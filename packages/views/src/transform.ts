// D208: a closed set of eight steps, run in main, pure. No regular expressions, no expressions, no functions of
// anyone's. Rows are read by own property only (a field named like an Object method reads nothing inherited), and a
// row is only ever given the keys its steps declare (fieldsAfter), plus the hidden `_ref` and `_tone`.
import type { Cell } from "./path.js";
import { HIDDEN, type Row } from "./rows.js";
import { VIEW_LIMITS } from "./limits.js";

export type Value = string | number | boolean | { param: string };
export type Op = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith" | "endsWith" | "in" | "exists";
export type Cond = { field: string; op: Op; value?: Value | Value[] };
export type AggFn = "count" | "sum" | "avg" | "min" | "max" | "first" | "countDistinct";
export type Agg = { fn: AggFn; field?: string };
export type JoinOn = { left: string; right: string } | { selector: string; labels: string };
export type PipeStep =
  | { filter: Cond[] }
  | { sort: { field: string; dir?: "asc" | "desc" }[] }
  | { limit: number }
  | { group: { by: string[]; agg: Record<string, Agg> } }
  | { join: { with: string; on: JoinOn; take?: Record<string, string>; agg?: Record<string, Agg> } }
  | { derive: Record<string, { fn: "ratio" | "percent" | "diff" | "sum"; of: [string, string] }> }
  | { rename: Record<string, string> }
  | { pick: string[] };

export type PipeContext = {
  /** The view's parameter values (D206), by name. */
  params: Readonly<Record<string, string>>;
  /** Another source's rows after its own pipe, before the 2,000-row cut (a join's right side). */
  rowsOf: (source: string) => readonly Row[] | undefined;
};

/** A cell of a row, own properties only. */
export const get = (row: Row, f: string): Cell => {
  if (!Object.hasOwn(row, f)) return null;
  const v = row[f];
  return v === undefined || (typeof v === "object" && v !== null) ? null : v;
};

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A number, or a string that is one ("5", "2.5e3"); NaN otherwise. Numbers compare as numbers (D208). */
export function asNumber(v: Cell): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && NUMERIC.test(v.trim())) return Number(v.trim());
  return NaN;
}

const resolve = (v: Value, params: PipeContext["params"]): Cell =>
  typeof v === "object" ? (Object.hasOwn(params, v.param) ? params[v.param]! : null) : v;

/** -1, 0, 1: numbers as numbers when both are; otherwise as strings, by code unit (stable, locale-free). */
export function compare(a: Cell, b: Cell): number {
  const x = asNumber(a);
  const y = asNumber(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0;
  const s = String(a);
  const t = String(b);
  return s < t ? -1 : s > t ? 1 : 0;
}

function holds(row: Row, c: Cond, params: PipeContext["params"]): boolean {
  const v = get(row, c.field);
  if (c.op === "exists") return v !== null && v !== "";
  if (c.op === "in") {
    const list = Array.isArray(c.value) ? c.value : c.value !== undefined ? [c.value] : [];
    return v !== null && list.some((x) => {
      const r = resolve(x, params);
      return r !== null && compare(v, r) === 0;
    });
  }
  const raw = Array.isArray(c.value) ? c.value[0] : c.value;
  const w = raw === undefined ? null : resolve(raw, params);
  if (v === null || w === null) return c.op === "ne" ? v !== w : false;
  switch (c.op) {
    case "eq": return compare(v, w) === 0;
    case "ne": return compare(v, w) !== 0;
    case "gt": return compare(v, w) > 0;
    case "gte": return compare(v, w) >= 0;
    case "lt": return compare(v, w) < 0;
    case "lte": return compare(v, w) <= 0;
    case "contains": return String(v).toLowerCase().includes(String(w).toLowerCase());
    case "startsWith": return String(v).toLowerCase().startsWith(String(w).toLowerCase());
    case "endsWith": return String(v).toLowerCase().endsWith(String(w).toLowerCase());
  }
}

/** One aggregate over rows. Sums and the like take finite numbers only; none is no value, never 0 or NaN. */
export function aggregate(rows: readonly Row[], a: Agg): Cell {
  if (a.fn === "count") return a.field ? rows.reduce((n, r) => (get(r, a.field!) !== null ? n + 1 : n), 0) : rows.length;
  const vals = a.field ? rows.map((r) => get(r, a.field!)).filter((v): v is Exclude<Cell, null> => v !== null) : [];
  if (a.fn === "first") return vals[0] ?? null;
  if (a.fn === "countDistinct") return new Set(vals.map((v) => `${typeof v}:${String(v)}`)).size;
  const nums = vals.map(asNumber).filter((n) => !Number.isNaN(n));
  if (!nums.length) return null;
  let out: number;
  switch (a.fn) {
    case "sum": out = nums.reduce((s, n) => s + n, 0); break;
    case "avg": out = nums.reduce((s, n) => s + n, 0) / nums.length; break;
    case "min": out = nums.reduce((m, n) => (n < m ? n : m), Infinity); break;
    case "max": out = nums.reduce((m, n) => (n > m ? n : m), -Infinity); break;
  }
  return Number.isFinite(out) ? out : null;
}

const keep = (from: Row, into: Row) => {
  for (const h of HIDDEN) if (Object.hasOwn(from, h)) (into as Record<string, unknown>)[h] = from[h];
  return into;
};

/** `k=v, k2=v2` (what `$labels` and `$selector` make) as pairs; anything unshaped is no pair. */
export function parsePairs(v: Cell): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof v !== "string") return out;
  for (const part of v.split(", ").slice(0, 100)) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

function join(rows: readonly Row[], j: Extract<PipeStep, { join: unknown }>["join"], ctx: PipeContext): Row[] {
  const right = ctx.rowsOf(j.with) ?? [];
  const matchesOf: (r: Row) => Row[] = "left" in j.on
    ? (() => {
        const on = j.on as { left: string; right: string };
        const index = new Map<string, Row[]>();
        for (const r of right) {
          const k = get(r, on.right);
          if (k === null) continue;
          const key = `${typeof k === "number" ? "n" : "s"}:${String(k)}`;
          const list = index.get(key);
          if (list) list.push(r);
          else index.set(key, [r]);
        }
        return (l: Row) => {
          const k = get(l, on.left);
          if (k === null) return [];
          const n = asNumber(k);
          return index.get(`s:${String(k)}`) ?? (Number.isNaN(n) ? undefined : index.get(`n:${String(n)}`)) ?? index.get(`s:${String(n)}`) ?? [];
        };
      })()
    : (() => {
        const on = j.on as { selector: string; labels: string };
        const labelled = right.map((r) => ({ r, labels: parsePairs(get(r, on.labels)) }));
        return (l: Row) => {
          const sel = parsePairs(get(l, on.selector));
          // As Kubernetes reads a Service's selector: an empty one selects nothing.
          if (!sel.size) return [];
          return labelled.filter(({ labels }) => [...sel].every(([k, v]) => labels.get(k) === v)).map(({ r }) => r);
        };
      })();
  return rows.map((l) => {
    const m = matchesOf(l);
    const out: Row = keep(l, { ...withoutHidden(l) });
    for (const [to, from] of Object.entries(j.take ?? {})) out[to] = m.length ? get(m[0]!, from) : null;
    for (const [to, a] of Object.entries(j.agg ?? {})) out[to] = aggregate(m, a);
    return out;
  });
}

function withoutHidden(r: Row): Row {
  const out: Row = {};
  for (const k of Object.keys(r)) if (!(HIDDEN as readonly string[]).includes(k)) out[k] = r[k];
  return out;
}

/** Run one step. */
export function runStep(rows: readonly Row[], step: PipeStep, ctx: PipeContext): Row[] {
  if ("filter" in step) return rows.filter((r) => step.filter.every((c) => holds(r, c, ctx.params)));
  if ("sort" in step) {
    const keys = step.sort;
    return rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        for (const k of keys) {
          const x = get(a.r, k.field);
          const y = get(b.r, k.field);
          // No value sorts last whichever way.
          if (x === null || y === null) {
            if (x === y) continue;
            return x === null ? 1 : -1;
          }
          const c = compare(x, y);
          if (c) return k.dir === "desc" ? -c : c;
        }
        return a.i - b.i;
      })
      .map(({ r }) => r);
  }
  if ("limit" in step) return rows.slice(0, step.limit);
  if ("group" in step) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = JSON.stringify(step.group.by.map((f) => get(r, f)));
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    // `by: []` is one total row, also over no rows (a count of 0, not nothing).
    if (!step.group.by.length && !groups.size) groups.set("[]", []);
    return [...groups.values()].map((g) => {
      const out: Row = {};
      for (const f of step.group.by) out[f] = g.length ? get(g[0]!, f) : null;
      for (const [to, a] of Object.entries(step.group.agg)) out[to] = aggregate(g, a);
      return out;
    });
  }
  if ("join" in step) return join(rows, step.join, ctx);
  if ("derive" in step) {
    return rows.map((r) => {
      const out: Row = keep(r, { ...withoutHidden(r) });
      for (const [to, d] of Object.entries(step.derive)) {
        const a = asNumber(get(r, d.of[0]));
        const b = asNumber(get(r, d.of[1]));
        let v = NaN;
        if (d.fn === "ratio") v = b === 0 ? NaN : a / b;
        else if (d.fn === "percent") v = b === 0 ? NaN : (a / b) * 100;
        else if (d.fn === "diff") v = a - b;
        else v = a + b;
        out[to] = Number.isFinite(v) ? v : null;
      }
      return out;
    });
  }
  if ("rename" in step) {
    return rows.map((r) => {
      const out: Row = {};
      for (const k of Object.keys(r)) {
        if ((HIDDEN as readonly string[]).includes(k)) continue;
        const to = Object.hasOwn(step.rename, k) ? step.rename[k]! : k;
        out[to] = r[k];
      }
      return keep(r, out);
    });
  }
  return rows.map((r) => {
    const out: Row = {};
    for (const f of step.pick) out[f] = get(r, f);
    return keep(r, out);
  });
}

/** Run a pipe (at most VIEW_LIMITS.steps steps; the schema refused longer). */
export function runPipe(rows: readonly Row[], pipe: readonly PipeStep[] | undefined, ctx: PipeContext): Row[] {
  let out = rows.slice();
  for (const step of (pipe ?? []).slice(0, VIEW_LIMITS.steps)) out = runStep(out, step, ctx);
  return out;
}

/** The fields a step's rows can have, from the fields before it (the property test's contract). */
export function fieldsAfter(step: PipeStep, before: ReadonlySet<string>): Set<string> {
  if ("filter" in step || "sort" in step || "limit" in step) return new Set(before);
  if ("group" in step) return new Set([...step.group.by, ...Object.keys(step.group.agg)]);
  if ("join" in step) return new Set([...before, ...Object.keys(step.join.take ?? {}), ...Object.keys(step.join.agg ?? {})]);
  if ("derive" in step) return new Set([...before, ...Object.keys(step.derive)]);
  if ("rename" in step) return new Set([...before].map((k) => (Object.hasOwn(step.rename, k) ? step.rename[k]! : k)));
  return new Set(step.pick);
}

/** The 2,000-row cut a source's rows get after its pipe (D225). */
export function deliver(rows: readonly Row[], max: number = VIEW_LIMITS.rows): { rows: Row[]; total: number; truncated: boolean } {
  return rows.length > max ? { rows: rows.slice(0, max), total: rows.length, truncated: true } : { rows: rows.slice(), total: rows.length, truncated: false };
}
