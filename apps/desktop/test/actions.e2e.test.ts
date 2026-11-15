// Your actions (wave 8 part 1) in the built app against OrbStack: scale hands-web from its row's menu, restart it from
// the drawer's ⋯, run hands-report from ⌘K, a conflict when it changed between review and Apply, Enter on a fresh
// card sending nothing, ⌫ on a row opening a delete review, a Secret's delete review with no value, and Recent
// actions. Needs deploy/scenarios/hands (node deploy/scenarios/hands/up.mjs) in landlens-dev; puts hands-web back to 2
// replicas and deletes the Job it made. Screenshots go to $LANDLENS_SHOTS (w8p1-*, dark and light).
// LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/actions.e2e.test.ts
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
    await page.screenshot({ path: resolve(shots, `w8p1-${name}${both ? `-${colorScheme}` : ""}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
};
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
const replicas = () => kubectl("get", "deploy/hands-web", "-o", "jsonpath={.spec.replicas}");

describe.runIf(run)("your actions on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  const jobs: string[] = [];
  const sheet = () => page.getByRole("dialog").filter({ has: page.locator("#action-title") });
  const card = () => page.getByRole("region", { name: "Review your action" });
  const list = async (kind: string, name: string) => {
    // A sheet left open by an earlier failure would cover the sidebar.
    if (await sheet().count()) await page.keyboard.press("Escape");
    await page.getByRole("button", { name: kind, exact: true }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
    const row = page.locator(".tr", { hasText: name }).first();
    await row.waitFor({ timeout: 30_000 });
    return row;
  };

  beforeAll(async () => {
    kubectl("scale", "deploy/hands-web", "--replicas=2");
    kubectl("rollout", "status", "deploy/hands-web", "--timeout=120s");
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-")) },
    });
    // Main's own dialog is answered here, never by the window: Cancel, and each question kept.
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
    await app?.close();
    if (run) {
      kubectl("scale", "deploy/hands-web", "--replicas=2");
      for (const j of jobs) kubectl("delete", "job", j, "--ignore-not-found", "--wait=false");
      kubectl("annotate", "deploy/hands-web", "landlens.dev/e2e-");
      kubectl("rollout", "status", "deploy/hands-web", "--timeout=120s");
    }
  }, 200_000);

  it("scales hands-web from its row's menu: a form, the cluster's dry run, Apply as you, then back to 2", async () => {
    const row = await list("Deployments", "hands-web");
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: /Deployment hands-web/ });
    await menu.waitFor();
    expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Logs\nL", "Open shell\nS", "Edit YAML\nE", "Scale…", "Restart", "Ask Claude", "Copy name", "Delete…\n⌫"]);
    await shot(page, "01-menu", true);
    await menu.getByRole("menuitem", { name: "Scale…" }).click();
    const field = sheet().getByRole("spinbutton", { name: "Replicas" });
    await field.waitFor();
    expect(await field.inputValue()).toBe("2");
    // Arrows step by one; the field is focused.
    await page.keyboard.press("ArrowDown");
    expect(await field.inputValue()).toBe("1");
    await sheet().getByRole("button", { name: "Review" }).click();
    // Going under the budget: main's fact from the real PDB, beside the diff.
    await card().waitFor({ timeout: 20_000 });
    expect(await card().innerText()).toMatch(/Your action[\s\S]*Scale deployment landlens-dev\/hands-web to 1 replica[\s\S]*PodDisruptionBudget hands-web-pdb wants 2 available/);
    await shot(page, "02-review-facts", true);
    await card().getByRole("button", { name: /^Back/ }).click();
    await field.waitFor();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    expect(await field.inputValue()).toBe("3");
    await shot(page, "03-scale-form", true);
    await sheet().getByRole("button", { name: "Review" }).click();
    await card().waitFor({ timeout: 20_000 });
    const text = await card().innerText();
    expect(text).toMatch(/replicas: 2[\s\S]*replicas: 3[\s\S]*Dry run passed/);
    expect(replicas()).toBe("2");
    await page.waitForTimeout(600);
    await card().getByRole("button", { name: /^Apply/ }).click();
    await sheet().getByRole("list", { name: "What happened" }).waitFor({ timeout: 20_000 });
    expect(await sheet().innerText()).toContain("deployment landlens-dev/hands-web applied");
    await shot(page, "04-done", true);
    expect(replicas()).toBe("3");
    await sheet().getByRole("button", { name: "Done" }).click();

    // Back to 2 the same way.
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Scale…" }).click();
    await sheet().getByRole("spinbutton", { name: "Replicas" }).fill("2");
    await sheet().getByRole("button", { name: "Review" }).click();
    await card().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await card().getByRole("button", { name: /^Apply/ }).click();
    await sheet().getByRole("button", { name: "Done" }).click();
    expect(replicas()).toBe("2");
  }, 120_000);

  it("Enter on a fresh card sends nothing; a change between review and Apply is a conflict, and Review again reads it anew", async () => {
    const row = await list("Deployments", "hands-web");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Scale…" }).click();
    // The row may still hold the count before the last scale (the watch's next event): type the number.
    await sheet().getByRole("spinbutton", { name: "Replicas" }).fill("3");
    await sheet().getByRole("button", { name: "Review" }).click();
    await card().waitFor({ timeout: 20_000 });
    await page.keyboard.press("Enter"); // the Apply button has focus, but the card is less than half a second old
    await page.waitForTimeout(1200);
    expect(replicas()).toBe("2");
    expect(await card().isVisible()).toBe(true);
    kubectl("annotate", "deploy/hands-web", "landlens.dev/e2e=changed", "--overwrite");
    await card().getByRole("button", { name: /^Apply/ }).click();
    await sheet().getByRole("list", { name: "What happened" }).waitFor({ timeout: 20_000 });
    expect(await sheet().innerText()).toContain("changed after your review: not sent");
    expect(replicas()).toBe("2");
    await shot(page, "05-conflict", true);
    await sheet().getByRole("button", { name: "Review again" }).click();
    await card().waitFor({ timeout: 20_000 });
    await card().getByRole("button", { name: /^Back/ }).click();
    await sheet().getByRole("button", { name: "Cancel" }).click();
    expect(replicas()).toBe("2");
  }, 90_000);

  it("restarts hands-web from the drawer's ⋯", async () => {
    const row = await list("Deployments", "hands-web");
    await row.click();
    const before = kubectl("get", "deploy/hands-web", "-o", "jsonpath={.metadata.generation}");
    await page.locator(".drawer").getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu", { name: /Deployment hands-web/ });
    // The drawer's own tabs aren't repeated in its menu.
    expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Scale…", "Restart", "Ask Claude", "Copy name", "Delete…\n⌫"]);
    await shot(page, "06-drawer-menu");
    await menu.getByRole("menuitem", { name: "Restart" }).click();
    await card().waitFor({ timeout: 20_000 });
    expect(await card().innerText()).toContain("kubectl.kubernetes.io/restartedAt");
    await page.waitForTimeout(600);
    await card().getByRole("button", { name: /^Apply/ }).click();
    await sheet().getByRole("button", { name: "Done" }).click();
    expect(Number(kubectl("get", "deploy/hands-web", "-o", "jsonpath={.metadata.generation}"))).toBeGreaterThan(Number(before));
    expect(kubectl("get", "deploy/hands-web", "-o", "jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}")).toMatch(/^\d{4}-/);
    await page.locator(".drawer").getByRole("button", { name: "Close details" }).click();
  }, 90_000);

  it("runs hands-report from ⌘K: a Job owned by the CronJob, then removed", async () => {
    await page.keyboard.press("Meta+K");
    const input = page.getByRole("dialog", { name: "Search" }).getByRole("combobox", { name: "Search" });
    await input.fill("trigger hands-report");
    await page.getByRole("option", { name: /Run hands-report now/ }).waitFor({ timeout: 20_000 });
    await shot(page, "07-palette", true);
    await page.keyboard.press("Enter");
    await card().waitFor({ timeout: 20_000 });
    const text = await card().innerText();
    expect(text).toMatch(/Run cronjob landlens-dev\/hands-report now[\s\S]*Runs now, once, outside the schedule/);
    const name = /hands-report-manual-[a-z0-9]{5}/.exec(text)![0];
    jobs.push(name);
    await shot(page, "08-trigger-review", true);
    // A Job's whole spec is over 40 lines: the card shows it all before Apply can send it.
    await card().getByRole("button", { name: "Show the whole change" }).click();
    await card().getByRole("button", { name: /^Apply/ }).click();
    await sheet().getByRole("button", { name: "Done" }).click();
    const job = JSON.parse(kubectl("get", "job", name, "-o", "json"));
    expect(job.metadata.ownerReferences).toEqual([expect.objectContaining({ kind: "CronJob", name: "hands-report", controller: true })]);
    expect(job.metadata.annotations["cronjob.kubernetes.io/instantiate"]).toBe("manual");
    kubectl("delete", "job", name, "--wait=false");
  }, 90_000);

  it("⌫ on a row opens a delete review, and Cancel deletes nothing", async () => {
    const row = await list("ConfigMaps", "hands-cm-6");
    await row.click();
    await row.focus();
    await page.keyboard.press("Backspace");
    await card().waitFor({ timeout: 20_000 });
    expect(await card().innerText()).toMatch(/Delete configmap landlens-dev\/hands-cm-6/);
    await shot(page, "09-delete-review", true);
    await page.keyboard.press("Escape");
    await card().waitFor({ state: "detached" });
    expect(kubectl("get", "configmap", "hands-cm-6", "-o", "name").trim()).toBe("configmap/hands-cm-6");
  }, 60_000);

  it("a Secret has Delete only, and its review shows sizes, never a value", async () => {
    const secret = JSON.parse(kubectl("get", "secret", "hands-secret", "-o", "json"));
    const password = Buffer.from(secret.data.password, "base64").toString();
    const row = await list("Secrets", "hands-secret");
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: /Secret hands-secret/ });
    expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Logs\nL", "Open shell\nS", "Edit YAML\nSecrets stay locked", "Copy name", "Delete…\n⌫"]);
    await menu.getByRole("menuitem", { name: "Delete…" }).click();
    await card().waitFor({ timeout: 20_000 });
    const text = await card().innerText();
    expect(text).toMatch(/password: <40 bytes>/);
    expect(text).not.toContain(password);
    expect(await page.content()).not.toContain(password);
    expect(await card().getByRole("button", { name: "Ask Claude first" }).count()).toBe(0);
    await shot(page, "10-secret-delete", true);
    await card().getByRole("button", { name: /^Cancel/ }).click();
    expect(kubectl("get", "secret", "hands-secret", "-o", "jsonpath={.metadata.uid}")).toBe(secret.metadata.uid);
  }, 60_000);

  it("Recent actions lists what you did, newest first, from ⌘K and the status bar", async () => {
    await page.getByRole("button", { name: /^Recent actions/ }).click();
    const pop = page.getByRole("dialog", { name: "Recent actions" });
    await pop.waitFor();
    const rows = await pop.locator(".recent-row").allInnerTexts();
    // Each row: its sentence, its age, its outcome word.
    expect(rows.map((r) => [r.split("\n")[0], r.split("\n").at(-1)])).toEqual([
      ["Ran CronJob landlens-dev/hands-report", "Done"],
      ["Restarted Deployment landlens-dev/hands-web", "Done"],
      ["Scaled Deployment landlens-dev/hands-web · 2 → 3 replicas", "Changed first"],
      ["Scaled Deployment landlens-dev/hands-web · 3 → 2 replicas", "Done"],
      ["Scaled Deployment landlens-dev/hands-web · 2 → 3 replicas", "Done"],
    ]);
    await shot(page, "11-recent-actions", true);
    await page.keyboard.press("Escape");
    await pop.waitFor({ state: "detached" });
  }, 30_000);
});
