// Prometheus as a metrics source (wave 4, part 4): found as OpenLens finds it, asked through the service proxy with
// fixed cAdvisor queries, its answer checked; between Clickland and metrics-server.
import { describe, expect, it, vi } from "vitest";
import { findPrometheus, parseMatrix, prometheusSeries, queries, queryPath, safeName, stepFor } from "../src/prometheus.js";
import { MetricsService } from "../src/service.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const T = { namespace: "monitoring", service: "prometheus-server", port: "80", scheme: "http" as const, provider: "helm" };
const matrix = (label: string, rows: Record<string, number[]>) => ({
  status: "success",
  data: { resultType: "matrix", result: Object.entries(rows).map(([k, vs]) => ({ metric: { [label]: k }, values: vs.map((v, i) => [(NOW - (vs.length - i) * 15_000) / 1000, String(v)]) })) },
});

/** A cluster with a Helm-installed Prometheus, a Deployment `web` with two pods, and its node. */
function cluster(prom: (query: string) => unknown) {
  const calls: string[] = [];
  const get = vi.fn(async (path: string): Promise<any> => {
    calls.push(path);
    if (path.startsWith("/api/v1/services?labelSelector=app%3Dprometheus%2Ccomponent%3Dserver"))
      return { items: [{ metadata: { name: "prometheus-server", namespace: "monitoring" }, spec: { ports: [{ name: "http", port: 80 }] } }] };
    if (path.includes("/proxy/api/v1/query_range?")) return prom(new URLSearchParams(path.split("?")[1]).get("query")!);
    if (path === "/apis/apps/v1/namespaces/shop/deployments/web")
      return { spec: { selector: { matchLabels: { app: "web" } }, template: { spec: { containers: [{ name: "app", resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { memory: "128Mi" } } }] } } } };
    if (path === "/api/v1/namespaces/shop/pods?labelSelector=app=web") return { items: [{ metadata: { name: "web-1" } }, { metadata: { name: "web-2" } }] };
    if (path === "/api/v1/nodes") return { items: [{ metadata: { name: "orbstack" }, status: { allocatable: { cpu: "8", memory: "16Gi" } } }] };
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  return { get, calls };
}

describe("Prometheus", () => {
  it("is found by a Helm chart's labels, the operator's, or a well-known name, and not otherwise", async () => {
    expect(await findPrometheus(cluster(() => ({})).get)).toEqual(T);
    const op = vi.fn(async (p: string): Promise<any> => {
      if (p.includes("operated-prometheus")) return { items: [{ metadata: { name: "prometheus-operated", namespace: "mon" }, spec: { ports: [{ name: "web", port: 9090 }] } }] };
      if (p.includes("labelSelector")) return { items: [] };
      throw Object.assign(new Error("nope"), { status: 404 });
    });
    expect(await findPrometheus(op)).toMatchObject({ namespace: "mon", service: "prometheus-operated", port: "9090", provider: "operator" });
    const named = vi.fn(async (p: string): Promise<any> => {
      if (p.includes("labelSelector")) throw Object.assign(new Error("forbidden"), { status: 403 });
      if (p === "/api/v1/namespaces/monitoring/services/prometheus-k8s") return { metadata: { name: "prometheus-k8s", namespace: "monitoring" }, spec: { ports: [{ name: "web", port: 9090 }] } };
      throw Object.assign(new Error("nope"), { status: 404 });
    });
    expect(await findPrometheus(named)).toMatchObject({ provider: "kube-prometheus", service: "prometheus-k8s" });
    expect(await findPrometheus(async () => ({ items: [] }))).toBeUndefined();
  });

  it("asks fixed queries through the service proxy, with names checked and quoted", () => {
    expect(queryPath(T, "up", NOW - 3_600_000, NOW, 15)).toBe(`/api/v1/namespaces/monitoring/services/http:prometheus-server:80/proxy/api/v1/query_range?query=up&start=${(NOW - 3_600_000) / 1000}&end=${NOW / 1000}&step=15`);
    expect(stepFor({ scope: "pod", range: "1h" })).toBe(15);
    expect(stepFor({ scope: "pod", range: "24h" })).toBe(360);
    expect(queries({ scope: "pod", namespace: "shop", name: "web-1", range: "1h" }, 15)).toMatchObject({
      label: "container",
      cpu: 'sum by (container) (rate(container_cpu_usage_seconds_total{namespace="shop",pod="web-1",container!="",container!="POD"}[300s]))',
    });
    expect(queries({ scope: "deployment", namespace: "shop", name: "web", range: "1h" }, 15, ["web-1", "web-2"]).memory).toBe('sum by (pod) (container_memory_working_set_bytes{namespace="shop",pod=~"web-1|web-2",container!="",container!="POD"})');
    expect(queries({ scope: "deployment", namespace: "shop", name: "web", range: "1h" }, 15, []).cpu).toContain('pod=~"^$"');
    expect(queries({ scope: "cluster", range: "1h" }, 15)).toMatchObject({ label: "node", nsCpu: expect.stringContaining("sum by (namespace)") });
    for (const bad of ['web"} or vector(1) #', "Web", "a b", "", "x".repeat(254)]) expect(safeName(bad), bad).toBe(false);
  });

  it("reads only a matrix, keyed by names, finite numbers, capped", () => {
    expect(() => parseMatrix({ status: "error" }, "pod")).toThrow(/didn't look like metrics/);
    expect(() => parseMatrix({ status: "success", data: { resultType: "vector", result: [] } }, "pod")).toThrow();
    const lines = parseMatrix({ status: "success", data: { resultType: "matrix", result: [
      { metric: { pod: "web-1" }, values: [[1, "0.5"], [2, "NaN"], [3, "x"], [4, "0.7"]] },
      { metric: { pod: "<script>" }, values: [[1, "1"]] },
      { metric: {}, values: [[1, "1"]] },
    ] } }, "pod");
    expect(lines).toEqual([{ key: "web-1", points: [[1000, 0.5], [4000, 0.7]] }]);
  });

  it("gives a workload's pods with its requests and limits, and refuses a name that isn't one", async () => {
    const c = cluster((q) => (q.includes("cpu") ? matrix("pod", { "web-1": [0.1, 0.2], "web-2": [0.3] }) : matrix("pod", { "web-1": [1e8], "web-2": [2e8] })));
    const s = await prometheusSeries(c.get, c.get, T, { scope: "deployment", namespace: "shop", name: "web", range: "1h" }, NOW);
    expect(s).toMatchObject({ source: "prometheus", prometheus: "monitoring/prometheus-server", by: "pod", step: 15 });
    expect(s.cpu.series.map((l) => [l.key, l.points.length])).toEqual([["web-1", 2], ["web-2", 1]]);
    expect(s.cpu.request).toBeCloseTo(0.1);
    expect(s.memory.limit).toBe(128 * 1024 * 1024);
    // The cluster's objects are read before Prometheus is asked.
    expect(c.calls.findIndex((p) => p.includes("/deployments/web"))).toBeLessThan(c.calls.findIndex((p) => p.includes("/proxy/")));
    await expect(prometheusSeries(c.get, c.get, T, { scope: "pod", namespace: "shop", name: 'x"}', range: "1h" }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("gives the cluster per node with allocatable and the namespaces' means, and a node only its own", async () => {
    const c = cluster((q) => (q.includes("by (namespace)") ? matrix("namespace", { shop: [0.5, 0.5], kube: [0.1] }) : matrix("node", { orbstack: [1, 2], other: [3] })));
    const s = await prometheusSeries(c.get, c.get, T, { scope: "cluster", range: "1h" }, NOW);
    expect(s.cpu.allocatable).toBe(8);
    expect(s.cpu.series.map((l) => l.key)).toEqual(["orbstack", "other"]);
    expect(s.namespaces?.map((n) => n.key)).toEqual(["shop", "kube"]);
    const n = await prometheusSeries(async (p: string) => (p.endsWith("/nodes/orbstack") ? { status: { allocatable: { cpu: "8" } } } : c.get(p)), c.get, T, { scope: "node", name: "orbstack", range: "1h" }, NOW);
    expect(n.cpu.series.map((l) => l.key)).toEqual(["orbstack"]);
  });

  it("sits between Clickland and metrics-server, and says why it was passed over", async () => {
    const make = (prom: (q: string) => unknown) => {
      const c = cluster(prom);
      return new MetricsService({ clickland: () => ({ clusterName: (x) => x }), cluster: () => ({ context: "orbstack", get: c.get }), now: () => NOW, sampler: { timers: { set: () => 1, clear: () => {} }, now: () => NOW } });
    };
    const ok = await make(() => matrix("node", { orbstack: [1] })).series({ handle: "hhhhhhhhhhhh", scope: "cluster", range: "1h" });
    expect(ok.source).toBe("prometheus");
    expect(ok.reasons.map((r) => r.code)).toEqual(["clickland-off"]);
    const bad = await make(() => ({ status: "error", error: "bad" })).series({ handle: "hhhhhhhhhhhh", scope: "cluster", range: "1h" });
    expect(bad.source).toBe("none");
    expect(bad.reasons.map((r) => r.code)).toEqual(["clickland-off", "prometheus-failed", "no-metrics-server"]);
    expect(bad.reasons[1]!.message).toMatch(/Prometheus \(monitoring\/prometheus-server\) didn't answer/);
  });
});
