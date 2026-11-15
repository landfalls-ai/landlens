// The Land family on the Connections page (wave 7 part 1) in the built app, against the loopback fakes of Clickland,
// Landflow and Landfall (packages/connections/test/fake-family.ts): no request reaches a real sibling. Connects
// Clickland's read key through its settings dialog, Landflow by a pasted key with its triage webhook, and Landfall in
// the (played) browser; checks that family:list and the profile folder carry no secret in the clear, and that the fake
// Landfall was never asked for a trigger. Then the cards in the workspace at the narrowest window.
// LANDLENS_INTEGRATION=orbstack npx vitest run test/family.e2e.test.ts  (screenshots to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CK_READ, FakeClickland, FakeLandfall, FakeLandflow, LF_KEY, TRIAGE_SECRET } from "../../../packages/connections/test/fake-family";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack");
const shots = process.env.LANDLENS_SHOTS;
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

describe.runIf(run)("the Land family against the fake siblings", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let clickland: FakeClickland;
  let landflow: FakeLandflow;
  let landfall: FakeLandfall;
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-family-"));

  beforeAll(async () => {
    clickland = await new FakeClickland().start();
    landflow = await new FakeLandflow().start();
    landfall = await new FakeLandfall().start();
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData },
    });
    // The person's browser, played in main: only loopback addresses are fetched (the fake's authorize page, then its
    // redirect to Landlens's one-shot listener).
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { opened: string[] };
      g.opened = [];
      (shell as unknown as { openExternal: (u: string) => Promise<void> }).openExternal = async (url: string) => {
        g.opened.push(url);
        if (!url.startsWith("http://127.0.0.1:")) return;
        const r = await fetch(url, { redirect: "manual" });
        const back = r.headers.get("location");
        if (back?.startsWith("http://127.0.0.1:")) await fetch(back);
      };
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    page.on("dialog", (d) => void d.accept());
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([clickland?.stop(), landflow?.stop(), landfall?.stop()]);
  }, 60_000);

  const card = (name: string) => page.getByRole("region", { name: `${name} connection` });
  const opened = () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);

  it("shows the Land family under Google Cloud, every sibling off", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: /^Connections/ }).click();
    const fam = page.getByRole("region", { name: "Land family" });
    await fam.getByRole("heading", { name: "Land family" }).waitFor();
    for (const n of ["Clickland", "Landflow", "Landfall"]) await card(n).getByText("Off", { exact: true }).waitFor();
    // Under Google Cloud, in that order.
    const order = await page.locator(".conn-card h3").allInnerTexts();
    expect(order.slice(order.indexOf("Google Cloud"))).toEqual(["Google Cloud", "Clickland", "Landflow", "Landfall"]);
    await card("Landfall").scrollIntoViewIfNeeded();
    await both(page, "w7-01-family-off");
  });

  it("connects Clickland's read key in its settings dialog, and says who it is", async () => {
    await card("Clickland").getByRole("button", { name: "Connect…" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Clickland" });
    await dialog.getByLabel("Clickland address").fill(clickland.origin);
    await dialog.getByLabel("Clickland API key").fill(CK_READ);
    // No cluster yet: the per-context name isn't asked for.
    await expect(dialog.getByLabel("Cluster name in Clickland").count()).resolves.toBe(0);
    await dialog.getByRole("button", { name: "Save" }).click();
    await card("Clickland").getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    await card("Clickland").getByText("landlens-graphs").waitFor({ timeout: 20_000 });
    await expect(card("Clickland").innerText()).resolves.toContain("role viewer");
    await card("Clickland").getByRole("button", { name: "Check" }).click();
    await card("Clickland").getByRole("list", { name: "Clickland check" }).getByText("who-am-I").waitFor();
  });

  it("refuses a Landflow address over plain http to a name, then connects a pasted key", async () => {
    const lf = card("Landflow");
    await lf.getByLabel("Landflow address").fill("http://landflow-host.landflow-dev.svc.cluster.local:3000");
    await lf.getByLabel("Landflow API key").fill("lf_mcp_" + "x".repeat(40));
    await lf.getByText("That isn't shaped like a Landflow API key").waitFor();
    await lf.getByLabel("Landflow API key").fill(LF_KEY);
    await lf.getByRole("button", { name: "Connect", exact: true }).click();
    await lf.getByText("Use https, or plain http only to this machine").waitFor();
    expect(landflow.requests).toEqual([]);
    await lf.getByLabel("Landflow address").fill(landflow.origin);
    await lf.getByLabel("Landflow API key").fill(LF_KEY);
    await lf.getByRole("button", { name: "Connect", exact: true }).click();
    await lf.getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    const text = await lf.innerText();
    expect(text).toContain("Signed in as Fable Person");
    expect(text).toContain("Can record your work");
    expect(text).toContain("Can list and run");
  });

  it("sets up the triage webhook: the secret is stored, never shown", async () => {
    const lf = card("Landflow");
    await lf.getByRole("button", { name: "Set up" }).click();
    const form = lf.getByRole("form", { name: "Triage webhook" });
    await form.getByLabel("Webhook header name").fill("Authorization");
    await form.getByText("not Authorization").waitFor();
    await form.getByLabel("Webhook header name").fill("X-Webhook-Secret");
    await form.getByLabel("Webhook secret").fill(TRIAGE_SECRET);
    await both(page, "w7-02-triage-form");
    await form.getByRole("button", { name: "Save" }).click();
    await lf.getByText("Secret stored").waitFor();
    expect(await lf.innerText()).not.toContain(TRIAGE_SECRET);
  });

  it("signs in to Landfall in the (played) browser, for mcp:read, opening only the fake's page", async () => {
    const lf = card("Landfall");
    await lf.getByLabel("Landfall address").fill(landfall.origin);
    await lf.getByRole("button", { name: "Sign in", exact: true }).click();
    await lf.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    const all = await opened();
    expect(all).toHaveLength(1);
    expect(all[0]!.startsWith(`${landfall.origin}/mcp/authorize?`)).toBe(true);
    expect(new URL(all[0]!).searchParams.get("scope")).toBe("mcp:read");
    await expect(lf.innerText()).resolves.toContain("War rooms open through Landflow's triage flow. Landlens never opens one itself.");
    expect(landfall.forbidden).toEqual([]);
    await card("Clickland").scrollIntoViewIfNeeded();
    await both(page, "w7-03-family-ready");
    await card("Landfall").scrollIntoViewIfNeeded();
    await both(page, "w7-04-family-ready-lower");
  });

  it("family:list and the profile folder carry no secret in the clear", async () => {
    const listed = JSON.stringify(await page.evaluate(() => (globalThis as any).landlens.invoke("family:list", {})));
    const tokens = [...landfall.valid.keys()];
    expect(tokens.length).toBeGreaterThan(0);
    for (const s of [CK_READ, LF_KEY, TRIAGE_SECRET, ...tokens]) {
      expect(listed).not.toContain(s);
      // grep -r exits 1 when nothing matches.
      expect(() => execFileSync("/usr/bin/grep", ["-rlF", s, userData], { encoding: "utf8" })).toThrow();
    }
    expect(landflow.carrying(LF_KEY).every((r) => r.path === "/api/auth/me")).toBe(true);
    expect(clickland.carrying(CK_READ).every((r) => r.path === "/api/auth/me")).toBe(true);
  });

  it("in the workspace at the narrowest window, the cards keep one line per use", async () => {
    await page.getByRole("button", { name: "Clusters" }).click();
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await card("Landflow").getByText("Ready", { exact: true }).waitFor();
    await page.setViewportSize({ width: 1024, height: 700 });
    await card("Landflow").scrollIntoViewIfNeeded();
    await both(page, "w7-05-family-1024");
    // Each use's state sits on the row's line: never under the label and wrapped to a second line of its own.
    const rows = card("Landflow").locator(".fam-row");
    for (let i = 0; i < (await rows.count()); i++) {
      const [label, state] = await Promise.all([rows.nth(i).locator(".fam-label").boundingBox(), rows.nth(i).locator(".fam-state").boundingBox()]);
      expect(Math.abs(label!.y - state!.y)).toBeLessThan(12);
    }
    await page.setViewportSize({ width: 1440, height: 880 });
  });

  it("signs out of Landfall, revoking both tokens", async () => {
    await card("Landfall").scrollIntoViewIfNeeded();
    await card("Landfall").getByRole("button", { name: "Sign out" }).click();
    await card("Landfall").getByText("Off", { exact: true }).waitFor({ timeout: 20_000 });
    expect(landfall.revoked).toHaveLength(2);
  });
});
