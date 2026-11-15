// The YAML editor (wave 4, part 2) in the built app against OrbStack: edit shop-web's replicas through a dry-run
// review and apply it as you; a refused edit marks its line; create a ConfigMap from a template and open it. Needs
// deploy/scenarios/workbench.yaml in landlens-dev. Puts shop-web back to 2 replicas and deletes the ConfigMap after.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
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
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
const CM = "landlens-e2e-cm";

/** Put the cursor at the end of the editor line matching `line`, and replace its last `drop` characters. */
async function retype(page: Page, scope: string, line: RegExp, drop: number, text: string) {
  const l = page.locator(`${scope} .cm-line`, { hasText: line }).first();
  await l.click();
  await page.keyboard.press("End");
  for (let i = 0; i < drop; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

describe.runIf(run)("the YAML editor on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    kubectl("apply", "-f", resolve(__dirname, "../../../deploy/scenarios/workbench.yaml"));
    kubectl("scale", "deploy/shop-web", "--replicas=2");
    kubectl("delete", "configmap", CM, "--ignore-not-found");
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
    if (run) {
      kubectl("scale", "deploy/shop-web", "--replicas=2");
      kubectl("delete", "configmap", CM, "--ignore-not-found");
    }
  });

  it("edits a deployment's replicas through a dry-run review, as you", async () => {
    await page.getByRole("button", { name: "Deployments", exact: true }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
    const row = page.locator(".tr", { hasText: "shop-web" }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.locator(".drawer").getByRole("tab", { name: "YAML" }).click();
    await page.locator(".drawer").getByRole("button", { name: "Edit", exact: true }).click();
    const ed = ".drawer .yaml-edit";
    await page.locator(`${ed} .cm-content`).waitFor();
    // Status and bookkeeping aren't in the editor.
    const all = await page.locator(`${ed} .cm-content`).innerText();
    expect(all).not.toMatch(/managedFields|^status:/m);

    await retype(page, ed, /^\s*replicas: 2$/, 1, "3");
    await expect.poll(() => page.locator(`${ed} .edit-foot`).innerText()).toContain("1 line changed");
    expect(await page.locator(`${ed} .cm-l-chg`).count()).toBe(1);
    await shot(page, "w4-10-edit");

    await page.keyboard.press("Meta+Enter");
    const card = page.getByRole("region", { name: "Review your edit" });
    await card.waitFor({ timeout: 15_000 });
    expect(await card.innerText()).toMatch(/Your edit[\s\S]*replicas: 3[\s\S]*Dry run passed/);
    // A dry run changes nothing.
    expect(kubectl("get", "deploy/shop-web", "-o", "jsonpath={.spec.replicas}")).toBe("2");
    await shot(page, "w4-11-edit-review");

    await card.getByRole("button", { name: /^Apply/ }).click();
    await expect.poll(() => page.locator(".drawer .yaml-tab .change-done").innerText().catch(() => ""), { timeout: 15_000 }).toContain("Applied · deployment landlens-dev/shop-web");
    expect(kubectl("get", "deploy/shop-web", "-o", "jsonpath={.spec.replicas}")).toBe("3");
    // Only the changed field is Landlens's.
    const managers = JSON.parse(kubectl("get", "deploy/shop-web", "-o", "json", "--show-managed-fields")).metadata.managedFields as { manager: string; fieldsV1: any }[];
    const mine = managers.find((m) => m.manager === "landlens");
    expect(mine && Object.keys(mine.fieldsV1["f:spec"] ?? {})).toEqual(["f:replicas"]);
    await shot(page, "w4-12-edit-applied");
  }, 90_000);

  it("marks the line the cluster refused, and asks before discarding", async () => {
    await page.locator(".drawer").getByRole("button", { name: "Edit", exact: true }).click();
    const ed = ".drawer .yaml-edit";
    await page.locator(`${ed} .cm-content`).waitFor();
    await retype(page, ed, /^\s*replicas: 3$/, 1, "-1");
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => page.locator(`${ed} .cm-l-bad`).count(), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.locator(`${ed} .cm-msg.bad`).first().innerText()).toMatch(/greater than or equal to 0|must be/i);
    expect(await page.locator(`${ed} .edit-foot`).innerText()).toMatch(/The cluster refused this: 1 problem, on line \d+\. Nothing has changed\./);
    expect(kubectl("get", "deploy/shop-web", "-o", "jsonpath={.spec.replicas}")).toBe("3");
    await shot(page, "w4-13-edit-refused");

    // Leaving with changes asks in the foot: Esc asks, Esc again keeps editing, and the drawer stays.
    await page.locator(`${ed} .cm-content`).focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(`${ed} .edit-foot`).innerText()).toContain("Discard 1 changed line?");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(`${ed} .edit-foot`).innerText()).not.toContain("Discard 1 changed line?");
    await page.locator(`${ed} .edit-foot`).getByRole("button", { name: "Discard" }).click();
    await expect(page.locator(`${ed} .edit-foot`).innerText()).resolves.toContain("Discard 1 changed line?");
    await page.locator(`${ed} .edit-foot`).getByRole("button", { name: "Discard" }).click();
    await page.locator(ed).waitFor({ state: "detached" });
  }, 60_000);

  it("creates a ConfigMap from a template and opens it", async () => {
    await page.getByRole("button", { name: "Create from YAML" }).click();
    const sheet = page.getByRole("dialog", { name: "Create from YAML" });
    await sheet.getByRole("combobox", { name: "Template" }).selectOption("ConfigMap");
    const s = ".create-sheet";
    await expect.poll(() => page.locator(`${s} .cm-content`).innerText()).toContain("namespace: landlens-dev");
    await retype(page, s, /^\s*name: my-config$/, "my-config".length, CM);
    await shot(page, "w4-14-create");
    await page.keyboard.press("Meta+Enter");
    const card = page.getByRole("region", { name: "Review your edit" });
    await card.waitFor({ timeout: 15_000 });
    expect(await card.innerText()).toContain(`Create configmap ${CM}`);
    expect(kubectl("get", "configmap", "--ignore-not-found", CM)).toBe("");
    await shot(page, "w4-15-create-review");
    await card.getByRole("button", { name: /^Apply/ }).click();
    await sheet.waitFor({ state: "detached", timeout: 15_000 });
    await expect.poll(() => page.locator(".drawer").innerText().catch(() => ""), { timeout: 20_000 }).toContain(CM);
    expect(kubectl("get", "configmap", CM, "-o", "jsonpath={.data.key}")).toBe("value");

    // Creating it again says it exists.
    await page.getByRole("button", { name: "Create from YAML" }).click();
    await sheet.getByRole("combobox", { name: "Template" }).selectOption("ConfigMap");
    await retype(page, s, /^\s*name: my-config$/, "my-config".length, CM);
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => page.locator(`${s} .cm-msg.bad`).first().innerText().catch(() => ""), { timeout: 15_000 }).toContain("already exists");
    expect(await page.locator(`${s} .edit-foot`).innerText()).toMatch(/Not created: 1 problem, on line 4/);
    await shot(page, "w4-16-create-exists");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Discard" }).click();
    await sheet.waitFor({ state: "detached" });
  }, 90_000);
});
