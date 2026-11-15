// GcpService in main (docs/gcp.md) against the loopback fake and the fake gcloud: off in development without an
// override, the states, reads only for chosen projects, the caches and the read limits, errors as sentences, and no
// token in the file or the log.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gcpMode, GcpService, MAX_CACHED, RESOURCES_TTL, type GcpMode } from "../src/main/gcp";
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
  const data = mkdtempSync(join(tmpdir(), "landlens-gcp-"));
  const file = join(data, "gcp.json");
  const logs: string[] = [];
  const dir = o.dir ?? sdkDir();
  const svc = new GcpService({
    file,
    gkeDir: join(data, "gke"),
    mode: o.mode ?? { on: true, endpoint: fake.origin, gcloud: FAKE_GCLOUD },
    findGcloud: async () => ("gcloud" in o ? o.gcloud : undefined),
    loginPath: async () => process.env.PATH ?? "",
    env: { HOME: process.env.HOME, PATH: process.env.PATH, CLOUDSDK_CONFIG: dir, GH_TOKEN: "ghp_never" },
    log: (l) => logs.push(l),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return { svc, file, logs, dir, data };
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
    // With the fake, only a gcloud named for it runs; the login PATH's is never looked for (review of part 4, M1).
    expect((await service({ mode: { on: true, endpoint: fake.origin }, gcloud: FAKE_GCLOUD }).svc.status()).state).toBe("missing");
    const found = service({ mode: { on: true, endpoint: fake.origin, gcloud: FAKE_GCLOUD } });
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
    const st = await svc.choose(["demo-shop", "orbit-analytics", "demo-shop"]);
    expect(st.projects).toEqual(["demo-shop", "orbit-analytics"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ projects: ["demo-shop", "orbit-analytics"], agentRead: false, confirmed: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(svc.choose(["Not_A_Project"])).rejects.toThrow(/project ids/);
    expect(readFileSync(file, "utf8")).not.toContain("ya29");
    expect(logs.join("\n")).not.toContain("ya29");
  });

  it("reads only projects you chose: another is refused before any request", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    fake.requests.length = 0;
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

describe("choosing projects and Claude's reading (review of part 4, L6)", () => {
  it("adds only a project your account can see; one already chosen may stay", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    await expect(svc.choose(["demo-shop", "not-mine-at-all"])).rejects.toThrow("Your account can't see not-mine-at-all.");
    expect((await svc.status()).projects).toEqual(["demo-shop"]);
  });

  it("turns Claude's reading on only after main's own question, and off without one", async () => {
    const { svc, file } = service();
    await expect(svc.setAgentRead(true, async () => true)).rejects.toThrow("Choose the projects first.");
    await svc.choose(["demo-shop"]);
    const asked: string[] = [];
    expect((await svc.setAgentRead(true, async (q) => (asked.push(q.detail), false))).agentRead).toBe(false);
    expect(asked[0]).toContain("demo-shop");
    expect((await svc.setAgentRead(true, async () => true)).agentRead).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).agentRead).toBe(true);
    expect((await svc.setAgentRead(false, async () => { throw new Error("not asked"); })).agentRead).toBe(false);
  });
});

describe("GKE clusters in the catalog (D91)", () => {
  it("writes Landlens's own kubeconfig (0700/0600, no token) and lists the clusters as gke contexts", async () => {
    const { svc, data } = service();
    expect((await svc.gkeContexts()).contexts).toEqual([]); // no project chosen: none, and nothing asked
    await svc.choose(["demo-shop"]);
    const r = await svc.gkeContexts();
    expect(r.contexts.map((c) => [c.name, c.source, c.project, c.location, c.confirmed])).toEqual([
      ["gke_demo-shop_us-central1_shop-prod", "gke", "demo-shop", "us-central1", false],
      ["gke_demo-shop_europe-west1-b_shop-staging", "gke", "demo-shop", "europe-west1-b", false],
      ["gke_demo-shop_us-east1_batch-jobs", "gke", "demo-shop", "us-east1", false],
    ]);
    const kc = join(data, "gke", "kubeconfig");
    expect(statSync(join(data, "gke")).mode & 0o777).toBe(0o700);
    expect(statSync(kc).mode & 0o777).toBe(0o600);
    const text = readFileSync(kc, "utf8");
    expect(text).not.toContain(GCP_TOKEN);
    expect(text).toContain(FAKE_GCLOUD);
    // One listing a minute: the catalog asks again from the cache.
    await svc.gkeContexts();
    expect(fake.hits("/clusters")).toHaveLength(1);
  });

  it("connects a GKE context only once you said yes, kept; never one it didn't list", async () => {
    const { svc, file, data } = service();
    await svc.choose(["demo-shop"]);
    await svc.gkeContexts();
    const ctx = "gke_demo-shop_us-central1_shop-prod";
    await expect(svc.gkeConnect(ctx, false)).rejects.toThrow(/cloud cluster/);
    const ok = await svc.gkeConnect(ctx, true);
    expect(ok).toEqual({ kubeconfig: join(data, "gke", "kubeconfig"), env: { PATH: process.env.PATH ?? "" } });
    expect(JSON.parse(readFileSync(file, "utf8")).confirmed).toEqual([ctx]);
    expect(await svc.gkeConnect(ctx, false)).toBeDefined();
    expect((await svc.gkeContexts()).contexts[0]!.confirmed).toBe(true);
    expect(await svc.gkeConnect("gke_demo-shop_us-central1_not-listed", true)).toBeUndefined();
    expect(await svc.gkeConnect("orbstack", true)).toBeUndefined();
  });

  it("refuses a cluster pointed at this machine unless Google Cloud is the development fake", async () => {
    fake.clusters.set("demo-shop", [{ name: "local", location: "us-central1", endpoint: "127.0.0.1:26443", masterAuth: { clusterCaCertificate: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t" } }]);
    try {
      const { svc } = service();
      await svc.choose(["demo-shop"]);
      expect((await svc.gkeContexts()).contexts.map((c) => c.server)).toEqual(["https://127.0.0.1:26443"]);
    } finally {
      fake.clusters.delete("demo-shop");
    }
  });
});

describe("the agent's reader and Ask Claude's brief (D93, D94)", () => {
  it("gives no reader until Claude's reading is on, then reads only chosen projects, and stops when it is turned off", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    expect(await svc.agentReader(() => false)).toBeUndefined();
    await svc.setAgentRead(true, async () => true);
    const g = (await svc.agentReader(() => false))!;
    expect(g.projects).toEqual(["demo-shop"]);
    expect((await g.reader.projects()).map((p) => p.id)).toEqual(["demo-shop"]);
    expect((await g.reader.resources({ project: "demo-shop", assetType: "sqladmin.googleapis.com/Instance" })).items).toHaveLength(4);
    await expect(g.reader.types("payments-core")).rejects.toThrow(/Choose payments-core/);
    await svc.setAgentRead(false, async () => true);
    expect(await g.reader.projects()).toEqual([]);
    await expect(g.reader.types("demo-shop")).rejects.toThrow(/turned off/);
  });

  it("builds the brief in main: fields and scrubbed JSON, at most 8,000 characters", async () => {
    const { svc } = service();
    await svc.choose(["demo-shop"]);
    const r = await svc.resource("demo-shop", "//compute.googleapis.com/projects/demo-shop/zones/us-central1-a/instances/web-frontend-1");
    expect(r.brief).toContain("Name: //compute.googleapis.com/projects/demo-shop/zones/us-central1-a/instances/web-frontend-1");
    expect(r.brief).toContain("machineType");
    expect(r.brief).not.toContain("s3cr3t-Example-Only");
    expect(r.brief!.length).toBeLessThanOrEqual(8000);
    // The drawer's own JSON is the person's to see, as before.
    expect(r.json).toContain("s3cr3t-Example-Only");
  });
});

/**
 * GcpService with no loopback fake: a stub gcloud (`run`, per path) and a stub fetch that answers the project search
 * and each project's resource search itself, so a test can hold a read open, count reads and change the account.
 */
function stubbed(o: { find?: () => string | undefined; accounts?: Record<string, string>; token?: string; endpoint?: string; now?: () => number } = {}) {
  const data = mkdtempSync(join(tmpdir(), "landlens-gcp-stub-"));
  const logs: string[] = [];
  const reads: string[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  let inFlight = 0;
  let most = 0;
  let found = 0;
  const projects = ["demo-shop-1", "demo-shop-2", "demo-shop-3", "demo-shop-4"];
  const svc = new GcpService({
    file: join(data, "gcp.json"),
    mode: o.endpoint ? { on: true, endpoint: o.endpoint } : { on: true },
    findGcloud: async () => (found++, o.find ? o.find() : "/stub/gcloud"),
    loginPath: async () => "",
    env: {},
    log: (l) => logs.push(l),
    run: async (file, args) => (args[0] === "config" ? `${o.accounts?.[file] ?? "person@example.com"}\n` : `${o.token ?? "ya29.stub_token_for_tests_0123456789"}\n`),
    fetch: (async (u: URL | string) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith("projects:search")) return Response.json({ projects: projects.map((id, i) => ({ projectId: id, displayName: id, state: "ACTIVE", name: `projects/${i + 1}` })) });
      const p = /projects\/([^/:]+):searchAllResources/.exec(url.pathname)?.[1] ?? "?";
      reads.push(p);
      inFlight++;
      most = Math.max(most, inFlight);
      if (hold) await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return Response.json({ results: [{ name: `//compute.googleapis.com/projects/${p}/zones/a/instances/vm`, assetType: "compute.googleapis.com/Instance" }] });
    }) as typeof fetch,
    ...(o.now ? { now: o.now } : {}),
  });
  return {
    svc, logs, reads, gates,
    hold: (on: boolean) => void (hold = on),
    most: () => most,
    found: () => found,
  };
}
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("Fable's security review of part 4, fixed", () => {
  it("M1: with the development fake and no absolute gcloud named, gcloud is missing and the real one is never looked for", async () => {
    const mode = gcpMode({ LANDLENS_GCP_ENDPOINT: fake.origin, LANDLENS_GCLOUD: "relative/gcloud" }, false);
    expect(mode).toEqual({ on: true, endpoint: fake.origin });
    const s = stubbed({ endpoint: fake.origin });
    expect((await s.svc.status(true)).state).toBe("missing");
    expect(s.found()).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("L1: a token echoed in an error's status, or held no longer, never reaches main's log", async () => {
    const TOKEN = "eyJhbGciOiJSUzI1NiJ9.federatedTokenShape_0123456789abcdef";
    const logs: string[] = [];
    const svc = new GcpService({
      file: join(mkdtempSync(join(tmpdir(), "landlens-gcp-l1-")), "gcp.json"),
      mode: { on: true },
      findGcloud: async () => "/stub/gcloud",
      loginPath: async () => "",
      env: {},
      log: (l) => logs.push(l),
      run: async (_f, args) => (args[0] === "config" ? "person@example.com\n" : `${TOKEN}\n`),
      fetch: (async (u: URL | string, init: RequestInit) => {
        if (String(u).includes("projects:search")) return Response.json({ projects: [{ projectId: "demo-shop-1", state: "ACTIVE", name: "projects/1" }] });
        return new Response(JSON.stringify({ error: { status: `UNAUTHENTICATED ${(init.headers as Record<string, string>).Authorization!.slice(7)}` } }), { status: 401 });
      }) as typeof fetch,
    });
    await svc.choose(["demo-shop-1"]);
    const r = await svc.types("demo-shop-1");
    expect(r.error).toMatch(/gcloud auth login/);
    expect(logs.join("\n")).toMatch(/HTTP 401/);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("L2: a read that started before the account changed isn't kept for the new account", async () => {
    let account = "person@example.com";
    const s = stubbed();
    const svc = new GcpService({ ...(s.svc as unknown as { o: ConstructorParameters<typeof GcpService>[0] }).o, run: async (_f, args) => (args[0] === "config" ? `${account}\n` : "ya29.stub_token_for_tests_0123456789\n") });
    await svc.choose(["demo-shop-1"]);
    s.hold(true);
    const first = svc.types("demo-shop-1");
    await until(() => s.gates.length === 1);
    account = "someone-else@example.com";
    expect((await svc.status(true)).account).toBe(account);
    s.gates.shift()!();
    s.hold(false);
    await first;
    const before = s.reads.length;
    await svc.types("demo-shop-1");
    expect(s.reads.length).toBe(before + 1);
  });

  it("L2: another gcloud (signed in as someone else) forgets what the last one read", async () => {
    let path = "/stub/one/gcloud";
    const s = stubbed({ find: () => path, accounts: { "/stub/one/gcloud": "person@example.com", "/stub/two/gcloud": "other@example.com" } });
    await s.svc.choose(["demo-shop-1"]);
    await s.svc.types("demo-shop-1");
    expect(s.reads).toEqual(["demo-shop-1"]);
    path = "/stub/two/gcloud";
    expect((await s.svc.status(true)).account).toBe("other@example.com");
    await s.svc.types("demo-shop-1");
    expect(s.reads).toEqual(["demo-shop-1", "demo-shop-1"]);
  });

  it("L5: never more than two project reads at once, whenever a new read arrives", async () => {
    for (let k = 0; k < 12; k++) {
      const { svc } = stubbed();
      const slot = (svc as unknown as { slot<T>(f: () => Promise<T>): Promise<T> }).slot.bind(svc);
      let now = 0;
      let most = 0;
      const gates: (() => void)[] = [];
      const read = () => slot(async () => {
        most = Math.max(most, ++now);
        await new Promise<void>((r) => gates.push(r));
        now--;
      });
      const all = [read(), read(), read()];
      await ticks(3);
      gates.shift()!();
      await ticks(k);
      all.push(read());
      while (gates.length || now) {
        await ticks(5);
        gates.shift()?.();
      }
      await Promise.all(all);
      expect(most, `a read arriving ${k} ticks after one ended`).toBeLessThanOrEqual(2);
    }
  });

  it("L5: several waiting on one project's read that failed start one read again, not one each", async () => {
    let fails = 1;
    const reads: string[] = [];
    const svc = new GcpService({
      file: join(mkdtempSync(join(tmpdir(), "landlens-gcp-l5-")), "gcp.json"),
      mode: { on: true },
      findGcloud: async () => "/stub/gcloud",
      loginPath: async () => "",
      env: {},
      run: async (_f, args) => (args[0] === "config" ? "person@example.com\n" : "ya29.stub_token_for_tests_0123456789\n"),
      fetch: (async (u: URL | string) => {
        if (String(u).includes("projects:search")) return Response.json({ projects: [{ projectId: "demo-shop-1", state: "ACTIVE", name: "projects/1" }] });
        reads.push("read");
        await new Promise((r) => setTimeout(r, 20));
        if (fails-- > 0) return new Response("{}", { status: 503 });
        return Response.json({ results: [] });
      }) as typeof fetch,
    });
    await svc.choose(["demo-shop-1"]);
    await Promise.all([svc.types("demo-shop-1"), svc.types("demo-shop-1"), svc.types("demo-shop-1"), svc.types("demo-shop-1")]);
    expect(reads).toHaveLength(2);
  });

  it("L7: lists older than a minute go, and the cache holds at most MAX_CACHED resources", async () => {
    let t = 1_000_000;
    const s = stubbed({ now: () => t });
    await s.svc.choose(["demo-shop-1", "demo-shop-2"]);
    await s.svc.types("demo-shop-1");
    const lists = (s.svc as unknown as { lists: Map<string, unknown> }).lists;
    expect(lists.size).toBe(1);
    t += RESOURCES_TTL + 1;
    await s.svc.types("demo-shop-2");
    expect([...lists.keys()]).toEqual(["demo-shop-2\n"]);
    // Three lists of 20,000 each: the oldest goes so that at most 50,000 are held.
    const big = (n: number) => ({ at: t, items: Array.from({ length: n }, () => ({ name: "//x/y", assetType: "a.googleapis.com/B" })), cut: false });
    lists.clear();
    lists.set("demo-shop-1\n", { ...big(20_000), at: t - 3 });
    lists.set("demo-shop-1\nq1", { ...big(20_000), at: t - 2 });
    lists.set("demo-shop-1\nq2", { ...big(20_000), at: t - 1 });
    (s.svc as unknown as { sweep(): void }).sweep();
    expect(MAX_CACHED).toBe(50_000);
    expect([...lists.keys()]).toEqual(["demo-shop-1\nq1", "demo-shop-1\nq2"]);
  });
});
