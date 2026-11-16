// Main's Cloud Monitoring source (wave 9 part 2, D182–D183): the handle's own cluster decides, through GcpService.gkeOf
// only; an unchosen project and an unread listing are reasons; and a Claude session's metrics tool reads no Cloud
// Monitoring until part 4 gives it the grant's projects.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MetricsService, NOT_GRANTED } from "@landlens/metrics";
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
    const src = cloudMonitoringSource({ gkeOf, promAsk: () => ask, chosenProjectOf: () => undefined } as never, clusters, new Set(["mine"]));
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

describe("Fable's security review of part 2, fixed", () => {
  const named = (context: string) => ({ get: () => ({ info: { context, server: "https://203.0.113.17" }, sidecar: { tls: TLS } }) });
  const PROD = "gke_demo-shop_us-central1_shop-prod";

  it("M1/T8: a session's call is decided from the context's name and the chosen projects before gkeOf", async () => {
    const gkeOf = vi.fn(async () => REF);
    const promAsk = vi.fn();
    const chosenProjectOf = vi.fn((c: string) => (c === PROD ? "demo-shop" : undefined));
    const gcp = { gkeOf, promAsk, chosenProjectOf } as never;
    // A chosen project the session may not read: not granted, and gkeOf (gcloud, the listing, the project search) never runs.
    expect(await cloudMonitoringSource(gcp, named(PROD), new Set())("h", { agent: { projects: [], hold: () => {} } })).toEqual({ reason: { code: "cloud-monitoring-not-granted", message: NOT_GRANTED } });
    expect(await cloudMonitoringSource(gcp, named(PROD), new Set(["h"]))("h", { agent: { projects: ["orbit-analytics"], hold: () => {} } })).toMatchObject({ reason: { code: "cloud-monitoring-not-granted" } });
    // Not chosen, or not GKE's name: nothing.
    expect(await cloudMonitoringSource(gcp, named("gke_orbit-analytics_us-central1_shop-prod"), new Set())("h", { agent: { projects: [], hold: () => {} } })).toBeUndefined();
    expect(await cloudMonitoringSource(gcp, named("orbstack"), new Set())("h", { agent: { projects: [], hold: () => {} } })).toBeUndefined();
    expect(gkeOf).not.toHaveBeenCalled();
    expect(promAsk).not.toHaveBeenCalled();
    // A project the session may read (part 4) goes on to gkeOf; the IDE's own charts always do.
    expect(await cloudMonitoringSource(gcp, named(PROD), new Set())("h", { agent: { projects: ["demo-shop"], hold: () => {} } })).toMatchObject({ cluster: REF });
    expect(await cloudMonitoringSource(gcp, named(PROD), new Set())("h", {})).toMatchObject({ cluster: REF });
    expect(gkeOf).toHaveBeenCalledTimes(2);
  });

  it("T3: index.ts gives the MCP service and the agent the session series, never MetricsService.series itself", () => {
    const src = readFileSync(resolve(__dirname, "../src/main/index.ts"), "utf8");
    expect(src).toMatch(/const series = sessionSeries\(metrics\);/);
    const ctor = (name: string) => {
      const at = src.indexOf(`new ${name}({`);
      expect(at, name).toBeGreaterThan(0);
      // The constructor's own object, up to its closing `});` at the same indentation.
      const end = src.indexOf("\n  });", at);
      return src.slice(at, end);
    };
    for (const name of ["McpService", "AgentService"]) {
      const body = ctor(name);
      expect(body.match(/\bmetrics:\s*([^,\n]+)/g), name).toEqual(["metrics: series"]);
    }
    // Nothing else hands MetricsService's own series to a session.
    expect(src).not.toMatch(/metrics\.series\b/);
  });
});
