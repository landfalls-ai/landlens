// Launches the built app against the OrbStack cluster and walks the wave-1 path:
// pick a cluster → pods appear live → filter → open a pod → its YAML; plus the renderer's security posture.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

describe.runIf(run)("Landlens app on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "" },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("shows the kubeconfig contexts", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await expect(page.getByRole("button", { name: /orbstack/ }).first().isVisible()).resolves.toBe(true);
    await shot(page, "01-welcome");
  });

  it("runs the page sandboxed: no Node, no require, no process", async () => {
    const probe = await page.evaluate(() => ({
      require: typeof (globalThis as any).require,
      process: typeof (globalThis as any).process,
      bridge: Object.keys((globalThis as any).landlens ?? {}).sort(),
    }));
    expect(probe).toEqual({ require: "undefined", process: "undefined", bridge: ["invoke", "on"] });
  });

  it("refuses channels the bridge doesn't list", async () => {
    const err = await page.evaluate(() => (globalThis as any).landlens.invoke("shell:exec", {}).then(() => "", (e: Error) => e.message));
    expect(err).toContain("unknown channel");
  });

  it("connects and lists live pods, filters, and opens one", async () => {
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Pods" }).waitFor({ timeout: 30_000 });
    await page.locator(".tr").first().waitFor({ timeout: 30_000 });
    expect(await page.locator(".tr").count()).toBeGreaterThan(3);
    await shot(page, "02-pods-all-namespaces");

    await page.getByRole("combobox", { name: "Namespace" }).selectOption("kube-system");
    await page.locator(".tr", { hasText: "coredns" }).first().waitFor();
    await page.locator(".tr", { hasText: "coredns" }).first().click();
    await page.getByRole("tab", { name: /Overview/ }).waitFor();
    await expect(page.locator(".drawer").textContent()).resolves.toContain("coredns");
    await shot(page, "03-pod-details");

    await page.getByRole("tab", { name: "YAML" }).click();
    await expect(page.locator(".yaml").textContent()).resolves.toContain("kind: Pod");
    await expect(page.locator(".yaml").textContent()).resolves.not.toContain("managedFields");
    await shot(page, "04-pod-yaml");
  }, 60_000);

  it("shows deployments across namespaces", async () => {
    await page.getByRole("button", { name: "Deployments" }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("");
    await page.locator(".tr").first().waitFor({ timeout: 30_000 });
    await shot(page, "05-deployments");
  }, 60_000);

  it("never shows Secret values", async () => {
    await page.getByRole("button", { name: "Secrets" }).click();
    await page.locator(".tr").first().waitFor({ timeout: 30_000 });
    await page.locator(".tr").first().click();
    await page.getByRole("tab", { name: "YAML" }).click();
    const yaml = (await page.locator(".yaml").textContent()) ?? "";
    expect(yaml).toMatch(/kind: Secret/);
    // Every data value is replaced with its size.
    const data = /^data:\n((?: {2}.*\n?)+)/m.exec(yaml)?.[1] ?? "";
    const values = [...data.matchAll(/^ {2}[\w.-]+: (.+)$/gm)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/bytes|••••••/);
    await shot(page, "06-secret-redacted");
  }, 60_000);
});
