// Log rows: ordering by the API server's timestamps, merging pods' batches, ANSI colours, and search. Pure, so it is
// tested without a window (apps/desktop/test/log-rows.test.ts).

export type Row = { key: number; k: string; ts: string; text: string; pod?: string; mark?: boolean };

/** A sortable key for an RFC 3339 time: fractions padded to nanoseconds ("…:00.12Z" sorts before "…:00.123Z"). */
export function tsKey(ts: string): string {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(ts);
  return m ? `${m[1]}.${(m[2] ?? "").padEnd(9, "0").slice(0, 9)}Z` : ts;
}

/** Merge a batch (in order) into rows (in order). */
export function mergeRows(rows: Row[], batch: Row[]): Row[] {
  if (!batch.length) return rows;
  if (!rows.length || rows[rows.length - 1]!.k <= batch[0]!.k) return rows.concat(batch);
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.k <= batch[0]!.k) lo = mid + 1;
    else hi = mid;
  }
  const head = rows.slice(0, lo);
  const tail = rows.slice(lo);
  const out = head;
  let i = 0, j = 0;
  while (i < tail.length || j < batch.length) {
    if (j >= batch.length || (i < tail.length && tail[i]!.k <= batch[j]!.k)) out.push(tail[i++]!);
    else out.push(batch[j++]!);
  }
  return out;
}

// ANSI: colours map to the terminal tokens, bold and dim are kept, everything else is dropped (D18).
const SGR_COLOURS: Record<number, string> = { 30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white" };
// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
export function ansi(text: string): { text: string; cls?: string }[] {
  if (!text.includes("\x1b")) return [{ text }];
  const out: { text: string; cls?: string }[] = [];
  let colour: string | undefined, bold = false, dim = false, at = 0;
  const cls = () => [colour && `a-${colour}`, bold && "a-b", dim && "a-d"].filter(Boolean).join(" ") || undefined;
  for (const m of text.matchAll(ESC)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), ...(cls() ? { cls: cls()! } : {}) });
    at = m.index! + m[0].length;
    if (m[1] === undefined) continue;
    for (const p of (m[1] || "0").split(";").map(Number)) {
      if (p === 0) (colour = undefined, bold = false, dim = false);
      else if (p === 1) bold = true;
      else if (p === 2) dim = true;
      else if (p === 22) (bold = false, dim = false);
      else if (p === 39) colour = undefined;
      else if (SGR_COLOURS[p]) colour = SGR_COLOURS[p];
      else if (SGR_COLOURS[p - 60]) colour = SGR_COLOURS[p - 60];
    }
  }
  if (at < text.length) out.push({ text: text.slice(at), ...(cls() ? { cls: cls()! } : {}) });
  return out;
}
// eslint-disable-next-line no-control-regex
export const plain = (t: string) => t.replace(ESC, "");

/** Plain text, case-insensitive; `/…/` is a regex. */
export function matcher(q: string): RegExp | undefined {
  if (!q) return undefined;
  const re = /^\/(.+)\/$/.exec(q);
  try {
    return new RegExp(re ? re[1]! : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return undefined;
  }
}

