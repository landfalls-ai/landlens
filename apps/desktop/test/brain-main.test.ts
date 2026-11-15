// A session's summary to the brain, in main (wave 7 D134–D135): a sheet per window with the digest of the fields main
// filled; send refuses another window's sheet, an old one, a digest the sheet doesn't have, a session that moved on,
// and text a scrub would change; "Ask Claude to draft" sends main's fixed prompt only. Against the fake Landflow.
import { BRAIN_NOTES, BRAIN_PROMPT, type AgentHistoryEntry, type FamilyInfo, type McpCall } from "@landlens/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN, BrainService } from "../src/main/brain";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { FamilyService } from "../src/main/family";
import { FakeLandflow, LF_KEY, LF_KEY_NARROW } from "../../../packages/connections/test/fake-family";
import { fakeCrypto, tempFile } from "../../../packages/connections/test/helpers";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.map((s) => s()));
  stops = [];
});

const SESSION = "0b6e1c1e-5d1a-4c55-9a51-0d3c8e6d2f10";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

async function setup(o: { key?: string } = {}) {
  const lf = new FakeLandflow();
  await lf.start();
  stops.push(() => lf.stop());
  const crypto = fakeCrypto(true);
  const family = new FamilyService({
    file: tempFile("family.json"), crypto, clickland: new ClicklandSettingsStore(tempFile("clickland.json"), crypto),
    openExternal: async () => {}, push: (_i: FamilyInfo) => {}, log: () => {},
  });
  await family.connectLandflow(lf.origin, o.key ?? LF_KEY);
  const entry: AgentHistoryEntry = {
    session: SESSION, agent: "Claude Code", context: "orbstack", namespaces: ["landlens-dev"], title: `my words with ${TOKEN}`,
    createdAt: "2026-11-15T09:00:00.000Z", updatedAt: "2026-11-15T09:12:00.000Z", prompts: 2, applied: 1, rejected: 0,
  } as AgentHistoryEntry;
  const prompts: string[] = [];
  const agent = { open: true, busy: false, answer: "Found the crash: a missing env var. Patched the Deployment.", isOpen: () => agent.open,
    draft: async (_s: string, p: string) => {
      if (agent.busy) throw Object.assign(new Error("busy"), { status: 409, busy: true });
      prompts.push(p);
      return agent.answer;
    } };
  const clock = { t: Date.now() };
  const brain = new BrainService({ family, history: { get: (s) => (s === SESSION ? entry : undefined) }, agent, now: () => clock.t });
  brain.observer.asked?.(SESSION, "Problem: orders-api is crash-looping\nSeverity: failing (crashloop, X)", []);
  const call = { id: "c1", session: SESSION, server: "landlens-kube", tool: "get_resource", origin: "agent", status: "ok", startedAt: 0 } as McpCall;
  brain.call(call);
  brain.call(call);
  brain.call({ ...call, id: "c2", server: "github", tool: "search" });
  return { lf, brain, entry, agent, prompts, clock };
}
const win = {};
const other = {};

describe("the brain in main", () => {
  it("drafts a private event from the session's record, and sends it as shown", async () => {
    const { lf, brain } = await setup();
    const d = brain.draft(SESSION, win);
    expect(d.event).toMatchObject({ kind: "work.session", source: "landlens", sourceId: SESSION, turns: 2, visibility: "private", title: "Looked into orders-api is crash-looping on orbstack" });
    expect(d.event.summary).toBe("2 questions; 2 tool calls (1 cluster read); proposed 1 change, 1 applied.");
    expect(JSON.stringify(d)).not.toContain(TOKEN); // the history's title (the first prompt) is never used
    expect(d.to).toBe(new URL(lf.origin).host);
    const r = await brain.send({ sheet: d.sheet, digest: d.digest, title: "Fixed orders-api", summary: "Missing env var.", visibility: "team", team: "platform" }, win);
    expect(r).toEqual({ saved: true, note: BRAIN_NOTES.savedTeam });
    expect(lf.brain).toEqual([{ ...d.event, title: "Fixed orders-api", summary: "Missing env var.", visibility: "team", team: "platform" }]);
  });

  it("refuses another window's sheet, an old sheet, and a digest the sheet doesn't have", async () => {
    const { lf, brain, clock } = await setup();
    const d = brain.draft(SESSION, win);
    const req = { sheet: d.sheet, digest: d.digest, title: "t", summary: "s", visibility: "private" as const };
    await expect(brain.send(req, other)).rejects.toMatchObject({ status: 404, message: BRAIN_NOTES.noSheet });
    await expect(brain.send({ ...req, digest: "0".repeat(64) }, win)).rejects.toMatchObject({ status: 409, message: BRAIN_NOTES.changed });
    clock.t += BRAIN.sheetMs + 1;
    await expect(brain.send(req, win)).rejects.toMatchObject({ status: 404, message: BRAIN_NOTES.noSheet });
    expect(lf.brain).toEqual([]);
  });

  it("refuses a session that moved on since the sheet was made", async () => {
    const { lf, brain, entry } = await setup();
    const d = brain.draft(SESSION, win);
    entry.prompts = 3;
    entry.updatedAt = "2026-11-15T09:20:00.000Z";
    await expect(brain.send({ sheet: d.sheet, digest: d.digest, title: "t", summary: "s", visibility: "private" }, win)).rejects.toMatchObject({ status: 409, message: BRAIN_NOTES.changed });
    expect(lf.brain).toEqual([]);
  });

  it("sends nothing a scrub would change: the scrubbed text comes back to read", async () => {
    const { lf, brain } = await setup();
    const d = brain.draft(SESSION, win);
    const r = await brain.send({ sheet: d.sheet, digest: d.digest, title: "Rotated the token", summary: `The old one was ${TOKEN}`, visibility: "private" }, win);
    expect(r.saved).toBe(false);
    expect(r.note).toBe(BRAIN_NOTES.scrubbed);
    expect(r.scrubbed?.summary).not.toContain(TOKEN);
    expect(lf.brain).toEqual([]);
  });

  it("checks Landflow's own rules before sending", async () => {
    const { lf, brain } = await setup();
    const d = brain.draft(SESSION, win);
    const r = await brain.send({ sheet: d.sheet, digest: d.digest, title: "Looked at /Users/me/.kube/config", summary: "", visibility: "private" }, win);
    expect(r).toEqual({ saved: false, note: "The title holds a path on your machine. Describe the work without it." });
    expect(lf.brain).toEqual([]);
  });

  it("needs a key with brain:write", async () => {
    const { brain } = await setup({ key: LF_KEY_NARROW });
    expect(() => brain.draft(SESSION, win)).toThrow(BRAIN_NOTES.noBrain);
  });

  it("asks Claude with main's fixed prompt only, scrubbed and cut; not while busy or closed", async () => {
    const { brain, agent, prompts } = await setup();
    const d = brain.draft(SESSION, win);
    agent.answer = `Line one.\n\nRotated ${TOKEN}. ${"x".repeat(600)}`;
    const r = await brain.ask(d.sheet, win);
    expect(prompts).toEqual([BRAIN_PROMPT]);
    expect(r.summary).not.toContain(TOKEN);
    expect(r.summary).not.toContain("\n");
    expect(r.summary.length).toBeLessThanOrEqual(500);
    await expect(brain.ask(d.sheet, other)).rejects.toMatchObject({ status: 404 });
    agent.busy = true;
    await expect(brain.ask(d.sheet, win)).rejects.toMatchObject({ status: 409, message: BRAIN_NOTES.busy });
    agent.open = false;
    await expect(brain.ask(d.sheet, win)).rejects.toMatchObject({ status: 409, message: BRAIN_NOTES.closed });
  });

  it("removes the session's event, and says when there was none", async () => {
    const { lf, brain } = await setup();
    const d = brain.draft(SESSION, win);
    await brain.send({ sheet: d.sheet, digest: d.digest, title: "t", summary: "s", visibility: "private" }, win);
    expect(await brain.remove(SESSION)).toEqual({ ok: true, note: BRAIN_NOTES.removed });
    expect(lf.brain).toEqual([]);
    expect(await brain.remove(SESSION)).toEqual({ ok: false, note: BRAIN_NOTES.notThere });
    await expect(brain.remove("not-a-known-session")).rejects.toMatchObject({ status: 404 });
  });
});
