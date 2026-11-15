// The drain sheet's sequencing in the window (security review of wave 8 part 2, M1, M2, M4, M3's ending), pure:
// pushes kept from before Apply answers, the latest by number; only the latest review lands; Apply only while the
// review's ticks are the boxes'; the status bar's running drains; the ending as main read it.
import type { ActionReview, DrainPlan, DrainProgress, DrainRun } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { canApplyDrain, endingLine, hasEnded, newer, ProgressBuffer, running, Turns, withProgress } from "../src/renderer/src/drainRuns";

const progress = (seq: number, state: DrainProgress["state"], o: Partial<DrainProgress> = {}): DrainProgress => ({
  run: "edRUN", node: "node-1", state, seq, startedAt: 0, pods: [{ namespace: "a", name: "p", state: state === "done" ? "gone" : "waiting" }], ...o,
});
const plan = (o: Partial<DrainPlan> = {}): DrainPlan => ({ node: "node-1", cordoned: false, pods: [], counts: { evict: 0, blocked: 0, skipped: 0 }, ...o });
const review = (ticks: { bare: boolean; emptyDir: boolean }, o: Partial<ActionReview> = {}): ActionReview => ({ id: "edA", digest: "d".repeat(64), plan: plan(), ticks, ...o });

describe("M1: a push that comes before Apply's answer still ends the sheet", () => {
  it("is kept by run id from the first moment, and taken when the run is known", () => {
    const b = new ProgressBuffer();
    // The run ends in the same tick as the reply: both pushes land before the sheet knows the run's id.
    b.add(progress(1, "cordoning"));
    b.add(progress(3, "done"));
    const got = b.get("edRUN");
    expect(got?.state).toBe("done");
    expect(hasEnded(got)).toBe(true);
    expect(b.get("edOTHER")).toBeUndefined();
  });

  it("the highest number wins, whatever order the pushes and main's answer arrive in", () => {
    const b = new ProgressBuffer();
    b.add(progress(5, "done"));
    expect(b.add(progress(2, "evicting")).state).toBe("done"); // a late, older push doesn't undo the end
    expect(newer(progress(4, "evicting"), progress(3, "cordoning"))!.seq).toBe(4);
    expect(newer(undefined, progress(1, "evicting"))!.seq).toBe(1);
  });
});

describe("M2: ticks the person took back can't be applied", () => {
  it("two reviews answered in reverse order: only the latest lands", () => {
    const turns = new Turns();
    const a = turns.next(); // ticked
    const b = turns.next(); // unticked
    expect(turns.isLatest(b)).toBe(true); // B answers first and lands
    expect(turns.isLatest(a)).toBe(false); // A answers after: dropped (and its id given back)
  });

  it("Apply is on only while the review's ticks are the boxes' ticks", () => {
    const ticked = review({ bare: true, emptyDir: false });
    expect(canApplyDrain(ticked, { bare: true, emptyDir: false })).toBe(true);
    // Unticked inside the 300 ms, or a stale ticked review on screen: off.
    expect(canApplyDrain(ticked, { bare: false, emptyDir: false })).toBe(false);
    expect(canApplyDrain(review({ bare: false, emptyDir: false }), { bare: false, emptyDir: true })).toBe(false);
    // A review that doesn't say its ticks is never applied.
    const { ticks: _t, ...bare } = ticked;
    expect(canApplyDrain(bare, { bare: true, emptyDir: false })).toBe(false);
    // And the rest of D154's rule.
    expect(canApplyDrain({ ...ticked, previewOnly: true }, { bare: true, emptyDir: false })).toBe(false);
    expect(canApplyDrain({ ...ticked, plan: plan({ partial: "x" }) }, { bare: true, emptyDir: false })).toBe(false);
    const waits = plan({ pods: [{ namespace: "a", name: "p", uid: "u", class: "evict", bare: false, emptyDir: ["c"], blocked: "needs-emptydir" }] });
    expect(canApplyDrain({ ...ticked, plan: waits }, { bare: true, emptyDir: false })).toBe(false);
    const { id: _i, ...noId } = ticked;
    expect(canApplyDrain(noId, { bare: true, emptyDir: false })).toBe(false);
  });
});

describe("M4: the status bar's running drains", () => {
  it("lists those still running and follows the pushes", () => {
    const runs: DrainRun[] = [
      { progress: progress(2, "evicting"), plan: plan(), ended: false },
      { progress: progress(9, "done", { run: "edOLD" }), plan: plan(), ended: true },
    ];
    expect(running(runs).map((r) => r.progress.run)).toEqual(["edRUN"]);
    const after = withProgress(runs, progress(3, "stopped"));
    expect(after[0]).toMatchObject({ ended: true, progress: { state: "stopped" } });
    expect(running(after)).toEqual([]);
    // An older push doesn't bring an ended run back.
    expect(running(withProgress(after, progress(2, "evicting")))).toEqual([]);
  });
});

describe("M3: the ending says what main read, nothing more", () => {
  it("names a node no longer cordoned, pods that arrived, and claims nothing it didn't read", () => {
    expect(endingLine(progress(9, "done", { cordoned: true }))).toBe("Done. 1 gone, 0 blocked. The node stays cordoned.");
    expect(endingLine(progress(9, "done", { cordoned: false, arrived: 2 }))).toBe("Done. 1 gone, 0 blocked. The node is no longer cordoned. 2 pods arrived after the preview and are still on it. Drain again.");
    expect(endingLine(progress(9, "failed", { pods: [] }))).toBe("0 gone, 0 blocked.");
    expect(endingLine(progress(9, "stopped", { cordoned: true }))).toBe("Stopped. 0 gone, 0 blocked, 1 not evicted. The node stays cordoned.");
  });
});
