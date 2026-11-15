// Connections (wave 6 part 2) in the built app, against part 1's loopback fakes of GitHub and Linear: no request
// reaches github.com, api.githubcopilot.com or linear.app. The app's provider overrides point every provider origin
// at a fake, and shell.openExternal is replaced in main so a browser sign-in is played by a fetch to the fake (never
// the person's browser, and never a real address). Connects GitHub by the device flow and by a pasted token, Linear
// by the browser flow and by a pasted key; the MCP page lists both from Connections. With `claude`, one live session
// (your own Claude Code): a GitHub read runs without asking, a write shows the question, and the Calls tab has both;
// then (part 3) GitHub autonomous in the dock: a routine write in scope runs on its own, one out of scope asks with its
// reason, and a cluster write still waits on its change card (rejected, so nothing in the cluster changes).
// LANDLENS_INTEGRATION=orbstack[,claude] npx vitest run test/connections.e2e.test.ts  (screenshots to $LANDLENS_SHOTS)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider } from "../../../packages/connections/test/fake-provider";
import { GH_TOKEN, LIN_KEY } from "../../../packages/connections/test/helpers";

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
const both = async (page: Page, name: string) => {
  await shot(page, `${name}-dark`, "dark");
  await shot(page, `${name}-light`, "light");
  await page.emulateMedia({ colorScheme: "dark" });
};

describe.runIf(run)("Connections against the fake providers", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let github: FakeProvider;
  let linear: FakeProvider;
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-conn-"));

  beforeAll(async () => {
    github = await new FakeProvider("github", { device: ["authorization_pending", "token"] }).start();
    linear = await new FakeProvider("linear").start();
    github.valid.add(GH_TOKEN);
    linear.valid.add(LIN_KEY);
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: {
        ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData,
        LANDLENS_GITHUB_ENDPOINT: github.origin, LANDLENS_LINEAR_ENDPOINT: linear.origin, LANDLENS_GITHUB_CLIENT_ID: "Ov23liE2eTestClient01",
      },
    });
    // The person's browser, played in main: only loopback addresses are fetched (the fake's authorize page, then its
    // redirect to Landlens's one-shot listener); anything else (github.com/login/device) is only recorded.
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
    await github?.stop();
    await linear?.stop();
  }, 60_000);

  const card = (name: string) => page.getByRole("region", { name: `${name} connection` });
  const opened = () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);

  it("opens Connections from Welcome, with no cluster connected", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: /^Connections/ }).click();
    await page.getByRole("heading", { name: "Connections" }).waitFor();
    await card("GitHub").getByText("Not connected").waitFor();
    await card("Linear").getByText("Not connected").waitFor();
    await both(page, "c01-connections-empty");
  });

  it("connects GitHub with the device flow: the code, Copy and the one address, then ready", async () => {
    await card("GitHub").getByRole("button", { name: "Connect", exact: true }).click();
    const code = card("GitHub").getByLabel("Device code", { exact: true });
    await code.waitFor();
    expect(await code.innerText()).toBe("WDJB-MJHT");
    await both(page, "c02-github-device-code");
    await card("GitHub").getByRole("button", { name: "Open github.com/login/device" }).click();
    await card("GitHub").getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 });
    expect(await opened()).toEqual(["https://github.com/login/device"]);
    await expect(card("GitHub").innerText()).resolves.toContain("Signed in as octo-person");
    await expect(card("GitHub").innerText()).resolves.toContain("44 tools: 25 read, 19 write");
  });

  it("connects Linear in the (played) browser, opening only the fake's sign-in address", async () => {
    await card("Linear").getByRole("button", { name: "Connect", exact: true }).click();
    await card("Linear").getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 });
    const all = await opened();
    expect(all.at(-1)!.startsWith(`${linear.origin}/authorize?`)).toBe(true);
    await expect(card("Linear").innerText()).resolves.toContain("Signed in as lin@example.com");
    await card("GitHub").getByRole("button", { name: /^44 tools/ }).click();
    const tools = card("GitHub").getByRole("list", { name: "GitHub tools" });
    await tools.waitFor();
    await both(page, "c03-connected-tools");
    // Part 3: a write the autonomous mode may run on its own is marked Routine; a merge isn't.
    const row = (name: string) => tools.locator("li", { has: page.getByText(name, { exact: true }) });
    await row("issue_write").scrollIntoViewIfNeeded();
    await expect(row("issue_write").innerText()).resolves.toContain("Routine");
    await expect(row("merge_pull_request").innerText()).resolves.not.toContain("Routine");
    await both(page, "a3-00-routine-tools");
  });

  it("disconnects and connects again by a pasted token and key; conn:list never carries one", async () => {
    await card("GitHub").getByRole("button", { name: "Disconnect" }).click();
    await card("GitHub").getByText("Not connected").waitFor();
    await card("GitHub").getByRole("button", { name: "Use a token instead" }).click();
    await card("GitHub").getByLabel("GitHub token").fill("not-a-token");
    await card("GitHub").getByText("That isn't shaped like a GitHub token.").waitFor();
    await card("GitHub").getByLabel("GitHub token").fill(GH_TOKEN);
    await both(page, "c04-github-token");
    await card("GitHub").getByRole("button", { name: "Connect", exact: true }).click();
    await card("GitHub").getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 });
    await expect(card("GitHub").innerText()).resolves.toContain("pasted token");

    await card("Linear").getByRole("button", { name: "Disconnect" }).click();
    await card("Linear").getByText("Not connected").waitFor();
    expect(linear.revoked.length).toBe(2); // the access token, then the refresh token
    await card("Linear").getByRole("button", { name: "Use an API key instead" }).click();
    await card("Linear").getByLabel("Linear API key").fill(LIN_KEY);
    await card("Linear").getByRole("button", { name: "Connect", exact: true }).click();
    await card("Linear").getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 });

    const list = await page.evaluate(() => (globalThis as any).landlens.invoke("conn:list", {}));
    const text = JSON.stringify(list);
    expect(text).not.toContain(GH_TOKEN);
    expect(text).not.toContain(LIN_KEY);
    expect(text).not.toContain(github.deviceToken);
    const file = readFileSync(join(userData, "connections.json"), "utf8");
    expect(file).not.toContain(GH_TOKEN);
    expect(file).not.toContain(LIN_KEY);
    // The tokens went only to the fakes: GitHub's to /user and the MCP endpoints, Linear's to /graphql and MCP.
    expect(new Set(github.carrying(GH_TOKEN).map((r) => r.path))).toEqual(new Set(["/user", "/mcp/", "/mcp/readonly"]));
    expect(new Set(linear.carrying(LIN_KEY).map((r) => r.path))).toEqual(new Set(["/graphql", "/mcp", "/mcp/readonly"]));
  });

  it("sets the level and the switches", async () => {
    await card("Linear").getByRole("button", { name: "Read only" }).click();
    await expect.poll(() => card("Linear").getByRole("button", { name: "Read only" }).getAttribute("aria-pressed")).toBe("true");
    await card("Linear").getByRole("switch", { name: "Linear: reads run without asking" }).click();
    await expect.poll(() => card("Linear").getByRole("switch", { name: "Linear: reads run without asking" }).isChecked()).toBe(false);
    await both(page, "c05-linear-read-only");
    await card("Linear").getByRole("switch", { name: "Linear: reads run without asking" }).click();
    await card("Linear").getByRole("button", { name: "Ask for writes" }).click();
    await expect.poll(() => card("Linear").getByRole("button", { name: "Ask for writes" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lists both connections on the MCP page, from Connections, after landlens-kube", async () => {
    await page.getByRole("button", { name: "Clusters" }).click();
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await card("GitHub").getByText("Connected", { exact: true }).waitFor();
    await both(page, "c06-connections-in-workspace");
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    const gh = page.getByRole("region", { name: "MCP server github" });
    await gh.waitFor();
    const names = await page.locator(".mcp-server h3").allInnerTexts();
    expect(names.slice(0, 3)).toEqual(["landlens-kube", "github", "linear"]);
    await expect(gh.innerText()).resolves.toContain("From Connections");
    await expect(gh.getByRole("button", { name: /^(Edit|Remove) github$/ }).count()).resolves.toBe(0);
    await gh.getByRole("button", { name: "Manage in Connections" }).waitFor();
    // A read with no arguments previews as you; the page never runs a write.
    await gh.getByRole("button", { name: "Preview get_me" }).click();
    await gh.getByText("fake get_me").waitFor({ timeout: 15_000 });
    await gh.scrollIntoViewIfNeeded();
    await both(page, "c07-mcp-page-connections");
  });

  it.runIf(claude)("in a live session, a GitHub read runs without asking and a write shows the question", async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j");
    const dock = page.getByRole("complementary", { name: "Claude Code" });
    const box = dock.getByRole("combobox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled({ timeout: 2_000 }).catch(() => false), { timeout: 90_000 }).toBe(true);
    await box.fill(
      "This is a test of Landlens's GitHub connection. Do exactly two tool calls and nothing else: first call the github " +
        "MCP tool list_issues with owner landfalls-ai and repo landlens; then call the github MCP tool issue_write with " +
        'method "create", owner landfalls-ai, repo landlens, title "Landlens connection test". Then say done.',
    );
    await box.press("Enter");
    const ask = dock.getByRole("region", { name: "Claude asks" });
    await ask.waitFor({ timeout: 180_000 });
    const asked = await ask.innerText();
    expect(asked).toMatch(/GitHub · issue write/);
    expect(asked).not.toMatch(/Asked because/); // autonomous is off: every write asks, with no reason to give
    await both(page, "c08-session-write-asks");
    // The read ran before the question, without one.
    const calls = await page.evaluate(() => (globalThis as any).landlens.invoke("mcp:calls", {}));
    const gh = (calls.calls as { server: string; tool: string; status: string; origin: string }[]).filter((c) => c.server === "github" && c.origin === "agent");
    expect(gh.map((c) => `${c.tool}:${c.status}`)).toContain("list_issues:ok");
    expect(github.requests.some((r) => r.body.includes('"name":"issue_write"'))).toBe(false);
    // Turn the write down, and stop the session.
    const no = ask.getByRole("button", { name: /reject|deny|no/i }).first();
    await no.click();
    await dock.getByRole("button", { name: "Stop" }).click().catch(() => {});
    expect(github.requests.some((r) => r.body.includes('"name":"issue_write"'))).toBe(false);
    await page.getByRole("tab", { name: /Calls/ }).click();
    await page.getByRole("list", { name: "MCP calls" }).getByText("github · list_issues").first().waitFor();
    await both(page, "c09-calls-tab");
  }, 300_000);

  // ---- part 3: autonomous mode (D82–D84) ----------------------------------------------------------------------------
  const dock = () => page.getByRole("complementary", { name: "Claude Code" });
  const issueWrites = () => github.requests.filter((r) => r.body.includes('"name":"issue_write"'));

  it.runIf(claude)("turns GitHub autonomous on from the dock: chips, the scope sheet (Enter never turns it on), the strip", async () => {
    const d = dock();
    if (!(await d.count())) await page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j");
    const chip = d.getByRole("button", { name: "GitHub · asks" });
    await chip.waitFor({ timeout: 30_000 });
    await d.getByRole("button", { name: "Linear · asks" }).waitFor();
    await both(page, "a3-01-dock-chips");
    await chip.click();
    const sheet = d.getByRole("dialog", { name: "GitHub autonomous" });
    await sheet.waitFor();
    await sheet.getByLabel("Repositories").fill("landfalls-ai/landlens");
    await sheet.getByText("Claude may write to landfalls-ai/landlens without asking, up to 20 times. Anything it can read may end up there.").waitFor();
    // Enter in the sheet, in a field or on Turn on itself, never turns it on (D84).
    await sheet.getByLabel("Repositories").press("Enter");
    await sheet.getByRole("button", { name: "Turn on" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await expect(sheet.isVisible()).resolves.toBe(true);
    await expect(d.getByRole("status", { name: "Autonomous" }).count()).resolves.toBe(0);
    await both(page, "a3-02-scope-sheet");
    await sheet.getByRole("button", { name: "Turn on" }).click();
    const strip = d.getByRole("status", { name: "Autonomous" });
    await strip.waitFor();
    expect(await strip.innerText()).toContain("GitHub writes to landfalls-ai/landlens run without asking.");
    await d.getByRole("button", { name: "GitHub · autonomous 0/20" }).waitFor();
    await both(page, "a3-03-autonomous-strip");
  });

  it.runIf(claude)("in scope a routine write runs on its own and says so; out of scope it asks, with the reason", async () => {
    const d = dock();
    const box = d.getByRole("combobox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled({ timeout: 2_000 }).catch(() => false), { timeout: 60_000 }).toBe(true);
    const before = issueWrites().length;
    await box.fill(
      "This is a test of Landlens's autonomous mode. Do exactly two tool calls, one after the other, and nothing else: first call " +
        'the github MCP tool issue_write with method "create", owner landfalls-ai, repo landlens, title "Landlens autonomous test"; ' +
        'then call the github MCP tool issue_write with method "create", owner other-org, repo elsewhere, title "Out of scope test". Then say done.',
    );
    await box.press("Enter");
    const ask = d.getByRole("region", { name: "Claude asks" });
    await ask.waitFor({ timeout: 240_000 });
    const asked = await ask.innerText();
    expect(asked).toMatch(/GitHub · issue write/);
    expect(asked).toContain("Asked because: other-org/elsewhere isn't in the scope");
    expect(asked).toContain("other-org/elsewhere");
    expect(asked).toContain("Out of scope test");
    // The write in scope ran, on the fake, without a question; the out-of-scope one hasn't.
    const ran = issueWrites().slice(before);
    expect(ran.length).toBe(1);
    expect(ran[0]!.body).toContain("Landlens autonomous test");
    await d.locator(".auto-chip", { hasText: "ran on its own" }).first().waitFor({ timeout: 15_000 });
    await d.getByRole("button", { name: "GitHub · autonomous 1/20" }).waitFor();
    await ask.scrollIntoViewIfNeeded();
    await both(page, "a3-04-asks-out-of-scope");
    await ask.getByRole("button", { name: /reject|deny|no/i }).first().click();
    const stop = d.getByRole("button", { name: "Stop", exact: true });
    await expect.poll(() => stop.count(), { timeout: 120_000 }).toBe(0);
    expect(issueWrites().slice(before).some((r) => r.body.includes("other-org"))).toBe(false);
    await d.locator(".auto-chip").first().scrollIntoViewIfNeeded();
    await both(page, "a3-05-ran-on-its-own");
    // The Calls tab: the Autonomous filter shows that write, and its drawer says how it got through.
    await page.getByRole("tab", { name: /Calls/ }).click();
    await page.getByRole("group", { name: "Status" }).getByRole("button", { name: /^Autonomous/ }).click();
    const list = page.getByRole("list", { name: "MCP calls" });
    await list.getByText("github · issue_write").first().waitFor();
    await expect(list.locator("li").count()).resolves.toBe(1);
    await list.locator("li button").first().click();
    await page.getByText("The autonomous mode: ran on its own").waitFor();
    await both(page, "a3-06-calls-autonomous");
  }, 420_000);

  it.runIf(claude)("with GitHub autonomous on, a cluster write still waits on its change card (rejected: nothing changes)", async () => {
    const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
    try {
      kubectl("get", "deployment", "orders-api");
    } catch {
      kubectl("apply", "-f", resolve(__dirname, "../../../deploy/scenarios/crashloop.yaml"));
    }
    const env = () => kubectl("get", "deployment", "orders-api", "-o", "jsonpath={.spec.template.spec.containers[0].env}");
    const envBefore = env();
    const d = dock();
    await d.getByRole("status", { name: "Autonomous" }).waitFor();
    const box = d.getByRole("combobox", { name: "Message Claude Code" });
    const stop = d.getByRole("button", { name: "Stop", exact: true });
    await box.fill(
      "The orders-api deployment in namespace landlens-dev crash-loops because DATABASE_URL is not set. Propose the fix with the patch tool: " +
        "add the env var DATABASE_URL=postgres://orders-db.landlens-dev.svc.cluster.local:5432/orders to its api container. Propose exactly one change, then stop.",
    );
    await box.press("Enter");
    await stop.waitFor({ timeout: 30_000 });
    let cards = 0;
    const deadline = Date.now() + 300_000;
    while (await stop.count()) {
      if (Date.now() > deadline) throw new Error(`the agent did not finish in 5 minutes; the dock says:\n${await d.innerText()}`);
      const card = d.locator("section.change").first();
      if (await card.count()) {
        cards++;
        await card.locator(".diff").first().waitFor();
        expect(await card.locator(".diff").first().innerText()).toContain("DATABASE_URL");
        await card.scrollIntoViewIfNeeded();
        if (cards === 1) await both(page, "a3-07-change-card-while-autonomous");
        await card.getByRole("button", { name: "Reject", exact: true }).click();
      }
      // A question for the cluster tool (never answered on its own) is allowed here: it only reaches the change card.
      const ask = d.getByRole("region", { name: "Claude asks" }).first();
      if (await ask.count()) {
        expect(await ask.innerText()).not.toContain("Asked because");
        await ask.locator("button.primary").first().click();
      }
      await page.waitForTimeout(500);
    }
    expect(cards).toBeGreaterThanOrEqual(1);
    await d.locator(".change-done.rejected").first().waitFor();
    expect(env()).toBe(envBefore);
    expect(env()).not.toContain("DATABASE_URL");
    // No cluster call ran as autonomous.
    const calls = await page.evaluate(() => (globalThis as any).landlens.invoke("mcp:calls", {}));
    const auto = (calls.calls as { server: string; gate?: string }[]).filter((c) => c.gate === "autonomous");
    expect(auto.every((c) => c.server === "github")).toBe(true);
    // Stop in the strip turns it off; the chip asks again.
    await d.getByRole("button", { name: "Stop GitHub autonomous" }).click();
    await d.getByRole("button", { name: "GitHub · asks" }).waitFor();
    await expect(d.getByRole("status", { name: "Autonomous" }).count()).resolves.toBe(0);
    await d.getByRole("button", { name: "GitHub · asks" }).click();
    await d.getByRole("dialog", { name: "GitHub autonomous" }).getByText("You stopped it.").waitFor();
    await both(page, "a3-08-stopped");
    await page.keyboard.press("Escape");
  }, 900_000);
});
