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

  it("folds the sidebar's sections, remembers them across a reload, and folds all of them at once (D139)", async () => {
    const sidebar = page.getByRole("complementary", { name: "Resources" });
    const header = (s: string) => sidebar.locator(`.nav-sec[data-sec="${s}"]`);
    const expanded = (s: string) => header(s).getAttribute("aria-expanded");
    const states = () => sidebar.locator(".nav-sec").evaluateAll((bs: any[]) => bs.map((b) => `${b.getAttribute("data-sec")}:${b.getAttribute("aria-expanded")}`));
    const kind = (name: string) => sidebar.getByRole("button", { name, exact: true });
    await header("Workloads").waitFor({ timeout: 30_000 });
    expect(await expanded("Workloads")).toBe("true");
    const rows = await header("Workloads").getAttribute("aria-controls");
    expect(await page.locator(`[id="${rows}"]`).count()).toBe(1);
    await shot(page, "w7-nav-01-unfolded");
    await shot(page, "w7-nav-02-unfolded-light", "light");

    // Fold Workloads on Overview: its rows go, and the choice is stored.
    await header("Workloads").click();
    expect(await expanded("Workloads")).toBe("false");
    expect(await kind("Pods").count()).toBe(0);
    expect(await kind("Helm releases").count()).toBe(0);
    expect(JSON.parse((await page.evaluate(() => (globalThis as any).localStorage.getItem("landlens.nav.v1"))) ?? "{}").closed).toContain("Workloads");

    // Reload: back to Welcome, connect, and Workloads is still folded.
    await page.reload();
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await header("Workloads").waitFor({ timeout: 30_000 });
    expect(await expanded("Workloads")).toBe("false");

    // The page you are on stays under its folded header, alone; the header carries the roll-up (the demo's crash loop).
    await page.keyboard.press("Meta+2");
    await page.getByRole("heading", { name: "Pods" }).waitFor();
    await kind("Pods").waitFor();
    expect(await kind("Deployments").count()).toBe(0);
    await header("Workloads").locator(".nav-badge.bad").waitFor({ timeout: 30_000 });
    expect(await header("Workloads").innerText()).toMatch(/Workloads[\s\S]*\d/);
    await shot(page, "w7-nav-03-folded-active");
    await shot(page, "w7-nav-04-folded-active-light", "light");

    // ← and → on a header; ↓ steps into its rows.
    await header("Workloads").focus();
    await page.keyboard.press("ArrowRight");
    expect(await expanded("Workloads")).toBe("true");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => (globalThis as any).document.activeElement?.getAttribute("aria-label"))).toBe("Pods");
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => (globalThis as any).document.activeElement?.getAttribute("data-sec"))).toBe("Workloads");
    await page.keyboard.press("ArrowLeft");
    expect(await expanded("Workloads")).toBe("false");

    // Option-click folds every section, and again unfolds them all.
    await header("Network").click({ modifiers: ["Alt"] });
    await expect.poll(states).toEqual(expect.arrayContaining(["Workspace:false", "Cloud:false", "Workloads:false", "Network:false", "Cluster:false"]));
    expect((await states()).every((s) => s.endsWith(":false"))).toBe(true);
    // Problems and the page you are on still show.
    await kind("Problems").waitFor();
    await kind("Pods").waitFor();
    await page.setViewportSize({ width: 1024, height: 700 });
    await shot(page, "w7-nav-05-all-folded-1024");
    await shot(page, "w7-nav-06-all-folded-1024-light", "light");
    await header("Cluster").click({ modifiers: ["Alt"] });
    await expect.poll(async () => (await states()).every((s) => s.endsWith(":true"))).toBe(true);
    await shot(page, "w7-nav-07-all-unfolded-1024");
    await page.setViewportSize({ width: 1440, height: 880 });

    // The two ⌘K commands.
    await open("> fold all");
    await expect.poll(async () => (await options())[0]).toMatch(/^Fold all sections/);
    await input().press("Enter");
    await expect.poll(async () => (await states()).every((s) => s.endsWith(":false"))).toBe(true);
    await open("> unfold");
    await expect.poll(options).toEqual([expect.stringMatching(/^Unfold all sections/)]);
    await input().press("Enter");
    await expect.poll(async () => (await states()).every((s) => s.endsWith(":true"))).toBe(true);

    // The rail: one icon per kind section, its flyout listing the kinds; the folds are left alone. (A resize gives the
    // rail back to the width rules, so it is collapsed at 1024×700.)
    await header("Workloads").click();
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await shot(page, "w7-nav-08-rail-1024");
    const icon = sidebar.getByRole("button", { name: "Workloads", exact: true });
    await icon.click();
    const menu = page.getByRole("menu", { name: "Workloads" });
    expect(await menu.innerText()).toMatch(/Pods[\s\S]*Deployments[\s\S]*Helm releases/);
    await shot(page, "w7-nav-09-rail-flyout-1024");
    await shot(page, "w7-nav-10-rail-flyout-1024-light", "light");
    await menu.getByRole("menuitem", { name: "Deployments" }).click();
    await page.getByRole("heading", { name: "Deployments" }).waitFor();
    await page.keyboard.press("Meta+B");
    await page.setViewportSize({ width: 1440, height: 880 });
    await header("Workloads").waitFor();
    expect(await expanded("Workloads")).toBe("false");
    await header("Workloads").click();

    // Storage that throws (full, or turned off): a fold still toggles and the sidebar stays, Problems included; it just
    // isn't remembered (security review of part 5, L10).
    await page.evaluate(() => {
      const p = Storage.prototype as unknown as { setItem: unknown; keep?: unknown };
      p.keep = p.setItem;
      p.setItem = () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
    });
    try {
      await header("Network").click();
      await expect.poll(() => expanded("Network")).toBe("false");
      await header("Network").click();
      await expect.poll(() => expanded("Network")).toBe("true");
      await sidebar.getByRole("button", { name: /^Problems/ }).waitFor({ timeout: 2_000 });
    } finally {
      await page.evaluate(() => {
        const p = Storage.prototype as unknown as { setItem: unknown; keep?: unknown };
        if (p.keep) p.setItem = p.keep;
      });
    }
    await page.keyboard.press("Meta+1");
  }, 120_000);

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

  it("lists an object's actions on Tab, and a Secret's are only Ask Claude and Delete (wave 8), Delete last", async () => {
    await open("landlens-demo-auth");
    const row = dialog().getByRole("option", { name: /^landlens-demo-auth\s*Secret/ });
    await row.waitFor({ timeout: 15_000 });
    await row.hover();
    await input().press("Tab");
    await expect.poll(options).toEqual([expect.stringMatching(/^Ask Claude about landlens-demo-auth/), expect.stringMatching(/^Delete landlens-demo-auth…/)]);
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
