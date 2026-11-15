// Helm releases (wave 4, part 4; D42–D43) in the built app against OrbStack, read-only: the landlens-demo chart's
// two revisions in landlens-dev (deploy/scenarios/helm/README.md). Writes nothing to the cluster.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const shot = async (page: Page, name: string, colorScheme: "dark" | "light" = "dark") => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};
const DUMMIES = /demo-dev-password|demo-dev-api-key|ZGVtby1kZXYtcGFzc3dvcmQ/;

describe.runIf(run)("Helm releases on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  const sidebar = () => page.getByRole("complementary", { name: "Resources" });
  const drawer = () => page.getByRole("complementary", { name: "Helm release landlens-demo" });

  beforeAll(async () => {
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-")) },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it("lists releases as the last Workloads item, with chart, revision and status", async () => {
    const item = sidebar().getByRole("group", { name: "Workloads" }).getByRole("button", { name: "Helm releases", exact: true });
    await item.click();
    await page.getByRole("heading", { name: "Helm releases" }).waitFor();
    await expect.poll(() => page.locator(".thead [role=columnheader]").allInnerTexts()).toEqual(["Name", "Namespace", "Chart", "App version", "Revision", "Status", "Updated"]);
    const row = page.locator(".tr", { hasText: "landlens-demo" }).first();
    await row.waitFor({ timeout: 15_000 });
    expect(await row.innerText()).toMatch(/landlens-demo[\s\S]*landlens-dev[\s\S]*landlens-demo-0\.1\.0[\s\S]*1\.0\.0[\s\S]*\b2\b[\s\S]*deployed/);
    await shot(page, "w4-40-helm-list");
    await row.click();
  }, 60_000);

  it("shows the overview, values with secrets hidden, the manifest and the history's diff", async () => {
    const d = drawer();
    await d.waitFor();
    await expect.poll(() => d.innerText()).toMatch(/Chart\s*landlens-demo-0\.1\.0[\s\S]*Last action\s*Upgrade complete/);
    expect(await d.innerText()).toMatch(/Objects\s*3/);
    await shot(page, "w4-41-helm-overview");

    await d.getByRole("tab", { name: "Values" }).click();
    await expect.poll(() => d.innerText()).toMatch(/message: hi/);
    await d.getByRole("button", { name: "All", exact: true }).click();
    await expect.poll(() => d.innerText()).toMatch(/adminPassword: <hidden · 17 characters>/);
    expect(await d.innerText()).toMatch(/2 values that look secret are hidden/);
    await shot(page, "w4-42-helm-values");

    await d.getByRole("tab", { name: "Manifest" }).click();
    await expect.poll(() => d.innerText()).toMatch(/kind: Secret[\s\S]*password: <hidden/);

    await d.getByRole("tab", { name: "History" }).click();
    await d.getByRole("button", { name: "Diff values with current" }).first().click();
    const diff = d.getByRole("region", { name: /Values, revision 1 to 2/ });
    await diff.waitFor();
    expect(await diff.innerText()).toMatch(/message: hi/);
    await shot(page, "w4-43-helm-history");

    // Nothing the window got holds a dummy secret.
    expect(await page.content()).not.toMatch(DUMMIES);
  }, 60_000);

  it("opens an object from the drawer, and asks Claude with the release as quoted data", async () => {
    const d = drawer();
    await d.getByRole("tab", { name: "Overview" }).click();
    await d.getByRole("button", { name: "Ask Claude" }).click();
    await page.locator(".dock").getByText(/helm landlens-dev\/landlens-demo|Helm release landlens-dev\/landlens-demo/).first().waitFor();
    await page.keyboard.press("Meta+J");
    await d.getByRole("button", { name: /Deployment\/landlens-demo/ }).click();
    await page.getByRole("heading", { name: "Deployments" }).waitFor();
    await page.locator(".drawer").getByRole("heading", { name: "landlens-demo" }).waitFor({ timeout: 15_000 });
  }, 60_000);
});
