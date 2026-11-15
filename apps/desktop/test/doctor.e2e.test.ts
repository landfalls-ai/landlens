// The Problems page (wave 5, part 3; D57–D61) in the built app against OrbStack: deploy/scenarios/doctor's broken
// workloads and TLS Secrets in landlens-dev, each listed under the right section with its facts, the Logs tab's
// evidence, ⌘K's problems and the status bar's count. `up.mjs` starts the scenarios (landlens-dev only) if they aren't
// up; the test itself writes nothing to the cluster.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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
const UP = resolve(__dirname, "../../../deploy/scenarios/doctor/up.mjs");

// Up for over 15 minutes, pending pods are failing too; on a fresh start they are to watch, so only names are checked
// for those. Readiness is failing because cart-api has none available.
const FAILING = ["orders-api", "ledger-worker", "cart-api", "search-indexer", "reports", "shop-tls-expired"];
const WATCH = ["invoice-archive", "shop-tls"];
const ANY = ["gpu-trainer", "thumbnailer", "invoice-renderer"];
/** A title starts with its subject's name, then a space, a colon or an apostrophe ("shop-tls" isn't "shop-tls-expired"). */
const titled = (name: string) => new RegExp(`^${name.replace(/[-.]/g, "\\$&")}(?=[\\s:'])`);

describe.runIf(run)("the Problems page on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  const sidebar = () => page.getByRole("complementary", { name: "Resources" });
  const section = (name: "Failing" | "To watch") => page.getByRole("region", { name });
  const row = (name: string) => page.locator(".pb-row", { has: page.locator(".pb-title", { hasText: titled(name) }) });
  const drawer = () => page.locator(".pb-drawer");

  beforeAll(async () => {
    await promisify(execFile)("node", [UP]);
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

  it("lists every scenario under its section, grouped, with no skipped checks", async () => {
    await sidebar().getByRole("button", { name: "Problems", exact: true }).click();
    await page.getByRole("heading", { name: "Problems" }).waitFor();
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
    // Pending and not-ready wait 2 minutes before they count: a fresh start can take up to 4.
    await expect.poll(async () => {
      const names = await page.locator(".pb-row .pb-title").allInnerTexts();
      return [...FAILING, ...WATCH, ...ANY].filter((n) => !names.some((t) => titled(n).test(t)));
    }, { timeout: 240_000, interval: 3000 }).toEqual([]);
    for (const n of FAILING) expect(await section("Failing").locator(".pb-title", { hasText: titled(n) }).count(), n).toBeGreaterThan(0);
    for (const n of WATCH) expect(await section("To watch").locator(".pb-title", { hasText: titled(n) }).count(), n).toBeGreaterThan(0);
    // Five crash-looping replicas are one row.
    await expect.poll(() => row("ledger-worker").count()).toBe(1);
    expect(await row("ledger-worker").innerText()).toMatch(/5 pods/);
    // Every check could be made, so no strip says otherwise (certificates may still be reading on the first ask).
    await expect.poll(() => page.locator(".pb-checks").count(), { timeout: 30_000 }).toBe(0);
    await shot(page, "w5-30-problems");
    await shot(page, "w5-31-problems-light", "light");
  }, 300_000);

  it("filters by severity and kind", async () => {
    await page.getByRole("group", { name: "Severity" }).getByRole("button", { name: /To watch/ }).click();
    await expect.poll(() => section("Failing").count()).toBe(0);
    await page.getByRole("group", { name: "Severity" }).getByRole("button", { name: /^All/ }).click();
    const crash = page.getByRole("group", { name: "Kind of problem" }).getByRole("button", { name: /Crash loops/ });
    await crash.click();
    await expect.poll(() => crash.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(async () => {
      const titles = await page.locator(".pb-row .pb-title").allInnerTexts();
      return titles.length > 0 && titles.every((t) => /crash-looping/.test(t));
    }).toBe(true);
    await crash.click();
    await expect.poll(() => crash.getAttribute("aria-pressed")).toBe("false");
    await expect.poll(() => row("cart-api").count()).toBe(1);
  }, 60_000);

  it("shows each problem's facts in its drawer", async () => {
    const facts: [string, RegExp][] = [
      ["ledger-worker", /exit 2/],
      ["cart-api", /8081/],
      ["gpu-trainer", /Node selector\s*landlens\.dev\/pool=gpu-a100/],
      ["thumbnailer", /24Mi/],
      ["shop-tls-expired", /Not after\s*\d{4}-\d\d-\d\d/],
    ];
    for (const [name, want] of facts) {
      await row(name).first().click();
      await drawer().waitFor();
      await expect.poll(() => drawer().innerText(), { message: name }).toMatch(want);
      expect(await drawer().innerText()).toMatch(/Likely cause[\s\S]*From Landlens's rules, not from Claude/);
    }
    await row("shop-tls-expired").first().click();
    await shot(page, "w5-32-problem-cert");
    // The certificate's facts only: nothing of a key or PEM reached the window.
    expect(await page.content()).not.toMatch(/BEGIN|PRIVATE KEY/);
  }, 60_000);

  it("shows the crash's own words in the Logs tab", async () => {
    await row("ledger-worker").first().click();
    await drawer().getByRole("tab", { name: "Logs" }).click();
    await expect.poll(() => drawer().locator(".logs").innerText(), { timeout: 20_000 }).toMatch(/LEDGER_SHARDS/);
    expect(await drawer().locator(".logs-note").innerText()).toMatch(/previous run/i);
    await shot(page, "w5-33-problem-logs");
    await drawer().getByRole("tab", { name: "Events" }).click();
    await expect.poll(() => drawer().innerText()).toMatch(/BackOff/);
    await page.keyboard.press("Escape");
    await expect.poll(() => drawer().count()).toBe(0);
  }, 60_000);

  it("finds a problem with ⌘K's problems word and opens its drawer", async () => {
    await page.keyboard.press("Meta+K");
    await page.keyboard.type("problems cart");
    const results = page.getByRole("listbox", { name: "Results" });
    await expect.poll(() => results.innerText()).toMatch(/cart-api/);
    await page.keyboard.press("Enter");
    await drawer().waitFor();
    await expect.poll(() => drawer().innerText()).toMatch(/cart-api[\s\S]*readiness/);
    await page.keyboard.press("Escape");
  }, 60_000);

  it("opens the page from the status bar's count, preset to that severity", async () => {
    await sidebar().getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByRole("button", { name: /failing, open Problems/ }).click();
    await page.getByRole("heading", { name: "Problems" }).waitFor();
    await expect.poll(() => page.getByRole("group", { name: "Severity" }).getByRole("button", { name: /Failing/ }).getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => section("To watch").count()).toBe(0);
  }, 60_000);
});
