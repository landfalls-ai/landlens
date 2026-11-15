// Custom resources (wave 4, part 4; D38–D41) in the built app against OrbStack, read-only: k3s's own CRDs
// (addons.k3s.cattle.io, with Source and Checksum printer columns, and etcdsnapshotfiles.k3s.cattle.io). Writes
// nothing to the cluster: CRDs are cluster-wide, and Landlens's tests write only in landlens-dev.
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

describe.runIf(run)("custom resources on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  const sidebar = () => page.getByRole("complementary", { name: "Resources" });
  const headers = () => page.locator(".thead [role=columnheader]").allInnerTexts();

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

  it("groups custom kinds under one closed section, by API group, with Definitions first", async () => {
    const section = sidebar().getByRole("button", { name: /^Custom resources/ });
    await section.waitFor({ timeout: 30_000 });
    expect(await section.getAttribute("aria-expanded")).toBe("false");
    expect(await sidebar().getByRole("button", { name: "Addon", exact: true }).count()).toBe(0);
    await section.click();
    const group = sidebar().getByRole("group", { name: "k3s.cattle.io" });
    await group.waitFor();
    expect(await group.getByRole("button", { name: /k3s\.cattle\.io/ }).innerText()).toMatch(/k3s\.cattle\.io\s*2/);
    expect(await group.getByRole("button", { name: "Addon", exact: true }).count()).toBe(1);
    expect(await group.getByRole("button", { name: "ETCDSnapshotFile", exact: true }).count()).toBe(1);
    expect(await sidebar().getByRole("button", { name: "Definitions", exact: true }).count()).toBe(1);
    // The definitions list is no longer under Cluster.
    expect(await sidebar().getByRole("group", { name: "Cluster" }).getByRole("button", { name: /definitions/i }).count()).toBe(0);
    await shot(page, "w4-30-custom-section");
  }, 60_000);

  it("lists a custom kind with its printer columns, and shows them in its drawer", async () => {
    await sidebar().getByRole("button", { name: "Addon", exact: true }).click();
    await expect.poll(headers, { timeout: 15_000 }).toEqual(["Name", "Namespace", "Source", "Checksum", "Age"]);
    const row = page.locator(".tr", { hasText: "coredns" }).first();
    await row.waitFor({ timeout: 15_000 });
    expect(await row.innerText()).toMatch(/kube-system[\s\S]*\/var\/lib\/rancher\/k3s\/server\/manifests\/orb-coredns\.yaml/);
    await shot(page, "w4-31-custom-list");
    await row.click();
    const facts = page.locator(".drawer .facts").first();
    await expect.poll(() => facts.innerText()).toMatch(/Source\s*\/var\/lib\/rancher[\s\S]*Checksum\s*[0-9a-f]{16}/);
    await shot(page, "w4-32-custom-drawer");
    await page.keyboard.press("Escape");
  }, 60_000);

  it("pins a kind under Agent, and unpins it", async () => {
    const addon = sidebar().getByRole("group", { name: "k3s.cattle.io" }).locator(".nav-row", { has: page.getByRole("button", { name: "Addon", exact: true }) });
    await addon.hover();
    await addon.getByRole("button", { name: "Pin Addon" }).click();
    const pinned = sidebar().getByRole("group", { name: "Pinned" });
    await pinned.getByRole("button", { name: "Addon", exact: true }).waitFor();
    await shot(page, "w4-33-pinned");
    await pinned.getByRole("button", { name: "Addon", exact: true }).click();
    await expect.poll(headers).toContain("Source");
    await pinned.locator(".nav-row").first().hover();
    await pinned.getByRole("button", { name: "Unpin Addon" }).click();
    await expect.poll(() => sidebar().getByRole("group", { name: "Pinned" }).count()).toBe(0);
  }, 60_000);

  it("shows a definition's versions and columns, and opens its kind", async () => {
    await sidebar().getByRole("button", { name: "Definitions", exact: true }).click();
    await expect.poll(headers, { timeout: 15_000 }).toEqual(["Name", "Group", "Kind", "Scope", "Age"]);
    const row = page.locator(".tr", { hasText: "addons.k3s.cattle.io" }).first();
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    const drawer = page.locator(".drawer");
    await expect.poll(() => drawer.innerText()).toMatch(/Versions[\s\S]*v1\s*served\s*storage/);
    expect(await drawer.innerText()).toMatch(/Columns[\s\S]*Source[\s\S]*\.spec\.source[\s\S]*Checksum/);
    await shot(page, "w4-34-definition");
    await drawer.getByRole("button", { name: /^Open addons/ }).click();
    await expect.poll(headers, { timeout: 15_000 }).toEqual(["Name", "Namespace", "Source", "Checksum", "Age"]);
  }, 60_000);

  it("is one icon with a flyout in the rail", async () => {
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    const icon = sidebar().getByRole("button", { name: "Custom resources", exact: true });
    await icon.waitFor();
    await icon.click();
    const menu = page.getByRole("menu", { name: "Custom resources" });
    await menu.waitFor();
    expect(await menu.innerText()).toMatch(/Definitions[\s\S]*k3s\.cattle\.io[\s\S]*Addon[\s\S]*ETCDSnapshotFile/);
    await shot(page, "w4-35-rail-flyout");
    await menu.getByRole("menuitem", { name: "ETCDSnapshotFile" }).click();
    await menu.waitFor({ state: "detached" });
    await expect.poll(headers, { timeout: 15_000 }).toContain("SnapshotName");
    // On macOS the rail hides its toggle (the traffic lights sit there): ⌘B expands it.
    await page.keyboard.press("Meta+B");
    await sidebar().getByRole("button", { name: "Addon", exact: true }).waitFor();
  }, 60_000);
});
