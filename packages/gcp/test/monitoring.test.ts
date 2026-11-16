// Cloud Monitoring's PromQL transport (wave 9, D179) against the fake: query_range only, GET only, as the project; a
// query too long or a range that isn't one refused before a request; a refused query a fixed sentence whose text holds
// nothing of the query or Google's echo; and the fake behaving as a metrics scope (D197), so the filter in
// packages/metrics has something to drop.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rawGcpError, SENTENCES } from "../src/errors.js";
import { PROM_LIMIT_MS, PROM_QUERY_MAX, promRange } from "../src/monitoring.js";
import { FakeGcp, GCP_TOKEN, PROMQL_MARKER } from "./fake-gcp.js";
import { clientFor } from "./helpers.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.fail.clear();
  fake.leak = false;
});

const T0 = Date.parse("2026-11-16T09:00:00Z");
const S = 'project_id="demo-shop",location="us-central1",cluster_name="shop-prod"';
const G = "project_id,location,cluster_name";
const NODE_CPU = `sum by (${G},node_name) (rate(kubernetes_io:node_cpu_core_usage_time{${S}}[300s]))`;
type Matrix = { status: string; data: { resultType: string; result: { metric: Record<string, string>; values: [number, string][] }[] } };
const failWith = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    return e as Error & { status: number; raw: string };
  }
  throw new Error("did not fail");
};

describe("promRange", () => {
  it("GETs query_range on the project's PromQL endpoint, as the project, with the range in seconds", async () => {
    const out = (await promRange(clientFor(fake).client, "demo-shop", NODE_CPU, T0 - 3_600_000, T0, 60)) as Matrix;
    expect(fake.requests).toHaveLength(1);
    const r = fake.requests[0]!;
    expect(r).toMatchObject({ method: "GET", path: "/v1/projects/demo-shop/location/global/prometheus/api/v1/query_range", userProject: "demo-shop", authorization: `Bearer ${GCP_TOKEN}` });
    expect(r.query).toEqual({ query: NODE_CPU, start: String((T0 - 3_600_000) / 1000), end: String(T0 / 1000), step: "60" });
    expect(out.status).toBe("success");
    expect(out.data.result.map((s) => s.metric.node_name).sort()).toEqual(["gke-shop-prod-default-pool-1a2b", "gke-shop-prod-default-pool-3c4d"]);
    expect(out.data.result[0]!.values).toHaveLength(61);
  });

  it("asks with its own 10 s limit, under a client whose own limit is longer", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await promRange(clientFor(fake, { limitMs: 60_000 }).client, "demo-shop", NODE_CPU, T0 - 3_600_000, T0, 60);
      expect(spy).toHaveBeenCalledWith(PROM_LIMIT_MS);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a query too long, an empty one, a range that isn't one, or a project that isn't an id, before any request", async () => {
    const { client } = clientFor(fake);
    const long = `${NODE_CPU}${" ".repeat(PROM_QUERY_MAX)}`;
    expect(await failWith(() => promRange(client, "demo-shop", long, T0 - 1, T0, 60))).toMatchObject({ status: 400 });
    expect(await failWith(() => promRange(client, "demo-shop", "", T0 - 1, T0, 60))).toMatchObject({ status: 400 });
    expect(await failWith(() => promRange(client, "demo-shop", NODE_CPU, T0, T0 - 1, 60))).toMatchObject({ status: 400 });
    expect(await failWith(() => promRange(client, "demo-shop", NODE_CPU, NaN, T0, 60))).toMatchObject({ status: 400 });
    expect(await failWith(() => promRange(client, "demo-shop", NODE_CPU, T0 - 1, T0, 0))).toMatchObject({ status: 400 });
    expect(await failWith(() => promRange(client, "demo-shop/../orbit-analytics", NODE_CPU, T0 - 1, T0, 60))).toMatchObject({ status: 400 });
    expect(fake.requests).toHaveLength(0);
  });

  it("a query Google refuses is the fixed sentence: neither it nor the log line holds the query or Google's echo", async () => {
    const q = `sum by (${G}) (rate(kubernetes_io:node_memory_used_bytes{${S}}[300s]))`; // rate() over a gauge
    const e = await failWith(() => promRange(clientFor(fake).client, "demo-shop", q, T0 - 3_600_000, T0, 60));
    expect(e).toMatchObject({ status: 400, message: SENTENCES.query });
    const log = rawGcpError(e);
    for (const text of [e.message, log]) {
      expect(text).not.toContain(PROMQL_MARKER);
      expect(text).not.toContain("kubernetes_io");
      expect(text).not.toContain("demo-shop");
    }
    // Prometheus's own errorType reaches the log, as a word.
    expect(log).toContain("bad_data");
  });

  it("a disabled API or a missing role is its sentence", async () => {
    fake.fail.set("demo-shop", { status: 403, reason: "SERVICE_DISABLED", api: "monitoring" });
    expect((await failWith(() => promRange(clientFor(fake).client, "demo-shop", NODE_CPU, T0 - 1, T0, 60))).message).toBe(
      "The Cloud Monitoring API is off in demo-shop. Turn it on: `gcloud services enable monitoring.googleapis.com --project demo-shop`.",
    );
    fake.fail.set("demo-shop", { status: 403, api: "monitoring" });
    expect((await failWith(() => promRange(clientFor(fake).client, "demo-shop", NODE_CPU, T0 - 1, T0, 60))).message).toBe(
      "Your account can't read Cloud Monitoring in demo-shop (it needs Monitoring Viewer).",
    );
  });
});

describe("the fake as a metrics scope (D197)", () => {
  const ask = (q: string) => promRange(clientFor(fake).client, "demo-shop", q, T0 - 600_000, T0, 60) as Promise<Matrix>;
  const ids = (m: Matrix) => [...new Set(m.data.result.map((s) => `${s.metric.project_id}/${s.metric.location}/${s.metric.cluster_name}`))].sort();

  it("a query without the identity matchers answers for every cluster of the scope, with their labels", async () => {
    const all = await ask(`sum by (${G},node_name) (rate(kubernetes_io:node_cpu_core_usage_time{}[300s]))`);
    expect(ids(all)).toEqual(["demo-shop/europe-west1-b/shop-staging", "demo-shop/us-central1/shop-prod", "orbit-analytics/us-central1/shop-prod"]);
    // Only the location and name: another project's cluster of the same name and location answers too.
    const named = await ask(`sum by (${G},node_name) (rate(kubernetes_io:node_cpu_core_usage_time{location="us-central1",cluster_name="shop-prod"}[300s]))`);
    expect(ids(named)).toEqual(["demo-shop/us-central1/shop-prod", "orbit-analytics/us-central1/shop-prod"]);
    // All three matchers: this cluster only; with `leak`, every cluster again.
    expect(ids(await ask(NODE_CPU))).toEqual(["demo-shop/us-central1/shop-prod"]);
    fake.leak = true;
    expect(ids(await ask(NODE_CPU))).toHaveLength(3);
  });

  it("reads matchers, a pod regex with escaped dots, memory_type and sum by", async () => {
    const pods = await ask(`sum by (${G},pod_name) (kubernetes_io:container_memory_used_bytes{${S},namespace_name="shop",pod_name=~"orders-api-7c9f-x2x4q|cart-6d5b-9wq7z",memory_type="non-evictable"})`);
    expect(pods.data.result.map((s) => s.metric.pod_name).sort()).toEqual(["cart-6d5b-9wq7z", "orders-api-7c9f-x2x4q"]);
    const dotted = await ask(`sum by (${G},pod_name) (kubernetes_io:container_memory_used_bytes{${S},pod_name=~"orders-api-7c9f-x2x4q\\\\.x"})`);
    expect(dotted.data.result).toEqual([]);
    const ns = await ask(`sum by (${G},namespace_name) (rate(kubernetes_io:container_cpu_core_usage_time{${S}}[300s]))`);
    expect(ns.data.result.map((s) => s.metric.namespace_name).sort()).toEqual(["kube-system", "monitoring", "shop"]);
    expect(Object.keys(ns.data.result[0]!.metric).sort()).toEqual(["cluster_name", "location", "namespace_name", "project_id"]);
  });

  it("refuses an unknown metric, a rate over a gauge, and any path but query_range or any method but GET", async () => {
    expect(await failWith(() => ask(`sum by (${G}) (kubernetes_io:container_restart_count{${S}})`))).toMatchObject({ status: 400 });
    for (const path of ["api/v1/query", "api/v1/series", "api/v1/labels"]) {
      const r = await fetch(`${fake.origin}/v1/projects/demo-shop/location/global/prometheus/${path}?query=up`, { headers: { Authorization: `Bearer ${GCP_TOKEN}` } });
      expect(r.status, path).toBe(405);
    }
    const post = await fetch(`${fake.origin}/v1/projects/demo-shop/location/global/prometheus/api/v1/query_range`, { method: "POST", headers: { Authorization: `Bearer ${GCP_TOKEN}` }, body: "query=up" });
    expect(post.status).toBe(405);
  });
});
