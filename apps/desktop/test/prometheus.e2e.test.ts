// Prometheus as the graphs' source (wave 4, part 4) in the built app against OrbStack: the scenario's Prometheus in
// landlens-dev (deploy/scenarios/prometheus, backfilled cAdvisor-shaped series for the landlens-demo chart's pods),
// with no Clickland. Starts the scenario and removes it afterwards, so other files still see no metrics source.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const ROOT = resolve(__dirname, "../../..");
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
const shot = async (page: Page, name: string, colorScheme: "dark" | "light" = "dark") => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

describe.runIf(run)("graphs from Prometheus on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    execFileSync("node", [resolve(ROOT, "deploy/scenarios/prometheus/up.mjs")], { stdio: "ignore" });
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-")) },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (run) {
      kubectl("delete", "-f", resolve(ROOT, "deploy/scenarios/prometheus/prometheus.yaml"), "--ignore-not-found");
      kubectl("delete", "configmap", "landlens-prometheus-data", "--ignore-not-found");
    }
  }, 120_000);

  it("draws the Overview's usage from the cluster's Prometheus, and names it", async () => {
    const usage = page.getByRole("region", { name: "Usage" });
    const src = usage.locator(".metrics-src", { hasText: "Prometheus" });
    await src.waitFor({ timeout: 30_000 });
    expect(await src.innerText()).toMatch(/Prometheus\s*landlens-prometheus/);
    expect(await src.getAttribute("title")).toContain("landlens-dev/landlens-prometheus");
    expect(await usage.innerText()).toContain("landlens-dev");
    await shot(page, "w4-60-overview-prometheus");
  }, 60_000);

  it("draws a deployment's pods in its Metrics tab", async () => {
    await page.getByRole("button", { name: "Deployments", exact: true }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
    await page.locator(".tr", { hasText: "landlens-demo" }).first().click();
    await page.getByRole("tab", { name: "Metrics" }).click();
    const tab = page.locator(".mtab");
    await tab.locator(".chart-plot svg path.line").first().waitFor({ timeout: 30_000 });
    expect(await tab.locator(".chart-legend").first().textContent()).toMatch(/landlens-demo-[a-z0-9]+-[a-z0-9]+/);
    expect(await tab.innerText()).toMatch(/Prometheus\s*landlens-prometheus/);
    await shot(page, "w4-61-deployment-prometheus");
  }, 60_000);
});
