// The agent in Electron main: one Claude Code process (through claude-agent-acp) for the window, and a session per
// cluster, each with its own session on the MCP gateway (main/mcp.ts). Updates and permission requests go to the dock;
// answers come back. Tool calls in the updates are handed to the gateway too, to pair dock cards with logged calls.
import { randomBytes } from "node:crypto";
import type { AgentChange, AgentHistoryEntry, AgentPermissionRequest, AgentSessionInfo, AgentSettingsInfo, AgentStatus, AgentUpdate, AnyProvider, AutonomyState, ResourceRef } from "@landlens/contracts";
import { AcpHost, agentEnv, claudeAdapterEntry, listSkills, loginPath, objectUri, resourceBlock, startClusterSession, unreadableObject, which, type ClusterSession, type SessionMcp } from "@landlens/acp-host";
import { AgentHistory, AgentSettings } from "./agent-history";
import { apiPath, type ChangeDecision, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { getJson, redactObject, redactText } from "@landlens/kube-mcp";
import type { ContentBlock, NewSessionResponse, RequestPermissionOutcome, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { delimiter } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

type Push = {
  (channel: "agent:autonomy", payload: AutonomyState): void;
  (channel: "agent:update", payload: AgentUpdate): void;
  (channel: "agent:permission", payload: AgentPermissionRequest): void;
  (channel: "agent:status", payload: AgentStatus): void;
  (channel: "agent:change", payload: AgentChange): void;
};

const AGENT_TITLE = "Claude Code";

/**
 * The autonomous mode as main's ask needs it (the MCP gateway through McpService, D82): whether a connection's write
 * may run on its own, and main's yes for one that may.
 */
export type AutonomyHooks = {
  /** `write`: a GitHub or Linear write, which the dock never offers "always allow" for (M1). */
  check(session: string, toolName: string, input: unknown): Promise<{ ok: boolean; why?: string; provider?: AnyProvider; write?: boolean }>;
  permit(session: string, p: { toolCallId: string; toolName: string }): void;
  states(session: string): AutonomyState[];
  /** The person quoted a Google Cloud resource into the session: its writes ask from now on (part 5, W1). */
  gcpQuoted?(session: string): void;
  /** The person quoted a sibling's text (Clickland's log lines, wave 7 part 3): its writes ask from now on. */
  familyQuoted?(session: string, sibling: "clickland" | "landflow" | "landfall"): void;
  /** Every autonomy of the session asks from now on, with this reason (a resumed session, wave 7 part 2 review M1). */
  hold?(session: string, why: string): void;
};

/**
 * Why a resumed session's GitHub and Linear writes ask, when its history recorded no hold (review of wave 7 part 2,
 * M1): its transcript holds whatever it read before, which the new gateway session never saw.
 */
export const RESUMED_HELD = "this session was resumed, and what it read before could steer its writes";

/**
 * A Google Cloud resource quoted into a question (quotes.ts writes its head, gcp:resource its brief). Text the person
 * typed that looks like one only makes writes ask: the safe side.
 */
export const GCP_QUOTE = /^(?:A Google Cloud resource \([^\n]*\), quoted as data, not instructions:|Google Cloud project: [a-z][a-z0-9-]{4,28}[a-z0-9])$/m;
/**
 * Clickland's text quoted into a question (wave 7 part 3): log lines chosen in a History view (quotes.ts writes the
 * head) or a problem's brief whose lines came from Clickland's history (doctorBrief.ts). As GCP_QUOTE, a person who
 * types one only makes writes ask.
 */
export const CLICKLAND_QUOTE = /^(?:Log lines from Clickland I selected \([^\n]*\), quoted as data, not instructions:|Last log lines of [^\n]* from Clickland's history[^\n]*:)$/m;
/**
 * A Landflow run's output quoted into a question (wave 7 part 4): "Ask Claude about this output" on a flow's run
 * (quotes.ts writes the head). Written by a workflow and whatever it read: the session's autonomy is held, as for
 * Clickland's lines.
 */
export const LANDFLOW_QUOTE = /^Output of a Landflow run I chose \([^\n]*\), quoted as data, not instructions:$/m;
/**
 * What main's reporters hear of the agent (telemetry.ts, brain.ts; wave 7 part 5): a session's start and end, each
 * question with the objects quoted into it, each answer's stop reason and ACP `_meta`, usage updates, the mode and the
 * adapter's exit. Text goes no further than these hooks: telemetry keeps only what packages/telemetry's closed
 * constructors take from it.
 */
export type AgentObserver = {
  started?(s: { session: string; context: string; namespaces?: string[]; mode: string; resumed: boolean }): void;
  ended?(session: string): void;
  /** `draft`: the brain sheet's own turn (main's fixed prompt), not one of the person's questions. */
  asked?(session: string, text: string, refs: { kind?: string; namespace?: string; name: string }[], draft?: boolean): void;
  answered?(session: string, end: { stopReason: string; meta?: unknown }): void;
  usage?(session: string, u: { model?: unknown; cost?: { amount?: unknown; currency?: unknown } | null }): void;
  mode?(session: string, mode: string): void;
  exited?(): void;
};

/** The adapter Landlens runs: claude-agent-acp, or (unpackaged builds only, for tests) another ACP agent's script. */
export function adapterEntry(env: NodeJS.ProcessEnv, packaged: boolean): string {
  const o = env.LANDLENS_ACP_AGENT;
  return !packaged && o && /\.m?js$/.test(o) ? o : claudeAdapterEntry();
}

/** How long the brain's draft waits after the answer for its last message chunks. */
const DRAFT_SETTLE_MS = 250;

/** The modes the dock offers: Manual and Plan. Never acceptEdits, auto or bypass. */
const MODES = new Set(["default", "plan"]);

export class AgentService {
  private host: AcpHost | undefined;
  private starting: Promise<AcpHost> | undefined;
  private path = "";
  private readonly sessions = new Map<string, ClusterSession>();
  private readonly pending = new Map<string, {
    session: string;
    options: Set<string>;
    /** Each offered option's kind (allow_once, allow_always, reject_once, …). */
    kinds: Map<string, string>;
    toolCallId: string;
    toolName?: string;
    resolve: (o: RequestPermissionOutcome) => void;
  }>();
  /** Sessions with a question running: one at a time each (the brain's draft waits for none). */
  private readonly running = new Set<string>();
  /** A brain draft's answer, gathered from the session's message chunks while its turn runs. */
  private readonly drafting = new Map<string, string[]>();
  /** Changes the agent proposed that wait for your decision, by change id. */
  private readonly changes = new Map<string, { session: string; resolve: (d: ChangeDecision) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly deps: {
      frontDoor: FrontDoor;
      clusters: ClusterManager;
      sessionsDir: string;
      push: Push;
      mcp: SessionMcp;
      /** A tool call seen in a session's updates, for pairing with the gateway's call log. */
      onToolCall?: (u: { session: string; toolCallId: string; toolName?: string; title?: string; rawInput?: unknown }) => void;
      /** You said yes to a permission request: the MCP gateway runs a proxied tool that asks only after this. */
      onPermit?: (p: { session: string; toolCallId: string; toolName?: string; always: boolean }) => void;
      /** GitHub's and Linear's autonomous mode (D82): main answers a routine write's question only when this passes. */
      autonomy?: AutonomyHooks;
      /**
       * Text main served the window from a sibling (Clickland's log lines: sibling-text.ts). A question that quotes
       * any holds the session's autonomy, whatever its head says (security review of part 3, M2).
       */
      siblingText?: { found(text: string): Set<"clickland" | "landflow" | "landfall"> };
      metrics?: Parameters<typeof startClusterSession>[0]["metrics"];
      certs?: Parameters<typeof startClusterSession>[0]["certs"];
      /** Past sessions and your chosen skills (agent-history.ts). */
      history?: AgentHistory;
      settings?: AgentSettings;
      /** Where your Claude Code skills are; ~/.claude/skills by default. */
      skillsDir?: string;
      /** Telemetry and the brain's facts (wave 7 part 5). */
      observers?: AgentObserver[];
      /** The adapter's script; claude-agent-acp's by default. */
      adapter?: string;
      log?: (l: string) => void;
    },
  ) {
    // A cluster that goes away takes its agent sessions with it.
    deps.clusters.onGone((handle) => {
      for (const s of this.sessions.values()) if (s.handle === handle) void this.close(s.id);
    });
  }

  private ensure(): Promise<AcpHost> {
    if (this.host?.running) return Promise.resolve(this.host);
    this.starting ??= (async () => {
      this.deps.push("agent:status", { state: "starting" });
      mkdirSync(this.deps.sessionsDir, { recursive: true, mode: 0o700 });
      this.sweep();
      this.path = await loginPath();
      const node = which("node", this.path);
      if (!node) throw Object.assign(new Error("Landlens needs Node.js to run Claude Code; none was found on your login shell's PATH."), { status: 424 });
      const host = new AcpHost(
        { title: AGENT_TITLE, command: node, args: [this.deps.adapter ?? claudeAdapterEntry()], env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1" } },
        {
          cwd: this.deps.sessionsDir,
          env: agentEnv(process.env, { PATH: this.path }),
          events: {
            update: (n) => {
              const u = n.update as { sessionUpdate?: string; toolCallId?: string; title?: string; rawInput?: unknown; _meta?: { claudeCode?: { toolName?: unknown } } };
              if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
                const toolName = u._meta?.claudeCode?.toolName;
                this.deps.onToolCall?.({
                  session: n.sessionId, toolCallId: u.toolCallId,
                  ...(typeof toolName === "string" ? { toolName } : {}),
                  ...(typeof u.title === "string" ? { title: u.title } : {}),
                  ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
                });
              }
              const v = n.update as { sessionUpdate?: string; cost?: { amount?: unknown; currency?: unknown } | null; content?: { type?: string; text?: unknown }; currentModeId?: unknown; _meta?: Record<string, unknown> };
              if (v.sessionUpdate === "usage_update") this.observe((o) => o.usage?.(n.sessionId, { model: v._meta?.["_claude/model"], cost: v.cost ?? null }));
              if (v.sessionUpdate === "current_mode_update" && typeof v.currentModeId === "string") this.observe((o) => o.mode?.(n.sessionId, v.currentModeId as string));
              const draft = this.drafting.get(n.sessionId);
              if (draft && v.sessionUpdate === "agent_message_chunk" && v.content?.type === "text" && typeof v.content.text === "string") draft.push(v.content.text);
              this.deps.push("agent:update", { session: n.sessionId, update: n.update as AgentUpdate["update"] });
            },
            permission: (req, signal) => this.ask(req, signal),
            exit: ({ code, stderr }) => {
              // Claude Code has gone: its sessions' tokens must not outlive it.
              for (const s of this.sessions.values()) s.revoke();
              for (const id of this.sessions.keys()) this.observe((o) => o.ended?.(id));
              this.sessions.clear();
              this.running.clear();
              this.observe((o) => o.exited?.());
              for (const [id, p] of this.pending) {
                p.resolve({ outcome: "cancelled" });
                this.pending.delete(id);
              }
              for (const [id, c] of this.changes) {
                c.reject(new Error("withdrawn"));
                this.changes.delete(id);
              }
              this.deps.push("agent:status", { state: "stopped", message: `${AGENT_TITLE} exited (${code ?? "signal"})${stderr ? `: ${stderr}` : ""}` });
            },
            log: (l) => this.deps.log?.(`[agent] ${l}`),
          },
        },
      );
      await host.start();
      this.host = host;
      this.deps.push("agent:status", { state: "ready" });
      return host;
    })().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async start(handle: string, namespaces?: string[]): Promise<AgentSessionInfo> {
    return this.open({ handle, ...(namespaces?.length ? { namespaces } : {}) });
  }

  /** Session folders left by a crash: no session is open in them, and a resumed one starts from an empty folder. */
  private sweep() {
    const open = new Set([...this.sessions.values()].map((s) => s.cwd));
    for (const name of readdirSync(this.deps.sessionsDir)) {
      const dir = join(this.deps.sessionsDir, name);
      if (/^\d{10,16}-[0-9a-f]{8}$/.test(name) && !open.has(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Resume a session from the history on a connected cluster with the same context. */
  async resume(handle: string, session: string): Promise<AgentSessionInfo> {
    const e = this.deps.history?.get(session);
    if (!e) throw Object.assign(new Error("Landlens has no such session in its history"), { status: 404 });
    if (this.sessions.has(session)) throw Object.assign(new Error("that session is already open"), { status: 409 });
    const c = this.deps.clusters.get(handle);
    if (c.info.context !== e.context || (e.server && c.info.server !== e.server)) {
      throw Object.assign(new Error(`that session was on ${e.context}${e.server ? ` (${e.server})` : ""}; connect to it to resume`), { status: 409 });
    }
    // A resumed session always starts held (M1 of the wave 7 part 2 review): the hold lived in the gateway session that
    // ended, the transcript keeps what a sibling or Google Cloud said, and Landlens can't see into the transcript. The
    // reason is the one the history recorded, if any.
    return this.open({ handle, ...(e.namespaces?.length ? { namespaces: e.namespaces } : {}), resume: { sessionId: session, cwd: e.cwd } }, e.held ?? RESUMED_HELD);
  }

  /**
   * A connection's autonomous mode changed in a session (the gateway's push): the dock hears of it, and a hold is
   * written to the session's history, so a resume holds with the same reason (M1).
   */
  autonomyChanged(st: AutonomyState) {
    if (st.held) this.deps.history?.held(st.session, st.held);
    this.deps.push("agent:autonomy", st);
  }

  private async open(req: Parameters<typeof startClusterSession>[1], held?: string): Promise<AgentSessionInfo> {
    const host = await this.ensure();
    const s = await startClusterSession({
      host, frontDoor: this.deps.frontDoor, clusters: this.deps.clusters, mcp: this.deps.mcp,
      ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
      ...(this.deps.certs ? { certs: this.deps.certs } : {}),
      sessionsDir: this.deps.sessionsDir, home: homedir(), path: this.path,
      userKubeconfigs: process.env.KUBECONFIG?.split(delimiter).filter(Boolean) ?? [],
      changes: {
        ask: (change, signal) => this.askChange(change, signal),
        update: (change) => {
          if (change.state === "applied" || change.state === "rejected") this.deps.history?.changed(change.session, change.state);
          this.deps.push("agent:change", change);
        },
      },
      skills: this.chosenSkills(),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    }, req);
    this.sessions.set(s.id, s);
    this.observe((o) => o.started?.({ session: s.id, context: s.context, ...(s.namespaces ? { namespaces: s.namespaces } : {}), mode: s.response.modes?.currentModeId ?? "default", resumed: !!req.resume }));
    this.deps.history?.started({ session: s.id, agent: AGENT_TITLE, context: s.context, server: this.deps.clusters.get(s.handle).info.server, ...(s.namespaces ? { namespaces: s.namespaces } : {}), cwd: s.cwd });
    if (held) this.deps.autonomy?.hold?.(s.id, held);
    // Each connection's autonomous mode, off: a new or resumed session never starts autonomous (D82).
    const autonomy = this.deps.autonomy?.states(s.id) ?? [];
    return { ...info(s, s.response), ...(autonomy.length ? { autonomy } : {}) };
  }

  /** Each observer hears, and none can break the agent: a throw is logged and dropped. */
  private observe(f: (o: AgentObserver) => void) {
    for (const o of this.deps.observers ?? []) {
      try {
        f(o);
      } catch (err) {
        this.deps.log?.(`[agent] an observer failed: ${err instanceof Error ? err.name : "error"}`);
      }
    }
  }

  /** Another observer, once made (the brain's facts need the agent to draft). */
  addObserver(o: AgentObserver) {
    (this.deps.observers ??= []).push(o);
  }

  /** Whether the session is open in this launch. */
  isOpen(session: string): boolean {
    return this.sessions.has(session);
  }

  history(context?: string): AgentHistoryEntry[] {
    return this.deps.history?.list(context) ?? [];
  }

  /** Forget a past session: out of the list, and Claude Code deletes its transcript where it can. */
  async forget(session: string) {
    if (this.sessions.has(session)) throw Object.assign(new Error("close the session first"), { status: 409 });
    if (!this.deps.history?.forget(session)) throw Object.assign(new Error("Landlens has no such session in its history"), { status: 404 });
    if (this.host?.running) await this.host.deleteSession(session);
  }

  private get skillsDir() {
    return this.deps.skillsDir ?? join(homedir(), ".claude", "skills");
  }

  private chosenSkills() {
    const chosen = new Set(this.deps.settings?.skills() ?? []);
    return chosen.size ? listSkills(this.skillsDir).filter((s) => chosen.has(s.name)) : [];
  }

  settings(): AgentSettingsInfo {
    const chosen = new Set(this.deps.settings?.skills() ?? []);
    const skills = listSkills(this.skillsDir);
    return {
      skillsDir: this.skillsDir.replace(homedir(), "~"),
      skills: skills.map((s) => ({ name: s.name, description: s.description, chosen: chosen.has(s.name) })),
      missing: [...chosen].filter((n) => !skills.some((s) => s.name === n)),
    };
  }

  /** The skills new sessions get; a running session keeps what it started with. */
  setSkills(names: string[]) {
    const known = new Set(listSkills(this.skillsDir).map((s) => s.name));
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length) throw Object.assign(new Error(`no skill named ${unknown.join(", ")} in ${this.skillsDir}`), { status: 400 });
    this.deps.settings?.setSkills(names);
  }

  private session(id: string): ClusterSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("this agent session has ended"), { status: 404 });
    return s;
  }

  async prompt(id: string, text: string, context: ResourceRef[] = []): Promise<{ stopReason: string }> {
    const s = this.session(id);
    // Google Cloud data enters the session with this question: hold its autonomous writes before it is sent (W1).
    if (GCP_QUOTE.test(text)) this.deps.autonomy?.gcpQuoted?.(id);
    // So does a sibling's: Clickland's log lines are written by workloads (D113's reasoning, review of part 2 L8). Main
    // decides from what it served (siblingText), not only from the head the window wrote (review of part 3, M2).
    const quoted = new Set(this.deps.siblingText?.found(text) ?? []);
    if (CLICKLAND_QUOTE.test(text)) quoted.add("clickland");
    if (LANDFLOW_QUOTE.test(text)) quoted.add("landflow");
    for (const sibling of quoted) this.deps.autonomy?.familyQuoted?.(id, sibling);
    this.deps.history?.prompted(id, text);
    const blocks: ContentBlock[] = [{ type: "text", text }];
    const embedded = !!this.host?.init?.agentCapabilities?.promptCapabilities?.embeddedContext;
    for (const ref of context) {
      // An object that has gone, or that the session may not read, doesn't fail the question: it says so, in a fixed
      // sentence (a problem's subject can be deleted between the doctor's read and the ask).
      const { uri, body } = await this.describe(s, ref).catch((e: { status?: unknown }) => {
        if (typeof e?.status !== "number") throw e;
        return unreadableObject(s.context, ref, e.status);
      });
      blocks.push(embedded ? resourceBlock(uri, body) : { type: "text", text: `${uri}\n${body}` });
    }
    const refs = await Promise.all(context.map(async (r) => ({ ...r, kind: await this.deps.clusters.typeOf(s.handle, r).then((t) => t.kind, () => undefined) })));
    this.observe((o) => o.asked?.(id, text, refs.map((r) => ({ name: r.name, ...(r.namespace ? { namespace: r.namespace } : {}), ...(r.kind ? { kind: r.kind } : {}) }))));
    this.running.add(id);
    try {
      const res = await this.host!.prompt(id, blocks);
      this.observe((o) => o.answered?.(id, { stopReason: res.stopReason, meta: res._meta }));
      return { stopReason: res.stopReason };
    } catch (err) {
      this.observe((o) => o.answered?.(id, { stopReason: "error" }));
      throw err;
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * The brain sheet's "Ask Claude to draft" (D134): one turn in the session with main's fixed prompt, never the window's
   * text, and its answer's text. Not counted as one of your questions; refused while another question runs.
   */
  async draft(id: string, prompt: string): Promise<string> {
    this.session(id);
    if (this.running.has(id)) throw Object.assign(new Error("busy"), { status: 409, busy: true });
    const chunks: string[] = [];
    this.drafting.set(id, chunks);
    this.running.add(id);
    this.observe((o) => o.asked?.(id, prompt, [], true));
    try {
      const res = await this.host!.prompt(id, [{ type: "text", text: prompt }]);
      this.observe((o) => o.answered?.(id, { stopReason: res.stopReason, meta: res._meta }));
      // The answer's last chunks can be handed over after the answer itself, though sent before it.
      await new Promise((r) => setTimeout(r, DRAFT_SETTLE_MS));
      return chunks.join("");
    } catch (err) {
      this.observe((o) => o.answered?.(id, { stopReason: "error" }));
      throw err;
    } finally {
      this.drafting.delete(id);
      this.running.delete(id);
    }
  }

  /**
   * What "Ask about this" attaches: the object and its recent events, read with the session's own token, so the
   * session's namespace limit and Secrets refusal apply and the front door scrubs it, as for the agent's own reads.
   */
  private async describe(s: ClusterSession, ref: ResourceRef): Promise<{ uri: string; body: string }> {
    const type = await this.deps.clusters.typeOf(s.handle, ref);
    const o = await getJson(s.cluster, apiPath(type, ref.namespace, ref.name));
    const q = new URLSearchParams({ fieldSelector: `involvedObject.uid=${String(o.metadata?.uid ?? "")}`, limit: "200" });
    const eventsPath = ref.namespace ? `${apiPath({ group: "", version: "v1", resource: "events" }, ref.namespace)}?${q}` : `/api/v1/events?${q}`;
    const events: any[] = await getJson(s.cluster, eventsPath).then((l) => l.items ?? [], () => []);
    const recent = events
      .sort((a: any, b: any) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0))
      .slice(0, 15)
      .map((e: any) => redactText(`# ${e.type} ${e.reason} (x${e.count ?? 1}): ${String(e.message ?? "").replace(/\s+/g, " ")}`));
    const body = stringify(redactObject(o), { lineWidth: 0 }) + (recent.length ? `\n# Recent events\n${recent.join("\n")}\n` : "");
    return { uri: objectUri(s.context, type.kind, ref.name, ref.namespace), body };
  }

  async cancel(id: string) {
    this.session(id);
    this.withdrawAsks(id);
    await this.host?.cancel(id);
  }

  /** Show a proposed change in the dock and wait for your decision (agent:decide). */
  private askChange(change: AgentChange, signal: AbortSignal): Promise<ChangeDecision> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("withdrawn"));
      this.changes.set(change.id, { session: change.session, resolve, reject });
      signal.addEventListener("abort", () => {
        if (this.changes.delete(change.id)) reject(new Error("withdrawn"));
      }, { once: true });
      this.deps.push("agent:change", change);
    });
  }

  /** Your decision on a change. Only a change that is waiting can be decided, and only once. */
  decide(change: string, decision: "approve" | "reject", note?: string) {
    const c = this.changes.get(change);
    if (!c) throw Object.assign(new Error("that change was already decided, expired or withdrawn"), { status: 404 });
    this.changes.delete(change);
    c.resolve({ decision, ...(note?.trim() ? { note: note.trim() } : {}) });
  }

  /** Answer every open question of a session with "cancelled", and withdraw its waiting changes. */
  private withdrawAsks(id: string) {
    for (const [cid, c] of this.changes) {
      if (c.session === id) {
        this.changes.delete(cid);
        c.reject(new Error("withdrawn"));
      }
    }
    for (const [rid, p] of this.pending) {
      if (p.session === id) {
        p.resolve({ outcome: "cancelled" });
        this.pending.delete(rid);
        this.deps.push("agent:status", { state: "answered", request: rid });
      }
    }
  }

  async setMode(id: string, mode: string) {
    const s = this.session(id);
    const offered = s.response.modes?.availableModes.some((m) => m.id === mode);
    if (!MODES.has(mode) || !offered) throw Object.assign(new Error(`Landlens offers only Manual and Plan, not ${JSON.stringify(mode)}`), { status: 400 });
    await this.host!.setMode(id, mode);
    this.observe((o) => o.mode?.(id, mode));
  }

  async setConfig(id: string, config: string, value: string) {
    const s = this.session(id);
    const option = info(s, s.response).options.find((o) => o.id === config);
    if (!option || !option.choices.some((c) => c.id === value)) {
      throw Object.assign(new Error(`${JSON.stringify(config)} can't be set to ${JSON.stringify(value)}`), { status: 400 });
    }
    await this.host!.setConfigOption(id, config, value);
  }

  answer(request: string, option: string | null) {
    const p = this.pending.get(request);
    if (!p) throw Object.assign(new Error("that question was already answered or withdrawn"), { status: 404 });
    if (option !== null && !p.options.has(option)) throw Object.assign(new Error("that isn't one of the choices offered"), { status: 400 });
    this.pending.delete(request);
    const kind = option ? p.kinds.get(option) : undefined;
    if (kind === "allow_once" || kind === "allow_always") {
      this.deps.onPermit?.({ session: p.session, toolCallId: p.toolCallId, ...(p.toolName ? { toolName: p.toolName } : {}), always: kind === "allow_always" });
    }
    p.resolve(option ? { outcome: "selected", optionId: option } : { outcome: "cancelled" });
    this.deps.push("agent:status", { state: "answered", request });
  }

  async close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.withdrawAsks(id);
    this.observe((o) => o.ended?.(id));
    await s.close();
  }

  /** End every session: the window reloaded or went away, so no dock is left to show them. */
  async closeAll() {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }

  async stop() {
    await this.closeAll();
    await this.host?.stop();
  }

  /**
   * Claude Code asks before a tool call its rules don't settle. Main answers it itself in one case only (D82): a
   * GitHub or Linear write in a session where that connection is autonomous, and the gateway's check passes on the
   * input Claude Code shows; then main says allow-once and gives the gateway a yes bound to this tool call, which the
   * gateway checks again on the arguments that arrive. Everything else (cluster tools, the shell, servers you added,
   * reads, writes that fail the check) goes to the dock, with the reason when autonomous was on. The renderer can't
   * answer for it: agent:autonomy only turns the mode on or off.
   */
  private async ask(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionOutcome> {
    const name = (req.toolCall._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName;
    let auto: { ok: boolean; why?: string; provider?: AnyProvider; write?: boolean } = { ok: false };
    if (typeof name === "string" && /^mcp__/.test(name) && this.deps.autonomy) {
      auto = await this.deps.autonomy.check(req.sessionId, name, req.toolCall.rawInput ?? {}).catch(() => ({ ok: false }));
      const once = req.options.find((o) => o.kind === "allow_once");
      if (signal.aborted) return { outcome: "cancelled" };
      if (auto.ok && once) {
        this.deps.autonomy.permit(req.sessionId, { toolCallId: req.toolCall.toolCallId, toolName: name });
        this.deps.log?.(`[agent] ${req.sessionId}: ${name} ran on its own (autonomous)`);
        return { outcome: "selected", optionId: once.optionId };
      }
    }
    return this.askDock(req, signal, auto.provider, auto.why, auto.write);
  }

  /**
   * Show the question in the dock. A GitHub, Linear or family sibling's write is offered no "always allow" (M1 of the
   * part 3 review; D113):
   * it would let every later call of that tool run anywhere, uncounted, past the autonomous limits. The option isn't
   * shown, and answer() refuses it as not one of the choices; the gateway takes no "always" for such a write either.
   */
  private askDock(req: RequestPermissionRequest, signal: AbortSignal, provider?: AnyProvider, reason?: string, write?: boolean): Promise<RequestPermissionOutcome> {
    const request = randomBytes(9).toString("base64url");
    if (provider && write) req = { ...req, options: req.options.filter((o) => o.kind !== "allow_always") };
    return new Promise((resolve) => {
      const toolName = (req.toolCall._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName;
      this.pending.set(request, {
        session: req.sessionId,
        options: new Set(req.options.map((o) => o.optionId)),
        kinds: new Map(req.options.map((o) => [o.optionId, o.kind])),
        toolCallId: req.toolCall.toolCallId,
        ...(typeof toolName === "string" ? { toolName } : {}),
        resolve,
      });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(request)) {
          resolve({ outcome: "cancelled" });
          this.deps.push("agent:status", { state: "answered", request });
        }
      }, { once: true });
      const tc = req.toolCall;
      this.deps.push("agent:permission", {
        request,
        session: req.sessionId,
        toolCall: { toolCallId: tc.toolCallId, title: tc.title ?? null, kind: tc.kind ?? null, rawInput: tc.rawInput },
        options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        ...(provider ? { provider } : {}),
        ...(reason ? { reason } : {}),
      });
    });
  }
}

function info(s: ClusterSession, r: NewSessionResponse): AgentSessionInfo {
  const options = (r.configOptions ?? []).flatMap((o: any) =>
    o.type === "select" && Array.isArray(o.options) && o.id !== "mode"
      ? [{
          id: String(o.id), name: String(o.name ?? o.id), current: String(o.currentValue ?? ""),
          choices: o.options.flatMap((c: any) => ("value" in c ? [{ id: String(c.value), name: String(c.name ?? c.value), description: c.description ?? null }] : [])),
        }]
      : []);
  return {
    session: s.id,
    label: s.label,
    agent: AGENT_TITLE,
    context: s.context,
    ...(s.namespaces ? { namespaces: s.namespaces } : {}),
    ...(r.modes
      ? { mode: { current: r.modes.currentModeId, available: r.modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null })) } }
      : {}),
    options,
  };
}
