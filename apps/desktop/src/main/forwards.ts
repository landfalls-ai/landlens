// Port-forwards (wave 4, part 3; D33–D37): a port on 127.0.0.1 and [::1] that reaches a pod's port, or a Service's
// through one ready pod, through the front door as you. Each pod gets a token that may forward only its one port
// ("you · <context> · forward <ns>/<pod>:<port>"), revoked when the forward stops or moves to another pod, which
// closes its connections. Forwards are local sessions, like shells: they belong to the app, not a window, end with
// their cluster, and the kept ones are saved per context and start again when Landlens reconnects to the same
// cluster under that context.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { NamespaceName, ObjectName, Uid, type ClusterInfo, type ForwardInfo, type KubeObject, type Request } from "@landlens/contracts";
import { apiPath, bridge, isPortFree, listenLocal, pickPod, podPort, podReady, selectorQuery, servicePort, suggestPort, type ClusterManager, type Connected, type FrontDoor, type Listener } from "@landlens/kube";
import { z } from "zod";

/** Forwards per context (what the Forwards tab shows), and in all. */
export const MAX_FORWARDS = 20;
const MAX_SAVED = 100;
/** Open connections per forward, and in all: each costs main four sockets and the API server a stream. */
export const MAX_CONNECTIONS = 64;
const MAX_ALL_CONNECTIONS = 256;
/** How often a running forward checks its pod is still there and ready. */
const CHECK_MS = 5_000;
/** A check's read gives up after this long. */
const READ_MS = 10_000;
/** At most this many pushes a second. */
const PUSH_MS = 200;

/** Labels a rollout or the pod's own identity changes: a replacement pod has the rest. */
const VOLATILE = new Set(["pod-template-hash", "controller-revision-hash", "statefulset.kubernetes.io/pod-name", "apps.kubernetes.io/pod-index", "batch.kubernetes.io/controller-uid", "controller-uid", "batch.kubernetes.io/job-name", "job-name"]);

const LabelKey = z.string().max(317).regex(/^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/);
const LabelValue = z.string().max(63).regex(/^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/);
const Owner = z.object({ kind: z.string().regex(/^[A-Z][A-Za-z0-9]{0,62}$/), name: ObjectName }).strict();
type Owner = z.infer<typeof Owner>;

/** What a forward is, as saved: no tokens, no pod. Held to the same names IPC is (security review, finding 7). */
const Saved = z.object({
  id: z.string().regex(/^fw[A-Za-z0-9_-]{8,32}$/),
  context: z.string().min(1).max(253),
  /** The cluster it was made on: its API server and kube-system's uid. A context name can point elsewhere later. */
  server: z.string().min(1).max(2048).optional(),
  cluster: Uid.optional(),
  namespace: NamespaceName,
  kind: z.enum(["pod", "service"]),
  name: ObjectName,
  port: z.number().int().min(1).max(65535),
  localPort: z.number().int().min(1024).max(65535),
  /** A pod forward's way to find a replacement pod: its controller's, and the pod's stable labels. */
  labels: z.record(LabelKey, LabelValue).optional(),
  owner: Owner.optional(),
  scheme: z.enum(["http", "https"]).default("http"),
  /** You stopped it: it isn't started again on reconnect. */
  stopped: z.boolean().optional(),
}).strict();
type Saved = z.infer<typeof Saved>;

type Live = Saved & {
  keep: boolean;
  /** Set from the moment a start begins (so the cluster going, or a second restore, sees it) until it stops. */
  handle?: string;
  state: ForwardInfo["state"];
  pod?: string;
  podPort?: number;
  token?: string;
  listener?: Listener;
  timer?: ReturnType<typeof setInterval>;
  /** The check in flight, so connections and ticks don't pile reads up. */
  checking?: { gen: number; done: Promise<void> };
  message?: string;
  lastError?: string;
  since: number;
  open: Set<() => void>;
  /** Bumped by each start and stop, so anything that finishes late can tell it is stale. */
  gen: number;
};

const err = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });
const PODS = { group: "", version: "v1", resource: "pods" };
const SERVICES = { group: "", version: "v1", resource: "services" };
const OTHER_CLUSTER = "This context now points at another cluster. Remove this forward and start a new one.";

type Read = (path: string) => Promise<any>;

export class ForwardService {
  private readonly forwards = new Map<string, Live>();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: {
    clusters: Pick<ClusterManager, "get" | "onGone">;
    frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
    /** Where kept forwards are saved. */
    file: string;
    push: (forwards: ForwardInfo[]) => void;
    openExternal: (url: string) => unknown;
    log?: (l: string) => void;
    /** How often a running forward checks its pod (tests make it short). */
    checkMs?: number;
  }) {
    for (const s of this.load()) this.forwards.set(s.id, { ...s, keep: true, state: "stopped", since: Date.now(), open: new Set(), gen: 0 });
    deps.clusters.onGone((handle) => this.clusterGone(handle));
  }

  list(): ForwardInfo[] {
    return [...this.forwards.values()].map((f) => ({
      id: f.id, context: f.context, namespace: f.namespace, kind: f.kind, name: f.name, port: f.port, localPort: f.localPort,
      keep: f.keep, state: f.state, since: f.since, connections: f.open.size, scheme: f.scheme,
      ...(f.pod ? { pod: f.pod } : {}), ...(f.podPort ? { podPort: f.podPort } : {}),
      ...(f.message ? { message: f.message } : {}), ...(f.lastError ? { lastError: f.lastError } : {}),
    }));
  }

  suggest(port: number): Promise<{ port: number }> {
    const taken = new Set([...this.forwards.values()].filter((f) => f.listener || f.handle).map((f) => f.localPort));
    return suggestPort(port, async (p) => !taken.has(p) && (await isPortFree(p))).then((p) => ({ port: p }));
  }

  async check(port: number): Promise<{ free: boolean; next?: number }> {
    if (await isPortFree(port)) return { free: true };
    return { free: false, next: (await this.suggest(port + 1 > 65535 ? 1024 : port + 1)).port };
  }

  async start(r: Request<"forward:start">): Promise<ForwardInfo> {
    const context = this.deps.clusters.get(r.handle).info.context;
    this.room(context);
    const c = this.deps.clusters.get(r.handle);
    const read = reader(c);
    let labels: Record<string, string> | undefined;
    let owner: Owner | undefined;
    let scheme: "http" | "https" = r.port === 443 || r.port === 8443 ? "https" : "http";
    // Check the target first, so a typo fails here and not on the first connection.
    if (r.kind === "pod") {
      const pod = await read(apiPath(PODS, r.namespace, r.name));
      labels = replacementLabels(pod);
      if (labels) owner = await controllerOf(pod, read);
      if (!owner) labels = undefined;
    } else {
      const svc = await read(apiPath(SERVICES, r.namespace, r.name));
      const sp = servicePort(svc, r.port);
      if (!sp) throw err(400, `${r.name} has no TCP port ${r.port}`);
      if (!hasSelector(svc)) throw err(400, `${r.name} has no selector, so there is no pod to forward to`);
      if (/https|tls/i.test(sp.name ?? "")) scheme = "https";
    }
    const cluster = await clusterId(read);
    // The reads took time: the cluster may have gone, and other starts may have filled the room (finding 3, 4).
    const now = this.deps.clusters.get(r.handle);
    if (now.info.context !== context) throw err(409, "the cluster changed while this forward started");
    this.room(context);
    const f: Live = {
      id: `fw${randomBytes(12).toString("base64url")}`, context, server: now.info.server, ...(cluster ? { cluster } : {}),
      namespace: r.namespace, kind: r.kind, name: r.name, port: r.port, localPort: r.localPort, scheme,
      ...(labels && owner ? { labels, owner } : {}),
      keep: r.keep, state: "starting", since: Date.now(), open: new Set(), gen: 0,
    };
    this.forwards.set(f.id, f);
    try {
      await this.begin(f, r.handle);
    } catch (e) {
      this.forwards.delete(f.id);
      this.changed();
      throw e;
    }
    if (f.keep) this.save();
    return this.info(f);
  }

  async resume(id: string, handle: string): Promise<ForwardInfo> {
    const f = this.get(id);
    const c = this.deps.clusters.get(handle);
    if (c.info.context !== f.context) throw err(400, `this forward is for ${f.context}`);
    if (f.listener || f.handle) return this.info(f);
    if (f.server) {
      // You asked for it, but a context that now names another cluster is still not the one it was made for.
      const why = await this.other(f, c.info, reader(c));
      if (why) {
        this.set(f, "stopped", why);
        throw err(409, why);
      }
    } else {
      // Saved before Landlens noted the cluster: starting it by hand ties it to this one.
      f.server = c.info.server;
      const cluster = await clusterId(reader(c));
      if (cluster) f.cluster = cluster;
    }
    delete f.stopped;
    await this.begin(f, handle);
    if (f.keep) this.save();
    return this.info(f);
  }

  stop(id: string) {
    const f = this.get(id);
    this.halt(f, "stopped");
    f.stopped = true;
    if (f.keep) this.save();
    this.changed();
  }

  remove(id: string) {
    const f = this.get(id);
    this.halt(f, "stopped");
    this.forwards.delete(id);
    if (f.keep) this.save();
    this.changed();
  }

  open(id: string) {
    const f = this.get(id);
    if (!f.listener) throw err(409, "this forward isn't running");
    // Built here from the forward's own port: the window never names a URL.
    void this.deps.openExternal(`${f.scheme}://127.0.0.1:${f.localPort}/`);
  }

  /**
   * Start the kept forwards for this cluster's context (D37), without opening anything: only those made on this
   * cluster (its API server, and kube-system's uid when it can be read), not whatever the context names now (finding 8).
   */
  restore(info: ClusterInfo) {
    for (const f of this.forwards.values()) {
      if (f.context !== info.context || !f.keep || f.stopped || f.listener || f.handle) continue;
      const gen = f.gen;
      f.handle = info.handle;
      void (async () => {
        let why: string | undefined;
        try {
          why = f.server ? await this.other(f, info, reader(this.deps.clusters.get(info.handle))) : "Saved before Landlens noted which cluster it is for: start it again to tie it to this one.";
        } catch {
          why = "The cluster disconnected.";
        }
        if (gen !== f.gen || !this.forwards.has(f.id)) return;
        if (why) {
          delete f.handle;
          return this.set(f, "stopped", why);
        }
        await this.begin(f, info.handle).catch(() => this.changed());
      })();
    }
  }

  /** The app is quitting: close everything, keep what is saved. */
  stopAll() {
    for (const f of this.forwards.values()) this.halt(f, "stopped");
  }

  // --- inside ---

  private get(id: string): Live {
    const f = this.forwards.get(id);
    if (!f) throw err(404, "no such forward");
    return f;
  }

  private info(f: Live): ForwardInfo {
    return this.list().find((x) => x.id === f.id)!;
  }

  private set(f: Live, state: ForwardInfo["state"], message?: string) {
    if (f.state !== state) f.since = Date.now();
    f.state = state;
    if (message) f.message = message;
    else delete f.message;
    this.changed();
  }

  /** Room for one more forward on this context, and in all. */
  private room(context: string) {
    const all = [...this.forwards.values()];
    if (all.filter((f) => f.context === context).length >= MAX_FORWARDS) throw err(429, `at most ${MAX_FORWARDS} forwards for one cluster`);
    if (all.length >= MAX_SAVED) throw err(429, `at most ${MAX_SAVED} forwards`);
  }

  /** Why this cluster isn't the one the forward was made on, if it isn't. */
  private async other(f: Live, info: ClusterInfo, read: Read): Promise<string | undefined> {
    if (f.server !== info.server) return OTHER_CLUSTER;
    if (!f.cluster) return undefined;
    const now = await clusterId(read);
    return now && now !== f.cluster ? OTHER_CLUSTER : undefined;
  }

  /**
   * Listen, then run, unless the forward was stopped or removed, or its cluster went, while it listened (security
   * review, finding 3): then the listener closes and no token is issued.
   */
  private async begin(f: Live, handle: string) {
    const gen = ++f.gen;
    f.handle = handle;
    this.set(f, "starting");
    let l: Listener;
    try {
      l = await this.listen(f);
    } catch (e) {
      if (gen === f.gen) delete f.handle;
      throw e;
    }
    let alive = true;
    try {
      this.deps.clusters.get(handle);
    } catch {
      alive = false;
    }
    if (gen !== f.gen || !this.forwards.has(f.id) || !alive) {
      l.close();
      if (gen === f.gen) {
        delete f.handle;
        this.set(f, "stopped", alive ? undefined : "The cluster disconnected.");
      }
      throw err(409, "this forward stopped while it started");
    }
    f.listener = l;
    this.run(f, handle);
  }

  /** Listen on the forward's port, or say it's taken (with a free one to offer). */
  private async listen(f: Live): Promise<Listener> {
    try {
      return await listenLocal(f.localPort, (s) => this.connection(f, s));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        const next = (await this.suggest(f.localPort + 1 > 65535 ? 1024 : f.localPort + 1)).port;
        this.set(f, "failed", `Port ${f.localPort} is in use by another program.`);
        throw err(409, `Port ${f.localPort} is in use. ${next} is free.`, { next });
      }
      this.set(f, "failed", (e as Error).message);
      throw e;
    }
  }

  /** Find the pod, then keep checking it is there; a Service's or a controller's pod is replaced when it goes. */
  private run(f: Live, handle: string) {
    f.handle = handle;
    const gen = ++f.gen;
    this.set(f, "starting");
    const tick = () => void this.verify(f, gen);
    tick();
    f.timer = setInterval(tick, this.deps.checkMs ?? CHECK_MS);
    f.timer.unref?.();
  }

  /** One check at a time per forward (finding 4). */
  private verify(f: Live, gen: number): Promise<void> {
    if (gen !== f.gen || !f.handle) return Promise.resolve();
    if (f.checking?.gen === gen) return f.checking.done;
    const done = this.check1(f, gen).finally(() => {
      if (f.checking?.done === done) delete f.checking;
    });
    f.checking = { gen, done };
    return done;
  }

  private async check1(f: Live, gen: number) {
    let c: Connected;
    try {
      c = this.deps.clusters.get(f.handle!) as Connected;
    } catch {
      // The cluster went and nobody said (finding 3): stop, as a cluster switch does.
      this.halt(f, "stopped", "The cluster disconnected.");
      if (!f.keep) this.forwards.delete(f.id);
      return;
    }
    const read = reader(c);
    try {
      // A pod forward that is still good: the pod is there and ready (a bare pod: running). A Service forward reads
      // the Service every time, so a changed selector or port, or a deleted Service, moves or stops it (finding 6).
      if (f.pod && f.kind === "pod") {
        const pod = await read(apiPath(PODS, f.namespace, f.pod)).catch(() => undefined);
        if (gen !== f.gen) return;
        if (pod && (!f.labels ? running(pod) : podReady(pod))) return f.state === "running" ? undefined : this.set(f, "running");
      }
      const found = await this.find(f, read);
      if (gen !== f.gen) return;
      if (!found || found === "gone") {
        this.retarget(f);
        const gone = f.kind === "pod" && !f.labels;
        return this.set(f, gone ? "failed" : "reconnecting", gone ? `${f.name} is gone or not running.` : found === "gone" ? `Service ${f.name} is gone.` : f.kind === "service" ? `No ready pod behind ${f.name} yet.` : `Waiting for a pod like ${f.name}.`);
      }
      if (found.pod !== f.pod || found.port !== f.podPort) {
        this.retarget(f, found);
        // Straight from one ready pod to another: the state stays Running, but the window must hear of the move.
        this.changed();
      }
      if (f.state !== "running") this.set(f, "running");
    } catch (e) {
      if (gen === f.gen) this.set(f, "reconnecting", `Can't read the cluster: ${String((e as Error).message)}`.slice(0, 300));
    }
  }

  private async find(f: Live, read: Read): Promise<{ pod: string; port: number } | "gone" | undefined> {
    if (f.kind === "pod") {
      const pod = await read(apiPath(PODS, f.namespace, f.name)).catch(() => undefined);
      if (pod && running(pod)) return { pod: f.name, port: f.port };
      if (!f.labels || !f.owner || !Object.keys(f.labels).length) return undefined;
      // Only pods of the same controller: another pod with the same labels is not this forward's (finding 6).
      const list = await read(`${apiPath(PODS, f.namespace)}?labelSelector=${encodeURIComponent(selectorQuery(f.labels))}`);
      const mine: KubeObject[] = [];
      for (const p of ((list.items ?? []) as KubeObject[]).filter(podReady).slice(0, 50)) {
        const o = await controllerOf(p, read);
        if (o && o.kind === f.owner.kind && o.name === f.owner.name) mine.push(p);
      }
      const p = pickPod(mine, f.port);
      return p && { pod: p.pod.metadata.name, port: p.port };
    }
    const svc = await read(apiPath(SERVICES, f.namespace, f.name)).catch((e) => {
      if ((e as { status?: number }).status === 404) return undefined;
      throw e;
    });
    if (!svc) return "gone";
    const sp = servicePort(svc, f.port);
    if (!sp || !hasSelector(svc)) return undefined;
    const list = await read(`${apiPath(PODS, f.namespace)}?labelSelector=${encodeURIComponent(selectorQuery(svc.spec.selector))}`);
    const items = (list.items ?? []) as KubeObject[];
    // Stay on the current pod while it is still behind the Service, ready, with the same port.
    const cur = f.pod ? items.find((p) => p.metadata.name === f.pod && podReady(p)) : undefined;
    if (cur && podPort(cur, sp.target) === f.podPort) return { pod: f.pod!, port: f.podPort! };
    const p = pickPod(items, sp.target);
    return p && { pod: p.pod.metadata.name, port: p.port };
  }

  /** Point the forward at another pod (or none): the old token goes, which closes its connections. */
  private retarget(f: Live, to?: { pod: string; port: number }) {
    if (f.token) this.deps.frontDoor.revokeToken(f.token);
    delete f.token;
    delete f.pod;
    delete f.podPort;
    if (!to || !f.handle) return;
    f.pod = to.pod;
    f.podPort = to.port;
    f.token = this.deps.frontDoor.issueToken({
      label: `you · ${f.context} · forward ${f.namespace}/${to.pod}:${to.port}`,
      policy: { access: "forward", pod: { namespace: f.namespace, name: to.pod }, port: to.port },
      clusters: [f.handle],
    });
  }

  private connection(f: Live, s: Socket) {
    if (f.state !== "running" || !f.token || !f.pod || !f.podPort || !f.handle) {
      s.destroy();
      void this.verify(f, f.gen);
      return;
    }
    let total = 0;
    for (const x of this.forwards.values()) total += x.open.size;
    if (f.open.size >= MAX_CONNECTIONS || total >= MAX_ALL_CONNECTIONS) {
      s.destroy();
      f.lastError = f.open.size >= MAX_CONNECTIONS ? `Too many connections at once (at most ${MAX_CONNECTIONS}): one was refused.` : `Too many connections across forwards (at most ${MAX_ALL_CONNECTIONS}): one was refused.`;
      this.changed();
      return;
    }
    const close = bridge(
      { url: this.deps.frontDoor.clusterUrl(f.handle), certificate: this.deps.frontDoor.certificate, token: f.token, namespace: f.namespace, pod: f.pod, port: f.podPort },
      s,
      {
        error: (e) => {
          f.lastError = String(e.message).slice(0, 300);
          // The pod went between checks: look again now.
          if (e.status === 404) void this.verify(f, f.gen);
          this.changed();
        },
        open: () => {
          if (f.lastError) (delete f.lastError, this.changed());
        },
      },
    );
    f.open.add(close);
    s.once("close", () => (f.open.delete(close), this.changed()));
    this.changed();
  }

  private halt(f: Live, state: "stopped" | "failed", message?: string) {
    f.gen++;
    if (f.timer) clearInterval(f.timer);
    delete f.timer;
    delete f.checking;
    for (const close of [...f.open]) close();
    f.open.clear();
    f.listener?.close();
    delete f.listener;
    this.retarget(f);
    delete f.handle;
    delete f.lastError;
    this.set(f, state, message);
  }

  /** Sessions end on a cluster switch: forwards stop; the kept ones start again on reconnect. */
  private clusterGone(handle: string) {
    for (const f of [...this.forwards.values()]) {
      if (f.handle !== handle) continue;
      this.halt(f, "stopped");
      if (!f.keep) this.forwards.delete(f.id);
    }
    this.changed();
  }

  private changed() {
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = undefined;
      this.deps.push(this.list());
    }, PUSH_MS);
  }

  private load(): Saved[] {
    try {
      const raw = JSON.parse(readFileSync(this.deps.file, "utf8")) as { version?: unknown; forwards?: unknown };
      if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.forwards)) return [];
      return raw.forwards.slice(0, MAX_SAVED).flatMap((x) => {
        const p = Saved.safeParse(x);
        return p.success ? [p.data] : [];
      });
    } catch {
      return [];
    }
  }

  private save() {
    const forwards: Saved[] = [...this.forwards.values()].filter((f) => f.keep).map((f) => ({
      id: f.id, context: f.context, ...(f.server ? { server: f.server } : {}), ...(f.cluster ? { cluster: f.cluster } : {}),
      namespace: f.namespace, kind: f.kind, name: f.name, port: f.port, localPort: f.localPort, scheme: f.scheme,
      ...(f.labels ? { labels: f.labels } : {}), ...(f.owner ? { owner: f.owner } : {}), ...(f.stopped ? { stopped: true } : {}),
    }));
    const tmp = `${this.deps.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 2, forwards }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.deps.file);
  }
}

/** Reads for checks: straight to the sidecar as you, each with a time limit (finding 4). */
const reader = (c: Pick<Connected, "client">): Read => (path) => c.client.json(path, { signal: AbortSignal.timeout(READ_MS) });

const running = (p: KubeObject) => !p.metadata.deletionTimestamp && p.status?.phase === "Running";

/** A selector that selects something: `{}` would be every pod in the namespace (finding 6). */
const hasSelector = (svc: KubeObject) => !!svc.spec?.selector && Object.keys(svc.spec.selector).length > 0;

/** This cluster's identity beyond its URL: kube-system's uid, when you may read it. */
async function clusterId(read: Read): Promise<string | undefined> {
  try {
    const uid = (await read("/api/v1/namespaces/kube-system"))?.metadata?.uid;
    return Uid.safeParse(uid).success ? uid : undefined;
  } catch {
    return undefined;
  }
}

/** The pod's controller, and a ReplicaSet's Deployment, so a rollout's new ReplicaSet counts as the same. */
async function controllerOf(pod: KubeObject, read: Read): Promise<Owner | undefined> {
  const ref = (pod.metadata.ownerReferences ?? []).find((o: { controller?: boolean }) => o.controller) as { kind?: string; name?: string } | undefined;
  const own = Owner.safeParse({ kind: ref?.kind, name: ref?.name });
  if (!own.success) return undefined;
  if (own.data.kind !== "ReplicaSet") return own.data;
  const rs = await read(apiPath({ group: "apps", version: "v1", resource: "replicasets" }, pod.metadata.namespace, own.data.name)).catch(() => undefined);
  const up = ((rs?.metadata?.ownerReferences ?? []) as { kind?: string; name?: string; controller?: boolean }[]).find((o) => o.controller);
  const dep = Owner.safeParse({ kind: up?.kind, name: up?.name });
  return dep.success && dep.data.kind === "Deployment" ? dep.data : own.data;
}

/** A controller's pod can be replaced by one with the same stable labels; a bare pod can't. */
export function replacementLabels(pod: KubeObject): Record<string, string> | undefined {
  if (!(pod.metadata.ownerReferences ?? []).some((o: { controller?: boolean }) => o.controller)) return undefined;
  const out = Object.fromEntries(Object.entries(pod.metadata.labels ?? {}).filter(([k, v]) => !VOLATILE.has(k) && LabelKey.safeParse(k).success && LabelValue.safeParse(v).success));
  return Object.keys(out).length ? out : undefined;
}
