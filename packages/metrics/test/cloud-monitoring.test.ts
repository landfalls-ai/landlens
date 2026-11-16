// Cloud Monitoring as a metrics source (wave 9, D180–D181): the fixed queries, exactly; names checked before anything
// is asked; a workload's pods as an escaped regex, or the namespace cut to them; the reader's own list first; and the
// metrics-scope leak, against the fake Google that leaks on purpose: only series carrying exactly this cluster's
// project, location and name are kept, whichever matcher is missing from the query.
import type { GkeRef } from "@landlens/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGcp, GCP_TOKEN } from "../../gcp/test/fake-gcp";
import { CUT_REASON, cloudMonitoringSeries, gkeHasData, gkeQueries, gkeStep, parseGkeMatrix, POD_REGEX_MAX, type PromAsk } from "../src/cloud-monitoring.js";

const NOW = Date.parse("2026-11-16T09:00:00Z");
const C: GkeRef = { project: "demo-shop", number: "482913570214", location: "us-central1", name: "shop-prod" };
const S = 'project_id="demo-shop",location="us-central1",cluster_name="shop-prod"';
const G = "project_id,location,cluster_name";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.leak = false;
});

/** main's ask, played straight against the fake (no client: the transport is packages/gcp's, tested there). */
const fakeAsk = (rewrite: (q: string) => string = (q) => q): PromAsk & { queries: string[] } => {
  const queries: string[] = [];
  const ask = async (query: string, from: number, to: number, step: number) => {
    const q = rewrite(query);
    queries.push(q);
    const u = new URL(`${fake.origin}/v1/projects/${C.project}/location/global/prometheus/api/v1/query_range`);
    u.search = new URLSearchParams({ query: q, start: String(from / 1000), end: String(to / 1000), step: String(step) }).toString();
    const r = await fetch(u, { headers: { Authorization: `Bearer ${GCP_TOKEN}` } });
    if (!r.ok) throw Object.assign(new Error("Cloud Monitoring didn't accept Landlens's query."), { status: r.status });
    return r.json();
  };
  return Object.assign(ask, { queries });
};

/** shop-prod as its own API server sees it: a Deployment `orders-api` with two pods, the nodes, and `shop`'s pods. */
function cluster() {
  const calls: string[] = [];
  const get = vi.fn(async (path: string): Promise<any> => {
    calls.push(path);
    if (path === "/apis/apps/v1/namespaces/shop/deployments/orders-api")
      return { spec: { selector: { matchLabels: { app: "orders-api" } }, template: { spec: { containers: [{ name: "api", resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { memory: "512Mi" } } }] } } } };
    if (path === "/api/v1/namespaces/shop/pods?labelSelector=app=orders-api") return { items: [{ metadata: { name: "orders-api-7c9f-x2x4q" } }, { metadata: { name: "orders-api-7c9f-b8k2m" } }] };
    if (path === "/api/v1/namespaces/shop/pods/orders-api-7c9f-x2x4q") return { spec: { containers: [{ name: "api", resources: { requests: { cpu: "250m" } } }, { name: "istio-proxy" }] } };
    if (path === "/api/v1/pods?limit=1" || path === "/api/v1/namespaces/shop/pods?limit=1") return { items: [] };
    if (path === "/api/v1/nodes") return { items: [{ metadata: { name: "gke-shop-prod-default-pool-1a2b" }, status: { allocatable: { cpu: "3920m", memory: "13Gi" } } }, { metadata: { name: "gke-shop-prod-default-pool-3c4d" }, status: { allocatable: { cpu: "3920m", memory: "13Gi" } } }] };
    if (path === "/api/v1/nodes/gke-shop-prod-default-pool-1a2b") return { status: { allocatable: { cpu: "3920m", memory: "13Gi" } } };
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  return { get, calls };
}

const keys = (ls: { key: string }[]) => ls.map((l) => l.key).sort();
const matrix = (rows: Record<string, unknown>[]) => ({ status: "success", data: { resultType: "matrix", result: rows.map((metric) => ({ metric, values: [[NOW / 1000, "1"]] })) } });

describe("the queries (D180)", () => {
  it("are each scope's, exactly, with the three labels in every selector and every by", () => {
    expect(gkeQueries(C, { scope: "pod", namespace: "shop", name: "orders-api-7c9f-x2x4q", range: "1h" }, 60)).toEqual({
      label: "container_name",
      cpu: `sum by (${G},container_name) (rate(kubernetes_io:container_cpu_core_usage_time{${S},namespace_name="shop",pod_name="orders-api-7c9f-x2x4q"}[300s]))`,
      memory: `sum by (${G},container_name) (kubernetes_io:container_memory_used_bytes{${S},namespace_name="shop",pod_name="orders-api-7c9f-x2x4q",memory_type="non-evictable"})`,
    });
    expect(gkeQueries(C, { scope: "deployment", namespace: "shop", name: "orders-api", range: "6h" }, 90, ["a-1", "b.2"])).toEqual({
      label: "pod_name",
      cpu: `sum by (${G},pod_name) (rate(kubernetes_io:container_cpu_core_usage_time{${S},namespace_name="shop",pod_name=~"a-1|b\\\\.2"}[300s]))`,
      memory: `sum by (${G},pod_name) (kubernetes_io:container_memory_used_bytes{${S},namespace_name="shop",pod_name=~"a-1|b\\\\.2",memory_type="non-evictable"})`,
      only: new Set(["a-1", "b.2"]),
    });
    expect(gkeQueries(C, { scope: "namespace", namespace: "shop", range: "24h" }, 360)).toEqual({
      label: "pod_name",
      cpu: `sum by (${G},pod_name) (rate(kubernetes_io:container_cpu_core_usage_time{${S},namespace_name="shop"}[720s]))`,
      memory: `sum by (${G},pod_name) (kubernetes_io:container_memory_used_bytes{${S},namespace_name="shop",memory_type="non-evictable"})`,
    });
    expect(gkeQueries(C, { scope: "cluster", range: "1h" }, 60)).toEqual({
      label: "node_name",
      cpu: `sum by (${G},node_name) (rate(kubernetes_io:node_cpu_core_usage_time{${S}}[300s]))`,
      memory: `sum by (${G},node_name) (kubernetes_io:node_memory_used_bytes{${S},memory_type="non-evictable"})`,
      nsCpu: `sum by (${G},namespace_name) (rate(kubernetes_io:container_cpu_core_usage_time{${S}}[300s]))`,
      nsMemory: `sum by (${G},namespace_name) (kubernetes_io:container_memory_used_bytes{${S},memory_type="non-evictable"})`,
    });
    expect(gkeQueries(C, { scope: "node", name: "gke-n-1", range: "1h" }, 60)).toEqual({
      label: "node_name",
      cpu: `sum by (${G},node_name) (rate(kubernetes_io:node_cpu_core_usage_time{${S},node_name="gke-n-1"}[300s]))`,
      memory: `sum by (${G},node_name) (kubernetes_io:node_memory_used_bytes{${S},node_name="gke-n-1",memory_type="non-evictable"})`,
      only: new Set(["gke-n-1"]),
    });
    expect([gkeStep({ range: "1h" }), gkeStep({ range: "6h" }), gkeStep({ range: "24h" })]).toEqual([60, 90, 360]);
  });

  it("refuses a name that isn't a Kubernetes name, or a cluster that isn't GKE's shape, with a 400 before any read or ask", async () => {
    const ask = vi.fn();
    const c = cluster();
    for (const r of [
      { scope: "pod", namespace: "shop", name: 'x"} or vector(1) #', range: "1h" },
      { scope: "pod", namespace: "shop}", name: "x", range: "1h" },
      { scope: "node", name: "Node", range: "1h" },
    ] as const) {
      await expect(cloudMonitoringSeries(c.get, ask, C, r, NOW)).rejects.toMatchObject({ status: 400 });
      expect(() => gkeQueries(C, r, 60)).toThrow();
    }
    for (const bad of [{ ...C, project: 'demo-shop",x="' }, { ...C, location: "us-central1}" }, { ...C, name: "shop prod" }]) {
      await expect(cloudMonitoringSeries(c.get, ask, bad, { scope: "cluster", range: "1h" }, NOW)).rejects.toMatchObject({ status: 400 });
    }
    expect(() => gkeQueries(C, { scope: "deployment", namespace: "shop", name: "w", range: "1h" }, 60, ['p"x'])).toThrow();
    expect(ask).not.toHaveBeenCalled();
    expect(c.calls).toEqual([]);
  });

  it("past 3,000 characters of pod names asks for the namespace and keeps only the workload's pods", () => {
    const many = Array.from({ length: 120 }, (_, i) => `orders-api-7c9f-${String(i).padStart(5, "0")}-abcdefghij`);
    const q = gkeQueries(C, { scope: "deployment", namespace: "shop", name: "orders-api", range: "1h" }, 60, many);
    expect(many.join("|").length).toBeGreaterThan(POD_REGEX_MAX);
    expect(q.cpu).not.toContain("pod_name=~");
    expect(q.cpu).toContain(`{${S},namespace_name="shop"}`);
    expect(q.only).toEqual(new Set(many));
    expect(q.cpu.length).toBeLessThan(6_000);
  });
});

describe("the metrics-scope leak (D181), against the fake that leaks", () => {
  it("keeps only shop-prod's series of demo-shop when the fake answers for every cluster of the scope", async () => {
    const c = cluster();
    const clean = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "cluster", range: "1h" }, NOW);
    fake.leak = true;
    const leaked = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "cluster", range: "1h" }, NOW);
    // orbit-analytics's shop-prod has a node of the same name, and its own; shop-staging its own.
    expect(keys(leaked.cpu.series)).toEqual(["gke-shop-prod-default-pool-1a2b", "gke-shop-prod-default-pool-3c4d"]);
    expect(leaked.cpu.series).toEqual(clean.cpu.series);
    expect(leaked.memory.series).toEqual(clean.memory.series);
    expect(leaked.namespaces).toEqual(clean.namespaces);
    expect(leaked.namespaces?.map((n) => n.key)).not.toContain("analytics");
    // A pod whose name the other project's cluster also has.
    const pod = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "pod", namespace: "shop", name: "orders-api-7c9f-x2x4q", range: "1h" }, NOW);
    fake.leak = false;
    const cleanPod = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "pod", namespace: "shop", name: "orders-api-7c9f-x2x4q", range: "1h" }, NOW);
    expect(keys(pod.cpu.series)).toEqual(["api", "istio-proxy"]);
    expect(pod.cpu.series).toEqual(cleanPod.cpu.series);
  });

  it("with each of the three matchers taken out of the query in turn, the parse still keeps only this cluster's", async () => {
    // A cluster differing from shop-prod in exactly one of the three: another project's (orbit-analytics, seeded),
    // another location's and another name's.
    fake.gke.set("demo-shop/europe-west1-b/shop-prod", { nodes: ["gke-shop-prod-default-pool-1a2b", "gke-eu-only"], pods: [] });
    fake.gke.set("demo-shop/us-central1/shop-prod-canary", { nodes: ["gke-shop-prod-default-pool-1a2b", "gke-canary-only"], pods: [] });
    try {
      const c = cluster();
      const clean = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "cluster", range: "1h" }, NOW);
      for (const m of ['project_id="demo-shop",', 'location="us-central1",', ',cluster_name="shop-prod"']) {
        const ask = fakeAsk((q) => q.split(m).join(""));
        const out = await cloudMonitoringSeries(c.get, ask, C, { scope: "cluster", range: "1h" }, NOW);
        expect(ask.queries.every((q) => !q.includes(m)), m).toBe(true);
        expect(keys(out.cpu.series), m).toEqual(["gke-shop-prod-default-pool-1a2b", "gke-shop-prod-default-pool-3c4d"]);
        expect(out.cpu.series, m).toEqual(clean.cpu.series);
        expect(out.memory.series, m).toEqual(clean.memory.series);
      }
    } finally {
      fake.gke.delete("demo-shop/europe-west1-b/shop-prod");
      fake.gke.delete("demo-shop/us-central1/shop-prod-canary");
    }
  });

  it("drops a series missing any of the three labels, or carrying another value, or a key that isn't a name", () => {
    const id = { project_id: "demo-shop", location: "us-central1", cluster_name: "shop-prod" };
    const rows = [
      { ...id, node_name: "kept" },
      { location: "us-central1", cluster_name: "shop-prod", node_name: "no-project" },
      { project_id: "demo-shop", cluster_name: "shop-prod", node_name: "no-location" },
      { project_id: "demo-shop", location: "us-central1", node_name: "no-cluster" },
      { ...id, project_id: "orbit-analytics", node_name: "other-project" },
      { ...id, project_id: "482913570214", node_name: "by-number" },
      { ...id, location: "us-central1-a", node_name: "other-location" },
      { ...id, cluster_name: "shop-prod-canary", node_name: "other-cluster" },
      { ...id, cluster_name: ["shop-prod"], node_name: "not-a-string" },
      { ...id, node_name: "<script>" },
      { ...id },
    ];
    expect(keys(parseGkeMatrix(matrix(rows), C, "node_name"))).toEqual(["kept"]);
    expect(() => parseGkeMatrix({ status: "error", error: "bad" }, C, "node_name")).toThrow(/didn't look like metrics/);
    expect(() => parseGkeMatrix({ status: "success", data: { resultType: "vector", result: [] } }, C, "node_name")).toThrow();
  });

  it("a cluster scope with more than 200 of its own series draws 200 and says so; other clusters' series don't count", async () => {
    const id = { project_id: "demo-shop", location: "us-central1", cluster_name: "shop-prod" };
    const other = Array.from({ length: 300 }, (_, i) => ({ ...id, project_id: "orbit-analytics", node_name: `o-${i}` }));
    const mine = (n: number) => Array.from({ length: n }, (_, i) => ({ ...id, node_name: `n-${i}` }));
    const c = cluster();
    // 300 of another project's first, then 150 of this cluster's: all 150 drawn, nothing said.
    const fits = await cloudMonitoringSeries(c.get, async () => matrix([...other, ...mine(150)]), C, { scope: "cluster", range: "1h" }, NOW);
    expect(fits.cpu.series).toHaveLength(150);
    expect(fits.reasons).toEqual([]);
    const over = await cloudMonitoringSeries(c.get, async () => matrix(mine(250)), C, { scope: "cluster", range: "1h" }, NOW);
    expect(over.cpu.series).toHaveLength(200);
    expect(over.reasons).toEqual([{ code: "cloud-monitoring-cut", message: CUT_REASON }]);
  });
});

describe("a scope's series from Cloud Monitoring", () => {
  it("a workload's pods, with requests and limits from the cluster, read before Google is asked", async () => {
    const c = cluster();
    const ask = fakeAsk();
    const s = await cloudMonitoringSeries(c.get, ask, C, { scope: "deployment", namespace: "shop", name: "orders-api", range: "1h" }, NOW);
    expect(s).toMatchObject({ source: "cloud-monitoring", by: "pod", step: 60, gke: { project: "demo-shop", location: "us-central1", name: "shop-prod" }, reasons: [] });
    expect(keys(s.cpu.series)).toEqual(["orders-api-7c9f-b8k2m", "orders-api-7c9f-x2x4q"]);
    expect(s.cpu.series[0]!.points).toHaveLength(61);
    expect(s.cpu.request).toBeCloseTo(0.25);
    expect(s.memory.limit).toBe(512 * 1024 * 1024);
    expect(ask.queries[0]).toContain('pod_name=~"orders-api-7c9f-x2x4q|orders-api-7c9f-b8k2m"');
    expect(c.calls).toContain("/apis/apps/v1/namespaces/shop/deployments/orders-api");
    expect(fake.requests.every((r) => r.method === "GET" && r.path === "/v1/projects/demo-shop/location/global/prometheus/api/v1/query_range")).toBe(true);
  });

  it("the cluster per node with allocatable and the namespaces' means; a node only its own", async () => {
    const c = cluster();
    const s = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "cluster", range: "1h" }, NOW);
    expect(s.by).toBe("node");
    expect(s.cpu.allocatable).toBeCloseTo(7.84);
    expect(s.namespaces?.map((n) => n.key).sort()).toEqual(["kube-system", "monitoring", "shop"]);
    const n = await cloudMonitoringSeries(c.get, fakeAsk(), C, { scope: "node", name: "gke-shop-prod-default-pool-1a2b", range: "1h" }, NOW);
    expect(keys(n.cpu.series)).toEqual(["gke-shop-prod-default-pool-1a2b"]);
    expect(n.cpu.allocatable).toBeCloseTo(3.92);
  });

  it("asks the reader for the scope's pods first: a reader who can't list them gets nothing from Google", async () => {
    const c = cluster();
    const ask = vi.fn();
    const denied = async (p: string) => (p.includes("/pods?limit=1") ? Promise.reject(Object.assign(new Error("forbidden"), { status: 403 })) : c.get(p));
    await expect(cloudMonitoringSeries(denied, ask, C, { scope: "namespace", namespace: "shop", range: "1h" }, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(cloudMonitoringSeries(denied, ask, C, { scope: "cluster", range: "1h" }, NOW)).rejects.toMatchObject({ status: 403 });
    expect(ask).not.toHaveBeenCalled();
  });

  it("a workload too big for the regex is asked by namespace and cut to its own pods; a node keeps only itself", async () => {
    const id = { project_id: "demo-shop", location: "us-central1", cluster_name: "shop-prod" };
    const many = Array.from({ length: 120 }, (_, i) => `orders-api-7c9f-${String(i).padStart(5, "0")}-abcdefghij`);
    const big = async (p: string): Promise<any> => (p.includes("labelSelector") ? { items: many.map((name) => ({ metadata: { name } })) } : cluster().get(p));
    const ask = vi.fn(async () => matrix([...many.slice(0, 3), "cart-6d5b-9wq7z", "web-frontend-84d6-4mz9t"].map((pod_name) => ({ ...id, pod_name }))));
    const s = await cloudMonitoringSeries(big, ask, C, { scope: "deployment", namespace: "shop", name: "orders-api", range: "1h" }, NOW);
    expect((ask.mock.calls[0] as unknown[])[0]).not.toContain("pod_name=~");
    expect(keys(s.cpu.series)).toEqual(many.slice(0, 3));
    // A node's query names it; an answer with another node anyway keeps only the asked one.
    const nodes = async () => matrix(["gke-shop-prod-default-pool-1a2b", "gke-shop-prod-default-pool-3c4d"].map((node_name) => ({ ...id, node_name })));
    const n = await cloudMonitoringSeries(cluster().get, nodes, C, { scope: "node", name: "gke-shop-prod-default-pool-1a2b", range: "1h" }, NOW);
    expect(keys(n.cpu.series)).toEqual(["gke-shop-prod-default-pool-1a2b"]);
  });

  it("a workload with no pods asks nothing", async () => {
    const ask = vi.fn();
    const none = async (p: string): Promise<any> => (p.includes("labelSelector") ? { items: [] } : cluster().get(p));
    const s = await cloudMonitoringSeries(none, ask, C, { scope: "deployment", namespace: "shop", name: "orders-api", range: "1h" }, NOW);
    expect(s.cpu.series).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("gkeHasData: this cluster's node CPU in the last hour, never another's", async () => {
    expect(await gkeHasData(fakeAsk(), C, NOW)).toBe(true);
    // Only another project's cluster has data: still no.
    const saved = fake.gke.get("demo-shop/us-central1/shop-prod")!;
    fake.gke.delete("demo-shop/us-central1/shop-prod");
    try {
      fake.leak = true;
      expect(await gkeHasData(fakeAsk(), C, NOW)).toBe(false);
    } finally {
      fake.gke.set("demo-shop/us-central1/shop-prod", saved);
    }
  });
});
