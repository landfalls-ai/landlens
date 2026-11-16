// GKE's diagnosis recommender for one cluster (wave 9, D176) against the fake: only ACTIVE, only this cluster's (by
// project id or number, under locations/ or zones/), the join to recommendations, the deprecated APIs cut and
// cleaned, an odd shape still a row, and nothing but two GETs.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_FILTER, ADVICE_LIMIT_MS, ADVICE_PAGE, ADVICE_PAGES, clusterTargets, gkeAdvice, MAX_ADVICE } from "../src/recommender.js";
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
    const { items: rows } = await gkeAdvice(clientFor(fake).client, shop);
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
    const { items: rows } = await gkeAdvice(clientFor(fake).client, shop);
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
    expect((await gkeAdvice(clientFor(fake).client, shop)).items.map((r) => r.id).sort()).toEqual(["by-id", "by-number-zones", "two-targets"]);
    // Without the number, only by id.
    const { number: _n, ...noNumber } = shop;
    expect((await gkeAdvice(clientFor(fake).client, noNumber)).items.map((r) => r.id).sort()).toEqual(["by-id", "two-targets"]);
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
    const rows = Object.fromEntries((await gkeAdvice(clientFor(fake).client, shop)).items.map((r) => [r.id, r]));
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
    const rows = Object.fromEntries((await gkeAdvice(clientFor(fake).client, shop)).items.map((r) => [r.id, r]));
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

  it("shows at most 50, worst first, from every page it read", async () => {
    fake.advice.set("demo-shop/us-central1", {
      insights: Array.from({ length: 250 }, (_, i) => insight(`i${i}`, target("demo-shop"), { severity: i === 120 ? "CRITICAL" : i === 249 ? "CRITICAL" : "LOW" })),
      recommendations: [],
    });
    const { items: rows, cut } = await gkeAdvice(clientFor(fake).client, shop);
    expect(fake.hits("/insights").map((r) => r.query.pageToken)).toEqual([undefined, "100", "200"]);
    expect(rows).toHaveLength(MAX_ADVICE);
    expect(rows.slice(0, 2).map((r) => r.id).sort()).toEqual(["i120", "i249"]);
    expect(cut).toBe(false);
  });

  // M2 (review of part 1): the lists hold every cluster of the location. This test replaces one that expected a row
  // on page 3 to be dropped without a word.
  it("M2: reads up to ten pages; this cluster's row behind other clusters' is found; past the last page it says cut", async () => {
    const others = (n: number) => Array.from({ length: n }, (_, i) => insight(`o${i}`, target("demo-shop", "locations", "us-central1", `other-${i}`)));
    // 250 of other clusters, then shop-prod's critical one: found on the third page, nothing cut.
    fake.advice.set("demo-shop/us-central1", { insights: [...others(250), insight("mine", target("demo-shop"), { severity: "CRITICAL" })], recommendations: [] });
    let r = await gkeAdvice(clientFor(fake).client, shop);
    expect(r.items.map((a) => a.id)).toEqual(["mine"]);
    expect(r.cut).toBe(false);
    // A list that ends on exactly the tenth page isn't cut.
    fake.requests.length = 0;
    fake.advice.set("demo-shop/us-central1", { insights: others(ADVICE_PAGES * ADVICE_PAGE), recommendations: [] });
    r = await gkeAdvice(clientFor(fake).client, shop);
    expect(fake.hits("/insights")).toHaveLength(ADVICE_PAGES);
    expect(r).toEqual({ items: [], cut: false });
    // One more row than ten pages hold: shop-prod's is unread, and the answer says so instead of "nothing".
    fake.requests.length = 0;
    fake.advice.set("demo-shop/us-central1", { insights: [...others(ADVICE_PAGES * ADVICE_PAGE), insight("mine", target("demo-shop"))], recommendations: [] });
    r = await gkeAdvice(clientFor(fake).client, shop);
    expect(fake.hits("/insights")).toHaveLength(ADVICE_PAGES);
    expect(r).toEqual({ items: [], cut: true });
    // The recommendations' list cut is a cut too (a row's action may be on the unread page).
    const recs = Array.from({ length: ADVICE_PAGES * ADVICE_PAGE + 1 }, (_, i) => ({ name: `${base}/recommenders/${RECOMMENDER}/recommendations/r${i}`, stateInfo: { state: "ACTIVE" } }));
    fake.advice.set("demo-shop/us-central1", { insights: [insight("mine", target("demo-shop"))], recommendations: recs });
    r = await gkeAdvice(clientFor(fake).client, shop);
    expect(r.items.map((a) => a.id)).toEqual(["mine"]);
    expect(r.cut).toBe(true);
  });

  it("T1: each page asks with the recommender's own 10 s limit, below a client that allows longer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await gkeAdvice(clientFor(fake, { limitMs: 60_000 }).client, shop);
      expect(timeout.mock.calls.map((c) => c[0])).toEqual([ADVICE_LIMIT_MS, ADVICE_LIMIT_MS]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("L3 and T2: a user agent is redacted before it is cut, so a credential across the cut shows nothing of itself", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsYW5kbGVucy10ZXN0In0.c2lnbmF0dXJlLW9mLXRoZS10ZXN0";
    const key = `AIza${"Q".repeat(35)}`;
    const agents = [
      `kubectl/v1.33 ${jwt} (darwin)`, // short: the redaction itself
      `${"a".repeat(99)} ${jwt}`, // starts at 100, across the cut at 120
      `${"b".repeat(95)} ${key}`,
      `${"c".repeat(99)};${key}`,
    ];
    fake.advice.set("demo-shop/us-central1", {
      insights: [insight("dep", target("demo-shop"), {
        insightSubtype: "DEPRECATION_K8S_1_32_API",
        content: { apiDeprecationInsight: [{ api: "/apis/x/v1", deprecatedClientStats: agents.map((userAgent) => ({ userAgent })) }] },
      })],
      recommendations: [],
    });
    const { items } = await gkeAdvice(clientFor(fake).client, shop);
    const shown = items[0]!.apis![0]!.clients.map((c) => c.agent);
    expect(shown).toHaveLength(4);
    expect(shown[0]).toMatch(/^kubectl\/v1\.33 <redacted jwt> \(darwin\)$/);
    for (const a of shown) {
      expect(a).not.toMatch(/eyJ|AIza|QQQQ/);
      expect(Array.from(a).length).toBeLessThanOrEqual(120);
    }
  });

  it("L2: no astral format character, line separator or bidi override survives in a user agent, an API or a version", async () => {
    const hide = "\u{E0001}\u{E0049}\u{E0067}\u2028\u2029\u{1D173}\u202e";
    fake.advice.set("demo-shop/us-central1", {
      insights: [insight("dep", target("demo-shop"), {
        description: `Kubernetes 1.32 ${hide}stops serving`,
        insightSubtype: "DEPRECATION_K8S_1_32_API",
        content: { apiDeprecationInsight: [{ api: `/apis/x${hide}/v1`, stopServingVersion: `1.32${hide}`, deprecatedClientStats: [{ userAgent: `agent${hide}/1` }] }] },
      })],
      recommendations: [],
    });
    const { items } = await gkeAdvice(clientFor(fake).client, shop);
    const a = items[0]!;
    expect(a.description).toMatch(/^Kubernetes 1\.32 +stops serving$/); // U+2028 is whitespace there, so a space
    expect(a.apis![0]).toEqual({ api: "/apis/x/v1", stops: "1.32", clients: [{ agent: "agent /1" }] }); // a user agent's whitespace, U+2028 too, is one space
    expect(JSON.stringify(items)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("L5: a recommendation joins on the insight's whole name (the project by id or number), not its last segment", async () => {
    const byId = `projects/demo-shop/locations/us-central1/insightTypes/${INSIGHT_TYPE}/insights`;
    const rec = (id: string, insightName: string) => ({ name: `${base}/recommenders/${RECOMMENDER}/recommendations/${id}`, description: `do ${id}`, stateInfo: { state: "ACTIVE" }, associatedInsights: [{ insight: insightName }] });
    fake.advice.set("demo-shop/us-central1", {
      insights: [insight("same", target("demo-shop")), insight("by-id", target("demo-shop"))],
      recommendations: [
        // The same last segment under another insight type, another location, another project: none is this one's.
        rec("other-type", `${base}/insightTypes/google.compute.OtherInsight/insights/same`),
        rec("other-location", `projects/${NUM}/locations/europe-west1/insightTypes/${INSIGHT_TYPE}/insights/same`),
        rec("other-project", `projects/730284615592/locations/us-central1/insightTypes/${INSIGHT_TYPE}/insights/same`),
        rec("suffix", `x/${base}/insightTypes/${INSIGHT_TYPE}/insights/same`),
        // The project by id, where the insight is named by number: the same insight.
        rec("id-form", `${byId}/by-id`),
      ],
    });
    const rows = Object.fromEntries((await gkeAdvice(clientFor(fake).client, shop)).items.map((r) => [r.id, r]));
    expect(rows.same!.action).toBeUndefined();
    expect(rows["by-id"]!.action).toBe("do id-form");
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
    expect((await gkeAdvice(clientFor(fake).client, shop)).items.map((r) => r.id)).toEqual(["crit", "low-dep", "low-new", "low-old", "unknown"]);
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
