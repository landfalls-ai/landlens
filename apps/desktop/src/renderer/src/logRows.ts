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
// Everything else a container can write that isn't text: OSC ended by ESC \, DCS/SOS/PM/APC strings, CSI with
// intermediate bytes, two-byte escapes, a lone ESC; then C0 controls but tab, DEL and C1 (security review, wave 4
// part 1, finding 7). Bidi controls become visible marks, so copied text reads as it looks.
// eslint-disable-next-line no-control-regex
const ESC_ANY = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|\x1b/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const bidiMark = (c: string) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;
/** One line as plain text: for Copy, Download and Ask Claude. */
export const plain = (t: string) => t.replace(ESC, "").replace(ESC_ANY, "").replace(CONTROLS, "").replace(BIDI, bidiMark);

/**
 * What a paste into a pod would send, and whether to ask first (D9; security review, wave 4 part 1, finding 3). Escape
 * characters are removed, so the text can't end bracketed paste early (`ESC[201~`) or send keys. It asks when the
 * text holds a line break of any kind (a lone CR is Enter too) or any other control character but tab, since either
 * runs something the moment it lands.
 */
export function pasteCheck(text: string): { clean: string; ask: boolean; lines: number; preview: string[] } {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x1b\x9b]/g, "");
  const parts = clean.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
  // eslint-disable-next-line no-control-regex
  const ask = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(clean);
  // eslint-disable-next-line no-control-regex
  const visible = (l: string) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === "\x7f" ? "^?" : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`)).replace(/[\x80-\x9f]/g, "�");
  const preview = parts.slice(0, 3).map((l) => { const v = visible(l); return v.length > 100 ? `${v.slice(0, 100)}…` : v; });
  return { clean, ask, lines: parts.length, preview };
}

/**
 * Plain text, case-insensitive; `/…/` is a regex. A regex with a quantified group that itself repeats (`(a+)+`,
 * `(\w*)*`, `(x|y+){2,}`) or a backreference is refused: on a line a container wrote to make it backtrack, it could
 * freeze the window (security review, wave 4 part 1, finding 6). `findHits` also cuts lines and stops on a budget.
 */
export function matcher(q: string): RegExp | undefined {
  if (!q) return undefined;
  const re = /^\/(.+)\/$/.exec(q);
  if (re && (/\([^)]*[+*}][^)]*\)\s*[+*{?]/.test(re[1]!) || /\\[1-9]|\\k</.test(re[1]!))) return undefined;
  try {
    return new RegExp(re ? re[1]! : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return undefined;
  }
}


/** How much of a line search reads, and how long one search may run before it stops. */
export const SEARCH_LINE = 2048;
export const SEARCH_BUDGET_MS = 60;

/** The rows that match, or `slow` when the search ran past its budget (the rows found so far are kept). */
export function findHits(rows: { text: string; mark?: unknown }[], re: RegExp | undefined, now: () => number = () => performance.now()): { hits: number[]; slow: boolean } {
  if (!re) return { hits: [], slow: false };
  const start = now();
  const hits: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.mark) continue;
    re.lastIndex = 0;
    if (re.test(plain(r.text.length > SEARCH_LINE ? r.text.slice(0, SEARCH_LINE) : r.text))) hits.push(i);
    if ((i & 255) === 255 && now() - start > SEARCH_BUDGET_MS) return { hits, slow: true };
  }
  return { hits, slow: false };
}
