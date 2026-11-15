// Launches the built app against the OrbStack cluster and walks the wave-1 path:
// pick a cluster → pods appear live → filter → open a pod → its YAML; plus the renderer's security posture.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Wait until the dock's composer takes a message; if it never does, fail with what the dock says. */
async function ready(page: Page) {
  const dock = page.getByRole("complementary", { name: "Claude Code" });
  const box = dock.getByRole("combobox", { name: "Message Claude Code" });
  try {
    await expect.poll(() => box.isEnabled({ timeout: 2_000 }).catch(() => false), { timeout: 90_000 }).toBe(true);
  } catch (err) {
    await shot(page, "agent-not-ready");
    const text = (await dock.innerText().catch(() => "(no dock)")).slice(0, 3000);
    throw new Error(`the dock never took a message; it says:\n${text}`, { cause: err });
  }
  return box;
}

describe.runIf(run)("Landlens app on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    // The scenario's pod must have crashed at least once (a run that just re-created it leaves a fresh pod).
    const restarts = () => {
      try {
        return Number(execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", "get", "pods", "-l", "app=orders-api", "-o", "jsonpath={.items[0].status.containerStatuses[0].restartCount}"], { encoding: "utf8" }) || 0);
      } catch {
        return 0;
      }
    };
    for (let i = 0; i < 60 && restarts() < 1; i++) await new Promise((r) => setTimeout(r, 2_000));
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      // A fresh profile: no Clickland key from your own use, and nothing written to it.
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: mkdtempSync(join(tmpdir(), "landlens-e2e-")) },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
  }, 180_000);

  // Closing under load (other projects' containers share the engine) can take longer than the default 10 s.
  afterAll(async () => {
    await app?.close();
  }, 60_000);

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

  it("resizes Claude's panel by dragging or with the keys, and remembers the width (wave 6)", async () => {
    await page.setViewportSize({ width: 1440, height: 880 });
    // No drawer: beside one the dock has less room (dockMax).
    await page.keyboard.press("Escape");
    await page.locator(".drawer").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Ask Claude", description: /⌘J/ }).click();
    const dock = page.getByRole("complementary", { name: "Claude Code" });
    const grip = page.getByRole("separator", { name: "Resize Claude's panel" });
    await grip.waitFor();
    await page.waitForTimeout(400); // the slide-in
    const w = async () => Math.round((await dock.boundingBox())!.width);
    expect(await w()).toBe(392);
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + 200);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 - 200, g.y + 200, { steps: 8 });
    await page.mouse.up();
    expect(await w()).toBe(592);
    expect(await page.evaluate(() => (globalThis as any).localStorage.getItem("landlens.dock.width"))).toBe("592");
    await shot(page, "w6-01-dock-wide");
    await grip.focus();
    await page.keyboard.press("ArrowRight");
    expect(await w()).toBe(576);
    await page.keyboard.press("End"); // the rail and 600px of table stay
    expect(await w()).toBe(1440 - 52 - 600);
    await page.keyboard.press("Home");
    expect(await w()).toBe(320);
    await grip.dblclick();
    expect(await w()).toBe(392);
    expect(await page.evaluate(() => (globalThis as any).localStorage.getItem("landlens.dock.width"))).toBeNull();
    await page.keyboard.press("Meta+j");
    await dock.waitFor({ state: "detached" });
  }, 60_000);

  it("shows deployments across namespaces", async () => {
    await page.getByRole("button", { name: "Deployments", exact: true }).click();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("");
    await page.locator(".tr").first().waitFor({ timeout: 30_000 });
    await shot(page, "05-deployments");
  }, 60_000);

  it("never shows Secret values", async () => {
    await page.getByRole("button", { name: "Secrets", exact: true }).click();
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
    // A listener of the test's own on loopback, HTTP and UDP: any request that reaches it is a hit, whatever the view
    // gets back. It answers every request with a real image and open CORS, so only Landlens's rules can stop a probe.
    const hits: string[] = [];
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const http = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "image/png" });
      res.end(png);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const udp = createSocket("udp4");
    const udpHits: number[] = [];
    udp.on("message", (m) => udpHits.push(m.length));
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
    const port = (http.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const view = await viewWith(page, ".verdict");
      const url = view.url();
      const probe = await view.evaluate(async ({ base, port, udpPort }) => {
        const g = globalThis as any;
        const violations: { directive: string; blocked: string }[] = [];
        g.document.addEventListener("securitypolicyviolation", (e: any) => violations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI) }));
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const tryIt = async (fn: () => Promise<unknown>) => { try { await fn(); return "reached"; } catch { return "blocked"; } };
        let parent = "";
        try { parent = typeof g.parent.document; } catch { parent = "blocked"; }
        let storage = "";
        try { storage = typeof g.localStorage; } catch { storage = "blocked"; }
        const img = await new Promise<string>((r) => {
          const i = new g.Image();
          i.onload = () => r("loaded");
          i.onerror = () => r("blocked");
          i.src = `${base}/img.png`;
        });
        const out: Record<string, unknown> = {
          landlens: typeof g.landlens,
          parentLandlens: (() => { try { return typeof g.parent.landlens; } catch { return "blocked"; } })(),
          origin: g.origin,
          parent,
          storage,
          noCors: await tryIt(() => fetch(`${base}/no-cors`, { mode: "no-cors" })),
          cors: await tryIt(() => fetch(`${base}/cors`)),
          img,
          beacon: (() => { try { return g.navigator.sendBeacon(`${base}/beacon`, "x") ? "queued" : "refused"; } catch { return "blocked"; } })(),
          popup: g.open(`${base}/popup`) === null ? "blocked" : "opened",
        };
        try { new g.EventSource(`${base}/sse`); } catch { /* blocked */ }
        try { new g.WebSocket(`ws://127.0.0.1:${port}/ws`); } catch { /* blocked */ }
        const link = g.document.createElement("link");
        link.rel = "prefetch";
        link.href = `${base}/prefetch`;
        g.document.head.append(link);
        const bg = g.document.createElement("div");
        bg.style.backgroundImage = `url(${base}/bg.png)`;
        bg.style.width = "4px";
        bg.style.height = "4px";
        g.document.body.append(bg);
        // WebRTC: ICE gathering with a STUN server on the test's UDP port.
        const candidates: string[] = [];
        try {
          const pc = new g.RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }] });
          pc.onicecandidate = (e: any) => e.candidate && candidates.push(String(e.candidate.candidate));
          pc.createDataChannel("probe");
          await pc.setLocalDescription(await pc.createOffer());
          await sleep(2000);
          pc.close();
          out.webrtc = "ran";
        } catch (e) {
          out.webrtc = `blocked (${(e as Error).name})`;
        }
        await sleep(300);
        return { ...out, candidates, violations };
      }, { base, port, udpPort: (udp.address() as AddressInfo).port });
      await page.waitForTimeout(500);
      if (shots) writeFileSync(resolve(shots, "view-probe.json"), JSON.stringify(probe, null, 2));
      expect(probe).toMatchObject({ landlens: "undefined", parentLandlens: "blocked", origin: "null", parent: "blocked", storage: "blocked", noCors: "blocked", cors: "blocked", img: "blocked", popup: "blocked" });
      // Nothing reached the test's listener, by any route, and nothing gathered a network candidate.
      expect(hits, JSON.stringify(probe)).toEqual([]);
      expect(udpHits).toEqual([]);
      expect(probe.candidates.filter((c) => / udp | tcp /.test(` ${c} `) && !/\.local /.test(c)), String(probe.candidates)).toEqual([]);
      // Each probe was stopped by the CSP itself, one violation per address (not a set that one probe could fill).
      const by = (d: string, path: string) => probe.violations.some((v) => v.directive === d && v.blocked.startsWith(`${base}${path}`));
      for (const path of ["/no-cors", "/cors", "/beacon", "/sse"]) expect(by("connect-src", path), `${path}: ${JSON.stringify(probe.violations)}`).toBe(true);
      expect(by("img-src", "/img.png")).toBe(true);
      expect(by("img-src", "/bg.png")).toBe(true);
      expect(probe.violations.some((v) => v.directive === "connect-src" && v.blocked.startsWith(`ws://127.0.0.1:${port}`))).toBe(true);
      expect(url).toMatch(/^landlens-app:\/\/view\/[0-9a-f]{32}$/);
    } finally {
      http.close();
      udp.close();
    }

    // It can't navigate itself elsewhere. Each probe gets a fresh view (a cancelled navigation leaves the frame on
    // Chromium's error page). Another landlens-app: address passes the page's frame-src, so only main's
    // will-frame-navigate stops it; data: and the web are stopped by both.
    const kube = page.getByRole("region", { name: "MCP server landlens-kube" });
    for (const target of [`landlens-app://view/${"0".repeat(32)}`, "data:text/html,<p>moved</p>", "https://example.com/"]) {
      await kube.getByRole("button", { name: "Close preview" }).click();
      await kube.getByRole("button", { name: "Preview cluster_overview" }).click();
      const view = await viewWith(page, ".verdict");
      const frames = page.frames().length;
      await view.evaluate((t) => { (globalThis as any).location.href = t; }, target).catch(() => {});
      await page.waitForTimeout(800);
      const urls = page.frames().map((f) => f.url());
      const scheme = target.slice(0, target.indexOf(":") + 1);
      expect(urls.some((u) => u === target || (scheme !== "landlens-app:" && u.startsWith(scheme))), `${target}: ${urls.join(", ")}`).toBe(false);
      expect(urls.filter((u) => !u.startsWith("file:") && !/^landlens-app:\/\/view\/[0-9a-f]{32}$/.test(u) && !u.startsWith("chrome-error:")), urls.join(", ")).toEqual([]);
      expect(page.frames().length).toBe(frames);
    }
    // And main serves a view only at a live view's own address.
    const other = await page.evaluate(() => fetch("landlens-app://view/" + "0".repeat(32)).then((r) => r.status, () => "blocked"));
    expect(other).toBe("blocked"); // the page's own CSP: connect-src 'self'
    await kube.getByRole("button", { name: "Close preview" }).click();
    await kube.getByRole("button", { name: "Preview cluster_overview" }).click();
    await viewWith(page, ".verdict");
  }, 90_000);

  it("opens links only through main, https only, and never through window.open", async () => {
    await app.evaluate(({ shell }) => {
      const g = globalThis as any;
      g.__opened = [];
      shell.openExternal = async (u: string) => void g.__opened.push(u);
    });
    const r = await page.evaluate(async () => {
      const g = globalThis as any;
      const popup = g.open("https://example.com/from-window-open") === null ? "denied" : "opened";
      const ok = await g.landlens.invoke("link:open", { url: "https://example.com/from-answer" });
      const plain = await g.landlens.invoke("link:open", { url: "http://example.com/" }).then(() => "opened", (e: Error) => e.message);
      return { popup, ok, plain };
    });
    expect(r).toEqual({ popup: "denied", ok: { opened: true }, plain: "Landlens opens https links only." });
    await page.waitForTimeout(300);
    expect(await app.evaluate(() => (globalThis as any).__opened)).toEqual(["https://example.com/from-answer"]);
  });

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
      // The readout is the series (and the total), never the reference lines: those are labelled in the gutter.
      await plot.locator(".chart-tip").waitFor();
      expect(await plot.locator(".chart-tip").textContent()).not.toContain("allocatable");
      expect(await plot.locator("svg").textContent()).toContain("allocatable");
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
      // In the drawer nothing floats over the plot: the head takes the crosshair's time and the legend its values.
      await expect.poll(() => tab.locator(".chart-now").first().textContent()).toMatch(/^\d\d:\d\d · /);
      expect(await tab.locator(".chart-tip").count()).toBe(0);
      await shot(page, "24-pod-metrics");
      await shot(page, "25-light-pod-metrics", "light");
      await page.mouse.move(0, 0);

      await page.locator(".tr", { hasText: "orders-api" }).first().click();
      await page.getByRole("tab", { name: "Metrics" }).click();
      await tab.getByRole("status").filter({ hasText: "No usage samples" }).waitFor({ timeout: 30_000 });
      expect(await tab.textContent()).toMatch(/its status is (CrashLoopBackOff|Error)/);
      await shot(page, "26-pod-metrics-no-samples");

      await page.getByRole("button", { name: "Deployments", exact: true }).click();
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
      await expect(panel.getByRole("switch", { name: "Use clickland on orbstack" }).isChecked()).resolves.toBe(true);
      // A remote server's own "read-only" is only its claim: nothing runs without asking until you say so.
      const auto = panel.getByRole("switch", { name: "Run clickland's read-only tools without asking" });
      await expect(auto.isChecked()).resolves.toBe(false);
      // The header never comes back to the page.
      expect(JSON.stringify(await page.evaluate(() => (globalThis as any).landlens.invoke("mcp:servers", { context: "orbstack" })))).not.toContain(key);
      await panel.getByRole("button", { name: "Test" }).click();
      await panel.getByRole("list", { name: "clickland tools" }).waitFor({ timeout: 20_000 });
      expect(await panel.locator(".mcp-tool .badge", { hasText: "Read-only" }).count()).toBe(0);
      await auto.click();
      await expect.poll(() => auto.isChecked()).toBe(true);
      expect(await panel.locator(".mcp-tool .badge", { hasText: "Read-only" }).count()).toBeGreaterThan(0);
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
    const box = await ready(page);
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
    // A failed card is a bug, unless it's Landlens refusing Secrets: the agent sometimes looks, and is told no.
    const failed = (await dock.locator(".tool-failed").evaluateAll((els) => els.map((e) => (e as unknown as { innerText: string }).innerText)))
      .filter((t) => !/\bsecrets\b/.test(t));
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
    const box = await ready(page);
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
    // Only the newest view stays open; the earlier ones fold to their tool row and verdict, so the answer stays near.
    const object = await viewWith(page, "button:has-text('Open in Landlens')");
    expect(await dock.locator(".tool-app iframe").count()).toBe(1);
    const folded = dock.locator(".tool-verdict");
    expect(await folded.count()).toBeGreaterThanOrEqual(1);
    await dock.locator(".msg-agent").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "38-dock-views-folded");
    await shot(page, "39-light-dock-views-folded", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await dock.locator(".tool-with-app.folded", { hasText: "cluster overview" }).last().locator(".tool-verdict").click();
    const health = await viewWith(page, ".verdict");
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
    // "Open in Landlens" takes the main view to the pod. The dock caps a tall view until "Show all".
    const expanded = await (await object.frameElement()).evaluate((el: any) => {
      const more = el.closest(".app-frame")?.querySelector(".app-fade button");
      more?.click();
      return !!more;
    });
    if (expanded) await page.waitForTimeout(300);
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

  it.runIf(claude)("proposes the crashloop fix as a diff: a rejected change never applies, an approved one fixes the deployment", async () => {
    // Back to the broken scenario (a past run may have fixed it): only in landlens-dev.
    const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
    const scenario = resolve(__dirname, "../../../deploy/scenarios/crashloop.yaml");
    kubectl("delete", "deployment", "orders-api", "--ignore-not-found", "--wait=true");
    kubectl("apply", "-f", scenario);
    const env = () => kubectl("get", "deployment", "orders-api", "-o", "jsonpath={.spec.template.spec.containers[0].env}");
    const dock = page.getByRole("complementary", { name: "Claude Code" });
    const box = await ready(page);
    const stop = dock.getByRole("button", { name: "Stop" });
    /** Send a message and answer the agent until it finishes; `onChange` decides each change card that appears. */
    const turn = async (text: string, onChange: (card: ReturnType<typeof dock.locator>) => Promise<void>) => {
      await box.fill(text);
      await box.press("Enter");
      await stop.waitFor({ timeout: 30_000 });
      const deadline = Date.now() + 300_000;
      while (await stop.count()) {
        if (Date.now() > deadline) throw new Error(`the agent did not finish in 5 minutes; the dock says:\n${await dock.innerText()}`);
        const card = dock.locator("section.change").first();
        if (await card.count()) await onChange(card);
        const ask = dock.locator(".ask button.primary").first();
        if (await ask.count()) await ask.click();
        await page.waitForTimeout(500);
      }
    };
    const fix = "The orders-api deployment in namespace landlens-dev crash-loops because DATABASE_URL is not set. Propose the fix with the patch tool: " +
      "add the env var DATABASE_URL=postgres://orders-db.landlens-dev.svc.cluster.local:5432/orders to its api container. Propose exactly one change, then stop.";

    // 1. Rejected with a note: nothing reaches the deployment, and the agent hears why.
    let seen = 0;
    await turn(fix, async (card) => {
      if (seen++) return;
      await card.locator(".diff").first().waitFor();
      expect(await card.locator(".diff").first().innerText()).toContain("DATABASE_URL");
      await card.scrollIntoViewIfNeeded();
      await shot(page, "50-change-card");
      await shot(page, "51-light-change-card", "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize({ width: 1024, height: 700 });
      await card.scrollIntoViewIfNeeded();
      await shot(page, "52-1024-change-card");
      await page.setViewportSize({ width: 1440, height: 880 });
      await card.getByRole("button", { name: "Reject with a note" }).click();
      await box.fill("Not yet. Wait until I ask again.");
      await dock.getByRole("button", { name: /Reject with note/ }).click();
    });
    expect(seen).toBeGreaterThanOrEqual(1);
    await dock.locator(".change-done.rejected").first().waitFor();
    await shot(page, "53-change-rejected");
    expect(env()).not.toContain("DATABASE_URL");

    // 2. Approved: Landlens applies exactly the diff, and the deployment recovers.
    let approved = 0;
    await turn("Propose that same fix again now; I'll approve it.", async (card) => {
      if (approved) return;
      await card.locator(".diff").first().waitFor();
      // Nothing is approved unseen: a capped diff or closed operation is shown first.
      const reveal = card.getByRole("button", { name: "Show all of it to approve" });
      if (await reveal.count()) await reveal.click();
      await card.getByRole("button", { name: /^Approve/ }).click();
      approved++;
    });
    expect(approved).toBe(1);
    await dock.locator(".change-done.applied").first().waitFor({ timeout: 30_000 });
    await shot(page, "54-change-applied");
    expect(env()).toContain("DATABASE_URL");
    await expect.poll(() => kubectl("get", "deployment", "orders-api", "-o", "jsonpath={.status.availableReplicas}"), { timeout: 120_000, interval: 2_000 }).toBe("1");
    // The changes are on the history entry for this session.
    await dock.getByRole("button", { name: /History/ }).click();
    const row = dock.getByRole("list", { name: /Past sessions/ }).locator(".hist-row.on");
    await expect.poll(() => row.innerText()).toContain("1 change");
    await shot(page, "55-history");
    await page.keyboard.press("Escape");
    // Leave the scenario broken again for the next run.
    kubectl("delete", "deployment", "orders-api", "--wait=true");
    kubectl("apply", "-f", scenario);
  }, 900_000);
});
