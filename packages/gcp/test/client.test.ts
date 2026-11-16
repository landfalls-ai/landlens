// The client (D85–D87, D174): GET only, to five fixed origins and no other; a call may lower its limits, never raise them.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endpointsFor, GOOGLE_ENDPOINTS, GcpClient } from "../src/client.js";
import { SENTENCES } from "../src/errors.js";
import { gkeAdvice } from "../src/recommender.js";
import { searchProjects } from "../src/assets.js";
import { listClusters } from "../src/gke.js";
import { FakeGcp, GCP_TOKEN } from "./fake-gcp.js";
import { clientFor } from "./helpers.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.slowMs = 0;
});

const failWith = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    return e as Error & { status: number };
  }
  throw new Error("did not fail");
};

describe("five origins and no other", () => {
  it("Google's five hosts, each https, and the override points all five at the loopback fake", () => {
    expect(GOOGLE_ENDPOINTS).toEqual({
      resourceManager: "https://cloudresourcemanager.googleapis.com",
      cloudAsset: "https://cloudasset.googleapis.com",
      container: "https://container.googleapis.com",
      monitoring: "https://monitoring.googleapis.com",
      recommender: "https://recommender.googleapis.com",
    });
    const ep = endpointsFor("http://127.0.0.1:4000");
    expect(Object.keys(ep)).toHaveLength(5);
    expect(new Set(Object.values(ep))).toEqual(new Set(["http://127.0.0.1:4000"]));
    expect(() => endpointsFor("https://monitoring.googleapis.com")).toThrow(/127\.0\.0\.1/);
  });

  it("a sixth origin is refused before anything is asked", async () => {
    let asked = 0;
    const fetchSpy: typeof fetch = (...a) => (asked++, fetch(...a));
    const { client } = clientFor(fake, { fetch: fetchSpy });
    for (const path of ["https://logging.googleapis.com/v2/entries:list", "http://127.0.0.1:1/x", "//evil.example/v1/x"]) {
      expect((await failWith(() => client.get("monitoring", path, {}, "demo-shop"))).message).toBe(SENTENCES.unreachable);
    }
    expect(asked).toBe(0);
    expect(fake.requests).toHaveLength(0);
    // Google's own client refuses the fake's origin too.
    const real = new GcpClient({ auth: { token: async () => GCP_TOKEN, drop: () => {} }, fetch: fetchSpy });
    expect((await failWith(() => real.get("recommender", `${fake.origin}/v1/x`, {}))).message).toBe(SENTENCES.unreachable);
    expect(asked).toBe(0);
  });

  it("every request of every API is a GET", async () => {
    const { client } = clientFor(fake);
    await searchProjects(client);
    await listClusters(client, "demo-shop");
    await gkeAdvice(client, { project: "demo-shop", number: "482913570214", location: "us-central1", name: "shop-prod" });
    await client.get("monitoring", "/v3/projects/demo-shop/alerts", {}, "demo-shop").catch(() => undefined);
    expect(fake.requests.length).toBeGreaterThanOrEqual(5);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("the package's source sends no other method", () => {
    const dir = resolve(__dirname, "../src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("client.ts");
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/["'`](?:POST|PUT|PATCH|DELETE)["'`]/);
      for (const m of src.matchAll(/method:\s*([^,}\n]+)/g)) expect(m[1]!.trim(), f).toBe('"GET"');
    }
  });
});

describe("a call's limits (D174)", () => {
  it("can lower the time limit, and can't raise it", async () => {
    fake.slowMs = 300;
    const { client } = clientFor(fake);
    expect((await failWith(() => client.get("cloudresourcemanager", "/v3/projects:search", {}, undefined, { limitMs: 100 }))).message).toBe(SENTENCES.timeout);
    const tight = clientFor(fake, { limitMs: 100 }).client;
    expect((await failWith(() => tight.get("cloudresourcemanager", "/v3/projects:search", {}, undefined, { limitMs: 60_000 }))).message).toBe(SENTENCES.timeout);
    fake.slowMs = 0;
    await expect(client.get("cloudresourcemanager", "/v3/projects:search", {}, undefined, { limitMs: 5_000 })).resolves.toBeTruthy();
  });

  it("can lower the size limit, and can't raise it", async () => {
    const big = "/v1/projects/orbit-analytics:searchAllResources";
    const { client } = clientFor(fake);
    await expect(client.get("cloudasset", big, { pageSize: "500" }, "orbit-analytics")).resolves.toBeTruthy();
    expect((await failWith(() => client.get("cloudasset", big, { pageSize: "500" }, "orbit-analytics", { maxBytes: 2048 }))).message).toBe(SENTENCES.tooBig);
    const small = clientFor(fake, { maxBytes: 2048 }).client;
    expect((await failWith(() => small.get("cloudasset", big, { pageSize: "500" }, "orbit-analytics", { maxBytes: 64 * 1024 * 1024 }))).message).toBe(SENTENCES.tooBig);
  });

  it("L4 (review of wave 9 part 1): a limit that isn't a finite number above 0 is ignored, never lifting the cap", async () => {
    const big = "/v1/projects/orbit-analytics:searchAllResources";
    const small = clientFor(fake, { maxBytes: 2048 }).client;
    for (const maxBytes of [NaN, -1, 0, Infinity]) {
      const e = await failWith(() => small.get("cloudasset", big, { pageSize: "500" }, "orbit-analytics", { maxBytes }));
      expect(e.message, String(maxBytes)).toBe(SENTENCES.tooBig);
    }
    // A NaN or negative time limit is the client's own: the call still runs, and still stops at the client's limit.
    const { client } = clientFor(fake);
    for (const limitMs of [NaN, -1, 0]) await expect(client.get("cloudresourcemanager", "/v3/projects:search", {}, undefined, { limitMs }), String(limitMs)).resolves.toBeTruthy();
    fake.slowMs = 300;
    const tight = clientFor(fake, { limitMs: 100 }).client;
    expect((await failWith(() => tight.get("cloudresourcemanager", "/v3/projects:search", {}, undefined, { limitMs: NaN }))).message).toBe(SENTENCES.timeout);
    fake.slowMs = 0;
  });
});
