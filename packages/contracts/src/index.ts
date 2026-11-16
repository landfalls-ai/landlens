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
/** A problem's id as the doctor makes it: one line, at most 600 characters. */
export const ProblemId = z.string().min(1).max(600).regex(/^[^\u0000-\u001f\u007f]+$/, "not a problem id");
export const Uid = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "not a uid");

export const KubeContext = z.object({
  name: z.string(),
  cluster: z.string(),
  user: z.string(),
  server: z.string(),
  namespace: z.string().optional(),
  current: z.boolean(),
  /**
   * Where the context comes from: your kubeconfig, or a GKE cluster of a Google Cloud project you chose (wave 6, D91),
   * which Landlens lists from its own kubeconfig in its data folder and never writes to yours.
   */
  source: z.enum(["kubeconfig", "gke"]),
  /** A GKE context's project and location. */
  project: z.string().optional(),
  location: z.string().optional(),
  /** A GKE context you already said yes to connecting (asked once per cluster, D91). */
  confirmed: z.boolean().optional(),
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
  /** Defined by a CustomResourceDefinition (from the CRD list's names; by group when that list can't be read). */
  custom: z.boolean().optional(),
});
export type ResourceType = z.infer<typeof ResourceType>;

/** One object the ⌘K palette can find: its kind and name, nothing of its content. */
export type SearchEntry = { group: string; version: string; resource: string; kind: string; name: string; namespace?: string };

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
  /** "exec" for pods/exec, "log" for pods/log. */
  subresource: z.string().max(32).regex(/^[a-z]+$/, "not a subresource").optional(),
});
export type AccessCheck = z.infer<typeof AccessCheck>;

/** An ACP session id, as the agent made it. */
export const ChangeId = z.string().regex(/^ch[A-Za-z0-9_-]{8,32}$/, "not a change id");
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

// A Land family sibling's address (docs/family.md, wave 7 D102): one rule for Clickland, Landflow and Landfall. An
// origin only: scheme://host[:port], a trailing "/" at most; no user info, path, query or fragment (the contracts build
// has no URL global). https anywhere; plain http only to this machine, so a key never crosses a network in the clear.
// An unpackaged build may also take plain http to the exact hosts in LANDLENS_FAMILY_HTTP_HOSTS: main decides that
// (main/family.ts), so the family channels take FamilyOrigin, the shape, and main applies familyUrlAllowed.
const FAMILY_ORIGIN = /^(https?):\/\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\])(:\d{1,5})?\/?$/;
/** This machine's names: plain http may go to these. */
export const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;
/** A host name LANDLENS_FAMILY_HTTP_HOSTS may list. */
export const FAMILY_HTTP_HOST = /^[a-z0-9.-]{1,253}$/;
/** https, or http to this machine or to one of `httpHosts` (exact, lowercase). False for anything that isn't an origin. */
export function familyUrlAllowed(u: string, httpHosts: readonly string[] = []): boolean {
  const m = FAMILY_ORIGIN.exec(u);
  if (!m) return false;
  const port = m[3] ? Number(m[3].slice(1)) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return false;
  const host = m[2]!.toLowerCase();
  return m[1] === "https" || (LOCAL_HOSTS as readonly string[]).includes(host) || httpHosts.includes(host);
}
/** An origin's shape, for the channels; main applies familyUrlAllowed with its overrides. */
export const FamilyOrigin = z.string().max(300).regex(FAMILY_ORIGIN, "an address like https://landflow.example or http://127.0.0.1:3000, with no path");
/** A sibling's address as this build takes it with no overrides. */
export const FamilyUrl = FamilyOrigin.refine((u) => familyUrlAllowed(u), "https, or http to this machine (127.0.0.1, localhost)");

/**
 * Clickland's address and key. The key travels renderer → main only (when the person types it); main keeps it
 * encrypted with safeStorage and never sends it back. Since wave 7 the address follows the family's rule (FamilyUrl).
 */
export const ClicklandUrl = FamilyUrl;
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

// Clickland's history in the IDE (docs/metrics.md#logs-and-traces, wave 7 part 3, D115–D118): a pod's or a workload's
// logs and traces, read in main with Clickland's key. The window names an object and a range; main builds the search
// from names it validated (each a quoted term), so nothing the window sends is search syntax. Answers are checked,
// capped and their bodies scrubbed (redactText) before they cross.
export const ClicklandRange = z.enum(["1h", "6h", "24h", "7d"]);
export type ClicklandRange = z.infer<typeof ClicklandRange>;
/** A Kubernetes name as Clickland's collectors record it (a DNS subdomain). */
export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
export const ClicklandScope = z.object({
  kind: z.enum(["pod", "deployment", "statefulset", "daemonset"]),
  namespace: NamespaceName,
  name: z.string().min(1).max(253).regex(K8S_NAME, "not a Kubernetes name"),
  container: z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "not a container name").optional(),
});
export type ClicklandScope = z.infer<typeof ClicklandScope>;
/** Clickland's paging cursor (its SearchRequest's `before`). */
export const ClicklandCursor = z.string().regex(/^\d{1,20}$/, "not a cursor");
/** A trace id as Clickland takes it: hex. */
export const ClicklandTraceId = z.string().regex(/^[0-9a-f]{1,64}$/, "not a trace id");
export const ClicklandLogsRequest = z.object({
  handle: Handle,
  scope: ClicklandScope,
  range: ClicklandRange,
  /** Words to find, sent as one quoted phrase, never as search syntax. One line. */
  filter: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/, "one line").optional(),
  /** "Errors only": the fixed error levels (error, fatal, critical). */
  errors: z.boolean().optional(),
  before: ClicklandCursor.optional(),
});
/** One log line from Clickland, as Landlens keeps it: the body scrubbed and cut, three attributes, the rest dropped. */
export type ClRow = {
  at: string;
  body: string;
  severity?: string;
  service?: string;
  pod?: string;
  container?: string;
  stream?: "stdout" | "stderr";
  /** The body was longer than 8,192 characters and is cut. */
  cut?: true;
};
export type ClicklandLogs =
  | { rows: ClRow[]; next?: string; cut: boolean; source: "clickland"; cluster: string }
  | { unavailable: MetricsReason };
/** One trace of a service: its top span of that service, when, how long, and whether any of its spans failed. */
export type ClTrace = { id: string; name: string; service: string; at: string; ms: number; error: boolean };
/**
 * `scoped`: every span listed named the window's cluster and namespace (k8s.cluster.name, k8s.namespace.name); spans
 * that named another were dropped. False: the list is by service name, in any cluster (security review of part 3, M3).
 */
export type ClicklandTraces = { traces: ClTrace[]; service: string; scoped: boolean } | { unavailable: MetricsReason };
/** A span of one trace, for the plain span list (no waterfall): depth, start offset and duration on one scale. */
export type ClSpan = { id: string; name: string; service: string; kind?: string; depth: number; offsetMs: number; ms: number; error: boolean };
export type ClicklandTrace = { spans: ClSpan[]; ms: number; cut: boolean } | { unavailable: MetricsReason };

// MCP (docs/mcp.md): the gateway every agent session's MCP calls go through, the servers it serves (the built-in
// landlens-kube and remote servers you add), the call log, and MCP Apps (tool views in a sandboxed frame).

/**
 * A log line that looks like the failure. Applied to log output only (the log view, and the dock's wells for get_logs
 * and kubectl logs): in a describe or a command line, "FATAL" is just a word.
 */
export const FAILURE_LINE = /\b(FATAL|ERROR|Error:|panic|Exception|Traceback|fatal:|error:|OOMKilled|Killed)\b|\b(ERR|CRIT|SEVERE)\b/;

/** The built-in server's name; no remote server may take it or anything starting with "landlens". */
export const BUILTIN_MCP_SERVER = "landlens-kube";
/**
 * Server names Connections serves on the gateway (wave 6, and the Land family's in wave 7 D107): a server you add can't
 * take one.
 */
export const RESERVED_MCP_NAMES = ["github", "linear", "landlens-gcp", "clickland", "landflow", "landfall"] as const;
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

// Connections (docs/connections.md, wave 6): Landlens's own sign-in to GitHub and Linear. Tokens come in on
// conn:token and nothing ever sends one back; the page names a provider, never an address.
export const ConnProvider = z.enum(["github", "linear"]);
export type ConnProvider = z.infer<typeof ConnProvider>;
/** "read": the read-only endpoint is the upstream; "ask": every write asks. Autonomous is per session, never stored. */
export const ConnMode = z.enum(["read", "ask"]);
export type ConnMode = z.infer<typeof ConnMode>;
export type ConnMethod = "device" | "oauth" | "token";
/** A sign-in in progress (a device code or a browser sign-in), made by main. */
export const FlowId = z.string().regex(/^fl[A-Za-z0-9_-]{16}$/, "not a flow id");
/** A GitHub token Landlens accepts pasted: classic (`ghp_…` and the other `gh?_` kinds) or fine-grained. */
export const GITHUB_TOKEN_SHAPE = /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;
/** A Linear API key or OAuth token. */
export const LINEAR_KEY_SHAPE = /^lin_(api|oauth)_[A-Za-z0-9]{20,255}$/;
export const ConnTokenInput = z
  .object({ provider: ConnProvider, token: z.string().min(1).max(400).regex(/^[\x21-\x7e]+$/, "one line of printable characters") })
  .refine((t) => (t.provider === "github" ? GITHUB_TOKEN_SHAPE : LINEAR_KEY_SHAPE).test(t.token), "not shaped like a token for that provider");
/** Who a connection signed in as; each field one line, at most 100 characters. */
export type ConnAccount = { login: string; name?: string; org?: string };
/** What the renderer may know about a connection: never a token. */
export type ConnInfo = {
  provider: ConnProvider;
  state: "off" | "connecting" | "ready" | "expired" | "failed";
  method?: ConnMethod;
  account?: ConnAccount;
  /** As the provider reported them. */
  scopes?: string[];
  mode: ConnMode;
  /** Its read tools run without asking (D79). */
  readsAuto: boolean;
  /** "Give to Claude sessions": a ready connection's tools are served to every agent session (D77). */
  give: boolean;
  /** From the last listing (conn:test). */
  tools?: { read: number; write: number };
  /** One of CONN_NOTES. */
  note?: string;
  /** GitHub: a client id is built in, so the device flow is offered. */
  canDevice?: boolean;
};
/** Every sentence a connection's note can be. */
export const CONN_NOTES = {
  cantStore: "This machine can't encrypt the token, so Landlens won't store it.",
  githubRefused: "GitHub didn't accept the token.",
  linearRefused: "Linear didn't accept the key.",
  githubUnreachable: "Couldn't reach GitHub.",
  linearUnreachable: "Couldn't reach Linear.",
  githubAnswer: "GitHub's answer wasn't what Landlens expected.",
  linearAnswer: "Linear's answer wasn't what Landlens expected.",
  deviceExpired: "The code expired before it was entered. Connect again.",
  deviceDenied: "The sign-in was turned down at GitHub.",
  noDevice: "GitHub sign-in needs Landlens's app, which isn't registered yet. Use a token instead.",
  linearDenied: "The sign-in was turned down at Linear.",
  linearTimeout: "The sign-in wasn't finished within 5 minutes. Connect again.",
  linearElsewhere: "Linear's sign-in named another server, so Landlens stopped.",
  linearExpired: "Linear's sign-in ran out. Connect again.",
  linearReadScope: "Linear was connected for reading only. Connect again to let Claude ask for writes.",
  drift: "The tools changed since you accepted them. Look at them, then accept.",
  unaccepted: "Look at its tools, then accept them, so its reads can run without asking.",
  readonlyUnproven: "Its read-only endpoint didn't list fewer tools than the full one, so no tool counts as a read and Read only isn't served.",
  githubNameTaken: "Rename your server named github first.",
  linearNameTaken: "Rename your server named linear first.",
} as const;
export type ConnList = { canStore: boolean; github: ConnInfo; linear: ConnInfo };

// The Land family (docs/family.md, wave 7): Landlens's own sign-in to the Clickland, Landflow and Landfall the person
// runs, held in main. A key or token comes in on family:connect (Landflow's pasted key), family:signin (Landfall's
// browser sign-in) or family:set (the triage webhook's secret); no channel sends one back.
export const Sibling = z.enum(["clickland", "landflow", "landfall"]);
export type Sibling = z.infer<typeof Sibling>;
/** A sibling as a provider on the gateway (D107): its server's name is the sibling's. */
export const FamilyProvider = Sibling;
export type FamilyProvider = Sibling;
/** Any server the gateway treats as a provider's: a wave 6 connection or a family sibling. */
export const AnyProvider = z.enum(["github", "linear", "clickland", "landflow", "landfall"]);
export type AnyProvider = z.infer<typeof AnyProvider>;
/**
 * A Landflow personal API key (`lf_` and 32 random bytes, base64url). Not an instance MCP token (`lf_mcp_`, which acts
 * for nobody), a debug token (`lf_dbg_`) or a Landfall key (`lf_key_`).
 */
export const LANDFLOW_KEY_SHAPE = /^lf_(?!mcp_|key_|dbg_)[A-Za-z0-9_-]{20,128}$/;
export const LandflowKey = z.string().max(200).regex(LANDFLOW_KEY_SHAPE, "not a Landflow API key (lf_…)");
/** The triage flow's webhook path under /api/webhook/ (D121): no dots, so no dot segments. */
export const TriagePath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,119}$/, "letters, digits, /, _ and -");
/** The header the webhook's secret goes in: never one HTTP or Landlens owns. */
export const TriageHeader = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "not a header name")
  .refine(
    (h) => !/^(host|cookie|authorization|proxy-authorization|connection|keep-alive|upgrade|expect|te|trailer|origin|forwarded|x-forwarded-.*|content-(length|type|encoding)|transfer-encoding|idempotency-key|x-landlens-.*)$/i.test(h),
    "Landlens sets this header itself, or it can't carry the secret",
  );
/** The webhook's secret: one line of printable characters, no space at either end. */
export const TriageSecret = z.string().max(400).regex(/^[\x21-\x7e](?:[\x20-\x7e]{0,398}[\x21-\x7e])?$/, "one line of printable characters");
export type FamilyAccount = { name?: string; email?: string; org?: string; role?: string };
/** What the renderer may know about a sibling: never a key, token or secret. */
export type FamilyInfo = {
  sibling: Sibling;
  state: "off" | "connecting" | "ready" | "expired" | "failed";
  /** The origin, as stored. */
  url: string;
  method?: "key" | "oauth";
  /** Who the key or sign-in is; each field one line, at most 100 characters. */
  account?: FamilyAccount;
  /** As the sibling reported them. */
  scopes?: string[];
  /** "Tools for Claude" (D108): its MCP server is given to every agent session. Off when first connected. */
  toSessions: boolean;
  /** "Reads run without asking" (D110): on when first connected. */
  readsAuto: boolean;
  /** The accepted listing's reads and writes (D110: Landlens's list, the server's hint and the pin together). */
  tools?: { read: number; write: number };
  /** Its tools changed since you accepted them (D111): every tool of its server asks until you accept again. */
  drift?: boolean;
  /** One of FAMILY_NOTES. */
  note?: string;
  /** Landflow: what the key's scopes cover. */
  can?: { brain: boolean; run: boolean; runs: boolean; flows: boolean };
  /** Landflow: the triage flow's webhook (D121). */
  triage?: { path: string; header: string; hasSecret: boolean };
  /** Clickland: the console's origin, for Open in Clickland (D118). */
  console?: string;
  /** Clickland: Landlens's own telemetry to its collector (D127, D133). */
  telemetry?: TelemetryInfo;
};
export type FamilyList = { canStore: boolean; clickland: FamilyInfo; landflow: FamilyInfo; landfall: FamilyInfo };
/** Every sentence a sibling's note or error can be; the raw error goes to main's log only. */
export const FAMILY_NOTES = {
  cantStore: "This machine can't encrypt the token, so Landlens won't store it.",
  httpOnlyHere: "Use https, or plain http only to this machine (127.0.0.1, localhost).",
  keyElsewhere: "Paste the key again: a stored key never follows a new address.",
  unreachable: "Nothing is listening at that address.",
  clicklandRefused: "Clickland refused the key.",
  clicklandAnswer: "Clickland's answer wasn't what Landlens expected.",
  clicklandSlow: "Clickland didn't answer in time.",
  clicklandWrites: "This key can also write. A key with only read is enough.",
  landflowRefused: "Landflow refused the key.",
  landflowAnswer: "Landflow's answer wasn't what Landlens expected.",
  landflowSlow: "Landflow didn't answer in time.",
  landflowNotKey: "Landflow didn't take that as a personal API key.",
  landflowWrites: "This key can also change workflows. Landlens doesn't need that.",
  connectLandflow: "Connect Landflow first.",
  landfallOff: "This Landfall doesn't offer its MCP connector (MCP_GATEWAY_ENABLED is off).",
  landfallAnswer: "Landfall's answer wasn't what Landlens expected.",
  landfallSlow: "Landfall didn't answer in time.",
  landfallElsewhere: "Landfall's sign-in named another server, so Landlens stopped.",
  landfallDenied: "The sign-in was turned down at Landfall.",
  landfallTimeout: "The sign-in wasn't finished within 5 minutes. Sign in again.",
  landfallExpired: "Landfall's sign-in ran out. Sign in again.",
  landfallUnreachable: "Couldn't reach Landfall.",
  landfallWider: "Landfall gave this sign-in more than read access, so Landlens didn't keep it.",
  landfallChanged: "Landfall's sign-in changed while it was refreshed. Try again.",
  drift: "Its tools changed since you accepted them. Review them, then accept.",
  unaccepted: "Its tools aren't accepted yet. Check them, then accept, so its reads can run without asking.",
  nameTaken: "A server you added on the MCP page has this name, so its tools stay off. Rename that server first.",
  badListing: "Its tool listing isn't one Landlens accepts (a tool name over 128 characters, or over 500 tools).",
  moved: "Moved from the MCP page: Claude sessions on every cluster get its tools now.",
  siblingAddress: "This is the address of a Land family app you connected: its tools reach Claude through Connections → Land family, not here.",
  reviewAgain: "Its tools changed since you reviewed them. Review them again, then accept.",
} as const;
/** "<Sibling> answered HTTP <n>.": the one note with a number in it. */
export const familyHttpNote = (name: "Clickland" | "Landflow" | "Landfall", status: number) => `${name} answered HTTP ${Math.trunc(status)}.`;

// Landflow on a resource (docs/family.md#landflow-on-a-resource, wave 7 part 4, D119–D126). Every send is the person's
// click on a sheet that shows what leaves; main builds every body from the cluster's own report and the person's
// choices, and the renderer sends only choices and the ids main gave it. A problem goes to Landflow's triage webhook as
// a Generic alert; a flow tagged `landlens` runs as a manual run of the saved workflow. Landlens never calls Landfall:
// a war room is opened only by Landflow's triage flow, and its link is read from the run.
export const TriageSeverity = z.enum(["sev1", "sev2", "sev3", "sev4"]);
export type TriageSeverity = z.infer<typeof TriageSeverity>;
/** A sheet main prepared (an alert or a flow's input), owned by the window that asked for it. */
export const LandflowSheetId = z.string().regex(/^ls[A-Za-z0-9_-]{20,40}$/, "not a sheet");
/** A send or run main made: landflow:follow and landflow:open take it, never an address. */
export const LandflowRunId = z.string().regex(/^lr[A-Za-z0-9_-]{20,40}$/, "not a run");
/**
 * The one id rule for Landflow's workflow and execution ids (`wf_…`, nanoid execution ids), shared by the channel, the
 * client and family-sent.json (security review of part 4, L9). A workflow listed with another id is shown as one
 * Landlens can't run.
 */
export const LANDFLOW_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A Landflow workflow id, as GET /api/workflows lists it (`wf_…`, or one a person chose). */
export const LandflowFlowId = z.string().regex(LANDFLOW_ID, "not a workflow id");
/**
 * The SHA-256 of the body a sheet shows, as hex (security review of part 4, H1): the send names it, and main refuses a
 * sheet whose body is no longer that one.
 */
export const LandflowDigest = z.string().regex(/^[0-9a-f]{64}$/, "not a digest");
/**
 * The Generic alert Landlens sends (D120): Normalize Alert reads title, severity, service, id, description, status and
 * environment with its default paths; the rest rides along.
 */
export type TriageAlert = {
  source: "landlens";
  title: string;
  severity: TriageSeverity;
  service: string;
  environment: string;
  status: "firing";
  id: string;
  fingerprint: string;
  description: string;
  labels: { cluster: string; namespace?: string; kind: string; name: string; class: string; reason: string };
  entity: { kind: string; id: string };
};
/** What the triage sheet shows: the alert exactly as it will be sent, where it goes, and the header's name. */
export type AlertPreview = {
  sheet: string;
  /** SHA-256 of the alert's JSON as main will post it: landflow:triage names it (H1). */
  digest: string;
  /** `<Landflow>/api/webhook/<path>`. */
  to: string;
  header: string;
  alert: TriageAlert;
  /** Log lines asked for: how many went in, or why none did (a fixed sentence). */
  logs?: { lines: number; note?: string };
};
/** The input a flow on a resource gets (D125): names, the problem it started from, the object's YAML if ticked. */
export type FlowInput = {
  landlens: 1;
  cluster: string;
  namespace?: string;
  kind: string;
  apiVersion: string;
  name: string;
  problem?: { class: string; reason: string; title: string };
  /** The object as Ask Claude would attach it: no Secret, no env[].value, at most 32 KiB. */
  yaml?: string;
};
/** `digest`: SHA-256 of the input's JSON as main will send it; landflow:run names it (H1). */
export type FlowPreview = { sheet: string; digest: string; to: string; input: FlowInput; yaml?: { note: string } };
/**
 * A flow tagged `landlens`: its name and description as text, one line each, and whose it is (review of part 4, M2):
 * the project that owns it and whether it reached the key's user through a share. `runnable: false`: its id isn't one
 * Landlens runs (LANDFLOW_ID); `id` is then only the row's key.
 */
export type LandflowFlow = { id: string; name: string; description?: string; owner?: string; shared: boolean; runnable: boolean };
/** Landfall's TriggerResult outcomes, read from the triage run's node outputs (D122). */
export type LandflowOutcome = "opened" | "attached" | "recorded" | "ignored" | "suppressed";
export type LandflowRunStatus = "running" | "queued" | "waiting" | "success" | "error" | "canceled";
/**
 * A send to triage or a flow's run, as the window sees it (D122, D125): fixed sentences, the run's status, Landfall's
 * outcome and the room's address (as text; opened only through landflow:open), and for a flow its last node's output,
 * scrubbed and cut. Nothing else of the run crosses.
 */
export type LandflowRun = {
  run?: string;
  note: string;
  tone: "ok" | "warn" | "bad" | "info";
  /** Still worth asking again (landflow:follow). */
  follow: boolean;
  status?: LandflowRunStatus;
  /** The run's address in Landflow, as text. */
  runLink?: string;
  outcome?: LandflowOutcome;
  /** The room's address, as text. */
  room?: string;
  /** A flow's last node's output: JSON as text, redacted, at most 4,000 characters. */
  output?: string;
};
/** A problem sent to triage from this cluster (D124): the chip on its row and drawer. */
export type LandflowSent = { run: string; problem: string; title: string; severity: TriageSeverity; at: string; state: "triage" | "room"; room?: string };
/** Every sentence a send or a run can show. */
export const LANDFLOW_NOTES = {
  sent: "Sent to triage.",
  following: "Sent to triage. Following the run…",
  held: "Landflow is holding it with other alerts.",
  secretRefused: "Landflow refused the webhook secret.",
  noWebhook: "No published flow listens at that webhook.",
  opened: "War room opened.",
  attached: "Attached to the room that is already open.",
  recorded: "Recorded; no room opened.",
  waiting: "Triage is waiting for on-call's answer.",
  failed: "The run failed. Open it in Landflow.",
  triageDone: "Triage finished without opening a room.",
  noRuns: "This key can't read runs (executions:read). Open it in Landflow.",
  gone: "Landflow no longer has this run.",
  started: "Started in Landflow. Following the run…",
  startedOnly: "Started in Landflow.",
  running: "Running in Landflow…",
  flowWaiting: "The run is waiting in Landflow.",
  finished: "Finished.",
  noFlow: "Landflow doesn't have that flow.",
  cantRun: "This key can't run flows (run).",
  cantList: "This key can't list workflows (workflows:read).",
  noTriage: "Set up the triage webhook on Connections → Landflow first.",
  notReady: "Connect Landflow first.",
  noSheet: "That sheet is gone. Open it again.",
  sheetChanged: "What this sheet shows changed. Look again before sending.",
  flowChanged: "This flow changed in Landflow since it was listed. Look again.",
  cantKeep: "Landlens can't keep a record of a send from this cluster, so it doesn't send it.",
  dialogOpen: "A dialog is already open.",
  stillGoing: "Still going. Check again in a moment.",
} as const;

// What Landlens reports (docs/family.md#what-landlens-reports, wave 7 part 5, D127–D135). Telemetry is off until the
// person turns it on and goes only to the collector address they confirmed; every record is built in main by
// packages/telemetry/src/records.ts from closed sets: an attribute key is one of TELEMETRY_KEYS and its value an enum,
// a number or a name that passed the Kubernetes-name rule. There is no free-text field. A session's summary goes to
// Landflow's brain as one private `work.session` event, drafted by rules in main, shown on a sheet and sent only on the
// person's click.
export const TELEMETRY_KEYS = [
  "gen_ai.operation.name", "gen_ai.agent.name", "gen_ai.conversation.id", "gen_ai.request.model",
  "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cost", "gen_ai.response.finish_reasons", "gen_ai.tool.name",
  "gen_ai.token.type",
  "landlens.mode", "landlens.ask", "landlens.cluster", "landlens.namespace", "landlens.namespaces", "landlens.subject.kind",
  "landlens.subject.namespace", "landlens.subject.name", "landlens.problem.class", "landlens.server", "landlens.status",
  "landlens.gate", "landlens.who", "landlens.verb", "landlens.kind", "landlens.outcome", "landlens.waited_ms",
  "landlens.event", "landlens.count", "landlens.policy", "landlens.allowed", "landlens.class", "landlens.tone", "landlens.action",
] as const;
export type TelemetryKey = (typeof TELEMETRY_KEYS)[number];
export type TelemetryValue = string | number | boolean;
export type TelemetryAttrs = { [K in TelemetryKey]?: TelemetryValue };
/**
 * One record exactly as it is queued for the collector (D132's drawer shows these). Times are milliseconds since the
 * epoch; ids are hex. `name` is a span, metric or event name from Landlens's own closed set.
 */
export type TelemetryRecord =
  | { signal: "span"; name: string; at: number; end: number; traceId: string; spanId: string; parentSpanId?: string; error: boolean; attrs: TelemetryAttrs }
  | { signal: "metric"; name: string; kind: "sum" | "gauge"; at: number; start: number; value: number; attrs: TelemetryAttrs }
  | { signal: "log"; name: string; at: number; severity: "info" | "warn" | "error"; attrs: TelemetryAttrs };
/** Where telemetry stands (D133), on the Clickland card. */
export type TelemetryInfo = {
  on: boolean;
  /** The collector's origin (OTLP/HTTP); records go to <collector>/v1/traces, /v1/metrics and /v1/logs. */
  collector: string;
  /** Names of the cluster, namespace and the object a question was about go with the records; off is "counts only". */
  names: boolean;
  /** `team.id` on every record, if the person typed one. */
  team?: string;
  /** The collector's last answer. */
  last?: { at: string; ok: boolean };
  /** Records waiting to go; at most 2,000 are kept, older ones dropped. */
  waiting: number;
  /** Records dropped since the app started (the cap, or three failed tries). */
  dropped: number;
};
export const DEFAULT_COLLECTOR = "http://127.0.0.1:4318";
/**
 * Whether a kubeconfig context's name may stand for its cluster when the person set no name for it (security review of
 * wave 7 part 5, L2, L3): one DNS label (lowercase letters, digits and dashes, at most 63) with no run of six or more
 * digits. So `orbstack`, `kind-dev` or `prod-eu-1` go; `gke_<project>_<zone>_<name>`, an EKS ARN with its account id,
 * `user@cluster`, `default/api-host:6443/admin` or `acme-123456789012` don't.
 */
export const plainContextName = (context: string): boolean => /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(context) && !/\d{6,}/.test(context);
/**
 * The cluster's name Landlens sends to a sibling (telemetry's `landlens.cluster`, the brain's draft): the name the
 * person set for Clickland's graphs, else the context's own name when it is plain, else none.
 */
export const clusterLabel = (set: string | undefined, context: string): string | undefined => set ?? (plainContextName(context) ? context : undefined);
/** A team's name as `team.id`: at most 60 characters, a name (lowercase letters, digits, `-`, `.`, `_`). */
export const TelemetryTeam = z.string().max(60).regex(/^[a-z0-9](?:[-a-z0-9._]{0,58}[a-z0-9])?$/, "a team name: lowercase letters, digits, - . _");
export const TELEMETRY_NOTES = {
  off: "Telemetry is off. Nothing is sent.",
  declined: "Telemetry stays off: you didn't confirm the collector.",
  namesDeclined: "Names stay off: you didn't confirm sending them.",
  dialogOpen: "A dialog is already open.",
  noConsole: "Set Clickland's console address first.",
  noSession: "Landlens has no such session.",
} as const;

/** A brain sheet main prepared for a session (D134), owned by the window that asked. */
export const BrainSheetId = z.string().regex(/^bs[A-Za-z0-9_-]{20,40}$/, "not a sheet");
export const BrainDigest = z.string().regex(/^[0-9a-f]{64}$/, "not a digest");
export const WorkVisibility = z.enum(["private", "team", "org"]);
export type WorkVisibility = z.infer<typeof WorkVisibility>;
/** Text the person may edit on the sheet, held to Landflow's limits (packages/protocol/src/work-events.ts). */
export const BrainTitle = z.string().min(1).max(200);
export const BrainSummary = z.string().max(500);
export const BrainHint = z.string().max(120);
/** The `work.session` event as the sheet shows it and main will send it (D134). */
export type WorkDraft = {
  kind: "work.session";
  source: "landlens";
  sourceId: string;
  occurredAt: string;
  endedAt?: string;
  turns: number;
  title: string;
  summary: string;
  visibility: WorkVisibility;
  team?: string;
  initiative?: string;
};
/**
 * The brain sheet (D134): the event as main drafted it from the session's own record, the facts the summary was drafted
 * from, where it goes, and the digest of the fields main fills (brain:send names it, so what is sent is what was shown).
 */
export type BrainDraft = { sheet: string; digest: string; to: string; event: WorkDraft; facts: string[]; open: boolean };
/** brain:send's answer: saved, or why not (Landflow's reason as text, or Landlens's fixed sentence). */
export type BrainSend = { saved: boolean; note: string; scrubbed?: { title: string; summary: string; team?: string; initiative?: string } };
export const BRAIN_NOTES = {
  saved: "Saved to your brain, private.",
  savedTeam: "Saved to your brain, shared with your team.",
  savedOrg: "Saved to your brain, shared with your organisation.",
  scrubbed: "Landlens hid something that looked like a secret. Check the text, then send again.",
  noBrain: "This Landflow key can't record work (brain:write).",
  notReady: "Connect Landflow first.",
  noSheet: "That sheet is gone. Open it again.",
  changed: "This session moved on since the sheet was made. Look again before sending.",
  closed: "Open the session to ask Claude for a draft.",
  removed: "Removed from your brain.",
  notThere: "Nothing of this session is in your brain.",
  brainOff: "The brain is off on this Landflow.",
  refused: "Landflow refused the key.",
  busy: "Claude is busy in this session. Ask again when it has answered.",
  declined: "Not sent: you didn't confirm who sees it.",
  dialogOpen: "A dialog is already open.",
  drafting: "Claude is drafting the brain's summary in this session. Ask when it is done, or cancel the draft.",
  draftCancelled: "The draft was cancelled.",
  draftTool: "Claude tried to use a tool while drafting, so Landlens stopped the draft. Write the summary, or ask again.",
} as const;
/** The one question "Ask Claude to draft" sends (D134): fixed, never the window's. */
export const BRAIN_PROMPT = "Summarise this session in at most 400 characters: the question, what you found, what was changed. No names of people, no secrets.";

// Google Cloud (docs/gcp.md, wave 6 part 4): browse every resource of the projects you choose, read-only, with
// gcloud's own sign-in. Landlens stores no Google credential; the token stays in main. Names are held to Google's
// shapes before they go into a path or a query.
/** A project id: 6–30 lowercase letters, digits and dashes, starting with a letter, not ending in a dash. */
export const GcpProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "not a project id");
/** A Cloud Asset type, such as compute.googleapis.com/Instance. */
export const GcpAssetType = z.string().regex(/^[a-z0-9.-]{1,80}\/[A-Za-z0-9]{1,80}$/, "not an asset type");
/** A resource's full name: starts with //, at most 1,000 characters, no quote, backslash or control character. */
export const GcpResourceName = z.string().max(1000).regex(/^\/\/[^"\\\u0000-\u001f\u007f]+$/, "not a resource name");
/** A Cloud Asset query typed in the page: one line, at most 500 characters. */
export const GcpQuery = z.string().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/, "one line");
/** Where Google Cloud stands: off in a development build, gcloud missing, nobody signed in to gcloud, or ready. */
export type GcpState = "off-dev" | "missing" | "signed-out" | "ready";
export type GcpStatus = {
  state: GcpState;
  /** gcloud's account, when signed in. */
  account?: string;
  /** The projects you chose to browse (ids only). */
  projects: string[];
  /** "Claude can read these projects" (D93): the landlens-gcp tools in agent sessions. Off by default. */
  agentRead: boolean;
  /**
   * While agentRead: the chosen projects you said yes to, for this account (review of part 5, M3). A project chosen
   * after that question isn't readable by Claude until main asks again (gcp:agent-read with on).
   */
  agentProjects?: string[];
};
export type GcpProject = { id: string; name: string; number: string };
/** One resource as Cloud Asset's search returns it: every string cut to 300 characters, at most 20 labels. */
export type GcpResource = {
  name: string;
  assetType: string;
  displayName?: string;
  location?: string;
  state?: string;
  createTime?: string;
  updateTime?: string;
  parent?: string;
  labels?: Record<string, string>;
};
export type GcpTypeCount = { assetType: string; count: number };
export type GkeCluster = { project: string; location: string; name: string; status: string; version: string; endpoint: string; context: string };
/**
 * A connected cluster that is a GKE cluster of a chosen project (wave 9, D173): main's answer, never the page's. `number`
 * is the project's number (the recommender names clusters by it), when the project search gave it.
 */
export type GkeRef = { project: string; number?: string; location: string; name: string };
/** One of Google's suggestions for a GKE cluster, from its diagnosis recommender (D176): Google's text, cleaned and cut. */
export type GkeAdvice = {
  /** The insight's last path segment. */
  id: string;
  /** Google's subtype, such as DEPRECATION_K8S_1_32_API or EXEC_PROBE_TIMEOUT; "OTHER" when it isn't that shape. */
  subtype: string;
  topic: "deprecation" | "other";
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  category: "reliability" | "cost" | "security" | "performance" | "manageability" | "sustainability" | "unknown";
  /** Google's sentence, at most 300 characters. */
  description: string;
  /** The associated recommendation's description, at most 300 characters. */
  action?: string;
  priority?: "P1" | "P2" | "P3" | "P4";
  /** When Google last refreshed it (ISO). */
  refreshed?: string;
  /** For an API deprecation: the APIs still called and who calls them (a user agent is the caller's own text). */
  apis?: { api: string; stops?: string; clients: { agent: string; requests?: number; last?: string }[] }[];
};
/** An open Cloud Monitoring alert on a cluster (D186; wave 9 part 3). */
export type GcpAlert = {
  id: string;
  opened: string;
  policy: string;
  policyId?: string;
  severity: "critical" | "error" | "warning" | "none";
  resourceType: string;
  metric?: string;
  subject?: { kind: "Pod" | "Node" | "Namespace"; namespace?: string; name: string; container?: string };
};
/**
 * Google's view of a connected cluster (D177): whether it is a GKE cluster of a chosen project (with a hint when it
 * looks like one of a project you haven't chosen), and if so Google's suggestions and open alerts, each failing alone
 * into its fixed sentence. Alerts are read from wave 9 part 3; until then their list is empty.
 */
export type GcpClusterView =
  | { gke: false; hint?: string }
  | {
      gke: true;
      cluster: { project: string; location: string; name: string };
      /**
       * `cut`: Google had more pages of the location's suggestions than Landlens reads, so this cluster may have more
       * than `items` (review of part 1, M2); the panel then never says there are none.
       */
      advice: { items: GkeAdvice[]; cut: boolean; at: string } | { error: string };
      alerts: { items: GcpAlert[]; others: number; cut: boolean; at: string } | { error: string };
    };
/** The built-in server of read-only Google Cloud tools (D93), on the gateway beside landlens-kube when you turn it on. */
export const GCP_MCP_SERVER = "landlens-gcp";
/** What a GKE context needs said once before the first connect (D91); main asks it in a native dialog (part 5, L3). */
export const CLOUD_CONFIRM = "This is a cloud cluster. Claude will read it, and can change it only through changes you approve.";
/** cluster:connect's answer when you said no to that question: the page shows nothing for it. */
export const CLOUD_DECLINED = "You didn't connect the cloud cluster.";
/** cluster:status: main disconnected a cluster (a GKE cluster whose project you unchose, or gcloud's account changed). */
export type ClusterStatusEvent = { handle: string; context: string; state: "disconnected"; reason: string };
/** The most resources Landlens reads in one project (10 pages of 500), and the most one gcp:resources answer holds. */
export const GCP_MAX_RESOURCES = 5000;
export const GCP_PAGE = 500;
/**
 * The most rows of each of a location's two recommender lists Landlens reads (ten pages of 100; review of wave 9 part 1,
 * M2). The lists hold every cluster of the location; past this a view says `cut`.
 */
export const GKE_ADVICE_READ = 1000;

// The autonomous mode (docs/connections.md, D82–D84): per session, per connection, turned on in the dock, never
// stored. It covers GitHub and Linear writes only; cluster writes always go through the approval broker.
/** A GitHub repository as `owner/repo`. */
export const RepoName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "not owner/repo");
/** A Linear team key, such as ENG. */
export const TeamKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/, "not a team key");
/** A branch name as the person types it in the scope sheet (the repository's default branch). */
export const BranchName = z.string().regex(/^(?!-)[A-Za-z0-9._/-]{1,100}$/, "not a branch name");
/** Where autonomous writes may go: 1–5 repositories (GitHub, with their default branch), or one team (Linear). */
export const AutonomyScope = z.object({
  repos: z.array(RepoName).min(1).max(5).optional(),
  /** The repositories' default branch, as the person typed it; file writes never go to it, main or master. */
  branch: BranchName.optional(),
  team: TeamKey.optional(),
}).strict();
export type AutonomyScope = z.infer<typeof AutonomyScope>;
/** The most autonomous writes in one session per provider, and in any minute (D83). */
export const AUTONOMY_BUDGET = 20;
export const AUTONOMY_PER_MINUTE = 5;
/** Why autonomous ended: Stop, the budget, the tools changed, the session ended, or 3 refusals in a row. */
export type AutonomyOff = "you" | "budget" | "drift" | "session" | "refused";
/** A connection's autonomy in one agent session (agent:autonomy, answered and pushed). */
export type AutonomyState = {
  session: string;
  provider: ConnProvider;
  on: boolean;
  scope?: AutonomyScope;
  /** Autonomous writes run in this session, and the most it may run. */
  used: number;
  budget: number;
  offBecause?: AutonomyOff;
  /** The connection's level for this session: at "read" no write exists, so there is no autonomy to turn on. */
  mode: ConnMode;
  /** Why it can't be turned on in this session (its tools changed, or were never accepted). */
  blocked?: string;
  /**
   * Why every write asks in this session even while it is on (review of wave 6 part 5, W1): Google Cloud data was read
   * in it, through landlens-gcp or a resource the person quoted.
   */
  held?: string;
};
/** Turn a connection's autonomy on (with its scope) or off, for one session. */
export const AutonomyRequest = z.object({ session: SessionId, provider: ConnProvider, on: z.boolean(), scope: AutonomyScope.optional() })
  .refine((r) => !r.on || (r.provider === "github" ? !!r.scope?.repos?.length && r.scope.team === undefined : !!r.scope?.team && r.scope.repos === undefined && r.scope.branch === undefined), "a scope for that provider is needed: GitHub repositories, or one Linear team");

/** A container's name (a DNS label). */
export const ContainerName = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "not a container name");
/** A log stream's or terminal's id, made by main. */
export const KindName = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,62}$/, "not a kind");
/** A Secret's key: Kubernetes's rule (1–253 of `[-._a-zA-Z0-9]`). */
export const SecretKey = z.string().regex(/^[-._a-zA-Z0-9]{1,253}$/, "not a Secret key");
/** A Secret, by namespace and name only: the kind is always core v1 `secrets`, decided in main, never by the window (D163). */
export const SecretRef = z.object({ namespace: NamespaceName, name: ObjectName }).strict();
export type SecretRef = z.infer<typeof SecretRef>;
export const EditId = z.string().regex(/^ed[A-Za-z0-9_-]{8,32}$/, "not an edit id");
export const StreamId = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);

export type LogLine = { ts: string; text: string };
export type LogsPush = { stream: string; lines: LogLine[] };
export type LogsEnd = { stream: string; status?: number; message?: string };
export type TerminalData = { terminal: string; data: string };
/** A terminal opened, or ended: the shell exited (code), or the connection failed (message). */
/** A problem with your YAML: a syntax error, or the cluster's reason for refusing it, on a line when it names one. */
export type EditProblem = { message: string; field?: string; line?: number };
/** Another manager owns a field you changed (managedFields): it may set it back. */
export type EditOwner = { path: string; manager: string; line?: number };
/** A dry run of your edit: the operations to show, kept under `id` for Apply; or the problems; or a conflict. */
/** `agent`: the diff (or created objects) scrubbed as the agent's own reads are: what "Ask Claude to check it" sends. */
export type EditReview = { id?: string; operations?: ChangeOperation[]; owners?: EditOwner[]; changed?: string[]; problems?: EditProblem[]; conflict?: boolean; agent?: string };

/**
 * Your actions (wave 8, D141–D148): what the person asks main to do to objects. The window names an action's closed
 * shape and its targets; main resolves each target's type from the cluster's discovery, builds every request, dry-runs
 * it as you, and keeps it under an `ed…` id. Nothing in a request can carry a body, a path or a title. Cordon and drain
 * (part 2, D149–D154) name a node, and for a drain the two choices kubectl calls --force and --delete-emptydir-data.
 */
export const ACTION_TARGETS = 50;
/** A Node's name: a DNS subdomain (the API server's own rule for nodes). */
export const NodeName = z.string().min(1).max(253).regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/, "not a node name");
export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scale"), target: ResourceRef.strict(), replicas: z.number().int().min(0).max(1000) }).strict(),
  z.object({ kind: z.literal("restart"), targets: z.array(ResourceRef.strict()).min(1).max(ACTION_TARGETS) }).strict(),
  z.object({ kind: z.literal("delete"), targets: z.array(ResourceRef.strict()).min(1).max(ACTION_TARGETS) }).strict(),
  z.object({ kind: z.literal("trigger"), target: ResourceRef.strict() }).strict(),
  z.object({ kind: z.literal("suspend"), target: ResourceRef.strict(), suspend: z.boolean() }).strict(),
  z.object({ kind: z.literal("cordon"), node: NodeName, on: z.boolean() }).strict(),
  z.object({ kind: z.literal("drain"), node: NodeName, bare: z.boolean(), emptyDir: z.boolean() }).strict(),
]);
export type Action = z.infer<typeof Action>;
export type ActionKind = Action["kind"];
/**
 * A review's SHA-256, as hex, over what main keeps and what main sent for the card: the requests, the diff, the risks,
 * the title, the facts, the plan and whether main's dialog asks. Apply must name it. It ties Apply to the review main
 * answered; it can't prove what the window drew.
 */
export const ActionDigest = z.string().regex(/^[0-9a-f]{64}$/, "not a digest");
/** What the diff doesn't say (D142): a fixed sentence of main's, with checked names only. */
export type ActionFact = { tone: "info" | "warn" | "bad"; code: string; text: string };
/**
 * A dry run of your action: the edit review's fields, with main's title and facts. `native`: Apply asks in main's own
 * dialog first (bulk and wide deletes). `digest`: what Apply must name.
 */
export type ActionReview = EditReview & {
  title?: string;
  facts?: ActionFact[];
  native?: true;
  digest?: string;
  /** A drain's plan (D150, D151): what would be evicted, what blocks, what stays, and the cluster's own dry runs. */
  plan?: DrainPlan;
  /**
   * D153: a development build that wasn't told it may write to this cluster's nodes. The review is built from reads
   * only (no dry run to the node, no dry-run eviction) and has no id: there is nothing to apply.
   */
  previewOnly?: true;
  /** Pods where the cluster's dry run and Landlens's reading disagree (the row shows the cluster's answer). */
  disagree?: number;
  /**
   * A drain's two ticks as main reviewed them (security review of part 2, M2): in the digest, named in main's dialog,
   * and the sheet enables Apply only while its boxes say the same.
   */
  ticks?: { bare: boolean; emptyDir: boolean };
};
export type ActionOutcome = "applied" | "conflict" | "failed" | "gone";
export type ActionResult = { target: string; outcome: ActionOutcome; message?: string };

/**
 * Drain (wave 8 part 2, D150–D152). A pod on the node: what a drain does with it, and why it is blocked if it is.
 * `evict`: evicted through the eviction API. `daemonset` and `mirror`: skipped (they would come straight back).
 * `finished`: Succeeded or Failed, evicted without a budget check. `terminating`: already going, left alone.
 */
export type DrainClass = "evict" | "daemonset" | "mirror" | "finished" | "terminating";
export type DrainBlock = "budget" | "many-budgets" | "needs-bare" | "needs-emptydir";
export type DrainPod = {
  namespace: string;
  name: string;
  uid: string;
  owner?: { kind: string; name: string };
  class: DrainClass;
  /** No controller owner: nothing recreates it. */
  bare: boolean;
  /** The names of its emptyDir volumes. */
  emptyDir: string[];
  /** The PodDisruptionBudgets whose selector matches it: one with what it allows now, or several by name. */
  budget?: { name: string; allowed: number } | { many: string[] };
  blocked?: DrainBlock;
  /** The API server's answer to a dry-run eviction (D151): 2xx would go; 429 a budget; 403 your role. */
  dry?: { status: number; reason?: "budget" | "forbidden" | "other" };
  /** Its DaemonSet is gone (security review of part 2, L12): nothing recreates it, so it is evicted as a bare pod. */
  orphan?: true;
};
export type DrainPlan = {
  node: string;
  cordoned: boolean;
  pods: DrainPod[];
  counts: { evict: number; blocked: number; skipped: number };
  /** Why the plan may be incomplete (past the caps, or budgets that couldn't be listed): Apply stays off. */
  partial?: string;
};
export type DrainPodState = "waiting" | "evicting" | "evicted" | "gone" | "blocked" | "failed";
/** A drain's run (D152), pushed on `action:progress` to the window that started it, at most four times a second. */
export type DrainProgress = {
  run: string;
  node: string;
  state: "cordoning" | "evicting" | "done" | "stopped" | "timed-out" | "failed";
  pods: { namespace: string; name: string; state: DrainPodState; note?: string }[];
  /** When the run started (ms since the epoch), for the elapsed time. */
  startedAt: number;
  /** A run that ended before any eviction, or stopped evicting: why, in a fixed sentence. */
  note?: string;
  /** Each push's number in its run: the window keeps the highest it has seen (security review of part 2, M1). */
  seq: number;
  /** At the end, read again (M3): whether the node is still cordoned. */
  cordoned?: boolean;
  /** At the end, read again (M3): pods a drain would evict that arrived after the preview and are still on the node. */
  arrived?: number;
};
/** A window's drain on a cluster (M4): its latest state and the plan it runs, so the window can re-attach to it. */
export type DrainRun = { progress: DrainProgress; plan: DrainPlan; ended: boolean };
/** One kept row per action the person applied (D147): names and closed words only, never a diff, a message or a value. */
export type ActionLogEntry = {
  id: string;
  at: string;
  context: string;
  /** The first 16 hex digits of the SHA-256 of the cluster's API server address, as family-sent.json keeps it. */
  server: string;
  who: "you";
  action: "scale" | "restart" | "delete" | "trigger" | "suspend" | "resume" | "cordon" | "uncordon" | "drain" | "reveal" | "copy";
  kind: string;
  /** The kind's group and resource, so a row opens its own kind (security review of part 1, L8). */
  group?: string;
  resource?: string;
  namespace?: string;
  names: string[];
  key?: string;
  detail?: string;
  /** `sent`: written before the requests went (M3) and not answered yet; a row left so by a crash stays `sent`. */
  outcome: "sent" | "applied" | "partial" | "failed" | "conflict" | "cancelled" | "stopped";
};

/** Port-forward (wave 4, part 3). A local port is 1024 or above; a remote one any TCP port. */
export const LocalPort = z.number().int().min(1024).max(65535);
export const RemotePort = z.number().int().min(1).max(65535);
export const ForwardId = z.string().regex(/^fw[A-Za-z0-9_-]{8,32}$/, "not a forward id");
export type ForwardState = "starting" | "running" | "reconnecting" | "failed" | "stopped";
/**
 * A forward: 127.0.0.1:localPort → a pod's port, or a Service's port through one ready pod. `pod` and `podPort` are
 * where it goes now. `keep`: saved, and started again when Landlens reconnects to the cluster.
 */
export type ForwardInfo = {
  id: string;
  context: string;
  namespace: string;
  kind: "pod" | "service";
  name: string;
  port: number;
  localPort: number;
  keep: boolean;
  state: ForwardState;
  pod?: string;
  podPort?: number;
  /** Why it failed, or what it is waiting for. */
  message?: string;
  /** The last connection's error ("Nothing is listening on port 8080 in the pod"). */
  lastError?: string;
  /** When it entered its state (ms). */
  since: number;
  connections: number;
  scheme: "http" | "https";
};
export type ForwardsPush = { forwards: ForwardInfo[] };

// Helm releases, read-only (wave 4, part 4; D42–D43). Main decodes Helm's release Secrets; the window gets no
// secret values: secret-looking values are hidden and Secrets in the manifest keep only their keys.
export type HelmRelease = {
  name: string; namespace: string; revision: number; status: string;
  chart: string; chartVersion: string; appVersion: string; updated?: string;
};
export type HelmHistoryEntry = {
  revision: number; status: string; chart: string; chartVersion: string; appVersion: string; updated?: string; description: string;
};
export type HelmObjectRef = { kind: string; name: string; namespace?: string; apiVersion?: string };
export type HelmReleaseDetail = {
  release: HelmRelease;
  /** The latest revision (the one shown may be older). */
  latest: number;
  description: string;
  firstDeployed?: string;
  notes: string;
  chartDescription: string;
  /** YAML: the values you set, and with the chart's defaults. */
  values: { user: string; all: string };
  /** How many values were hidden as secrets: of yours, and of all (yours over the chart's). */
  hidden: { user: number; all: number };
  manifest: string;
  manifestCut: boolean;
  /** How many Secret values the manifest hid. */
  manifestHidden: number;
  objects: HelmObjectRef[];
  history: HelmHistoryEntry[];
};

/** How a session ended: the shell exited, the connection dropped, or the cluster refused it (status says why). */
export type TerminalEnd = "exit" | "lost" | "refused";
export type TerminalStatus = { terminal: string; state: "open" | "exited"; ended?: TerminalEnd; code?: number; status?: number; message?: string };

/** Request/response channels: name → [request schema, response type]. */
export const channels = {
  "catalog:list": z.object({}),
  // A GKE context (D91): main asks "This is a cloud cluster…" itself, in a native dialog, once per cluster (part 5, L3).
  "cluster:connect": z.object({ context: z.string().min(1).max(253) }),
  "cluster:disconnect": z.object({ handle: Handle }),
  "cluster:discovery": z.object({ handle: Handle }),
  "cluster:access": z.object({ handle: Handle, checks: z.array(AccessCheck).max(200) }),
  "cluster:health": z.object({ handle: Handle, namespace: NamespaceName.optional() }),
  // The cluster doctor (wave 5): its report for a scope, and evidence for one problem in it.
  "doctor:list": z.object({ handle: Handle, namespace: NamespaceName.optional() }),
  "doctor:evidence": z.object({ handle: Handle, namespace: NamespaceName.optional(), id: ProblemId }),
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
  // A link in an answer: main opens https links in your browser. Nothing opens through window.open.
  "link:open": z.object({ url: z.string().min(1).max(2000) }),
  "agent:close": z.object({ session: SessionId }),
  // Wave 3: your decision on a change the agent proposed (agent:change). The note goes back to the agent.
  "agent:decide": z.object({ change: ChangeId, decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() }),
  // Wave 3: past sessions (Claude Code keeps the transcripts; Landlens the list), resume one, forget one.
  "agent:history": z.object({ context: z.string().min(1).max(253).optional() }),
  "agent:resume": z.object({ handle: Handle, session: SessionId }),
  "agent:forget": z.object({ session: SessionId }),
  // Wave 3: which of your Claude Code skills agent sessions get.
  "agent:settings": z.object({}),
  "agent:skills": z.object({ chosen: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(50) }),
  // The workbench (wave 4): followed logs and pod shells, with your own access.
  "logs:open": z.object({
    handle: Handle, namespace: NamespaceName, pod: ObjectName, container: ContainerName,
    previous: z.boolean().optional(), tailLines: z.number().int().min(1).max(10_000).optional(),
    sinceTime: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/).optional(),
  }),
  "logs:close": z.object({ stream: StreamId }),
  "terminal:open": z.object({ handle: Handle, namespace: NamespaceName, pod: ObjectName, container: ContainerName, shell: z.enum(["auto", "bash", "sh"]).optional() }),
  "terminal:local": z.object({ handle: Handle }),
  "terminal:input": z.object({ terminal: StreamId, data: z.string().max(65_536) }),
  "terminal:resize": z.object({ terminal: StreamId, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
  /** The window drew this much of a terminal's output (flow control). */
  "terminal:ack": z.object({ terminal: StreamId, chars: z.number().int().min(1).max(64 * 1024 * 1024) }),
  "terminal:close": z.object({ terminal: StreamId }),
  // Your edits (docs/workbench.md): dry-run first, then apply exactly what was dry-run.
  "edit:review": z.object({
    handle: Handle,
    type: z.object({ group: GroupName, version: VersionName, resource: ResourceName, kind: KindName, namespaced: z.boolean() }),
    namespace: NamespaceName.optional(), name: ObjectName,
    base: z.string().regex(/^[0-9A-Za-z._-]{1,64}$/, "not a resourceVersion"),
    original: z.string().max(512 * 1024), edited: z.string().max(512 * 1024),
  }),
  "edit:create": z.object({ handle: Handle, namespace: NamespaceName.optional(), yaml: z.string().max(512 * 1024) }),
  "edit:apply": z.object({ handle: Handle, id: EditId }),
  "edit:discard": z.object({ id: EditId }),
  // Your actions (docs/workbench.md#your-actions, D144): the window names an action and its targets; main builds,
  // dry-runs and keeps every request; Apply names the review's id and digest and nothing else. Strict.
  "action:review": z.object({ handle: Handle, action: Action }).strict(),
  "action:apply": z.object({ handle: Handle, id: EditId, digest: ActionDigest }).strict(),
  "action:discard": z.object({ id: EditId }).strict(),
  /** Stop a drain's run (D152): no new eviction is sent; those in flight finish; the node stays cordoned. */
  "action:stop": z.object({ run: EditId }).strict(),
  /** This window's drains on this cluster, running and lately ended, with their latest state (M1, M4). */
  "action:runs": z.object({ handle: Handle }).strict(),
  /** The connected cluster's rows: its context and its API server's hash both match (security review, L7). */
  "action:log": z.object({ handle: Handle, limit: z.number().int().min(1).max(200).optional() }).strict(),
  // Secret values (wave 8 part 4, D161–D168; docs/workbench.md#secrets-and-certificates): main's own dialog unlocks
  // one Secret for this window; a reveal answers one key's value to this window only; a copy goes to the clipboard
  // from main and never to the window; certificates are public halves only. Strict.
  "secret:unlock": z.object({ handle: Handle, secret: SecretRef }).strict(),
  /** No `secret`: every unlock this window holds. */
  "secret:lock": z.object({ handle: Handle, secret: SecretRef.optional() }).strict(),
  "secret:reveal": z.object({ handle: Handle, secret: SecretRef, key: SecretKey }).strict(),
  "secret:copy": z.object({ handle: Handle, secret: SecretRef, key: SecretKey, as: z.enum(["text", "base64"]).optional() }).strict(),
  "secret:certs": z.object({ handle: Handle, secret: SecretRef }).strict(),
  "forward:list": z.object({}),
  /** The local port to offer for a remote one (free now). */
  "forward:suggest": z.object({ port: RemotePort }),
  "forward:check": z.object({ port: LocalPort }),
  "forward:start": z.object({ handle: Handle, namespace: NamespaceName, kind: z.enum(["pod", "service"]), name: ObjectName, port: RemotePort, localPort: LocalPort, keep: z.boolean() }),
  "forward:stop": z.object({ id: ForwardId }),
  /** Start a stopped or failed forward again, on this cluster. */
  "forward:resume": z.object({ id: ForwardId, handle: Handle }),
  "forward:remove": z.object({ id: ForwardId }),
  /** Open http(s)://127.0.0.1:<its port>/ in your browser. */
  "forward:open": z.object({ id: ForwardId }),
  // Helm releases, read-only (wave 4, part 4): decoded in main, as you.
  "helm:list": z.object({ handle: Handle, namespace: NamespaceName.optional() }),
  "helm:get": z.object({ handle: Handle, namespace: NamespaceName, name: ObjectName, revision: z.number().int().min(1).max(1_000_000).optional() }),
  // Use the Prometheus Landlens found for this cluster's context (it must still be the one found), or stop using one.
  "metrics:prometheus": z.object({ handle: Handle, use: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\/[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/).nullable() }),
  // The ⌘K palette's names across kinds (D45); `fresh` reads again even if the last read is recent.
  "search:index": z.object({ handle: Handle, fresh: z.boolean().optional() }),
  "metrics:series": MetricsRequest,
  "metrics:settings": z.object({ context: z.string().min(1).max(253).optional() }),
  "metrics:configure": ClicklandSettingsInput,
  "metrics:test": z.object({ handle: Handle.optional(), url: ClicklandUrl.optional(), key: ClicklandKey.optional(), cluster: ClicklandClusterName.optional() }),
  "metrics:disconnect": z.object({}),
  // Clickland's history (D117): main checks the object is in the window's cluster or its doctor report first.
  "clickland:logs": ClicklandLogsRequest,
  "clickland:traces": z.object({ handle: Handle, scope: ClicklandScope, range: ClicklandRange, errors: z.boolean().optional() }),
  "clickland:trace": z.object({ handle: Handle, id: ClicklandTraceId }),
  /**
   * Open in Clickland (D118): main builds the console's URL from the stored console address and this object (or one
   * trace), asks in a native dialog that shows the host, then opens it. The window never supplies a URL.
   */
  "clickland:open": z.object({
    handle: Handle,
    scope: ClicklandScope,
    signal: z.enum(["logs", "traces"]),
    range: ClicklandRange,
    errors: z.boolean().optional(),
    trace: ClicklandTraceId.optional(),
  }),
  // MCP (docs/mcp.md). Header values come in with save and test; nothing sends them back.
  "mcp:servers": z.object({ context: z.string().min(1).max(253).optional() }),
  "mcp:save": McpServerInput,
  "mcp:test": z.object({ id: McpServerId.optional(), url: McpUrl.optional(), header: z.object({ name: McpHeaderName, value: McpHeaderValue.optional() }).optional() }),
  "mcp:enable": z.object({ id: McpServerId, context: z.string().min(1).max(253), enabled: z.boolean() }),
  "mcp:auto-run": z.object({ id: McpServerId, enabled: z.boolean(), context: z.string().min(1).max(253).optional() }),
  "mcp:remove": z.object({ id: McpServerId }),
  "mcp:calls": z.object({}),
  /** Run one read-only tool that needs no arguments, as you, to see what it returns and its app. */
  "mcp:try": z.object({ handle: Handle, server: z.string().min(1).max(32), tool: McpToolName }),
  "mcp:app-open": z.object({ call: McpCallId }),
  "mcp:app-call": z.object({ view: McpViewId, name: McpToolName, arguments: z.record(z.string(), z.unknown()).optional() }),
  "mcp:app-close": z.object({ view: McpViewId }),
  "mcp:app-link": z.object({ view: McpViewId, url: z.string().min(1).max(2000) }),
  // Connections (docs/connections.md). A token comes in on conn:token; no channel sends one back.
  "conn:list": z.object({}),
  "conn:github-device": z.object({}),
  "conn:linear-signin": z.object({ mode: ConnMode }),
  "conn:token": ConnTokenInput,
  "conn:cancel": z.object({ flow: FlowId }),
  "conn:set": z.object({ provider: ConnProvider, mode: ConnMode.optional(), readsAuto: z.boolean().optional(), give: z.boolean().optional() }),
  "conn:test": z.object({ provider: ConnProvider }),
  "conn:repin": z.object({ provider: ConnProvider }),
  "conn:disconnect": z.object({ provider: ConnProvider }),
  // The Land family (docs/family.md). A Landflow key comes in on family:connect, the triage webhook's secret on
  // family:set; no channel sends one back. Addresses are FamilyOrigin here; main holds them to familyUrlAllowed with
  // its overrides (LANDLENS_FAMILY_HTTP_HOSTS, unpackaged only). A Landfall sign-in is a flow, ended by conn:cancel.
  "family:list": z.object({ context: z.string().min(1).max(253).optional() }),
  "family:connect": z.object({ sibling: z.literal("landflow"), url: FamilyOrigin, key: LandflowKey.optional() }),
  "family:signin": z.object({ sibling: z.literal("landfall"), url: FamilyOrigin }),
  "family:set": z
    .object({
      sibling: Sibling,
      toSessions: z.boolean().optional(),
      readsAuto: z.boolean().optional(),
      console: FamilyUrl.nullable().optional(),
      triage: z.object({ path: TriagePath, header: TriageHeader, secret: TriageSecret.optional() }).nullable().optional(),
    })
    .refine((r) => r.console === undefined || r.sibling === "clickland", "only Clickland has a console address")
    .refine((r) => r.triage === undefined || r.sibling === "landflow", "only Landflow has a triage webhook"),
  "family:test": z.object({ sibling: Sibling }),
  /**
   * Accept the listing a family:test showed (D111), named by the hash that test returned: main refuses unless it is
   * still the listing its last Check saw (review of part 2, M3).
   */
  "family:repin": z.object({ sibling: Sibling, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  "family:disconnect": z.object({ sibling: Sibling }),
  // Landflow on a resource (docs/family.md, D126). Only choices and ids cross: main builds the alert from the problem in
  // the scope's current report and the flow's input from the object, and sends only what the sheet showed. Strict: a
  // request that carries anything else (a title, a description, an address) is refused.
  "landflow:alert": z.object({ handle: Handle, namespace: NamespaceName.optional(), problem: ProblemId, severity: TriageSeverity, logs: z.boolean(), sheet: LandflowSheetId.optional() }).strict(),
  "landflow:triage": z.object({ sheet: LandflowSheetId, digest: LandflowDigest }).strict(),
  "landflow:flows": z.object({}).strict(),
  "landflow:input": z.object({ handle: Handle, ref: ResourceRef.strict(), namespace: NamespaceName.optional(), problem: ProblemId.optional(), yaml: z.boolean(), sheet: LandflowSheetId.optional() }).strict(),
  "landflow:run": z.object({ sheet: LandflowSheetId, flow: LandflowFlowId, digest: LandflowDigest }).strict(),
  "landflow:follow": z.object({ run: LandflowRunId }).strict(),
  "landflow:sent": z.object({ handle: Handle }).strict(),
  /** The run in Landflow, or the room it opened: main's own record of it, after the native dialog that shows its host. */
  "landflow:open": z.object({ run: LandflowRunId, what: z.enum(["run", "room"]) }).strict(),
  // What Landlens reports (docs/family.md#what-landlens-reports, D133, D135). Telemetry: the switch, the collector's
  // address (main confirms a new one natively), counts only, the team; the drawer's records; a session in Clickland.
  // The brain: a sheet per session, prepared in main; send names the sheet and the digest of the fields main filled, and
  // carries only the text the person may edit; main scrubs and checks it again.
  "telemetry:set": z.object({ on: z.boolean().optional(), collector: FamilyOrigin.optional(), names: z.boolean().optional(), team: TelemetryTeam.nullable().optional() }).strict(),
  "telemetry:recent": z.object({}).strict(),
  "telemetry:open": z.object({ session: SessionId }).strict(),
  "brain:draft": z.object({ session: SessionId }).strict(),
  "brain:ask": z.object({ sheet: BrainSheetId }).strict(),
  "brain:cancel": z.object({ sheet: BrainSheetId }).strict(),
  "brain:send": z.object({ sheet: BrainSheetId, digest: BrainDigest, title: BrainTitle, summary: BrainSummary, visibility: WorkVisibility, team: BrainHint.optional(), initiative: BrainHint.optional() }).strict(),
  "brain:remove": z.object({ session: SessionId }).strict(),
  // The autonomous mode (D82): per session and connection, never stored. Main answers a routine write's question
  // only when the gateway's check passes; the renderer can turn it on or off, never answer for it.
  "agent:autonomy": AutonomyRequest,
  // Google Cloud (docs/gcp.md): read-only, with gcloud's sign-in; no channel takes an address or returns a token.
  "gcp:status": z.object({ fresh: z.boolean().optional() }),
  "gcp:projects": z.object({ fresh: z.boolean().optional() }),
  // Ids you can see (checked in main against the project search); "Claude can read" is its own channel (L6 of part 4's review).
  "gcp:choose": z.object({ projects: z.array(GcpProjectId).max(20) }),
  // "Claude can read these projects" (D93): turning it on asks you in a native dialog in main.
  "gcp:agent-read": z.object({ on: z.boolean() }),
  "gcp:types": z.object({ project: GcpProjectId, fresh: z.boolean().optional() }),
  "gcp:resources": z.object({ project: GcpProjectId, assetType: GcpAssetType.optional(), query: GcpQuery.optional(), offset: z.number().int().min(0).max(GCP_MAX_RESOURCES).optional() }),
  "gcp:resource": z.object({ project: GcpProjectId, name: GcpResourceName }),
  "gcp:clusters": z.object({}),
  // Google's view of a connected cluster (wave 9, D177): only the handle; main finds the project, location and cluster.
  "gcp:cluster-view": z.object({ handle: Handle, fresh: z.boolean().optional() }).strict(),
} as const;
export type Channel = keyof typeof channels;

export type Responses = {
  /** `gke`: the GKE clusters' projects that couldn't be listed, each with its sentence (D88). */
  "catalog:list": { contexts: KubeContext[]; error?: string; gke?: { errors: { project: string; message: string }[] } };
  "cluster:connect": ClusterInfo;
  "cluster:disconnect": { ok: true };
  "cluster:discovery": { types: ResourceType[] };
  "cluster:access": { allowed: boolean[] };
  "cluster:health": ClusterHealth;
  "doctor:list": DoctorReport;
  "doctor:evidence": DoctorEvidence;
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
  "link:open": { opened: boolean };
  "agent:close": { ok: true };
  "agent:decide": { ok: true };
  "agent:history": { sessions: AgentHistoryEntry[] };
  "agent:resume": AgentSessionInfo;
  "agent:forget": { ok: true };
  "agent:settings": AgentSettingsInfo;
  "agent:skills": { ok: true };
  "logs:open": { stream: string };
  "logs:close": { ok: true };
  "terminal:open": { terminal: string; label: string };
  "terminal:local": { terminal: string; label: string; shell: string };
  "terminal:input": { ok: true };
  "terminal:resize": { ok: true };
  "terminal:ack": { ok: true };
  "terminal:close": { ok: true };
  "edit:review": EditReview;
  "edit:create": EditReview;
  "edit:apply": { results: string[] };
  "edit:discard": { ok: true };
  "action:review": ActionReview;
  /** A drain answers with its run at once (D152); its progress comes on `action:progress`. */
  "action:apply": { results: ActionResult[] } | { run: string };
  "action:discard": { ok: true };
  "action:stop": { ok: true };
  "action:runs": { runs: DrainRun[] };
  "action:log": { entries: ActionLogEntry[] };
  /** `left`: milliseconds until the unlock ends, by main's clock. */
  "secret:unlock": { unlocked: true; until: string; left: number };
  "secret:lock": { ok: true };
  "secret:reveal": Revealed;
  "secret:copy": { copied: true; clearsIn: number };
  "secret:certs": { certs: CertDetail[]; skipped?: string };
  "forward:list": ForwardsPush;
  "forward:suggest": { port: number };
  "forward:check": { free: boolean; next?: number };
  "forward:start": ForwardInfo;
  "forward:stop": { ok: true };
  "forward:resume": ForwardInfo;
  "forward:remove": { ok: true };
  "forward:open": { ok: true };
  "helm:list": { releases: HelmRelease[]; unreadable: number };
  "helm:get": HelmReleaseDetail;
  "metrics:prometheus": { ok: true };
  "search:index": { entries: SearchEntry[]; cut: string[]; unreadable: string[]; at: string };
  "metrics:series": MetricsSeries;
  "metrics:settings": ClicklandSettings;
  "metrics:configure": ClicklandSettings;
  "metrics:test": ClicklandTest;
  "metrics:disconnect": ClicklandSettings;
  "clickland:logs": ClicklandLogs;
  "clickland:traces": ClicklandTraces;
  "clickland:trace": ClicklandTrace;
  "clickland:open": { opened: boolean };
  "mcp:servers": McpServers;
  "mcp:save": McpServerInfo;
  "mcp:test": McpTest;
  "mcp:enable": McpServerInfo;
  "mcp:auto-run": McpServerInfo;
  "mcp:remove": { ok: true };
  "mcp:calls": { calls: McpCall[] };
  "mcp:try": McpCall;
  "mcp:app-open": McpAppView;
  "mcp:app-call": McpToolResult;
  "mcp:app-close": { ok: true };
  "mcp:app-link": { opened: boolean };
  "conn:list": ConnList & { gcp: GcpStatus };
  "conn:github-device": { flow: string; userCode: string; verificationUri: "https://github.com/login/device"; expiresIn: number };
  "conn:linear-signin": { flow: string };
  "conn:token": ConnInfo;
  "conn:cancel": { ok: true };
  "conn:set": ConnInfo;
  "conn:test": McpTest;
  "conn:repin": ConnInfo;
  "conn:disconnect": ConnInfo;
  "family:list": FamilyList;
  "family:connect": FamilyInfo;
  "family:signin": { flow: string };
  "family:set": FamilyInfo;
  "family:test": McpTest;
  "family:repin": FamilyInfo;
  "family:disconnect": FamilyInfo;
  "landflow:alert": AlertPreview;
  "landflow:triage": LandflowRun;
  "landflow:flows": { flows: LandflowFlow[] };
  "landflow:input": FlowPreview;
  "landflow:run": LandflowRun;
  "landflow:follow": LandflowRun;
  "landflow:sent": { entries: LandflowSent[] };
  "landflow:open": { opened: boolean };
  "telemetry:set": TelemetryInfo;
  "telemetry:recent": { records: TelemetryRecord[]; info: TelemetryInfo };
  "telemetry:open": { opened: boolean };
  "brain:draft": BrainDraft;
  "brain:ask": { summary: string };
  "brain:cancel": { ok: boolean };
  "brain:send": BrainSend;
  "brain:remove": { ok: boolean; note: string };
  "agent:autonomy": AutonomyState;
  "gcp:status": GcpStatus;
  "gcp:projects": { projects: GcpProject[]; cut: boolean };
  "gcp:choose": GcpStatus;
  "gcp:agent-read": GcpStatus;
  /** A project's asset types with their counts, from the cached read; `error` is one fixed sentence (D88). */
  "gcp:types": { types: GcpTypeCount[]; total: number; cut: boolean; error?: string };
  /** At most 500 from `offset` into the cached list; `total` is the whole list's length. */
  "gcp:resources": { items: GcpResource[]; total: number; cut: boolean; error?: string };
  /** `json`: the resource's own JSON (versionedResources[0].resource), cut at 256 KB. */
  /** `brief`: what Ask Claude quotes (D94): the fields and the scrubbed JSON, at most 8,000 characters, built in main. */
  "gcp:resource": { resource: GcpResource; json?: string; cut: boolean; brief?: string };
  "gcp:clusters": { clusters: GkeCluster[]; errors: { project: string; message: string }[] };
  "gcp:cluster-view": GcpClusterView;
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
  /** A connection's write that may run on its own in an autonomous session (D83's allowlist). */
  routine?: boolean;
};
export type McpServerInfo = {
  /** "landlens-kube" for the built-in server, the provider for a connection, else its stored id. */
  id: string;
  name: string;
  builtin: boolean;
  /**
   * Served from Connections (wave 6; the Land family from wave 7): managed on the Connections page, not edited or
   * removed here ("gcp": landlens-gcp).
   */
  connection?: ConnProvider | Sibling | "gcp";
  url: string;
  /** The header Landlens adds, and whether a value is stored. The value itself never leaves main. */
  header?: { name: string; stored: boolean };
  /** Used by agent sessions on the asked cluster (the built-in always is). */
  enabled: boolean;
  /**
   * "Run read-only tools without asking": its tools that say they only read run in agent sessions without a prompt,
   * while its listing is the one you saw when you turned this on. Off for every server you add; the built-in is
   * always on.
   */
  autoRun: boolean;
  /** Why auto-run was turned off (its tools changed). */
  autoRunNote?: string;
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
};
export type McpTest = {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
  tools?: McpToolInfo[];
  /** A family sibling's listing against the accepted one, by tool name (D111): what Review shows. */
  diff?: { added: string[]; removed: string[]; changed: string[] };
  /** A family sibling's listing, as a hash: Accept sends it back, so only the listing Review showed is pinned (M3). */
  listing?: string;
};
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
  /**
   * How a remote server's call got to run (set by the gateway): a read that runs without asking, your yes in the
   * dock, autonomous (a routine write in scope, wave 6), or Preview on the MCP page.
   */
  gate?: "read" | "asked" | "autonomous" | "preview";
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
  | "prometheus-failed" // found in the cluster, but its answer couldn't be read
  | "prometheus-found" // found, but not chosen yet: anyone who can make a Service could pose as one
  | "cloud-monitoring-failed" // a GKE cluster of a chosen project, but Cloud Monitoring didn't answer (wave 9 D182)
  | "cloud-monitoring-no-data" // no GKE system metrics for the cluster's nodes in the last hour
  | "cloud-monitoring-not-chosen" // GKE-shaped, but its project isn't chosen on the Google Cloud page
  | "cloud-monitoring-not-granted" // the agent's call only: Claude may not read this cluster's project (D194)
  | "cloud-monitoring-cut" // Cloud Monitoring answered more series than Landlens draws
  | "no-metrics-server"
  | "live-only"; // metrics-server: samples only since Landlens opened, at most an hour
export type MetricsReason = { code: MetricsReasonCode; message: string };
export type MetricsSeries = {
  source: "clickland" | "prometheus" | "cloud-monitoring" | "metrics-server" | "none";
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
  /** Prometheus: the Service that answered, `namespace/name`. */
  prometheus?: string;
  /** A Prometheus Landlens found but you haven't chosen, `namespace/name`: offered, not used. */
  prometheusFound?: string;
  /** Cloud Monitoring: the GKE cluster whose system metrics answered (wave 9 D182). */
  gke?: { project: string; location: string; name: string };
};
export type ClicklandSettings = {
  url: string;
  /** Whether a key is stored. The key itself never leaves main. */
  hasKey: boolean;
  /** Whether safeStorage can encrypt on this machine; without it Landlens won't store a key. */
  canStore: boolean;
  /** The Clickland cluster name for the asked context (its own name unless set). */
  cluster?: string;
  /** The console's origin, for Open in Clickland (wave 7 D118); set on the Clickland dialog. */
  console?: string;
};
export type ClicklandTest = {
  ok: boolean;
  /** One line per step: the health check, then a query. */
  steps: { name: string; ok: boolean; detail: string }[];
};

/** What is wrong in a cluster right now, problems first: the Overview page and the agent's cluster_overview. */
/** The doctor's classes of problem (docs/doctor.md), in the order its rules are tried. */
export type ProblemClass =
  | "crashloop" | "start" | "image" | "config" | "oom" | "pending" | "probe" | "notready"
  | "restarts" | "unavailable" | "node" | "warning" | "cert";
/** What the doctor could read; a missing check is said plainly rather than read as "no problems". */
export type DoctorCheck = "pods" | "workloads" | "nodes" | "events" | "certs";
/**
 * ok; forbidden (no access); error (failed this time); partial (a cap, a failed page or Secrets left out cut it);
 * pending (still being read: certificates on a first ask); skipped (not read for this ask: certificates for the agent
 * in namespaces the window isn't showing); off (not for this scope).
 */
export type DoctorCheckState = "ok" | "forbidden" | "error" | "partial" | "pending" | "skipped" | "off";
/** A TLS Secret's certificate as main reads it from `tls.crt`: dates and names, never the key or the PEM. */
export type CertFact = {
  notBefore: string;
  /** The earliest notAfter in the chain. */
  notAfter: string;
  which: "leaf" | "chain";
  subject: string;
  issuer: string;
  sans: string[];
  selfSigned: boolean;
  unreadable?: true;
};
/**
 * One certificate of a Secret, for the drawer's certificate panel (wave 8 part 4, D167): public material only, from
 * `tls.crt` and `ca.crt`; `tls.key` and every other key are never decoded. Names are the certificate's own text.
 */
export type CertDetail = {
  key: "tls.crt" | "ca.crt";
  /** Its place in the key's PEM: 0 is the first (the leaf, in `tls.crt`). */
  index: number;
  subject: string;
  issuer: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  /** Hex, at most 64 characters. */
  serial: string;
  /** The SHA-256 fingerprint, hex. */
  sha256: string;
  ca: boolean;
  selfSigned: boolean;
  publicKey?: { type: "rsa" | "ec" | "ed25519" | "other"; bits?: number; curve?: string };
  unreadable?: true;
};
/** One Secret value, to the window that unlocked it (D164): text when it is UTF-8 and at most 64 KiB, else only its size. */
export type Revealed =
  | { kind: "text"; text: string; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "large"; bytes: number };
export type ProblemEvent = { at: string; reason: string; message: string; count: number };
/** Small, structured evidence: what the row, the drawer and the agent's brief read. No env, labels or annotations. */
export type ProblemFacts = {
  lastState?: { reason?: string; exitCode?: number; signal?: number; finishedAt?: string; message?: string };
  image?: string;
  scheduling?: string;
  /** A pending pod's nodeSelector as `key=value`, only pairs shaped like labels, at most 10. */
  nodeSelector?: string[];
  probe?: { type: "readiness" | "liveness" | "startup"; how: string; period?: number; timeout?: number; failureThreshold?: number; lastMessage?: string };
  available?: string;
  limit?: string;
  events: ProblemEvent[];
  cert?: CertFact;
  usedBy?: string[];
};
export type Problem = {
  id: string;
  class: ProblemClass;
  /** "bad" is failing, "warn" is to watch. */
  tone: "bad" | "warn";
  /** The subject: the owner (a Deployment), not each of its pods. */
  kind: string;
  namespace?: string;
  name: string;
  group: string;
  version: string;
  resource: string;
  /** CrashLoopBackOff, OOMKilled, Unschedulable, ReadinessProbe, FailedMount, Expired, … */
  reason: string;
  /** "orders-api is crash-looping". */
  title: string;
  /** One line: "container api · exit 1 (Error) · 14 restarts · 5 pods". */
  detail: string;
  container?: string;
  restarts?: number;
  /** At most 50 names; podCount is exact. */
  pods: string[];
  podCount: number;
  since?: string;
  facts: ProblemFacts;
  /** Landlens's own rule-based first suggestion: static text with names and numbers, never workload-written text. */
  hint: { cause: string; next: string[] };
};
/** Kept for the callers that predate the doctor. */
export type HealthProblem = Problem;
export type DoctorReport = { at: string; problems: Problem[]; cut: boolean; checks: Record<DoctorCheck, DoctorCheckState> };
/** On-demand evidence for one problem (D60): the previous run's last lines for a crash, an OOM kill or a probe kill. */
export type DoctorEvidence = {
  /**
   * `source: "clickland"`: the kubelet had neither run, so the lines are Clickland's history of that pod and container
   * (wave 7 D118), oldest first, scrubbed before they crossed; `newest` is the time of the last of them (review of part
   * 3, L8: a pod name can be another incarnation's, so the note shows when).
   */
  log?: { pod: string; container: string; previous: boolean; lines: string[]; cut: boolean; source?: "clickland"; newest?: string } | { error: string };
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
  problems: Problem[];
  warnings: HealthEvent[];
  /** What could be read; absent from callers that predate the doctor. */
  checks: Record<DoctorCheck, DoctorCheckState>;
  /** More problems than the cap (500). */
  cut: boolean;
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
  /** The connections (GitHub, Linear) in this session and their autonomy, which starts off. */
  autonomy?: AutonomyState[];
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
  /** A connection's or a family sibling's tool: the dock shows its mark and its arguments as a table. */
  provider?: AnyProvider;
  /** Autonomous was on, and this write asks anyway: why (D82), e.g. "not one of the routine writes". */
  reason?: string;
};

/** What a change does to one object. */
export type ChangeVerb = "create" | "update" | "patch" | "delete";
/** Why a change deserves a second look; the dock shows these as tags, the loud ones first. */
export type ChangeRisk =
  | "deletes" | "rbac" | "namespace" | "cluster-scoped" | "reads-secret" | "privileged" | "host-access"
  | "service-account" | "new-workload" | "scales-to-zero" | "changes-image" | "restarts-pods"
  /** Wave 8 part 2 (drain): pods are evicted; data goes with a pod (emptyDir) or a volume. */
  | "evicts-pods" | "loses-data";
/** One line of a unified diff; "…" stands for a run of unchanged lines (its text says how many). */
export type DiffLine = { t: " " | "+" | "-" | "…"; text: string; oldNo?: number; newNo?: number };
export type ChangeOperation = {
  verb: ChangeVerb;
  kind: string;
  group: string;
  namespace?: string;
  name: string;
  /** The object as it is against what the dry run says it will be, as YAML without status or server bookkeeping. */
  diff: { lines: DiffLine[]; added: number; removed: number };
  /** The API server's warnings from the dry run. */
  warnings: string[];
  risk: ChangeRisk[];
};
export type ChangeState = "waiting" | "applying" | "applied" | "rejected" | "failed" | "expired" | "withdrawn";
/**
 * A change the agent proposed through a landlens-kube write tool, dry-run on the API server and waiting for you
 * (agent:change, sent again on every state change). Nothing is applied before you approve; what is applied is exactly
 * what the dry run checked, or nothing (the object changed since: a conflict).
 */
export type AgentChange = {
  id: string;
  session: string;
  /** The MCP gateway's call id, which the dock pairs with Claude Code's tool call. */
  call?: string;
  tool: string;
  title: string;
  /** The agent's own words for why. Untrusted text. */
  reason: string;
  operations: ChangeOperation[];
  createdAt: string;
  expiresAt: string;
  state: ChangeState;
  /** What happened, in a line: applied results, the API's error, your note. */
  result?: string;
};

/** A past agent session, as the dock's history lists it. */
export type AgentHistoryEntry = {
  session: string;
  agent: string;
  context: string;
  namespaces?: string[];
  /** Your first prompt, shortened; empty until you send one. */
  title: string;
  createdAt: string;
  updatedAt: string;
  prompts: number;
  /** Changes applied and rejected in it. */
  applied: number;
  rejected: number;
};

export type AgentSettingsInfo = {
  /** Where your skills are read from (~/.claude/skills). */
  skillsDir: string;
  skills: { name: string; description: string; chosen: boolean }[];
  /** Chosen skills that are gone from the folder. */
  missing: string[];
};

export type AgentStatus =
  | { state: "starting" | "ready" }
  | { state: "stopped"; message: string }
  | { state: "answered"; request: string };
export type Request<C extends Channel> = z.infer<(typeof channels)[C]>;

/** Main → renderer push channels. */
export const pushChannels = [
  "watch:event", "cluster:status", "agent:update", "agent:permission", "agent:status", "agent:change", "mcp:call",
  "logs:lines", "logs:end", "terminal:data", "terminal:status", "forward:update", "conn:update", "agent:autonomy",
  "family:update", "action:progress",
] as const;
export type PushChannel = (typeof pushChannels)[number];

/** An error crossing IPC keeps a Kubernetes-like status code so the UI can say "no access" vs "failed". */
export type IpcError = { status: number; message: string };

/** What the preload bridge exposes as `window.landlens`. */
export interface LandlensBridge {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Responses[C]>;
  on(channel: PushChannel, listener: (payload: any) => void): () => void;
}
