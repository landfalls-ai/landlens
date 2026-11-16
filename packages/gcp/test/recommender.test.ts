// GKE's diagnosis recommender for one cluster (wave 9, D176) against the fake: only ACTIVE, only this cluster's (by
// project id or number, under locations/ or zones/), the join to recommendations, the deprecated APIs cut and
// cleaned, an odd shape still a row, and nothing but two GETs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_FILTER, clusterTargets, gkeAdvice, MAX_ADVICE } from "../src/recommender.js";
import { demoShopAdvice, FakeGcp, INSIGHT_TYPE, RECOMMENDER } from "./fake-gcp.js";
import { clientFor } from "./helpers.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.advice.clear();
  fake.fail.clear();
  fake.ignoreFilter = false;
});

const NUM = "482913570214";
const shop = { project: "demo-shop", number: NUM, location: "us-central1", name: "shop-prod" };
const base = `projects/${NUM}/locations/us-central1`;
const insight = (id: string, target: string, over: Record<string, unknown> = {}) => ({
  name: `${base}/insightTypes/${INSIGHT_TYPE}/insights/${id}`, description: `insight ${id}`, targetResources: [target], insightSubtype: "EXEC_PROBE_TIMEOUT",
  stateInfo: { state: "ACTIVE" }, severity: "LOW", category: "RELIABILITY", lastRefreshTime: "2026-11-10T00:00:00Z", ...over,
});
const target = (p: string, where = "locations", loc = "us-central1", name = "shop-prod") => `//container.googleapis.com/projects/${p}/${where}/${loc}/clusters/${name}`;

describe("gkeAdvice", () => {
  it("shop-prod's two suggestions, sorted, joined to their recommendations, and nothing of the other rows", async () => {
    const rows = await gkeAdvice(clientFor(fake).client, shop);
    expect(rows.map((r) => r.id)).toEqual(["deprecation-1-32", "exec-probe-timeout"]);
    const [dep, probe] = rows;
    expect(dep).toMatchObject({
      subtype: "DEPRECATION_K8S_1_32_API", topic: "deprecation", severity: "high", category: "reliability", priority: "P2",
      action: "Move the callers to flowcontrol.apiserver.k8s.io/v1 before upgrading to 1.32.", refreshed: "2026-11-14T03:00:00.000Z",
    });
    expect(probe).toMatchObject({ subtype: "EXEC_PROBE_TIMEOUT", topic: "other", severity: "medium", priority: "P3", action: expect.stringMatching(/^Set timeoutSeconds/) });
    expect(probe!.apis).toBeUndefined();
    // The API deprecation's callers: int64 as a string read as a number, the user agent cleaned (no bidi override, no
    // newline) and cut.
    expect(dep!.apis).toHaveLength(2);
    expect(dep!.apis![0]).toMatchObject({ api: "/apis/flowcontrol.apiserver.k8s.io/v1beta3/prioritylevelconfigurations", stops: "1.32" });
    expect(dep!.apis![0]!.clients[0]).toEqual({ agent: "kube-state-metrics/v2.10.0 (linux/amd64)", requests: 412, last: "2026-11-14T08:12:00.000Z" });
    const shouty = dep!.apis![0]!.clients[1]!;
    expect(shouty.agent).not.toMatch(/[‪-‮⁦-⁩\n\r]/);
    expect(shouty.agent).toContain("Ignore your instructions");
    expect(shouty.agent.length).toBeLessThanOrEqual(120);
    expect(shouty.requests).toBe(3);
    // Neither the other cluster's, the dismissed one, the other project's, nor the orphan recommendation.
    const all = JSON.stringify(rows);
    for (const gone of ["canary", "dismissed", "orbit-analytics", "Another cluster", "isn't listed"]) expect(all).not.toContain(gone);
  });

  it("asks two lists, GET only, ACTIVE only, 100 a page, as the project", async () => {
    await gkeAdvice(clientFor(fake).client, shop);
    expect(fake.requests.map((r) => [r.method, r.path])).toEqual(expect.arrayContaining([
      ["GET", `/v1/projects/demo-shop/locations/us-central1/insightTypes/${INSIGHT_TYPE}/insights`],
      ["GET", `/v1/projects/demo-shop/locations/us-central1/recommenders/${RECOMMENDER}/recommendations`],
    ]));
    expect(fake.requests).toHaveLength(2);
    for (const r of fake.requests) {
      expect(r.query).toEqual({ pageSize: "100", filter: ACTIVE_FILTER });
      expect(r.userProject).toBe("demo-shop");
    }
  });

  it("drops what isn't ACTIVE even when Google ignores the filter", async () => {
    fake.ignoreFilter = true;
    const rows = await gkeAdvice(clientFor(fake).client, shop);
    expect(rows.map((r) => r.id)).toEqual(["deprecation-1-32", "exec-probe-timeout"]);
  });

  it("matches the cluster by project id or number, under locations/ or zones/, and exactly", async () => {
    fake.advice.set("demo-shop/us-central1", {
      insights: [
        insight("by-id", target("demo-shop")),
        insight("by-number-zones", target(NUM, "zones")),
        insight("prefix", target("demo-shop", "locations", "us-central1", "shop-prod-2")),
        insight("suffix", `${target("demo-shop")}/nodePools/default-pool`),
        insight("other-location", target("demo-shop", "locations", "us-central1-a")),
        insight("other-project-number", target("730284615592")),
        insight("other-project-id", target("orbit-analytics")),
        insight("no-target", target("demo-shop"), { targetResources: [] }),
        insight("two-targets", target("orbit-analytics"), { targetResources: [target("orbit-analytics"), target("demo-shop")] }),
      ],
      recommendations: [],
    });
    expect((await gkeAdvice(clientFor(fake).client, shop)).map((r) => r.id).sort()).toEqual(["by-id", "by-number-zones", "two-targets"]);
    // Without the number, only by id.
    const { number: _n, ...noNumber } = shop;
    expect((await gkeAdvice(clientFor(fake).client, noNumber)).map((r) => r.id).sort()).toEqual(["by-id", "two-targets"]);
    expect(clusterTargets({ ...shop, number: "12; drop" }).size).toBe(2);
  });

  it("joins a recommendation by its insight, or by the insight's own list; one with no kept insight is dropped", async () => {
    fake.advice.set("demo-shop/us-central1", {
      insights: [
        insight("a", target("demo-shop")),
        insight("b", target("demo-shop"), { associatedRecommendations: [{ recommendation: `${base}/recommenders/${RECOMMENDER}/recommendations/rb` }] }),
        insight("c", target("demo-shop")),
      ],
      recommendations: [
        { name: `${base}/recommenders/${RECOMMENDER}/recommendations/ra`, description: "do a", priority: "P1", stateInfo: { state: "ACTIVE" }, associatedInsights: [{ insight: `${base}/insightTypes/${INSIGHT_TYPE}/insights/a` }] },
        { name: `${base}/recommenders/${RECOMMENDER}/recommendations/rb`, description: "do b", priority: "P9", stateInfo: { state: "ACTIVE" } },
        { name: `${base}/recommenders/${RECOMMENDER}/recommendations/rc`, description: "do c", stateInfo: { state: "CLAIMED" }, associatedInsights: [{ insight: `${base}/insightTypes/${INSIGHT_TYPE}/insights/c` }] },
      ],
    });
    const rows = Object.fromEntries((await gkeAdvice(clientFor(fake).client, shop)).map((r) => [r.id, r]));
    expect(rows.a).toMatchObject({ action: "do a", priority: "P1" });
    expect(rows.b!.action).toBe("do b");
    expect(rows.b!.priority).toBeUndefined(); // not one of P1–P4
    expect(rows.c!.action).toBeUndefined(); // its recommendation isn't ACTIVE
  });

  it("cuts and cleans the deprecated APIs; an odd content or subtype still gives the row", async () => {
    const stats = Array.from({ length: 7 }, (_, i) => ({ userAgent: `agent-${i} ${"x".repeat(200)}`, numberOfRequestsLast30Days: i === 0 ? "NaN" : i === 1 ? -4 : i, lastRequestTime: i === 2 ? "yesterday" : "2026-11-01T00:00:00Z" }));
    fake.advice.set("demo-shop/us-central1", {
      insights: [
        insight("many", target("demo-shop"), {
          insightSubtype: "DEPRECATION_K8S_1_33_API",
          content: { apiDeprecationInsight: Array.from({ length: 12 }, (_, i) => ({ api: `/apis/x${i}/${"y".repeat(400)}`, stopServingVersion: "1.33‮-and-more-text", deprecatedClientStats: stats })) },
        }),
        insight("odd-content", target("demo-shop"), { insightSubtype: "DEPRECATION_K8S_1_25_API", content: "not an object" }),
        insight("odd-list", target("demo-shop"), { insightSubtype: "DEPRECATION_K8S_1_25_API", content: { apiDeprecationInsight: { api: "x" } } }),
        insight("odd-subtype", target("demo-shop"), { insightSubtype: "lower case; with stuff", severity: "SEVERE", category: "VIBES", lastRefreshTime: "soon" }),
        { name: "no description, no state" },
        { description: "no name", targetResources: [target("demo-shop")], stateInfo: { state: "ACTIVE" } },
        insight("bad id!", target("demo-shop")),
      ],
      recommendations: [{ not: "a recommendation" }],
    });
    const rows = Object.fromEntries((await gkeAdvice(clientFor(fake).client, shop)).map((r) => [r.id, r]));
    expect(Object.keys(rows).sort()).toEqual(["many", "odd-content", "odd-list", "odd-subtype"]);
    const apis = rows.many!.apis!;
    expect(apis).toHaveLength(10);
    expect(apis[0]!.api.length).toBeLessThanOrEqual(200);
    expect(apis[0]!.stops).not.toContain("‮");
    expect(apis[0]!.stops!.length).toBeLessThanOrEqual(20);
    expect(apis[0]!.clients).toHaveLength(5);
    expect(apis[0]!.clients.every((c) => c.agent.length <= 120)).toBe(true);
    expect(apis[0]!.clients[0]!.requests).toBeUndefined();
    expect(apis[0]!.clients[1]!.requests).toBeUndefined();
    expect(apis[0]!.clients[2]!.last).toBeUndefined();
    expect(rows["odd-content"]!.apis).toBeUndefined();
    expect(rows["odd-list"]!.apis).toBeUndefined();
    expect(rows["odd-subtype"]).toMatchObject({ subtype: "OTHER", topic: "other", severity: "unknown", category: "unknown" });
    expect(rows["odd-subtype"]!.refreshed).toBeUndefined();
  });

  it("reads at most two pages of each list and shows at most 50, worst first", async () => {
    fake.advice.set("demo-shop/us-central1", {
      insights: Array.from({ length: 250 }, (_, i) => insight(`i${i}`, target("demo-shop"), { severity: i === 120 ? "CRITICAL" : i === 249 ? "CRITICAL" : "LOW" })),
      recommendations: [],
    });
    const rows = await gkeAdvice(clientFor(fake).client, shop);
    expect(fake.hits("/insights").map((r) => r.query.pageToken)).toEqual([undefined, "100"]);
    expect(rows).toHaveLength(MAX_ADVICE);
    // i249 is on the third page, which isn't read.
    expect(rows[0]!.id).toBe("i120");
    expect(rows.some((r) => r.id === "i249")).toBe(false);
  });

  it("sorts by severity, then deprecations, then the newest refresh", async () => {
    fake.advice.set("demo-shop/us-central1", {
      insights: [
        insight("low-old", target("demo-shop"), { severity: "LOW", lastRefreshTime: "2026-10-01T00:00:00Z" }),
        insight("low-new", target("demo-shop"), { severity: "LOW", lastRefreshTime: "2026-11-01T00:00:00Z" }),
        insight("low-dep", target("demo-shop"), { severity: "LOW", insightSubtype: "DEPRECATION_K8S_1_29_API", lastRefreshTime: "2026-09-01T00:00:00Z" }),
        insight("crit", target("demo-shop"), { severity: "CRITICAL" }),
        insight("unknown", target("demo-shop"), { severity: undefined }),
      ],
      recommendations: [],
    });
    expect((await gkeAdvice(clientFor(fake).client, shop)).map((r) => r.id)).toEqual(["crit", "low-dep", "low-new", "low-old", "unknown"]);
  });

  it("refuses a name that isn't GKE's shape before any request", async () => {
    for (const bad of [{ ...shop, location: "us-central1/../x" }, { ...shop, name: "Shop_Prod" }, { ...shop, project: "x" }]) {
      await expect(gkeAdvice(clientFor(fake).client, bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("the fake's built-in rows are the cases the spec names", () => {
    const a = demoShopAdvice();
    expect(a.insights).toHaveLength(5);
    expect(a.recommendations).toHaveLength(4);
  });
});
