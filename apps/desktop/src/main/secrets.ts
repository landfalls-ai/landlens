// Secret values for the person only (wave 8 part 4, D161–D168).
//
// Today's rule stays: no Secret value reaches the window, the agent, a file, a log or telemetry. This service opens one
// door, as narrow as it can be made:
//
// - Unlock (D163): main reads the Secret once (its uid and type; the body is dropped), then asks in its own native
//   dialog on the asking window, naming the cluster, the namespace and the Secret. Yes unlocks that one Secret, by uid,
//   for that window on that cluster, for 5 minutes. An unlock ends at its time, on Lock, when the window goes, reloads
//   or loses its renderer, when the cluster stops, and when the window connects another cluster. At most 5 a window.
// - Reveal (D164): one key, to the window that unlocked it, read again with a token for that one GET, the uid checked;
//   the rest of the object is dropped; nothing is cached. 10 reads of values a minute a window.
// - Copy (D165): the same read, written to the system clipboard by main, never to the window, with macOS's concealed
//   marker in the same write (Electron 45's ClipboardItem: one atomic write, so the marker and the text go together),
//   so clipboard managers that honour it skip it. Main keeps only the SHA-256 of what it wrote and clears the
//   clipboard 30 s later, and when Landlens quits, only if it still holds that.
// - Certificates (D167): public halves only (certs.ts certDetails: tls.crt and ca.crt), no unlock.
//
// Every read is one front-door token with the `object` policy (D162): one GET of that one Secret, labelled
// `you · <context> · secret <namespace>/<name>`, taken back after its one request and revoked in `finally`. Your RBAC
// decides (`get secrets`). Every error this service throws is one of its own fixed sentences: never the API's text, a
// parse error's (V8 quotes the text it couldn't parse) or anything with a value in it. Nothing here logs. One action-log
// row per reveal and per copy names the Secret and the key, never a value or a length; telemetry counts neither.
import { createHash } from "node:crypto";
import type { CertDetail, Revealed, SecretRef } from "@landlens/contracts";
import { certDetails, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorSend } from "@landlens/kube-mcp";
import type { WebContents } from "electron";
import { logEntry, type ActionLog } from "./action-log";
import type { Confirm } from "./native-confirm";

export const UNLOCK_MS = 5 * 60_000;
export const MAX_UNLOCKS = 5;
/** Reads of values (reveals and copies) a window may make in a minute. */
export const VALUE_READS = 10;
export const VALUE_READS_MS = 60_000;
/** How long a copied value stays on the clipboard, and a revealed one on screen (the window's timer). */
export const CLEAR_MS = 30_000;
/** The most text a reveal shows: past it, Copy only. */
export const MAX_TEXT = 64 * 1024;
/** macOS's marker that clipboard managers skip (nspasteboard.org), as Electron 45's clipboard names a raw format. */
export const CONCEALED = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';

/** Main's fixed sentences: the only errors this service gives. */
export const SECRET_TEXT = {
  forbidden: (ns: string) => `You can't read Secrets in ${ns}.`,
  gone: "That Secret is gone.",
  keyGone: "That key is gone.",
  changed: "It changed since you unlocked it: unlock again.",
  locked: "Unlock this Secret first.",
  unreadable: "The cluster's answer wasn't a Secret Landlens could read.",
  unreachable: "The cluster didn't answer.",
  status: (n: number) => `The cluster answered HTTP ${n}.`,
  helm: "Helm's release record: open it under Helm.",
  cancelled: "Cancelled.",
  asking: "Landlens is already asking about a Secret in this window.",
  tooMany: `At most ${MAX_UNLOCKS} Secrets are unlocked at once in a window: lock one first.`,
  rate: `At most ${VALUE_READS} values a minute: wait a moment.`,
  notText: "It isn't text: copy it as base64.",
  logRefused: "Landlens couldn't write its action log, so nothing was read.",
  windowGone: "The window that asked has gone.",
  inPrompt: "That is a Secret value Landlens copied for you: it isn't sent to Claude.",
  secretRef: "Secrets aren't sent to Claude.",
  clipboard: "Landlens couldn't write to the clipboard.",
} as const;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The clipboard as main uses it: a concealed write, a read to compare, a clear. */
export type SecretClipboard = { write(text: string): Promise<void>; readText(): Promise<string>; clear(): void };

export type SecretDeps = {
  clusters: Pick<ClusterManager, "get" | "onGone">;
  frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
  log: Pick<ActionLog, "add" | "settle"> & { readonly unsaved?: boolean };
  clipboard: SecretClipboard;
  now?: () => number;
};

type Unlock = { wc: WebContents; handle: string; namespace: string; name: string; uid: string; until: number };
type Key = { wc: WebContents; handle: string; secret: SecretRef };

export class SecretService {
  private readonly unlocks = new Set<Unlock>();
  private readonly asking = new WeakSet<WebContents>();
  private readonly watched = new WeakSet<WebContents>();
  private readonly reads = new WeakMap<WebContents, number[]>();
  /** What main last wrote to the clipboard, as its SHA-256 only, and the timer that clears it. */
  private copied: { hash: string; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(private readonly d: SecretDeps) {
    d.clusters.onGone((handle) => {
      for (const u of this.unlocks) if (u.handle === handle) this.unlocks.delete(u);
    });
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  /** A window's unlocks end with its page: when it goes, reloads or its renderer dies. */
  private own(wc: WebContents) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    const end = () => this.lockWindow(wc);
    wc.on("did-start-navigation", (e: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (e.isMainFrame && !e.isSameDocument) end();
    });
    wc.on("render-process-gone", end);
    wc.once("destroyed", () => {
      end();
      this.watched.delete(wc);
    });
  }

  /** Every unlock this window holds ends (Lock now with no Secret, a navigation, another cluster connected). */
  lockWindow(wc: WebContents) {
    for (const u of this.unlocks) if (u.wc === wc) this.unlocks.delete(u);
  }

  private live(wc: WebContents): Unlock[] {
    const now = this.now;
    for (const u of this.unlocks) if (u.until <= now) this.unlocks.delete(u);
    return [...this.unlocks].filter((u) => u.wc === wc);
  }

  private find(k: Key): Unlock | undefined {
    return this.live(k.wc).find((u) => u.handle === k.handle && u.namespace === k.secret.namespace && u.name === k.secret.name);
  }

  /**
   * One GET of one Secret as you (D162): a token for that request only, the `object` policy, revoked at the end.
   * Answers the parsed object or one of the fixed sentences; never the cluster's text.
   */
  private async read(handle: string, s: SecretRef): Promise<{ uid: string; type: string; data: Record<string, unknown> }> {
    const c = this.d.clusters.get(handle);
    const token = this.d.frontDoor.issueToken({
      label: `you · ${c.info.context} · secret ${s.namespace}/${s.name}`,
      policy: { access: "object", object: { group: "", resource: "secrets", namespace: s.namespace, name: s.name } },
      clusters: [handle],
    });
    try {
      let got: { status: number; text: string };
      try {
        got = await frontDoorSend({ url: this.d.frontDoor.clusterUrl(handle), certificate: this.d.frontDoor.certificate, token })({ method: "GET", path: `/api/v1/namespaces/${s.namespace}/secrets/${s.name}` });
      } catch {
        throw fail(504, SECRET_TEXT.unreachable);
      }
      if (got.status === 403) throw fail(403, SECRET_TEXT.forbidden(s.namespace));
      if (got.status === 404) throw fail(404, SECRET_TEXT.gone);
      if (got.status !== 200) throw fail(502, SECRET_TEXT.status(got.status));
      let o: any;
      try {
        o = JSON.parse(got.text);
      } catch {
        throw fail(502, SECRET_TEXT.unreadable);
      }
      const uid = o?.metadata?.uid;
      if (o?.kind !== "Secret" || o.metadata?.name !== s.name || o.metadata?.namespace !== s.namespace || typeof uid !== "string" || !uid) throw fail(502, SECRET_TEXT.unreadable);
      const data = o.data && typeof o.data === "object" && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {};
      return { uid, type: typeof o.type === "string" ? o.type : "", data };
    } finally {
      this.d.frontDoor.revokeToken(token);
    }
  }

  /** Main's question on the asking window (D163); yes unlocks that Secret, by uid, for 5 minutes. */
  async unlock(r: { handle: string; secret: SecretRef }, wc: WebContents, confirm: Confirm): Promise<{ unlocked: true; until: string; left: number }> {
    this.own(wc);
    if (this.asking.has(wc)) throw fail(429, SECRET_TEXT.asking);
    const others = this.live(wc).filter((u) => !(u.handle === r.handle && u.namespace === r.secret.namespace && u.name === r.secret.name));
    if (others.length >= MAX_UNLOCKS) throw fail(429, SECRET_TEXT.tooMany);
    this.asking.add(wc);
    try {
      const context = this.d.clusters.get(r.handle).info.context;
      const got = await this.read(r.handle, r.secret);
      if (got.type === "helm.sh/release.v1") throw fail(400, SECRET_TEXT.helm);
      const yes = await confirm({
        message: `Show values of Secret ${r.secret.namespace}/${r.secret.name}?`,
        detail: `Values are shown to you only, for 30 seconds at a time. Claude never sees them. On ${oneLine(context)}.`,
        yes: "Show values",
      });
      if (!yes) throw fail(409, SECRET_TEXT.cancelled);
      // The window and the cluster may have gone while the dialog was up.
      if (wc.isDestroyed() || !this.watched.has(wc)) throw fail(410, SECRET_TEXT.windowGone);
      this.d.clusters.get(r.handle);
      for (const u of this.unlocks) if (u.wc === wc && u.handle === r.handle && u.namespace === r.secret.namespace && u.name === r.secret.name) this.unlocks.delete(u);
      const until = this.now + UNLOCK_MS;
      this.unlocks.add({ wc, handle: r.handle, namespace: r.secret.namespace, name: r.secret.name, uid: got.uid, until });
      return { unlocked: true, until: new Date(until).toISOString(), left: UNLOCK_MS };
    } finally {
      this.asking.delete(wc);
    }
  }

  lock(r: { handle: string; secret?: SecretRef }, wc: WebContents) {
    for (const u of this.unlocks) {
      if (u.wc !== wc) continue;
      if (!r.secret || (u.handle === r.handle && u.namespace === r.secret.namespace && u.name === r.secret.name)) this.unlocks.delete(u);
    }
  }

  /** The value's bytes, after every check: the window's unlock, its rate, the log row, one read, the same uid. */
  private async value(k: Key, key: string, action: "reveal" | "copy", use: (bytes: Buffer) => Promise<void> | void): Promise<void> {
    const u = this.find(k);
    if (!u) throw fail(403, SECRET_TEXT.locked);
    const now = this.now;
    const recent = (this.reads.get(k.wc) ?? []).filter((t) => t > now - VALUE_READS_MS);
    if (recent.length >= VALUE_READS) throw fail(429, SECRET_TEXT.rate);
    this.reads.set(k.wc, [...recent, now]);
    const info = this.d.clusters.get(k.handle).info;
    // The row is written before the read (as an action's before its first request); a log that can't take it reads nothing.
    let row: string;
    try {
      row = this.d.log.add(logEntry({ context: info.context, server: info.server, action, kind: "Secret", group: "", resource: "secrets", namespace: k.secret.namespace, names: [k.secret.name], key, outcome: "sent" })).id;
    } catch {
      throw fail(500, SECRET_TEXT.logRefused);
    }
    const settle = (outcome: "applied" | "failed" | "conflict") => {
      try {
        this.d.log.settle(row, { outcome });
      } catch {
        // the row stays as sent
      }
    };
    if (this.d.log.unsaved) {
      settle("failed");
      throw fail(500, SECRET_TEXT.logRefused);
    }
    try {
      const got = await this.read(k.handle, k.secret);
      if (got.uid !== u.uid) {
        this.unlocks.delete(u);
        throw fail(409, SECRET_TEXT.changed);
      }
      if (got.type === "helm.sh/release.v1") throw fail(400, SECRET_TEXT.helm);
      const b64 = got.data[key];
      if (typeof b64 !== "string") throw fail(404, SECRET_TEXT.keyGone);
      const bytes = Buffer.from(b64, "base64");
      try {
        await use(bytes);
      } finally {
        bytes.fill(0);
      }
      settle("applied");
    } catch (e) {
      settle((e as { status?: number }).status === 409 ? "conflict" : "failed");
      throw fixed(e);
    }
  }

  /** One key's value, to the window that unlocked it (D164): text when it is UTF-8 and at most 64 KiB, else its size. */
  async reveal(r: { handle: string; secret: SecretRef; key: string }, wc: WebContents): Promise<Revealed> {
    let out: Revealed = { kind: "binary", bytes: 0 };
    await this.value({ wc, handle: r.handle, secret: r.secret }, r.key, "reveal", (bytes) => {
      if (bytes.length > MAX_TEXT) out = { kind: "large", bytes: bytes.length };
      else {
        const text = utf8(bytes);
        out = text === undefined ? { kind: "binary", bytes: bytes.length } : { kind: "text", text, bytes: bytes.length };
      }
    });
    return out;
  }

  /** One key's value to the clipboard, from main (D165): the window gets `copied` and never the value. */
  async copy(r: { handle: string; secret: SecretRef; key: string; as?: "text" | "base64" }, wc: WebContents): Promise<{ copied: true; clearsIn: number }> {
    await this.value({ wc, handle: r.handle, secret: r.secret }, r.key, "copy", async (bytes) => {
      const text = r.as === "base64" ? bytes.toString("base64") : utf8(bytes);
      if (text === undefined) throw fail(415, SECRET_TEXT.notText);
      try {
        await this.d.clipboard.write(text);
      } catch {
        throw fail(500, SECRET_TEXT.clipboard);
      }
      if (this.copied) clearTimeout(this.copied.timer);
      const hash = sha(text);
      const timer = setTimeout(() => void this.clearIfOurs(hash), CLEAR_MS);
      timer.unref?.();
      this.copied = { hash, timer };
    });
    return { copied: true, clearsIn: CLEAR_MS / 1000 };
  }

  /** Clear the clipboard if it still holds what main wrote (never what the person copied since). */
  private async clearIfOurs(hash: string): Promise<void> {
    if (this.copied?.hash === hash) {
      clearTimeout(this.copied.timer);
      this.copied = undefined;
    }
    try {
      if (sha(await this.d.clipboard.readText()) === hash) this.d.clipboard.clear();
    } catch {
      // a clipboard that can't be read is left alone
    }
  }

  /** Quitting: the clipboard is cleared now if it still holds a value main copied. */
  async quit(): Promise<void> {
    const c = this.copied;
    if (c) await this.clearIfOurs(c.hash);
  }

  /**
   * A guard for text on its way to Claude (the dock, a change's note, a brain summary): refused when it holds the value
   * main copied and the clipboard still has. Main reads the clipboard only while a copy of its own may be on it.
   */
  async refuseCopied(texts: (string | undefined)[]): Promise<void> {
    const c = this.copied;
    if (!c) return;
    let now: string;
    try {
      now = await this.d.clipboard.readText();
    } catch {
      return;
    }
    if (!now || sha(now) !== c.hash) return;
    if (texts.some((t) => t?.includes(now))) throw fail(400, SECRET_TEXT.inPrompt);
  }

  /** A prompt for Claude (D168): no Secret attached, and no value main copied that the clipboard still holds. */
  async refusePrompt(p: { text: string; context?: { group: string; resource: string }[] }): Promise<void> {
    if (p.context?.some((r) => r.group === "" && r.resource === "secrets")) throw fail(400, SECRET_TEXT.secretRef);
    await this.refuseCopied([p.text]);
  }

  /** The certificates of a Secret (D167): public halves only, no unlock; your RBAC still decides. */
  async certs(r: { handle: string; secret: SecretRef }): Promise<{ certs: CertDetail[]; skipped?: string }> {
    try {
      return certDetails(await this.read(r.handle, r.secret));
    } catch (e) {
      throw fixed(e);
    }
  }
}

/** Valid UTF-8 as text, else undefined (never a replacement character standing in for bytes). */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const SENTENCES = new Set<string>(Object.values(SECRET_TEXT as Record<string, unknown>).filter((v): v is string => typeof v === "string"));
/** Only main's own sentences cross: an error of anything else becomes "the cluster's answer wasn't readable". */
function fixed(e: unknown): Error {
  const m = (e as Error)?.message ?? "";
  const status = (e as { status?: unknown })?.status;
  const ours = typeof status === "number" && (SENTENCES.has(m) || /^You can't read Secrets in [a-z0-9-]{1,63}\.$/.test(m) || /^The cluster answered HTTP \d{3}\.$/.test(m));
  return ours ? (e as Error) : fail(500, SECRET_TEXT.unreadable);
}

/** A context name as one line in main's dialog. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 253);

