// Clickland in the IDE (wave 7 part 3, D115–D118) in the built app against OrbStack and the loopback fake Clickland
// (packages/connections/test/fake-family.ts), seeded with lines for the doctor scenario's real ledger-worker pods in
// landlens-dev and one pod that is gone: the Logs tab's History source for the deployment and for a pod, Errors only,
// the person's words as one phrase, a line picked for Ask Claude; the Traces tab and one trace's spans; the console
// address in the Clickland dialog and Open in Clickland behind main's dialog (stubbed here), from the Logs tab and ⌘K.
// With `clickland` too, the same History view against a real Clickland (LANDLENS_CLICKLAND_URL, default :4730, and
// LANDLENS_CLICKLAND_KEY, default the development bootstrap key; reads only) shows ledger-worker's real crash line.
// LANDLENS_INTEGRATION=orbstack npx vitest run test/clickland.e2e.test.ts  (screenshots to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CK_READ, FakeClickland } from "../../../packages/connections/test/fake-family";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
const live = run && flags.includes("clickland");
const shots = process.env.LANDLENS_SHOTS;
const SECRET = "hunter2hunter2hunter2";
const GONE = "ledger-worker-79756648df-gone1";
const CONSOLE = "http://127.0.0.1:4711";

const shot = async (page: Page, name: string, colorScheme: "dark" | "light" = "dark") => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};
const both = async (page: Page, name: string) => {
  await shot(page, `${name}-dark`, "dark");
  await shot(page, `${name}-light`, "light");
  await page.emulateMedia({ colorScheme: "dark" });
};
const pods = (app: string) =>
  execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", "get", "pods", "-l", `app=${app}`, "-o", "jsonpath={.items[*].metadata.name}"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function launch(userData: string) {
  const app = await electron.launch({
    executablePath: require("electron") as unknown as string,
    args: [resolve(__dirname, "..")],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData },
  });
  // Main's native dialog answers Open, and the browser is played: both record what they were given.
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { asked: string[]; opened: string[] };
    g.asked = [];
    g.opened = [];
    (dialog as unknown as { showMessageBox: (...a: unknown[]) => Promise<unknown> }).showMessageBox = async (...a: unknown[]) => {
      const o = a.find((x) => x && typeof x === "object" && "message" in (x as object)) as { message: string; detail: string };
      g.asked.push(`${o.message}\n${o.detail}`);
      return { response: 0, checkboxChecked: false };
    };
    (shell as unknown as { openExternal: (u: string) => Promise<void> }).openExternal = async (u: string) => void g.opened.push(u);
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 880 });
  return { app, page };
}

async function connectClickland(page: Page, url: string, key: string, consoleUrl?: string) {
  await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
  await page.getByRole("button", { name: /^Connections/ }).click();
  const card = page.getByRole("region", { name: "Clickland connection" });
  await card.getByRole("button", { name: "Connect…" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Clickland" });
  await dialog.getByLabel("Clickland address").fill(url);
  await dialog.getByLabel("Clickland API key").fill(key);
  if (consoleUrl) await dialog.getByLabel("Clickland console address").fill(consoleUrl);
  return { card, dialog };
}

async function openDeployment(page: Page, name: string) {
  await page.getByRole("button", { name: "Clusters" }).click();
  await page.getByRole("button", { name: /orbstack/ }).first().click();
  await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
  const row = page.locator(".tr", { hasText: name }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
}

describe.runIf(run)("Clickland's history in the IDE, against the fake Clickland", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let ck: FakeClickland;
  let running: string[] = [];
  const drawer = () => page.locator(".drawer");
  const lines = () => drawer().getByRole("log", { name: "Clickland log lines" });
  const g = () => app.evaluate(() => {
    const x = globalThis as unknown as { asked: string[]; opened: string[] };
    return { asked: [...x.asked], opened: [...x.opened] };
  });

  beforeAll(async () => {
    ck = await new FakeClickland().start();
    running = pods("ledger-worker");
    expect(running.length).toBeGreaterThan(0);
    const res = (pod: string) => ({ "k8s.cluster.name": "orbstack", "k8s.namespace.name": "landlens-dev", "k8s.deployment.name": "ledger-worker", "k8s.pod.name": pod, "k8s.container.name": "worker" });
    let m = 50;
    for (const pod of [GONE, ...running.slice(0, 3)]) {
      ck.addLog({ timestamp: ago(m--), body: "ledger worker starting, shards from LEDGER_SHARDS\n", severity: "INFO", service: "ledger-worker", resource: res(pod), attributes: { "log.iostream": "stdout" } });
      ck.addLog({ timestamp: ago(m--), body: `calling the ledger API with Authorization: Bearer ${SECRET}\n`, severity: "INFO", service: "ledger-worker", resource: res(pod), attributes: { "log.iostream": "stdout" } });
      ck.addLog({ timestamp: ago(m--), body: "FATAL: cannot parse LEDGER_SHARDS=three (want a number)\n", severity: "ERROR", service: "ledger-worker", resource: res(pod), attributes: { "log.iostream": "stderr" } });
    }
    const t = (n: number) => n.toString(16).padStart(32, "0");
    ck.addSpan({ timestamp: ago(9), name: "POST /ledger/close", service: "ledger-worker", traceId: t(1), spanId: "a1", durationMs: 182 });
    ck.addSpan({ timestamp: new Date(Date.parse(ago(9)) + 12).toISOString(), name: "SELECT ledger_entries", service: "ledger-worker", kind: "Client", traceId: t(1), spanId: "a2", parentSpanId: "a1", durationMs: 64 });
    ck.addSpan({ timestamp: new Date(Date.parse(ago(9)) + 90).toISOString(), name: "POST shards.parse", service: "ledger-worker", traceId: t(1), spanId: "a3", parentSpanId: "a1", durationMs: 70, status: "Error" });
    ck.addSpan({ timestamp: ago(4), name: "GET /healthz", service: "ledger-worker", traceId: t(2), spanId: "b1", durationMs: 3 });
    ({ app, page } = await launch(mkdtempSync(join(tmpdir(), "landlens-e2e-clickland-"))));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await ck?.stop();
  }, 60_000);

  it("stores the console address from the Clickland dialog (D118)", async () => {
    const { card, dialog } = await connectClickland(page, ck.origin, CK_READ, CONSOLE);
    await both(page, "w7p3-01-clickland-dialog-console");
    await dialog.getByRole("button", { name: "Save" }).click();
    await card.getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    // Opened again, the dialog shows it.
    await card.getByRole("button", { name: "Settings…" }).click();
    const again = page.getByRole("dialog", { name: "Connect Clickland" }).getByLabel("Clickland console address");
    await expect.poll(() => again.inputValue()).toBe(CONSOLE);
    await page.keyboard.press("Escape");
  });

  it("shows a deployment's history from Clickland, newest last, its pods marked, a gone pod's lines too (D118)", async () => {
    await openDeployment(page, "ledger-worker");
    await drawer().getByRole("tab", { name: "Logs" }).click();
    await drawer().getByRole("radio", { name: "History" }).click();
    await lines().getByText("FATAL: cannot parse LEDGER_SHARDS").first().waitFor({ timeout: 20_000 });
    const text = await lines().innerText();
    expect(text).not.toContain(SECRET);
    expect(text).toContain("<redacted auth header>");
    // Newest last: the last row is the newest live pod's crash line.
    const tx = await lines().locator(".ll .tx").allInnerTexts();
    expect(tx.at(-1)).toContain("FATAL");
    expect(tx).toHaveLength(12);
    await expect(drawer().locator(".logs-foot").innerText()).resolves.toMatch(/From Clickland\s*orbstack/);
    expect(await drawer().locator(".ll.err").count()).toBe(4);
    // What the window asked: main's own search, from names it checked.
    expect(ck.searches.at(-1)).toMatchObject({ signal: "logs", query: expect.stringMatching(/^k8s\.cluster\.name:"orbstack" k8s\.namespace\.name:"landlens-dev" k8s\.deployment\.name:"ledger-worker"( k8s\.container\.name:"worker")?$/) });
    await both(page, "w7p3-02-history-deployment");
  });

  it("Errors only and the person's words narrow it in Clickland; a picked line can go to Claude", async () => {
    await drawer().getByRole("button", { name: "Errors" }).click();
    await expect.poll(() => lines().locator(".ll").count(), { timeout: 10_000 }).toBe(4);
    // Fatal and critical lines count as errors too (review of part 3, L7).
    expect(ck.searches.at(-1)!.query.endsWith(" (level:error OR level:fatal OR level:critical)")).toBe(true);
    await drawer().getByLabel("Find in Clickland's lines").fill(`three" OR k8s.namespace.name:"clickland-dev`);
    await page.keyboard.press("Enter");
    await expect.poll(() => drawer().locator(".logs-end").innerText().catch(() => ""), { timeout: 10_000 }).toMatch(/No lines from Clickland/);
    expect(ck.searches.at(-1)!.query.endsWith(`"three\\" OR k8s.namespace.name:\\"clickland-dev"`)).toBe(true);
    await drawer().getByLabel("Find in Clickland's lines").fill("LEDGER_SHARDS=three");
    await page.keyboard.press("Enter");
    await expect.poll(() => lines().locator(".ll").count(), { timeout: 10_000 }).toBe(4);
    await lines().locator(".ll .ts").last().click();
    await drawer().getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Ask Claude" }).waitFor();
    await both(page, "w7p3-03-history-errors-picked");
    await page.keyboard.press("Escape");
  });

  it("Open in Clickland builds the console's search in main and opens it after the dialog that shows its host", async () => {
    await drawer().getByRole("button", { name: "Open in Clickland" }).click();
    await expect.poll(async () => (await g()).opened.length).toBe(1);
    const { asked, opened } = await g();
    expect(asked[0]).toMatch(/^Open 127\.0\.0\.1:4711 in your browser\?/);
    const u = new URL(opened[0]!);
    expect(u.origin).toBe(CONSOLE);
    expect(u.searchParams.get("signal")).toBe("logs");
    expect(u.searchParams.get("query")).toMatch(/^k8s\.cluster\.name:"orbstack" k8s\.namespace\.name:"landlens-dev" k8s\.deployment\.name:"ledger-worker"( k8s\.container\.name:"worker")? \(level:error OR level:fatal OR level:critical\)$/);
  });

  it("lists the service's traces and one trace's spans, failures marked (D118)", async () => {
    await drawer().getByRole("tab", { name: "Traces" }).click();
    const list = drawer().getByRole("list", { name: "Traces" });
    await list.getByText("POST /ledger/close").waitFor({ timeout: 20_000 });
    expect(await list.getByRole("button").count()).toBe(2);
    expect(ck.searches.at(-1)).toMatchObject({ signal: "traces", query: `service:"ledger-worker"` });
    await both(page, "w7p3-04-traces");
    await list.getByText("POST /ledger/close").click();
    const spans = drawer().getByRole("list", { name: "Spans" });
    await spans.getByText("SELECT ledger_entries").waitFor({ timeout: 10_000 });
    expect(await spans.locator(".tr-span").count()).toBe(3);
    expect(await spans.locator(".tr-span.bad").innerText()).toContain("POST shards.parse");
    await both(page, "w7p3-05-trace-spans");
    await drawer().getByRole("button", { name: "All traces" }).click();
    await drawer().getByRole("button", { name: "Errors" }).click();
    await drawer().getByText(/No failed traces from/).or(list.getByText("POST /ledger/close")).first().waitFor();
    // The old list can still be on screen when the wait above passes: wait for the search itself.
    await expect.poll(() => ck.searches.at(-1)!.query, { timeout: 10_000 }).toBe(`service:"ledger-worker" status:error`);
  });

  it("a pod's History reads that pod only; ⌘K's Tab on it offers Open in Clickland", async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    const row = page.locator(".tr", { hasText: running[0]! }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await drawer().getByRole("tab", { name: "Logs" }).click();
    await drawer().getByRole("radio", { name: "History" }).click();
    await lines().getByText("FATAL: cannot parse LEDGER_SHARDS").waitFor({ timeout: 20_000 });
    expect(await lines().locator(".ll").count()).toBe(3);
    expect(ck.searches.at(-1)!.query).toContain(`k8s.pod.name:"${running[0]}"`);
    await both(page, "w7p3-06-history-pod");
    await page.keyboard.press("Escape");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    await page.keyboard.type(running[0]!);
    await page.getByRole("option", { name: new RegExp(running[0]!) }).first().waitFor();
    await page.keyboard.press("Tab");
    await page.getByRole("option", { name: /Open in Clickland/ }).waitFor();
    await both(page, "w7p3-07-palette-open-in-clickland");
    const before = (await g()).opened.length;
    await page.getByRole("option", { name: /Open in Clickland/ }).click();
    await expect.poll(async () => (await g()).opened.length).toBe(before + 1);
    expect(new URL((await g()).opened.at(-1)!).searchParams.get("query")).toContain(`k8s.pod.name:"${running[0]}"`);
  });
});

describe.runIf(live)("Clickland's history in the IDE, against a real Clickland (reads only)", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  const URL_ = process.env.LANDLENS_CLICKLAND_URL ?? "http://127.0.0.1:4730";
  const KEY = process.env.LANDLENS_CLICKLAND_KEY ?? "ck_dev_bootstrap_key_000000000000000";

  beforeAll(async () => {
    ({ app, page } = await launch(mkdtempSync(join(tmpdir(), "landlens-e2e-clickland-live-"))));
  }, 180_000);
  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it("shows ledger-worker's real crash line from Clickland's history", async () => {
    const { card, dialog } = await connectClickland(page, URL_, KEY);
    await dialog.getByRole("button", { name: "Save" }).click();
    await card.getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    await openDeployment(page, "ledger-worker");
    const drawer = page.locator(".drawer");
    await drawer.getByRole("tab", { name: "Logs" }).click();
    await drawer.getByRole("radio", { name: "History" }).click();
    await drawer.getByRole("button", { name: "Errors" }).click();
    const lines = drawer.getByRole("log", { name: "Clickland log lines" });
    await lines.getByText(/cannot parse LEDGER_SHARDS/).first().waitFor({ timeout: 30_000 });
    await both(page, "w7p3-08-live-history");
    await drawer.getByRole("tab", { name: "Traces" }).click();
    await drawer.getByText(/No traces from|No failed traces from/).or(drawer.getByRole("list", { name: "Traces" })).first().waitFor({ timeout: 20_000 });
  });
});
