// GcpService in main (docs/gcp.md) against the loopback fake and the fake gcloud: off in development without an
// override, the states, reads only for chosen projects, the caches and the read limits, errors as sentences, and no
// token in the file or the log.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gcpMode, GcpService, RESOURCES_TTL, type GcpMode } from "../src/main/gcp";
import { FakeGcp, GCP_TOKEN } from "../../../packages/gcp/test/fake-gcp";
import { FAKE_GCLOUD, sdkDir } from "../../../packages/gcp/test/helpers";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.fail.clear();
  fake.slowMs = 0;
});

function service(o: { mode?: GcpMode; dir?: string; gcloud?: string | undefined; fetch?: typeof fetch; now?: () => number } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "landlens-gcp-")), "gcp.json");
  const logs: string[] = [];
  const dir = o.dir ?? sdkDir();
  const svc = new GcpService({
    file,
    mode: o.mode ?? { on: true, endpoint: fake.origin, gcloud: FAKE_GCLOUD },
    findGcloud: async () => ("gcloud" in o ? o.gcloud : undefined),
    loginPath: async () => process.env.PATH ?? "",
    env: { HOME: process.env.HOME, PATH: process.env.PATH, CLOUDSDK_CONFIG: dir, GH_TOKEN: "ghp_never" },
    log: (l) => logs.push(l),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return { svc, file, logs, dir };
}

describe("when Google Cloud is on (D86)", () => {
  it("a packaged app is on and takes no override; an unpackaged one is off without a loopback fake or LANDLENS_GCP_REAL=1", () => {
    const env = { LANDLENS_GCP_ENDPOINT: "http://127.0.0.1:4000", LANDLENS_GCLOUD: "/tmp/fake-gcloud", LANDLENS_GCP_REAL: "1" };
    expect(gcpMode(env, true)).toEqual({ on: true });
    expect(gcpMode({}, false)).toEqual({ on: false });
    expect(gcpMode({ LANDLENS_GCLOUD: "/tmp/fake-gcloud" }, false)).toEqual({ on: false });
    expect(gcpMode({ LANDLENS_GCP_ENDPOINT: "https://cloudasset.googleapis.com" }, false)).toEqual({ on: false });
    expect(gcpMode({ LANDLENS_GCP_ENDPOINT: "http://localhost:4000" }, false)).toEqual({ on: false });
    expect(gcpMode({ LANDLENS_GCP_REAL: "true" }, false)).toEqual({ on: false });
    expect(gcpMode(env, false)).toEqual({ on: true, endpoint: "http://127.0.0.1:4000", gcloud: "/tmp/fake-gcloud" });
    expect(gcpMode({ LANDLENS_GCP_REAL: "1", LANDLENS_GCLOUD: "relative/gcloud" }, false)).toEqual({ on: true });
  });

  it("says off-dev, missing, signed-out or ready", async () => {
    expect((await service({ mode: { on: false } }).svc.status()).state).toBe("off-dev");
    expect((await service({ mode: { on: true, endpoint: fake.origin }, gcloud: undefined }).svc.status()).state).toBe("missing");
    expect((await service({ mode: { on: true, endpoint: fake.origin, gcloud: "/nowhere/gcloud" } }).svc.status()).state).toBe("missing");
    const found = service({ mode: { on: true, endpoint: fake.origin }, gcloud: FAKE_GCLOUD });
    expect(await found.svc.status()).toEqual({ state: "ready", account: "person@example.com", projects: [], agentRead: false });
    const out = sdkDir();
    writeFileSync(join(out, "account"), "");
    const s = service({ dir: out });
    expect((await s.svc.status()).state).toBe("signed-out");
    await expect(s.svc.projects()).rejects.toThrow("gcloud isn't signed in. Run `gcloud auth login`.");
    // Signing in shows on Check again (fresh), not before a minute has passed.
    writeFileSync(join(out, "account"), "person@example.com");
    expect((await s.svc.status()).state).toBe("signed-out");
    expect((await s.svc.status(true)).state).toBe("ready");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("projects and what is kept", () => {
  it("lists projects (cached 5 minutes) and keeps only the chosen ids, 0600, no token", async () => {
    const { svc, file, logs } = service();
    expect((await svc.projects()).projects).toHaveLength(5);
    await svc.projects();
    expect(fake.hits("projects:search")).toHaveLength(1);
    await svc.projects(true);
    expect(fake.hits("projects:search")).toHaveLength(2);
    const st = await svc.choose(["demo-shop", "orbit-analytics", "demo-shop"], false);
    expect(st.projects).toEqual(["demo-shop", "orbit-analytics"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ projects: ["demo-shop", "orbit-analytics"], agentRead: false });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(svc.choose(["Not_A_Project"])).rejects.toThrow(/project ids/);
    expect(readFileSync(file, "utf8")).not.toContain("ya29");
    expect(logs.join("\n")).not.toContain("ya29");
  });

  it("reads only projects you chose: another is refused before any request", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    await expect(svc.types("payments-core")).rejects.toThrow("Choose payments-core on the Google Cloud page first.");
    await expect(svc.resources({ project: "payments-core" })).rejects.toThrow(/Choose payments-core/);
    await expect(svc.resource("payments-core", "//storage.googleapis.com/payments-core-datasets")).rejects.toThrow(/Choose payments-core/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("types and resources", () => {
  it("counts types from one read, serves pages of 500 and a type from that read, and reads again after 60 s", async () => {
    let t = 1_000;
    const { svc } = service({ now: () => t });
    await svc.choose(["orbit-analytics", "demo-shop"]);
    const types = await svc.types("orbit-analytics");
    expect(types.total).toBe(1200);
    expect(types.cut).toBe(false);
    expect(types.types.reduce((n, x) => n + x.count, 0)).toBe(1200);
    const reads = fake.hits("searchAllResources").length;
    const p1 = await svc.resources({ project: "orbit-analytics" });
    const p3 = await svc.resources({ project: "orbit-analytics", offset: 1000 });
    expect([p1.items.length, p1.total, p3.items.length]).toEqual([500, 1200, 200]);
    const vms = await svc.resources({ project: "orbit-analytics", assetType: "compute.googleapis.com/Instance" });
    expect(vms.total).toBe(types.types.find((x) => x.assetType === "compute.googleapis.com/Instance")!.count);
    expect(fake.hits("searchAllResources").length).toBe(reads);
    t += RESOURCES_TTL;
    await svc.types("orbit-analytics");
    expect(fake.hits("searchAllResources").length).toBe(reads * 2);
  });

  it("sends a query as a new read, cached on its own", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    const r = await svc.resources({ project: "demo-shop", query: "state:TERMINATED" });
    expect(r.items.map((x) => x.displayName)).toEqual(["staging-worker-1", "load-test-runner"]);
    await svc.resources({ project: "demo-shop", query: "state:TERMINATED" });
    expect(fake.hits("searchAllResources").filter((x) => x.query.query === "state:TERMINATED")).toHaveLength(1);
  });

  it("says cut past 5,000", async () => {
    const { svc } = service();
    await svc.choose(["archive-vault"]);
    expect(await svc.types("archive-vault")).toMatchObject({ total: 5000, cut: true });
  });

  it("reads a project once when asked twice at once, and two projects at a time in all", async () => {
    let now = 0;
    let most = 0;
    const counting: typeof fetch = async (input, init) => {
      most = Math.max(most, ++now);
      try {
        return await fetch(input, init);
      } finally {
        now--;
      }
    };
    fake.slowMs = 30;
    const { svc } = service({ fetch: counting });
    await svc.choose(["demo-shop", "payments-core", "ml-sandbox-42"]);
    await Promise.all([svc.types("demo-shop"), svc.types("demo-shop"), svc.types("payments-core"), svc.types("ml-sandbox-42")]);
    expect(fake.hits("demo-shop:searchAllResources")).toHaveLength(1);
    expect(most).toBe(2);
  });

  it("a project that fails says its sentence; the others still load; the log has the raw error without the token", async () => {
    fake.fail.set("payments-core", { status: 403, reason: "SERVICE_DISABLED", message: `token ${GCP_TOKEN} leaked` });
    const { svc, logs } = service();
    await svc.choose(["demo-shop", "payments-core"]);
    const [bad, good] = await Promise.all([svc.types("payments-core"), svc.types("demo-shop")]);
    expect(bad.error).toBe("The Cloud Asset API is off in payments-core. Turn it on: `gcloud services enable cloudasset.googleapis.com --project payments-core`.");
    expect(good.total).toBeGreaterThan(50);
    expect(logs.some((l) => l.includes("payments-core") && l.includes("HTTP 403"))).toBe(true);
    expect(logs.join("\n")).not.toContain(GCP_TOKEN);
  });

  it("gives one resource with its JSON, and 404 when it has gone", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    const name = "//cloudsql.googleapis.com/projects/demo-shop/instances/orders-db";
    const r = await svc.resource("demo-shop", name);
    expect(JSON.parse(r.json!)).toMatchObject({ databaseVersion: "POSTGRES_16" });
    await expect(svc.resource("demo-shop", "//cloudsql.googleapis.com/projects/demo-shop/instances/gone")).rejects.toMatchObject({ status: 404 });
  });

  it("lists GKE clusters of the chosen projects, with each failing project's sentence", async () => {
    fake.fail.set("payments-core", { status: 403, api: "container" });
    const { svc } = service();
    await svc.choose(["demo-shop", "payments-core"]);
    const r = await svc.clusters();
    expect(r.clusters.map((c) => c.name)).toEqual(["shop-prod", "shop-staging", "batch-jobs"]);
    expect(r.errors).toEqual([{ project: "payments-core", message: "Your account can't list GKE clusters in payments-core (it needs Kubernetes Engine Cluster Viewer)." }]);
  });

  it("gcloud gets HOME, PATH and CLOUDSDK_* only, never Landlens's other variables", async () => {
    const { svc, dir } = service();
    await svc.projects();
    const env = readFileSync(join(dir, "env"), "utf8");
    expect(env).not.toContain("GH_TOKEN");
    expect(env).toContain("CLOUDSDK_CONFIG=");
  });
});
