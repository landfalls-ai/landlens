// Text in a view, both ways. Out of the cluster (cells, log lines): whitespace runs become one space, every invisible
// character goes (gcp's `clean`: control, format, line and paragraph separators, private-use, unassigned, lone
// surrogates, variation selectors, the blank letters), credential shapes are redacted, and only then is it cut, so a
// key across the cut is taken whole (kube's `scrubCut`). Into a document (Claude's titles, labels, markdown): the
// same characters are refused rather than dropped, so Claude sees why; variation selectors alone are dropped, so an
// emoji keeps its picture.
import { clean } from "@landlens/gcp";
import { scrubCut } from "@landlens/kube";
import { VIEW_LIMITS } from "./limits.js";

const ALL = Number.MAX_SAFE_INTEGER;

/** A cell's string (or a log line): one line, nothing invisible, scrubbed, then at most `max` characters. */
export function cellText(s: string, max: number = VIEW_LIMITS.cell): string {
  const one = clean(s.replace(/\s+/g, " "), ALL).trim();
  const { text, cut } = scrubCut(one, max);
  // A cut can split a surrogate pair: clean again takes the half away.
  const out = clean(text, ALL);
  if (!cut) return out;
  // Room for the ellipsis, and never half a surrogate pair at the end.
  const head = out.slice(0, Math.max(0, max - 1));
  return `${/[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head}…`;
}

const SELECTORS = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** Claude's text with its variation selectors dropped; `invisible` says whether anything else invisible is left. */
export function docText(s: string, lines = false): { text: string; invisible: boolean } {
  const text = (lines ? s.replace(/\r\n?/g, "\n") : s).replace(SELECTORS, "");
  const parts = lines ? text.split("\n").map((p) => p.replace(/\t/g, " ")) : [text];
  return { text, invisible: parts.some((p) => clean(p, ALL) !== p) };
}
