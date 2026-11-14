// The typed IPC between Landlens main and the sandboxed renderer. Main validates every request with these schemas;
// the preload bridge only forwards the channels listed here.
import { z } from "zod";

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
});
export type ResourceType = z.infer<typeof ResourceType>;

export const resourceKey = (t: Pick<ResourceType, "group" | "resource">) =>
  t.group ? `${t.resource}.${t.group}` : t.resource;

export const ResourceRef = z.object({
  group: z.string(),
  version: z.string(),
  resource: z.string(),
  namespace: z.string().optional(),
  name: z.string(),
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
  handle: z.string(),
  group: z.string(),
  version: z.string(),
  resource: z.string(),
  namespace: z.string().optional(), // absent: all namespaces (or cluster-scoped)
});
export type WatchRequest = z.infer<typeof WatchRequest>;

/** Pushed from main to the renderer on the `watch:event` channel. */
export type WatchEvent =
  | { subscription: string; type: "snapshot"; items: KubeObject[] }
  | { subscription: string; type: "delta"; upserted: KubeObject[]; removed: string[] }
  | { subscription: string; type: "error"; status: number; message: string };

export const AccessCheck = z.object({
  verb: z.string(),
  group: z.string(),
  resource: z.string(),
  namespace: z.string().optional(),
});
export type AccessCheck = z.infer<typeof AccessCheck>;

/** Request/response channels: name → [request schema, response type]. */
export const channels = {
  "catalog:list": z.object({}),
  "cluster:connect": z.object({ context: z.string() }),
  "cluster:disconnect": z.object({ handle: z.string() }),
  "cluster:discovery": z.object({ handle: z.string() }),
  "cluster:access": z.object({ handle: z.string(), checks: z.array(AccessCheck).max(200) }),
  "resource:get": z.object({ handle: z.string(), ref: ResourceRef }),
  "resource:events": z.object({ handle: z.string(), namespace: z.string().optional(), uid: z.string() }),
  "watch:subscribe": WatchRequest,
  "watch:unsubscribe": z.object({ subscription: z.string() }),
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
};
export type Request<C extends Channel> = z.infer<(typeof channels)[C]>;

/** Main → renderer push channels. */
export const pushChannels = ["watch:event", "cluster:status"] as const;
export type PushChannel = (typeof pushChannels)[number];

/** An error crossing IPC keeps a Kubernetes-like status code so the UI can say "no access" vs "failed". */
export type IpcError = { status: number; message: string };

/** What the preload bridge exposes as `window.landlens`. */
export interface LandlensBridge {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Responses[C]>;
  on(channel: PushChannel, listener: (payload: any) => void): () => void;
}
