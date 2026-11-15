// Nodes (wave 8 part 2) in the built app against OrbStack: the drain's preview and cordon's sheet, reads only.
// OrbStack has one node, shared with other projects: this test never cordons or drains it, and the app it starts has
// LANDLENS_NODE_WRITES taken out of its environment, so main's fence (D153) refuses every node write and dry-run
// eviction before it leaves Landlens. The preview is checked on the hands scenario's pods in landlens-dev (node
// deploy/scenarios/hands/up.mjs): hands-web blocked by hands-web-pdb, hands-bare bare, hands-cache under emptyDir,
// hands-agent under Stay. Afterwards the node is as it was and every landlens-dev pod has the uid it had.
// Screenshots go to $LANDLENS_SHOTS (w8p2-*, dark and light).
// LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/nodes.e2e.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const shot = async (page: Page, name: string, both = false) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const colorScheme of both ? (["dark", "light"] as const) : (["dark"] as const)) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(shots, `w8p2-${name}${both ? `-${colorScheme}` : ""}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
};
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", ...args], { encoding: "utf8" });
const unschedulable = () => kubectl("get", "node", "orbstack", "-o", "jsonpath={.spec.unschedulable}");
const uids = () => Object.fromEntries((JSON.parse(kubectl("-n", "landlens-dev", "get", "pods", "-o", "json")).items as any[]).map((p) => [p.metadata.name, p.metadata.uid]));
const PREVIEW = "Development build: preview only. Nothing is sent to nodes on this cluster.";

describe.runIf(run)("nodes on OrbStack: the preview only", () => {
  let app: ElectronApplication;
  let page: Page;
  let before: { unschedulable: string; uids: Record<string, string> };
  const sheet = () => page.getByRole("dialog").filter({ has: page.locator("#action-title") });
  const nodeRow = async () => {
    if (await sheet().count()) await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Nodes", exact: true }).click();
    const row = page.locator(".tr", { hasText: "orbstack" }).first();
    await row.waitFor({ timeout: 30_000 });
    return row;
  };

  beforeAll(async () => {
    before = { unschedulable: unschedulable(), uids: uids() };
    expect(before.unschedulable).toBe("");
    // D153: LANDLENS_NODE_WRITES is never inherited.
    const env = Object.fromEntries(Object.entries({ ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-")) })
      .filter((e): e is [string, string] => e[0] !== "LANDLENS_NODE_WRITES" && typeof e[1] === "string"));
    app = await electron.launch({ executablePath: require("electron") as unknown as string, args: [resolve(__dirname, "..")], env });
    // Main's own dialog is answered here, never by the window: Cancel, and each question kept. None is expected.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { asked: string[] };
      g.asked = [];
      (dialog as unknown as { showMessageBox: (...a: unknown[]) => Promise<unknown> }).showMessageBox = async (...a: unknown[]) => {
        g.asked.push((a.at(-1) as { message: string }).message);
        return { response: 1, checkboxChecked: false };
      };
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  }, 180_000);

  afterAll(async () => {
    const asked = await app?.evaluate(() => (globalThis as unknown as { asked: string[] }).asked).catch(() => undefined);
    await app?.close();
    if (!run) return;
    // This is the whole of what touched the real node: reads.
    expect(asked).toEqual([]);
    expect(unschedulable()).toBe(before.unschedulable);
    const now = uids();
    for (const [name, uid] of Object.entries(before.uids)) expect([name, now[name]]).toEqual([name, uid]);
  }, 60_000);

  it("the node's menu offers Cordon and Drain…", async () => {
    const row = await nodeRow();
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: /Node orbstack/ });
    await menu.waitFor();
    const items = await menu.getByRole("menuitem").allInnerTexts();
    expect(items).toEqual(expect.arrayContaining(["Cordon", "Drain…"]));
    expect(items.indexOf("Cordon")).toBeLessThan(items.indexOf("Drain…"));
    await shot(page, "01-node-menu", true);
    await page.keyboard.press("Escape");
  }, 60_000);

  it("Drain… shows the plan from reads: the scenario's pods where they belong, preview only, Apply off", async () => {
    const row = await nodeRow();
    await row.click({ button: "right" });
    await page.getByRole("menu", { name: /Node orbstack/ }).getByRole("menuitem", { name: "Drain…" }).click();
    await sheet().getByRole("region", { name: "Blocked" }).waitFor({ timeout: 30_000 });
    expect(await sheet().getByRole("note").first().innerText()).toContain(PREVIEW);
    const drain = sheet().getByRole("button", { name: /Drain…/ });
    expect(await drain.isDisabled()).toBe(true);
    const blocked = sheet().getByRole("region", { name: "Blocked" });
    const rowOf = (group: ReturnType<typeof sheet>, prefix: string) => group.locator(`li[data-pod^="landlens-dev/${prefix}"]`);
    // hands-web's two pods, held by the budget that allows none.
    expect(await rowOf(blocked, "hands-web-").count()).toBe(2);
    expect(await rowOf(blocked, "hands-web-").first().innerText()).toMatch(/budget hands-web-pdb · 0 allowed[\s\S]*Wait for hands-web-pdb to allow a disruption, or scale its Deployment up/);
    expect(await rowOf(blocked, "hands-bare").innerText()).toMatch(/bare[\s\S]*Tick “Delete pods that nothing will recreate”/);
    expect(await rowOf(blocked, "hands-cache-").innerText()).toMatch(/emptyDir cache[\s\S]*Tick “Lose emptyDir data”/);
    await shot(page, "02-drain-preview", true);
    // The DaemonSet's pod stays (folded until opened).
    const stay = sheet().getByRole("region", { name: "Stay" });
    await stay.getByRole("button", { name: /Stay/ }).click();
    expect(await rowOf(stay, "hands-agent-").innerText()).toContain("DaemonSet");
    // The two ticks re-review: the bare and emptyDir pods move to Will be evicted; Apply is still off.
    await sheet().getByRole("checkbox", { name: "Delete pods that nothing will recreate" }).check();
    await sheet().getByRole("checkbox", { name: "Lose emptyDir data" }).check();
    const evict = sheet().getByRole("region", { name: "Will be evicted" });
    await rowOf(evict, "hands-bare").waitFor({ timeout: 30_000 });
    await rowOf(evict, "hands-cache-").waitFor({ timeout: 30_000 });
    expect(await rowOf(blocked, "hands-web-").count()).toBe(2);
    expect(await drain.isDisabled()).toBe(true);
    await shot(page, "03-drain-ticked", true);
    await page.keyboard.press("Escape");
    await sheet().waitFor({ state: "detached" });
  }, 120_000);

  it("Cordon from the drawer's ⋯: Landlens's own reading of the patch, preview only, Apply off", async () => {
    const row = await nodeRow();
    await row.click();
    await page.locator(".drawer").getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menu", { name: /Node orbstack/ }).getByRole("menuitem", { name: "Cordon" }).click();
    const card = page.getByRole("region", { name: "Review your action" });
    await card.waitFor({ timeout: 30_000 });
    const text = await card.innerText();
    expect(text).toMatch(/Cordon node orbstack[\s\S]*unschedulable: true/);
    expect(text).toContain(PREVIEW);
    expect(text).not.toContain("Dry run passed");
    expect(await card.getByRole("button", { name: /^Apply|Cluster-wide/ }).first().isDisabled()).toBe(true);
    await shot(page, "04-cordon-preview", true);
    await card.getByRole("button", { name: /^Cancel/ }).click();
    await page.locator(".drawer").getByRole("button", { name: "Close details" }).click();
  }, 90_000);

  it("⌘K offers cordon, uncordon and drain on the node", async () => {
    await page.keyboard.press("Meta+K");
    const input = page.getByRole("dialog", { name: "Search" }).getByRole("combobox", { name: "Search" });
    await input.fill("drain orbstack");
    await page.getByRole("option", { name: /Drain orbstack…/ }).waitFor({ timeout: 20_000 });
    await shot(page, "05-palette");
    await page.keyboard.press("Enter");
    await sheet().getByRole("region", { name: "Blocked" }).waitFor({ timeout: 30_000 });
    expect(await sheet().getByRole("button", { name: /Drain…/ }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
  }, 60_000);
});
