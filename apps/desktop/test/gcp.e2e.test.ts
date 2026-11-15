// Google Cloud (wave 6 part 4) in the built app, against the loopback fake of Google's three APIs and the fake gcloud
// (packages/gcp/test): no request reaches Google, and gcloud isn't needed. Off without an override; gcloud missing;
// then choose projects, browse types with counts, page 1,200 resources, the 5,000 cut, a resource's drawer and JSON, a
// Cloud Asset query, each error sentence, signed out; then, with a cluster connected, the sidebar's Google Cloud and ⌘K.
// LANDLENS_INTEGRATION=orbstack npx vitest run test/gcp.e2e.test.ts  (screenshots to $LANDLENS_SHOTS)
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGcp, GCP_TOKEN } from "../../../packages/gcp/test/fake-gcp";
import { FAKE_GCLOUD, sdkDir } from "../../../packages/gcp/test/helpers";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
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

/** The app's environment without any Google Cloud override the shell may carry. */
const baseEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(LANDLENS_GCP_|LANDLENS_GCLOUD|CLOUDSDK_)/.test(k)) env[k] = v;
  return { ...env, ELECTRON_RENDERER_URL: "" };
};
const launch = (env: Record<string, string>) => electron.launch({ executablePath: require("electron") as unknown as string, args: [resolve(__dirname, "..")], env: { ...baseEnv(), ...env } });

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

describe.runIf(run)("Google Cloud is off or unavailable without the right setup", { timeout: 60_000 }, () => {
  it("is off in a development build with no override, and nothing is asked", async () => {
    const app = await launch({ LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-gcp-off-")) });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 880 });
      await page.getByRole("button", { name: /^Google Cloud/ }).click();
      await page.getByText("Off in development builds").waitFor();
      await both(page, "g4-00-off-dev");
    } finally {
      await app.close();
    }
  });

  it("says to install gcloud when it isn't found", async () => {
    const fake = await new FakeGcp().start();
    const app = await launch({ LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-gcp-missing-")), LANDLENS_GCP_ENDPOINT: fake.origin, LANDLENS_GCLOUD: "/nonexistent/gcloud" });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 880 });
      await page.getByRole("button", { name: /^Connections/ }).click();
      const card = page.getByRole("region", { name: "Google Cloud connection" });
      await card.getByText("Install the Google Cloud CLI, then run").waitFor();
      await card.getByRole("button", { name: "Check again" }).click();
      await card.getByText("gcloud not found").waitFor();
      await both(page, "g4-01-gcloud-missing");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await app.close();
      await fake.stop();
    }
  });
});

describe.runIf(run)("Google Cloud against the fake", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let fake: FakeGcp;
  const sdk = sdkDir();
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-gcp-"));

  beforeAll(async () => {
    fake = await new FakeGcp().start();
    app = await launch({ LANDLENS_USER_DATA: userData, LANDLENS_GCP_ENDPOINT: fake.origin, LANDLENS_GCLOUD: FAKE_GCLOUD, CLOUDSDK_CONFIG: sdk });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await fake?.stop();
  }, 60_000);

  const types = () => page.getByRole("region", { name: "Types" });
  const projects = () => page.getByRole("region", { name: "Projects" });
  const resources = () => page.getByRole("region", { name: "Resources" });
  const typeButton = (name: string) => types().getByRole("button", { name: new RegExp(`^${name}\\s*[\\d,]+$`) });

  it("opens from Welcome, with no cluster, and asks for projects", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: /^Google Cloud/ }).click();
    await page.getByRole("heading", { name: "Google Cloud" }).waitFor();
    await page.getByText("Choose the projects to browse").waitFor();
    await page.getByRole("button", { name: "Choose projects…" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose projects" });
    await dialog.getByRole("checkbox", { name: "demo-shop" }).waitFor();
    // Only active projects: the one being deleted isn't offered.
    expect(await dialog.getByRole("checkbox").count()).toBe(5);
    await expect(dialog.getByRole("checkbox", { name: "old-prototype" }).count()).resolves.toBe(0);
    for (const p of ["demo-shop", "orbit-analytics", "archive-vault", "payments-core", "ml-sandbox-42"]) await dialog.getByRole("checkbox", { name: p }).check();
    await both(page, "g4-02-choose-projects");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
  });

  it("shows the project's types grouped by service with counts, and its resources", async () => {
    await typeButton("All").waitFor();
    const all = fake.assets("demo-shop").length;
    expect(await typeButton("All").innerText()).toContain(String(all));
    for (const group of ["Compute Engine", "Kubernetes Engine", "Cloud SQL", "Cloud Storage", "Pub/Sub", "IAM"]) await types().getByRole("group", { name: group }).waitFor();
    expect(await types().getByRole("group", { name: "Cloud SQL" }).innerText()).toMatch(/Instance\s*4/);
    await resources().getByText(`${all} resources`).waitFor();
    await both(page, "g4-03-browse-all");
    await types().getByRole("group", { name: "Compute Engine" }).getByRole("button", { name: /^Instance/ }).click();
    await resources().getByText("9 resources").waitFor();
    await both(page, "g4-04-browse-instances");
    // One read of the project: the types and every type's rows come from it.
    expect(fake.hits("demo-shop:searchAllResources").filter((r) => !r.query.query)).toHaveLength(1);
  });

  it("opens a resource: its summary, labels and its own JSON", async () => {
    await resources().getByRole("row", { name: /web-frontend-1/ }).click();
    const drawer = page.getByRole("complementary", { name: "Google Cloud resource web-frontend-1" });
    await drawer.getByText("//compute.googleapis.com/projects/demo-shop/zones/us-central1-a/instances/web-frontend-1").waitFor();
    expect(await drawer.innerText()).toContain("Compute Engine");
    await both(page, "g4-05-drawer-summary");
    await drawer.getByRole("tab", { name: "JSON" }).click();
    const json = drawer.locator(".gcp-json .cm-content");
    await json.waitFor();
    await expect(json.getAttribute("aria-label")).resolves.toBe("Resource JSON");
    expect(await json.innerText()).toContain("e2-standard-4");
    await both(page, "g4-06-drawer-json");
    expect(fake.requests.at(-1)!.query.readMask).toContain("versionedResources");
    await drawer.getByRole("button", { name: "Close details" }).click();
  });

  it("filters the rows it has, and sends Enter's text to Cloud Asset as a query", async () => {
    await types().getByRole("button", { name: /^All/ }).click();
    const box = resources().getByRole("searchbox", { name: "Filter resources" });
    await box.fill("orders");
    await resources().getByText(/^\d+ of \d+$/).waitFor();
    await box.fill("state:TERMINATED");
    await box.press("Enter");
    await resources().getByRole("button", { name: "Clear the query" }).waitFor();
    await resources().getByText("2 resources").waitFor();
    expect(fake.hits("searchAllResources").some((r) => r.query.query === "state:TERMINATED")).toBe(true);
    await both(page, "g4-07-query");
    await resources().getByRole("button", { name: "Clear the query" }).click();
  });

  it("pages a 1,200-resource project and cuts one of 6,000 at 5,000", async () => {
    await projects().getByRole("button", { name: /Orbit Analytics/ }).click();
    await resources().getByText("1,200 resources").waitFor({ timeout: 20_000 });
    expect(fake.hits("orbit-analytics:searchAllResources").map((r) => r.query.pageToken ?? "")).toEqual(["", "500", "1000"]);
    await projects().getByRole("button", { name: /Archive Vault/ }).click();
    await resources().getByText("Showing the first 5,000.").waitFor({ timeout: 30_000 });
    await resources().getByText("5,000 resources").waitFor({ timeout: 30_000 });
    expect(await types().innerText()).toContain("Counted from the first 5,000.");
    await both(page, "g4-08-cut");
  });

  it("says each failure as its sentence, in the Types column, while other projects still load", async () => {
    const sentence = async (fail: Parameters<FakeGcp["fail"]["set"]>[1] | "401", want: string) => {
      if (fail === "401") fake.valid.clear();
      else fake.fail.set("payments-core", fail);
      await projects().getByRole("button", { name: /Payments Core/ }).click();
      await types().getByRole("button", { name: "Read again" }).click().catch(() => undefined);
      await types().getByRole("alert").filter({ hasText: want }).waitFor({ timeout: 20_000 });
      fake.fail.clear();
      fake.valid.add(GCP_TOKEN);
    };
    await sentence({ status: 403, reason: "SERVICE_DISABLED" }, "The Cloud Asset API is off in payments-core. Turn it on: `gcloud services enable cloudasset.googleapis.com --project payments-core`.");
    await both(page, "g4-09-error-disabled");
    await sentence({ status: 403 }, "Your account can't list resources in payments-core (it needs Cloud Asset Viewer).");
    await sentence({ status: 429 }, "Google is limiting requests. Try again in a minute.");
    await sentence("401", "Google didn't accept gcloud's sign-in. Run `gcloud auth login`.");
    // Another project still loads.
    await projects().getByRole("button", { name: /Demo Shop/ }).click();
    await typeButton("All").waitFor();
  });

  it("says signed out on the Connections card and comes back on Check again", async () => {
    await page.getByRole("button", { name: "Clusters" }).click();
    await page.getByRole("button", { name: /^Connections/ }).click();
    const card = page.getByRole("region", { name: "Google Cloud connection" });
    await card.getByText("Signed in as person@example.com").waitFor();
    expect(await card.innerText()).toContain("demo-shop");
    await both(page, "g4-10-connections-card");
    writeFileSync(join(sdk, "account"), "");
    try {
      await page.evaluate(() => (globalThis as unknown as { landlens: { invoke: (c: string, r: unknown) => Promise<unknown> } }).landlens.invoke("gcp:status", { fresh: true }));
      await page.getByRole("button", { name: "Clusters" }).click();
      await page.getByRole("button", { name: /^Connections/ }).click();
      await card.getByText("gcloud isn't signed in. Run").waitFor();
      await both(page, "g4-11-signed-out");
    } finally {
      rmSync(join(sdk, "account"));
    }
    await card.getByRole("button", { name: "Check again" }).click();
    await card.getByText("Signed in as person@example.com").waitFor();
  });

  it("keeps no Google credential: the token went only to the fake, and no file or answer holds it", async () => {
    expect(fake.requests.length).toBeGreaterThan(10);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
    expect(JSON.parse(readFileSync(join(userData, "gcp.json"), "utf8"))).toEqual({ projects: ["demo-shop", "orbit-analytics", "archive-vault", "payments-core", "ml-sandbox-42"], agentRead: false });
    expect(statSync(join(userData, "gcp.json")).mode & 0o777).toBe(0o600);
    expect(allText(userData)).not.toContain(GCP_TOKEN);
    const answers = await page.evaluate(async () => {
      const l = (globalThis as unknown as { landlens: { invoke: (c: string, r: unknown) => Promise<unknown> } }).landlens;
      return JSON.stringify([await l.invoke("conn:list", {}), await l.invoke("gcp:status", {}), await l.invoke("gcp:projects", {}), await l.invoke("gcp:types", { project: "demo-shop" })]);
    });
    expect(answers).not.toContain("ya29");
    // A project not chosen is refused before any request.
    const before = fake.requests.length;
    const refused = await page.evaluate(() => (globalThis as unknown as { landlens: { invoke: (c: string, r: unknown) => Promise<unknown> } }).landlens.invoke("gcp:types", { project: "not-chosen-1" }).then(() => "ok", (e: Error) => e.message));
    expect(refused).toContain("Choose not-chosen-1");
    expect(fake.requests.length).toBe(before);
  });

  it("with a cluster: Google Cloud in the sidebar, ⌘K finds a resource by name, and the narrow window", async () => {
    await page.getByRole("button", { name: "Clusters" }).click();
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    const sidebar = page.getByRole("complementary", { name: "Resources" });
    await sidebar.getByRole("button", { name: "Google Cloud", exact: true }).click({ timeout: 30_000 });
    await typeButton("All").waitFor({ timeout: 20_000 });
    await resources().getByText(/\d+ resources/).waitFor();
    await types().getByRole("group", { name: "Cloud SQL" }).getByRole("button", { name: /^Instance/ }).click();
    await resources().getByRole("row", { name: /orders-db/ }).click();
    await page.getByRole("complementary", { name: "Google Cloud resource orders-db" }).waitFor();
    await both(page, "g4-12-workspace");
    await page.keyboard.press("Escape");
    await page.getByRole("complementary", { name: "Google Cloud resource orders-db" }).waitFor({ state: "detached" });
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox", { name: "Search" }).fill("checkout-api");
    const option = page.getByRole("option", { name: /checkout-api/ }).first();
    await option.waitFor();
    await both(page, "g4-13-jump");
    await option.click();
    await page.getByRole("complementary", { name: "Google Cloud resource checkout-api" }).waitFor();
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(300);
    await both(page, "g4-14-1024");
    await page.setViewportSize({ width: 1440, height: 880 });
  });
});
