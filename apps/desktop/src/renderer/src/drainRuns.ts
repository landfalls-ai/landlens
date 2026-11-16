// A drain's run as the window holds it (security review of wave 8 part 2, M1, M2, M4), pure so a test can reach it.
//
// M1: progress can arrive before `action:apply` answers (a run with nothing to evict ends in the same tick), so the
// sheet listens from the moment it opens and keeps every push by run id; on entering the run it takes what it already
// has and asks main once (`action:runs`) for the latest. Each push carries its number in the run (`seq`); the highest
// wins, whatever order they arrive in.
// M2: a tick change drops the review on screen at once, and a review's answer lands only if it is the latest asked;
// Apply is on only while the review's ticks are the boxes' ticks.
// M4: main lists the window's runs; the status bar's chip re-opens a run's sheet, so Stop is always reachable.
import type { ActionReview, DrainProgress, DrainRun } from "@landlens/contracts";

/** The later of two states of one run, by its push number. */
export function newer(a: DrainProgress | undefined, b: DrainProgress | undefined): DrainProgress | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.seq > a.seq ? b : a;
}

/** A run that has ended (no more evictions will be sent). */
export const hasEnded = (p: DrainProgress | undefined) => !!p && p.state !== "cordoning" && p.state !== "evicting";

/** Pushes kept by run id from the sheet's first moment, before Apply has answered with the run (M1). */
export class ProgressBuffer {
  private readonly runs = new Map<string, DrainProgress>();
  add(p: DrainProgress): DrainProgress {
    const best = newer(this.runs.get(p.run), p)!;
    this.runs.set(p.run, best);
    return best;
  }
  get(run: string): DrainProgress | undefined {
    return this.runs.get(run);
  }
}

/** Which review may land (M2): each ask takes a turn; only the latest turn's answer is used, older ones are dropped. */
export class Turns {
  private n = 0;
  next(): number {
    return ++this.n;
  }
  isLatest(turn: number): boolean {
    return turn === this.n;
  }
}

export type Ticks = { bare: boolean; emptyDir: boolean };

/**
 * Whether the drain sheet's Apply is on (D154, M2): a review main can run (an id and a digest, not preview only, not
 * partial, nothing waiting on a tick) whose ticks are the boxes' ticks now.
 */
export function canApplyDrain(review: ActionReview | undefined, ticks: Ticks): boolean {
  if (!review?.id || !review.digest || review.previewOnly || !review.plan || review.plan.partial) return false;
  if (!review.ticks || review.ticks.bare !== ticks.bare || review.ticks.emptyDir !== ticks.emptyDir) return false;
  return !review.plan.pods.some((p) => p.blocked === "needs-bare" || p.blocked === "needs-emptydir");
}

/** The runs the status bar shows (M4): those still running, oldest first. */
export const running = (runs: DrainRun[]) => runs.filter((r) => !r.ended && !hasEnded(r.progress));

/** A run's state from a push, in the window's list of runs (a run it hasn't listed yet is left for the next read). */
export function withProgress(runs: DrainRun[], p: DrainProgress): DrainRun[] {
  return runs.map((r) => (r.progress.run === p.run ? { ...r, progress: newer(r.progress, p)!, ended: r.ended || hasEnded(newer(r.progress, p)) } : r));
}

/** The ending's sentence (D152, M3): what happened, and what the node is now, only as far as Landlens read it. */
export function endingLine(p: DrainProgress): string {
  const n = (s: DrainProgress["pods"][number]["state"]) => p.pods.filter((x) => x.state === s).length;
  const head = p.state === "stopped" ? "Stopped. " : p.state === "timed-out" ? "Time's up. " : p.state === "failed" ? "" : "Done. ";
  const counts = [`${n("gone")} gone`, `${n("blocked")} blocked`, ...(n("failed") ? [`${n("failed")} failed`] : []),
    ...(n("evicted") ? [`${n("evicted")} still terminating`] : []), ...(n("waiting") ? [`${n("waiting")} not evicted`] : [])].join(", ");
  const node = p.cordoned === true ? " The node stays cordoned." : p.cordoned === false ? " The node is no longer cordoned." : "";
  const arrived = p.arrived ? ` ${p.arrived} pod${p.arrived === 1 ? "" : "s"} arrived after the preview and ${p.arrived === 1 ? "is" : "are"} still on it. Drain again.` : "";
  return `${head}${counts}.${node}${arrived}`;
}
