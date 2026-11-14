// A Landlens scope as Clickland queries: kubelet stats and cluster state, stored under service `kubernetes` every 30 s,
// filtered with `where` (Clickland specs/001) on the cluster's `k8s.cluster.name` and the scope's attributes.
import type { MetricLine, MetricPanel, MetricsRange, MetricsScope, MetricsSeries } from "@landlens/contracts";
import { ClicklandError, type ClicklandClient, type ClicklandQuery, type ClicklandSeries } from "./clickland.js";
import { strip, totals } from "./quantity.js";

export const RANGE_MS: Record<MetricsRange, number> = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000 };
const WORKLOAD_ATTR = { deployment: "k8s.deployment.name", statefulset: "k8s.statefulset.name", daemonset: "k8s.daemonset.name" } as const;

export type ScopeRequest = { scope: MetricsScope; namespace?: string; name?: string; range: MetricsRange };

/** Which metrics answer a scope, and how its series split. */
export function plan(cluster: string, r: ScopeRequest) {
  const where: Record<string, string> = { "k8s.cluster.name": cluster };
  if (r.namespace && r.scope !== "cluster" && r.scope !== "node") where["k8s.namespace.name"] = r.namespace;
  if (r.scope === "cluster" || r.scope === "node") {
    if (r.scope === "node") where["k8s.node.name"] = r.name!;
    return {
      by: "node" as const,
      where,
      usage: { cpu: "k8s.node.cpu.usage", memory: "k8s.node.memory.working_set", groupBy: "k8s.node.name" },
      allocatable: true,
      refs: false,
      namespaces: r.scope === "cluster",
    };
  }
  if (r.scope === "pod") where["k8s.pod.name"] = r.name!;
  else if (r.scope !== "namespace") where[WORKLOAD_ATTR[r.scope]] = r.name!;
  const pod = r.scope === "pod";
  return {
    by: pod ? ("container" as const) : ("pod" as const),
    where,
    usage: pod
      ? { cpu: "container.cpu.usage", memory: "container.memory.working_set", groupBy: "k8s.container.name" }
      : { cpu: "k8s.pod.cpu.usage", memory: "k8s.pod.memory.working_set", groupBy: "k8s.pod.name" },
    allocatable: false,
    refs: r.scope !== "namespace",
    namespaces: false,
  };
}

export async function clicklandSeries(client: ClicklandClient, cluster: string, r: ScopeRequest, now = Date.now()): Promise<MetricsSeries> {
  const to = now;
  const from = now - RANGE_MS[r.range];
  const p = plan(cluster, r);
  const q = (metric: string, groupBy: string, where = p.where): Promise<ClicklandSeries> =>
    client.query({ metric, type: "gauge", aggregation: "avg", from: iso(from), to: iso(to), service: "kubernetes", groupBy, where });
  const byContainer = "k8s.container.name";
  const [cpu, memory, allocCpu, allocMem, nsCpu, nsMem, reqCpu, limCpu, reqMem, limMem, containers] = await Promise.all([
    q(p.usage.cpu, p.usage.groupBy),
    q(p.usage.memory, p.usage.groupBy),
    p.allocatable ? q("k8s.node.allocatable_cpu", "k8s.node.name") : undefined,
    p.allocatable ? q("k8s.node.allocatable_memory", "k8s.node.name") : undefined,
    p.namespaces ? q("k8s.pod.cpu.usage", "k8s.namespace.name") : undefined,
    p.namespaces ? q("k8s.pod.memory.working_set", "k8s.namespace.name") : undefined,
    ...(p.refs
      ? ["k8s.container.cpu_request", "k8s.container.cpu_limit", "k8s.container.memory_request", "k8s.container.memory_limit", "k8s.container.restarts"].map((m) =>
          q(m, byContainer),
        )
      : [undefined, undefined, undefined, undefined, undefined]),
  ]);
  if (r.scope === "cluster" && !cpu.series.length && !memory.series.length)
    throw new ClicklandError("no-cluster", `Clickland has no node samples for k8s.cluster.name “${cluster}” in the last ${r.range}.`);

  // Every container the cluster state knows, so a container without a limit means "no total limit".
  const names = [...new Set([...keys(containers), ...keys(reqCpu), ...keys(limCpu), ...keys(reqMem), ...keys(limMem)])];
  const panel = (usage: ClicklandSeries, req?: ClicklandSeries, lim?: ClicklandSeries, alloc?: ClicklandSeries): MetricPanel => {
    const panel: MetricPanel = { series: lines(usage) };
    if (alloc) {
      const total = sumLatest(alloc);
      if (total !== undefined) panel.allocatable = total;
    }
    if (req || lim) {
      const per: Record<string, { request?: number; limit?: number }> = {};
      for (const c of names) per[c] = strip({ request: latest(req, c), limit: latest(lim, c) });
      Object.assign(panel, totals(per, names));
      if (p.by === "container") panel.byKey = per;
    }
    return panel;
  };
  const out: MetricsSeries = {
    source: "clickland",
    reasons: [],
    step: cpu.bucketSeconds || memory.bucketSeconds || 30,
    from,
    to,
    by: p.by,
    cluster,
    cpu: panel(cpu, reqCpu, limCpu, allocCpu),
    memory: panel(memory, reqMem, limMem, allocMem),
  };
  if (nsCpu && nsMem) out.namespaces = namespaceMeans(nsCpu, nsMem);
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();
const keys = (s?: ClicklandSeries) => (s ? s.series.map((x) => x.key).filter((k) => k && k !== "other") : []);
const lines = (s: ClicklandSeries): MetricLine[] =>
  s.series.filter((x) => x.key !== "").map((x) => ({ key: x.key, points: x.points.map(([t, v]) => [Date.parse(t), v] as [number, number]) }));
function latest(s: ClicklandSeries | undefined, key: string): number | undefined {
  const pts = s?.series.find((x) => x.key === key)?.points;
  return pts?.length ? pts[pts.length - 1]![1] : undefined;
}
function sumLatest(s: ClicklandSeries): number | undefined {
  const vals = s.series.map((x) => x.points.at(-1)?.[1]).filter((v): v is number => v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
}
const mean = (pts: [string, number][]) => (pts.length ? pts.reduce((a, [, v]) => a + v, 0) / pts.length : 0);

/** Each namespace's mean usage over the range, largest CPU first ("other" folds Clickland's tail and goes last). */
export function namespaceMeans(cpu: ClicklandSeries, memory: ClicklandSeries) {
  const by = new Map<string, { key: string; cpu: number; memory: number }>();
  for (const s of cpu.series) if (s.key) by.set(s.key, { key: s.key, cpu: mean(s.points), memory: 0 });
  for (const s of memory.series) if (s.key) by.set(s.key, { ...(by.get(s.key) ?? { key: s.key, cpu: 0 }), memory: mean(s.points) });
  return [...by.values()].sort((a, b) => (a.key === "other" ? 1 : b.key === "other" ? -1 : b.cpu - a.cpu));
}
