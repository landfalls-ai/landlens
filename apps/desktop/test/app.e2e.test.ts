// Launches the built app against the OrbStack cluster and walks the wave-1 path:
// pick a cluster → pods appear live → filter → open a pod → its YAML; plus the renderer's security posture.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
/** Runs your own Claude Code (your login and usage) against deploy/scenarios/crashloop.yaml in landlens-dev. */
const claude = flags.includes("claude");
const shots = process.env.LANDLENS_SHOTS;
/** Dark is Landlens's default, so screenshots are dark unless asked, whatever this machine's appearance. */
const shot = async (page: Page, name: string, colorScheme: "dark" | "light" = "dark") => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400); // the drawer and dock slide in over 240ms
  await page.evaluate(() => new Promise((r) => (globalThis as any).requestAnimationFrame(() => (globalThis as any).requestAnimationFrame(r))));
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

  it("carries the CSP in the built page: no inline scripts, no eval", async () => {
    const csp = await page.evaluate(() => (globalThis as any).document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    // page.evaluate runs through DevTools, which CSP exempts, so test what injected markup would do: an inline
    // script and a string timer (an eval) must both be blocked, and the page must see the violations.
    const probe = await page.evaluate(async () => {
      const g = globalThis as any;
      const violations: string[] = [];
      g.document.addEventListener("securitypolicyviolation", (e: any) => violations.push(e.effectiveDirective));
      const s = g.document.createElement("script");
      s.textContent = "globalThis.__inline = 1";
      g.document.head.appendChild(s);
      g.setTimeout("globalThis.__timer = 1", 0);
      await new Promise((r) => g.setTimeout(r, 100));
      return { inline: g.__inline ?? null, timer: g.__timer ?? null, violations: [...new Set(violations)].sort() };
    });
    expect(probe).toEqual({ inline: null, timer: null, violations: ["script-src-elem", "script-src"].sort() });
  });

  it("refuses requests whose names could change the API path", async () => {
    const tries = [
      { group: "", version: "v1", resource: "secrets?x=", name: "a" },
      { group: "", version: "v1", resource: "pods", namespace: "kube-system", name: "../secrets" },
      { group: "", version: "v1", resource: "pods", namespace: "kube-system", name: "a/b" },
      { group: "", version: "v1", resource: "pods", namespace: "kube%2fsystem", name: "a" },
    ];
    for (const ref of tries) {
      const err = await page.evaluate((ref) => (globalThis as any).landlens.invoke("resource:get", { handle: "aaaaaaaaaaaaaaaa", ref }).then(() => "", (e: Error) => e.message), ref);
      expect(err).toContain("bad request");
    }
  });

  it("connects and lands on the Overview, then lists live pods, filters, and opens one", async () => {
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("region", { name: "Verdict" }).waitFor({ timeout: 30_000 });
    await shot(page, "02-overview");

    await page.getByRole("button", { name: "Pods", exact: true }).click();
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

  it("shows a failing pod's diagnosis, in dark and light, at 1440×880 and 1024×700", async () => {
    const failing = async () => {
      await page.getByRole("button", { name: "Pods", exact: true }).click();
      await page.getByRole("combobox", { name: "Namespace" }).selectOption("");
      const row = page.locator(".tr", { hasText: "orders-api" }).first();
      await row.waitFor({ timeout: 30_000 });
      await row.click();
      await page.getByRole("region", { name: "Diagnosis" }).waitFor();
      await expect(page.locator(".tr.row-bad").count()).resolves.toBeGreaterThan(0);
    };
    const overview = async () => {
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.getByRole("region", { name: "Verdict" }).waitFor({ timeout: 30_000 });
    };
    try {
      await failing();
      await shot(page, "12-pods-drawer");
      await page.keyboard.press("Escape");
      await overview();

      await shot(page, "13-light-overview", "light");
      await failing();
      await shot(page, "14-light-pods-drawer", "light");

      await page.setViewportSize({ width: 1024, height: 700 });
      await page.keyboard.press("Escape");
      await overview();
      await shot(page, "15-1024-overview");
      await failing();
      await shot(page, "16-1024-pods-drawer");
      await shot(page, "17-1024-light-pods-drawer", "light");
    } finally {
      await page.setViewportSize({ width: 1440, height: 880 });
      await page.keyboard.press("Escape");
    }
  }, 120_000);

  it.runIf(claude)("asks Claude why the crash-looping pod fails, and shows the evidence it read", async () => {
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
    const row = page.locator(".tr", { hasText: "orders-api" }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.locator(".drawer").getByRole("button", { name: /Ask Claude/ }).click();
    const dock = page.getByRole("complementary", { name: "Claude Code" });
    await dock.locator(".ctx-chip", { hasText: "orders-api" }).waitFor();
    const box = dock.getByRole("textbox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled(), { timeout: 90_000 }).toBe(true);
    await shot(page, "07-agent-dock-ready");
    await box.fill("Why is this pod crashlooping? Keep the answer short.");
    await box.press("Enter");
    const stop = dock.getByRole("button", { name: "Stop" });
    await stop.waitFor({ timeout: 30_000 }).catch(async (err) => {
      await shot(page, "08-agent-did-not-start");
      throw new Error(`the agent did not start working; the dock says:\n${await dock.innerText()}`, { cause: err });
    });
    await shot(page, "08-agent-working");
    // While it works, answer any question the way a person would: allow once (the session can only read anyway).
    let asked = 0;
    const deadline = Date.now() + 240_000;
    while (await stop.count()) {
      if (Date.now() > deadline) throw new Error("the agent did not finish in 4 minutes");
      const ask = dock.locator(".ask button.primary").first();
      if (await ask.count()) {
        if (!asked++) await shot(page, "09-agent-asks");
        await ask.click();
      }
      await page.waitForTimeout(500);
    }
    await shot(page, "10-agent-answer");

    const answer = (await dock.locator(".msg-agent").allTextContents()).join("\n");
    expect(answer).toContain("DATABASE_URL");
    const tools = await dock.locator(".tool").count();
    // What it read beyond the attached pod (its YAML and events go with "Ask Claude") is on screen as cards.
    expect(tools).toBeGreaterThanOrEqual(1);
    const failed = await dock.locator(".tool-failed").evaluateAll((els) => els.map((e) => (e as unknown as { innerText: string }).innerText));
    expect(failed, failed.join("\n---\n")).toEqual([]);
    await dock.locator(".tool summary").first().click();
    await shot(page, "11-agent-tool-card");

    // With the drawer and the dock open at 1024×700 the sidebar is a rail and the drawer floats over the table.
    await page.setViewportSize({ width: 1024, height: 700 });
    await shot(page, "18-1024-dock-drawer");
    await page.locator(".drawer").getByRole("button", { name: "Close details" }).click();
    await shot(page, "19-1024-dock");
    await page.setViewportSize({ width: 1440, height: 880 });
  }, 360_000);
});
