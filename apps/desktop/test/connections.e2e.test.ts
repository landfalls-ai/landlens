// Connections (wave 6 part 2) in the built app, against part 1's loopback fakes of GitHub and Linear: no request
// reaches github.com, api.githubcopilot.com or linear.app. The app's provider overrides point every provider origin
// at a fake, and shell.openExternal is replaced in main so a browser sign-in is played by a fetch to the fake (never
// the person's browser, and never a real address). Connects GitHub by the device flow and by a pasted token, Linear
// by the browser flow and by a pasted key; the MCP page lists both from Connections. With `claude`, one live session
// (your own Claude Code): a GitHub read runs without asking, a write shows the question, and the Calls tab has both.
// LANDLENS_INTEGRATION=orbstack[,claude] npx vitest run test/connections.e2e.test.ts  (screenshots to $LANDLENS_SHOTS)
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
    await card("GitHub").getByRole("list", { name: "GitHub tools" }).waitFor();
    await both(page, "c03-connected-tools");
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
    expect(linear.revoked.length).toBe(1);
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
    expect(asked).toMatch(/issue_write/);
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
});
