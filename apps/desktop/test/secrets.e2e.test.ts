// Secret values for the person only (wave 8 part 4, D161–D168) in the built app against OrbStack. The test makes its
// own throwaway Secrets in landlens-dev and removes them: hands-reveal-e2e (Opaque: username, a marker value LLMARK-…
// made per run, a bidi override, 16 random bytes) and hands-reveal-tls (a self-signed pair made with openssl in a 0700
// temp folder that is removed at once). Main's own dialog is stubbed as gke.e2e stubs it, recording what it asked.
//
// What it proves: before a reveal the page and resource:get carry no value; the unlock dialog names the Secret and the
// cluster; Reveal shows one key, which can't be selected or dragged out, and goes on Hide, after 30 s (the page's
// clock), on a lost focus and on a tab change; Copy puts the value on the clipboard from main with macOS's concealed
// marker, the window never has it, and main clears it after 30 s; a prompt holding the copied value is refused; the
// fake agent's every prompt and attachment, mcp:calls, localStorage and sessionStorage, and every file in the profile
// (agent session folders included) lack the marker; the certificate panel shows the CN, expiry and issuer with no
// private key text. Screenshots are taken only while nothing is revealed (w8p4-*, dark and light, $LANDLENS_SHOTS).
// LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/secrets.e2e.test.ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseNamespace } from "./e2e-helpers";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
const OPAQUE = "hands-reveal-e2e";
const TLS = "hands-reveal-tls";
const MARK = `LLMARK-${randomBytes(24).toString("hex")}`.slice(0, 40);
const B64 = Buffer.from(MARK).toString("base64");
const CONCEALED = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';

describe.runIf(run)("Secret values and certificates on OrbStack", () => {
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  /** tls.key's base64, in 40-character runs: none may reach the page, a file or a prompt. */
  let keyRuns: string[] = [];
  let savedClipboard = "";
  /** A second connection of orbstack, made by the test before the window's own, for resource:get. */
  let handle = "";
  const asked = () => app.evaluate(() => (globalThis as unknown as { asked: { message: string; detail: string }[] }).asked);
  const drawer = () => page.locator(".drawer");
  const data = () => drawer().getByRole("region", { name: "Data" });
  const value = () => drawer().locator("pre.secret-value");
  const dock = () => page.getByRole("complementary", { name: "Claude Code" });
  const clipboardHolds = (text: string) => app.evaluate(async ({ clipboard }, t) => (await clipboard.readText()) === t, text);
  const shot = async (name: string, dummy = false) => {
    if (!shots) return;
    // Never with the marker on screen; a value only when it is the dummy username.
    if (!dummy) expect(await value().count()).toBe(0);
    expect(await page.content()).not.toContain(MARK);
    mkdirSync(shots, { recursive: true });
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(shots, `w8p4-${name}-${colorScheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "dark" });
  };
  const openSecret = async (name: string) => {
    if (await dock().count()) (await page.keyboard.press("Meta+j"), await dock().waitFor({ state: "detached" }));
    await page.getByRole("button", { name: "Secrets", exact: true }).click();
    await page.getByRole("heading", { name: "Secrets" }).waitFor();
    await page.getByRole("searchbox", { name: "Filter by name" }).fill(name);
    const row = page.locator(".tr", { hasText: name }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await drawer().getByRole("heading", { name }).waitFor();
  };

  beforeAll(async () => {
    kubectl("delete", "secret", OPAQUE, TLS, "--ignore-not-found");
    const dir = mkdtempSync(join(tmpdir(), "landlens-secrets-e2e-"));
    try {
      const blob = join(dir, "blob");
      writeFileSync(blob, randomBytes(16), { mode: 0o600 });
      kubectl("create", "secret", "generic", OPAQUE, "--from-literal=username=hands", `--from-literal=password=${MARK}`, "--from-literal=bidi=abc‮def", `--from-file=blob=${blob}`);
      const crt = join(dir, "tls.crt");
      const key = join(dir, "tls.key");
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", crt,
        "-subj", "/CN=hands-reveal.landlens.dev", "-addext", "subjectAltName=DNS:hands-reveal.landlens.dev", "-days", "90"], { stdio: "ignore" });
      kubectl("create", "secret", "tls", TLS, `--cert=${crt}`, `--key=${key}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const k = kubectl("get", "secret", TLS, "-o", "jsonpath={.data.tls\\.key}");
    keyRuns = Array.from({ length: Math.floor(k.length / 40) }, (_, i) => k.slice(i * 40, i * 40 + 40));
    userData = mkdtempSync(join(tmpdir(), "landlens-e2e-secrets-"));
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData, LANDLENS_ACP_AGENT: resolve(__dirname, "fixtures/fake-acp-agent.mjs") },
    });
    // Main's own dialog is answered here, never by the window: each question kept; yes unless a test says no.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { asked: { message: string; detail: string }[]; yes: boolean };
      g.asked = [];
      g.yes = true;
      (dialog as unknown as { showMessageBox: (...a: unknown[]) => Promise<unknown> }).showMessageBox = async (...a: unknown[]) => {
        const q = a.at(-1) as { message: string; detail: string };
        g.asked.push({ message: q.message, detail: q.detail });
        return { response: g.yes ? 0 : 1, checkboxChecked: false };
      };
    });
    savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.getByRole("button", { name: /orbstack/ }).first().waitFor({ timeout: 30_000 });
    handle = await page.evaluate(() => (globalThis as any).landlens.invoke("cluster:connect", { context: "orbstack" }).then((i: { handle: string }) => i.handle));
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Secrets", exact: true }).click();
    await chooseNamespace(page, "landlens-dev");
  }, 180_000);

  afterAll(async () => {
    if (app) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard).catch(() => {});
    await app?.close();
    if (run) kubectl("delete", "secret", OPAQUE, TLS, "--ignore-not-found", "--wait=false");
  }, 60_000);

  it("before a reveal: keys and sizes only; neither the page nor resource:get has a value; no Ask Claude", async () => {
    await openSecret(OPAQUE);
    await data().waitFor();
    const text = await data().innerText();
    for (const k of ["blob", "bidi", "password", "username"]) expect(text).toContain(k);
    expect(text).toContain("40 B");
    expect(await page.content()).not.toContain(MARK);
    const got = await page.evaluate((h) => (globalThis as any).landlens.invoke("resource:get", { handle: h, ref: { group: "", version: "v1", resource: "secrets", namespace: "landlens-dev", name: "hands-reveal-e2e" } }), handle);
    expect(got.object.data.password).toBe("<40 bytes>");
    expect(JSON.stringify(got)).not.toContain(MARK);
    expect(JSON.stringify(got)).not.toContain(B64);
    expect(await drawer().getByRole("button", { name: "Ask Claude" }).count()).toBe(0);
    await drawer().getByRole("button", { name: "Look for certificates" }).waitFor();
    await shot("01-data-locked");
  }, 90_000);

  it("Reveal asks main's dialog naming the Secret and the cluster, then shows one key that can't be selected; Hide drops it", async () => {
    await data().getByRole("button", { name: "Reveal password" }).click();
    await value().waitFor({ timeout: 20_000 });
    const q = (await asked()).at(-1)!;
    expect(q.message).toBe(`Show values of Secret landlens-dev/${OPAQUE}?`);
    expect(q.detail).toBe("Values are shown to you only, for 30 seconds at a time. Claude never sees them. On orbstack.");
    expect(await value().textContent()).toBe(MARK);
    expect(await value().getAttribute("data-private")).toBe("");
    expect(await value().evaluate((el) => (globalThis as any).getComputedStyle(el).userSelect)).toBe("none");
    // Nothing kept where DevTools would show it across a reload.
    const stores = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stores).not.toContain(MARK);
    await data().getByRole("status", { name: /^Unlocked for/ }).waitFor();
    await data().getByRole("button", { name: "Hide password" }).click();
    await value().waitFor({ state: "detached" });
    expect(await page.content()).not.toContain(MARK);
    await shot("02-unlocked");
  }, 60_000);

  it("a bidi override is drawn as its escape; a binary key shows only its size", async () => {
    await data().getByRole("button", { name: "Reveal bidi" }).click();
    await value().waitFor();
    expect(await value().textContent()).toBe("abc\\u{202E}def");
    // Revealing another hides the first: one value at a time.
    await data().getByRole("button", { name: "Reveal blob" }).click();
    await data().getByText(/^Not text \(16 B\)/).waitFor();
    expect(await value().count()).toBe(0);
    await data().getByRole("button", { name: "Hide blob" }).click();
    // One screenshot with a value on screen: the dummy username ("hands"), never the marker.
    await data().getByRole("button", { name: "Reveal username" }).click();
    await value().waitFor();
    expect(await value().textContent()).toBe("hands");
    await shot("02b-revealed-dummy", true);
    await data().getByRole("button", { name: "Hide username" }).click();
    await value().waitFor({ state: "detached" });
  }, 60_000);

  it("hides after 30 s by the page's clock, on a lost focus and on a tab change", async () => {
    await page.clock.install();
    await data().getByRole("button", { name: "Reveal password" }).click();
    await value().waitFor();
    await page.clock.fastForward(31_000);
    await value().waitFor({ state: "detached", timeout: 5_000 });
    expect(await page.content()).not.toContain(MARK);

    await data().getByRole("button", { name: "Reveal password" }).click();
    await value().waitFor();
    await page.evaluate(() => (globalThis as any).dispatchEvent(new Event("blur")));
    await value().waitFor({ state: "detached", timeout: 5_000 });

    await data().getByRole("button", { name: "Reveal password" }).click();
    await value().waitFor();
    await drawer().getByRole("tab", { name: "YAML" }).click();
    expect(await page.content()).not.toContain(MARK);
    expect(await drawer().innerText()).toContain("••••••");
    await drawer().getByRole("tab", { name: "Overview" }).click();
    expect(await value().count()).toBe(0);
  }, 90_000);

  it("Copy writes to the clipboard from main with the concealed marker; a prompt holding it is refused; main clears it after 30 s", async () => {
    await data().getByRole("button", { name: "Copy password" }).click();
    await data().getByRole("status").filter({ hasText: /^Copied\. Clears in \d+ s$/ }).waitFor({ timeout: 10_000 });
    expect(await clipboardHolds(MARK)).toBe(true);
    if (process.platform === "darwin") expect(await app.evaluate(({ clipboard }, f) => clipboard.has(f), CONCEALED)).toBe(true);
    expect(await page.content()).not.toContain(MARK);
    await shot("03-copied");

    // The dock: a message holding the value (as a paste would) is refused in main, and nothing reaches the agent.
    await page.keyboard.press("Meta+j");
    const box = dock().getByRole("combobox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled({ timeout: 2_000 }).catch(() => false), { timeout: 90_000 }).toBe(true);
    await box.fill(`is this right? ${MARK}`);
    await box.press("Enter");
    await dock().getByText("That is a Secret value Landlens copied for you: it isn't sent to Claude.").waitFor({ timeout: 20_000 });
    await box.fill("What is in landlens-dev?");
    await box.press("Enter");
    await dock().locator(".msg-agent", { hasText: "Everything I was asked about looks fine." }).last().waitFor({ timeout: 60_000 });
    await page.keyboard.press("Meta+j");
    await dock().waitFor({ state: "detached" });

    await expect.poll(() => clipboardHolds(""), { timeout: 40_000, interval: 1_000 }).toBe(true);
  }, 180_000);

  it("the certificate panel: CN, expiry and issuer; no private key text on the page", async () => {
    await openSecret(TLS);
    const certs = drawer().getByRole("region", { name: "Certificates" });
    await certs.getByText("hands-reveal.landlens.dev").first().waitFor({ timeout: 20_000 });
    const text = await certs.innerText();
    expect(text).toMatch(/expires in (89|90) days/);
    expect(text).toContain("self-signed");
    expect(text).toMatch(/Issuer\s+hands-reveal\.landlens\.dev/);
    expect(text).toMatch(/Key\s+EC prime256v1|Key\s+EC P-256/);
    const html = await page.content();
    expect(html).not.toMatch(/PRIVATE KEY/);
    for (const r of keyRuns) expect(html).not.toContain(r);
    await drawer().getByRole("tab", { name: "YAML" }).click();
    for (const r of keyRuns) expect(await page.content()).not.toContain(r);
    await drawer().getByRole("tab", { name: "Overview" }).click();
    await certs.waitFor();
    await shot("04-certificates");
  }, 90_000);

  it("Lock now ends the unlock: the next Reveal asks again", async () => {
    await openSecret(OPAQUE);
    const before = (await asked()).length;
    // Still unlocked from before (5 minutes): the chip, then Lock now.
    await data().getByRole("status", { name: /^Unlocked for/ }).getByRole("button", { name: "Lock now" }).click();
    await app.evaluate(() => void ((globalThis as unknown as { yes: boolean }).yes = false));
    await data().getByRole("button", { name: "Reveal password" }).click();
    await expect.poll(async () => (await asked()).length).toBe(before + 1);
    expect(await value().count()).toBe(0);
    expect(await page.content()).not.toContain(MARK);
  }, 60_000);

  it("the agent's prompts and attachments, mcp:calls and every file in the profile lack the marker and tls.key", async () => {
    const calls = JSON.stringify(await page.evaluate(() => (globalThis as any).landlens.invoke("mcp:calls", {})));
    expect(calls).not.toContain(MARK);
    // The fake agent wrote every prompt it got into its session folder, inside the profile.
    const prompts = readFileSync(join(userData, "agent-sessions", "fake-agent-prompts.jsonl"), "utf8");
    expect(prompts).toContain("What is in landlens-dev?");
    expect(prompts).not.toContain("is this right?");
    for (const needle of [MARK, B64, ...keyRuns]) {
      expect(() => execFileSync("/usr/bin/grep", ["-rlF", needle, userData], { encoding: "utf8" }), needle.slice(0, 6)).toThrow();
    }
  }, 60_000);
});
