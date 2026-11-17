// What a view says back to Claude about its sources (D205, D215): states and counts from a closed vocabulary, never a
// row, a cell or the cluster's text. And the cut that keeps one message to a frame under VIEW_LIMITS.frameMessage
// (part 1's security review: a source could push 2,000 rows × 24 fields × 2,000 characters a second).
import type { SourceData, ViewSourceState } from "@landlens/contracts";
import { VIEW_LIMITS } from "./limits.js";
import { SENTENCES } from "./errors.js";

export type StatusLike = { state: ViewSourceState; message?: string; rows: number; total: number; truncated: boolean };

/**
 * The states whose message is one of D222's sentences built from checked names only (the document's own ids and
 * kinds, the session's namespaces, an HTTP status). An `unavailable` source's message may be a usage reader's own
 * reason, and `ok`'s notes may name what was cut: Claude gets a fixed sentence for the one and nothing for the other.
 */
const SAYS: ReadonlySet<ViewSourceState> = new Set(["forbidden", "unknown", "off", "error"]);

/** One line per source: `<id>: <state>, <rows> rows[, cut at 2000][. <sentence>]`. */
export function statusLine(id: string, s: StatusLike): string {
  const cut = s.total > s.rows ? `, cut at ${s.rows}` : "";
  const why = SAYS.has(s.state) && s.message ? ` ${s.message}` : s.state === "unavailable" ? ` ${SENTENCES.metricsOff}` : "";
  return `${id}: ${s.state}, ${s.rows} ${s.rows === 1 ? "row" : "rows"}${cut}.${why}`;
}

export function statusLines(sources: Record<string, StatusLike>): string[] {
  return Object.entries(sources).map(([id, s]) => statusLine(id, s));
}

const size = (v: unknown) => JSON.stringify(v).length;

/**
 * A source's data cut to fit `max` characters as JSON (rows dropped from the end, halving, then one at a time), with
 * `truncated` set and D222's sentence. Lines and a series are kept whole or dropped the same way.
 */
export function fitData(data: SourceData, max: number = VIEW_LIMITS.frameMessage): SourceData {
  if (size(data) <= max) return data;
  let d: SourceData = { ...data, truncated: true };
  if (d.lines) {
    let lines = d.lines;
    while (lines.length && size({ ...d, lines }) > max) lines = lines.slice(Math.ceil(lines.length / 2));
    d = { ...d, lines, message: SENTENCES.logOlder };
  }
  if (d.series && size(d) > max) {
    const { series: _drop, ...rest } = d;
    d = rest;
  }
  let rows = d.rows;
  let n = rows.length;
  while (n > 0 && size({ ...d, rows: rows.slice(0, n) }) > max) n = Math.floor(n / 2);
  // Grow back one at a time from the half that fits, at most a few hundred steps.
  let step = Math.max(1, Math.floor(n / 16));
  while (step >= 1 && n < rows.length) {
    if (size({ ...d, rows: rows.slice(0, n + step) }) <= max) n += step;
    else if (step === 1) break;
    else step = Math.floor(step / 2);
  }
  rows = rows.slice(0, n);
  return { ...d, rows, message: SENTENCES.rowsTooBig(rows.length) };
}
