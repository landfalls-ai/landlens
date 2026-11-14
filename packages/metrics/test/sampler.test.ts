import { describe, expect, it } from "vitest";
import { liveSeries } from "../src/live-series.js";
import { MetricsServerSampler, Ring } from "../src/sampler.js";

/** A fake cluster serving metrics.k8s.io; usage grows by one step per tick. */
function fakeCluster(opts: { served?: boolean } = {}) {
  let tick = 0;
  const calls: string[] = [];
  const get = async (path: string): Promise<any> => {
    calls.push(path);
    if (path === "/apis/metrics.k8s.io/v1beta1") {
      if (opts.served === false) throw Object.assign(new Error("not found"), { status: 404 });
      return { resources: [{ name: "nodes" }, { name: "pods" }] };
    }
    if (path.endsWith("/nodes") && path.includes("metrics")) return { items: [{ metadata: { name: "n1" }, usage: { cpu: `${100 * ++tick}m`, memory: "1Gi" } }] };
    if (path.endsWith("/pods") && path.includes("metrics"))
      return {
        items: [
          { metadata: { namespace: "shop", name: "api-1" }, containers: [{ name: "api", usage: { cpu: "50m", memory: "32Mi" } }, { name: "proxy", usage: { cpu: "1m", memory: "1Mi" } }] },
          { metadata: { namespace: "shop", name: "api-2" }, containers: [{ name: "api", usage: { cpu: "70m", memory: "30Mi" } }] },
          { metadata: { namespace: "other", name: "x" }, containers: [{ name: "x", usage: { cpu: "500m", memory: "1Mi" } }] },
        ],
      };
    if (path === "/api/v1/nodes") return { items: [{ status: { allocatable: { cpu: "4", memory: "8Gi" } } }] };
    if (path === "/api/v1/namespaces/shop/pods/api-1")
      return { spec: { containers: [{ name: "api", resources: { requests: { cpu: "50m" }, limits: { cpu: "200m" } } }, { name: "proxy" }] } };
    if (path === "/apis/apps/v1/namespaces/shop/deployments/api")
      return { spec: { selector: { matchLabels: { app: "api" } }, template: { spec: { containers: [{ name: "api", resources: { requests: { cpu: "50m" }, limits: { cpu: "200m" } } }] } } } };
    if (path === "/api/v1/namespaces/shop/pods?labelSelector=app=api") return { items: [{ metadata: { name: "api-1" } }, { metadata: { name: "api-2" } }] };
    throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
  };
  return { get, calls };
}

/** Manual timers and clock: run() fires the interval once and advances the clock by it. */
function manual() {
  let now = 1_000_000;
  let fn: (() => void) | undefined;
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
    timers: { set: (f: () => void) => ((fn = f), 1), clear: () => (fn = undefined) },
    fire: () => fn?.(),
    get armed() {
      return !!fn;
    },
  };
}

describe("Ring", () => {
  it("keeps the newest items up to its capacity, oldest first", () => {
    const r = new Ring<number>(3);
    for (const n of [1, 2, 3, 4, 5]) r.push(n);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.length).toBe(3);
  });
});

describe("MetricsServerSampler", () => {
  it("samples at once when asked, every interval after, keeps an hour, and stops when no one asks", async () => {
    const c = fakeCluster();
    const m = manual();
    const s = new MetricsServerSampler(c.get, { intervalMs: 15_000, keepMs: 60_000, idleMs: 30_000, now: m.now, timers: m.timers });
    await s.touch();
    expect(s.running).toBe(true);
    expect(s.samples()).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      m.advance(15_000);
      if (i % 2 === 0) s.touch(); // a view keeps asking (already running: no extra sample)
      await s.tick(); // the interval fires
    }
    // 60 s at 15 s: four samples kept, the oldest dropped.
    expect(s.samples()).toHaveLength(4);
    expect(s.samples()[3]!.nodes.get("n1")!.cpu).toBeCloseTo(0.7);
    m.advance(45_000);
    await s.tick(); // idle for 45 s > 30 s
    expect(s.running).toBe(false);
    expect(m.armed).toBe(false);
  });

  it("says when metrics.k8s.io isn't served, and asks at most once a minute", async () => {
    const c = fakeCluster({ served: false });
    const m = manual();
    const s = new MetricsServerSampler(c.get, { now: m.now, timers: m.timers });
    expect(await s.available()).toMatchObject({ ok: false, message: expect.stringContaining("metrics-server isn't installed") });
    await s.available();
    expect(c.calls.filter((p) => p === "/apis/metrics.k8s.io/v1beta1")).toHaveLength(1);
  });
});

describe("liveSeries", () => {
  const sampled = async () => {
    const c = fakeCluster();
    const m = manual();
    const s = new MetricsServerSampler(c.get, { now: m.now, timers: m.timers });
    await s.touch();
    m.advance(15_000);
    await s.tick();
    return { c, s, now: m.now() };
  };

  it("gives a pod's containers with requests and limits from its spec", async () => {
    const { c, s, now } = await sampled();
    const out = await liveSeries(c.get, s.samples(), { scope: "pod", namespace: "shop", name: "api-1", range: "1h" }, 15, now);
    expect(out).toMatchObject({ source: "metrics-server", by: "container", step: 15 });
    expect(out.cpu.series.map((x) => x.key)).toEqual(["api", "proxy"]);
    expect(out.cpu.series[0]!.points).toHaveLength(2);
    expect(out.cpu.request).toBeCloseTo(0.05);
    expect(out.cpu.limit).toBeUndefined(); // proxy sets none
    expect(out.cpu.byKey!.api).toEqual({ request: 0.05, limit: 0.2 });
  });

  it("gives a deployment per pod (its selector's pods only), and the cluster per node with namespaces", async () => {
    const { c, s, now } = await sampled();
    const dep = await liveSeries(c.get, s.samples(), { scope: "deployment", namespace: "shop", name: "api", range: "1h" }, 15, now);
    expect(dep.by).toBe("pod");
    expect(dep.cpu.series.map((x) => x.key).sort()).toEqual(["api-1", "api-2"]);
    expect(dep.cpu.series.find((x) => x.key === "api-1")!.points[0]![1]).toBeCloseTo(0.051);
    expect(dep.cpu).toMatchObject({ request: 0.05, limit: 0.2 });
    const cl = await liveSeries(c.get, s.samples(), { scope: "cluster", range: "1h" }, 15, now);
    expect(cl.cpu.allocatable).toBe(4);
    expect(cl.memory.allocatable).toBe(8 * 2 ** 30);
    expect(cl.namespaces!.map((n) => n.key)).toEqual(["other", "shop"]);
    expect(cl.namespaces![1]!.cpu).toBeCloseTo(0.121);
  });
});
