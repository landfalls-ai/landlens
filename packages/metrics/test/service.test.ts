import { describe, expect, it, vi } from "vitest";
import { MetricsService, NOT_GRANTED } from "../src/service.js";
import { fakeClickland, KEY } from "./fakes.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const node = { key: "orbstack", points: [[new Date(NOW - 30_000).toISOString(), 1.5]] as [string, number][] };

/** A cluster with or without metrics-server. */
const cluster = (served: boolean) => ({
  context: "orbstack",
  get: async (path: string): Promise<any> => {
    if (!served) throw Object.assign(new Error("404 page not found"), { status: 404 });
    if (path === "/apis/metrics.k8s.io/v1beta1") return { resources: [{ name: "pods" }] };
    if (path.includes("metrics.k8s.io")) return { items: [] };
    return { items: [] };
  },
});

function service(opts: { key?: boolean; served?: boolean; fetchImpl?: typeof fetch; names?: Record<string, string> }) {
  return new MetricsService({
    clickland: () => ({
      ...(opts.key ? { config: { url: "http://127.0.0.1:4710", key: KEY } } : {}),
      clusterName: (ctx) => opts.names?.[ctx] ?? ctx,
    }),
    cluster: () => cluster(opts.served ?? false),
    now: () => NOW,
    sampler: { timers: { set: () => 1, clear: () => {} }, now: () => NOW },
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });
}
const req = { handle: "hhhhhhhhhhhh", scope: "cluster", range: "1h" } as const;

describe("choosing the source", () => {
  it("uses Clickland when it has a key and answers for this cluster's name", async () => {
    const f = fakeClickland({ series: { "k8s.node.cpu.usage": [node] } });
    const s = await service({ key: true, fetchImpl: f.fetchImpl, names: { orbstack: "dev-cluster" } }).series(req);
    expect(s).toMatchObject({ source: "clickland", reasons: [], cluster: "dev-cluster" });
    expect(f.calls[1]!.body.where["k8s.cluster.name"]).toBe("dev-cluster"); // after the filter probe
  });

  it("falls back to metrics-server when Clickland isn't connected, is down, refuses the key, or has no such cluster", async () => {
    const cases = [
      [{}, "clickland-off"],
      [{ key: true, fetchImpl: fakeClickland({ down: true }).fetchImpl }, "clickland-unreachable"],
      [{ key: true, fetchImpl: fakeClickland({ status: 401 }).fetchImpl }, "clickland-unauthorized"],
      [{ key: true, fetchImpl: fakeClickland().fetchImpl }, "clickland-no-cluster"],
    ] as const;
    for (const [opts, code] of cases) {
      const s = await service({ ...opts, served: true }).series(req);
      expect(s.source).toBe("metrics-server");
      expect(s.reasons.map((r) => r.code)).toEqual([code, "live-only"]);
    }
  });

  it("refuses a Clickland that ignores filters (it would mix every pod's data), in a series and in the test", async () => {
    const f = fakeClickland({ ignoresWhere: true, series: { "k8s.node.cpu.usage": [node] } });
    const s = await service({ key: true, served: true, fetchImpl: f.fetchImpl }).series(req);
    expect(s.source).toBe("metrics-server");
    expect(s.reasons[0]).toMatchObject({ code: "clickland-failed", message: expect.stringContaining("ignores metric filters") });
    const t = await service({ fetchImpl: f.fetchImpl }).test({ url: "http://127.0.0.1:4710", key: KEY });
    expect(t.ok).toBe(false);
    expect(t.steps.find((x) => x.name === "Filters")!.ok).toBe(false);
  });

  it("answers none, with both reasons, when neither is there", async () => {
    const s = await service({ served: false }).series(req);
    expect(s).toMatchObject({ source: "none", cpu: { series: [] }, memory: { series: [] } });
    expect(s.reasons.map((r) => r.code)).toEqual(["clickland-off", "no-metrics-server"]);
    expect(s.reasons[1]!.message).toContain("metrics-server isn't installed");
  });
});

describe("the Settings test", () => {
  it("checks health, then queries this cluster's node CPU", async () => {
    const f = fakeClickland({ series: { "k8s.node.cpu.usage": [node] } });
    const t = await service({ fetchImpl: f.fetchImpl }).test({ url: "http://127.0.0.1:4710", key: KEY, handle: "hhhhhhhhhhhh" });
    expect(t.ok).toBe(true);
    expect(t.steps.map((s) => s.name)).toEqual(["Health", "Filters", "Query"]);
    expect(f.calls[2]!.body.where).toEqual({ "k8s.cluster.name": "orbstack" });
  });

  it("fails on a refused key or no data, saying which", async () => {
    const denied = await service({ fetchImpl: fakeClickland({ status: 403 }).fetchImpl }).test({ url: "http://127.0.0.1:4710", key: KEY });
    expect(denied.ok).toBe(false);
    expect(denied.steps.at(-1)!.detail).toContain("read scope");
    const none = await service({ fetchImpl: fakeClickland().fetchImpl }).test({ url: "http://127.0.0.1:4710", key: KEY, cluster: "nope" });
    expect(none.steps.at(-1)).toMatchObject({ ok: false, detail: expect.stringContaining("“nope”") });
    expect((await service({}).test({})).ok).toBe(false);
  });

  it("sends the stored key only to the origin it was saved for: another address needs it typed again", async () => {
    const f = fakeClickland({ series: { "k8s.node.cpu.usage": [node] } });
    const elsewhere = await service({ key: true, fetchImpl: f.fetchImpl }).test({ url: "https://collector.example" });
    expect(elsewhere).toEqual({ ok: false, steps: [{ name: "Settings", ok: false, detail: expect.stringContaining("Type it again") }] });
    expect(f.calls).toEqual([]); // nothing was sent anywhere
    // The same origin (another path) is the same Clickland; a typed key may go anywhere the contract allows.
    expect((await service({ key: true, fetchImpl: f.fetchImpl }).test({ url: "http://127.0.0.1:4710/" })).ok).toBe(true);
    expect(f.calls.every((c) => c.url.startsWith("http://127.0.0.1:4710/"))).toBe(true);
    const typed = fakeClickland({ series: { "k8s.node.cpu.usage": [node] } });
    expect((await service({ key: true, fetchImpl: typed.fetchImpl }).test({ url: "https://collector.example", key: KEY })).ok).toBe(true);
  });
});

describe("the metrics tool's reads", () => {
  it("reads the cluster with the read it is given (the session's token), not the sidecar", async () => {
    const read: string[] = [];
    const s = await service({ served: true }).series({ handle: "hhhhhhhhhhhh", scope: "pod", namespace: "shop", name: "api-1", range: "1h" }, {
      read: async (path) => {
        read.push(path);
        return { spec: { containers: [{ name: "api", resources: { requests: { cpu: "50m" } } }] } };
      },
    });
    expect(s.source).toBe("metrics-server");
    expect(read).toEqual(["/api/v1/namespaces/shop/pods/api-1"]);
    expect(s.cpu.request).toBeCloseTo(0.05);
  });
});

describe("Cloud Monitoring in the order (wave 9, D182)", () => {
  const C = { project: "demo-shop", location: "us-central1", name: "shop-prod" };
  const id = { project_id: "demo-shop", location: "us-central1", cluster_name: "shop-prod" };
  const m = (label: string, keys: string[]) => ({ status: "success", data: { resultType: "matrix", result: keys.map((k) => ({ metric: { ...id, [label]: k }, values: [[NOW / 1000 - 60, "0.5"], [NOW / 1000, "0.6"]] })) } });
  /** Answers node CPU (and memory) for the cluster, nothing for a pod: a new pod has no samples yet. */
  const answers = (o: { nodes?: string[]; pod?: string[] } = {}) => {
    const log: string[] = [];
    const ask = async (q: string) => {
      log.push(q);
      if (q.includes("node_name") && !q.includes("namespace_name")) return m("node_name", o.nodes ?? ["gke-n-1"]);
      if (q.includes("by (project_id,location,cluster_name,namespace_name)")) return m("namespace_name", ["shop"]);
      return m("container_name", o.pod ?? []);
    };
    return { ask, log };
  };
  /** A cluster with nodes and a pod, metrics-server served or not, a Helm Prometheus when asked for. */
  const kube = (served: boolean, prom = false) => async (path: string): Promise<any> => {
    if (prom && path.startsWith("/api/v1/services?labelSelector=app%3Dprometheus%2Ccomponent%3Dserver")) return { items: [{ metadata: { name: "prometheus-server", namespace: "monitoring" }, spec: { ports: [{ name: "http", port: 80 }] } }] };
    if (path.includes("/proxy/api/v1/query_range?")) return { status: "success", data: { resultType: "matrix", result: [{ metric: { node: "orbstack" }, values: [[NOW / 1000, "1"]] }] } };
    if (path === "/api/v1/nodes") return { items: [{ metadata: { name: "gke-n-1" }, status: { allocatable: { cpu: "4", memory: "16Gi" } } }] };
    if (path === "/api/v1/namespaces/shop/pods/new-pod") return { spec: { containers: [{ name: "app" }] } };
    if (path === "/api/v1/pods?limit=1") return { items: [] };
    if (!served) throw Object.assign(new Error("404 page not found"), { status: 404 });
    if (path === "/apis/metrics.k8s.io/v1beta1") return { resources: [{ name: "pods" }] };
    return { items: [] };
  };
  type Dep = NonNullable<ConstructorParameters<typeof MetricsService>[0]["cloudMonitoring"]>;
  const svc = (o: { served?: boolean; prom?: boolean; chosen?: string; dep?: Dep; key?: boolean; fetchImpl?: typeof fetch }) => new MetricsService({
    clickland: () => ({ ...(o.key ? { config: { url: "http://127.0.0.1:4710", key: KEY } } : {}), clusterName: (c) => c }),
    cluster: () => ({ context: "gke_demo-shop_us-central1_shop-prod", get: kube(o.served ?? true, o.prom) }),
    prometheus: { chosen: () => o.chosen },
    ...(o.dep ? { cloudMonitoring: o.dep } : {}),
    ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}),
    now: () => NOW,
    sampler: { timers: { set: () => 1, clear: () => {} }, now: () => NOW },
  });
  const use = (ask: (q: string) => Promise<unknown>): Dep => async () => ({ cluster: C, ask });
  const codes = (s: { reasons: { code: string }[] }) => s.reasons.map((r) => r.code);

  it("draws ahead of metrics-server, with the cluster it read and the reasons before it", async () => {
    const a = answers();
    const s = await svc({ dep: use(a.ask) }).series(req);
    expect(s).toMatchObject({ source: "cloud-monitoring", gke: C, by: "node", step: 60 });
    expect(s.cpu.series.map((l) => l.key)).toEqual(["gke-n-1"]);
    expect(s.cpu.allocatable).toBe(4);
    expect(codes(s)).toEqual(["clickland-off"]);
  });

  it("Clickland with data and a Prometheus you chose stay ahead of it; a found Prometheus is still offered beside it", async () => {
    const asked = vi.fn(answers().ask);
    const f = fakeClickland({ series: { "k8s.node.cpu.usage": [node] } });
    expect((await svc({ key: true, fetchImpl: f.fetchImpl, dep: use(asked) }).series(req)).source).toBe("clickland");
    expect((await svc({ prom: true, chosen: "monitoring/prometheus-server", dep: use(asked) }).series(req)).source).toBe("prometheus");
    expect(asked).not.toHaveBeenCalled();
    const offered = await svc({ prom: true, dep: use(asked) }).series(req);
    expect(offered).toMatchObject({ source: "cloud-monitoring", prometheusFound: "monitoring/prometheus-server" });
    expect(codes(offered)).toEqual(["clickland-off", "prometheus-found"]);
  });

  it("not a GKE cluster of a chosen project says nothing; a reason from main is said and metrics-server answers", async () => {
    expect(codes(await svc({ dep: async () => undefined }).series(req))).toEqual(["clickland-off", "live-only"]);
    const hint = "This looks like a GKE cluster of demo-shop. Choose that project on the Google Cloud page to see Google's metrics, alerts and suggestions for it.";
    const s = await svc({ dep: async () => ({ reason: { code: "cloud-monitoring-not-chosen", message: hint } }) }).series(req);
    expect(s.source).toBe("metrics-server");
    expect(s.reasons[1]).toEqual({ code: "cloud-monitoring-not-chosen", message: hint });
    // A lookup that failed is said, never silence.
    const broke = await svc({ dep: async () => Promise.reject(new Error("boom")) }).series(req);
    expect(codes(broke)).toEqual(["clickland-off", "cloud-monitoring-failed", "live-only"]);
  });

  it("no node samples in the last hour is no-data and metrics-server next; an empty pod of a cluster with data is Cloud Monitoring's", async () => {
    const off = answers({ nodes: [] });
    const s = await svc({ dep: use(off.ask) }).series(req);
    expect(s.source).toBe("metrics-server");
    expect(s.reasons[1]).toEqual({ code: "cloud-monitoring-no-data", message: "Cloud Monitoring has no GKE system metrics for shop-prod in demo-shop in the last hour." });
    const on = answers();
    const pod = await svc({ dep: use(on.ask) }).series({ handle: "hhhhhhhhhhhh", scope: "pod", namespace: "shop", name: "new-pod", range: "1h" });
    expect(pod).toMatchObject({ source: "cloud-monitoring", by: "container", cpu: { series: [] }, memory: { series: [] } });
    expect(on.log.at(-1)).toContain("node_cpu_core_usage_time");
  });

  it("a failure is its sentence, Google's 400 included, and metrics-server is next; whether it has data failing isn't an empty chart", async () => {
    const sentence = "The Cloud Monitoring API is off in demo-shop. Turn it on: `gcloud services enable monitoring.googleapis.com --project demo-shop`.";
    const off = await svc({ dep: use(async () => Promise.reject(Object.assign(new Error(sentence), { status: 403 }))) }).series(req);
    expect(off.source).toBe("metrics-server");
    expect(off.reasons[1]).toEqual({ code: "cloud-monitoring-failed", message: `Cloud Monitoring (demo-shop) didn't answer: ${sentence}` });
    const refused = await svc({ dep: use(async () => Promise.reject(Object.assign(new Error("Cloud Monitoring didn't accept Landlens's query."), { status: 400 }))) }).series(req);
    expect(codes(refused)).toEqual(["clickland-off", "cloud-monitoring-failed", "live-only"]);
    const odd = await svc({ dep: use(async () => ({ status: "error", error: "x" })) }).series(req);
    expect(odd.reasons[1]!.message).toBe("Cloud Monitoring (demo-shop) didn't answer: Cloud Monitoring's answer didn't look like metrics.");
    // The pod is empty, then asking about node data fails: a failure, not "no samples yet".
    let n = 0;
    const flaky = async () => (n++ ? Promise.reject(new Error("Google didn't answer in time.")) : answers({ pod: [] }).ask("pod"));
    const pod = await svc({ dep: use(flaky), served: false }).series({ handle: "hhhhhhhhhhhh", scope: "pod", namespace: "shop", name: "new-pod", range: "1h" });
    expect(pod.source).toBe("none");
    expect(pod.reasons[1]).toEqual({ code: "cloud-monitoring-failed", message: "Cloud Monitoring (demo-shop) didn't answer: Google didn't answer in time." });
    // Landlens's own name check is still the page's 400.
    await expect(svc({ dep: use(answers().ask) }).series({ handle: "hhhhhhhhhhhh", scope: "pod", namespace: "shop", name: 'x"}', range: "1h" })).rejects.toMatchObject({ status: 400 });
  });

  it("whether the cluster has data is asked once in five minutes", async () => {
    let t = NOW;
    const off = answers({ nodes: [] });
    const s = new MetricsService({ clickland: () => ({ clusterName: (c) => c }), cluster: () => ({ context: "x", get: kube(true) }), cloudMonitoring: use(off.ask), now: () => t, sampler: { timers: { set: () => 1, clear: () => {} }, now: () => t } });
    await s.series(req);
    await s.series(req);
    const hasData = () => off.log.filter((q) => !q.includes("namespace_name")).length;
    expect(hasData()).toBe(5); // CPU and memory per node, twice, and one check, kept
    t += 300_001;
    await s.series(req);
    expect(hasData()).toBe(8);
  });

  it("an agent's call reads Google only for a project its session may read, and holds its autonomy before the first query", async () => {
    const order: string[] = [];
    const ask = vi.fn(async (q: string) => (order.push("ask"), answers().ask(q)));
    const without = await svc({ dep: use(ask) }).series(req, { agent: { projects: ["orbit-analytics"], hold: () => order.push("hold") } });
    expect(without.source).toBe("metrics-server");
    expect(without.reasons[1]).toEqual({ code: "cloud-monitoring-not-granted", message: NOT_GRANTED });
    expect(ask).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    const granted = await svc({ dep: use(ask) }).series(req, { agent: { projects: ["demo-shop"], hold: () => order.push("hold") } });
    expect(granted.source).toBe("cloud-monitoring");
    expect(order[0]).toBe("hold");
    expect(order.filter((x) => x === "hold")).toHaveLength(1);
    expect(order.length).toBeGreaterThan(2);
  });
});
