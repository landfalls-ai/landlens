// A session's summary to the brain (wave 7 D134): the rule-built draft, Landlens's mirror of Landflow's
// validateWorkEvent, and recordWork/removeWork against the fake built from Landflow's /api/brain/work routes.
import { BRAIN_NOTES, FAMILY_NOTES, type WorkDraft } from "@landlens/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { checkWork, containsMachinePath, draftWork, factLines, looksLikeCode, type SessionFacts } from "../src/brain.js";
import { FamilyError } from "../src/family.js";
import { recordWork, removeWork } from "../src/landflow.js";
import { FakeLandflow, LF_KEY, LF_KEY_NARROW } from "./fake-family.js";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.map((s) => s()));
  stops = [];
});
const up = async (f: FakeLandflow) => {
  await f.start();
  stops.push(() => f.stop());
  return f;
};

const FACTS: SessionFacts = {
  session: "0b6e1c1e-5d1a-4c55-9a51-0d3c8e6d2f10", cluster: "orbstack", namespaces: ["landlens-dev"],
  createdAt: "2026-11-15T09:00:00.000Z", updatedAt: "2026-11-15T09:12:00.000Z",
  questions: 3, tools: 14, reads: 12, proposed: 1, applied: 1, rejected: 0,
};

describe("draftWork", () => {
  it("drafts a private work.session from the session's record, with nothing else", () => {
    const e = draftWork(FACTS);
    expect(e).toEqual({
      kind: "work.session", source: "landlens", sourceId: FACTS.session, occurredAt: FACTS.createdAt, endedAt: FACTS.updatedAt, turns: 3,
      title: "Worked on orbstack/landlens-dev with Claude", summary: "3 questions; 14 tool calls (12 cluster reads); proposed 1 change, 1 applied.", visibility: "private",
    });
    expect(checkWork(e)).toBeUndefined();
    expect(Object.keys(e)).not.toEqual(expect.arrayContaining(["repo", "areas", "url", "prs"]));
  });

  it("titles a problem's session by the problem, and a context that isn't a name as 'a cluster'", () => {
    expect(draftWork({ ...FACTS, problem: "orders-api is crash-looping" }).title).toBe("Looked into orders-api is crash-looping on orbstack");
    expect(draftWork({ ...FACTS, namespaces: undefined, cluster: "/Users/me/.kube/config" }).title).toBe("Worked on a cluster with Claude");
    // An account id in an ARN, a person's name, or no name at all (security review of part 5, L3).
    for (const cluster of ["arn:aws:eks:eu-west-1:123456789012:cluster/prod", "alice@prod", undefined]) {
      expect(draftWork({ ...FACTS, namespaces: undefined, cluster }).title, String(cluster)).toBe("Worked on a cluster with Claude");
    }
    expect(factLines({ ...FACTS, proposed: 0, applied: 0 })).toEqual(["3 questions", "14 tool calls, 12 cluster reads", "no change proposed"]);
  });
});

describe("checkWork mirrors validateWorkEvent", () => {
  const ok: WorkDraft = draftWork(FACTS);
  it.each([
    ["a second line", { title: "one\ntwo" }, "one line"],
    ["a path on the machine", { title: "Fixed /Users/me/secrets.txt" }, "path on your machine"],
    ["a path in the summary", { summary: "see ~/notes for it" }, "path on your machine"],
    ["code for a title", { title: `const x = () => { return ${"y".repeat(80)}; }` }, "reads like code"],
    ["a long title", { title: "t".repeat(201) }, "at most 200"],
    ["a long summary", { summary: "s".repeat(501) }, "at most 500"],
    ["a long team", { team: "t".repeat(121) }, "at most 120"],
    ["a control character", { summary: "a\u0007b" }, "control character"],
    ["another kind", { kind: "work.review" }, "only its own"],
    ["a visibility Landflow lacks", { visibility: "public" }, "private, team or org"],
  ])("refuses %s", (_n, patch, words) => {
    expect(checkWork({ ...ok, ...(patch as Partial<WorkDraft>) })).toContain(words);
  });
  it("copies Landflow's path and code tests", () => {
    expect(containsMachinePath("C:\\Users\\x")).toBe(true);
    expect(containsMachinePath("file:///etc")).toBe(true);
    expect(containsMachinePath("the /api/brain route")).toBe(false);
    expect(looksLikeCode("function f() { return 1; }")).toBe(true);
    expect(looksLikeCode("Looked into orders-api")).toBe(false);
  });
});

describe("recordWork and removeWork", () => {
  it("saves the event as sent, updates it on a second send, and removes it", async () => {
    const lf = await up(new FakeLandflow());
    const event = draftWork(FACTS);
    expect(await recordWork({ origin: lf.origin, key: LF_KEY, event })).toEqual({ saved: true });
    expect(lf.brain).toEqual([event]);
    await recordWork({ origin: lf.origin, key: LF_KEY, event: { ...event, title: "Second title" } });
    expect(lf.brain.map((e) => e.title)).toEqual(["Second title"]);
    expect(await removeWork({ origin: lf.origin, key: LF_KEY, sourceId: event.sourceId })).toBe(true);
    expect(lf.brain).toEqual([]);
    expect(await removeWork({ origin: lf.origin, key: LF_KEY, sourceId: event.sourceId })).toBe(false);
  });

  it("shows Landflow's reason for a rejected event, as text", async () => {
    const lf = await up(new FakeLandflow());
    const a = await recordWork({ origin: lf.origin, key: LF_KEY, event: { ...draftWork(FACTS), occurredAt: "2099-01-01T00:00:00.000Z" } });
    expect(a).toEqual({ saved: false, reason: "occurredAt is more than a day in the future" });
    expect(lf.brain).toEqual([]);
  });

  it("says why a key or an instance can't take it", async () => {
    const lf = await up(new FakeLandflow());
    const event = draftWork(FACTS);
    const fail = async (p: Promise<unknown>) => p.then(() => undefined, (e: FamilyError) => e);
    expect((await fail(recordWork({ origin: lf.origin, key: LF_KEY_NARROW, event })))?.message).toBe(BRAIN_NOTES.noBrain);
    expect((await fail(recordWork({ origin: lf.origin, key: `lf_${"Z".repeat(43)}`, event })))?.message).toBe(FAMILY_NOTES.landflowRefused);
    lf.brainOff = true;
    expect((await fail(recordWork({ origin: lf.origin, key: LF_KEY, event })))?.message).toBe(BRAIN_NOTES.brainOff);
    expect(lf.brain).toEqual([]);
  });
});
