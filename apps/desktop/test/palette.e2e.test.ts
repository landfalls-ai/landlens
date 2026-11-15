// The ⌘K search (wave 4, part 4; D44–D45) in the built app against OrbStack, read-only: objects across kinds by name
// (the landlens-demo chart's ConfigMap, Secret and Deployment in landlens-dev, deploy/scenarios/helm/README.md), a
// verb as the first word, Tab for an object's actions, `>` for commands and recent items. Opens a pod shell and a
// local terminal and closes them; writes nothing to the cluster.
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

describe.runIf(run)("the ⌘K search on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  const dialog = () => page.getByRole("dialog", { name: "Search" });
  const input = () => dialog().getByRole("combobox", { name: "Search" });
  const options = () => dialog().getByRole("option").allInnerTexts();
  const open = async (q = "") => {
    await page.keyboard.press("Meta+K");
    await input().waitFor();
    if (q) await input().fill(q);
  };

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
    // Live sessions would ask before quitting; end them first.
    await page?.evaluate(() => (globalThis as any).document.querySelectorAll(".bench-tab .icon-btn").forEach((b: any) => b.click())).catch(() => {});
    await app?.close();
  });

  it("finds objects of every kind by name and opens one in its list's drawer", async () => {
    await open("landlens-demo");
    await expect.poll(options, { timeout: 20_000 }).toEqual(expect.arrayContaining([
      expect.stringMatching(/^landlens-demo\s*Deployment · landlens-dev/),
      expect.stringMatching(/^landlens-demo\s*ConfigMap · landlens-dev/),
      expect.stringMatching(/^landlens-demo-auth\s*Secret · landlens-dev/),
    ]));
    expect(await dialog().getByRole("listbox").innerText()).toMatch(/Objects[\s\S]*Kinds|Objects/);
    expect(await dialog().innerText()).toMatch(/\d+ objects/);
    await shot(page, "w4-50-search");
    await dialog().getByRole("option", { name: /^landlens-demo\s*Deployment/ }).click();
    await page.getByRole("heading", { name: "Deployments" }).waitFor();
    await page.locator(".drawer").getByRole("heading", { name: "landlens-demo" }).waitFor({ timeout: 15_000 });
  }, 60_000);

  it("shows recent items and the open object's actions when empty", async () => {
    await open();
    await expect.poll(() => dialog().getByRole("listbox").innerText()).toMatch(/Actions for landlens-demo[\s\S]*Logs of landlens-demo[\s\S]*Recent[\s\S]*landlens-demo/);
    await shot(page, "w4-51-search-empty");
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "detached" });
  }, 30_000);

  it("turns matches into an action with a first word, and runs it", async () => {
    await open("logs landlens-demo");
    await expect.poll(options, { timeout: 15_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^Logs of landlens-demo\s*Deployment · landlens-dev/)]));
    // A Secret, a ConfigMap and a Service have no logs.
    expect((await options()).some((o) => /Secret|ConfigMap/.test(o))).toBe(false);
    await shot(page, "w4-52-search-verb");
    await dialog().getByRole("option", { name: /^Logs of landlens-demo\s*Deployment/ }).click();
    await expect.poll(() => page.locator(".drawer").getByRole("tab", { name: "Logs" }).getAttribute("aria-selected"), { timeout: 15_000 }).toBe("true");
  }, 60_000);

  it("lists an object's actions on Tab, and a Secret's are only Ask Claude", async () => {
    await open("landlens-demo-auth");
    const row = dialog().getByRole("option", { name: /^landlens-demo-auth\s*Secret/ });
    await row.waitFor({ timeout: 15_000 });
    await row.hover();
    await input().press("Tab");
    await expect.poll(options).toEqual([expect.stringMatching(/^Ask Claude about landlens-demo-auth/)]);
    await expect(dialog().getByRole("button", { name: "Back" }).innerText()).resolves.toContain("landlens-demo-auth");
    await input().press("Backspace");
    await expect.poll(options).toEqual(expect.arrayContaining([expect.stringMatching(/^landlens-demo-auth\s*Secret/)]));
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "detached" });
  }, 30_000);

  it("opens a shell in a pod from a first word, and a local terminal from > commands", async () => {
    await open("shell landlens-demo-");
    const row = dialog().getByRole("option", { name: /^Open shell in landlens-demo-[a-z0-9]+-[a-z0-9]+\s*Pod/ }).first();
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    const panel = page.getByRole("region", { name: "Panel" });
    await expect.poll(() => page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab").first().getAttribute("aria-label"), { timeout: 15_000 }).toMatch(/Shell: app in landlens-dev\/landlens-demo-/);
    await open("> new local");
    await expect.poll(options).toEqual([expect.stringMatching(/^New local terminal/)]);
    await shot(page, "w4-53-search-commands");
    await input().press("Enter");
    await expect.poll(async () => (await panel.locator(".bench-pane:not([hidden]) .term-id").textContent())?.replace(/\s+/g, " "), { timeout: 10_000 }).toMatch(/on this Mac/);
  }, 60_000);
});
