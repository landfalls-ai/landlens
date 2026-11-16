// D225: every limit of a view in one place. Each has a unit test at the limit and one past it (schema.test.ts,
// transform.test.ts, patch.test.ts, view-runtime.test.ts).

export const VIEW_LIMITS = {
  /** A document as JSON, in characters. */
  documentChars: 400_000,
  /** Sources per view, the hidden ones (`$workload`'s ReplicaSets and Jobs) included. */
  sources: 8,
  blocks: 24,
  appBlocks: 4,
  /** One app block's `html` + `css` + `js`, in characters. */
  appChars: 150_000,
  /** Objects one watch keeps; past it the source is `truncated`. */
  watchObjects: 10_000,
  /** Rows a source delivers after its pipe. */
  rows: 2_000,
  /** One cell's string, in characters. */
  cell: 2_000,
  columns: 16,
  steps: 8,
  /** Fields one source keeps (part 1: the spec gives none; a table shows at most 16). */
  fields: 24,
  toolSources: 2,
  logsSources: 2,
  /** A log source's lines, and one line's characters. */
  logLines: 500,
  patchOps: 50,
  versions: 20,
  /** Per frame, a minute. */
  frameCalls: 60,
  linkDialogs: 3,
  intents: 6,
  saved: 200,
  /** A view file on import, in bytes. */
  importBytes: 512_000,
  /** `render_view` + `patch_view` calls per session, a minute. */
  renders: 30,
  /** A message to a frame, in characters: past it a source's rows are cut until it fits. */
  frameMessage: 1_000_000,
  /** Watches, log streams and polls one open view may run (a "*" over a namespace-limited view is one per namespace). */
  feeds: 24,
  /** Pods a workload's `kube.logs` source follows. */
  logPods: 5,
  /** Views open at once in main (one per window; the rest is headroom for a reload). */
  openViews: 4,
  // Security review of wave 10 part 1 (M3, M5): what one view may cost main, in work and in memory.
  /**
   * A join's work: the right side's rows indexed (each label counted for a selector join), then every candidate a left
   * row is compared with, times the join's takes and aggregates. Past it the join isn't worked out and says so.
   */
  joinWork: 500_000,
  /** Objects a source reads, over all its watches (a "*" in a limited view is one per namespace), before its pipe. */
  sourceObjects: 10_000,
  /** Objects a view's watches keep, together. */
  viewObjects: 20_000,
  /** Characters of JSON a view's watches keep, together, each object trimmed to what the document reads (32 MiB). */
  viewChars: 33_554_432,
  /** Characters a source's rows hold after its pipe (what a join reads and the 2,000-row cut takes from; 8 MiB). */
  sourceChars: 8_388_608,
} as const;

export type ViewLimits = { -readonly [K in keyof typeof VIEW_LIMITS]: number };

/** How often each source is read (D210), and the runtime's other times, in ms. */
export const VIEW_TIMES = {
  /** A watch's batch. */
  batch: 1_000,
  /** At most one push per source this often. */
  push: 1_000,
  top: 15_000,
  metrics: 60_000,
  /** The doctor has no push of its own; its report is asked this often (it caches 2 s itself). */
  doctor: 15_000,
  helm: 60_000,
  /** Part 4 (D210): Google Cloud every 5 minutes, Clickland every 30 s, a gateway tool every 2 minutes. */
  gcp: 300_000,
  clickland: 30_000,
  tool: 120_000,
  /** Events age out of `sinceMinutes` on this tick even when nothing changes. */
  eventsTick: 60_000,
  /** A workload's pods, read again for `kube.logs`. */
  logPods: 30_000,
  /** A followed log that ended is followed again after this. */
  logRetry: 5_000,
  /** A manual Refresh runs at most this often. */
  refresh: 5_000,
  /** Hidden this long, a view's sources stop (its token is kept). */
  hiddenStop: 30_000,
} as const;

export type ViewTimes = { -readonly [K in keyof typeof VIEW_TIMES]: number };

/**
 * Limits for a caller (a test, a smaller window) that may only narrow them (review lesson): a value must be a finite
 * number, at least 1 (0 for none of a thing is not a limit), and at most the default. Anything else throws, NaN and
 * Infinity included, so a typo can never lift a limit.
 */
export function narrowLimits<T extends Record<string, number>>(base: T, o: Partial<Record<keyof T, number>> = {}): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(o) as [keyof T & string, number | undefined][]) {
    if (v === undefined) continue;
    if (!Object.hasOwn(base, k)) throw new RangeError(`no such limit: ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > base[k]!) {
      throw new RangeError(`limit ${k} may only be narrowed: ${String(v)} is not a number from 1 to ${base[k]}`);
    }
    (out as Record<string, number>)[k] = v;
  }
  return out;
}

/** Times for a test (short polls): each a finite number of ms from 1 to 10 minutes; NaN and Infinity throw. */
export function checkTimes(base: ViewTimes, o: Partial<ViewTimes> = {}): ViewTimes {
  const out = { ...base };
  for (const [k, v] of Object.entries(o) as [keyof ViewTimes, number | undefined][]) {
    if (v === undefined) continue;
    if (!Object.hasOwn(base, k)) throw new RangeError(`no such time: ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 600_000) throw new RangeError(`time ${k} must be a finite number of ms from 1 to 600000`);
    out[k] = v;
  }
  return out;
}
