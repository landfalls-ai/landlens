// A unified line diff for the change review: what an object looks like now against what the dry run says it will
// look like. Longest common subsequence over lines, then unchanged runs folded to a few lines of context.
import type { DiffLine } from "@landlens/contracts";

/** Lines beyond which the diff gives up matching and shows a full replace (n × m cells). */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  const raw = a.length * b.length > MAX_CELLS ? replaceAll(a, b) : lcs(a, b);
  let added = 0;
  let removed = 0;
  for (const l of raw) {
    if (l.t === "+") added++;
    else if (l.t === "-") removed++;
  }
  return { lines: fold(raw, context), added, removed };
}

function replaceAll(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text, i) => ({ t: "-" as const, text, oldNo: i + 1 })),
    ...b.map((text, i) => ({ t: "+" as const, text, newNo: i + 1 })),
  ];
}

function lcs(a: string[], b: string[]): DiffLine[] {
  // Trim the common head and tail first: most changes touch a few lines of a long object.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  // table[i][j]: LCS length of am[i..] and bm[j..]
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = am[i] === bm[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ t: " ", text: a[k]!, oldNo: k + 1, newNo: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      out.push({ t: " ", text: am[i]!, oldNo: head + i + 1, newNo: head + j + 1 });
      i++;
      j++;
    } else if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      out.push({ t: "+", text: bm[j]!, newNo: head + j + 1 });
      j++;
    } else {
      out.push({ t: "-", text: am[i]!, oldNo: head + i + 1 });
      i++;
    }
  }
  for (let k = 0; k < tail; k++) {
    out.push({ t: " ", text: a[a.length - tail + k]!, oldNo: a.length - tail + k + 1, newNo: b.length - tail + k + 1 });
  }
  // Show removals before additions within a changed run, as unified diffs do.
  return orderRuns(out);
}

function orderRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let minus: DiffLine[] = [];
  let plus: DiffLine[] = [];
  const flush = () => {
    out.push(...minus, ...plus);
    minus = [];
    plus = [];
  };
  for (const l of lines) {
    if (l.t === "-") minus.push(l);
    else if (l.t === "+") plus.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out;
}

/** Keep `context` unchanged lines around each change; a longer unchanged run becomes one "…" line. */
function fold(lines: DiffLine[], context: number): DiffLine[] {
  if (!lines.some((l) => l.t !== " ")) return lines.length ? [{ t: "…", text: `${lines.length} unchanged lines` }] : [];
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ t: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ t: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}
