// Launches the built app against the OrbStack cluster and walks the wave-1 path:
// pick a cluster → pods appear live → filter → open a pod → its YAML; plus the renderer's security posture.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Frame, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
/** Runs your own Claude Code (your login and usage) against deploy/scenarios/crashloop.yaml in landlens-dev. */
const claude = flags.includes("claude");
/**
 * Graphs from a running Clickland with metric filters (LANDLENS_CLICKLAND_URL, default http://127.0.0.1:4710). The test
 * makes a read-scoped key with Clickland's development bootstrap key, types it into Connect Clickland, and revokes it.
 * Needs deploy/scenarios/metrics.yaml running for a few minutes.
 */
const clickland = flags.includes("clickland");
const CLICKLAND_URL = process.env.LANDLENS_CLICKLAND_URL ?? "http://127.0.0.1:4710";
const CLICKLAND_ADMIN = process.env.CLICKLAND_BOOTSTRAP_KEY ?? "ck_dev_bootstrap_key_000000000000000";
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

/** The MCP App view frames on the page (landlens-app://view/…), newest last. */
const viewFrames = (page: Page): Frame[] => page.frames().filter((f) => f.url().startsWith("landlens-app://"));
/** Wait for a view frame whose document shows `selector`. */
async function viewWith(page: Page, selector: string, timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const f of viewFrames(page)) if (await f.locator(selector).count().catch(() => 0)) return f;
    if (Date.now() > deadline) throw new Error(`no view showing ${selector}; frames: ${viewFrames(page).map((f) => f.url()).join(", ")}`);
    await page.waitForTimeout(250);
  }
}

describe.runIf(run)("Landlens app on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      // A fresh profile: no Clickland key from your own use, and nothing written to it.
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-")) },
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

  it("says why there are no graphs, and how to fix it, when neither Clickland nor metrics-server is there", async () => {
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    const usage = page.getByRole("region", { name: "Usage" });
    await usage.getByRole("status", { name: "Metrics unavailable" }).waitFor({ timeout: 30_000 });
    const text = (await usage.textContent()) ?? "";
    expect(text).toContain("Clickland isn't connected");
    expect(text).toContain("metrics-server");
    await expect(usage.getByRole("button", { name: "Connect Clickland" }).isVisible()).resolves.toBe(true);
    await usage.scrollIntoViewIfNeeded();
    await shot(page, "20-usage-unavailable");
  }, 60_000);


  it("lists the MCP servers, previews landlens-kube's health card in its sandbox, in dark and light", async () => {
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.getByRole("heading", { name: "MCP" }).waitFor();
    const kube = page.getByRole("region", { name: "MCP server landlens-kube" });
    await kube.getByRole("list", { name: "landlens-kube tools" }).waitFor({ timeout: 30_000 });
    const tools = (await kube.locator(".mcp-tool").allTextContents()).join("\n");
    for (const t of ["cluster_overview", "describe", "get_logs", "metrics"]) expect(tools).toContain(t);
    expect(await kube.locator(".badge", { hasText: "Asks first" }).count()).toBe(0);
    await shot(page, "30-mcp-servers");

    await kube.getByRole("button", { name: "Preview cluster_overview" }).click();
    const view = await viewWith(page, ".verdict");
    expect(await view.locator(".eyebrow").first().textContent()).toContain("orbstack");
    await page.waitForTimeout(300);
    await shot(page, "31-mcp-preview-health");
    await shot(page, "32-light-mcp-preview-health", "light");
    await expect.poll(() => view.evaluate(() => (globalThis as any).document.documentElement.getAttribute("data-theme"))).toBe("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => view.evaluate(() => (globalThis as any).document.documentElement.getAttribute("data-theme"))).toBe("dark");
  }, 90_000);

  it("keeps a view off the network, away from the page and window.landlens, and where it was loaded", async () => {
    const view = await viewWith(page, ".verdict");
    const url = view.url();
    const probe = await view.evaluate(async () => {
      const g = globalThis as any;
      const violations: string[] = [];
      g.document.addEventListener("securitypolicyviolation", (e: any) => violations.push(e.effectiveDirective));
      const tryFetch = (u: string) => fetch(u).then(() => "reached", () => "blocked");
      let parent = "";
      try {
        parent = typeof g.parent.document;
      } catch {
        parent = "blocked";
      }
      let storage = "";
      try {
        storage = typeof g.localStorage;
      } catch {
        storage = "blocked";
      }
      const img = await new Promise<string>((r) => {
        const i = new g.Image();
        i.onload = () => r("loaded");
        i.onerror = () => r("blocked");
        i.src = "https://example.com/x.png";
      });
      const out = {
        landlens: typeof g.landlens,
        parentLandlens: (() => { try { return typeof g.parent.landlens; } catch { return "blocked"; } })(),
        origin: g.origin,
        parent,
        storage,
        local: await tryFetch("http://127.0.0.1:9/"),
        web: await tryFetch("https://example.com/"),
        img,
        popup: g.open("https://example.com") === null ? "blocked" : "opened",
      };
      await new Promise((r) => setTimeout(r, 100));
      return { ...out, violations: [...new Set(violations)].sort() };
    });
    expect(probe).toMatchObject({ landlens: "undefined", parentLandlens: "blocked", origin: "null", parent: "blocked", storage: "blocked", local: "blocked", web: "blocked", img: "blocked", popup: "blocked" });
    expect(probe.violations).toEqual(expect.arrayContaining(["connect-src", "img-src"]));
    // It can't navigate itself elsewhere: main cancels it (the frame is left on Chromium's error page) and the
    // address never loads.
    const frames = page.frames().length;
    await view.evaluate(() => { (globalThis as any).location.href = "https://example.com/"; }).catch(() => {});
    await page.waitForTimeout(800);
    const urls = page.frames().map((f) => f.url());
    expect(urls.some((u) => u.startsWith("https://example.com")), urls.join(", ")).toBe(false);
    expect(urls.filter((u) => !u.startsWith("file:") && !u.startsWith("landlens-app:") && !u.startsWith("chrome-error:")), urls.join(", ")).toEqual([]);
    expect(page.frames().length).toBe(frames);
    expect(url).toMatch(/^landlens-app:\/\/view\/[0-9a-f]{32}$/);
    // And main serves a view only at a live view's own address.
    const other = await page.evaluate(() => fetch("landlens-app://view/" + "0".repeat(32)).then((r) => r.status, () => "blocked"));
    expect(other).toBe("blocked"); // the page's own CSP: connect-src 'self'
  }, 60_000);

  it("logs the calls, with the front-door requests behind each landlens-kube call", async () => {
    await page.getByRole("tab", { name: /Calls/ }).click();
    const list = page.getByRole("list", { name: "MCP calls" });
    const row = list.locator(".mcp-call", { hasText: "landlens-kube · cluster_overview" }).first();
    await row.waitFor({ timeout: 10_000 });
    expect(await row.textContent()).toContain("you");
    await shot(page, "33-mcp-calls");
    await row.click();
    const drawer = page.getByRole("complementary", { name: "MCP call" });
    await drawer.waitFor();
    const reqs = drawer.getByRole("list", { name: "Front-door requests" });
    await reqs.waitFor();
    expect(await reqs.locator("li").count()).toBeGreaterThan(1);
    expect(await reqs.textContent()).toContain("/api/v1/pods");
    await viewWith(page, ".verdict");
    await shot(page, "34-mcp-call-detail");
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /Servers/ }).click();
  }, 60_000);

  it.runIf(clickland)("connects Clickland, then draws the cluster's usage and a pod's metrics, in dark and light", async () => {
    const made = await fetch(`${CLICKLAND_URL}/api/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLICKLAND_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "landlens-e2e", scopes: ["read"] }),
    });
    expect(made.status).toBe(201);
    const { id, key } = (await made.json()) as { id: string; key: string };
    try {
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.getByRole("region", { name: "Usage" }).getByRole("button", { name: "Connect Clickland" }).click();
      const dialog = page.getByRole("dialog", { name: "Connect Clickland" });
      await dialog.getByLabel("Clickland address").fill(CLICKLAND_URL);
      await dialog.getByLabel("Clickland API key").fill(key);
      await dialog.getByRole("button", { name: "Test" }).click();
      const result = dialog.getByRole("list", { name: "Test result" });
      await result.waitFor({ timeout: 20_000 });
      expect(await result.textContent()).toMatch(/Health.*Filters.*Query/s);
      await expect(dialog.locator(".test-steps .tone-bad").count()).resolves.toBe(0);
      await shot(page, "21-connect-clickland");
      await dialog.getByRole("button", { name: "Save" }).click();
      // The key never comes back to the page.
      expect(await page.evaluate(() => (globalThis as any).landlens.invoke("metrics:settings", {}))).toEqual(expect.objectContaining({ hasKey: true }));
      expect(JSON.stringify(await page.evaluate(() => (globalThis as any).landlens.invoke("metrics:settings", {})))).not.toContain(key);

      const usage = page.getByRole("region", { name: "Usage" });
      await usage.locator(".metrics-src", { hasText: "Clickland" }).waitFor({ timeout: 30_000 });
      await usage.locator(".chart-plot svg path.edge").first().waitFor();
      await usage.scrollIntoViewIfNeeded();
      const plot = usage.locator(".chart-plot").first();
      const box = (await plot.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
      await expect(plot.locator(".chart-tip").textContent()).resolves.toContain("allocatable");
      await shot(page, "22-overview-usage");
      await shot(page, "23-light-overview-usage", "light");
      await page.mouse.move(0, 0);

      await page.getByRole("button", { name: "Pods", exact: true }).click();
      await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
      await page.locator(".tr", { hasText: "catalog-api" }).first().click();
      await page.getByRole("tab", { name: "Metrics" }).click();
      const tab = page.locator(".mtab");
      await tab.locator(".chart-plot svg path.edge").first().waitFor({ timeout: 30_000 });
      expect(await tab.locator(".chart-legend").first().textContent()).toMatch(/api.*proxy/s);
      expect(await tab.textContent()).toMatch(/limit 250m.*request 60m/s);
      const pbox = (await tab.locator(".chart-plot").first().boundingBox())!;
      await page.mouse.move(pbox.x + pbox.width * 0.8, pbox.y + pbox.height * 0.5);
      await tab.locator(".chart-tip").waitFor();
      await shot(page, "24-pod-metrics");
      await shot(page, "25-light-pod-metrics", "light");
      await page.mouse.move(0, 0);

      await page.locator(".tr", { hasText: "orders-api" }).first().click();
      await page.getByRole("tab", { name: "Metrics" }).click();
      await tab.getByRole("status").filter({ hasText: "No usage samples" }).waitFor({ timeout: 30_000 });
      expect(await tab.textContent()).toMatch(/its status is (CrashLoopBackOff|Error)/);
      await shot(page, "26-pod-metrics-no-samples");

      await page.getByRole("button", { name: "Deployments" }).click();
      await page.locator(".tr", { hasText: "catalog-api" }).first().click();
      await page.getByRole("tab", { name: "Metrics" }).click();
      await tab.locator(".chart-plot svg path.line").first().waitFor({ timeout: 30_000 });
      await shot(page, "27-deployment-metrics");
    } finally {
      await page.keyboard.press("Escape");
      await fetch(`${CLICKLAND_URL}/api/keys/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${CLICKLAND_ADMIN}` } });
    }
  }, 180_000);


  it.runIf(clickland)("adds Clickland's MCP server with a read key, tests it, and shows its view from Preview", async () => {
    const made = await fetch(`${CLICKLAND_URL}/api/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLICKLAND_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "landlens-e2e-mcp", scopes: ["read"] }),
    });
    expect(made.status).toBe(201);
    const { id, key } = (await made.json()) as { id: string; key: string };
    try {
      await page.getByRole("button", { name: "MCP", exact: true }).click();
      await page.getByRole("button", { name: "Add server" }).click();
      const dialog = page.getByRole("dialog", { name: "Add an MCP server" });
      await dialog.getByLabel("Server name").fill("clickland");
      await dialog.getByLabel("Server address").fill(`${CLICKLAND_URL}/api/mcp`);
      await dialog.getByLabel("Header name").fill("Authorization");
      await dialog.getByLabel("Header value").fill(`Bearer ${key}`);
      await dialog.getByRole("button", { name: "Test" }).click();
      const result = dialog.getByRole("list", { name: "Test result" });
      await result.waitFor({ timeout: 20_000 });
      expect(await result.textContent()).toMatch(/initialize.*tools\/list/s);
      await expect(dialog.locator(".test-steps .tone-bad").count()).resolves.toBe(0);
      await shot(page, "35-mcp-add-server");
      await dialog.getByRole("button", { name: "Save" }).click();
      const panel = page.getByRole("region", { name: "MCP server clickland" });
      await panel.waitFor();
      await expect(panel.getByRole("switch").isChecked()).resolves.toBe(true);
      // The header never comes back to the page.
      expect(JSON.stringify(await page.evaluate(() => (globalThis as any).landlens.invoke("mcp:servers", { context: "orbstack" })))).not.toContain(key);
      await panel.getByRole("button", { name: "Test" }).click();
      await panel.getByRole("list", { name: "clickland tools" }).waitFor({ timeout: 20_000 });
      await panel.getByRole("button", { name: "Preview list_services" }).click();
      const before = viewFrames(page).length;
      await expect.poll(() => viewFrames(page).length, { timeout: 30_000 }).toBeGreaterThan(before);
      const frame = viewFrames(page).at(-1)!;
      await expect.poll(() => frame.evaluate(() => (globalThis as any).document.body.innerText.trim().length).catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(20);
      await page.waitForTimeout(800);
      await panel.scrollIntoViewIfNeeded();
      await shot(page, "36-mcp-clickland-view");
      await page.getByRole("tab", { name: /Calls/ }).click();
      await page.getByRole("list", { name: "MCP calls" }).locator(".mcp-call", { hasText: "clickland · list_services" }).first().click();
      await page.getByRole("complementary", { name: "MCP call" }).waitFor();
      await shot(page, "37-mcp-clickland-call");
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: /Servers/ }).click();
    } finally {
      await fetch(`${CLICKLAND_URL}/api/keys/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${CLICKLAND_ADMIN}` } });
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

  it.runIf(claude)("shows cluster_overview's health card and describe's object card inline in the dock, dark and light", async () => {
    const dock = page.getByRole("complementary", { name: "Claude Code" });
    const box = dock.getByRole("textbox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled(), { timeout: 90_000 }).toBe(true);
    await box.fill("Call the cluster_overview tool, then the describe tool for pod orders-api in namespace landlens-dev (use list_resources first if you need its full name). Answer in one sentence.");
    await box.press("Enter");
    const stop = dock.getByRole("button", { name: "Stop" });
    await stop.waitFor({ timeout: 30_000 });
    const deadline = Date.now() + 240_000;
    while (await stop.count()) {
      if (Date.now() > deadline) throw new Error("the agent did not finish in 4 minutes");
      const ask = dock.locator(".ask button.primary").first();
      if (await ask.count()) await ask.click();
      await page.waitForTimeout(500);
    }
    const health = await viewWith(page, ".verdict");
    const object = await viewWith(page, "button:has-text('Open in Landlens')");
    expect(await dock.locator(".tool-app iframe").count()).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(500);
    // Each view's own frame element, so the shot shows that card (the first test's log view is above them).
    await (await health.frameElement()).evaluate((el: any) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await shot(page, "40-dock-health-card");
    await shot(page, "41-light-dock-health-card", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await (await object.frameElement()).evaluate((el: any) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await shot(page, "42-dock-object-card");
    await shot(page, "43-light-dock-object-card", "light");
    expect(await health.evaluate(() => (globalThis as any).document.documentElement.getAttribute("data-theme"))).toBe("light");
    await page.emulateMedia({ colorScheme: "dark" });
    // "Open in Landlens" takes the main view to the pod.
    await object.locator("button", { hasText: "Open in Landlens" }).click();
    await expect.poll(async () => (await page.locator(".drawer").textContent().catch(() => "")) ?? "", { timeout: 30_000 }).toContain("orders-api");
    await shot(page, "44-open-in-landlens");
    // The calls are logged against the agent session and paired with their cards.
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.getByRole("tab", { name: /Calls/ }).click();
    const row = page.getByRole("list", { name: "MCP calls" }).locator(".mcp-call", { hasText: "landlens-kube · describe" }).first();
    await row.click();
    const drawer = page.getByRole("complementary", { name: "MCP call" });
    await expect.poll(() => drawer.textContent()).toContain("Dock card");
    await shot(page, "45-mcp-agent-call-detail");
  }, 360_000);
});
