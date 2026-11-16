// What the Views page's native blocks draw (wave 10 part 3, D206, D218), as pure functions over a source's rows: a
// cell's words by its column's format, a tone from the closed set, a table's columns for ResourceTable, a stat, a
// chart's bars and lines, a list, the selection's actions. Every value becomes text here and a React text node in the
// block: nothing a source delivers is ever markup. No React, so the tests run in Node (view-blocks.test.ts).
import type { KubeObject, ResourceType, RowRef, ViewRow, ViewTone } from "@landlens/contracts";
import { age } from "@landlens/kube/status";
import type { Cell, Column } from "./kinds";
import { bulkActions, type Sort } from "./tableState";

export type Format = "text" | "number" | "age" | "bytes" | "cpu" | "percent" | "status" | "ref" | "mono";
export type ColumnDoc = { field: string; header?: string; format?: Format; width?: number; toneField?: string };
export type ChartUnit = "cpu" | "bytes" | "count" | "percent";
/** A block as the validated document has it (packages/views' Block; the page reads only these fields). */
export type BlockDoc = {
  type: "table" | "stat" | "chart" | "list" | "logs" | "problems" | "text" | "app";
  source?: string; span?: number; title?: string;
  columns?: ColumnDoc[]; rowActions?: boolean; select?: boolean;
  field?: string; label?: string; format?: Format; toneField?: string; sparkField?: string;
  kind?: "line" | "area" | "bar"; x?: string; y?: string[]; unit?: ChartUnit;
  primary?: string; secondary?: string; max?: number;
  failuresOnly?: boolean; markdown?: string;
  id?: string; uses?: string[]; fill?: boolean; minHeight?: number;
};

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
export function bytesWords(v: number): string {
  let n = v;
  let i = 0;
  while (Math.abs(n) >= 1024 && i < UNITS.length - 1) (n /= 1024, i++);
  return `${i ? n.toFixed(Math.abs(n) < 10 ? 1 : 0) : Math.round(n)} ${UNITS[i]}`;
}
export const cpuWords = (v: number) => (Math.abs(v) < 1 ? `${Math.round(v * 1000)}m` : `${Math.round(v * 100) / 100}`);

/** A cell as text, by its column's format. Never markup: an object or a list (which a cell never holds) is nothing. */
export function cellWords(v: unknown, format: Format = "text", now = Date.now()): string {
  if (v === null || v === undefined || typeof v === "object" || typeof v === "function") return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "";
  switch (format) {
    case "age": return age(v, now);
    case "bytes": return bytesWords(v);
    case "cpu": return cpuWords(v);
    case "percent": return `${Math.round(v * 10) / 10}%`;
    case "text": case "status": case "ref": case "mono": return String(v);
    default: return v.toLocaleString("en-US");
  }
}

const TONES: ReadonlySet<string> = new Set(["ok", "warn", "bad", "muted"]);
/** A tone only from the closed set: a field's value picks a class, never writes one. */
export const toneOf = (v: unknown): ViewTone | undefined => (typeof v === "string" && TONES.has(v) ? (v as ViewTone) : undefined);

/** A cell's sort key: a number as a number (an age sorts by its time), anything else by its words. */
export function sortKey(v: unknown, format: Format = "text"): number | string {
  if (typeof v === "number" && Number.isFinite(v)) return format === "age" ? -v : v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return cellWords(v, format);
}

export const refKey = (r: Pick<RowRef, "group" | "resource" | "name"> & { namespace?: string | undefined }) => `${r.group}/${r.resource}/${r.namespace ?? ""}/${r.name}`;
export const refLabel = (r: Pick<RowRef, "kind" | "name"> & { namespace?: string | undefined }) => `${r.kind} ${r.namespace ? `${r.namespace}/` : ""}${r.name}`;

/** A row as ResourceTable takes it: a KubeObject-shaped holder with a stable uid (its object's, else its place). */
export type RowObject = KubeObject & { __row: ViewRow };
export function rowObjects(rows: ViewRow[], primary: string | undefined): RowObject[] {
  const seen = new Map<string, number>();
  return rows.map((row, i) => {
    let uid = row._ref ? refKey(row._ref) : `row-${i}`;
    // Two rows of one object (a join's fan-out): each keeps its own uid.
    const n = seen.get(uid) ?? 0;
    seen.set(uid, n + 1);
    if (n) uid = `${uid}#${n}`;
    const name = cellWords(primary ? row[primary] : undefined) || row._ref?.name || "";
    return { metadata: { uid, name, ...(row._ref?.namespace ? { namespace: row._ref.namespace } : {}) }, __row: row } as RowObject;
  });
}
export const rowOf = (o: KubeObject): ViewRow => (o as RowObject).__row ?? {};

const NUMERIC: ReadonlySet<Format> = new Set(["number", "age", "bytes", "cpu", "percent"]);

/**
 * A table block's columns for ResourceTable: one per document column, its id the field (unique), its words by format,
 * its tone from `toneField` or (a status column) the row's own `_tone`. A width the document gives is kept; the first
 * column is the widest. ResourceTable's narrow-pane rules drop node, ready, age, namespace and restarts by id.
 */
export function tableColumns(cols: ColumnDoc[]): Column[] {
  const used = new Set<string>();
  return cols.map((c, i) => {
    // The field is the id, so ResourceTable's own columns (a status pill, coloured restarts, a quiet namespace, ages,
    // and its narrow-pane drops) apply to a view's column of that name.
    let id = c.field;
    while (used.has(id) || id === "status-icon") id = `${id}_`;
    used.add(id);
    const format = c.format ?? "text";
    const tonePick = (row: ViewRow) => (c.toneField ? toneOf(row[c.toneField]) : format === "status" || c.field === "status" ? row._tone : undefined);
    return {
      id,
      label: c.header ?? c.field,
      ...(c.width ? { width: `${c.width}px` } : i === 0 ? { width: "minmax(160px, 2fr)" } : NUMERIC.has(format) ? { width: "minmax(72px, .6fr)" } : {}),
      ...(NUMERIC.has(format) ? { num: true } : {}),
      cell: (o: KubeObject, now: number): Cell => {
        const row = rowOf(o);
        const v = row[c.field];
        const text = cellWords(v, format, now);
        const tone = tonePick(row);
        return { text, sort: sortKey(v, format), ...(tone ? { tone } : {}), ...(format === "age" && typeof v === "number" ? { title: new Date(v).toLocaleString() } : {}) };
      },
    };
  });
}

/** A stat: the first row's value in its format, its tone, and the values of `sparkField` over the rows for a sparkline. */
export function statOf(rows: ViewRow[], b: Pick<BlockDoc, "field" | "format" | "toneField" | "sparkField">, now = Date.now()): { text: string; tone?: ViewTone; spark: number[] } {
  const r = rows[0];
  const v = r && b.field ? r[b.field] : undefined;
  const text = v === undefined || v === null ? "—" : cellWords(v, b.format ?? "number", now) || "—";
  const tone = r ? (b.toneField ? toneOf(r[b.toneField]) : undefined) : undefined;
  const spark = b.sparkField ? rows.map((x) => x[b.sparkField!]).filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(0, 200) : [];
  return { text, ...(tone ? { tone } : {}), spark };
}

/** A chart's numbers in its unit. */
export function unitWords(unit: ChartUnit | undefined): (v: number) => string {
  switch (unit) {
    case "cpu": return cpuWords;
    case "bytes": return bytesWords;
    case "percent": return (v) => `${Math.round(v * 10) / 10}%`;
    default: return (v) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : `${Math.round(v * 100) / 100}`);
  }
}

/** A bar chart's bars: one per row (x names it), largest first, at most `max`; rows without a number are left out. */
export function barsOf(rows: ViewRow[], x: string | undefined, y: string, max = 20): { key: string; value: number }[] {
  return rows
    .map((r, i) => ({ key: (x ? cellWords(r[x]) : "") || `#${i + 1}`, value: r[y] }))
    .filter((b): b is { key: string; value: number } => typeof b.value === "number" && Number.isFinite(b.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, max);
}

/**
 * A line or area chart's series: y fields over x, in x's order. x is a number (a time in ms or a count) or, when the
 * rows' x isn't numeric, their place. A row without a number for y is a gap in that series.
 */
export function linesOf(rows: ViewRow[], x: string | undefined, ys: string[]): { xs: number[]; time: boolean; series: { key: string; values: (number | null)[] }[] } {
  const numeric = !!x && rows.length > 0 && rows.every((r) => typeof r[x] === "number" && Number.isFinite(r[x]));
  const order = rows.map((r, i) => ({ r, at: numeric ? (r[x!] as number) : i })).sort((a, b) => a.at - b.at).slice(0, 2_000);
  const time = numeric && order.length > 0 && order[0]!.at > 1e12;
  return {
    xs: order.map((o) => o.at),
    time,
    series: ys.map((y) => ({ key: y, values: order.map((o) => (typeof o.r[y] === "number" && Number.isFinite(o.r[y]) ? (o.r[y] as number) : null)) })),
  };
}

/**
 * Whether a bulk may start from a view's selection: never Delete while a block chose any of its rows (D219; security
 * review of part 3, M2). The bar offers by it and the Workspace checks it again before the sheet opens.
 */
export const bulkOffered = (kind: "restart" | "delete", by: "you" | "block") => !(by === "block" && kind === "delete");

/**
 * What the selection bar offers (D156, D219): your own selection gets the kind's bulk actions (Restart, Delete); a
 * selection holding any row a block chose never gets Delete, so nothing destructive starts from a frame, even a click
 * away. Rows of more than one kind get no action (a bulk is one kind), only Ask.
 */
export function selectionActions(type: Pick<ResourceType, "group" | "resource" | "verbs"> | undefined, by: "you" | "block"): ("restart" | "delete")[] {
  if (!type) return [];
  return bulkActions(type).filter((a) => bulkOffered(a, by));
}

/**
 * The chip for an object the drawer over a view asks about: its kind from its own type (discovery), never the
 * drawer's, so another object's ask isn't labelled as the drawer's kind (security review of part 3, L5). None when the
 * kind isn't known, and never a Secret.
 */
export function chipOf(ref: Pick<RowRef, "group" | "version" | "resource" | "name"> & { namespace?: string | undefined }, typeOf: (r: Pick<RowRef, "group" | "resource">) => Pick<ResourceType, "kind"> | undefined): RowRef | undefined {
  if (ref.group === "" && ref.resource === "secrets") return undefined;
  const kind = typeOf(ref)?.kind;
  return kind ? { group: ref.group, version: ref.version, resource: ref.resource, kind, name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) } : undefined;
}

/** The one kind of a set of rows, or undefined when they are of several (or none). */
export function oneKind(refs: RowRef[]): Pick<RowRef, "group" | "version" | "resource" | "kind"> | undefined {
  const r = refs[0];
  if (!r || refs.some((x) => x.group !== r.group || x.resource !== r.resource)) return undefined;
  return { group: r.group, version: r.version, resource: r.resource, kind: r.kind };
}

/** A log line's tone: failures in the bad colour, the rest plain. Only failures with `failuresOnly`. */
export function logLines(lines: { n: number; text: string; failure: boolean }[] | undefined, failuresOnly = false) {
  return (lines ?? []).filter((l) => !failuresOnly || l.failure);
}

/**
 * The sort a table shows (D214's tweak): the person's, while the shown version still has that column; otherwise
 * Claude's order (the source's pipe), which ResourceTable keeps as it came.
 */
export const tweakSort = (sort: Sort | undefined, columns: Pick<Column, "id">[]): Sort => (sort && columns.some((c) => c.id === sort.id) ? sort : { id: "", dir: 1 });
