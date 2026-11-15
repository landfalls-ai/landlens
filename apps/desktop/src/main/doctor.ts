// The cluster doctor in main (wave 5, D53–D56, D60; docs/doctor.md): one service per connected cluster and scope (a
// namespace, or all), reading as you. Pods come from one shared watch (the Pods table's, when it is open), so the
// Overview no longer lists every pod every 10 seconds; workloads, nodes, warning events and TLS Secrets are read when
// asked and older than their interval. Nothing runs between asks: a scope nobody asked about for 60 seconds stops.
// Secrets are read here only for their certificates' dates and names (certs.ts); no Secret value leaves main.
import type { ClusterHealth, DoctorCheck, DoctorCheckState, DoctorEvidence, DoctorReport, KubeObject } from "@landlens/contracts";
import {
  type CertInput, type ClusterManager, diagnose, healthCounts, KubeError, readCerts, readLogTail, recentWarnings, warningEvents, type WatchHub,
} from "@landlens/kube";

export const DOCTOR = {
  eventsMs: 15_000,
  workloadsMs: 30_000,
  certsMs: 10 * 60_000,
  diagnoseMs: 2_000,
  idleMs: 60_000,
  firstListMs: 20_000,
  scopesPerCluster: 2,
  log: { tailLines: 200, maxBytes: 64 * 1024, timeoutMs: 10_000 },
} as const;

type Status = { status: number; message: string };
type Src<T> = { at: number; value?: T; inflight?: Promise<void> };

class Scope {
  sub?: string;
  ready!: Promise<void>;
  podsError?: Status & { at: number };
  asked = 0;
  idle?: ReturnType<typeof setTimeout>;
  readonly checks: Record<DoctorCheck, DoctorCheckState>;
  readonly workloads: Src<{ deployments?: KubeObject[]; statefulsets?: KubeObject[]; daemonsets?: KubeObject[] }> = { at: 0 };
  readonly nodes: Src<KubeObject[]> = { at: 0 };
  readonly events: Src<KubeObject[]> = { at: 0 };
  readonly certs: Src<{ certs: CertInput[]; ingresses?: KubeObject[] }> = { at: 0 };
  readonly certCache = new Map<string, CertInput>();
  health?: ClusterHealth;
  healthAt = 0;
  constructor(readonly handle: string, readonly namespace: string | undefined) {
    this.checks = { pods: "ok", workloads: "ok", nodes: namespace ? "off" : "ok", events: "ok", certs: "ok" };
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
const stateOf = (e: unknown): DoctorCheckState => {
  const s = (e as { status?: number })?.status;
  return s === 401 || s === 403 ? "forbidden" : "error";
};

export type DoctorDeps = { clusters: ClusterManager; hub: WatchHub; now?: () => number };

export class DoctorService {
  private readonly scopes = new Map<string, Map<string, Scope>>();
  private readonly now: () => number;

  constructor(private readonly deps: DoctorDeps) {
    this.now = deps.now ?? Date.now;
    deps.clusters.onGone((handle) => this.forget(handle));
  }

  /** The Overview's health for a scope: counts and the doctor's problems, from one set of reads. */
  async health(handle: string, namespace?: string): Promise<ClusterHealth> {
    const s = this.scope(handle, namespace);
    await this.pods(s);
    const items = this.deps.hub.items(s.sub!) ?? [];
    const now = this.now();
    if (s.health && now - s.healthAt < DOCTOR.diagnoseMs) return s.health;
    // Certificates can take a while on a big cluster (one read per changed Secret): wait for them at most 3 seconds;
    // the next ask picks them up.
    const certs = this.refreshCerts(s, now);
    await Promise.all([this.refreshWorkloads(s, now), this.refreshNodes(s, now), this.refreshEvents(s, now), Promise.race([certs, delay(3_000)])]);
    const w = s.workloads.value ?? {};
    const report = diagnose({
      pods: items,
      ...(w.deployments ? { deployments: w.deployments } : {}), ...(w.statefulsets ? { statefulsets: w.statefulsets } : {}), ...(w.daemonsets ? { daemonsets: w.daemonsets } : {}),
      ...(s.nodes.value ? { nodes: s.nodes.value } : {}), ...(s.events.value ? { events: s.events.value } : {}),
      ...(s.certs.value ? { certs: s.certs.value.certs, ...(s.certs.value.ingresses ? { ingresses: s.certs.value.ingresses } : {}) } : {}),
      checks: { ...s.checks },
    }, now);
    s.health = {
      ...healthCounts(items, w.deployments, s.nodes.value, now),
      problems: report.problems, cut: report.cut, checks: report.checks, warnings: recentWarnings(s.events.value ?? [], now),
    };
    s.healthAt = now;
    return s.health;
  }

  async report(handle: string, namespace?: string): Promise<DoctorReport> {
    const h = await this.health(handle, namespace);
    return { at: h.at, problems: h.problems, cut: h.cut, checks: h.checks };
  }

  /** Evidence for a problem in the scope's current report only: the window can't name a pod here (D60). */
  async evidence(handle: string, namespace: string | undefined, id: string): Promise<DoctorEvidence> {
    const s = this.scopes.get(handle)?.get(namespace ?? "");
    const p = s?.health?.problems.find((x) => x.id === id);
    if (!s || !p) throw new KubeError(404, "That problem isn't in the current report.");
    this.touch(s);
    const crash = p.class === "crashloop" || p.class === "oom" || p.class === "start" || p.class === "restarts" || (p.class === "probe" && p.facts.probe?.type !== "readiness");
    const pod = p.pods[0];
    if (!crash || !pod || !p.namespace || !p.container) return {};
    const container = p.container.replace(/^init:/, "");
    const client = this.deps.clusters.get(handle).client;
    const read = (previous: boolean) => readLogTail(client, { namespace: p.namespace!, pod, container, previous, tailLines: DOCTOR.log.tailLines }, DOCTOR.log);
    const previous = (p.restarts ?? 0) > 0 && p.class !== "start";
    try {
      return { log: { pod, container, previous, ...(await read(previous)) } };
    } catch (e) {
      // The previous run can be gone (a new pod); the current one is the next best thing.
      if (previous && (e as KubeError).status === 400) {
        try {
          return { log: { pod, container, previous: false, ...(await read(false)) } };
        } catch (e2) {
          e = e2;
        }
      }
      const status = (e as KubeError).status;
      return { log: { error: status === 403 || status === 401 ? "You can't read this pod's logs." : `Couldn't read the log: ${String((e as Error).message).slice(0, 200)}` } };
    }
  }

  /** Certificate facts the person's own read found, for the agent's cluster_overview (D67); undefined if not read. */
  certsFor(handle: string, namespaces?: string[]): CertInput[] | undefined {
    const all = this.scopes.get(handle)?.get("");
    const pick = (s: Scope | undefined) => (s && s.checks.certs === "ok" ? s.certs.value?.certs : undefined);
    if (!namespaces?.length) return pick(all);
    const out: CertInput[] = [];
    for (const ns of namespaces) {
      const certs = pick(this.scopes.get(handle)?.get(ns)) ?? pick(all)?.filter((c) => c.namespace === ns);
      if (!certs) return undefined;
      out.push(...certs.filter((c) => c.namespace === ns));
    }
    return out;
  }

  forget(handle: string) {
    for (const s of this.scopes.get(handle)?.values() ?? []) this.stop(s);
    this.scopes.delete(handle);
  }

  /** How many scopes are running, for tests. */
  get size() {
    let n = 0;
    for (const m of this.scopes.values()) n += m.size;
    return n;
  }

  private scope(handle: string, namespace?: string): Scope {
    this.deps.clusters.get(handle); // throws 404 for a handle that isn't connected
    let m = this.scopes.get(handle);
    if (!m) this.scopes.set(handle, (m = new Map()));
    const k = namespace ?? "";
    let s = m.get(k);
    if (!s) {
      if (m.size >= DOCTOR.scopesPerCluster) {
        const oldest = [...m.values()].sort((a, b) => a.asked - b.asked)[0]!;
        this.stop(oldest);
      }
      s = new Scope(handle, namespace);
      m.set(k, s);
    }
    this.touch(s);
    return s;
  }

  private touch(s: Scope) {
    s.asked = this.now();
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => this.stop(s), DOCTOR.idleMs);
    s.idle.unref?.();
  }

  private stop(s: Scope) {
    if (s.idle) clearTimeout(s.idle);
    if (s.sub) this.deps.hub.unsubscribe(s.sub);
    s.sub = undefined;
    this.scopes.get(s.handle)?.delete(s.namespace ?? "");
  }

  /** The pod watch: started once, waited for once; a failed one is tried again after 30 seconds. */
  private async pods(s: Scope) {
    if (s.podsError && this.now() - s.podsError.at > 30_000 && s.sub) {
      this.deps.hub.unsubscribe(s.sub);
      s.sub = undefined;
      s.podsError = undefined;
    }
    if (!s.sub) {
      let done!: () => void;
      s.ready = new Promise<void>((r) => (done = r));
      s.sub = this.deps.hub.subscribe({ handle: s.handle, group: "", version: "v1", resource: "pods", ...(s.namespace ? { namespace: s.namespace } : {}) }, (e) => {
        if (e.type === "snapshot") (s.podsError = undefined), done();
        else if (e.type === "error") (s.podsError = { status: e.status ?? 500, message: e.message, at: this.now() }), done();
      });
      const timer = setTimeout(() => {
        s.podsError = { status: 504, message: "The pod list didn't arrive in time.", at: this.now() };
        done();
      }, DOCTOR.firstListMs);
      timer.unref?.();
      void s.ready.then(() => clearTimeout(timer));
    }
    await s.ready;
    if (s.podsError) throw new KubeError(s.podsError.status, s.podsError.message);
  }

  private async refresh<T>(src: Src<T>, every: number, now: number, read: () => Promise<T | undefined>) {
    if (src.inflight) return src.inflight;
    if (src.at && now - src.at < every) return;
    src.inflight = (async () => {
      try {
        src.value = await read();
      } finally {
        src.at = this.now();
        src.inflight = undefined;
      }
    })();
    return src.inflight;
  }

  private refreshWorkloads(s: Scope, now: number) {
    const get = this.getter(s.handle);
    const ns = s.namespace ? `/namespaces/${s.namespace}` : "";
    return this.refresh(s.workloads, DOCTOR.workloadsMs, now, async () => {
      let state: DoctorCheckState = "ok";
      const one = (r: string) => get(`/apis/apps/v1${ns}/${r}?limit=2000`).then((l) => {
        if (l?.metadata?.continue && state === "ok") state = "partial";
        return (Array.isArray(l?.items) ? l.items : []) as KubeObject[];
      }, (e) => {
        if (state === "ok" || stateOf(e) === "forbidden") state = stateOf(e);
        return undefined;
      });
      const [deployments, statefulsets, daemonsets] = await Promise.all([one("deployments"), one("statefulsets"), one("daemonsets")]);
      s.checks.workloads = state;
      return { ...(deployments ? { deployments } : {}), ...(statefulsets ? { statefulsets } : {}), ...(daemonsets ? { daemonsets } : {}) };
    });
  }

  private refreshNodes(s: Scope, now: number) {
    if (s.namespace) return Promise.resolve();
    const get = this.getter(s.handle);
    return this.refresh(s.nodes, DOCTOR.workloadsMs, now, () =>
      get("/api/v1/nodes").then((l) => ((s.checks.nodes = "ok"), (l.items ?? []) as KubeObject[]), (e) => ((s.checks.nodes = stateOf(e)), undefined)));
  }

  private refreshEvents(s: Scope, now: number) {
    const get = this.getter(s.handle);
    return this.refresh(s.events, DOCTOR.eventsMs, now, () =>
      warningEvents(get, s.namespace).then((r) => ((s.checks.events = r.partial ? "partial" : "ok"), r.items), (e) => ((s.checks.events = stateOf(e)), undefined)));
  }

  private refreshCerts(s: Scope, now: number) {
    const client = this.deps.clusters.get(s.handle).client;
    const ns = s.namespace ? `/namespaces/${s.namespace}` : "";
    return this.refresh(s.certs, DOCTOR.certsMs, now, async () => {
      try {
        const { certs } = await readCerts(client, s.namespace, s.certCache);
        s.checks.certs = "ok";
        const ingresses = await client.jsonCapped(`/apis/networking.k8s.io/v1${ns}/ingresses?limit=2000`, { maxBytes: 16 * 1048576, timeoutMs: 10_000 })
          .then((l: any) => (l.items ?? []) as KubeObject[], () => undefined);
        return { certs, ...(ingresses ? { ingresses } : {}) };
      } catch (e) {
        s.checks.certs = stateOf(e);
        return undefined;
      }
    });
  }

  /** Lists as you, each answer capped at 32 MB as it streams in and given up after 15 seconds. */
  private getter(handle: string) {
    const client = this.deps.clusters.get(handle).client;
    return (path: string) => client.jsonCapped(path, { maxBytes: 32 * 1048576, timeoutMs: 15_000 });
  }
}
