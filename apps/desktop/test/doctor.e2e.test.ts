// The Problems page (wave 5, part 3; D57–D61) in the built app against OrbStack: deploy/scenarios/doctor's broken
// workloads and TLS Secrets in landlens-dev, each listed under the right section with its facts, the Logs tab's
// evidence, ⌘K's problems and the status bar's count. `beforeAll` runs `up.mjs`, which applies the scenarios in
// landlens-dev only (idempotent); the tests themselves write nothing.
// With `claude` too (LANDLENS_INTEGRATION=orbstack,claude), "Ask Claude" on each scenario runs the person's own Claude
// Code (D65): the answer must name the scenario's planted token and its subject; nothing is retried or worded.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e  (screenshots go to $LANDLENS_SHOTS)
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
const claude = flags.includes("claude");
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
/** D69's table: what only the evidence says, which a sensible answer names. */
const TOKENS: [string, RegExp[]][] = [
  ["orders-api", [/DATABASE_URL/]],
  ["ledger-worker", [/LEDGER_SHARDS/]],
  ["gpu-trainer", [/gpu-a100|node ?selector/i]],
  ["thumbnailer", [/OOM|out of memory|memory limit/i, /24\s?Mi/]],
  ["cart-api", [/8081/]],
  ["search-indexer", [/\/tmp\/alive|liveness/i]],
  ["reports", [/registry\.invalid/]],
  ["invoice-renderer", [/invoice-templates/]],
  ["invoice-archive", [/landlens-missing|storage ?class/i]],
  ["shop-tls-expired", [/expir/i]],
];
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
    // Another scope's report doesn't hold this id: changing the namespace closes the drawer.
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("");
    await expect.poll(() => drawer().count()).toBe(0);
    await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
  }, 60_000);

  it("opens the page from the status bar's count, preset to that severity", async () => {
    await sidebar().getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByRole("button", { name: /failing, open Problems/ }).click();
    await page.getByRole("heading", { name: "Problems" }).waitFor();
    await expect.poll(() => page.getByRole("group", { name: "Severity" }).getByRole("button", { name: /Failing/ }).getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => section("To watch").count()).toBe(0);
  }, 60_000);
  describe.runIf(claude)("Ask Claude on each scenario (D65)", () => {
    const dock = () => page.getByRole("complementary", { name: "Claude Code" });
    const box = () => dock().getByRole("combobox", { name: "Message Claude Code" });
    const stop = () => dock().getByRole("button", { name: "Stop", exact: true });
    const ready = () => expect.poll(() => box().isEnabled({ timeout: 2_000 }).catch(() => false), { timeout: 90_000 }).toBe(true);
    /**
     * Wait for the turn to end (4 minutes), allowing any question once. `onChange` sees each waiting change card;
     * without it a proposed change is rejected (the doctor's question asks for one proposed change; nothing applies).
     */
    const finish = async (onChange: (card: ReturnType<Page["locator"]>) => Promise<void> = async (card) => {
      const reject = card.getByRole("button", { name: "Reject", exact: true });
      if (await reject.count()) await reject.click();
    }) => {
      await stop().waitFor({ timeout: 60_000 }).catch(() => {}); // a short turn can end before it is seen
      const deadline = Date.now() + 240_000;
      while (await stop().count()) {
        if (Date.now() > deadline) throw new Error(`the agent did not finish in 4 minutes; the dock says:\n${await dock().innerText()}`);
        const card = dock().locator("section.change").first();
        if (await card.count()) await onChange(card);
        const ask = dock().locator(".ask button.primary").first();
        if (await ask.count()) await ask.click();
        await page.waitForTimeout(500);
      }
    };
    /** A new session, then Ask Claude on the scenario's row: the brief goes as quoted data with the doctor's question. */
    const ask = async (name: string) => {
      if (await dock().count()) {
        await dock().getByRole("button", { name: "New session" }).click();
        // A change still waiting makes the dock ask first; stopping withdraws it (nothing was applied).
        const confirm = dock().getByRole("button", { name: "Stop and open" });
        if (await confirm.waitFor({ timeout: 2_000 }).then(() => true, () => false)) await confirm.click();
        await ready();
      }
      await row(name).first().getByRole("button", { name: `Ask Claude about ${name}` }).click();
      await ready();
    };
    const answer = async () => (await dock().locator(".msg-agent").allTextContents()).join("\n");
    /**
     * A failed card is a bug, unless it's the fence: Landlens refusing a Secret, or kubectl in the agent's own shell,
     * which has no kubeconfig (the cluster is reached only through Landlens's tools). A previous run's log can also be
     * briefly missing while a container restarts every few seconds (thumbnailer's OOM loop): the API's answer, not ours.
     */
    const failedCards = async () =>
      (await dock().locator(".tool-failed").evaluateAll((els) => els.map((e) => (e as unknown as { innerText: string }).innerText))).filter((t) => !/\bsecrets?\b/i.test(t) && !/^shell\s+kubectl\b/.test(t) && !/^get logs\s+\S+ · previous$/.test(t));

    beforeAll(async () => {
      await sidebar().getByRole("button", { name: "Problems", exact: true }).click();
      await page.getByRole("heading", { name: "Problems" }).waitFor();
      await page.getByRole("combobox", { name: "Namespace" }).selectOption("landlens-dev");
      await page.getByRole("group", { name: "Severity" }).getByRole("button", { name: /^All/ }).click();
    });

    for (const [name, tokens] of TOKENS) {
      it(`names what breaks ${name}`, async () => {
        await expect.poll(() => row(name).count(), { timeout: 60_000 }).toBeGreaterThan(0);
        await ask(name);
        await finish();
        const text = await answer();
        await shot(page, `w5-40-ask-${name}`);
        for (const t of tokens) expect(text, `${name}: ${t}`).toMatch(t);
        // The subject, in the answer or in the change it proposed (the reply after a rejection may not repeat it).
        const changes = (await dock().locator("section.change, .change-done").allInnerTexts()).join("\n");
        expect(`${text}\n${changes}`).toContain(name.replace(/-expired$/, ""));
        expect(await failedCards()).toEqual([]);
      }, 330_000);
    }

    it("proposes the readiness fix as a change card, and a rejected change leaves cart-api as it was", async () => {
      const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
      const probe = () => kubectl("get", "deployment", "cart-api", "-o", "jsonpath={.spec.template.spec.containers[0].readinessProbe}");
      const before = probe();
      await ask("cart-api");
      await finish();
      await box().fill("Propose that fix now with the patch tool: exactly one change to cart-api, then stop.");
      await box().press("Enter");
      let seen = 0;
      await finish(async (card) => {
        if (seen++) return;
        await card.locator(".diff").first().waitFor();
        expect(await card.locator(".diff").first().innerText()).toContain("8080");
        await card.scrollIntoViewIfNeeded();
        await shot(page, "w5-41-ask-change-card");
        await card.getByRole("button", { name: "Reject", exact: true }).click();
      });
      expect(seen).toBeGreaterThanOrEqual(1);
      await dock().locator(".change-done.rejected").first().waitFor();
      expect(probe()).toBe(before);
    }, 600_000);
  });
});
