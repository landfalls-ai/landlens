// What Landlens reports (wave 7 part 5, D127–D135) in the built app, against OrbStack and the loopback fakes of
// Clickland and Landflow (packages/connections/test/fake-family.ts): no request reaches a real sibling, and no Claude
// Code runs. The agent is test/fixtures/fake-acp-agent.mjs, run by main's real AgentService in place of
// claude-agent-acp (LANDLENS_ACP_AGENT, unpackaged builds only): its turns go through the real gateway, call
// landlens-kube for real (a read), and report usage and cost as claude-agent-acp does.
// Telemetry: off on the Clickland card; turned on to the fake collector behind main's dialog (stubbed here, and it
// records what it was asked); a question with a secret in it reaches the collector as an invoke_agent span with its
// execute_tool child, and its text doesn't; "See what is sent" shows the records. The brain: the dock's session menu
// opens the sheet, "Ask Claude to draft" fills the summary, Send saves one private work.session in the fake Landflow.
// LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/report.e2e.test.ts  (screenshots to $LANDLENS_SHOTS)
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BRAIN_NOTES } from "@landlens/contracts";
import { FakeClickland, FakeLandflow, LF_KEY } from "../../../packages/connections/test/fake-family";

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
const SECRET = "hunter2-e2e-not-a-real-password";
const QUESTION = `Is anything wrong in this cluster? (my db password=${SECRET})`;
/** Every span in the bodies the fake collector kept. */
const spans = (traces: unknown[]) => (traces as any[]).flatMap((b) => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
const attr = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value?.stringValue ?? s.attributes.find((a: any) => a.key === k)?.value?.intValue;

describe.runIf(run)("what Landlens reports, against the fake Clickland and Landflow", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  let clickland: FakeClickland;
  let landflow: FakeLandflow;
  let session = "";
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-report-"));
  const card = () => page.getByRole("region", { name: "Clickland connection" });
  const dock = () => page.getByRole("complementary", { name: "Claude Code" });
  const asked = () => app.evaluate(() => [...(globalThis as unknown as { asked: string[] }).asked]);

  beforeAll(async () => {
    clickland = await new FakeClickland().start();
    landflow = await new FakeLandflow().start();
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData, LANDLENS_ACP_AGENT: resolve(__dirname, "fixtures/fake-acp-agent.mjs") },
    });
    // Main's native dialog answers yes, and records what it asked.
    await app.evaluate(({ dialog }) => {
      const x = globalThis as unknown as { asked: string[] };
      x.asked = [];
      (dialog as unknown as { showMessageBox: (...a: unknown[]) => Promise<unknown> }).showMessageBox = async (...a: unknown[]) => {
        const o = a.find((v) => v && typeof v === "object" && "message" in (v as object)) as { message: string; detail: string };
        x.asked.push(`${o.message}\n${o.detail}`);
        return { response: 0, checkboxChecked: false };
      };
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
    page.on("dialog", (d) => void d.accept().catch(() => undefined));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([clickland?.stop(), landflow?.stop()]);
  }, 60_000);

  it("shows telemetry off on the Clickland card, and sends nothing", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: /^Connections/ }).click();
    await card().getByText("Landlens's telemetry").waitFor();
    expect(await card().getByRole("switch", { name: "Landlens's telemetry" }).isChecked()).toBe(false);
    await card().scrollIntoViewIfNeeded();
    await both(page, "w7p5-01-telemetry-off");
    expect(clickland.otlp).toEqual({ traces: [], metrics: [], logs: [] });
  });

  it("turns telemetry on to the fake collector, behind main's dialog that names it", async () => {
    await card().getByRole("button", { name: "Collector and team…" }).click();
    const form = card().getByRole("form", { name: "Telemetry collector and team" });
    await form.getByLabel("Collector address").fill(clickland.origin);
    await form.getByLabel("Team").fill("Has Spaces");
    await form.getByText("Lowercase letters").waitFor();
    await form.getByLabel("Team").fill("platform");
    await both(page, "w7p5-02-collector-form");
    await form.getByRole("button", { name: "Save" }).click();
    await form.waitFor({ state: "detached" });
    expect(await asked()).toEqual([]); // still off: no new place to send to
    await card().getByRole("switch", { name: "Landlens's telemetry" }).click();
    await expect.poll(() => card().getByRole("switch", { name: "Landlens's telemetry" }).isChecked()).toBe(true);
    const q = await asked();
    expect(q).toHaveLength(1);
    expect(q[0]).toContain(new URL(clickland.origin).host);
    expect(q[0]).toContain("No prompt or answer text");
    await card().getByRole("switch", { name: "Send names with telemetry" }).waitFor();
    await both(page, "w7p5-03-telemetry-on");
  });

  it("connects Landflow with a key that can record work", async () => {
    const lf = page.getByRole("region", { name: "Landflow connection" });
    await lf.getByLabel("Landflow address").fill(landflow.origin);
    await lf.getByLabel("Landflow API key").fill(LF_KEY);
    await lf.getByRole("button", { name: "Connect", exact: true }).click();
    await lf.getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
  });

  it("sends a turn as an invoke_agent span with its tool call, and none of the question's text", async () => {
    await page.getByRole("button", { name: "Clusters" }).click();
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Ask Claude", description: /⌘J/ }).click();
    const box = dock().getByRole("combobox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled(), { timeout: 30_000 }).toBe(true);
    await box.fill(QUESTION);
    await box.press("Enter");
    await dock().locator(".msg-agent", { hasText: "Everything I was asked about looks fine." }).waitFor({ timeout: 30_000 });
    // The queue sends every 10 s.
    await expect.poll(() => spans(clickland.otlp.traces).some((s) => attr(s, "gen_ai.operation.name") === "invoke_agent"), { timeout: 30_000, interval: 1000 }).toBe(true);
    const all = spans(clickland.otlp.traces);
    const turn = all.find((s) => attr(s, "gen_ai.operation.name") === "invoke_agent");
    session = attr(turn, "gen_ai.conversation.id");
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(attr(turn, "gen_ai.request.model")).toBe("claude-fake-1");
    expect(attr(turn, "gen_ai.usage.input_tokens")).toBe("1500");
    expect(attr(turn, "landlens.cluster")).toBe("orbstack");
    const tool = all.find((s) => attr(s, "gen_ai.tool.name") === "api_resources");
    expect(tool?.parentSpanId).toBe(turn.spanId);
    expect(attr(tool, "landlens.server")).toBe("landlens-kube");
    const sent = JSON.stringify(clickland.otlp);
    for (const t of [SECRET, "password", "Is anything wrong", "Everything I was asked"]) expect(sent).not.toContain(t);
    expect(sent).toContain("platform"); // team.id
    await both(page, "w7p5-04-dock-answered");
  });

  it("drafts the brain's summary from the session, asks Claude for one, and sends it private", async () => {
    await dock().getByRole("button", { name: "Session actions" }).click();
    await dock().getByRole("menuitem", { name: "Send a summary to the brain…" }).click();
    const sheet = page.getByRole("dialog", { name: "Send a summary to the brain" });
    await expect.poll(() => sheet.getByLabel("Title").inputValue(), { timeout: 10_000 }).toBe("Worked on orbstack with Claude");
    expect(await sheet.getByLabel("Summary").inputValue()).toBe("1 question; 1 tool call (1 cluster read); no changes.");
    expect(await sheet.getByRole("radio", { name: "private" }).getAttribute("aria-checked")).toBe("true");
    await both(page, "w7p5-05-brain-sheet");
    // Enter in the title doesn't send.
    await sheet.getByLabel("Title").press("Enter");
    expect(landflow.brain).toEqual([]);
    await sheet.getByRole("button", { name: "Ask Claude to draft" }).click();
    await expect.poll(() => sheet.getByLabel("Summary").inputValue(), { timeout: 20_000 }).toBe("Checked the cluster's API resources; nothing was changed.");
    await sheet.getByText("Claude's draft: check it before sending.").waitFor();
    const before = (await asked()).length;
    await sheet.getByRole("button", { name: "Send", exact: true }).click();
    await sheet.getByText(BRAIN_NOTES.saved).waitFor({ timeout: 10_000 });
    await both(page, "w7p5-06-brain-saved");
    expect(landflow.brain).toHaveLength(1);
    const e = landflow.brain[0]!;
    expect(e).toMatchObject({ kind: "work.session", source: "landlens", sourceId: session, turns: 1, visibility: "private", title: "Worked on orbstack with Claude", summary: "Checked the cluster's API resources; nothing was changed." });
    expect(Object.keys(e).sort()).toEqual(["endedAt", "kind", "occurredAt", "source", "sourceId", "summary", "title", "turns", "visibility"]);
    expect(JSON.stringify(e)).not.toContain(SECRET);
    expect((await asked()).length).toBe(before); // private: no dialog
    await sheet.getByRole("button", { name: "Done" }).click();
  });

  it("asks in main's dialog, showing the text, before the summary is shared with the team (review of part 5, M4)", async () => {
    await dock().getByRole("button", { name: "Session actions" }).click();
    await dock().getByRole("menuitem", { name: "Send a summary to the brain…" }).click();
    const sheet = page.getByRole("dialog", { name: "Send a summary to the brain" });
    await expect.poll(() => sheet.getByLabel("Title").inputValue(), { timeout: 10_000 }).toBe("Worked on orbstack with Claude");
    await sheet.getByLabel("Summary").fill("Checked the API resources for the team.");
    await sheet.getByRole("radio", { name: "team" }).click();
    const before = (await asked()).length;
    await sheet.getByRole("button", { name: "Send", exact: true }).click();
    await sheet.getByText(BRAIN_NOTES.savedTeam).waitFor({ timeout: 10_000 });
    const q = (await asked()).slice(before);
    expect(q).toHaveLength(1);
    expect(q[0]).toContain(`Share this summary with your team in ${new URL(landflow.origin).host}'s brain?`);
    expect(q[0]).toContain("Title: Worked on orbstack with Claude");
    expect(q[0]).toContain("Summary: Checked the API resources for the team.");
    expect(landflow.brain.at(-1)).toMatchObject({ visibility: "team", summary: "Checked the API resources for the team." });
    await sheet.getByRole("button", { name: "Done" }).click();
  });

  it("removes the session's summary from the brain", async () => {
    await dock().getByRole("button", { name: "Session actions" }).click();
    await dock().getByRole("menuitem", { name: "Remove from the brain" }).click();
    await dock().getByText(BRAIN_NOTES.removed).waitFor();
    expect(landflow.brain).toEqual([]);
  });

  it("shows what is sent, exactly as queued", async () => {
    await page.getByRole("button", { name: /^Connections/ }).click();
    await card().getByRole("button", { name: "See what is sent" }).click();
    const drawer = page.getByRole("dialog", { name: "What Landlens sends" });
    await drawer.getByText("invoke_agent landlens-claude").first().waitFor();
    const text = await drawer.innerText();
    expect(text).toContain("gen_ai.conversation.id");
    expect(text).not.toContain(SECRET);
    await both(page, "w7p5-07-what-is-sent");
    await drawer.getByRole("button", { name: "Done" }).click();
  });
});

// D137's telemetry check, with a synthetic session: LANDLENS_INTEGRATION=orbstack,clickland. Telemetry on to the local
// Clickland's collector (LANDLENS_CLICKLAND_COLLECTOR, default http://127.0.0.1:4318) as team `landlens-live-check`;
// one turn of the fake ACP agent (no Claude Code; it reads only the cluster's API resources); then the card says the
// collector took the records. It reads nothing back (that needs a Clickland key, which this test doesn't make). It leaves
// a few spans, sums and events from service `landlens` in that Clickland; its own retention removes them.
describe.runIf(run && flags.includes("clickland"))("telemetry to the local Clickland collector (live, synthetic session)", { timeout: 90_000 }, () => {
  let app: ElectronApplication;
  let page: Page;
  const collector = process.env.LANDLENS_CLICKLAND_COLLECTOR ?? "http://127.0.0.1:4318";
  const userData = mkdtempSync(join(tmpdir(), "landlens-e2e-report-live-"));
  const card = () => page.getByRole("region", { name: "Clickland connection" });

  beforeAll(async () => {
    app = await electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [resolve(__dirname, "..")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", LANDLENS_USER_DATA: userData, LANDLENS_ACP_AGENT: resolve(__dirname, "fixtures/fake-acp-agent.mjs") },
    });
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: (...a: unknown[]) => Promise<unknown> }).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 880 });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it("sends a synthetic session's turn, and the collector takes it", async () => {
    await page.getByRole("heading", { name: "Pick a cluster" }).waitFor();
    await page.getByRole("button", { name: /^Connections/ }).click();
    await card().getByRole("button", { name: "Collector and team…" }).click();
    const form = card().getByRole("form", { name: "Telemetry collector and team" });
    await form.getByLabel("Collector address").fill(collector);
    await form.getByLabel("Team").fill("landlens-live-check");
    await form.getByRole("button", { name: "Save" }).click();
    await card().getByRole("switch", { name: "Landlens's telemetry" }).click();
    await expect.poll(() => card().getByRole("switch", { name: "Landlens's telemetry" }).isChecked()).toBe(true);
    await page.getByRole("button", { name: "Clusters" }).click();
    await page.getByRole("button", { name: /orbstack/ }).first().click();
    await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Ask Claude", description: /⌘J/ }).click();
    const dock = page.getByRole("complementary", { name: "Claude Code" });
    const box = dock.getByRole("combobox", { name: "Message Claude Code" });
    await expect.poll(() => box.isEnabled(), { timeout: 30_000 }).toBe(true);
    await box.fill("Landlens live telemetry check: a synthetic turn.");
    await box.press("Enter");
    await dock.locator(".msg-agent", { hasText: "looks fine" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Connections/ }).click();
    // The queue sends every 10 s; the card says when the collector last answered.
    await expect.poll(() => card().innerText(), { timeout: 40_000, interval: 2000 }).toMatch(/Sent \d/);
    const recent = await page.evaluate(() => (globalThis as any).landlens.invoke("telemetry:recent", {}));
    expect(recent.info.last.ok).toBe(true);
    expect(recent.records.some((r: { name: string }) => r.name === "invoke_agent landlens-claude")).toBe(true);
    console.log(`sent to ${collector}: ${recent.records.length} records (${[...new Set(recent.records.map((r: { name: string }) => r.name))].join(", ")})`);
  });
});
