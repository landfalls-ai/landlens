// The cluster doctor in main (wave 5, D53–D56, D60; docs/doctor.md): one service per connected cluster and scope (a
// namespace, or all), reading as you. Pods come from one shared watch (the Pods table's, when it is open), so the
// Overview no longer lists every pod every 10 seconds; workloads, nodes, warning events and TLS Secrets are read when
// asked and older than their interval. Nothing runs between asks: a scope nobody asked about for 60 seconds stops.
// Secrets are read here only for their certificates' dates and names (certs.ts); no Secret value leaves main.
import type { ClusterHealth, DoctorCheck, DoctorCheckState, DoctorEvidence, DoctorReport, KubeObject, Problem } from "@landlens/contracts";
import {
  type CertInput, type ClusterManager, diagnose, healthCounts, KubeError, LIST_MAX, listPages, logsGone, readCerts, readLogTail, recentWarnings, warningEvents,
  type WatchHub,
} from "@landlens/kube";

export const DOCTOR = {
  eventsMs: 15_000,
  workloadsMs: 30_000,
  certsMs: 10 * 60_000,
  diagnoseMs: 2_000,
  idleMs: 60_000,
  firstListMs: 20_000,
  scopesPerCluster: 2,
  /** A source that failed (not forbidden, not cut) is read again after this, not after its full interval. */
  retryMs: 30_000,
  log: { tailLines: 200, maxBytes: 64 * 1024, readBytes: 1048576, timeoutMs: 10_000, pods: 3, totalMs: 20_000 },
  /** Log reads in flight per scope (one per problem). */
  evidencePerScope: 4,
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
  /** Log reads in flight, by problem id. */
  readonly evidence = new Map<string, Promise<DoctorEvidence>>();
  /** Aborted when the scope stops, so its reads stop too. */
  readonly stopped = new AbortController();
  health?: ClusterHealth;
  healthAt = 0;
  constructor(readonly handle: string, readonly namespace: string | undefined) {
    // Certificates are "pending" until their first read finishes: never "ok" before anything was read (review, 2).
    this.checks = { pods: "ok", workloads: "ok", nodes: namespace ? "off" : "ok", events: "ok", certs: "pending" };
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
const stateOf = (e: unknown): DoctorCheckState => {
  const s = (e as { status?: number })?.status;
  return s === 401 || s === 403 ? "forbidden" : "error";
};

export type DoctorDeps = {
  clusters: ClusterManager;
  hub: WatchHub;
  now?: () => number;
  /**
   * Clickland's last lines of a pod's container (wave 7 D118), for when the kubelet has neither run; undefined when
   * Clickland isn't connected or has none. Bodies come scrubbed (clickland-history.ts).
   */
  history?: (handle: string, q: { namespace: string; pods: string[]; container: string }) => Promise<{ pod: string; lines: string[]; cut: boolean; newest?: string } | undefined>;
};

export class DoctorService {
  private readonly scopes = new Map<string, Map<string, Scope>>();
  /** Certificate facts by Secret version, per cluster: shared by its scopes, dropped when it disconnects. */
  private readonly certCaches = new Map<string, Map<string, CertInput>>();
  private readonly now: () => number;

  constructor(private readonly deps: DoctorDeps) {
    this.now = deps.now ?? Date.now;
    deps.clusters.onGone((handle) => this.forget(handle));
  }

  /** The Overview's health for a scope: counts and the doctor's problems, from one set of reads. */
  async health(handle: string, namespace?: string): Promise<ClusterHealth> {
    const s = this.scope(handle, namespace);
    await this.pods(s);
    const items = s.sub ? this.deps.hub.items(s.sub) : undefined;
    if (!items) {
      // The watch went away under us (the cluster is disconnecting): not "no pods, all clear" (review, finding 8).
      s.sub = undefined;
      throw new KubeError(503, "The pod watch stopped; ask again in a moment.");
    }
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

  /**
   * Evidence for a problem in the scope's current report only: the window can't name a pod here (D60). One read per
   * problem at a time and at most four per scope; errors are fixed sentences, never the API's text (review, 6).
   */
  async evidence(handle: string, namespace: string | undefined, id: string): Promise<DoctorEvidence> {
    const s = this.scopes.get(handle)?.get(namespace ?? "");
    const p = s?.health?.problems.find((x) => x.id === id);
    if (!s || !p) throw new KubeError(404, "That problem isn't in the current report.");
    const had = s.evidence.get(id);
    if (had) return had;
    if (s.evidence.size >= DOCTOR.evidencePerScope) throw new KubeError(429, "Too many log reads at once; try again in a moment.");
    const run = this.readEvidence(handle, p, s.stopped.signal).finally(() => s.evidence.delete(id));
    s.evidence.set(id, run);
    return run;
  }

  /**
   * A problem in the scope's current report, as main holds it (wave 7 D126): what a send to triage or a flow is built
   * from. The window names it by id only; one that isn't in the report is refused.
   */
  problem(handle: string, namespace: string | undefined, id: string): Problem {
    const p = this.scopes.get(handle)?.get(namespace ?? "")?.health?.problems.find((x) => x.id === id);
    if (!p) throw new KubeError(404, "That problem isn't in the current report.");
    return p;
  }

  /**
   * Whether the scope reports of this cluster name the object (D117): a problem's subject, or one of its pods. Clickland's
   * history may be asked about such an object even when it is gone from the cluster.
   */
  knows(handle: string, o: { kind: "pod" | "deployment" | "statefulset" | "daemonset"; namespace: string; name: string }): boolean {
    const kind = { pod: "Pod", deployment: "Deployment", statefulset: "StatefulSet", daemonset: "DaemonSet" }[o.kind];
    for (const s of this.scopes.get(handle)?.values() ?? []) {
      for (const p of s.health?.problems ?? []) {
        if (p.namespace !== o.namespace) continue;
        if (p.kind === kind && p.name === o.name) return true;
        if (o.kind === "pod" && p.pods.includes(o.name)) return true;
      }
    }
    return false;
  }

  /**
   * Whether the newest reports of this cluster hold a problem about the object (its kind, namespace and name, and the
   * class when given): telemetry keeps a doctor brief's subject only then (security review of part 5, L1).
   */
  reports(handle: string, o: { kind?: string; namespace?: string; name?: string }, cls?: string): boolean {
    if (!o.kind || !o.name) return false;
    for (const s of this.scopes.get(handle)?.values() ?? []) {
      for (const p of s.health?.problems ?? []) {
        if (p.kind === o.kind && p.name === o.name && (p.namespace ?? undefined) === (o.namespace ?? undefined) && (!cls || p.class === cls)) return true;
      }
    }
    return false;
  }

  private async readEvidence(handle: string, p: Problem, stopped: AbortSignal): Promise<DoctorEvidence> {
    const ev = await this.readKubelet(handle, p, stopped);
    const log = ev.log;
    // The kubelet had neither run (the pods or their containers are gone): Clickland's history, if it has the lines.
    if (!log || !("error" in log) || !GONE.has(log.error) || !this.deps.history || !p.namespace || !p.container) return ev;
    const container = p.container.replace(/^init:/, "");
    const got = await this.deps.history(handle, { namespace: p.namespace, pods: p.pods.slice(0, DOCTOR.log.pods), container }).catch(() => undefined);
    if (!got || stopped.aborted) return ev;
    return { log: { pod: got.pod, container, previous: false, lines: got.lines.slice(-DOCTOR.log.tailLines), cut: got.cut || got.lines.length > DOCTOR.log.tailLines, source: "clickland", ...(got.newest ? { newest: got.newest } : {}) } };
  }

  private async readKubelet(handle: string, p: Problem, stopped: AbortSignal): Promise<DoctorEvidence> {
    const crash = p.class === "crashloop" || p.class === "oom" || p.class === "start" || p.class === "restarts" || (p.class === "probe" && p.facts.probe?.type !== "readiness");
    if (!crash || !p.pods.length || !p.namespace || !p.container) return {};
    const container = p.container.replace(/^init:/, "");
    const client = this.deps.clusters.get(handle).client;
    // All reads for one problem share a 20 s deadline and stop with the scope (review of part 4, L4).
    const signal = AbortSignal.any([AbortSignal.timeout(DOCTOR.log.totalMs), stopped]);
    const read = (pod: string, previous: boolean) => readLogTail(client, { namespace: p.namespace!, pod, container, previous, tailLines: DOCTOR.log.tailLines }, { ...DOCTOR.log, signal });
    const wantPrevious = (p.restarts ?? 0) > 0 && p.class !== "start";
    let error: unknown;
    // The previous run can be gone (a new pod: 400; a removed container: the kubelet's sentence), so the current run
    // is the next best thing, then the next pod: at most three pods, one read at a time.
    for (const pod of p.pods.slice(0, DOCTOR.log.pods)) {
      for (const previous of wantPrevious ? [true, false] : [false]) {
        try {
          const tail = await read(pod, previous);
          if (logsGone(tail.lines)) continue;
          return { log: { pod, container, previous, ...tail } };
        } catch (e) {
          error = e;
          const status = (e as KubeError).status;
          if (signal.aborted) return { log: { error: logError(e) } };
          if (previous && status === 400) continue; // no previous run: the current one
          if (status === 404 || status === 400) break; // this pod went, or has no log yet: the next
          return { log: { error: logError(e) } };
        }
      }
    }
    return { log: error ? { error: logError(error) } : { error: "The pod or its container is gone." } };
  }

  /**
   * Certificate facts the person's own read found, for the agent's cluster_overview (D67), with how far that read got.
   * `namespaces` undefined is every namespace (the all-namespaces scope only); an empty list is none (review, 10).
   * A scope still reading is `pending`; no scope covering the namespaces is `skipped` (the person's window shows
   * another namespace); never "no certificates".
   */
  certsFor(handle: string, namespaces?: string[]): { state: DoctorCheckState; certs?: CertInput[] } {
    const scopes = this.scopes.get(handle);
    const all = scopes?.get("");
    // No value yet is the scope's own state: `pending` before the first read, `forbidden` or `error` after a failed
    // one (review of part 4, M2). Of the namespace's scope and the all-namespaces scope, one with facts wins (L3).
    const covering = (s: Scope | undefined): { state: DoctorCheckState; certs?: CertInput[] } | undefined =>
      !s ? undefined : s.certs.value ? { state: s.checks.certs, certs: s.certs.value.certs } : { state: s.checks.certs === "ok" || s.checks.certs === "partial" ? "pending" : s.checks.certs };
    const best = (a?: ReturnType<typeof covering>, b?: ReturnType<typeof covering>) => (a?.certs ? a : b?.certs ? b : a ?? b);
    if (!namespaces) return covering(all) ?? { state: "skipped" };
    const out: CertInput[] = [];
    let state: DoctorCheckState = "ok";
    for (const ns of namespaces) {
      const got = best(covering(scopes?.get(ns)), covering(all));
      if (!got) return { state: "skipped" };
      if (!got.certs) return { state: got.state };
      if (got.state !== "ok") state = got.state;
      out.push(...got.certs.filter((c) => c.namespace === ns));
    }
    return { state, certs: out };
  }

  /**
   * The doctor's problems now, counted per cluster, class and tone (Landlens's telemetry gauge, wave 7 D129): from each
   * cluster's newest report (the whole cluster's when it has one, else its namespaces' added up, each problem once).
   * Counts only; no problem's name or text.
   */
  problemCounts(): { handle: string; class: string; tone: string; n: number }[] {
    const out: { handle: string; class: string; tone: string; n: number }[] = [];
    for (const [handle, m] of this.scopes) {
      const whole = m.get("")?.health;
      const reports = whole ? [whole] : [...m.values()].flatMap((s) => (s.health ? [s.health] : []));
      const seen = new Set<string>();
      const counts = new Map<string, number>();
      for (const r of reports) for (const p of r.problems) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        counts.set(`${p.class} ${p.tone}`, (counts.get(`${p.class} ${p.tone}`) ?? 0) + 1);
      }
      for (const [k, n] of counts) {
        const [cls, tone] = k.split(" ") as [string, string];
        out.push({ handle, class: cls, tone, n });
      }
    }
    return out;
  }

  forget(handle: string) {
    for (const s of this.scopes.get(handle)?.values() ?? []) this.stop(s);
    this.scopes.delete(handle);
    this.certCaches.delete(handle);
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
    s.stopped.abort();
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
        // Only a fatal error (no access, no such kind) fails the doctor; the watcher retries the rest and its last
        // snapshot stays good meanwhile (review, finding 8). The first list still has its 20-second limit.
        else if (e.type === "error" && (e as { fatal?: boolean }).fatal !== false) (s.podsError = { status: e.status ?? 500, message: e.message, at: this.now() }), done();
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

  /** Reads a source when it is older than `every`; after an error (not forbidden, not cut), again after 30 seconds. */
  private async refresh<T>(s: Scope, check: DoctorCheck, src: Src<T>, every: number, now: number, read: () => Promise<T | undefined>) {
    if (src.inflight) return src.inflight;
    if (src.at && now - src.at < every) return;
    src.inflight = (async () => {
      try {
        src.value = await read();
      } finally {
        src.at = s.checks[check] === "error" ? this.now() - every + DOCTOR.retryMs : this.now();
        src.inflight = undefined;
      }
    })();
    return src.inflight;
  }

  private refreshWorkloads(s: Scope, now: number) {
    const get = this.getter(s.handle);
    const ns = s.namespace ? `/namespaces/${s.namespace}` : "";
    return this.refresh(s, "workloads", s.workloads, DOCTOR.workloadsMs, now, async () => {
      let state: DoctorCheckState = "ok";
      const one = (r: string) => listPages(get, `/apis/apps/v1${ns}/${r}`, LIST_MAX.workloads).then((l) => {
        if (l.partial && state === "ok") state = "partial";
        return l.items;
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
    return this.refresh(s, "nodes", s.nodes, DOCTOR.workloadsMs, now, () =>
      listPages(get, "/api/v1/nodes", LIST_MAX.nodes).then((l) => ((s.checks.nodes = l.partial ? "partial" : "ok"), l.items), (e) => ((s.checks.nodes = stateOf(e)), undefined)));
  }

  private refreshEvents(s: Scope, now: number) {
    const get = this.getter(s.handle);
    return this.refresh(s, "events", s.events, DOCTOR.eventsMs, now, () =>
      warningEvents(get, s.namespace).then((r) => ((s.checks.events = r.partial ? "partial" : "ok"), r.items), (e) => ((s.checks.events = stateOf(e)), undefined)));
  }

  private refreshCerts(s: Scope, now: number) {
    const client = this.deps.clusters.get(s.handle).client;
    const ns = s.namespace ? `/namespaces/${s.namespace}` : "";
    let cache = this.certCaches.get(s.handle);
    if (!cache) this.certCaches.set(s.handle, (cache = new Map()));
    return this.refresh(s, "certs", s.certs, DOCTOR.certsMs, now, async () => {
      try {
        const { certs, cut, failed } = await readCerts(client, s.namespace, cache, { signal: s.stopped.signal });
        // More than 500 Secrets, or some left out (403, 429, a timeout): said, not "ok" (review, finding 2).
        s.checks.certs = cut || failed ? "partial" : "ok";
        const ingresses = await client.jsonCapped(`/apis/networking.k8s.io/v1${ns}/ingresses?limit=2000`, { maxBytes: 16 * 1048576, timeoutMs: 10_000 })
          .then((l: any) => (l.items ?? []) as KubeObject[], () => undefined);
        return { certs, ...(ingresses ? { ingresses } : {}) };
      } catch (e) {
        s.checks.certs = stateOf(e);
        return undefined;
      }
    });
  }

  /** Lists as you, a page at a time; each answer capped at 32 MB as it streams in and given up after 15 seconds. */
  private getter(handle: string) {
    const client = this.deps.clusters.get(handle).client;
    return (path: string) => client.jsonCapped(path, { maxBytes: 32 * 1048576, timeoutMs: 15_000 });
  }
}

/** The kubelet's answers that mean neither run is there to read: when Clickland may have the lines (D118). */
const GONE = new Set(["The pod or its container is gone.", "This container has no log to read yet."]);

/** A log read's failure as a fixed sentence: the API's own text doesn't reach the window (review, finding 6). */
function logError(e: unknown): string {
  const status = (e as KubeError)?.status;
  if (status === 401 || status === 403) return "You can't read this pod's logs.";
  if (status === 404) return "The pod or its container is gone.";
  if (status === 400) return "This container has no log to read yet.";
  if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") return "The log didn't arrive in time.";
  return status ? `Couldn't read the log (HTTP ${status}).` : "Couldn't read the log.";
}
