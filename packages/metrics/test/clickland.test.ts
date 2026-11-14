import { describe, expect, it } from "vitest";
import { ClicklandClient, ClicklandError } from "../src/clickland.js";
import { clicklandSeries, plan } from "../src/clickland-series.js";
import { fakeClickland, KEY } from "./fakes.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const pts = (...vs: number[]): [string, number][] => vs.map((v, i) => [new Date(NOW - (vs.length - i) * 30_000).toISOString(), v]);

describe("ClicklandClient", () => {
  it("sends the key only to the configured URL's query route, never to health, and refuses redirects", async () => {
    const f = fakeClickland();
    const c = new ClicklandClient({ url: "http://127.0.0.1:4710/", key: KEY }, f.fetchImpl);
    await c.health();
    await c.query({ metric: "m", type: "gauge", aggregation: "avg", from: "a", to: "b" });
    expect(f.calls.map((x) => x.url)).toEqual(["http://127.0.0.1:4710/api/health", "http://127.0.0.1:4710/api/metrics/query"]);
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(f.calls[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls.every((x) => x.redirect === "error")).toBe(true);
  });

  it("tells unreachable, unauthorized and failed apart, and never repeats the key", async () => {
    const down = new ClicklandClient({ url: "http://127.0.0.1:1", key: KEY }, fakeClickland({ down: true }).fetchImpl);
    await expect(down.health()).rejects.toMatchObject({ kind: "unreachable" });
    const denied = new ClicklandClient({ url: "http://127.0.0.1:1", key: KEY }, fakeClickland({ status: 401 }).fetchImpl);
    await expect(denied.query({} as never)).rejects.toMatchObject({ kind: "unauthorized" });
    const broken = new ClicklandClient({ url: "http://127.0.0.1:1", key: KEY }, fakeClickland({ status: 500 }).fetchImpl);
    const err = (await broken.query({} as never).catch((e) => e)) as ClicklandError;
    expect(err.kind).toBe("failed");
    expect(err.message).not.toContain(KEY);
  });
});

describe("a scope as Clickland queries", () => {
  it("filters every query on the cluster name and the scope's attributes", () => {
    expect(plan("orbstack", { scope: "pod", namespace: "shop", name: "api-1", range: "1h" }).where).toEqual({
      "k8s.cluster.name": "orbstack",
      "k8s.namespace.name": "shop",
      "k8s.pod.name": "api-1",
    });
    expect(plan("orbstack", { scope: "statefulset", namespace: "shop", name: "db", range: "1h" }).where["k8s.statefulset.name"]).toBe("db");
    expect(plan("orbstack", { scope: "node", name: "n1", range: "1h" }).where).toEqual({ "k8s.cluster.name": "orbstack", "k8s.node.name": "n1" });
  });

  it("gives a pod's containers with the pod's request, and a limit only when every container has one", async () => {
    const f = fakeClickland({
      series: {
        "container.cpu.usage": [{ key: "api", points: pts(0.1, 0.2) }, { key: "proxy", points: pts(0.01, 0.01) }],
        "container.memory.working_set": [{ key: "api", points: pts(10, 20) }],
        "k8s.container.cpu_request": [{ key: "api", points: pts(0.05) }, { key: "proxy", points: pts(0.01) }],
        "k8s.container.cpu_limit": [{ key: "api", points: pts(0.2) }],
        "k8s.container.memory_limit": [{ key: "api", points: pts(100) }, { key: "proxy", points: pts(16) }],
        "k8s.container.restarts": [{ key: "api", points: pts(0) }, { key: "proxy", points: pts(0) }],
      },
    });
    const s = await clicklandSeries(new ClicklandClient({ url: "http://x.test", key: KEY }, f.fetchImpl), "orbstack", { scope: "pod", namespace: "shop", name: "api-1", range: "1h" }, NOW);
    expect(s).toMatchObject({ source: "clickland", by: "container", step: 30, cluster: "orbstack", from: NOW - 3_600_000, to: NOW });
    expect(s.cpu.series.map((x) => x.key)).toEqual(["api", "proxy"]);
    expect(s.cpu.series[0]!.points[1]).toEqual([NOW - 30_000, 0.2]);
    expect(s.cpu.request).toBeCloseTo(0.06);
    expect(s.cpu.limit).toBeUndefined();
    expect(s.cpu.byKey).toEqual({ api: { request: 0.05, limit: 0.2 }, proxy: { request: 0.01 } });
    expect(s.memory.limit).toBe(116);
    for (const c of f.calls) expect(c.body.where).toMatchObject({ "k8s.cluster.name": "orbstack", "k8s.pod.name": "api-1" });
  });

  it("gives the cluster per node with allocatable and namespaces, and says when the cluster name has no data", async () => {
    const f = fakeClickland({
      series: {
        "k8s.node.cpu.usage": [{ key: "n1", points: pts(1, 3) }],
        "k8s.node.memory.working_set": [{ key: "n1", points: pts(5, 5) }],
        "k8s.node.allocatable_cpu": [{ key: "n1", points: pts(8) }],
        "k8s.pod.cpu.usage": [{ key: "a", points: pts(0.1, 0.3) }, { key: "b", points: pts(1, 1) }],
        "k8s.pod.memory.working_set": [{ key: "a", points: pts(4) }],
      },
    });
    const c = new ClicklandClient({ url: "http://x.test", key: KEY }, f.fetchImpl);
    const s = await clicklandSeries(c, "orbstack", { scope: "cluster", range: "6h" }, NOW);
    expect(s.cpu.allocatable).toBe(8);
    expect(s.memory.allocatable).toBeUndefined();
    expect(s.namespaces).toEqual([{ key: "b", cpu: 1, memory: 0 }, { key: "a", cpu: 0.2, memory: 4 }]);
    const empty = new ClicklandClient({ url: "http://x.test", key: KEY }, fakeClickland().fetchImpl);
    await expect(clicklandSeries(empty, "elsewhere", { scope: "cluster", range: "1h" }, NOW)).rejects.toMatchObject({ kind: "no-cluster" });
  });
});
