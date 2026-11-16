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

/**
 * A scope's two queries (and the cluster's per-namespace pair), D180's table exactly. `only` is the set of keys kept
 * from the answer: a workload's pods (always, and the only cut when its names are too long for the query) or the node.
 */
export function gkeQueries(c: GkeRef, r: ScopeRequest, step: number, pods?: string[]): { label: string; cpu: string; memory: string; nsCpu?: string; nsMemory?: string; only?: Set<string> } {
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
  if (r.scope === "pod") {
    const sel = `${ns},pod_name="${r.name}"`;
    return { label: "container_name", cpu: cpuOf("container_name", sel), memory: memOf("container_name", sel) };
  }
  if (r.scope === "namespace") return { label: "pod_name", cpu: cpuOf("pod_name", ns), memory: memOf("pod_name", ns) };
  // A workload: its pods by name; past POD_REGEX_MAX the namespace's, cut to these pods.
  const list = pods ?? [];
  const regex = podRegex(list);
  const sel = regex.length > POD_REGEX_MAX ? ns : `${ns},pod_name=~"${regex}"`;
  return { label: "pod_name", cpu: cpuOf("pod_name", sel), memory: memOf("pod_name", sel), only: new Set(list) };
}

/**
 * A matrix answer as lines keyed by `label`, keeping only this cluster's series (D181): `project_id`, `location` and
 * `cluster_name` must be strings equal to the cluster's. Then the key must be a Kubernetes name and the values finite.
 * `cut` when more than 200 of this cluster's series came back (the rest aren't drawn, and the window says so).
 */
export function parseGkeMatrixCut(raw: unknown, c: GkeRef, label: string): { lines: MetricLine[]; cut: boolean } {
  const r = raw as { status?: unknown; data?: { resultType?: unknown; result?: unknown } };
  if (r?.status !== "success" || r.data?.resultType !== "matrix" || !Array.isArray(r.data.result)) throw new Error(NOT_METRICS);
  const lines: MetricLine[] = [];
  let cut = false;
  for (const s of r.data.result as { metric?: Record<string, unknown>; values?: unknown }[]) {
    const m = s?.metric;
    if (!m || typeof m !== "object") continue;
    if (m.project_id !== c.project || m.location !== c.location || m.cluster_name !== c.name) continue;
    const key = m[label];
    if (typeof key !== "string" || !safeName(key) || !Array.isArray(s.values)) continue;
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
  return { lines, cut };
}

export const parseGkeMatrix = (raw: unknown, c: GkeRef, label: string): MetricLine[] => parseGkeMatrixCut(raw, c, label).lines;

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
  const range = async (query: string | undefined, label: string) => (query && !empty ? parseGkeMatrixCut(await ask(query, from, now, step), c, label) : none);
  const [cpu, memory, nsCpu, nsMemory] = await Promise.all([
    range(q.cpu, q.label),
    range(q.memory, q.label),
    range(q.nsCpu, "namespace_name"),
    range(q.nsMemory, "namespace_name"),
  ]);
  const only = (ls: MetricLine[]) => (q.only ? ls.filter((l) => q.only!.has(l.key)) : ls);
  const out: MetricsSeries = {
    ...base,
    source: "cloud-monitoring",
    reasons: [cpu, memory, nsCpu, nsMemory].some((x) => x.cut) ? [{ code: "cloud-monitoring-cut", message: CUT_REASON }] : [],
    step,
    from,
    to: now,
    gke: { project: c.project, location: c.location, name: c.name },
    cpu: { ...base.cpu, series: only(cpu.lines) },
    memory: { ...base.memory, series: only(memory.lines) },
  };
  if (q.nsCpu) out.namespaces = means(nsCpu.lines, nsMemory.lines);
  return out;
}

/** Whether Cloud Monitoring has any of this cluster's node CPU in the last hour: are system metrics on for it at all? */
export async function gkeHasData(ask: PromAsk, c: GkeRef, now = Date.now()): Promise<boolean> {
  const q = gkeQueries(c, { scope: "cluster", range: "1h" }, 60).cpu;
  const lines = parseGkeMatrix(await ask(q, now - RANGE_MS["1h"], now, 60), c, "node_name");
  return lines.some((l) => l.points.length > 0);
}

const mean = (pts: [number, number][]) => (pts.length ? pts.reduce((a, [, v]) => a + v, 0) / pts.length : 0);
function means(cpu: MetricLine[], memory: MetricLine[]) {
  const by = new Map<string, { key: string; cpu: number; memory: number }>();
  for (const l of cpu) by.set(l.key, { key: l.key, cpu: mean(l.points), memory: 0 });
  for (const l of memory) by.set(l.key, { ...(by.get(l.key) ?? { key: l.key, cpu: 0 }), memory: mean(l.points) });
  return [...by.values()].sort((a, b) => b.cpu - a.cpu);
}
