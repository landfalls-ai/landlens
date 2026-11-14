import { describe, expect, it } from "vitest";
import { MetricsService } from "../src/service.js";
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
    expect(f.calls[0]!.body.where["k8s.cluster.name"]).toBe("dev-cluster");
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
    expect(t.steps.map((s) => s.name)).toEqual(["Health", "Query"]);
    expect(f.calls[1]!.body.where).toEqual({ "k8s.cluster.name": "orbstack" });
  });

  it("fails on a refused key or no data, saying which", async () => {
    const denied = await service({ fetchImpl: fakeClickland({ status: 403 }).fetchImpl }).test({ url: "http://127.0.0.1:4710", key: KEY });
    expect(denied.ok).toBe(false);
    expect(denied.steps.at(-1)!.detail).toContain("read scope");
    const none = await service({ fetchImpl: fakeClickland().fetchImpl }).test({ url: "http://127.0.0.1:4710", key: KEY, cluster: "nope" });
    expect(none.steps.at(-1)).toMatchObject({ ok: false, detail: expect.stringContaining("“nope”") });
    expect((await service({}).test({})).ok).toBe(false);
  });
});
