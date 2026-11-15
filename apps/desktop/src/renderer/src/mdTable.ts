// GitHub-style Markdown tables for the dock's Markdown (Markdown.tsx): a header row, a separator row of dashes, then
// body rows. Pure, so it is tested without a DOM; cells stay text and are rendered with the same inline rules.

export type Align = "left" | "center" | "right" | undefined;
export type MdTable = { head: string[]; align: Align[]; rows: string[][]; end: number };

/** At most this many rows and columns are shown; the rest is counted under the table. */
export const TABLE_MAX = { rows: 200, cols: 12 } as const;

const SEP_CELL = /^\s*:?-{3,}:?\s*$/;

/** A row's cells: split on `|` outside backticks and not escaped, the outer pipes dropped. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isRow = (line: string | undefined) => !!line && line.includes("|") && line.trim().length > 0;

/** A table starting at lines[i], or undefined when lines[i] and lines[i + 1] aren't a header and its separator. */
export function parseTable(lines: string[], i: number): MdTable | undefined {
  const headLine = lines[i];
  const sepLine = lines[i + 1];
  if (!isRow(headLine) || !sepLine || !sepLine.includes("-")) return undefined;
  const sep = splitRow(sepLine);
  if (!sep.length || !sep.every((c) => SEP_CELL.test(c))) return undefined;
  const head = splitRow(headLine!);
  if (head.length !== sep.length) return undefined;
  const align: Align[] = sep.map((c) => {
    const t = c.trim();
    const l = t.startsWith(":");
    const r = t.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : undefined;
  });
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && isRow(lines[j]) && !/^\s*```/.test(lines[j]!)) {
    const cells = splitRow(lines[j]!);
    // Short rows are padded and long ones cut to the header's width, as GitHub does.
    rows.push(Array.from({ length: head.length }, (_, k) => cells[k] ?? ""));
    j++;
  }
  return { head, align, rows, end: j };
}

/** Whether a table starts here: the paragraph rule stops before one. */
export const tableStarts = (lines: string[], i: number) => parseTable(lines, i) !== undefined;
