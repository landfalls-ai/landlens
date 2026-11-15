// Landlens's own telemetry in main (docs/family.md#what-landlens-reports, wave 7 D127–D133). Off until the person turns
// it on, and then only to the collector address they confirmed in main's own dialog: no other destination exists. Fed
// by events main already has (a session's start and end, each prompt turn and ACP's usage, the gateway's call log, the
// approval broker's decisions, clusters connecting and their sidecars exiting, the front door's audit, the doctor's
// report), each turned into a record by packages/telemetry's constructors only, so nothing here can put text in one.
// With "counts only" no cluster, namespace or object name goes. The Go sidecar sends nothing (D131): main reports its
// exits. While off, no record is built and the queue is empty.
import { randomBytes } from "node:crypto";
import { clusterLabel, DEFAULT_COLLECTOR, TELEMETRY_NOTES, type AgentChange, type ClusterInfo, type McpCall, type TelemetryInfo, type TelemetryRecord } from "@landlens/contracts";
import { changeSpan, event, gauge, resourceOf, sum, TelemetryQueue, toolSpan, turnSpan, type AskOf, type EventName, type Severity, type SumLabels, type SumName } from "@landlens/telemetry";
import type { AuditEntry } from "@landlens/kube";
import type { StoredTelemetry } from "./clickland-settings";

/**
 * `settleMs`: how long a turn's span waits after the prompt's answer for ACP's last usage_update (the model and the
 * running cost), which the SDK may hand over after the answer although it was sent before it.
 */
/** `stopMs`: the most a quit waits for the last flush (review of part 5, L5). */
export const TELEMETRY = { metricsMs: 60_000, settleMs: 250, stopMs: 2_000 } as const;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** The gateway's server name as telemetry names it: built-in and reserved as they are, any other `remote`. */
const SERVER_NAMES = new Set(["landlens-kube", "landlens-gcp", "github", "linear", "clickland", "landflow", "landfall"]);
export const serverOf = (server: string) => (SERVER_NAMES.has(server) ? server : "remote");
const GATE = { read: "auto", asked: "asked", autonomous: "autonomous", preview: "asked" } as const;
const WHO = { agent: "agent", app: "view", you: "you" } as const;
const OUTCOME: Partial<Record<AgentChange["state"], "approved" | "rejected" | "failed" | "expired">> = { applied: "approved", rejected: "rejected", failed: "failed", expired: "expired", withdrawn: "expired" };

export type TelemetryDeps = {
  settings: { telemetry(): StoredTelemetry; setTelemetry(t: StoredTelemetry): void };
  /** The family's address rule with this build's overrides (main/family.ts). */
  allowed(url: string): boolean;
  /**
   * The cluster's name in Clickland, if the person set one for graphs. Without one, the context's own name goes only
   * when it is plain (clusterLabel: no GKE project, EKS account id or user in it; review of part 5, L2).
   */
  clusterName(context: string): string | undefined;
  /**
   * Whether the doctor's report for this context names a problem about the object (and of the class, when given): a
   * doctor brief's "Subject:" line is text in the prompt, so its names go only when main's own report has them (L1).
   */
  problemAbout?(context: string, subject: { kind?: string; namespace?: string; name?: string }, cls?: string): boolean;
  /**
   * Whether the tool is one the session's server listed as the person accepted it (a reserved server's pinned listing,
   * a sibling's offered tools, Landlens's own): any other name is the agent's or the server's word and goes as
   * `unknown` (L8).
   */
  knownTool?(session: string, server: string, tool: string): boolean;
  clusters(): ClusterInfo[];
  /** The doctor's problems per cluster, class and tone. */
  problems(): { handle: string; class: string; tone: string; n: number }[];
  version: string;
  platform: string;
  /** The console's origin, for "Open this session in Clickland". */
  console(): string | undefined;
  push?: () => void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (l: string) => void;
};

type Session = { context: string; namespaces: string[]; mode: string; model?: string; cost?: number };
type Turn = { traceId: string; spanId: string; start: number; ask: AskOf; mode: string; model?: string; cost0?: number };

export class TelemetryService {
  readonly queue: TelemetryQueue;
  private readonly sessions = new Map<string, Session>();
  private readonly turns = new Map<string, Turn>();
  /** Calls already recorded (a call is reported once, when it ends). */
  private readonly seenCalls = new Set<string>();
  private readonly seenChanges = new Set<string>();
  private counters = new Map<string, { name: SumName; labels: SumLabels; n: number }>();
  private windowStart: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** One collector dialog at a time. */
  private asking = false;
  /** Turns waiting for their last usage_update: stop() builds them at once (L5). */
  private readonly settling = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(private readonly d: TelemetryDeps) {
    this.queue = new TelemetryQueue({
      collector: () => this.collector(),
      resource: () => resourceOf({ version: d.version, platform: d.platform, team: this.stored().team }),
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(d.now ? { now: d.now } : {}),
      onState: () => d.push?.(),
    });
    this.windowStart = this.now;
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  private stored(): StoredTelemetry {
    return this.d.settings.telemetry();
  }

  /** Where records go now: the confirmed collector while on, if this build still takes its address; else nowhere. */
  private collector(): string | undefined {
    const t = this.stored();
    const c = t.collector ?? DEFAULT_COLLECTOR;
    return t.on && this.d.allowed(c) ? c : undefined;
  }

  get on(): boolean {
    return !!this.collector();
  }

  private get names(): boolean {
    return this.stored().names;
  }

  start() {
    this.queue.start();
    this.timer ??= setInterval(() => this.tick(), TELEMETRY.metricsMs);
    this.timer.unref?.();
  }

  /**
   * Quitting: turns still settling are built now, the sums go, and the last flush gets at most TELEMETRY.stopMs; what
   * hasn't gone by then is dropped and its POST aborted, so a collector that never answers can't hold the quit (L5).
   */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const [timer, finish] of this.settling) {
      clearTimeout(timer);
      finish();
    }
    this.settling.clear();
    if (this.on) {
      this.tick();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.queue.flush(), new Promise<void>((r) => (timer = setTimeout(r, TELEMETRY.stopMs)))]);
      clearTimeout(timer);
      this.queue.clear();
    }
    this.queue.stop();
  }

  info(): TelemetryInfo {
    const t = this.stored();
    const last = this.queue.last;
    return {
      on: this.on, collector: t.collector ?? DEFAULT_COLLECTOR, names: t.names, ...(t.team ? { team: t.team } : {}),
      ...(last ? { last: { at: new Date(last.at).toISOString(), ok: last.ok } } : {}), waiting: this.queue.waiting, dropped: this.queue.dropped,
    };
  }

  /** The drawer (D132): the last 100 records exactly as queued. */
  recent(): { records: TelemetryRecord[]; info: TelemetryInfo } {
    return { records: this.queue.recent(), info: this.info() };
  }

  /**
   * The card's switches (D133). Turning telemetry on, giving another collector while it is on, or turning names back on
   * while it is on (review of part 5, M3) asks in main's own dialog, which names the host: a window can't send
   * Landlens's records anywhere, or with more in them, than the person confirmed. Narrowing (off, counts only) never
   * asks. Off, another collector or counts only drops what waits, unsent, and stops a send in flight (M2): a record is
   * sent only to the collector, and with the names, it was made under.
   */
  async set(req: { on?: boolean; collector?: string; names?: boolean; team?: string | null }, confirm: (q: { message: string; detail: string; yes: string }) => Promise<boolean>): Promise<TelemetryInfo> {
    const t = this.stored();
    const collector = req.collector !== undefined ? new URL(req.collector).origin : (t.collector ?? DEFAULT_COLLECTOR);
    if (!this.d.allowed(collector)) throw fail(400, "Use https, or plain http only to this machine (127.0.0.1, localhost).");
    const on = req.on ?? t.on;
    const next: StoredTelemetry = {
      on, collector, names: req.names ?? t.names,
      ...(req.team === null ? {} : req.team !== undefined ? { team: req.team } : t.team ? { team: t.team } : {}),
    };
    const moved = collector !== (t.collector ?? DEFAULT_COLLECTOR);
    const newPlace = on && (!t.on || moved);
    const widened = on && t.on && next.names && !t.names;
    if (newPlace || widened) {
      if (this.asking) throw fail(409, TELEMETRY_NOTES.dialogOpen);
      this.asking = true;
      let yes: boolean;
      try {
        const host = new URL(collector).host;
        yes = await confirm({
          message: newPlace ? `Send Landlens's telemetry to ${host}?` : `Send names with Landlens's telemetry to ${host}?`,
          detail: `Landlens will send its own spans, counts and events to the OpenTelemetry collector at:\n${collector}\n\nNo prompt or answer text, tool arguments, log lines, YAML or secrets. ${next.names ? "The names of the cluster, namespace and the object a question was about go with them." : "Counts only: no cluster, namespace or object names."}`,
          yes: "Send telemetry",
        });
      } finally {
        this.asking = false;
      }
      if (!yes) throw fail(409, newPlace ? TELEMETRY_NOTES.declined : TELEMETRY_NOTES.namesDeclined);
    }
    this.d.settings.setTelemetry(next);
    if (!on || moved || (t.names && !next.names)) this.queue.clear();
    if (!on) this.counters.clear();
    this.d.push?.();
    return this.info();
  }

  // ---- Events ------------------------------------------------------------------------------------------------------

  private push(r: TelemetryRecord | undefined) {
    if (this.on) this.queue.push(r);
  }

  private count(name: SumName, labels: SumLabels, n = 1) {
    if (!this.on) return;
    const key = `${name} ${JSON.stringify(labels)}`;
    const c = this.counters.get(key) ?? { name, labels, n: 0 };
    c.n += n;
    this.counters.set(key, c);
  }

  private event(name: EventName, severity: Severity = "info") {
    this.push(event(name, severity, 1, this.now));
  }

  sessionStarted(s: { session: string; context: string; namespaces?: string[]; mode?: string }) {
    this.sessions.set(s.session, { context: s.context, namespaces: s.namespaces ?? [], mode: s.mode ?? "default" });
    this.count("landlens.sessions", {});
    this.event("session.started");
  }

  sessionEnded(session: string) {
    if (!this.sessions.has(session)) return;
    this.turns.delete(session);
    this.event("session.ended");
    // A turn still settling keeps its session's model and cost until it is built.
    const was = this.sessions.get(session);
    const timer = setTimeout(() => this.sessions.get(session) === was && this.sessions.delete(session), TELEMETRY.settleMs * 2);
    timer.unref?.();
  }

  modeChanged(session: string, mode: string) {
    const s = this.sessions.get(session);
    if (s) s.mode = mode;
  }

  /**
   * A prompt turn begins: its trace and span ids, so the gateway calls in it are its children. A doctor brief's subject
   * stays only if the doctor's own report names a problem about it (L1).
   */
  turnStarted(session: string, ask: AskOf) {
    const s = this.sessions.get(session);
    if (ask.ask === "problem" && ask.subject && !(s && this.d.problemAbout?.(s.context, ask.subject, ask.problem))) {
      const { subject: _gone, ...rest } = ask;
      ask = rest;
    }
    this.turns.set(session, { traceId: hex(16), spanId: hex(8), start: this.now, ask, mode: s?.mode ?? "default", ...(s?.cost !== undefined ? { cost0: s.cost } : {}) });
  }

  /** ACP's usage_update: the model, and the session's cost so far (cumulative, in USD). */
  usage(session: string, u: { model?: unknown; cost?: { amount?: unknown; currency?: unknown } | null }) {
    const s = this.sessions.get(session);
    if (!s) return;
    if (typeof u.model === "string") s.model = u.model;
    if (u.cost && u.cost.currency === "USD" && typeof u.cost.amount === "number" && Number.isFinite(u.cost.amount)) s.cost = u.cost.amount;
  }

  /**
   * The turn ended: its span, with the turn's tokens (the prompt answer's `_meta.quota.token_count`) and cost, built
   * once a usage_update sent with the answer has had time to arrive (settleMs).
   */
  turnEnded(session: string, end: { stopReason: string; meta?: unknown }): Promise<void> {
    const t = this.turns.get(session);
    if (!t) return Promise.resolve();
    this.turns.delete(session);
    const at = this.now;
    const s = this.sessions.get(session);
    return new Promise((done) => {
      const finish = () => (this.finishTurn(session, t, s, at, end), done());
      const timer = setTimeout(() => (this.settling.delete(timer), finish()), TELEMETRY.settleMs);
      timer.unref?.();
      this.settling.set(timer, finish);
    });
  }

  private finishTurn(session: string, t: Turn, s: Session | undefined, end: number, e: { stopReason: string; meta?: unknown }) {
    const tc = (e.meta as { quota?: { token_count?: Record<string, unknown> } } | undefined)?.quota?.token_count;
    const cost = s?.cost !== undefined ? s.cost - (t.cost0 ?? 0) : undefined;
    const names = this.names && s ? {
      cluster: clusterLabel(this.d.clusterName(s.context), s.context),
      namespaces: s.namespaces,
      ...(t.ask.subject ? { subject: t.ask.subject } : {}),
      ...(t.ask.problem ? { problem: t.ask.problem } : {}),
    } : false as const;
    this.push(turnSpan({
      traceId: t.traceId, spanId: t.spanId, start: t.start, end, conversation: session, model: s?.model,
      ...(tc ? { usage: { input: tc.inputTokens, output: tc.outputTokens, cacheRead: tc.cachedInputTokens, cacheWrite: tc.cachedWriteTokens } } : {}),
      ...(cost !== undefined && cost >= 0 ? { cost } : {}),
      stop: e.stopReason, mode: t.mode, ask: t.ask.ask, names,
    }));
    this.count("landlens.agent.turns", {});
    if (tc) {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
      const input = n(tc.inputTokens) + n(tc.cachedInputTokens) + n(tc.cachedWriteTokens);
      if (input) this.count("gen_ai.client.token.usage", { type: "input" }, input);
      if (n(tc.outputTokens)) this.count("gen_ai.client.token.usage", { type: "output" }, n(tc.outputTokens));
    }
  }

  /** A gateway call that ended: a child span of its session's turn, and its count. */
  call(c: McpCall) {
    if (c.status === "running" || this.seenCalls.has(c.id)) return;
    this.seenCalls.add(c.id);
    if (this.seenCalls.size > 2_000) this.seenCalls.delete(this.seenCalls.values().next().value!);
    const server = serverOf(c.server);
    const status = c.status;
    this.count("landlens.tool.calls", { server, status });
    if (status === "refused") this.event("gateway.refused", "warn");
    const turn = this.turns.get(c.session);
    this.push(toolSpan({
      traceId: turn?.traceId ?? hex(16), spanId: hex(8), ...(turn ? { parent: turn.spanId } : {}),
      start: c.startedAt, end: c.endedAt ?? this.now, server, tool: this.d.knownTool?.(c.session, c.server, c.tool) ? c.tool : undefined, status,
      gate: c.gate ? GATE[c.gate] : "auto", who: WHO[c.origin],
    }));
  }

  /** A change the agent proposed reached its end: a child span of its turn, and its count. */
  change(c: AgentChange) {
    const outcome = OUTCOME[c.state];
    if (!outcome || this.seenChanges.has(c.id)) return;
    this.seenChanges.add(c.id);
    if (this.seenChanges.size > 1_000) this.seenChanges.delete(this.seenChanges.values().next().value!);
    const op = c.operations[0];
    const turn = this.turns.get(c.session);
    const start = Date.parse(c.createdAt);
    this.count("landlens.cluster.writes", { verb: op?.verb, outcome });
    this.push(changeSpan({
      traceId: turn?.traceId ?? hex(16), spanId: hex(8), ...(turn ? { parent: turn.spanId } : {}),
      start, end: this.now, verb: op?.verb, kind: op?.kind, outcome, waitedMs: this.now - start, names: this.names,
    }));
  }

  clusterConnected() {
    this.event("cluster.connected");
  }

  clusterGone(why: "disconnected" | "exited") {
    this.event(why === "exited" ? "sidecar.exited" : "cluster.disconnected", why === "exited" ? "warn" : "info");
  }

  adapterExited() {
    this.event("adapter.exited", "warn");
  }

  /** One of your actions ended (wave 8, D147): counted by the action and its outcome, both closed words. */
  action(a: { action: string; outcome: string }) {
    this.count("landlens.actions", { action: a.action, outcome: a.outcome });
  }

  /** A front-door request, counted by the token's policy and whether it was let through. */
  audit(e: AuditEntry) {
    this.count("landlens.frontdoor.requests", { policy: e.access ?? "unknown", allowed: e.allowed });
  }

  /** Every 60 s: the sums since the last tick, and the gauges now. */
  tick() {
    const now = this.now;
    if (this.on) {
      for (const c of this.counters.values()) this.queue.push(sum(c.name, c.n, c.labels, this.windowStart, now));
      const clusters = this.d.clusters();
      this.queue.push(gauge("landlens.clusters.connected", clusters.length, {}, now, this.names));
      const byHandle = new Map(clusters.map((c) => [c.handle, c.context]));
      for (const p of this.d.problems()) {
        const ctx = byHandle.get(p.handle);
        if (ctx) this.queue.push(gauge("landlens.doctor.problems", p.n, { cluster: clusterLabel(this.d.clusterName(ctx), ctx), class: p.class, tone: p.tone }, now, this.names));
      }
    }
    this.counters = new Map();
    this.windowStart = now;
  }

  /**
   * "Open this session in Clickland" (D132): the console's search for the session's spans, after the native dialog that
   * shows the host. Only for a session Landlens knows; the address is main's own.
   */
  async open(session: string, known: (s: string) => boolean, ask: { confirm(q: { message: string; detail: string; yes: string }): Promise<boolean>; openExternal(url: string): Promise<void> }): Promise<{ opened: boolean }> {
    if (!known(session)) throw fail(404, TELEMETRY_NOTES.noSession);
    const console = this.d.console();
    if (!console) throw fail(409, TELEMETRY_NOTES.noConsole);
    const q = new URLSearchParams({ signal: "traces", query: `gen_ai.conversation.id:"${session}"` });
    const u = new URL(`/search?${q}`, console);
    if (u.origin !== console) throw fail(400, "not an address Landlens opens");
    if (this.asking) throw fail(409, TELEMETRY_NOTES.dialogOpen);
    this.asking = true;
    let yes: boolean;
    try {
      yes = await ask.confirm({ message: `Open ${u.host} in your browser?`, detail: `This session's spans, in the address saved as Clickland's console:\n${u.href.slice(0, 500)}`, yes: "Open" });
    } finally {
      this.asking = false;
    }
    if (yes) await ask.openExternal(u.href);
    return { opened: yes };
  }
}
