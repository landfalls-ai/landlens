// Connected clusters and the watches the UI has open on them, owned by Electron main.
import { randomBytes } from "node:crypto";
import type { ClusterInfo, KubeObject, ResourceType, WatchRequest } from "@landlens/contracts";
import { KubeClient, refPath, slim } from "./client.js";
import { discover } from "./discovery.js";
import type { FrontDoor } from "./frontdoor.js";
import { startSidecar, type Sidecar } from "./sidecar.js";
import { ResourceWatcher, type WatcherEvent } from "./watch.js";

export type Connected = {
  info: ClusterInfo;
  client: KubeClient;
  sidecar: Sidecar;
  types?: Promise<ResourceType[]>;
};

export class ClusterManager {
  private readonly clusters = new Map<string, Connected>();

  constructor(
    private readonly opts: { sidecarBinary: string; kubeconfig?: string; frontDoor: FrontDoor; log?: (l: string) => void },
  ) {}

  async connect(context: string): Promise<ClusterInfo> {
    for (const c of this.clusters.values()) if (c.info.context === context) return c.info;
    const sidecar = await startSidecar({
      binary: this.opts.sidecarBinary,
      context,
      ...(this.opts.kubeconfig ? { kubeconfig: this.opts.kubeconfig } : {}),
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
    this.clusters.set(handle, { info, client, sidecar });
    this.opts.frontDoor.addCluster(handle, sidecar);
    void sidecar.exited.then(() => this.forget(handle));
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
    c.types ??= discover(c.client).catch((err) => {
      c.types = undefined; // try again next time
      throw err;
    });
    return c.types;
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

  private forget(handle: string) {
    this.clusters.delete(handle);
    this.opts.frontDoor.removeCluster(handle);
  }
}

type Shared = { watcher: ResourceWatcher; subscribers: Map<string, (e: WatcherEvent) => void>; last?: WatcherEvent };

/** One watcher per (cluster, kind, namespace), shared by every view that shows it, stopped when the last leaves. */
export class WatchHub {
  private readonly shared = new Map<string, Shared>();
  private readonly bySubscription = new Map<string, string>();

  constructor(private readonly clusters: ClusterManager) {}

  subscribe(req: WatchRequest, send: (e: WatcherEvent) => void): string {
    const key = [req.handle, req.group, req.version, req.resource, req.namespace ?? ""].join("|");
    const id = randomBytes(9).toString("base64url");
    let s = this.shared.get(key);
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
    } else if (s.last?.type === "snapshot") {
      // A late subscriber gets the current state at once.
      send({ type: "snapshot", items: s.watcher.snapshot() });
    } else if (s.last) {
      send(s.last);
    }
    s.subscribers.set(id, send);
    this.bySubscription.set(id, key);
    return id;
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
}
