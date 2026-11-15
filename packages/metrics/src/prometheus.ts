// Prometheus as a metrics source (wave 4, part 4; plan: "Prometheus if found"): found the way OpenLens finds it (a
// Helm chart's server, the operator's governing Service, well-known names), asked through the API server's service
// proxy as you, with fixed cAdvisor queries Landlens builds itself. Nothing typed by anyone becomes PromQL: names are
// Kubernetes names, checked again here, and quoted. Requests, limits and allocatable come from the cluster, as for
// metrics-server.
import type { MetricLine, MetricsSeries } from "@landlens/contracts";
import { RANGE_MS, type ScopeRequest } from "./clickland-series.js";
import { liveSeries, workloadPods } from "./live-series.js";
import type { Get } from "./sampler.js";

export type PrometheusTarget = { namespace: string; service: string; port: string; scheme: "http" | "https"; provider: string };

/** Where OpenLens and Freelens look (docs/research/lens-features.md), in order. */
const BY_LABEL: { provider: string; selector: string }[] = [
  { provider: "helm", selector: "app=prometheus,component=server" },
  { provider: "helm", selector: "app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server" },
  { provider: "operator", selector: "operated-prometheus=true" },
];
const BY_NAME: { provider: string; namespace: string; service: string }[] = [
  { provider: "lens", namespace: "lens-metrics", service: "prometheus" },
  { provider: "openshift", namespace: "openshift-monitoring", service: "prometheus-k8s" },
  { provider: "kube-prometheus", namespace: "monitoring", service: "prometheus-k8s" },
  { provider: "stacklight", namespace: "stacklight", service: "prometheus-server" },
];

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
/** A label value Landlens puts in a query: a Kubernetes name, nothing that could close the quotes. */
export const safeName = (s: string) => NAME.test(s);

type Svc = { metadata?: { name?: string; namespace?: string }; spec?: { ports?: { name?: string; port?: number }[] } };
function targetOf(s: Svc, provider: string): PrometheusTarget | undefined {
  const name = s.metadata?.name;
  const namespace = s.metadata?.namespace;
  if (!name || !namespace || !safeName(name) || !safeName(namespace)) return undefined;
  const ports = s.spec?.ports ?? [];
  const p = ports.find((x) => x.name === "web" || x.name === "http" || x.name === "http-web") ?? ports.find((x) => x.port === 9090) ?? ports[0];
  if (!p?.port) return undefined;
  return { namespace, service: name, port: String(p.port), scheme: p.name === "https" ? "https" : "http", provider };
}

/** The first Prometheus the cluster has, or undefined; services you can't list are skipped. */
export async function findPrometheus(get: Get): Promise<PrometheusTarget | undefined> {
  for (const l of BY_LABEL) {
    try {
      const list = await get(`/api/v1/services?labelSelector=${encodeURIComponent(l.selector)}&limit=5`);
      for (const s of (list?.items ?? []) as Svc[]) {
        const t = targetOf(s, l.provider);
        if (t) return t;
      }
    } catch {
      /* not allowed to list services across namespaces: try the names */
    }
  }
  for (const n of BY_NAME) {
    try {
      const s = await get(`/api/v1/namespaces/${n.namespace}/services/${n.service}`);
      const t = targetOf(s, n.provider);
      if (t) return t;
    } catch {
      /* not there */
    }
  }
  return undefined;
}

/** The API path of a range query through the service proxy. */
export function queryPath(t: PrometheusTarget, query: string, from: number, to: number, step: number): string {
  const q = new URLSearchParams({ query, start: String(from / 1000), end: String(to / 1000), step: String(step) });
  return `/api/v1/namespaces/${t.namespace}/services/${t.scheme}:${t.service}:${t.port}/proxy/api/v1/query_range?${q}`;
}

const MAX_SERIES = 200;
const MAX_POINTS = 4000;
/** A matrix answer as lines keyed by `label`; anything else, or a key that isn't a name, is refused or dropped. */
export function parseMatrix(raw: unknown, label: string): MetricLine[] {
  const r = raw as { status?: unknown; data?: { resultType?: unknown; result?: unknown } };
  if (r?.status !== "success" || r.data?.resultType !== "matrix" || !Array.isArray(r.data.result)) throw new Error("Prometheus's answer didn't look like metrics.");
  const out: MetricLine[] = [];
  for (const s of r.data.result.slice(0, MAX_SERIES) as { metric?: Record<string, unknown>; values?: unknown }[]) {
    const key = s?.metric?.[label];
    if (typeof key !== "string" || !safeName(key) || !Array.isArray(s.values)) continue;
    const points: [number, number][] = [];
    for (const v of s.values.slice(0, MAX_POINTS)) {
      if (!Array.isArray(v)) continue;
      const t = Number(v[0]) * 1000;
      const n = Number(v[1]);
      if (Number.isFinite(t) && Number.isFinite(n)) points.push([t, n]);
    }
    out.push({ key, points });
  }
  return out;
}

/** The queries for a scope: one series per container (pod), per pod (workload, namespace) or per node. */
export function queries(r: ScopeRequest, step: number, pods?: string[]) {
  const w = `${Math.max(300, step * 2)}s`;
  const containers = 'container!="",container!="POD"';
  if (r.scope === "cluster" || r.scope === "node") {
    // The root cgroup is a node's total; Helm's chart names nodes by kubernetes_io_hostname, kube-prometheus by node.
    // A node's own series is picked from the answer, since which label names it varies.
    const named = (m: string) => `label_replace(${m}, "node", "$1", "kubernetes_io_hostname", "(.+)")`;
    return {
      label: "node",
      cpu: `sum by (node) (${named(`rate(container_cpu_usage_seconds_total{id="/"}[${w}])`)})`,
      memory: `sum by (node) (${named('container_memory_working_set_bytes{id="/"}')})`,
      nodeFilter: r.scope === "node" ? r.name : undefined,
      nsCpu: r.scope === "cluster" ? `sum by (namespace) (rate(container_cpu_usage_seconds_total{${containers}}[${w}]))` : undefined,
      nsMemory: r.scope === "cluster" ? `sum by (namespace) (container_memory_working_set_bytes{${containers}})` : undefined,
    };
  }
  const ns = `namespace="${r.namespace}"`;
  if (r.scope === "pod") {
    const sel = `${ns},pod="${r.name}",${containers}`;
    return { label: "container", cpu: `sum by (container) (rate(container_cpu_usage_seconds_total{${sel}}[${w}]))`, memory: `sum by (container) (container_memory_working_set_bytes{${sel}})` };
  }
  const podSel = r.scope === "namespace" ? "" : `,pod=~"${(pods ?? []).join("|") || "^$"}"`;
  const sel = `${ns}${podSel},${containers}`;
  return { label: "pod", cpu: `sum by (pod) (rate(container_cpu_usage_seconds_total{${sel}}[${w}]))`, memory: `sum by (pod) (container_memory_working_set_bytes{${sel}})` };
}

/** Seconds between points: about 240 points over the range, at least 15 s. */
export const stepFor = (r: ScopeRequest) => Math.max(15, Math.round(RANGE_MS[r.range] / 1000 / 240));

/**
 * A scope's series from Prometheus. `read` reads the cluster's objects (requests, limits, a workload's pods), first,
 * so a reader who can't see the scope's objects gets nothing from Prometheus either; `ask` reaches Prometheus.
 */
export async function prometheusSeries(read: Get, ask: Get, t: PrometheusTarget, r: ScopeRequest, now = Date.now()): Promise<MetricsSeries> {
  for (const n of [r.namespace, r.name]) if (n !== undefined && !safeName(n)) throw Object.assign(new Error("not a Kubernetes name"), { status: 400 });
  const step = stepFor(r);
  const base = await liveSeries(read, [], r, step, now);
  const pods = r.scope === "deployment" || r.scope === "statefulset" || r.scope === "daemonset" ? (await workloadPods(read, r)).filter(safeName) : undefined;
  const q = queries(r, step, pods);
  const from = now - RANGE_MS[r.range];
  const range = (query: string, label: string) => ask(queryPath(t, query, from, now, step)).then((x) => parseMatrix(x, label));
  const [cpu, memory, nsCpu, nsMemory] = await Promise.all([
    range(q.cpu, q.label),
    range(q.memory, q.label),
    "nsCpu" in q && q.nsCpu ? range(q.nsCpu, "namespace") : undefined,
    "nsMemory" in q && q.nsMemory ? range(q.nsMemory, "namespace") : undefined,
  ]);
  const only = (ls: MetricLine[]) => ("nodeFilter" in q && q.nodeFilter ? ls.filter((l) => l.key === q.nodeFilter) : ls);
  const out: MetricsSeries = {
    ...base,
    source: "prometheus",
    reasons: [],
    step,
    from,
    to: now,
    prometheus: `${t.namespace}/${t.service}`,
    cpu: { ...base.cpu, series: only(cpu) },
    memory: { ...base.memory, series: only(memory) },
  };
  if (nsCpu && nsMemory) out.namespaces = means(nsCpu, nsMemory);
  return out;
}

const mean = (pts: [number, number][]) => (pts.length ? pts.reduce((a, [, v]) => a + v, 0) / pts.length : 0);
function means(cpu: MetricLine[], memory: MetricLine[]) {
  const by = new Map<string, { key: string; cpu: number; memory: number }>();
  for (const l of cpu) by.set(l.key, { key: l.key, cpu: mean(l.points), memory: 0 });
  for (const l of memory) by.set(l.key, { ...(by.get(l.key) ?? { key: l.key, cpu: 0 }), memory: mean(l.points) });
  return [...by.values()].sort((a, b) => b.cpu - a.cpu);
}
