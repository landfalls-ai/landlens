// The typed IPC between Landlens main and the sandboxed renderer. Main validates every request with these schemas;
// the preload bridge only forwards the channels listed here.
import { z } from "zod";

// What may reach an API path. Main builds paths from these fields, so each is held to Kubernetes's own naming
// rules: no "/", "%", "?", "#", "\\", dot segments, spaces or control characters can get through.
const label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const GroupName = z.string().max(253).regex(/^$|^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "not an API group name");
export const VersionName = z.string().max(63).regex(label, "not an API version");
export const ResourceName = z.string().max(63).regex(label, "not a resource name");
export const NamespaceName = z.string().max(63).regex(label, "not a namespace name");
/**
 * Object names are DNS subdomains for most kinds, but RBAC and a few others allow ":" and more. Printable ASCII
 * that is legal as-is in a URL path, never "." or "..": nothing a client would percent-encode.
 */
export const ObjectName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?!\.{1,2}$)[\x21-\x7e]+$/, "not an object name")
  .regex(/^[^/%?#\\"<>`{}|^[\]]+$/, "not an object name");
export const Handle = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "not a cluster handle");
export const Uid = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "not a uid");

export const KubeContext = z.object({
  name: z.string(),
  cluster: z.string(),
  user: z.string(),
  server: z.string(),
  namespace: z.string().optional(),
  current: z.boolean(),
});
export type KubeContext = z.infer<typeof KubeContext>;

/** A connected cluster. `handle` is random per connection, never derived from the kubeconfig. */
export const ClusterInfo = z.object({
  handle: z.string(),
  context: z.string(),
  server: z.string(),
  version: z.string(),
});
export type ClusterInfo = z.infer<typeof ClusterInfo>;

/** One kind of resource the cluster serves, from API discovery. */
export const ResourceType = z.object({
  group: z.string(), // "" for the core group
  version: z.string(),
  resource: z.string(), // plural, e.g. "deployments"
  kind: z.string(),
  namespaced: z.boolean(),
  verbs: z.array(z.string()),
  shortNames: z.array(z.string()).optional(),
});
export type ResourceType = z.infer<typeof ResourceType>;

export const resourceKey = (t: Pick<ResourceType, "group" | "resource">) =>
  t.group ? `${t.resource}.${t.group}` : t.resource;

export const ResourceRef = z.object({
  group: GroupName,
  version: VersionName,
  resource: ResourceName,
  namespace: NamespaceName.optional(),
  name: ObjectName,
});
export type ResourceRef = z.infer<typeof ResourceRef>;

/** A Kubernetes object as Landlens passes it around (managedFields already stripped). */
export type KubeObject = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[];
    deletionTimestamp?: string;
  };
  spec?: any;
  status?: any;
  [key: string]: unknown;
};

export const WatchRequest = z.object({
  handle: Handle,
  group: GroupName,
  version: VersionName,
  resource: ResourceName,
  namespace: NamespaceName.optional(), // absent: all namespaces (or cluster-scoped)
});
export type WatchRequest = z.infer<typeof WatchRequest>;

/** Pushed from main to the renderer on the `watch:event` channel. */
export type WatchEvent =
  | { subscription: string; type: "snapshot"; items: KubeObject[] }
  | { subscription: string; type: "delta"; upserted: KubeObject[]; removed: string[] }
  | { subscription: string; type: "error"; status: number; message: string };

// Access checks go into a SelfSubjectAccessReview body, not a path, and may use "*".
const orAny = <T extends z.ZodString>(s: T) => z.union([z.literal("*"), s]);
export const AccessCheck = z.object({
  verb: z.string().max(32).regex(/^[a-z*]+$/, "not a verb"),
  group: orAny(GroupName),
  resource: orAny(ResourceName),
  namespace: NamespaceName.optional(),
});
export type AccessCheck = z.infer<typeof AccessCheck>;

/** An ACP session id, as the agent made it. */
export const SessionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "not a session id");

// Graphs (docs/metrics.md): CPU and memory over time, from Clickland when it is connected and answers, else from
// metrics-server sampled while Landlens is open, else nothing and a reason.
export const MetricsRange = z.enum(["1h", "6h", "24h"]);
export type MetricsRange = z.infer<typeof MetricsRange>;
export const MetricsScope = z.enum(["cluster", "namespace", "node", "deployment", "statefulset", "daemonset", "pod"]);
export type MetricsScope = z.infer<typeof MetricsScope>;
export const MetricsRequest = z
  .object({ handle: Handle, scope: MetricsScope, namespace: NamespaceName.optional(), name: ObjectName.optional(), range: MetricsRange })
  .refine((r) => r.scope === "cluster" || !!r.name || r.scope === "namespace", "this scope needs a name")
  .refine((r) => !["namespace", "deployment", "statefulset", "daemonset", "pod"].includes(r.scope) || !!r.namespace, "this scope needs a namespace");
export type MetricsRequest = z.infer<typeof MetricsRequest>;

/**
 * Clickland's address and key. The key travels renderer → main only (when the person types it); main keeps it
 * encrypted with safeStorage and never sends it back. Plain http only to this machine, so a key never crosses a network
 * in the clear.
 */
export const ClicklandUrl = z
  .string()
  .max(500)
  .refine((u) => {
    // scheme://host[:port][/path]: no user info, query or fragment (the contracts build has no URL global).
    const m = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.exec(u);
    if (!m) return false;
    return m[1] === "https" || ["127.0.0.1", "localhost", "[::1]"].includes(m[2]!.toLowerCase());
  }, "https, or http to this machine (127.0.0.1, localhost)");
export const ClicklandKey = z.string().max(200).regex(/^ck_[A-Za-z0-9_-]{16,128}$/, "not a Clickland API key (ck_…)");
/** The cluster's name in Clickland's data (`k8s.cluster.name`); a label value. */
export const ClicklandClusterName = z.string().max(253).regex(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/, "not a cluster name");
export const ClicklandSettingsInput = z.object({
  url: ClicklandUrl,
  /** Absent: keep the key already stored. */
  key: ClicklandKey.optional(),
  /** The kubeconfig context this name is for, and the name; absent: the context's own name. */
  cluster: z.object({ context: z.string().min(1).max(253), name: ClicklandClusterName }).optional(),
});

// MCP (docs/mcp.md): the gateway every agent session's MCP calls go through, the servers it serves (the built-in
// landlens-kube and remote servers you add), the call log, and MCP Apps (tool views in a sandboxed frame).

/** The built-in server's name; no remote server may take it or anything starting with "landlens". */
export const BUILTIN_MCP_SERVER = "landlens-kube";
/** How a remote server is named in Claude Code (`mcp__<name>__<tool>`): lowercase letters, digits and dashes. */
export const McpServerName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/, "2–32 lowercase letters, digits and dashes, starting with a letter")
  .refine((n) => !n.startsWith("landlens"), "names starting with landlens are Landlens's own");
export const McpServerId = z.string().regex(/^s_[A-Za-z0-9_-]{8,32}$/, "not a server id");
/** https anywhere, or plain http only to this machine, with no user info or fragment. */
export const McpUrl = z
  .string()
  .max(500)
  .refine((u) => {
    const m = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?(\/[A-Za-z0-9._~\/%-]*)?(\?[A-Za-z0-9._~=&%-]*)?$/.exec(u);
    if (!m) return false;
    return m[1] === "https" || ["127.0.0.1", "localhost", "[::1]"].includes(m[2]!.toLowerCase());
  }, "https, or http to this machine (127.0.0.1, localhost)");
/** A header Landlens adds to every request to that server (e.g. Authorization). Never one MCP or HTTP itself owns. */
export const McpHeaderName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "not a header name")
  .refine((h) => !/^(host|cookie|origin|referer|connection|content-(length|type|encoding)|transfer-encoding|accept|mcp-session-id|mcp-protocol-version|last-event-id|x-landlens-.*)$/i.test(h), "Landlens sets this header itself");
export const McpHeaderValue = z.string().min(1).max(4096).regex(/^[\x20-\x7e]+$/, "printable ASCII only");
/** Origins a remote server's views may reach, if its resource declares them too: https only, exact host. */
export const McpAppOrigin = z.string().max(200).regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, "an https origin, like https://api.example.com");
export const McpToolName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/, "not a tool name");
export const McpCallId = z.string().regex(/^c[0-9a-z]{1,24}$/, "not a call id");
export const McpViewId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "not a view id");
export const McpServerInput = z.object({
  /** Absent: a new server. */
  id: McpServerId.optional(),
  name: McpServerName,
  url: McpUrl,
  /** Absent: no header. `value` absent: keep the stored value. */
  header: z.object({ name: McpHeaderName, value: McpHeaderValue.optional() }).optional(),
  appOrigins: z.array(McpAppOrigin).max(10).optional(),
});

/** Request/response channels: name → [request schema, response type]. */
export const channels = {
  "catalog:list": z.object({}),
  "cluster:connect": z.object({ context: z.string().min(1).max(253) }),
  "cluster:disconnect": z.object({ handle: Handle }),
  "cluster:discovery": z.object({ handle: Handle }),
  "cluster:access": z.object({ handle: Handle, checks: z.array(AccessCheck).max(200) }),
  "cluster:health": z.object({ handle: Handle, namespace: NamespaceName.optional() }),
  "resource:get": z.object({ handle: Handle, ref: ResourceRef }),
  "resource:events": z.object({ handle: Handle, namespace: NamespaceName.optional(), uid: Uid }),
  "watch:subscribe": WatchRequest,
  "watch:unsubscribe": z.object({ subscription: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }),
  // The agent (wave 2): one session per cluster, read-only.
  "agent:start": z.object({ handle: Handle, namespaces: z.array(NamespaceName).max(20).optional() }),
  "agent:prompt": z.object({ session: SessionId, text: z.string().min(1).max(20_000), context: z.array(ResourceRef).max(10).optional() }),
  "agent:cancel": z.object({ session: SessionId }),
  "agent:mode": z.object({ session: SessionId, mode: z.string().min(1).max(64) }),
  "agent:config": z.object({ session: SessionId, config: z.string().min(1).max(64), value: z.string().min(1).max(200) }),
  "agent:answer": z.object({ request: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), option: z.string().max(200).nullable() }),
  "agent:close": z.object({ session: SessionId }),
  "metrics:series": MetricsRequest,
  "metrics:settings": z.object({ context: z.string().min(1).max(253).optional() }),
  "metrics:configure": ClicklandSettingsInput,
  "metrics:test": z.object({ handle: Handle.optional(), url: ClicklandUrl.optional(), key: ClicklandKey.optional(), cluster: ClicklandClusterName.optional() }),
  "metrics:disconnect": z.object({}),
  // MCP (docs/mcp.md). Header values come in with save and test; nothing sends them back.
  "mcp:servers": z.object({ context: z.string().min(1).max(253).optional() }),
  "mcp:save": McpServerInput,
  "mcp:test": z.object({ id: McpServerId.optional(), url: McpUrl.optional(), header: z.object({ name: McpHeaderName, value: McpHeaderValue.optional() }).optional() }),
  "mcp:enable": z.object({ id: McpServerId, context: z.string().min(1).max(253), enabled: z.boolean() }),
  "mcp:remove": z.object({ id: McpServerId }),
  "mcp:preset": z.object({ preset: z.literal("clickland") }),
  "mcp:calls": z.object({}),
  /** Run one read-only tool that needs no arguments, as you, to see what it returns and its app. */
  "mcp:try": z.object({ handle: Handle, server: z.string().min(1).max(32), tool: McpToolName }),
  "mcp:app-open": z.object({ call: McpCallId }),
  "mcp:app-call": z.object({ view: McpViewId, name: McpToolName, arguments: z.record(z.string(), z.unknown()).optional() }),
  "mcp:app-close": z.object({ view: McpViewId }),
  "mcp:app-link": z.object({ view: McpViewId, url: z.string().min(1).max(2000) }),
} as const;
export type Channel = keyof typeof channels;

export type Responses = {
  "catalog:list": { contexts: KubeContext[]; error?: string };
  "cluster:connect": ClusterInfo;
  "cluster:disconnect": { ok: true };
  "cluster:discovery": { types: ResourceType[] };
  "cluster:access": { allowed: boolean[] };
  "cluster:health": ClusterHealth;
  "resource:get": { object: KubeObject };
  "resource:events": { items: KubeObject[] };
  "watch:subscribe": { subscription: string };
  "watch:unsubscribe": { ok: true };
  "agent:start": AgentSessionInfo;
  "agent:prompt": { stopReason: string };
  "agent:cancel": { ok: true };
  "agent:mode": { ok: true };
  "agent:config": { ok: true };
  "agent:answer": { ok: true };
  "agent:close": { ok: true };
  "metrics:series": MetricsSeries;
  "metrics:settings": ClicklandSettings;
  "metrics:configure": ClicklandSettings;
  "metrics:test": ClicklandTest;
  "metrics:disconnect": ClicklandSettings;
  "mcp:servers": McpServers;
  "mcp:save": McpServerInfo;
  "mcp:test": McpTest;
  "mcp:enable": McpServerInfo;
  "mcp:remove": { ok: true };
  "mcp:preset": McpServerInfo;
  "mcp:calls": { calls: McpCall[] };
  "mcp:try": McpCall;
  "mcp:app-open": McpAppView;
  "mcp:app-call": McpToolResult;
  "mcp:app-close": { ok: true };
  "mcp:app-link": { opened: boolean };
};

/** A tool as the MCP page shows it. */
export type McpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  /** The server says it only reads (annotations.readOnlyHint). Only these run without asking. */
  readOnly: boolean;
  /** Its app's `ui://` resource, if it has one. */
  app?: string;
  /** Who may call it: the model, its app, or both (MCP Apps `_meta.ui.visibility`). */
  visibility: ("model" | "app")[];
  /** Arguments it requires. */
  required: string[];
};
export type McpServerInfo = {
  /** "landlens-kube" for the built-in server, else its stored id. */
  id: string;
  name: string;
  builtin: boolean;
  url: string;
  /** The header Landlens adds, and whether a value is stored. The value itself never leaves main. */
  header?: { name: string; stored: boolean };
  /** Used by agent sessions on the asked cluster (the built-in always is). */
  enabled: boolean;
  appOrigins: string[];
  /** From the last listing; absent until the server answered once. */
  tools?: McpToolInfo[];
  status: "ready" | "unknown" | "failed";
  detail?: string;
};
export type McpServers = {
  /** The gateway's loopback address. */
  gateway: string;
  servers: McpServerInfo[];
  canStore: boolean;
  /** Servers Landlens knows how to add in one step, when they answer. */
  presets: { id: "clickland"; name: string; url: string; reachable: boolean; hasKey: boolean; added: boolean }[];
};
export type McpTest = { ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; tools?: McpToolInfo[] };
/** A front-door request behind a landlens-kube call, from the front door's audit. */
export type McpFrontDoorRequest = { at: string; method: string; path: string; allowed: boolean; status?: number; reason?: string };
/** One MCP call through the gateway: by an agent session, by an app's view, or by you (Preview). */
export type McpCall = {
  id: string;
  /** The ACP session id, or "console" for Preview. */
  session: string;
  /** "agent 2 · orbstack", "you · orbstack". */
  label: string;
  server: string;
  tool: string;
  origin: "agent" | "app" | "you";
  /** Scrubbed like a tool result. */
  args: unknown;
  startedAt: number;
  endedAt?: number;
  ms?: number;
  /** refused: Landlens refused it before it reached the server (visibility, approval, ended session). */
  status: "running" | "ok" | "error" | "refused";
  /** The result's text, scrubbed and cut to 2,000 characters. */
  preview?: string;
  error?: string;
  /** The dock's tool card this call belongs to (ACP toolCallId), once paired. */
  toolCallId?: string;
  /** The tool's app resource, when the call returned and its view can be opened. */
  app?: string;
  /** For landlens-kube: what it asked the front door. */
  requests: McpFrontDoorRequest[];
};
export type McpToolResult = { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };
/** A view ready to load: the frame's address on the sandbox origin, and what the host hands the view. */
export type McpAppView = {
  view: string;
  url: string;
  server: string;
  tool: McpToolInfo;
  input: Record<string, unknown>;
  result: McpToolResult;
  prefersBorder?: boolean;
  /** The CSP the view runs under, for the record. */
  csp: string;
};

/** [time in ms, value]. CPU in cores, memory in bytes. */
export type MetricPoint = [number, number];
export type MetricLine = { key: string; points: MetricPoint[] };
/** One measure (CPU or memory) for a scope. Reference values are the latest known; absent when unknown or unset. */
export type MetricPanel = {
  /** Usage: per container (pod), per pod (workload, namespace), per node (cluster, node). */
  series: MetricLine[];
  /** For a pod, the sum over its containers; for a workload, per pod. Absent if no container sets one. */
  request?: number;
  /** As request, and only when every container sets one (otherwise there is no total limit). */
  limit?: number;
  /** Cluster and node: what the nodes can give to pods. */
  allocatable?: number;
  /** Per container: its own request and limit, for the readout. */
  byKey?: Record<string, { request?: number; limit?: number }>;
};
export type MetricsReasonCode =
  | "clickland-off" // no key stored
  | "clickland-unreachable"
  | "clickland-unauthorized"
  | "clickland-failed"
  | "clickland-no-cluster" // answers, but has nothing for this cluster's name
  | "no-metrics-server"
  | "live-only"; // metrics-server: samples only since Landlens opened, at most an hour
export type MetricsReason = { code: MetricsReasonCode; message: string };
export type MetricsSeries = {
  source: "clickland" | "metrics-server" | "none";
  /** Why a better source wasn't used, and anything the reader should know about this one. */
  reasons: MetricsReason[];
  /** Seconds between points. */
  step: number;
  from: number;
  to: number;
  /** What one series is. */
  by: "container" | "pod" | "node";
  cpu: MetricPanel;
  memory: MetricPanel;
  /** Cluster scope: the namespaces using the most, mean over the range, largest CPU first. */
  namespaces?: { key: string; cpu: number; memory: number }[];
  /** The name the cluster has in Clickland's data. */
  cluster?: string;
};
export type ClicklandSettings = {
  url: string;
  /** Whether a key is stored. The key itself never leaves main. */
  hasKey: boolean;
  /** Whether safeStorage can encrypt on this machine; without it Landlens won't store a key. */
  canStore: boolean;
  /** The Clickland cluster name for the asked context (its own name unless set). */
  cluster?: string;
};
export type ClicklandTest = {
  ok: boolean;
  /** One line per step: the health check, then a query. */
  steps: { name: string; ok: boolean; detail: string }[];
};

/** What is wrong in a cluster right now, problems first: the Overview page and the agent's cluster_overview. */
export type HealthProblem = {
  kind: "Pod" | "Deployment" | "Node";
  namespace?: string;
  name: string;
  /** CrashLoopBackOff, OOMKilled, Pending, NotReady, Unavailable, Restarts, … */
  reason: string;
  /** One line: "in container api, 11 restarts; last exit Error code 1". */
  detail: string;
  tone: "bad" | "warn";
  container?: string;
  restarts?: number;
};
export type HealthEvent = {
  at: string;
  namespace?: string;
  kind: string;
  name: string;
  reason: string;
  message: string;
  count: number;
};
export type ClusterHealth = {
  at: string;
  nodes: { total: number; ready: number; items: { name: string; ready: boolean; version: string; roles: string[] }[] } | null;
  pods: { total: number; running: number; succeeded: number; pending: number; failing: number; restarts: number };
  deployments: { total: number; available: number } | null;
  namespaces: number;
  problems: HealthProblem[];
  warnings: HealthEvent[];
};

/** A choice the agent offers: a mode, or a value of a config option such as the model. */
export type AgentChoice = { id: string; name: string; description?: string | null };

export type AgentSessionInfo = {
  session: string;
  /** How the front door's audit trail names this session, e.g. "agent 2 · orbstack". */
  label: string;
  agent: string;
  context: string;
  namespaces?: string[];
  mode?: { current: string; available: AgentChoice[] };
  /** Select-type config options (model, effort): current value and choices. */
  options: { id: string; name: string; current: string; choices: AgentChoice[] }[];
};

/**
 * An ACP session/update, passed through as the agent sent it. The dock reads `sessionUpdate` and the fields of each
 * kind (agent_message_chunk, tool_call, tool_call_update, plan, current_mode_update, usage_update, …).
 */
export type AgentUpdate = { session: string; update: { sessionUpdate: string; [k: string]: unknown } };

/** The agent asks before a tool call its own rules don't settle. Landlens shows it; the person answers. */
export type AgentPermissionRequest = {
  request: string;
  session: string;
  toolCall: { toolCallId: string; title?: string | null; kind?: string | null; rawInput?: unknown };
  options: { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[];
};

export type AgentStatus =
  | { state: "starting" | "ready" }
  | { state: "stopped"; message: string }
  | { state: "answered"; request: string };
export type Request<C extends Channel> = z.infer<(typeof channels)[C]>;

/** Main → renderer push channels. */
export const pushChannels = ["watch:event", "cluster:status", "agent:update", "agent:permission", "agent:status", "mcp:call"] as const;
export type PushChannel = (typeof pushChannels)[number];

/** An error crossing IPC keeps a Kubernetes-like status code so the UI can say "no access" vs "failed". */
export type IpcError = { status: number; message: string };

/** What the preload bridge exposes as `window.landlens`. */
export interface LandlensBridge {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Responses[C]>;
  on(channel: PushChannel, listener: (payload: any) => void): () => void;
}
