// landlens-gcp against the fake Google Cloud (D93, D97): read-only tools, chosen projects only (another is refused
// before any request), scrubbed answers (a startup script's password, environment values, Google's credential shapes),
// the YAML cut, 30 calls a minute, and the GKE clusters with whether Landlens is connected.
import { countTypes, getResource, listClusters, searchProjects, searchResources } from "@landlens/gcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGcp } from "../../gcp/test/fake-gcp.js";
import { clientFor } from "../../gcp/test/helpers.js";
import { GCP_CALLS_A_MINUTE, GCP_DATA_LINE, GCP_YAML_MAX, gcpMcpServer, type GcpReader } from "../src/server.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => void (fake.requests.length = 0));

/** A reader as GcpService gives one: chosen projects only, straight to the fake. */
function reader(chosen: string[], connected: string[] = []): GcpReader {
  const { client } = clientFor(fake);
  const only = (p: string) => {
    if (!chosen.includes(p)) throw new Error(`Choose ${p} first.`);
  };
  return {
    projects: async () => (await searchProjects(client)).projects.filter((p) => chosen.includes(p.id)),
    types: async (p) => {
      only(p);
      const r = await searchResources(client, p);
      return { types: countTypes(r.items), total: r.items.length, cut: r.cut };
    },
    resources: async ({ project, assetType, query }) => {
      only(project);
      const r = await searchResources(client, project, query ? { query } : {});
      const items = assetType ? r.items.filter((x) => x.assetType === assetType) : r.items;
      return { items, total: items.length, cut: r.cut };
    },
    resource: async (p, name) => {
      only(p);
      const r = await getResource(client, p, name);
      if (!r) throw new Error("no such resource");
      return r;
    },
    clusters: async () => ({ clusters: (await Promise.all(chosen.map((p) => listClusters(client, p)))).flat(), errors: [] }),
    connected: (c) => connected.includes(c),
  };
}

async function connect(r: GcpReader, now?: () => number) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gcpMcpServer(r, now ? { now } : {}).connect(a);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(b);
  return c;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe("landlens-gcp", () => {
  it("has five tools, every one read-only", async () => {
    const c = await connect(reader(["demo-shop"]));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["gcp_get_resource", "gcp_projects", "gcp_resource_types", "gcp_search_resources", "gke_clusters"]);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("lists only the chosen projects, and refuses another before any request is made", async () => {
    const c = await connect(reader(["demo-shop"]));
    const ps = text(await c.callTool({ name: "gcp_projects", arguments: {} }));
    expect(ps).toContain("demo-shop (Demo Shop)");
    expect(ps).not.toContain("orbit-analytics");
    fake.requests.length = 0;
    const r = await c.callTool({ name: "gcp_search_resources", arguments: { project: "orbit-analytics" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/isn't one of the projects the person chose/);
    expect(fake.requests.filter((q) => q.path.includes("orbit-analytics"))).toHaveLength(0);
    // A name that isn't a project id never reaches a path.
    const bad = await c.callTool({ name: "gcp_resource_types", arguments: { project: "../../v1/x" } });
    expect(bad.isError).toBe(true);
  });

  it("answers which Cloud SQL instances a project has, as data, not instructions", async () => {
    const c = await connect(reader(["demo-shop"]));
    const types = text(await c.callTool({ name: "gcp_resource_types", arguments: { project: "demo-shop" } }));
    expect(types).toMatch(/sqladmin\.googleapis\.com\/Instance\s+4/);
    const r = text(await c.callTool({ name: "gcp_search_resources", arguments: { project: "demo-shop", assetType: "sqladmin.googleapis.com/Instance" } }));
    expect(r.startsWith(GCP_DATA_LINE)).toBe(true);
    for (const db of ["orders-db", "catalog-db", "analytics-replica", "legacy-mysql"]) expect(r).toContain(`/instances/${db}`);
    expect(r).toContain("SUSPENDED");
    expect(fake.requests.every((q) => q.userProject === undefined || q.userProject === "demo-shop")).toBe(true);
  });

  it("hides a VM's startup script and a Cloud Run service's environment values", async () => {
    const c = await connect(reader(["demo-shop"]));
    const vm = text(await c.callTool({ name: "gcp_get_resource", arguments: { project: "demo-shop", name: "//compute.googleapis.com/projects/demo-shop/zones/us-central1-a/instances/web-frontend-1" } }));
    expect(vm).toContain("key: startup-script");
    expect(vm).not.toContain("s3cr3t-Example-Only");
    expect(vm).not.toContain("DB_PASSWORD=");
    expect(vm).toContain("machineType");
    const run = text(await c.callTool({ name: "gcp_get_resource", arguments: { project: "demo-shop", name: "//run.googleapis.com/projects/demo-shop/locations/us-central1/services/checkout-api" } }));
    expect(run).toContain("STRIPE_KEY");
    expect(run).not.toContain("example-not-a-real-key");
  });

  it("scrubs every Google credential shape, env maps, secret-named keys and bidi overrides (review of part 4, M2)", async () => {
    const name = "//cloudfunctions.googleapis.com/projects/demo-shop/locations/us-central1/functions/hook";
    const json = JSON.stringify({
      description: "safe‮gnp.exe call with AIzaSyA" + "b".repeat(32),
      environmentVariables: { STRIPE: "sk_live_notreally", PLAIN: "visible-only-as-name" },
      buildEnvironmentVariables: { NPM_TOKEN: "npm_abc" },
      secretEnvironmentVariables: [{ key: "DB", secret: "db-pass", version: "1" }],
      serviceConfig: { environmentVariables: { NESTED: "nested-value-x" } },
      notes: ["refresh 1//0g" + "c".repeat(60), "client GOCSPX-" + "d".repeat(28), "token ya29.a0AfB_" + "e".repeat(40)],
      adminPassword: "hunter2hunter2",
      metadata: { items: [{ key: "startup-script", value: "curl -H 'x: y' https://x" }] },
      containers: [{ env: [{ name: "PLAIN", value: "plainvalue123" }] }],
    });
    const r: GcpReader = {
      ...reader(["demo-shop"]),
      resource: async () => ({ resource: { name, assetType: "cloudfunctions.googleapis.com/Function", displayName: "hook‮" }, json, cut: false }),
    };
    const c = await connect(r);
    const out = text(await c.callTool({ name: "gcp_get_resource", arguments: { project: "demo-shop", name } }));
    for (const leak of ["AIzaSyA", "1//0g", "GOCSPX-", "ya29.a0", "sk_live_notreally", "visible-only-as-name", "npm_abc", "nested-value-x", "hunter2hunter2", "curl -H", "plainvalue123", "‮"]) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain("STRIPE");
  });

  it("cuts a resource's YAML at 16,000 characters", async () => {
    const name = "//storage.googleapis.com/big";
    const json = JSON.stringify({ rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, note: "x".repeat(20) })) });
    const c = await connect({ ...reader(["demo-shop"]), resource: async () => ({ resource: { name, assetType: "storage.googleapis.com/Bucket" }, json, cut: false }) });
    const out = text(await c.callTool({ name: "gcp_get_resource", arguments: { project: "demo-shop", name } }));
    expect(out.length).toBeLessThan(GCP_YAML_MAX + 1500);
    expect(out).toMatch(/cut at 16000 characters/);
  });

  it("allows 30 calls a minute in a session, then refuses until the minute has passed", async () => {
    let t = 1_000_000;
    const c = await connect(reader(["demo-shop"]), () => t);
    for (let i = 0; i < GCP_CALLS_A_MINUTE; i++) expect((await c.callTool({ name: "gcp_projects", arguments: {} })).isError).toBeFalsy();
    const over = await c.callTool({ name: "gcp_projects", arguments: {} });
    expect(over.isError).toBe(true);
    expect(text(over)).toMatch(/at most 30 Google Cloud calls a minute/);
    t += 60_000;
    expect((await c.callTool({ name: "gcp_projects", arguments: {} })).isError).toBeFalsy();
  });

  it("lists GKE clusters and says which Landlens is connected to", async () => {
    const c = await connect(reader(["demo-shop"], ["gke_demo-shop_us-central1_shop-prod"]));
    const out = text(await c.callTool({ name: "gke_clusters", arguments: {} }));
    expect(out).toMatch(/gke_demo-shop_us-central1_shop-prod\s+RUNNING.*connected in Landlens/);
    expect(out).toMatch(/gke_demo-shop_us-east1_batch-jobs\s+RECONCILING.*not connected/);
  });
});
