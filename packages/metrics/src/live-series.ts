// A scope's series from metrics-server samples, with requests, limits and allocatable read from the cluster itself.
import type { MetricLine, MetricPanel, MetricsSeries } from "@landlens/contracts";
import { apiPath } from "@landlens/kube";
import { RANGE_MS, type ScopeRequest } from "./clickland-series.js";
import { containerResources, quantity, totals } from "./quantity.js";
import type { Get, Sample, Usage } from "./sampler.js";

const WORKLOADS = { deployment: "deployments", statefulset: "statefulsets", daemonset: "daemonsets" } as const;

export async function liveSeries(get: Get, samples: Sample[], r: ScopeRequest, stepSeconds: number, now = Date.now()): Promise<MetricsSeries> {
  const from = now - RANGE_MS[r.range];
  const shown = samples.filter((s) => s.t >= from);
  const base = { source: "metrics-server" as const, reasons: [], step: stepSeconds, from, to: now };

  if (r.scope === "cluster" || r.scope === "node") {
    const nodes = r.scope === "node" ? [await get(apiPath({ group: "", version: "v1", resource: "nodes" }, undefined, r.name))] : (await get("/api/v1/nodes")).items ?? [];
    const alloc = (k: "cpu" | "memory") => nodes.reduce((a: number, n: any) => a + (quantity(n?.status?.allocatable?.[k]) || 0), 0);
    const pick = (s: Sample) => (r.scope === "node" ? new Map([...s.nodes].filter(([n]) => n === r.name)) : s.nodes);
    const out: MetricsSeries = {
      ...base,
      by: "node",
      cpu: { series: split(shown, pick, "cpu"), allocatable: alloc("cpu") },
      memory: { series: split(shown, pick, "memory"), allocatable: alloc("memory") },
    };
    if (r.scope === "cluster") out.namespaces = namespaceMeans(shown);
    return out;
  }

  const ns = r.namespace!;
  if (r.scope === "pod") {
    const pod = await get(apiPath({ group: "", version: "v1", resource: "pods" }, ns, r.name));
    const key = `${ns}/${r.name}`;
    const pick = (s: Sample) => s.pods.get(key) ?? new Map<string, Usage>();
    return { ...base, by: "container", ...refs(pod?.spec?.containers, shown, pick, true) };
  }

  // A workload or a namespace: one series per pod, summed over its containers.
  let pods: Set<string> | undefined;
  let template: any[] | undefined;
  if (r.scope !== "namespace") {
    const w = await workload(get, r);
    template = w.template;
    pods = new Set(w.pods);
  }
  const pick = (s: Sample) => {
    const out = new Map<string, Usage>();
    for (const [k, containers] of s.pods) {
      const [podNs, name] = k.split("/") as [string, string];
      if (podNs !== ns || (pods && !pods.has(name))) continue;
      out.set(name, sum([...containers.values()]));
    }
    return out;
  };
  return { ...base, by: "pod", ...refs(template, shown, pick, false) };
}

/** A workload's pod template's containers and its pods' names, by its selector's labels. */
async function workload(get: Get, r: ScopeRequest): Promise<{ template?: any[]; pods: string[] }> {
  const w = await get(apiPath({ group: "apps", version: "v1", resource: WORKLOADS[r.scope as keyof typeof WORKLOADS] }, r.namespace, r.name));
  const labels: Record<string, string> = w?.spec?.selector?.matchLabels ?? {};
  const selector = Object.entries(labels).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join(",");
  // No labels would select every pod in the namespace: a workload without matchLabels has none of its own here.
  if (!selector) return { template: w?.spec?.template?.spec?.containers, pods: [] };
  const list = await get(`${apiPath({ group: "", version: "v1", resource: "pods" }, r.namespace)}?labelSelector=${selector}`);
  return { template: w?.spec?.template?.spec?.containers, pods: (list?.items ?? []).map((p: any) => p.metadata.name as string) };
}

/** A workload's pods' names (Prometheus asks for these pods' containers). */
export const workloadPods = async (get: Get, r: ScopeRequest) => (await workload(get, r)).pods;

function refs(containers: any[] | undefined, shown: Sample[], pick: (s: Sample) => Map<string, Usage>, perKey: boolean) {
  const res = containerResources(containers);
  const names = Object.keys(res);
  const panel = (k: "cpu" | "memory"): MetricPanel => {
    const per = Object.fromEntries(names.map((n) => [n, res[n]![k]]));
    return { series: split(shown, pick, k), ...(containers ? totals(per, names) : {}), ...(perKey && containers ? { byKey: per } : {}) };
  };
  return { cpu: panel("cpu"), memory: panel("memory") };
}

/** One line per key of what `pick` returns, in time order. */
function split(samples: Sample[], pick: (s: Sample) => Map<string, Usage>, k: "cpu" | "memory"): MetricLine[] {
  const lines = new Map<string, [number, number][]>();
  for (const s of samples)
    for (const [key, u] of pick(s)) {
      const pts = lines.get(key) ?? [];
      pts.push([s.t, u[k]]);
      lines.set(key, pts);
    }
  return [...lines].map(([key, points]) => ({ key, points }));
}

const sum = (us: Usage[]): Usage => us.reduce((a, u) => ({ cpu: a.cpu + u.cpu, memory: a.memory + u.memory }), { cpu: 0, memory: 0 });

function namespaceMeans(samples: Sample[]) {
  const acc = new Map<string, { key: string; cpu: number; memory: number }>();
  for (const s of samples)
    for (const [k, containers] of s.pods) {
      const ns = k.split("/")[0]!;
      const u = sum([...containers.values()]);
      const a = acc.get(ns) ?? { key: ns, cpu: 0, memory: 0 };
      a.cpu += u.cpu / samples.length;
      a.memory += u.memory / samples.length;
      acc.set(ns, a);
    }
  return [...acc.values()].sort((a, b) => b.cpu - a.cpu);
}
