// The only constructors of a telemetry record (docs/family.md#what-landlens-reports, wave 7 D128–D130). Every record
// is built here from closed sets: an attribute key is one of the contract's TELEMETRY_KEYS, and its value is one of
// the enums below, a number, or a name that passed its pattern and that redactText leaves alone. There is no free-text
// field and no `Record<string, unknown>` of attributes: a caller passes typed fields, each checked here, and anything
// that fails its check is left out. So no prompt, answer, argument, error message, address or path can be carried,
// whatever a caller passes (the property test in test/records.test.ts).
import type { TelemetryAttrs, TelemetryRecord } from "@landlens/contracts";
import { redactText } from "@landlens/kube/redact";

export const AGENT_NAME = "landlens-claude";
export const ASKS = ["none", "object", "problem", "logs", "clickland-logs", "terminal", "edit", "helm", "gcp", "landflow"] as const;
export const MODES = ["default", "plan"] as const;
/** ACP's stop reasons, and `error` for a turn that failed. */
export const STOPS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "error"] as const;
/** Built-in and reserved servers by their names; every server the person added is `remote`. */
export const SERVERS = ["landlens-kube", "landlens-gcp", "github", "linear", "clickland", "landflow", "landfall", "remote"] as const;
export const CALL_STATUSES = ["ok", "error", "refused"] as const;
export const GATES = ["auto", "asked", "autonomous"] as const;
export const WHO = ["agent", "view", "you"] as const;
export const VERBS = ["create", "update", "patch", "delete"] as const;
/** A change's end: approved (applied), rejected, failed, expired (withdrawn counts as expired). */
export const OUTCOMES = ["approved", "rejected", "failed", "expired"] as const;
/** The front door's token policies (packages/kube/src/policy.ts), and `unknown` for a request no token matched. */
export const POLICIES = ["full", "read", "write", "exec", "forward", "unknown"] as const;
export const TOKEN_TYPES = ["input", "output"] as const;
export const PROBLEM_CLASSES = ["crashloop", "start", "image", "config", "oom", "pending", "probe", "notready", "restarts", "unavailable", "node", "warning", "cert"] as const;
export const TONES = ["bad", "warn"] as const;
export const EVENTS = [
  "session.started", "session.ended", "cluster.connected", "cluster.disconnected", "sidecar.exited", "adapter.exited",
  "gateway.refused", "telemetry.dropped",
] as const;
export const SEVERITIES = ["info", "warn", "error"] as const;
export const SUMS = ["landlens.sessions", "landlens.agent.turns", "landlens.tool.calls", "landlens.cluster.writes", "landlens.frontdoor.requests", "gen_ai.client.token.usage"] as const;
export const GAUGES = ["landlens.clusters.connected", "landlens.doctor.problems"] as const;
export const SPAN_NAMES = { turn: `invoke_agent ${AGENT_NAME}`, change: "landlens.change" } as const;

export type Ask = (typeof ASKS)[number];
export type Mode = (typeof MODES)[number];
export type Stop = (typeof STOPS)[number];
export type Server = (typeof SERVERS)[number];
export type CallStatus = (typeof CALL_STATUSES)[number];
export type Gate = (typeof GATES)[number];
export type Who = (typeof WHO)[number];
export type Verb = (typeof VERBS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type Policy = (typeof POLICIES)[number];
export type EventName = (typeof EVENTS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type SumName = (typeof SUMS)[number];
export type GaugeName = (typeof GAUGES)[number];

/** Every closed value a record can hold as a string: what the property test checks output strings against. */
export const ENUM_VALUES: ReadonlySet<string> = new Set<string>([
  AGENT_NAME, "invoke_agent", "execute_tool", ...ASKS, ...MODES, ...STOPS, ...SERVERS, ...CALL_STATUSES, ...GATES, ...WHO, ...VERBS,
  ...OUTCOMES, ...POLICIES, ...TOKEN_TYPES, ...PROBLEM_CLASSES, ...TONES, ...EVENTS, ...SEVERITIES,
]);

const oneOf = <T extends string>(set: readonly T[], v: unknown): T | undefined => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : undefined);
/** A value no secret pattern touches (a name shaped like a token is left out too). */
const clean = (v: string) => redactText(v) === v;
const shaped = (re: RegExp, max: number) => (v: unknown): string | undefined => (typeof v === "string" && v.length <= max && re.test(v) && clean(v) ? v : undefined);

/** A Kubernetes object or namespace name (a DNS subdomain), or a cluster's name as a label value. */
export const K8S_NAME = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
export const k8sName = shaped(K8S_NAME, 253);
/** The cluster's name in Clickland: a label value (the graphs' rule), so `orbstack` or `prod-eu-1`. */
export const CLUSTER_NAME = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
export const clusterName = shaped(CLUSTER_NAME, 63);
export const KIND = /^[A-Z][A-Za-z0-9]{0,62}$/;
export const kindName = shaped(KIND, 63);
/** A tool's name as MCP servers name them (`get_logs`, `list_services`). */
export const TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const toolName = shaped(TOOL, 64);
/** A model id (`claude-opus-5-5`, `claude-sonnet-4-5-20250929`). */
export const MODEL = /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/;
export const modelName = shaped(MODEL, 80);
/** An ACP session id as Claude Code makes them (a UUID). */
export const CONVERSATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;
export const conversationId = shaped(CONVERSATION, 64);
export const TEAM = /^[a-z0-9](?:[-a-z0-9._]{0,58}[a-z0-9])?$/;
export const teamName = shaped(TEAM, 60);
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,20})?$/;
export const versionText = shaped(VERSION, 40);
const hex = (n: number) => shaped(new RegExp(`^[0-9a-f]{${n}}$`), n);
export const traceIdOf = hex(32);
export const spanIdOf = hex(16);

/** A count: a finite whole number from 0 to a trillion. */
export const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12 ? Math.round(v) : undefined);
/** Money: finite, 0 to a million, six decimals. */
export const money = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e6 ? Math.round(v * 1e6) / 1e6 : undefined);
/** A time in milliseconds since the epoch. */
const time = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e14 ? Math.round(v) : fallback);

/** Attributes, with every undefined left out: the only way a record's attributes are made. */
function attrs(a: TelemetryAttrs): TelemetryAttrs {
  const out: TelemetryAttrs = {};
  for (const [k, v] of Object.entries(a) as [keyof TelemetryAttrs, TelemetryAttrs[keyof TelemetryAttrs]][]) if (v !== undefined) out[k] = v;
  return out;
}

/** What the question was about (D130): only names, each checked; absent when names are off ("counts only"). */
export type TurnNames = {
  cluster?: unknown;
  /** The session's namespace limit: sent when it is one namespace; a count when more. */
  namespaces?: unknown[];
  subject?: { kind?: unknown; namespace?: unknown; name?: unknown };
  problem?: unknown;
};

/** One prompt turn of a session, as Clickland's Agents pages read it (gen_ai.operation.name = invoke_agent). */
export function turnSpan(t: {
  traceId: unknown; spanId: unknown; start: unknown; end: unknown; conversation: unknown; model?: unknown;
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }; cost?: unknown;
  stop: unknown; mode: unknown; ask: unknown; names: TurnNames | false;
}): TelemetryRecord | undefined {
  const traceId = traceIdOf(t.traceId);
  const spanId = spanIdOf(t.spanId);
  if (!traceId || !spanId) return undefined;
  const now = Date.now();
  const at = time(t.start, now);
  const stop = oneOf(STOPS, t.stop) ?? "error";
  const n = t.names || undefined;
  const ns = Array.isArray(n?.namespaces) ? n!.namespaces.map(k8sName).filter((x): x is string => !!x) : [];
  return {
    signal: "span", name: SPAN_NAMES.turn, at, end: Math.max(at, time(t.end, at)), traceId, spanId, error: stop === "error",
    attrs: attrs({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.conversation.id": conversationId(t.conversation),
      "gen_ai.request.model": modelName(t.model),
      "gen_ai.usage.input_tokens": count(t.usage?.input),
      "gen_ai.usage.output_tokens": count(t.usage?.output),
      "gen_ai.usage.cache_read.input_tokens": count(t.usage?.cacheRead),
      "gen_ai.usage.cache_creation.input_tokens": count(t.usage?.cacheWrite),
      "gen_ai.usage.cost": money(t.cost),
      "gen_ai.response.finish_reasons": stop,
      "landlens.mode": oneOf(MODES, t.mode) ?? "default",
      "landlens.ask": oneOf(ASKS, t.ask) ?? "none",
      ...(n ? {
        "landlens.cluster": clusterName(n.cluster),
        "landlens.namespace": ns.length === 1 ? ns[0] : undefined,
        "landlens.namespaces": ns.length > 1 ? ns.length : undefined,
        "landlens.subject.kind": kindName(n.subject?.kind),
        "landlens.subject.namespace": k8sName(n.subject?.namespace),
        "landlens.subject.name": k8sName(n.subject?.name),
        "landlens.problem.class": oneOf(PROBLEM_CLASSES, n.problem),
      } : {}),
    }),
  };
}

/** A gateway call, a child of the turn it ran in (gen_ai.operation.name = execute_tool). */
export function toolSpan(t: {
  traceId: unknown; spanId: unknown; parent?: unknown; start: unknown; end: unknown; server: unknown; tool: unknown;
  status: unknown; gate: unknown; who: unknown;
}): TelemetryRecord | undefined {
  const traceId = traceIdOf(t.traceId);
  const spanId = spanIdOf(t.spanId);
  if (!traceId || !spanId) return undefined;
  const server = oneOf(SERVERS, t.server) ?? "remote";
  // A server the person added is `remote`, and so are its tools' names: they are the person's, not Landlens's.
  const tool = server === "remote" ? "remote" : (toolName(t.tool) ?? "unknown");
  const status = oneOf(CALL_STATUSES, t.status) ?? "error";
  const now = Date.now();
  const at = time(t.start, now);
  const parent = spanIdOf(t.parent);
  return {
    signal: "span", name: `execute_tool ${server}.${tool}`, at, end: Math.max(at, time(t.end, at)), traceId, spanId,
    ...(parent ? { parentSpanId: parent } : {}), error: status !== "ok",
    attrs: attrs({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": tool,
      "landlens.server": server,
      "landlens.status": status,
      "landlens.gate": oneOf(GATES, t.gate) ?? "auto",
      "landlens.who": oneOf(WHO, t.who) ?? "agent",
    }),
  };
}

/** A cluster write the agent proposed, a child of its turn: the verb, the object's kind, how it ended, how long you took. */
export function changeSpan(t: {
  traceId: unknown; spanId: unknown; parent?: unknown; start: unknown; end: unknown; verb: unknown; kind: unknown;
  outcome: unknown; waitedMs: unknown; names: boolean;
}): TelemetryRecord | undefined {
  const traceId = traceIdOf(t.traceId);
  const spanId = spanIdOf(t.spanId);
  const outcome = oneOf(OUTCOMES, t.outcome);
  if (!traceId || !spanId || !outcome) return undefined;
  const now = Date.now();
  const at = time(t.start, now);
  const parent = spanIdOf(t.parent);
  return {
    signal: "span", name: SPAN_NAMES.change, at, end: Math.max(at, time(t.end, at)), traceId, spanId,
    ...(parent ? { parentSpanId: parent } : {}), error: outcome === "failed",
    attrs: attrs({
      "landlens.verb": oneOf(VERBS, t.verb) ?? "update",
      "landlens.kind": t.names ? kindName(t.kind) : undefined,
      "landlens.outcome": outcome,
      "landlens.waited_ms": count(t.waitedMs),
    }),
  };
}

/** A sum's labels: each from its own closed set. */
export type SumLabels = { server?: unknown; status?: unknown; verb?: unknown; outcome?: unknown; policy?: unknown; allowed?: unknown; type?: unknown };

/** A counter's growth over [start, at] (delta temporality). */
export function sum(name: SumName, value: unknown, labels: SumLabels, start: unknown, at: unknown): TelemetryRecord | undefined {
  if (!(SUMS as readonly string[]).includes(name)) return undefined;
  const v = count(value);
  if (v === undefined) return undefined;
  const now = Date.now();
  const end = time(at, now);
  return {
    signal: "metric", name, kind: "sum", at: end, start: Math.min(end, time(start, end)), value: v,
    attrs: attrs({
      "landlens.server": oneOf(SERVERS, labels.server),
      "landlens.status": oneOf(CALL_STATUSES, labels.status),
      "landlens.verb": oneOf(VERBS, labels.verb),
      "landlens.outcome": oneOf(OUTCOMES, labels.outcome),
      "landlens.policy": oneOf(POLICIES, labels.policy),
      "landlens.allowed": typeof labels.allowed === "boolean" ? labels.allowed : undefined,
      "gen_ai.token.type": oneOf(TOKEN_TYPES, labels.type),
    }),
  };
}

/** A gauge at `at`: clusters connected, or the doctor's problems per cluster, class and tone. */
export function gauge(name: GaugeName, value: unknown, labels: { cluster?: unknown; class?: unknown; tone?: unknown }, at: unknown, names: boolean): TelemetryRecord | undefined {
  if (!(GAUGES as readonly string[]).includes(name)) return undefined;
  const v = count(value);
  if (v === undefined) return undefined;
  const end = time(at, Date.now());
  return {
    signal: "metric", name, kind: "gauge", at: end, start: end, value: v,
    attrs: attrs({
      "landlens.cluster": names ? clusterName(labels.cluster) : undefined,
      "landlens.class": oneOf(PROBLEM_CLASSES, labels.class),
      "landlens.tone": oneOf(TONES, labels.tone),
    }),
  };
}

/** One of Landlens's own events, with a severity and a count: never an error's text. */
export function event(name: EventName, severity: Severity, n: unknown, at: unknown): TelemetryRecord | undefined {
  if (!(EVENTS as readonly string[]).includes(name) || !(SEVERITIES as readonly string[]).includes(severity)) return undefined;
  return { signal: "log", name, at: time(at, Date.now()), severity, attrs: attrs({ "landlens.event": name, "landlens.count": count(n) ?? 1 }) };
}
