// Port-forward (wave 4, part 3) in the built app against OrbStack: forward shop-front's Service and its pod's port to
// 127.0.0.1 from the drawer, fetch through them, follow the Service to a new pod when its pod is deleted, see them in
// the panel's Forwards tab, and get the kept one back after a restart. Needs deploy/scenarios/workbench.yaml in
// landlens-dev; deletes one shop-front pod (its Deployment makes another).
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseNamespace } from "./e2e-helpers";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
const freePort = () => new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const fetchText = (port: number) => new Promise<string>((ok, fail) => {
  get({ host: "127.0.0.1", port, path: "/", agent: false, timeout: 5000 }, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => ok(body));
  }).on("error", fail);
});
const fetched = (port: number) => fetchText(port).catch((e: Error) => `error: ${e.message}`);

describe.runIf(run)("port-forward on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-"));
  let svcPort = 0;
  let podPort = 0;

  const launch = async () => {
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  };

  const open = async (kind: string, name: RegExp | string) => {
    await page.getByRole("button", { name: kind, exact: true }).click();
    await chooseNamespace(page, "landlens-dev");
    const row = page.locator(".tr", { hasText: name }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.locator(".drawer").getByRole("tab", { name: "Overview" }).click();
  };

  const forward = async (label: RegExp, port: number, keep: boolean) => {
    await page.locator(".drawer").getByRole("button", { name: label }).click();
    const pop = page.getByRole("dialog", { name: /^Forward / });
    await pop.waitFor();
    // The suggestion is a free port; the test uses its own.
    await expect.poll(() => pop.getByRole("textbox", { name: "Local port" }).inputValue()).toMatch(/^\d+$/);
    await pop.getByRole("textbox", { name: "Local port" }).fill(String(port));
    if (!keep) await pop.getByRole("checkbox", { name: "Keep after restart" }).uncheck();
    return pop;
  };

  beforeAll(async () => {
    kubectl("apply", "-f", resolve(__dirname, "../../../deploy/scenarios/workbench.yaml"));
    kubectl("rollout", "status", "deploy/shop-front", "--timeout=90s");
    svcPort = await freePort();
    podPort = await freePort();
    await launch();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it("forwards a Service's port from its Ports card, as you, and serves it on 127.0.0.1", async () => {
    await open("Services", "shop-front");
    const ports = page.locator(".drawer .ports");
    await expect.poll(() => ports.innerText()).toMatch(/80\/TCP\s*→ http · http/);
    const pop = await forward(/^Forward shop-front port 80$/, svcPort, true);
    expect(await pop.innerText()).toContain("Other machines can't reach it; any program or browser page on this Mac can. It runs as you, through Landlens.");
    await shot(page, "w4-20-forward-pop");
    await page.keyboard.press("Enter");
    await pop.waitFor({ state: "detached" });
    await expect.poll(() => ports.innerText(), { timeout: 15_000 }).toContain(`127.0.0.1:${svcPort}`);
    await expect.poll(() => fetched(svcPort), { timeout: 15_000 }).toBe("<h1>shop-front</h1>\n");
    await expect.poll(() => page.locator(".statusbar").innerText()).toContain("1 forward");
    await shot(page, "w4-21-forward-running");
  }, 90_000);

  it("forwards a pod's container port, and says a taken port is in use", async () => {
    await open("Pods", "shop-front");
    let pop = await forward(/^Forward shop-front-.* port 8080$/, svcPort, false);
    await pop.getByRole("button", { name: /^Start/ }).click();
    await expect.poll(() => pop.innerText()).toMatch(new RegExp(`Port ${svcPort} is in use\\.`));
    await pop.getByRole("button", { name: /^Use \d+$/ }).waitFor();
    await shot(page, "w4-22-forward-busy");
    await pop.getByRole("textbox", { name: "Local port" }).fill(String(podPort));
    await pop.getByRole("button", { name: /^Start/ }).click();
    await pop.waitFor({ state: "detached" });
    await expect.poll(() => fetched(podPort), { timeout: 15_000 }).toBe("<h1>shop-front</h1>\n");
    pop = page.getByRole("dialog", { name: /^Forward / });
    expect(await pop.count()).toBe(0);
  }, 60_000);

  it("lists forwards in the panel's pinned tab, and follows the Service to a new pod", async () => {
    await page.locator(".statusbar").getByRole("button", { name: /2 forwards/ }).click();
    const list = page.getByRole("list", { name: "Port forwards" });
    await list.waitFor();
    await expect.poll(() => list.getByRole("listitem").count()).toBe(2);
    expect(await list.innerText()).toMatch(new RegExp(`Running[\\s\\S]*127\\.0\\.0\\.1:${svcPort}[\\s\\S]*service/shop-front:80`));
    await shot(page, "w4-23-forwards-tab");

    const before = kubectl("get", "pod", "-l", "app=shop-front", "-o", "jsonpath={.items[0].metadata.name}").trim();
    kubectl("delete", "pod", before, "--wait=false");
    // The Service forward moves to the new pod. The pod forward follows the Deployment to its new pod, and its row
    // keeps the pod you started it on: "pod/<old>:8080 · now <new>".
    const svcRow = list.getByRole("listitem").filter({ hasText: `127.0.0.1:${svcPort}` });
    const podRow = list.getByRole("listitem").filter({ hasText: `127.0.0.1:${podPort}` });
    await expect.poll(async () => {
      const t = await svcRow.innerText();
      return /shop-front-/.test(t) && !t.includes(before);
    }, { timeout: 60_000, interval: 1000 }).toBe(true);
    await expect.poll(() => podRow.innerText(), { timeout: 60_000, interval: 1000 }).toMatch(new RegExp(`pod/${before}:8080 · now shop-front-`));
    await expect.poll(() => fetched(svcPort), { timeout: 30_000 }).toBe("<h1>shop-front</h1>\n");
    await shot(page, "w4-24-forward-moved");

    // Stop the pod forward and remove it.
    await list.getByRole("button", { name: `Stop forwarding 127.0.0.1:${podPort}` }).click();
    await expect.poll(() => fetched(podPort), { timeout: 10_000 }).toMatch(/^error/);
    await list.getByRole("button", { name: `Remove the forward on 127.0.0.1:${podPort}` }).click();
    await expect.poll(() => list.getByRole("listitem").count()).toBe(1);
  }, 120_000);

  it("starts the kept forward again after a restart, without opening anything", async () => {
    await app.close();
    await expect.poll(() => fetched(svcPort), { timeout: 10_000 }).toMatch(/^error/);
    await launch();
    await expect.poll(() => fetched(svcPort), { timeout: 30_000 }).toBe("<h1>shop-front</h1>\n");
    await expect.poll(() => page.locator(".statusbar").innerText()).toContain("1 forward");
    await page.locator(".statusbar").getByRole("button", { name: /1 forward/ }).click();
    const list = page.getByRole("list", { name: "Port forwards" });
    await list.getByRole("button", { name: `Stop forwarding 127.0.0.1:${svcPort}` }).click();
    await list.getByRole("button", { name: `Remove the forward on 127.0.0.1:${svcPort}` }).click();
    await expect.poll(() => list.count()).toBe(0);
  }, 120_000);
});
