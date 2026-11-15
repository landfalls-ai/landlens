// Connected clusters and the watches the UI has open on them, owned by Electron main.
import { randomBytes } from "node:crypto";
import type { ClusterInfo, KubeObject, ResourceType, WatchRequest } from "@landlens/contracts";
import { KubeClient, refPath, slim } from "./client.js";
import { discover } from "./discovery.js";
import { key as typeKey } from "./policy.js";
import type { FrontDoor } from "./frontdoor.js";
import { startSidecar, type Sidecar } from "./sidecar.js";
import { ResourceWatcher, type WatcherEvent } from "./watch.js";

export type Connected = {
  info: ClusterInfo;
  client: KubeClient;
  sidecar: Sidecar;
  types?: Promise<ResourceType[]>;
  /** `resource[.group]` → namespaced, once discovery has answered; the front door reads it synchronously. */
  scope?: Map<string, boolean>;
};

/** `envOnly` and `refuseLocal`: a GKE cluster's (sidecar.ts). */
export type ConnectOptions = { kubeconfig?: string; env?: Record<string, string>; envOnly?: boolean; refuseLocal?: boolean };

export class ClusterManager {
  private readonly clusters = new Map<string, Connected>();
  /** Connects in flight, by context, so two clicks don't start two sidecars. */
  private readonly connecting = new Map<string, Promise<ClusterInfo>>();
  private readonly goneListeners: ((handle: string, why: "disconnected" | "exited") => void)[] = [];
  private readonly connectedListeners: ((info: ClusterInfo) => void)[] = [];

  constructor(
    private readonly opts: { sidecarBinary: string; kubeconfig?: string; frontDoor: FrontDoor; log?: (l: string) => void },
  ) {}

  /** Called when a cluster goes away: disconnected, or its sidecar exited (`why`). */
  onGone(fn: (handle: string, why: "disconnected" | "exited") => void) {
    this.goneListeners.push(fn);
  }

  /** Called when a cluster is connected (Landlens's telemetry counts it, wave 7 D128). */
  onConnected(fn: (info: ClusterInfo) => void) {
    this.connectedListeners.push(fn);
  }

  /**
   * Connect to a context. `opts` is for a context that isn't in your kubeconfig: a GKE cluster's comes from Landlens's
   * own kubeconfig in its data folder, with the environment its exec plugin needs (wave 6, D91).
   */
  async connect(context: string, opts: ConnectOptions = {}): Promise<ClusterInfo> {
    for (const c of this.clusters.values()) if (c.info.context === context) return c.info;
    let p = this.connecting.get(context);
    if (!p) {
      p = this.start(context, opts).finally(() => this.connecting.delete(context));
      this.connecting.set(context, p);
    }
    return p;
  }

  private async start(context: string, opts: ConnectOptions): Promise<ClusterInfo> {
    const kubeconfig = opts.kubeconfig ?? this.opts.kubeconfig;
    const sidecar = await startSidecar({
      binary: this.opts.sidecarBinary,
      context,
      ...(kubeconfig ? { kubeconfig } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.envOnly ? { envOnly: true } : {}),
      ...(opts.refuseLocal ? { refuseLocal: true } : {}),
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
    const client = new KubeClient(sidecar);
    let version: string;
    try {
      const v = await client.json("/version");
      version = v.gitVersion ?? "unknown";
    } catch (err) {
      await sidecar.stop();
      throw err;
    }
    // A random handle: OpenLens used md5(path:context), which any local process could compute.
    const handle = randomBytes(12).toString("base64url");
    const info: ClusterInfo = { handle, context, server: sidecar.server, version };
    const entry: Connected = { info, client, sidecar };
    this.clusters.set(handle, entry);
    this.opts.frontDoor.addCluster(handle, { url: sidecar.url, secret: sidecar.secret, scopeOf: (k) => entry.scope?.get(k), context, server: sidecar.server });
    void sidecar.exited.then(() => this.forget(handle, "exited"));
    for (const fn of this.connectedListeners) fn(info);
    return info;
  }

  get(handle: string): Connected {
    const c = this.clusters.get(handle);
    if (!c) throw Object.assign(new Error("cluster is not connected"), { status: 404 });
    return c;
  }

  list(): ClusterInfo[] {
    return [...this.clusters.values()].map((c) => c.info);
  }

  async discovery(handle: string): Promise<ResourceType[]> {
    const c = this.get(handle);
    c.types ??= discover(c.client).then(
      (types) => {
        c.scope = new Map(types.map((t) => [typeKey(t.resource, t.group), t.namespaced]));
        return types;
      },
      (err) => {
        c.types = undefined; // try again next time
        throw err;
      },
    );
    return c.types;
  }

  /** The kind as discovery knows it; 404 for anything the cluster doesn't serve. */
  async typeOf(handle: string, ref: { group: string; version: string; resource: string }): Promise<ResourceType> {
    const t = (await this.discovery(handle)).find((t) => t.group === ref.group && t.resource === ref.resource);
    if (!t) throw Object.assign(new Error(`this cluster does not serve ${typeKey(ref.resource, ref.group)}`), { status: 404 });
    return t;
  }

  async getObject(handle: string, ref: Parameters<typeof refPath>[0]): Promise<KubeObject> {
    return slim(await this.get(handle).client.json(refPath(ref)));
  }

  async eventsFor(handle: string, uid: string, namespace?: string): Promise<KubeObject[]> {
    const q = new URLSearchParams({ fieldSelector: `involvedObject.uid=${uid}`, limit: "200" });
    const path = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` : "/api/v1/events";
    const list = await this.get(handle).client.json(`${path}?${q}`);
    return (list.items ?? []).map(slim);
  }

  async disconnect(handle: string): Promise<void> {
    const c = this.clusters.get(handle);
    if (!c) return;
    this.forget(handle);
    await c.sidecar.stop();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clusters.keys()].map((h) => this.disconnect(h)));
  }

  private forget(handle: string, why: "disconnected" | "exited" = "disconnected") {
    if (!this.clusters.delete(handle)) return;
    this.opts.frontDoor.removeCluster(handle);
    for (const fn of this.goneListeners) fn(handle, why);
  }
}

type Shared = { watcher: ResourceWatcher; subscribers: Map<string, (e: WatcherEvent) => void>; last?: WatcherEvent };

/** One watcher per (cluster, kind, namespace), shared by every view that shows it, stopped when the last leaves. */
export class WatchHub {
  private readonly shared = new Map<string, Shared>();
  private readonly bySubscription = new Map<string, string>();

  constructor(
    private readonly clusters: ClusterManager,
    private readonly maxSubscriptions = 500,
  ) {
    clusters.onGone((handle) => void this.stopAll(handle));
  }

  subscribe(req: WatchRequest, send: (e: WatcherEvent) => void): string {
    if (this.bySubscription.size >= this.maxSubscriptions) {
      throw Object.assign(new Error(`too many open watches (${this.maxSubscriptions})`), { status: 429 });
    }
    const key = [req.handle, req.group, req.version, req.resource, req.namespace ?? ""].join("|");
    const id = randomBytes(9).toString("base64url");
    let s = this.shared.get(key);
    if (s?.watcher.failed) {
      this.drop(key, s); // it ended on no access or an unknown kind; a new subscriber tries again
      s = undefined;
    }
    if (!s) {
      const client = this.clusters.get(req.handle).client;
      const subscribers = new Map<string, (e: WatcherEvent) => void>();
      const entry: Shared = {
        subscribers,
        watcher: new ResourceWatcher(client, req, (e) => {
          if (e.type !== "delta") entry.last = e;
          for (const fn of subscribers.values()) fn(e);
        }),
      };
      s = entry;
      this.shared.set(key, s);
      s.watcher.start();
    } else if (s.last) {
      // A late subscriber gets the current state, after subscribe() has returned its id to the caller.
      const entry = s;
      const last = s.last;
      queueMicrotask(() => {
        if (!entry.subscribers.has(id)) return;
        send(last.type === "snapshot" ? { type: "snapshot", items: entry.watcher.snapshot() } : last);
      });
    }
    s.subscribers.set(id, send);
    this.bySubscription.set(id, key);
    return id;
  }

  /** The shared watcher's current objects for a subscription (no second copy is kept); undefined if it is gone. */
  items(id: string): KubeObject[] | undefined {
    const key = this.bySubscription.get(id);
    const s = key ? this.shared.get(key) : undefined;
    return s?.watcher.snapshot();
  }

  unsubscribe(id: string) {
    const key = this.bySubscription.get(id);
    if (!key) return;
    this.bySubscription.delete(id);
    const s = this.shared.get(key);
    if (!s) return;
    s.subscribers.delete(id);
    if (s.subscribers.size === 0) {
      this.shared.delete(key);
      void s.watcher.stop();
    }
  }

  private drop(key: string, s: Shared) {
    this.shared.delete(key);
    for (const id of s.subscribers.keys()) this.bySubscription.delete(id);
    void s.watcher.stop();
  }

  /** Stop everything for a cluster (on disconnect) or for everyone (on quit). */
  async stopAll(handle?: string) {
    const stops: Promise<void>[] = [];
    for (const [key, s] of this.shared) {
      if (handle && !key.startsWith(handle + "|")) continue;
      this.shared.delete(key);
      for (const id of s.subscribers.keys()) this.bySubscription.delete(id);
      stops.push(s.watcher.stop());
    }
    await Promise.all(stops);
  }

  get size() {
    return this.shared.size;
  }

  get subscriptions() {
    return this.bySubscription.size;
  }
}
