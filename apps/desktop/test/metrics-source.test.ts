// Main's Cloud Monitoring source (wave 9 part 2, D182–D183): the handle's own cluster decides, through GcpService.gkeOf
// only; an unchosen project and an unread listing are reasons; and a Claude session's metrics tool reads no Cloud
// Monitoring until part 4 gives it the grant's projects.
import { describe, expect, it, vi } from "vitest";
import { MetricsService } from "@landlens/metrics";
import { cloudMonitoringSource, sessionSeries } from "../src/main/metrics-source";

const NOW = Date.parse("2026-11-16T09:00:00Z");
const REF = { project: "demo-shop", location: "us-central1", name: "shop-prod" };
const TLS = { ca: "ab", insecure: false, serverName: false, proxy: false };
const clusters = { get: (h: string) => ({ info: { context: `ctx-${h}`, server: "https://203.0.113.17" }, sidecar: { tls: TLS } }) };
const node = { status: "success", data: { resultType: "matrix", result: [{ metric: { project_id: "demo-shop", location: "us-central1", cluster_name: "shop-prod", node_name: "gke-n-1" }, values: [[NOW / 1000, "1"]] }] } };

describe("cloudMonitoringSource", () => {
  it("asks gkeOf about the handle's own context, address, trust and how it was connected, and maps its answer", async () => {
    const ask = vi.fn();
    const gkeOf = vi.fn();
    const src = cloudMonitoringSource({ gkeOf, promAsk: () => ask } as never, clusters, new Set(["mine"]));
    gkeOf.mockResolvedValueOnce(REF);
    expect(await src("mine", {})).toEqual({ cluster: REF, ask });
    expect(gkeOf).toHaveBeenLastCalledWith({ context: "ctx-mine", server: "https://203.0.113.17", viaLandlens: true, tls: TLS }, { unread: true });
    gkeOf.mockResolvedValueOnce(undefined);
    expect(await src("yours", {})).toBeUndefined();
    expect(gkeOf.mock.calls.at(-1)![0]).toMatchObject({ context: "ctx-yours", viaLandlens: false });
    gkeOf.mockResolvedValueOnce({ hint: "This looks like a GKE cluster of demo-shop." });
    expect(await src("yours", {})).toEqual({ reason: { code: "cloud-monitoring-not-chosen", message: "This looks like a GKE cluster of demo-shop." } });
    gkeOf.mockResolvedValueOnce({ unread: "Landlens couldn't list demo-shop's GKE clusters to check that this is one of them: x" });
    expect(await src("yours", {})).toEqual({ reason: { code: "cloud-monitoring-failed", message: expect.stringMatching(/^Landlens couldn't list demo-shop's/) } });
  });
});

describe("sessionSeries", () => {
  it("a session's metrics tool reads the cluster with its own token and asks Google nothing (no grant covers metrics yet)", async () => {
    const ask = vi.fn(async () => node);
    const read = vi.fn(async (path: string): Promise<any> => (path === "/api/v1/nodes" ? { items: [] } : { items: [] }));
    const metrics = new MetricsService({
      clickland: () => ({ clusterName: (c) => c }),
      cluster: () => ({ context: "gke_demo-shop_us-central1_shop-prod", get: async () => Promise.reject(Object.assign(new Error("404"), { status: 404 })) }),
      cloudMonitoring: async () => ({ cluster: REF, ask }),
      now: () => NOW,
      sampler: { timers: { set: () => 1, clear: () => {} }, now: () => NOW },
    });
    const s = await sessionSeries(metrics)("hhhhhhhhhhhh", { scope: "cluster", range: "1h" }, read);
    expect(ask).not.toHaveBeenCalled();
    expect(s.source).toBe("none");
    expect(s.reasons.map((r) => r.code)).toContain("cloud-monitoring-not-granted");
    // The IDE's own charts (no agent) do read it.
    expect((await metrics.series({ handle: "hhhhhhhhhhhh", scope: "cluster", range: "1h" }, { read })).source).toBe("cloud-monitoring");
    expect(ask).toHaveBeenCalled();
  });
});
