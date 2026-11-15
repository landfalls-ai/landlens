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
} as const;
/** "<Sibling> answered HTTP <n>.": the one note with a number in it. */
export const familyHttpNote = (name: "Clickland" | "Landflow" | "Landfall", status: number) => `${name} answered HTTP ${Math.trunc(status)}.`;

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
  /** Accept the listing the last family:test showed (D111). */
  "family:repin": z.object({ sibling: Sibling }),
  "family:disconnect": z.object({ sibling: Sibling }),
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
  | "no-metrics-server"
  | "live-only"; // metrics-server: samples only since Landlens opened, at most an hour
export type MetricsReason = { code: MetricsReasonCode; message: string };
export type MetricsSeries = {
  source: "clickland" | "prometheus" | "metrics-server" | "none";
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
  log?: { pod: string; container: string; previous: boolean; lines: string[]; cut: boolean } | { error: string };
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
  | "service-account" | "new-workload" | "scales-to-zero" | "changes-image" | "restarts-pods";
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
  "family:update",
] as const;
export type PushChannel = (typeof pushChannels)[number];

/** An error crossing IPC keeps a Kubernetes-like status code so the UI can say "no access" vs "failed". */
export type IpcError = { status: number; message: string };

/** What the preload bridge exposes as `window.landlens`. */
export interface LandlensBridge {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Responses[C]>;
  on(channel: PushChannel, listener: (payload: any) => void): () => void;
}
