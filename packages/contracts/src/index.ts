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

/** Request/response channels: name → [request schema, response type]. */
export const channels = {
  "catalog:list": z.object({}),
  "cluster:connect": z.object({ context: z.string().min(1).max(253) }),
  "cluster:disconnect": z.object({ handle: Handle }),
  "cluster:discovery": z.object({ handle: Handle }),
  "cluster:access": z.object({ handle: Handle, checks: z.array(AccessCheck).max(200) }),
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
} as const;
export type Channel = keyof typeof channels;

export type Responses = {
  "catalog:list": { contexts: KubeContext[]; error?: string };
  "cluster:connect": ClusterInfo;
  "cluster:disconnect": { ok: true };
  "cluster:discovery": { types: ResourceType[] };
  "cluster:access": { allowed: boolean[] };
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
export const pushChannels = ["watch:event", "cluster:status", "agent:update", "agent:permission", "agent:status"] as const;
export type PushChannel = (typeof pushChannels)[number];

/** An error crossing IPC keeps a Kubernetes-like status code so the UI can say "no access" vs "failed". */
export type IpcError = { status: number; message: string };

/** What the preload bridge exposes as `window.landlens`. */
export interface LandlensBridge {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Responses[C]>;
  on(channel: PushChannel, listener: (payload: any) => void): () => void;
}
