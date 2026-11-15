// Port-forwards (wave 4, part 3; D33–D37): a port on 127.0.0.1 that reaches a pod's port, or a Service's through one
// ready pod, through the front door as you. Each pod gets a token that may forward only its one port
// ("you · <context> · forward <ns>/<pod>:<port>"), revoked when the forward stops or moves to another pod, which
// closes its connections. Forwards are local sessions, like shells: they belong to the app, not a window, end with
// their cluster, and the kept ones are saved per context and start again when Landlens reconnects to it.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server, Socket } from "node:net";
import type { ClusterInfo, ForwardInfo, KubeObject, Request } from "@landlens/contracts";
import { bridge, isPortFree, listenLocal, pickPod, podReady, selectorQuery, servicePort, suggestPort, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { z } from "zod";

export const MAX_FORWARDS = 20;
/** How often a running forward checks its pod is still there and ready. */
const CHECK_MS = 5_000;
/** At most this many pushes a second. */
const PUSH_MS = 200;

/** Labels a rollout or the pod's own identity changes: a replacement pod has the rest. */
const VOLATILE = new Set(["pod-template-hash", "controller-revision-hash", "statefulset.kubernetes.io/pod-name", "apps.kubernetes.io/pod-index", "batch.kubernetes.io/controller-uid", "controller-uid", "batch.kubernetes.io/job-name", "job-name"]);

/** What a forward is, as saved: no tokens, no pod. */
const Saved = z.object({
  id: z.string().regex(/^fw[A-Za-z0-9_-]{8,32}$/),
  context: z.string().min(1).max(253),
  namespace: z.string().min(1).max(63),
  kind: z.enum(["pod", "service"]),
  name: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  localPort: z.number().int().min(1024).max(65535),
  /** A pod forward's way to find a replacement pod (a controller's pods' stable labels). */
  labels: z.record(z.string().max(63 + 253), z.string().max(63)).optional(),
  scheme: z.enum(["http", "https"]).default("http"),
  /** You stopped it: it isn't started again on reconnect. */
  stopped: z.boolean().optional(),
});
type Saved = z.infer<typeof Saved>;

type Live = Saved & {
  keep: boolean;
  handle?: string;
  state: ForwardInfo["state"];
  pod?: string;
  podPort?: number;
  token?: string;
  server?: Server;
  timer?: ReturnType<typeof setInterval>;
  message?: string;
  lastError?: string;
  since: number;
  open: Set<() => void>;
  /** Bumped by each start and stop, so a resolve that finishes late can tell it is stale. */
  gen: number;
};

const err = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

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
    const taken = new Set([...this.forwards.values()].filter((f) => f.server).map((f) => f.localPort));
    return suggestPort(port, async (p) => !taken.has(p) && (await isPortFree(p))).then((p) => ({ port: p }));
  }

  async check(port: number): Promise<{ free: boolean; next?: number }> {
    if (await isPortFree(port)) return { free: true };
    return { free: false, next: (await this.suggest(port + 1 > 65535 ? 1024 : port + 1)).port };
  }

  async start(r: Request<"forward:start">): Promise<ForwardInfo> {
    if (this.forwards.size >= MAX_FORWARDS) throw err(429, `at most ${MAX_FORWARDS} forwards`);
    const c = this.deps.clusters.get(r.handle);
    const read = (path: string) => c.client.json(path) as Promise<KubeObject>;
    let labels: Record<string, string> | undefined;
    let scheme: "http" | "https" = r.port === 443 || r.port === 8443 ? "https" : "http";
    // Check the target first, so a typo fails here and not on the first connection.
    if (r.kind === "pod") {
      const pod = await read(`/api/v1/namespaces/${r.namespace}/pods/${r.name}`);
      labels = replacementLabels(pod);
    } else {
      const svc = await read(`/api/v1/namespaces/${r.namespace}/services/${r.name}`);
      const sp = servicePort(svc, r.port);
      if (!sp) throw err(400, `${r.name} has no TCP port ${r.port}`);
      if (!svc.spec?.selector || !Object.keys(svc.spec.selector).length) throw err(400, `${r.name} has no selector, so there is no pod to forward to`);
      if (/https|tls/i.test(sp.name ?? "")) scheme = "https";
    }
    const f: Live = {
      id: `fw${randomBytes(12).toString("base64url")}`, context: c.info.context, namespace: r.namespace, kind: r.kind, name: r.name,
      port: r.port, localPort: r.localPort, scheme, ...(labels ? { labels } : {}),
      keep: r.keep, state: "starting", since: Date.now(), open: new Set(), gen: 0,
    };
    await this.listen(f);
    this.forwards.set(f.id, f);
    this.run(f, r.handle);
    if (f.keep) this.save();
    this.changed();
    return this.info(f);
  }

  async resume(id: string, handle: string): Promise<ForwardInfo> {
    const f = this.get(id);
    const c = this.deps.clusters.get(handle);
    if (c.info.context !== f.context) throw err(400, `this forward is for ${f.context}`);
    if (f.server) return this.info(f);
    await this.listen(f);
    delete f.stopped;
    this.run(f, handle);
    if (f.keep) this.save();
    this.changed();
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
    if (!f.server) throw err(409, "this forward isn't running");
    // Built here from the forward's own port: the window never names a URL.
    void this.deps.openExternal(`${f.scheme}://127.0.0.1:${f.localPort}/`);
  }

  /** Start the kept forwards for this cluster's context (D37), without opening anything. */
  restore(info: ClusterInfo) {
    for (const f of this.forwards.values()) {
      if (f.context !== info.context || !f.keep || f.stopped || f.server) continue;
      this.listen(f).then(() => (this.run(f, info.handle), this.changed()), () => this.changed());
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

  /** Listen on the forward's port, or say it's taken (with a free one to offer). */
  private async listen(f: Live) {
    try {
      f.server = await listenLocal(f.localPort, (s) => this.connection(f, s));
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

  private async verify(f: Live, gen: number) {
    if (gen !== f.gen || !f.handle) return;
    let c;
    try {
      c = this.deps.clusters.get(f.handle);
    } catch {
      return;
    }
    const read = (path: string) => c.client.json(path) as Promise<any>;
    try {
      // Still good: the pod is there and ready (a pod forward: running).
      if (f.pod) {
        const pod = await read(`/api/v1/namespaces/${f.namespace}/pods/${f.pod}`).catch(() => undefined);
        if (gen !== f.gen) return;
        if (pod && (f.kind === "pod" && !f.labels ? running(pod) : podReady(pod))) return f.state === "running" ? undefined : this.set(f, "running");
      }
      const found = await this.find(f, read);
      if (gen !== f.gen) return;
      if (!found) {
        this.retarget(f);
        const gone = f.kind === "pod" && !f.labels;
        return this.set(f, gone ? "failed" : "reconnecting", gone ? `${f.name} is gone or not running.` : f.kind === "service" ? `No ready pod behind ${f.name} yet.` : `Waiting for a pod like ${f.name}.`);
      }
      if (found.pod !== f.pod || found.port !== f.podPort) this.retarget(f, found);
      this.set(f, "running");
    } catch (e) {
      if (gen === f.gen) this.set(f, "reconnecting", `Can't read the cluster: ${(e as Error).message}`.slice(0, 300));
    }
  }

  private async find(f: Live, read: (path: string) => Promise<any>): Promise<{ pod: string; port: number } | undefined> {
    if (f.kind === "pod") {
      const pod = await read(`/api/v1/namespaces/${f.namespace}/pods/${f.name}`).catch(() => undefined);
      if (pod && running(pod)) return { pod: f.name, port: f.port };
      if (!f.labels) return undefined;
      const list = await read(`/api/v1/namespaces/${f.namespace}/pods?labelSelector=${encodeURIComponent(selectorQuery(f.labels))}`);
      const p = pickPod(list.items ?? [], f.port);
      return p && { pod: p.pod.metadata.name, port: p.port };
    }
    const svc = await read(`/api/v1/namespaces/${f.namespace}/services/${f.name}`);
    const sp = servicePort(svc, f.port);
    if (!sp || !svc.spec?.selector) return undefined;
    const list = await read(`/api/v1/namespaces/${f.namespace}/pods?labelSelector=${encodeURIComponent(selectorQuery(svc.spec.selector))}`);
    const p = pickPod(list.items ?? [], sp.target);
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
    const close = bridge(
      { url: this.deps.frontDoor.clusterUrl(f.handle), certificate: this.deps.frontDoor.certificate, token: f.token, namespace: f.namespace, pod: f.pod, port: f.podPort },
      s,
      {
        error: (e) => {
          f.lastError = e.message.slice(0, 300);
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
    for (const close of [...f.open]) close();
    f.open.clear();
    f.server?.close();
    delete f.server;
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
      const raw = JSON.parse(readFileSync(this.deps.file, "utf8")) as { forwards?: unknown[] };
      return (raw.forwards ?? []).slice(0, MAX_FORWARDS).flatMap((x) => {
        const p = Saved.safeParse(x);
        return p.success ? [p.data] : [];
      });
    } catch {
      return [];
    }
  }

  private save() {
    const forwards: Saved[] = [...this.forwards.values()].filter((f) => f.keep).map((f) => ({
      id: f.id, context: f.context, namespace: f.namespace, kind: f.kind, name: f.name, port: f.port, localPort: f.localPort, scheme: f.scheme,
      ...(f.labels ? { labels: f.labels } : {}), ...(f.stopped ? { stopped: true } : {}),
    }));
    const tmp = `${this.deps.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, forwards }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.deps.file);
  }
}

const running = (p: KubeObject) => !p.metadata.deletionTimestamp && p.status?.phase === "Running";

/** A controller's pod can be replaced by one with the same stable labels; a bare pod can't. */
export function replacementLabels(pod: KubeObject): Record<string, string> | undefined {
  if (!(pod.metadata.ownerReferences ?? []).some((o: { controller?: boolean }) => o.controller)) return undefined;
  const out = Object.fromEntries(Object.entries(pod.metadata.labels ?? {}).filter(([k]) => !VOLATILE.has(k)));
  return Object.keys(out).length ? out : undefined;
}
