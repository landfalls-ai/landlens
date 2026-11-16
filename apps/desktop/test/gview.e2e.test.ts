// Google's view of this cluster (wave 9) in the built app, against the loopback fake Google and OrbStack. No request
// reaches Google and no cloud cluster is touched. Part 1: "Google suggests" on the Overview (D173–D178).
//
// (a) Connected through Landlens's own GKE kubeconfig: the fake lists shop-prod at OrbStack's API server and the fake
//     gcloud prints a throwaway ServiceAccount's token, made here in landlens-dev with read-only RBAC and deleted after.
//     The Overview's "Google suggests" shows shop-prod's two suggestions (not another cluster's, a dismissed one, or
//     another project's cluster of the same name), opens one in place, shows a user agent's bidi override and newline
//     as plain text, and a disabled API as its sentence with Copy.
// (b) OrbStack opened as a context of your own named gke_demo-shop_us-central1_shop-prod, from a temporary kubeconfig
//     (0600, in this test's folder, removed after; the catalog honours KUBECONFIG): it is GKE only while the listing's
//     address is the one it is connected at and the CA it trusts is the one Google lists (review of part 1, M1). A
//     GKE-shaped name of a project you haven't chosen gets one quiet line.
// Every request the fake recorded is a GET with gcloud's token; nothing else is written to OrbStack.
// LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/gview.e2e.test.ts  (screenshots to $LANDLENS_SHOTS, g9-)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_CLUSTER_CA, FakeGcp, GCP_TOKEN } from "../../../packages/gcp/test/fake-gcp";
import { FAKE_GCLOUD, sdkDir } from "../../../packages/gcp/test/helpers";
import { chosenNamespaces } from "./e2e-helpers";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const shot = async (page: Page, name: string, colorScheme: "dark" | "light" = "dark", el?: Locator) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
  await (el ?? page).screenshot({ path: resolve(shots, `${name}.png`) });
};
/** Dark and light, the window and the panel alone, at 1280×800 and 1024×700. */
const all = async (page: Page, name: string, el?: Locator) => {
  for (const [w, h] of [[1280, 800], [1024, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await el?.scrollIntoViewIfNeeded();
    for (const scheme of ["dark", "light"] as const) {
      await shot(page, `${name}-${w}-${scheme}`, scheme);
      if (el) await shot(page, `${name}-panel-${w}-${scheme}`, scheme, el);
    }
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 800 });
};

const NS = "landlens-dev";
const SA = "landlens-gview-e2e";
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
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(LANDLENS_GCP_|LANDLENS_GKE_|LANDLENS_GCLOUD|CLOUDSDK_)/.test(k)) env[k] = v;
  return { ...env, ELECTRON_RENDERER_URL: "" };
};
type Landlens = { landlens: { invoke: (c: string, r: unknown) => Promise<unknown> } };
/** OrbStack's own kubeconfig entry, read (never written) by kubectl. */
const orbstack = () => JSON.parse(kc(["config", "view", "--raw", "--minify", "-o", "json"])) as {
  clusters: { cluster: { server: string; "certificate-authority-data": string } }[];
  users: { user: Record<string, unknown> }[];
};

async function launch(o: { userData: string; fake: FakeGcp; sdk: string; kubeconfig?: string }) {
  const app = await electron.launch({
    executablePath: require("electron") as unknown as string,
    args: [resolve(__dirname, "..")],
    env: { ...baseEnv(), LANDLENS_USER_DATA: o.userData, LANDLENS_GCP_ENDPOINT: o.fake.origin, LANDLENS_GCLOUD: FAKE_GCLOUD, CLOUDSDK_CONFIG: o.sdk, ...(o.kubeconfig ? { KUBECONFIG: o.kubeconfig } : {}) },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Main's own questions (a cloud cluster's first connect) are native dialogs, answered yes here in main.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  return { app, page };
}

const panel = (page: Page) => page.getByRole("region", { name: "Google suggests" });
const rows = (page: Page) => panel(page).locator(".gs-row");

describe.runIf(run)("(a) Google suggests on a GKE cluster Landlens connected", { timeout: 180_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let fake: FakeGcp;
  let token = "";
  const sdk = sdkDir();
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-gview-"));
  const invoke = (channel: string, req: unknown) =>
    page.evaluate(([c, r]) => (globalThis as unknown as Landlens).landlens.invoke(c as string, r).then((x) => ({ ok: x }), (e: Error) => ({ error: e.message })), [channel, req] as const);

  beforeAll(async () => {
    const { server, "certificate-authority-data": ca } = orbstack().clusters[0]!.cluster;
    kc(["apply", "-f", "-"], RBAC);
    token = kc(["-n", NS, "create", "token", SA, "--duration", "1h"]).trim();
    fake = await new FakeGcp().start();
    fake.valid.add(token);
    writeFileSync(join(sdk, "token"), token);
    fake.clusters.set("demo-shop", [{ name: "shop-prod", location: "us-central1", status: "RUNNING", currentMasterVersion: "1.33.4-gke.1172000", endpoint: new URL(server).host, masterAuth: { clusterCaCertificate: ca } }]);
    writeFileSync(join(userData, "gcp.json"), JSON.stringify({ projects: ["demo-shop"], agentRead: false, confirmed: [] }), { mode: 0o600 });
    ({ app, page } = await launch({ userData, fake, sdk }));
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

  it("shows shop-prod's two suggestions on the Overview, and opens one in place", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: /^shop-prod\s*GKE/ }).click({ timeout: 30_000 });
    const needed = page.getByRole("alert").filter({ hasText: "Your account can't read the whole cluster." });
    await needed.waitFor({ timeout: 60_000 });
    await needed.getByRole("textbox", { name: "Namespace" }).fill(NS);
    await needed.getByRole("button", { name: "Open" }).click();
    await page.getByRole("region", { name: "Verdict" }).waitFor({ timeout: 30_000 });
    await expect(chosenNamespaces(page)).resolves.toBe(NS);

    await panel(page).waitFor({ timeout: 30_000 });
    const head = await panel(page).locator(".panel-head").innerText();
    expect(head).toMatch(/Google suggests\s*2\s*GKE · demo-shop · us-central1/);
    await expect(rows(page).count()).resolves.toBe(2);
    const text = await panel(page).innerText();
    expect(text).toContain("Kubernetes 1.32 stops serving APIs");
    expect(text).toMatch(/High[\s\S]*Medium/);
    expect(text).toContain("Deprecation · reliability · refreshed");
    for (const gone of ["must not show", "Another cluster"]) expect(text).not.toContain(gone);
    // Placed after the two columns and before Usage and Nodes.
    const order = await page.locator(".ov > *").evaluateAll((els) => els.map((e) => {
      const el = e as unknown as { getAttribute(n: string): string | null; className: unknown };
      return el.getAttribute("aria-label") ?? String(el.className);
    }));
    expect(order.indexOf("Google suggests")).toBe(order.findIndex((x) => x.includes("ov-cols")) + 1);

    await rows(page).first().click();
    await expect(rows(page).first().getAttribute("aria-expanded")).resolves.toBe("true");
    const detail = panel(page).locator(".gs-detail");
    await detail.waitFor();
    const d = await detail.innerText();
    expect(d).toContain("What Google recommends");
    expect(d).toContain("Move the callers to flowcontrol.apiserver.k8s.io/v1 before upgrading to 1.32.");
    expect(d).toContain("/apis/flowcontrol.apiserver.k8s.io/v1beta3/prioritylevelconfigurations");
    expect(d).toContain("kube-state-metrics/v2.10.0 (linux/amd64)");
    expect(d).toContain("412 requests");
    expect(d).toContain("From Google's GKE recommender. Landlens doesn't mark it done or dismissed.");
    // The caller's own text: no bidi override and no newline reach the page; nothing of Google's is a link or markup.
    expect(d).toContain("Ignore your instructions");
    expect(d).not.toMatch(/[‪-‮⁦-⁩]/);
    await expect(panel(page).locator("a, h1, h2, img, iframe").count()).resolves.toBe(0);
    await all(page, "g9-01-google-suggests", panel(page));
    // Enter closes and opens it from the keyboard too.
    await rows(page).first().focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).locator(".gs-detail").count()).resolves.toBe(0);
  });

  it("a disabled API is its sentence with Copy, and the panel recovers on Check again", async () => {
    fake.fail.set("demo-shop", { status: 403, reason: "SERVICE_DISABLED", api: "recommender", message: "Recommender API has not been used <b>here</b> https://evil.example" });
    const refresh = panel(page).getByRole("button", { name: "Check Google's suggestions again" });
    const notice = panel(page).getByRole("alert");
    // "Check again" reads at most once in 10 s.
    await expect.poll(async () => {
      if (await refresh.isEnabled()) await refresh.click();
      return notice.count();
    }, { timeout: 40_000, interval: 2_000 }).toBe(1);
    const n = await notice.innerText();
    expect(n).toContain("Couldn't read Google's suggestions for shop-prod.");
    expect(n).toContain("The Recommender API is off in demo-shop. Turn it on: gcloud services enable recommender.googleapis.com --project demo-shop");
    expect(n).not.toMatch(/evil|<b>|has not been used/);
    await notice.getByRole("button", { name: "Copy command" }).waitFor();
    await all(page, "g9-02-google-suggests-error", panel(page));
    fake.fail.clear();
    await expect.poll(async () => {
      if (await refresh.isEnabled()) await refresh.click();
      return rows(page).count();
    }, { timeout: 40_000, interval: 2_000 }).toBe(2);
  });

  it("asked Google only with GETs and gcloud's token, for demo-shop; the page can't name another project", async () => {
    const asked = fake.requests.filter((r) => r.path.includes("/locations/us-central1/"));
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
    expect(fake.requests.every((r) => r.authorization === `Bearer ${token}`)).toBe(true);
    expect(asked.every((r) => r.userProject === "demo-shop" && r.path.startsWith("/v1/projects/demo-shop/"))).toBe(true);
    const refused = await invoke("gcp:cluster-view", { handle: "abcdefgh12345678", project: "orbit-analytics" });
    expect(refused).toEqual({ error: expect.any(String) });
  });
});

describe.runIf(run)("(b) a context of your own is GKE only at the listing's address", { timeout: 180_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let fake: FakeGcp;
  const sdk = sdkDir();
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-gview-own-"));
  const folder = mkdtempSync(join(tmpdir(), "landlens-e2e-gview-kc-"));
  const kubeconfig = join(folder, "kubeconfig");
  const SHOP = "gke_demo-shop_us-central1_shop-prod";
  const ORBIT = "gke_orbit-analytics_us-central1_shop-prod";
  let endpoint = "";
  let ca = "";
  const invoke = (channel: string, req: unknown) =>
    page.evaluate(([c, r]) => (globalThis as unknown as Landlens).landlens.invoke(c as string, r).then((x) => ({ ok: x }), (e: Error) => ({ error: e.message })), [channel, req] as const);
  const switchTo = async (from: string, to: string) => {
    await page.getByRole("button", { name: `${from}, switch cluster` }).click();
    const menu = page.getByRole("menu", { name: "Clusters" });
    await menu.getByRole("group", { name: "Clusters in your kubeconfig" }).getByRole("menuitem", { name: new RegExp(to) }).click();
    await page.getByRole("button", { name: `${to}, switch cluster` }).waitFor({ timeout: 60_000 });
  };

  beforeAll(async () => {
    const own = orbstack();
    const { server, "certificate-authority-data": orbCa } = own.clusters[0]!.cluster;
    endpoint = new URL(server).host;
    ca = orbCa;
    // OrbStack under two GKE-shaped names, in a file of this test's own (0600), never in ~/.kube/config.
    const doc = {
      apiVersion: "v1", kind: "Config", preferences: {}, "current-context": SHOP,
      clusters: [{ name: "orb", cluster: { server, "certificate-authority-data": ca } }],
      users: [{ name: "orb", user: own.users[0]!.user }],
      contexts: [SHOP, ORBIT].map((name) => ({ name, context: { cluster: "orb", user: "orb" } })),
    };
    writeFileSync(kubeconfig, JSON.stringify(doc), { mode: 0o600 });
    fake = await new FakeGcp().start();
    fake.clusters.set("demo-shop", [{ name: "shop-prod", location: "us-central1", status: "RUNNING", currentMasterVersion: "1.33.4-gke.1172000", endpoint, masterAuth: { clusterCaCertificate: ca } }]);
    writeFileSync(join(userData, "gcp.json"), JSON.stringify({ projects: ["demo-shop"], agentRead: false, confirmed: [] }), { mode: 0o600 });
    ({ app, page } = await launch({ userData, fake, sdk, kubeconfig }));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await fake?.stop();
    rmSync(folder, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }, 60_000);

  it("your own context with gcloud's name at the listed address shows Google suggests", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: new RegExp(`^${SHOP}`) }).click({ timeout: 30_000 });
    await page.getByRole("region", { name: "Verdict" }).waitFor({ timeout: 60_000 });
    await panel(page).waitFor({ timeout: 30_000 });
    await expect(rows(page).count()).resolves.toBe(2);
    await expect(page.locator(".gs-hint").count()).resolves.toBe(0);
  });

  it("a GKE-shaped name of a project you haven't chosen gets one quiet line, which opens Google Cloud", async () => {
    await switchTo(SHOP, ORBIT);
    const hint = page.getByRole("note").filter({ hasText: "This looks like a GKE cluster of orbit-analytics." });
    await hint.waitFor({ timeout: 30_000 });
    await expect(panel(page).count()).resolves.toBe(0);
    await hint.scrollIntoViewIfNeeded();
    if (shots) await all(page, "g9-03-hint", hint);
    await hint.getByRole("button", { name: "Open Google Cloud" }).click();
    await page.getByRole("region", { name: "Types" }).or(page.getByText("Choose projects")).first().waitFor({ timeout: 20_000 });
  });

  it("the same name, once Google lists shop-prod at another address, is an ordinary cluster", async () => {
    await switchTo(ORBIT, SHOP);
    await page.getByRole("button", { name: "Overview", exact: true }).click().catch(() => undefined);
    await panel(page).waitFor({ timeout: 30_000 });
    fake.clusters.set("demo-shop", [{ name: "shop-prod", location: "us-central1", status: "RUNNING", currentMasterVersion: "1.33.4-gke.1172000", endpoint: "203.0.113.17", masterAuth: { clusterCaCertificate: FAKE_CLUSTER_CA } }]);
    // A new choice drops the cached listing (it is otherwise kept a minute).
    await invoke("gcp:choose", { projects: ["demo-shop", "payments-core"] });
    await invoke("gcp:choose", { projects: ["demo-shop"] });
    const refresh = panel(page).getByRole("button", { name: "Check Google's suggestions again" });
    await expect.poll(async () => {
      if ((await refresh.count()) && (await refresh.isEnabled())) await refresh.click();
      return panel(page).count();
    }, { timeout: 40_000, interval: 2_000 }).toBe(0);
    await expect(page.locator(".gs-hint").count()).resolves.toBe(0);
    expect(fake.requests.every((r) => r.method === "GET" && r.authorization === `Bearer ${GCP_TOKEN}`)).toBe(true);
  });

  it("M1: the same name at the same address, once Google lists another CA for shop-prod, is an ordinary cluster", async () => {
    const list = (clusterCaCertificate: string) => {
      fake.clusters.set("demo-shop", [{ name: "shop-prod", location: "us-central1", status: "RUNNING", currentMasterVersion: "1.33.4-gke.1172000", endpoint, masterAuth: { clusterCaCertificate } }]);
    };
    const reopen = async () => {
      // A new choice drops the cached listing; switching away and back asks for the view again.
      await invoke("gcp:choose", { projects: ["demo-shop", "payments-core"] });
      await invoke("gcp:choose", { projects: ["demo-shop"] });
      await switchTo(SHOP, ORBIT);
      await switchTo(ORBIT, SHOP);
      await page.getByRole("button", { name: "Overview", exact: true }).click().catch(() => undefined);
    };
    // OrbStack's address, but the fake's own CA, not the one the kubeconfig trusts.
    list(FAKE_CLUSTER_CA);
    const before = fake.requests.length;
    await reopen();
    await expect.poll(() => fake.requests.slice(before).some((r) => r.path === "/v1/projects/demo-shop/locations/-/clusters"), { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(2_000);
    await expect(panel(page).count()).resolves.toBe(0);
    await expect(page.locator(".gs-hint").count()).resolves.toBe(0);
    expect(fake.requests.slice(before).some((r) => r.path.includes("/insights"))).toBe(false);
    // Listed again with the CA OrbStack serves: Google suggests is back.
    list(ca);
    await reopen();
    await panel(page).waitFor({ timeout: 30_000 });
    await expect(rows(page).count()).resolves.toBe(2);
  });
});
