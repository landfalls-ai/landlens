// Cloud Monitoring as a metrics source for a GKE cluster (wave 9, D180–D182): GKE's system metrics through Google's
// PromQL API, with fixed queries Landlens builds itself. Nothing typed by anyone becomes PromQL: the namespace, pod,
// workload and node are Kubernetes names checked here, and the project, location and cluster come from main's answer
// to "which GKE cluster is this?" (D173), checked again here. Requests, limits and allocatable come from the cluster
// itself, read first, as for Prometheus and metrics-server.
//
// The metrics-scope leak (D181): a PromQL query on project P answers for every project in P's metrics scope, and two
// projects can each hold a cluster of the same name in the same location. So every selector names project_id,
// location and cluster_name, every aggregation keeps them, and the parse keeps a series only when it carries exactly
// this cluster's three values. A series without them is dropped too: an answer that lost them draws nothing, never
// another cluster's line.
import type { GkeRef, MetricLine, MetricsSeries } from "@landlens/contracts";
import { RANGE_MS, type ScopeRequest } from "./clickland-series.js";
import { liveSeries, workloadPods } from "./live-series.js";
import { safeName } from "./prometheus.js";
import type { Get } from "./sampler.js";

/** How main asks Cloud Monitoring one range query for this cluster's project (D179): Google's answer, unread. */
export type PromAsk = (query: string, fromMs: number, toMs: number, stepS: number) => Promise<unknown>;

/** GKE's shapes (packages/gcp's GcpProjectId, GKE_LOCATION and GKE_NAME), checked again before they become PromQL. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z]+-[a-z]+\d+(-[a-z])?$/;
const CLUSTER = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
/** The three labels every selector names and every aggregation keeps (D181). */
const G = "project_id,location,cluster_name";
/** Past this many characters of pod names the query asks for the namespace and the answer is cut to the pods. */
export const POD_REGEX_MAX = 3_000;
const MAX_SERIES = 200;
const MAX_POINTS = 4_000;

/** What an answer that isn't a matrix says. */
export const NOT_METRICS = "Cloud Monitoring's answer didn't look like metrics.";
const bad = (what: string) => Object.assign(new Error(`not ${what}`), { status: 400 });

/** A failure of main's `ask` (Google, or main's own refusal), told apart from a failed read of the cluster. */
export class AskFailed extends Error {}

/**
 * An answer that had series but none carrying this cluster's labels as strings of their shape (review of part 2, L3):
 * Google answering by project number, under another label name, or without them in `sum by`. Said, never drawn as
 * "no samples" or "no system metrics", so metrics-server is next.
 */
export class LabelsLost extends Error {
  constructor(project: string) {
    super(`Cloud Monitoring (${project}) answered without this cluster's labels, so nothing of it is drawn.`);
  }
}

/** The cluster's three values as a selector, after checking each is GKE's shape. */
function selector(c: GkeRef): string {
  if (!PROJECT.test(c.project)) throw bad("a project id");
  if (!LOCATION.test(c.location)) throw bad("a GKE location");
  if (!CLUSTER.test(c.name)) throw bad("a GKE cluster name");
  return `project_id="${c.project}",location="${c.location}",cluster_name="${c.name}"`;
}

/** Seconds between points: about 240 over the range, at least the 60 s GKE samples at (60, 90 and 360 s). */
export const gkeStep = (r: { range: ScopeRequest["range"] }) => Math.max(60, Math.round(RANGE_MS[r.range] / 1000 / 240));

/** Pod names as a PromQL regex: each a Kubernetes name, `.` escaped (`\\.` in the string is `\.` to the regex). */
const podRegex = (pods: string[]) => pods.map((p) => p.replace(/\./g, "\\\\.")).join("|");

/** What a parse keeps besides this cluster's three labels: these keys only, and these labels equal to these values. */
export type GkeWant = { only?: Set<string>; labels?: Record<string, string> };

/**
 * A scope's two queries (and the cluster's per-namespace pair), D180's table exactly. `only` is the set of keys kept
 * from the answer: a workload's pods (always, and the only cut when its names are too long for the query) or the node.
 * `labels` are the scope's own labels the answer must carry (review of part 2, L2): a pod's, a workload's and a
 * namespace's queries keep `namespace_name` (and a pod's `pod_name`) in `by`, so the parse can check them as it checks
 * the cluster's three, and a matcher Google didn't honour can't draw another namespace's pod of the same name.
 */
export function gkeQueries(c: GkeRef, r: ScopeRequest, step: number, pods?: string[]): { label: string; cpu: string; memory: string; nsCpu?: string; nsMemory?: string } & GkeWant {
  const S = selector(c);
  const w = `[${Math.max(300, 2 * step)}s]`;
  for (const n of [r.namespace, r.name, ...(pods ?? [])]) if (n !== undefined && !safeName(n)) throw bad("a Kubernetes name");
  const cpuOf = (by: string, sel: string) => `sum by (${G},${by}) (rate(kubernetes_io:container_cpu_core_usage_time{${sel}}${w}))`;
  const memOf = (by: string, sel: string) => `sum by (${G},${by}) (kubernetes_io:container_memory_used_bytes{${sel},memory_type="non-evictable"})`;
  if (r.scope === "cluster" || r.scope === "node") {
    const sel = r.scope === "node" ? `${S},node_name="${r.name}"` : S;
    return {
      label: "node_name",
      cpu: `sum by (${G},node_name) (rate(kubernetes_io:node_cpu_core_usage_time{${sel}}${w}))`,
      memory: `sum by (${G},node_name) (kubernetes_io:node_memory_used_bytes{${sel},memory_type="non-evictable"})`,
      ...(r.scope === "cluster" ? { nsCpu: cpuOf("namespace_name", S), nsMemory: memOf("namespace_name", S) } : { only: new Set([r.name!]) }),
    };
  }
  const ns = `${S},namespace_name="${r.namespace}"`;
  const inNs = { namespace_name: r.namespace! };
  if (r.scope === "pod") {
    const sel = `${ns},pod_name="${r.name}"`;
    const by = "namespace_name,pod_name,container_name";
    return { label: "container_name", cpu: cpuOf(by, sel), memory: memOf(by, sel), labels: { ...inNs, pod_name: r.name! } };
  }
  if (r.scope === "namespace") return { label: "pod_name", cpu: cpuOf("namespace_name,pod_name", ns), memory: memOf("namespace_name,pod_name", ns), labels: inNs };
  // A workload: its pods by name; past POD_REGEX_MAX the namespace's, cut to these pods.
  const list = pods ?? [];
  const regex = podRegex(list);
  const sel = regex.length > POD_REGEX_MAX ? ns : `${ns},pod_name=~"${regex}"`;
  return { label: "pod_name", cpu: cpuOf("namespace_name,pod_name", sel), memory: memOf("namespace_name,pod_name", sel), only: new Set(list), labels: inNs };
}

/**
 * A matrix answer as lines keyed by `label`, keeping only this cluster's series (D181): `project_id`, `location` and
 * `cluster_name` must be strings equal to the cluster's, and so must the scope's own `labels` (L2). Then the key must be
 * a Kubernetes name, one of `only` when given (applied before the cap, so another workload's pods can't use up the
 * 200: review of part 2, L1), and the values finite. `cut` when more than 200 such series came back (the rest aren't
 * drawn, and the window says so). `unlabelled` counts the series refused because a label was missing, not a string,
 * or (`project_id`) not a project id, as a project number is: told apart from another cluster's series (L3).
 */
export function parseGkeMatrixCut(raw: unknown, c: GkeRef, label: string, want: GkeWant = {}): { lines: MetricLine[]; cut: boolean; total: number; unlabelled: number } {
  const r = raw as { status?: unknown; data?: { resultType?: unknown; result?: unknown } };
  if (r?.status !== "success" || r.data?.resultType !== "matrix" || !Array.isArray(r.data.result)) throw new Error(NOT_METRICS);
  const lines: MetricLine[] = [];
  let cut = false;
  let unlabelled = 0;
  const expected: [string, string][] = [["project_id", c.project], ["location", c.location], ["cluster_name", c.name], ...Object.entries(want.labels ?? {})];
  const result = r.data.result as { metric?: Record<string, unknown>; values?: unknown }[];
  series: for (const s of result) {
    const m = s?.metric;
    if (!m || typeof m !== "object") {
      unlabelled++;
      continue;
    }
    for (const [name, value] of expected) {
      const v = m[name];
      if (typeof v !== "string" || (name === "project_id" && !PROJECT.test(v))) {
        unlabelled++;
        continue series;
      }
      if (v !== value) continue series;
    }
    const key = m[label];
    if (typeof key !== "string" || !safeName(key) || !Array.isArray(s.values)) continue;
    if (want.only && !want.only.has(key)) continue;
    if (lines.length >= MAX_SERIES) {
      cut = true;
      break;
    }
    const points: [number, number][] = [];
    for (const v of s.values.slice(0, MAX_POINTS)) {
      if (!Array.isArray(v)) continue;
      const t = Number(v[0]) * 1000;
      const n = Number(v[1]);
      if (Number.isFinite(t) && Number.isFinite(n)) points.push([t, n]);
    }
    lines.push({ key, points });
  }
  return { lines, cut, total: result.length, unlabelled };
}

export const parseGkeMatrix = (raw: unknown, c: GkeRef, label: string, want: GkeWant = {}): MetricLine[] => parseGkeMatrixCut(raw, c, label, want).lines;

/** The parse, refusing an answer that had series but kept none and lost this cluster's labels on some (L3). */
function parseGke(raw: unknown, c: GkeRef, label: string, want: GkeWant = {}) {
  const p = parseGkeMatrixCut(raw, c, label, want);
  if (p.total > 0 && p.lines.length === 0 && p.unlabelled > 0) throw new LabelsLost(c.project);
  return p;
}

/** What a failed query says in a reason: main's sentence, or one of Landlens's own; never another error's text. */
export const failedSentence = (err: unknown) =>
  err instanceof AskFailed || err instanceof LabelsLost || (err as Error)?.message === NOT_METRICS ? (err as Error).message : "Landlens couldn't read its answer.";

/** What the window says when Cloud Monitoring had more series than Landlens draws. */
export const CUT_REASON = `Cloud Monitoring had more than ${MAX_SERIES} series for this scope; the first ${MAX_SERIES} are drawn.`;

/**
 * A scope's series from Cloud Monitoring. `read` reads the cluster (requests, limits, a workload's pods), first, so a
 * reader who can't list the scope's pods gets nothing from Cloud Monitoring either; `ask` reaches Google, as main.
 */
export async function cloudMonitoringSeries(read: Get, ask: PromAsk, c: GkeRef, r: ScopeRequest, now = Date.now()): Promise<MetricsSeries> {
  for (const n of [r.namespace, r.name]) if (n !== undefined && !safeName(n)) throw bad("a Kubernetes name");
  selector(c);
  const step = gkeStep(r);
  // The reader must be able to list the scope's pods itself (wave 4 part 4, finding 9).
  if (r.scope === "namespace") await read(`/api/v1/namespaces/${r.namespace}/pods?limit=1`);
  if (r.scope === "cluster") await read("/api/v1/pods?limit=1");
  const base = await liveSeries(read, [], r, step, now);
  const pods = r.scope === "deployment" || r.scope === "statefulset" || r.scope === "daemonset" ? (await workloadPods(read, r)).filter(safeName) : undefined;
  const q = gkeQueries(c, r, step, pods);
  const from = now - RANGE_MS[r.range];
  const none = { lines: [] as MetricLine[], cut: false };
  // A workload with no pods has nothing to ask for.
  const empty = pods !== undefined && pods.length === 0;
  const want: GkeWant = { ...(q.only ? { only: q.only } : {}), ...(q.labels ? { labels: q.labels } : {}) };
  const range = async (query: string | undefined, label: string, w: GkeWant) => (query && !empty ? parseGke(await ask(query, from, now, step), c, label, w) : none);
  // Top namespaces fail on their own (review of part 2, L6): the nodes that did answer are still drawn, and it is said.
  const nsRead = q.nsCpu ? Promise.all([range(q.nsCpu, "namespace_name", {}), range(q.nsMemory, "namespace_name", {})]) : undefined;
  nsRead?.catch(() => undefined);
  const [cpu, memory] = await Promise.all([range(q.cpu, q.label, want), range(q.memory, q.label, want)]);
  const reasons: MetricsSeries["reasons"] = [];
  let ns: Awaited<NonNullable<typeof nsRead>> | undefined;
  if (nsRead) {
    try {
      ns = await nsRead;
    } catch (err) {
      reasons.push({ code: "cloud-monitoring-failed", message: `Top namespaces couldn't be read: ${failedSentence(err)}`.slice(0, 300) });
    }
  }
  if ([cpu, memory, ...(ns ?? [])].some((x) => x.cut)) reasons.unshift({ code: "cloud-monitoring-cut", message: CUT_REASON });
  const out: MetricsSeries = {
    ...base,
    source: "cloud-monitoring",
    reasons,
    step,
    from,
    to: now,
    gke: { project: c.project, location: c.location, name: c.name },
    cpu: { ...base.cpu, series: cpu.lines },
    memory: { ...base.memory, series: memory.lines },
  };
  if (ns) out.namespaces = means(ns[0].lines, ns[1].lines);
  else delete out.namespaces;
  return out;
}

/** Whether Cloud Monitoring has any of this cluster's node CPU in the last hour: are system metrics on for it at all? */
export async function gkeHasData(ask: PromAsk, c: GkeRef, now = Date.now()): Promise<boolean> {
  const q = gkeQueries(c, { scope: "cluster", range: "1h" }, 60).cpu;
  const { lines } = parseGke(await ask(q, now - RANGE_MS["1h"], now, 60), c, "node_name");
  return lines.some((l) => l.points.length > 0);
}

const mean = (pts: [number, number][]) => (pts.length ? pts.reduce((a, [, v]) => a + v, 0) / pts.length : 0);
function means(cpu: MetricLine[], memory: MetricLine[]) {
  const by = new Map<string, { key: string; cpu: number; memory: number }>();
  for (const l of cpu) by.set(l.key, { key: l.key, cpu: mean(l.points), memory: 0 });
  for (const l of memory) by.set(l.key, { ...(by.get(l.key) ?? { key: l.key, cpu: 0 }), memory: mean(l.points) });
  return [...by.values()].sort((a, b) => b.cpu - a.cpu);
}

// ---- gcp_metrics: a GKE cluster read from Cloud Monitoring alone (wave 9 part 4, D193) -----------------------------
//
// The agent's gcp_metrics reads a GKE cluster of a project it may read, connected in Landlens or not: there may be no
// cluster to ask for requests, limits or a workload's pods. So it has no workload scopes, and its reference lines are
// Cloud Monitoring's own (the containers' request and limit gauges, the nodes' allocatable), through the same three
// labels, the same `by` and the same parse as the usage. At most six queries a call.

/** The scopes gcp_metrics has: no workload, whose pods only the cluster can list. */
export type GkeOnlyScope = "cluster" | "node" | "namespace" | "pod";
export type GkeOnlyRequest = { scope: GkeOnlyScope; namespace?: string; name?: string; range: ScopeRequest["range"] };
/** The most queries one gcp_metrics call makes (D193). */
export const GKE_ONLY_QUERIES = 6;

/** A container gauge's latest value per container of a pod, through the parse (D181 and the pod's own labels). */
function latestBy(lines: MetricLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const last = l.points.at(-1);
    if (last && Number.isFinite(last[1])) out.set(l.key, last[1]);
  }
  return out;
}

/**
 * A scope of a GKE cluster from Cloud Monitoring only (D193). `ask` reaches Google as main (its 25 s cache, its slot);
 * every query is D180's for the usage and the matching gauges for the references, all through D181's filter. A pod's
 * request is the sum of its containers' latest request; its limit only when every container that has usage has one.
 * A node's or the cluster's allocatable is the sum of the nodes' latest. A reference query that fails leaves its line
 * out and says so in `reasons`; a usage query that fails throws (the caller says it).
 */
export async function gkeProjectSeries(ask: PromAsk, c: GkeRef, r: GkeOnlyRequest, now = Date.now()): Promise<MetricsSeries> {
  if (!["cluster", "node", "namespace", "pod"].includes(r.scope)) throw bad("a scope Cloud Monitoring alone can read");
  if ((r.scope === "pod" || r.scope === "namespace") && !r.namespace) throw bad("a namespace");
  if ((r.scope === "pod" || r.scope === "node") && !r.name) throw bad("a name");
  const req: ScopeRequest = { scope: r.scope, range: r.range, ...(r.scope === "pod" || r.scope === "namespace" ? { namespace: r.namespace! } : {}), ...(r.scope === "pod" || r.scope === "node" ? { name: r.name! } : {}) };
  const step = gkeStep(req);
  const q = gkeQueries(c, req, step);
  const S = selector(c);
  const from = now - RANGE_MS[r.range];
  const want: GkeWant = { ...(q.only ? { only: q.only } : {}), ...(q.labels ? { labels: q.labels } : {}) };
  const range = async (query: string, label: string, w: GkeWant) => parseGke(await ask(query, from, now, step), c, label, w);
  // The reference gauges: the latest point is what counts, so an hour is enough whatever the range.
  const refs: { key: "cpuRequest" | "cpuLimit" | "memRequest" | "memLimit" | "cpuAlloc" | "memAlloc"; query: string; label: string }[] = [];
  if (r.scope === "pod") {
    const sel = `${S},namespace_name="${req.namespace}",pod_name="${req.name}"`;
    const by = `${G},namespace_name,pod_name,container_name`;
    for (const [key, metric] of [["cpuRequest", "container_cpu_request_cores"], ["cpuLimit", "container_cpu_limit_cores"], ["memRequest", "container_memory_request_bytes"], ["memLimit", "container_memory_limit_bytes"]] as const) {
      refs.push({ key, query: `sum by (${by}) (kubernetes_io:${metric}{${sel}})`, label: "container_name" });
    }
  } else if (r.scope === "node" || r.scope === "cluster") {
    const sel = r.scope === "node" ? `${S},node_name="${req.name}"` : S;
    refs.push({ key: "cpuAlloc", query: `sum by (${G},node_name) (kubernetes_io:node_cpu_allocatable_cores{${sel}})`, label: "node_name" });
    refs.push({ key: "memAlloc", query: `sum by (${G},node_name) (kubernetes_io:node_memory_allocatable_bytes{${sel}})`, label: "node_name" });
  }
  const refStep = 60;
  const refFrom = now - RANGE_MS["1h"];
  const refRead = refs.map(async (x) => ({ key: x.key, lines: parseGke(await ask(x.query, refFrom, now, refStep), c, x.label, want).lines }));
  for (const p of refRead) p.catch(() => undefined);
  const [cpu, memory] = await Promise.all([range(q.cpu, q.label, want), range(q.memory, q.label, want)]);
  const reasons: MetricsSeries["reasons"] = [];
  if (cpu.cut || memory.cut) reasons.push({ code: "cloud-monitoring-cut", message: CUT_REASON });
  const got = new Map<string, Map<string, number>>();
  const lost: string[] = [];
  for (const p of refRead) {
    try {
      const { key, lines } = await p;
      got.set(key, latestBy(lines));
    } catch (err) {
      lost.push(failedSentence(err));
    }
  }
  if (lost.length) reasons.push({ code: "cloud-monitoring-failed", message: `${r.scope === "pod" ? "Requests and limits" : "Allocatable"} couldn't all be read: ${lost[0]}`.slice(0, 300) });
  const sum = (m: Map<string, number> | undefined) => (m && m.size ? [...m.values()].reduce((a, b) => a + b, 0) : undefined);
  const containers = new Set([...cpu.lines, ...memory.lines].map((l) => l.key));
  /** A limit only when every container with usage has one (otherwise there is no total limit). */
  const limitOf = (m: Map<string, number> | undefined) => (m && m.size && [...containers].every((k) => m.has(k)) ? sum(m) : undefined);
  const panel = (lines: MetricLine[], o: { request?: number | undefined; limit?: number | undefined; allocatable?: number | undefined }): MetricsSeries["cpu"] => {
    const p: MetricsSeries["cpu"] = { series: lines };
    for (const k of ["request", "limit", "allocatable"] as const) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
    }
    return p;
  };
  return {
    source: "cloud-monitoring",
    reasons,
    step,
    from,
    to: now,
    by: r.scope === "pod" ? "container" : r.scope === "namespace" ? "pod" : "node",
    gke: { project: c.project, location: c.location, name: c.name },
    cpu: panel(cpu.lines, r.scope === "pod" ? { request: sum(got.get("cpuRequest")), limit: limitOf(got.get("cpuLimit")) } : { allocatable: sum(got.get("cpuAlloc")) }),
    memory: panel(memory.lines, r.scope === "pod" ? { request: sum(got.get("memRequest")), limit: limitOf(got.get("memLimit")) } : { allocatable: sum(got.get("memAlloc")) }),
  };
}
