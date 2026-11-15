// The workbench (wave 4, part 1) in the built app against OrbStack: followed logs in the drawer and the panel, a
// workload's pods merged, a pod shell that runs as you, a container with no shell, and a local terminal whose kubectl
// goes through Landlens. Needs deploy/scenarios/workbench.yaml in landlens-dev.
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

/** The text on a terminal's screen (xterm's DOM rows). */
const screen = (page: Page) => page.locator(".bench-pane:not([hidden]) .xterm-rows").innerText().catch(() => "");
async function typeIn(page: Page, text: string) {
  await page.locator(".bench-pane:not([hidden]) .xterm-helper-textarea").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

describe.runIf(run)("the workbench on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    kubectl("apply", "-f", resolve(__dirname, "../../../deploy/scenarios/workbench.yaml"));
    kubectl("rollout", "status", "deploy/shop-web", "--timeout=120s");
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

  it("follows a pod's log in the drawer", async () => {
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
    const row = page.locator(".tr", { hasText: "shop-web" }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.locator(".drawer").getByRole("tab", { name: "Logs" }).click();
    const log = page.locator(".drawer").getByRole("log", { name: "Logs" });
    await expect.poll(() => log.innerText(), { timeout: 20_000 }).toMatch(/GET \/products\/\d+ 200/);
    const before = (await log.locator(".ll:not(.mk)").count());
    await expect.poll(() => log.locator(".ll:not(.mk)").count(), { timeout: 10_000 }).toBeGreaterThan(before);
    await expect(page.locator(".drawer .logs-foot").innerText()).resolves.toContain("Following");
    // Loud lines are marked; colour codes are drawn, not printed.
    await expect.poll(() => log.locator(".ll.err").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await log.innerText()).not.toContain("\x1b[");
    await shot(page, "w4-01-drawer-logs");

    // Search pauses following and counts matches.
    await log.focus();
    await page.keyboard.press("Meta+f");
    await page.getByRole("textbox", { name: "Find in logs" }).fill("ERROR");
    await expect.poll(() => page.locator(".drawer .find-count").innerText()).toMatch(/1 of \d+/);
    await expect(page.locator(".drawer .logs-foot").innerText()).resolves.toContain("Paused");
    await shot(page, "w4-02-logs-search");
    await page.keyboard.press("Escape");
  }, 90_000);

  it("opens a shell in a container that runs as you, and says when it ends", async () => {
    await page.locator(".drawer").getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("button", { name: "Open shell in app" }).click();
    const panel = page.getByRole("region", { name: "Panel" });
    await panel.waitFor();
    await expect(panel.locator(".term-id").innerText()).resolves.toMatch(/Runs as you/);
    await expect(panel.locator(".term-id").innerText()).resolves.toMatch(/Claude Code can't see or type here/);
    await expect.poll(() => screen(page), { timeout: 20_000 }).toMatch(/[#$] ?$/m);
    await typeIn(page, "echo hello-$((6*7)); stty size");
    await expect.poll(() => screen(page), { timeout: 10_000 }).toContain("hello-42");
    await shot(page, "w4-03-pod-shell");

    await typeIn(page, "exit 3");
    await expect.poll(() => panel.locator(".term-bar").innerText(), { timeout: 10_000 }).toMatch(/exited \(code 3\)/);
    await expect(panel.getByRole("tab").first().getAttribute("aria-label")).resolves.toMatch(/Shell: app in landlens-dev\/shop-web/);
    await shot(page, "w4-04-shell-ended");
    await panel.getByRole("button", { name: /Reconnect/ }).click();
    await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("new session");
    // Typing goes to the new session once it is open: the ended bar goes, and the shell prints its prompt.
    await expect.poll(() => panel.locator(".term-bar").count(), { timeout: 20_000 }).toBe(0);
    await expect.poll(async () => (await screen(page)).split("new session")[1] ?? "", { timeout: 20_000 }).toMatch(/[#$] ?$/m);
    await typeIn(page, "echo again-$((40+2))");
    await expect.poll(() => screen(page), { timeout: 10_000 }).toContain("again-42");
  }, 90_000);

  it("says when a container has no shell", async () => {
    await page.getByRole("button", { name: "Open shell in sidecar" }).click();
    const panel = page.getByRole("region", { name: "Panel" });
    await panel.getByText("No shell in this container").waitFor({ timeout: 20_000 });
    await shot(page, "w4-05-no-shell");
  }, 60_000);

  it("merges a deployment's pods in its logs, and opens them in the panel", async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Deployments" }).click();
    const row = page.locator(".tr", { hasText: "shop-web" }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.locator(".drawer").getByRole("tab", { name: "Logs" }).click();
    await expect.poll(() => page.locator(".drawer .legend-pods span").count(), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => page.locator(".drawer .ll .pod").count(), { timeout: 20_000 }).toBeGreaterThan(2);
    await shot(page, "w4-06-deployment-logs");
    await page.locator(".drawer").getByRole("button", { name: "Open in the panel" }).click();
    await expect(page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab", { name: /Logs: Deployment landlens-dev\/shop-web/ }).isVisible()).resolves.toBe(true);
    await expect.poll(() => page.locator(".bench-pane:not([hidden]) .ll").count(), { timeout: 20_000 }).toBeGreaterThan(2);
    await shot(page, "w4-07-panel-logs");
  }, 90_000);

  it("opens a local terminal whose kubectl goes through Landlens", async () => {
    await page.keyboard.press("Control+Shift+Backquote");
    const panel = page.getByRole("region", { name: "Panel" });
    await expect.poll(async () => (await panel.locator(".bench-pane:not([hidden]) .term-id").textContent())?.replace(/\s+/g, " "), { timeout: 10_000 }).toMatch(/on this Mac ?· ?kubectl points at orbstack through Landlens/);
    await expect.poll(() => screen(page), { timeout: 20_000 }).not.toBe("");
    await page.waitForTimeout(1500); // the login shell's startup files
    await typeIn(page, "kubectl get deploy shop-web -n landlens-dev -o name; echo \"kc=$KUBECONFIG\"");
    await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("deployment.apps/shop-web");
    expect(await screen(page)).toMatch(/kc=.*terminals/);
    await shot(page, "w4-08-local-terminal");
    await shot(page, "w4-09-local-terminal-light", "light");
  }, 60_000);

  it("hides and shows the panel without ending sessions, at 1024×700 too", async () => {
    const panel = page.getByRole("region", { name: "Panel" });
    const tabs = await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab").count();
    await page.locator(".bench-pane:not([hidden]) .xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+Backquote");
    await expect(panel.isHidden()).resolves.toBe(true);
    await expect(page.locator(".statusbar").innerText()).resolves.toMatch(/\d+ sessions?/);
    await page.locator(".statusbar .sessions").click();
    await expect(panel.isVisible()).resolves.toBe(true);
    expect(await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab").count()).toBe(tabs);

    await page.setViewportSize({ width: 1024, height: 700 });
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    await page.locator(".tr", { hasText: "shop-web" }).first().click();
    await shot(page, "w4-10-1024");
    await page.setViewportSize({ width: 1440, height: 880 });
  }, 60_000);
});
