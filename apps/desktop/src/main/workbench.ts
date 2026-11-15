// The workbench's live parts (wave 4): followed logs and pod shells. Both belong to the window that opened them and
// end with it, or with the cluster.
//
// Logs are read through the sidecar like the rest of the IDE's reads. A shell can change things, so it goes through
// the front door with a token issued for that terminal alone ("you · <context> · shell <pod>"): every shell is in the
// audit trail, and the token is revoked when the shell ends. It is your access, never the agent's.
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { EditReview, LogsEnd, LogsPush, Request, TerminalData, TerminalStatus } from "@landlens/contracts";
import { AUTO_SHELL, EDIT_TTL_MS, EditBroker, followLogs, openExec, toolKubeconfig, type ClusterManager, type ExecSession, type FrontDoor, type Send } from "@landlens/kube";
import { frontDoorSend } from "@landlens/kube-mcp";
import type { IPty } from "node-pty";
import type { WebContents } from "electron";

type Push = {
  (wc: WebContents, channel: "logs:lines", payload: LogsPush): void;
  (wc: WebContents, channel: "logs:end", payload: LogsEnd): void;
  (wc: WebContents, channel: "terminal:data", payload: TerminalData): void;
  (wc: WebContents, channel: "terminal:status", payload: TerminalStatus): void;
};

type Owned = { wc: WebContents; handle: string; stop(): void };
type Terminal = Owned & { session: Pick<ExecSession, "write" | "resize">; flow: Flow };

/**
 * Flow control for a terminal's output (security review, wave 4 part 1, finding 9): what main sent and the window
 * hasn't drawn yet. Past HIGH the source (the pod's WebSocket, the pty) pauses; under LOW it resumes. Messages are at
 * most CHUNK characters.
 */
const HIGH = 2 * 1024 * 1024, LOW = 512 * 1024, CHUNK = 256 * 1024;
export class Flow {
  private unacked = 0;
  private paused = false;
  constructor(private readonly src: { pause(): void; resume(): void }) {}
  sent(n: number) {
    this.unacked += n;
    if (!this.paused && this.unacked > HIGH) (this.paused = true, this.src.pause());
  }
  ack(n: number) {
    this.unacked = Math.max(0, this.unacked - n);
    if (this.paused && this.unacked < LOW) (this.paused = false, this.src.resume());
  }
  get isPaused() {
    return this.paused;
  }
}

/** Reviews a window may hold at once. */
const MAX_REVIEWS = 20;
const SHELLS = { auto: AUTO_SHELL, bash: ["bash", "-il"], sh: ["sh", "-i"] } as const;
/** Terminal output is sent at most this often, in one message. */
const FLUSH_MS = 8;
export const MAX_TERMINALS = 20;
export const MAX_LOG_STREAMS = 50;

const id = () => randomBytes(12).toString("base64url");

export class WorkbenchService {
  private readonly logs = new Map<string, Owned>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(private readonly deps: {
    clusters: Pick<ClusterManager, "get" | "onGone" | "discovery">;
    frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate" | "url">;
    /** Where local terminals' kubeconfigs go (removed when each ends). */
    dataDir: string;
    push?: Push;
  }) {
    deps.clusters.onGone((handle) => this.stopCluster(handle));
    // A crash leaves terminal folders (a kubeconfig and a token file each): sweep them at start.
    rmSync(join(deps.dataDir, "terminals"), { recursive: true, force: true });
  }

  private send: Push = ((wc: WebContents, channel: string, payload: unknown) => {
    if (this.deps.push) return (this.deps.push as (w: WebContents, c: string, p: unknown) => void)(wc, channel, payload);
    if (!wc.isDestroyed()) wc.send(channel, payload);
  }) as Push;

  /**
   * Everything a window opened ends with its page: when the window goes, and when the page reloads or its renderer
   * crashes, since no tab is left to show or close what it opened (and a live terminal holds a token).
   */
  private own(wc: WebContents) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    const end = () => {
      for (const [k, v] of this.logs) if (v.wc === wc) this.closeLogs(k);
      for (const [k, v] of this.terminals) if (v.wc === wc) this.closeTerminal(k);
      for (const [k, v] of this.reviews) if (v.wc === wc) this.discardEdit(k, wc);
    };
    wc.on("did-start-navigation", (d: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (d.isMainFrame && !d.isSameDocument) end();
    });
    wc.on("render-process-gone", end);
    wc.once("destroyed", () => (end(), this.watched.delete(wc)));
  }

  openLogs(r: Request<"logs:open">, wc: WebContents): { stream: string } {
    if ([...this.logs.values()].filter((x) => x.wc === wc).length >= MAX_LOG_STREAMS) {
      throw Object.assign(new Error(`at most ${MAX_LOG_STREAMS} log streams at once`), { status: 429 });
    }
    const client = this.deps.clusters.get(r.handle).client;
    this.own(wc);
    const stream = id();
    const stop = followLogs(client, { ...r, follow: !r.previous }, {
      lines: (lines) => this.send(wc, "logs:lines", { stream, lines }),
      end: (e) => {
        this.logs.delete(stream);
        this.send(wc, "logs:end", { stream, ...e });
      },
    });
    this.logs.set(stream, { wc, handle: r.handle, stop });
    return { stream };
  }

  private readonly edits = new EditBroker();
  /** Each review belongs to the window and cluster it was made for, until it expires (with the broker's). */
  private readonly reviews = new Map<string, { wc: WebContents; handle: string; expires: number }>();

  /**
   * One request series as you: a token issued for it ("you · <context> · edit"), through the front door so it is
   * audited, revoked when the series ends.
   */
  private async asYou<T>(handle: string, f: (send: Send) => Promise<T>): Promise<T> {
    const c = this.deps.clusters.get(handle);
    const token = this.deps.frontDoor.issueToken({ label: `you · ${c.info.context} · edit`, policy: { access: "full" }, clusters: [handle] });
    try {
      return await f(frontDoorSend({ url: this.deps.frontDoor.clusterUrl(handle), certificate: this.deps.frontDoor.certificate, token }));
    } finally {
      this.deps.frontDoor.revokeToken(token);
    }
  }

  /** Keep a review for its window: expired ones go, and a window holds at most 20 (the oldest goes first). */
  private remember(r: EditReview, wc: WebContents, handle: string): EditReview {
    const now = Date.now();
    for (const [k, v] of this.reviews) if (v.expires <= now) this.reviews.delete(k);
    if (r.id) {
      this.own(wc);
      const mine = [...this.reviews].filter(([, v]) => v.wc === wc);
      if (mine.length >= MAX_REVIEWS) this.discardEdit(mine[0]![0], wc);
      this.reviews.set(r.id, { wc, handle, expires: now + EDIT_TTL_MS });
    }
    return r;
  }

  /**
   * The type comes from the cluster's discovery in main, not from the window: its kind and scope are main's, and the
   * Secret check rests on what the cluster serves (security review, wave 4 part 2, finding 7).
   */
  async reviewEdit(r: Request<"edit:review">, wc: WebContents): Promise<EditReview> {
    const t = (await this.deps.clusters.discovery(r.handle)).find((x) => x.group === r.type.group && x.version === r.type.version && x.resource === r.type.resource);
    if (!t) throw Object.assign(new Error(`this cluster doesn't serve ${r.type.resource}`), { status: 404 });
    const type = { group: t.group, version: t.version, resource: t.resource, kind: t.kind, namespaced: t.namespaced };
    return this.asYou(r.handle, (send) => this.edits.reviewEdit(send, { ...r, type })).then((x) => this.remember(x, wc, r.handle));
  }

  async reviewCreate(r: Request<"edit:create">, wc: WebContents): Promise<EditReview> {
    const types = (await this.deps.clusters.discovery(r.handle)).map((t) => ({ group: t.group, version: t.version, resource: t.resource, kind: t.kind, namespaced: t.namespaced }));
    return this.asYou(r.handle, (send) => this.edits.reviewCreate(send, { yaml: r.yaml, ...(r.namespace ? { namespace: r.namespace } : {}), types })).then((x) => this.remember(x, wc, r.handle));
  }

  applyEdit(r: Request<"edit:apply">, wc: WebContents): Promise<{ results: string[] }> {
    const owner = this.reviews.get(r.id);
    if (!owner || owner.wc !== wc || owner.handle !== r.handle || owner.expires <= Date.now()) throw Object.assign(new Error("no such review"), { status: 404 });
    this.deps.clusters.get(r.handle); // throws for a cluster that's gone, before the review is used up
    this.reviews.delete(r.id);
    return this.asYou(r.handle, (send) => this.edits.apply(send, r.id));
  }

  discardEdit(id: string, wc: WebContents) {
    if (this.reviews.get(id)?.wc !== wc) return;
    this.reviews.delete(id);
    this.edits.discard(id);
  }

  /** Live shells and local terminals, in every window. */
  terminalCount(): number {
    return this.terminals.size;
  }

  closeLogs(stream: string) {
    this.logs.get(stream)?.stop();
    this.logs.delete(stream);
  }

  openTerminal(r: Request<"terminal:open">, wc: WebContents): { terminal: string; label: string } {
    if ([...this.terminals.values()].filter((x) => x.wc === wc).length >= MAX_TERMINALS) {
      throw Object.assign(new Error(`at most ${MAX_TERMINALS} terminals at once`), { status: 429 });
    }
    const c = this.deps.clusters.get(r.handle);
    this.own(wc);
    const terminal = id();
    const label = `you · ${c.info.context} · shell ${r.namespace}/${r.pod}`;
    // Only this pod's exec: a leaked shell token is worth one shell, not the cluster (review, part 1, finding 5).
    const token = this.deps.frontDoor.issueToken({ label, policy: { access: "exec", pod: { namespace: r.namespace, name: r.pod } }, clusters: [r.handle] });
    let out = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flow: Flow | undefined;
    const flush = () => {
      timer = undefined;
      for (let i = 0; i < out.length; i += CHUNK) {
        const data = out.slice(i, i + CHUNK);
        this.send(wc, "terminal:data", { terminal, data });
        flow?.sent(data.length);
      }
      out = "";
    };
    let ended = false;
    let session: ExecSession;
    try {
      session = openExec({
      url: this.deps.frontDoor.clusterUrl(r.handle), certificate: this.deps.frontDoor.certificate, token,
      namespace: r.namespace, pod: r.pod, container: r.container, command: [...SHELLS[r.shell ?? "auto"]],
    }, {
      open: () => this.send(wc, "terminal:status", { terminal, state: "open" }),
      data: (text) => {
        out += text;
        timer ??= setTimeout(flush, FLUSH_MS);
      },
      exit: (e) => {
        if (ended) return;
        ended = true;
        if (timer) clearTimeout(timer);
        flush();
        this.deps.frontDoor.revokeToken(token);
        this.terminals.delete(terminal);
        this.send(wc, "terminal:status", { terminal, state: "exited", ...e });
      },
    });
    } catch (err) {
      this.deps.frontDoor.revokeToken(token);
      throw err;
    }
    flow = new Flow(session);
    this.terminals.set(terminal, {
      wc, handle: r.handle, session, flow,
      stop: () => {
        session.close();
        this.deps.frontDoor.revokeToken(token);
      },
    });
    return { terminal, label };
  }

  /**
   * Your login shell on this Mac, with kubectl pointed at this cluster through the front door: KUBECONFIG is a file
   * that names only this cluster, and its token is in the shell's environment, issued for this terminal and revoked
   * when it ends. Your shell's startup files run as usual, so one that sets KUBECONFIG wins.
   */
  openLocal(r: { handle: string }, wc: WebContents): { terminal: string; label: string; shell: string } {
    if ([...this.terminals.values()].filter((x) => x.wc === wc).length >= MAX_TERMINALS) {
      throw Object.assign(new Error(`at most ${MAX_TERMINALS} terminals at once`), { status: 429 });
    }
    const c = this.deps.clusters.get(r.handle);
    this.own(wc);
    const terminal = id();
    const label = `you · ${c.info.context} · terminal`;
    const dir = join(this.deps.dataDir, "terminals", terminal);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const kubeconfig = join(dir, "kubeconfig");
    const tokenFile = join(dir, "token");
    writeFileSync(kubeconfig, toolKubeconfig({ url: this.deps.frontDoor.url, certificate: this.deps.frontDoor.certificate }, [{ handle: r.handle, context: c.info.context }], undefined, { tokenFile }), { mode: 0o400 });
    const token = this.deps.frontDoor.issueToken({ label, policy: { access: "full" }, clusters: [r.handle] });
    // In a file, not the shell's environment: see tool-kubeconfig.ts (security review, wave 4 part 1, finding 1).
    writeFileSync(tokenFile, token, { mode: 0o400 });
    const shell = loginShell();
    let pty: IPty;
    try {
      pty = loadPty().spawn(shell, ["-l"], {
        name: "xterm-256color", cols: 100, rows: 30, cwd: homedir(),
        env: { ...localEnv(process.env), KUBECONFIG: kubeconfig, KUBECACHEDIR: join(dir, "cache"), TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (err) {
      this.deps.frontDoor.revokeToken(token);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    let out = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flow: Flow | undefined;
    const flush = () => {
      timer = undefined;
      for (let i = 0; i < out.length; i += CHUNK) {
        const data = out.slice(i, i + CHUNK);
        this.send(wc, "terminal:data", { terminal, data });
        flow?.sent(data.length);
      }
      out = "";
    };
    let ended = false;
    const end = (code?: number) => {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      flush();
      this.deps.frontDoor.revokeToken(token);
      rmSync(dir, { recursive: true, force: true });
      this.terminals.delete(terminal);
      this.send(wc, "terminal:status", { terminal, state: "exited", ended: "exit", ...(code !== undefined ? { code } : {}) });
    };
    pty.onData((d) => {
      out += d;
      timer ??= setTimeout(flush, FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => end(exitCode));
    flow = new Flow({ pause: () => pty.pause(), resume: () => pty.resume() });
    this.terminals.set(terminal, {
      wc, handle: r.handle, flow,
      session: { write: (d) => pty.write(d), resize: (cols, rows) => pty.resize(cols, rows) },
      stop: () => {
        try {
          pty.kill();
        } catch {
          // already gone
        }
        end();
      },
    });
    queueMicrotask(() => this.send(wc, "terminal:status", { terminal, state: "open" }));
    return { terminal, label, shell: shell.slice(shell.lastIndexOf("/") + 1) };
  }

  input(terminal: string, data: string, wc: WebContents) {
    this.mine(terminal, wc).session.write(data);
  }

  ack(terminal: string, chars: number, wc: WebContents) {
    this.terminals.get(terminal)?.wc === wc && this.terminals.get(terminal)!.flow.ack(chars);
  }

  resize(terminal: string, cols: number, rows: number, wc: WebContents) {
    this.mine(terminal, wc).session.resize(cols, rows);
  }

  close(terminal: string, wc: WebContents) {
    if (this.terminals.get(terminal)?.wc === wc) this.closeTerminal(terminal);
  }

  closeLogsFor(stream: string, wc: WebContents) {
    if (this.logs.get(stream)?.wc === wc) this.closeLogs(stream);
  }

  /** A terminal is driven only by the window that opened it. */
  private mine(terminal: string, wc: WebContents): Terminal {
    const t = this.terminals.get(terminal);
    if (!t || t.wc !== wc) throw Object.assign(new Error("no such terminal"), { status: 404 });
    return t;
  }

  private closeTerminal(terminal: string) {
    this.terminals.get(terminal)?.stop();
    this.terminals.delete(terminal);
  }

  private stopCluster(handle: string) {
    for (const [k, v] of this.logs) if (v.handle === handle) this.closeLogs(k);
    for (const [k, v] of this.terminals) if (v.handle === handle) this.closeTerminal(k);
    for (const [k, v] of this.reviews) if (v.handle === handle) this.discardEdit(k, v.wc);
  }
}

/** Your login shell: the account's, else $SHELL, if /etc/shells lists it; else zsh. */
export function loginShell(shells = readShells(), account = safeUserShell(), env = process.env.SHELL): string {
  for (const s of [account, env]) if (s && shells.includes(s)) return s;
  return "/bin/zsh";
}
function readShells(): string[] {
  try {
    return readFileSync("/etc/shells", "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/"));
  } catch {
    return ["/bin/zsh", "/bin/bash", "/bin/sh"];
  }
}
function safeUserShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/** Your environment, without Landlens's own variables or Electron's. */
export function localEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(ELECTRON_|LANDLENS_|VITE_|NODE_OPTIONS$|KUBECONFIG$|CHROME_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

let pty: typeof import("node-pty") | undefined;
/** node-pty, loaded on first use; its spawn helper must be executable (pnpm unpacks it without the bit). */
function loadPty(): typeof import("node-pty") {
  if (pty) return pty;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    try {
      chmodSync(helper, 0o755);
    } catch {
      // not there (a build from source has its own); node-pty will say what's wrong
    }
  }
  pty = require("node-pty") as typeof import("node-pty");
  return pty;
}
