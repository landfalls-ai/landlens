// GKE clusters and the agent's Google Cloud tools (wave 6 part 5, D91–D94, D97) in the built app. No request reaches
// Google and no cloud cluster is touched: the fake Google Cloud lists one GKE cluster, shop-prod, whose endpoint is
// OrbStack's API server, and the fake gcloud prints a throwaway ServiceAccount's token, made here in landlens-dev with
// read-only RBAC and deleted after the test. Landlens's own kubeconfig lives in userData; ~/.kube/config is only read
// (by kubectl, for OrbStack's CA) and never written.
//
// Welcome's "Google Cloud" heading and card; the once-per-cluster question; connected as the ServiceAccount (its RBAC,
// not the person's); the kubeconfig's modes and no token in it; the switcher; the drawer's Open in Landlens and Ask
// Claude; "Claude can read these projects" asking in main; landlens-gcp on the MCP page. With `claude` too
// (LANDLENS_INTEGRATION=orbstack,claude), one live question, answered from the fake: "which Cloud SQL instances are in
// project demo-shop?" (it uses the person's own Claude Code subscription).
// LANDLENS_INTEGRATION=orbstack npx vitest run test/gke.e2e.test.ts  (screenshots to $LANDLENS_SHOTS, prefix g5-)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGcp, GCP_TOKEN } from "../../../packages/gcp/test/fake-gcp";
import { FAKE_GCLOUD, sdkDir } from "../../../packages/gcp/test/helpers";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
const claude = flags.includes("claude");
const shots = process.env.LANDLENS_SHOTS;
const shot = async (page: Page, name: string, colorScheme: "dark" | "light" = "dark") => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};
const both = async (page: Page, name: string) => {
  await shot(page, `${name}-dark`, "dark");
  await shot(page, `${name}-light`, "light");
  await page.emulateMedia({ colorScheme: "dark" });
};

const NS = "landlens-dev";
const SA = "landlens-gke-e2e";
const CONTEXT = "gke_demo-shop_us-central1_shop-prod";
/** kubectl against OrbStack only. */
const kc = (args: string[], input?: string) => execFileSync("kubectl", ["--context", "orbstack", ...args], { encoding: "utf8", ...(input ? { input } : {}) });
const RBAC = `
apiVersion: v1
kind: ServiceAccount
metadata: { name: ${SA}, namespace: ${NS}, labels: { app.kubernetes.io/part-of: landlens-e2e } }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: ${SA}, namespace: ${NS}, labels: { app.kubernetes.io/part-of: landlens-e2e } }
rules:
  - { apiGroups: [""], resources: [pods, pods/log, services, configmaps, events], verbs: [get, list, watch] }
  - { apiGroups: [apps], resources: [deployments, replicasets, statefulsets, daemonsets], verbs: [get, list, watch] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ${SA}, namespace: ${NS}, labels: { app.kubernetes.io/part-of: landlens-e2e } }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: ${SA} }
subjects: [{ kind: ServiceAccount, name: ${SA}, namespace: ${NS} }]
`;

/** The app's environment without any Google Cloud override the shell may carry. */
const baseEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(LANDLENS_GCP_|LANDLENS_GCLOUD|CLOUDSDK_)/.test(k)) env[k] = v;
  return { ...env, ELECTRON_RENDERER_URL: "" };
};
/** Every file under a folder, read as text (to say no token is in any of them). */
const allText = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((d) => {
  const p = join(dir, d.name);
  if (d.isDirectory()) return allText(p);
  try {
    return statSync(p).size < 5_000_000 ? readFileSync(p, "latin1") : "";
  } catch {
    return "";
  }
}).join("\n");
type Landlens = { landlens: { invoke: (c: string, r: unknown) => Promise<unknown> } };

describe.runIf(run)("GKE clusters and the agent's Google Cloud tools, against the fake and OrbStack", { timeout: 120_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let fake: FakeGcp;
  let token = "";
  const sdk = sdkDir();
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-gke-"));
  const kubeconfig = join(homedir(), ".kube", "config");
  const kubeMtime = existsSync(kubeconfig) ? statSync(kubeconfig).mtimeMs : 0;
  const invoke = (channel: string, req: unknown) =>
    page.evaluate(([c, r]) => (globalThis as unknown as Landlens).landlens.invoke(c as string, r).then((x) => ({ ok: x }), (e: Error) => ({ error: e.message })), [channel, req] as const);

  beforeAll(async () => {
    // OrbStack's API server and CA, read (never written) from the person's kubeconfig by kubectl.
    const view = JSON.parse(kc(["config", "view", "--raw", "--minify", "-o", "json"])) as { clusters: { cluster: { server: string; "certificate-authority-data": string } }[] };
    const { server, "certificate-authority-data": ca } = view.clusters[0]!.cluster;
    const endpoint = new URL(server).host; // 127.0.0.1:26443
    kc(["apply", "-f", "-"], RBAC);
    token = kc(["-n", NS, "create", "token", SA, "--duration", "1h"]).trim();
    fake = await new FakeGcp().start();
    // gcloud's token for both: Google's APIs (the fake) and the GKE cluster (OrbStack, as the ServiceAccount).
    fake.valid.add(token);
    writeFileSync(join(sdk, "token"), token);
    fake.clusters.set("demo-shop", [
      { name: "shop-prod", location: "us-central1", status: "RUNNING", currentMasterVersion: "1.33.4-gke.1172000", endpoint, masterAuth: { clusterCaCertificate: ca } },
      { name: "batch-jobs", location: "us-east1", status: "RECONCILING", currentMasterVersion: "1.33.4-gke.1172000", endpoint: "" },
    ]);
    writeFileSync(join(userData, "gcp.json"), JSON.stringify({ projects: ["demo-shop"], agentRead: false, confirmed: [] }), { mode: 0o600 });
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...baseEnv(), LANDLENS_USER_DATA: userData, LANDLENS_GCP_ENDPOINT: fake.origin, LANDLENS_GCLOUD: FAKE_GCLOUD, CLOUDSDK_CONFIG: sdk },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    // Main's own questions (a cloud cluster's first connect, Claude's reading) are native dialogs: answered here, in
    // main, by `answer` (0 = yes, 1 = Cancel), each message kept in `asked`. The page can't answer them.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { asked: string[]; answer: number };
      g.asked = [];
      g.answer = 1;
      dialog.showMessageBox = (async (...a: unknown[]) => {
        g.asked.push((a.at(-1) as { message: string }).message);
        return { response: g.answer, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await fake?.stop();
    for (const kind of ["rolebinding", "role", "serviceaccount"]) {
      try {
        kc(["-n", NS, "delete", kind, SA, "--ignore-not-found", "--wait=false"]);
      } catch {
        // reported by the check below
      }
    }
    expect(kc(["-n", NS, "get", "serviceaccount,role,rolebinding", "-l", "app.kubernetes.io/part-of=landlens-e2e", "-o", "name"]).trim()).toBe("");
    rmSync(sdk, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }, 60_000);

  const card = () => page.getByRole("button", { name: /^shop-prod\s*GKE/ });

  it("lists the GKE cluster on Welcome under Google Cloud, and main refuses it before you say yes", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("heading", { name: /^Google Cloud/ }).waitFor({ timeout: 30_000 });
    await card().waitFor();
    expect(await card().innerText()).toMatch(/demo-shop · us-central1/);
    // The cluster without an endpoint (still being made) isn't offered.
    await expect(page.getByRole("button", { name: /^batch-jobs/ }).count()).resolves.toBe(0);
    await both(page, "g5-01-welcome-gke");
    // The page can't say yes: main asks in its own dialog, and a Cancel there refuses (review of part 5, L3).
    const refused = await invoke("cluster:connect", { context: CONTEXT, cloud: true });
    expect(refused).toEqual({ error: expect.stringContaining("You didn't connect the cloud cluster.") });
    expect(await app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)).toEqual(["Connect shop-prod?"]);
    expect(JSON.parse(readFileSync(join(userData, "gcp.json"), "utf8")).confirmed).toEqual([]);
  });

  it("asks once, in main, then connects as the ServiceAccount through Landlens's own kubeconfig", async () => {
    await app.evaluate(() => void ((globalThis as unknown as { answer: number }).answer = 0));
    await card().click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.length)).toBe(2);
    // No React dialog: the question was main's.
    await expect(page.getByRole("alertdialog").count()).resolves.toBe(0);
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 60_000 });
    // The ServiceAccount can't list pods across namespaces: the Overview says so and opens one it can read.
    const needed = page.getByRole("alert").filter({ hasText: "Your account can't read the whole cluster." });
    await needed.waitFor({ timeout: 30_000 });
    await both(page, "g5-08-namespace-needed");
    await needed.getByRole("textbox", { name: "Namespace" }).fill(NS);
    await needed.getByRole("button", { name: "Open" }).click();
    await page.getByRole("region", { name: "Verdict" }).waitFor({ timeout: 30_000 });
    await expect(page.getByRole("combobox", { name: "Namespace" }).inputValue()).resolves.toBe(NS);
    // Kept with its address, a hash of its CA and the account: a cluster recreated under the name asks again.
    expect(JSON.parse(readFileSync(join(userData, "gcp.json"), "utf8")).confirmed).toEqual([{ context: CONTEXT, endpoint: expect.stringMatching(/^127\.0\.0\.1:\d+$/), ca: expect.stringMatching(/^[0-9a-f]{64}$/), account: "person@example.com" }]);
    // Connected as the ServiceAccount: what its Role allows, and nothing it doesn't.
    const info = (await invoke("cluster:connect", { context: CONTEXT })) as { ok: { handle: string; server: string } };
    expect(await app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.length)).toBe(2); // not asked again
    expect(info.ok.server).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const access = (await invoke("cluster:access", {
      handle: info.ok.handle,
      checks: [
        { verb: "list", group: "", resource: "pods", namespace: NS },
        { verb: "list", group: "", resource: "nodes" },
        { verb: "get", group: "", resource: "secrets", namespace: NS },
        { verb: "delete", group: "", resource: "pods", namespace: NS },
      ],
    })) as { ok: { allowed: boolean[] } };
    expect(access.ok.allowed).toEqual([true, false, false, false]);
    // The exec plugin asked the fake gcloud for the account's token; the kubeconfig holds no token, only the plugin.
    expect(readFileSync(join(sdk, "calls"), "utf8")).toContain("auth print-access-token --account=person@example.com");
    const dir = join(userData, "gke");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "kubeconfig")).mode & 0o777).toBe(0o600);
    const kcText = readFileSync(join(dir, "kubeconfig"), "utf8");
    expect(kcText).toContain(`name: ${CONTEXT}`);
    expect(kcText).toContain("landlens-gke");
    expect(kcText).toContain(FAKE_GCLOUD);
    expect(kcText).not.toContain(token);
    expect(kcText).not.toMatch(/\btoken:/);
    // The person's kubeconfig wasn't written.
    expect(existsSync(kubeconfig) ? statSync(kubeconfig).mtimeMs : 0).toBe(kubeMtime);
  });

  it("shows the GKE cluster in the switcher, under Google Cloud", async () => {
    await page.getByRole("button", { name: `${CONTEXT}, switch cluster` }).click();
    const menu = page.getByRole("menu", { name: "Clusters" });
    const gke = menu.getByRole("group", { name: "Google Cloud" });
    await gke.getByRole("menuitem", { name: /shop-prod · demo-shop/ }).waitFor();
    await menu.getByRole("group", { name: "Clusters in your kubeconfig" }).getByRole("menuitem", { name: /orbstack/ }).waitFor();
    await both(page, "g5-03-switcher");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: `${CONTEXT}, switch cluster` }).click().catch(() => undefined);
    if (await menu.count()) await page.getByRole("button", { name: `${CONTEXT}, switch cluster` }).click();
  });

  it("offers Open in Landlens and Ask Claude on the cluster's resource, with a scrubbed brief from main", async () => {
    const sidebar = page.getByRole("complementary", { name: "Resources" });
    await sidebar.getByRole("button", { name: "Google Cloud", exact: true }).click({ timeout: 30_000 });
    const types = page.getByRole("region", { name: "Types" });
    await types.getByRole("group", { name: "Kubernetes Engine" }).getByRole("button", { name: /^Cluster/ }).click({ timeout: 20_000 });
    await page.getByRole("region", { name: "Resources" }).getByRole("row", { name: /shop-prod/ }).click();
    const drawer = page.getByRole("complementary", { name: "Google Cloud resource shop-prod" });
    await drawer.getByRole("button", { name: "Open in Landlens" }).waitFor();
    await expect.poll(() => drawer.getByRole("button", { name: "Ask Claude" }).isEnabled()).toBe(true);
    await both(page, "g5-04-drawer");
    await drawer.getByRole("button", { name: "Close details" }).click();
    // The brief: from main, scrubbed (the VM's startup script and the Cloud Run values aren't in it), at most 8,000.
    const vm = (await invoke("gcp:resource", { project: "demo-shop", name: "//compute.googleapis.com/projects/demo-shop/zones/us-central1-a/instances/web-frontend-1" })) as { ok: { brief: string } };
    expect(vm.ok.brief).toMatch(/^Google Cloud project: demo-shop\nName: \/\/compute/);
    expect(vm.ok.brief).toContain("startup-script");
    expect(vm.ok.brief).not.toContain("s3cr3t-Example-Only");
    expect(vm.ok.brief.length).toBeLessThanOrEqual(8000);
    const run = (await invoke("gcp:resource", { project: "demo-shop", name: "//run.googleapis.com/projects/demo-shop/locations/us-central1/services/checkout-api" })) as { ok: { brief: string } };
    expect(run.ok.brief).toContain("STRIPE_KEY");
    expect(run.ok.brief).not.toContain("example-not-a-real-key");
  });

  it("turns on Claude's read of the projects only after main asks, and lists landlens-gcp on the MCP page", async () => {
    await app.evaluate(() => {
      const g = globalThis as unknown as { asked: string[]; answer: number };
      g.asked = [];
      g.answer = 1; // Cancel first
    });
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    const gcp = page.getByRole("region", { name: "Google Cloud connection" });
    const sw = gcp.getByRole("switch", { name: "Claude can read these projects" });
    await sw.waitFor();
    expect(await sw.isChecked()).toBe(false);
    await sw.click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.length)).toBe(1);
    await expect.poll(() => sw.isChecked()).toBe(false);
    expect(JSON.parse(readFileSync(join(userData, "gcp.json"), "utf8")).agentRead).toBe(false);
    // The renderer can't turn it on by itself: gcp:choose has no agentRead, and the channel asks in main.
    await app.evaluate(() => void ((globalThis as unknown as { answer: number }).answer = 0));
    await sw.click();
    await expect.poll(() => sw.isChecked()).toBe(true);
    const asked = await app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/Google Cloud/);
    expect(JSON.parse(readFileSync(join(userData, "gcp.json"), "utf8")).agentRead).toBe(true);
    await both(page, "g5-05-claude-can-read");
    // A project the page adds afterwards isn't Claude's until main asks again (review of part 5, M3).
    const chose = (await invoke("gcp:choose", { projects: ["demo-shop", "orbit-analytics"] })) as { ok: { agentProjects: string[] } };
    expect(chose.ok.agentProjects).toEqual(["demo-shop"]);
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    const pending = gcp.getByRole("status").filter({ hasText: "Claude can't read orbit-analytics yet" });
    await pending.waitFor();
    if (shots) await both(page, "f5-01-pending-project");
    await pending.getByRole("button", { name: /Let Claude read it too/ }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.length)).toBe(3);
    await pending.waitFor({ state: "detached" });
    expect(JSON.parse(readFileSync(join(userData, "gcp.json"), "utf8")).grant).toEqual({ account: "person@example.com", projects: ["demo-shop", "orbit-analytics"] });
    await invoke("gcp:choose", { projects: ["demo-shop"] });
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    const tile = page.getByRole("region", { name: "MCP server landlens-gcp" });
    await tile.waitFor();
    await expect(tile.innerText()).resolves.toContain("From Connections");
    const names = await page.locator(".mcp-server h3").allInnerTexts();
    expect(names.slice(0, 2)).toEqual(["landlens-kube", "landlens-gcp"]);
    await tile.scrollIntoViewIfNeeded();
    await both(page, "g5-06-mcp-page");
  });

  it("keeps no credential: neither token is in any file Landlens wrote", async () => {
    const text = allText(userData);
    expect(text).not.toContain(token);
    expect(text).not.toContain(GCP_TOKEN);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
  });

  describe.runIf(claude)("a live session reads Google Cloud through landlens-gcp", () => {
    const dock = () => page.getByRole("complementary", { name: "Claude Code" });
    const box = () => dock().getByRole("combobox", { name: "Message Claude Code" });
    const stop = () => dock().getByRole("button", { name: "Stop", exact: true });

    it("answers which Cloud SQL instances are in demo-shop, from the fake, read-only", async () => {
      await page.getByRole("button", { name: "Overview", exact: true }).click().catch(() => undefined);
      fake.requests.length = 0;
      await page.keyboard.press("Meta+j");
      await expect.poll(() => box().isEnabled({ timeout: 2_000 }).catch(() => false), { timeout: 90_000 }).toBe(true);
      await box().fill("which Cloud SQL instances are in project demo-shop?");
      await box().press("Enter");
      await stop().waitFor({ timeout: 60_000 }).catch(() => {});
      const deadline = Date.now() + 240_000;
      while (await stop().count()) {
        if (Date.now() > deadline) throw new Error(`the agent did not finish in 4 minutes; the dock says:\n${await dock().innerText()}`);
        await page.waitForTimeout(500);
      }
      const answer = (await dock().locator(".msg-agent").allTextContents()).join("\n");
      for (const db of ["orders-db", "catalog-db", "analytics-replica", "legacy-mysql"]) expect(answer, db).toContain(db);
      await both(page, "g5-07-live-answer");
      const calls = ((await invoke("mcp:calls", {})) as { ok: { calls: { server: string; tool: string; status: string; origin: string }[] } }).ok.calls;
      const gcp = calls.filter((c) => c.server === "landlens-gcp" && c.origin === "agent");
      expect(gcp.length).toBeGreaterThan(0);
      expect(gcp.every((c) => c.status === "ok")).toBe(true);
      // What the fake was asked, if anything (main's 60-second cache may answer from the drawer's earlier read): GETs
      // for demo-shop only.
      expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
      expect(fake.requests.filter((r) => /projects\/(?!demo-shop)[a-z][-a-z0-9]+\//.test(r.path))).toEqual([]);
      // No card asked: every landlens-gcp tool is a read.
      await expect(dock().getByRole("region", { name: "Claude asks" }).count()).resolves.toBe(0);
    }, 330_000);
  });

  it("disconnects the GKE cluster when its project is taken out, and Welcome says why (review of part 5, L7)", async () => {
    const connected = (await invoke("cluster:connect", { context: CONTEXT })) as { ok: { handle: string } };
    expect(connected.ok.handle).toBeTruthy();
    await invoke("gcp:choose", { projects: [] });
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor({ timeout: 30_000 });
    await page.getByText("Disconnected, because its Google Cloud project is no longer chosen").waitFor();
    if (shots) await both(page, "f5-02-gke-disconnected");
    const access = await invoke("cluster:access", { handle: connected.ok.handle, checks: [{ verb: "list", group: "", resource: "pods", namespace: NS }] });
    expect(access).toEqual({ error: expect.stringMatching(/not connected/) });
  });
});
