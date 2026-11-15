// Projects and resources against the fake (D87): paging, the caps, the drawer's JSON, the names checked before they
// reach a path or a query, and where the token went.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clean, countTypes, getResource, MAX_JSON, READ_MASK, searchProjects, searchResources, serviceOf, toResource } from "../src/assets.js";
import { GcpClient, endpointsFor, GOOGLE_ENDPOINTS } from "../src/client.js";
import { GcpError, SENTENCES } from "../src/errors.js";
import { listClusters } from "../src/gke.js";
import { FakeGcp, GCP_TOKEN } from "./fake-gcp.js";
import { clientFor } from "./helpers.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.fail.clear();
  fake.slowMs = 0;
  fake.redirect = undefined;
  fake.projectsPageSize = 500;
});

describe("projects:search", () => {
  it("lists the active projects you can see, every page, with the token and no user project", async () => {
    fake.projectsPageSize = 2;
    const { projects, cut } = await searchProjects(clientFor(fake).client);
    expect(cut).toBe(false);
    expect(projects.map((p) => p.id)).toEqual(["demo-shop", "orbit-analytics", "archive-vault", "payments-core", "ml-sandbox-42"]);
    expect(projects[0]).toEqual({ id: "demo-shop", name: "Demo Shop", number: "482913570214" });
    expect(fake.hits("projects:search")).toHaveLength(3);
    expect(fake.requests.every((r) => r.authorization === `Bearer ${GCP_TOKEN}` && r.method === "GET" && !r.userProject)).toBe(true);
  });
});

describe("searchAllResources", () => {
  it("reads a realistic project with its fields, sends the project as X-Goog-User-Project and asks for the read mask", async () => {
    const { items, cut } = await searchResources(clientFor(fake).client, "demo-shop");
    expect(cut).toBe(false);
    expect(items.length).toBe(fake.assets("demo-shop").length);
    const vm = items.find((r) => r.name.endsWith("/instances/web-frontend-1"))!;
    expect(vm).toMatchObject({ assetType: "compute.googleapis.com/Instance", displayName: "web-frontend-1", location: "us-central1-a", state: "RUNNING", labels: { env: "prod" } });
    expect(fake.requests[0]!.userProject).toBe("demo-shop");
    expect(fake.requests[0]!.query).toMatchObject({ pageSize: "500", readMask: READ_MASK });
    const types = countTypes(items);
    expect(types.length).toBeGreaterThan(20);
    expect(types.find((t) => t.assetType === "sqladmin.googleapis.com/Instance")?.count).toBe(4);
  });

  it("pages 500 at a time (1,200 resources: 3 pages)", async () => {
    const { items, cut } = await searchResources(clientFor(fake).client, "orbit-analytics");
    expect(items).toHaveLength(1200);
    expect(cut).toBe(false);
    expect(fake.hits("searchAllResources").map((r) => r.query.pageToken ?? "")).toEqual(["", "500", "1000"]);
  });

  it("stops at 10 pages, 5,000 resources, and says cut", async () => {
    const { items, cut } = await searchResources(clientFor(fake).client, "archive-vault");
    expect(items).toHaveLength(5000);
    expect(cut).toBe(true);
    expect(fake.hits("searchAllResources")).toHaveLength(10);
  });

  it("passes the person's query and an asset type as they are", async () => {
    const { items } = await searchResources(clientFor(fake).client, "demo-shop", { query: "state:TERMINATED", assetType: "compute.googleapis.com/Instance" });
    expect(items.map((r) => r.displayName)).toEqual(["staging-worker-1", "load-test-runner"]);
    expect(fake.requests[0]!.query).toMatchObject({ query: "state:TERMINATED", assetTypes: "compute.googleapis.com/Instance" });
  });

  it("refuses names that aren't Google's shapes before any request", async () => {
    const { client } = clientFor(fake);
    for (const p of ["Demo-Shop", "demo", "demo-shop/../x", "demo-shop:x", "a".repeat(31)]) await expect(searchResources(client, p)).rejects.toThrow(GcpError);
    await expect(searchResources(client, "demo-shop", { assetType: "compute.googleapis.com/../Instance" })).rejects.toThrow(/asset type/);
    await expect(searchResources(client, "demo-shop", { query: "a\nb" })).rejects.toThrow(/one line/);
    await expect(getResource(client, "demo-shop", '//compute.googleapis.com/x" OR name:*')).rejects.toThrow(/resource name/);
    await expect(getResource(client, "demo-shop", "//compute.googleapis.com/a\\b")).rejects.toThrow(/resource name/);
    await expect(getResource(client, "demo-shop", "compute.googleapis.com/no-slashes")).rejects.toThrow(/resource name/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("one resource", () => {
  it("asks for that exact name with versionedResources and gives the resource's own JSON", async () => {
    const name = "//compute.googleapis.com/projects/demo-shop/zones/us-central1-a/instances/web-frontend-1";
    const r = (await getResource(clientFor(fake).client, "demo-shop", name))!;
    expect(r.resource.name).toBe(name);
    expect(JSON.parse(r.json!)).toMatchObject({ name: "web-frontend-1", machineType: expect.stringContaining("e2-standard-4") });
    expect(r.cut).toBe(false);
    expect(fake.requests[0]!.query).toMatchObject({ query: `name="${name}"`, pageSize: "1", readMask: `${READ_MASK},versionedResources` });
  });

  it("cuts the JSON at 256 KB, and shows none when the type has no versioned resource", async () => {
    const big = fake.assets("demo-shop").find((a) => a.assetType === "cloudkms.googleapis.com/KeyRing")!;
    big.resource = { blob: "x".repeat(MAX_JSON + 10) };
    const r = (await getResource(clientFor(fake).client, "demo-shop", big.name))!;
    expect(r.cut).toBe(true);
    expect(r.json!.length).toBe(MAX_JSON);
    const none = fake.assets("demo-shop").find((a) => a.assetType === "pubsub.googleapis.com/Topic")!;
    delete none.resource;
    const n = (await getResource(clientFor(fake).client, "demo-shop", none.name))!;
    expect(n.json).toBeUndefined();
    expect(await getResource(clientFor(fake).client, "demo-shop", "//storage.googleapis.com/nothing-here")).toBeUndefined();
  });
});

describe("what reaches the page", () => {
  it("cuts strings to 300, strips control and format characters, keeps 20 labels", () => {
    const labels = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`]));
    const r = toResource({ name: "//x/y", assetType: "compute.googleapis.com/Instance", displayName: `a‮b​c\u0007${"d".repeat(400)}`, labels });
    expect(r.displayName!.startsWith("abc")).toBe(true);
    expect(r.displayName!.length).toBe(300);
    expect(Object.keys(r.labels!)).toHaveLength(20);
    expect(clean("ok⁦x")).toBe("okx");
  });

  it("refuses an answer that isn't Cloud Asset's shape", async () => {
    const f: typeof fetch = async () => new Response(JSON.stringify({ results: [{ nope: 1 }] }), { status: 200 });
    await expect(searchResources(clientFor(fake, { fetch: f }).client, "demo-shop")).rejects.toThrow(SENTENCES.answer);
  });

  it("groups types by their service", () => {
    expect(serviceOf("compute.googleapis.com/Instance")).toBe("compute");
    expect(serviceOf("sqladmin.googleapis.com/Instance")).toBe("sqladmin");
  });
});

describe("the client's limits", () => {
  it("goes only to the configured origins, never follows a redirect, and stops reading past the cap", async () => {
    fake.redirect = "http://127.0.0.1:9/elsewhere";
    await expect(searchProjects(clientFor(fake).client)).rejects.toThrow(SENTENCES.redirect);
    fake.redirect = undefined;
    await expect(searchResources(clientFor(fake, { maxBytes: 4096 }).client, "demo-shop")).rejects.toThrow(SENTENCES.tooBig);
    fake.slowMs = 300;
    await expect(searchProjects(clientFor(fake, { limitMs: 100 }).client)).rejects.toThrow(SENTENCES.timeout);
    expect(() => endpointsFor("https://evil.example")).toThrow(/127\.0\.0\.1/);
    expect(endpointsFor()).toBe(GOOGLE_ENDPOINTS);
  });

  it("drops the token on a 401 and tries once more with a new one from gcloud", async () => {
    let tokens = 0;
    let drops = 0;
    const client = new GcpClient({ endpoints: endpointsFor(fake.origin), auth: { token: async () => (++tokens === 1 ? "ya29.stale-token-000000000000" : GCP_TOKEN), drop: () => void drops++ } });
    expect((await searchProjects(client)).projects.length).toBe(5);
    expect([tokens, drops]).toEqual([2, 1]);
  });
});

describe("GKE clusters", () => {
  it("lists a project's clusters with gcloud's context names, the DNS endpoint when there is no IP one", async () => {
    const cs = await listClusters(clientFor(fake).client, "demo-shop");
    expect(cs.map((c) => c.context)).toEqual(["gke_demo-shop_us-central1_shop-prod", "gke_demo-shop_europe-west1-b_shop-staging", "gke_demo-shop_us-east1_batch-jobs"]);
    expect(cs[2]!.endpoint).toBe("gke-0a1b2c3d4e-batch.us-east1.gke.goog");
    expect(fake.requests[0]!.userProject).toBe("demo-shop");
  });
});
