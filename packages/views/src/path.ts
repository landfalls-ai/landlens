// A field's path into an object (D207): a small reader that never evaluates anything. Names, quoted keys (for label
// and annotation keys), indexes 0–99 and `[*]`; at most 8 segments and 200 characters; never `__proto__`,
// `constructor` or `prototype`; own properties only, so nothing inherited is ever read. `[*]` joins at most 20 values
// with ", " and visits a bounded number of elements, so a 300,000-item array costs no more than a short one. Or one of
// the computed names (computed.ts), each one function over the object.
import { COMPUTED, computed, type ComputedName, type OwnerIndex } from "./computed.js";
import { cellText } from "./text.js";

export type Cell = string | number | boolean | null;
export type Segment = { key: string } | { index: number } | { all: true };
export type ParsedPath = { computed: ComputedName } | { segments: Segment[] };

export const PATH_LIMITS = { chars: 200, segments: 8, index: 99, values: 20, visits: 1_000, quoted: 253 } as const;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*/;
const QUOTED = /^\["([^"\\\u0000-\u001f\u007f]{1,253})"\]/;
const INDEX = /^\[(\d{1,2})\]/;

/** Parse a path, or say what is wrong with it in a fixed sentence. */
export function parsePath(p: string): ParsedPath | { error: string } {
  if (p.length === 0) return { error: "a path can't be empty" };
  if (p.length > PATH_LIMITS.chars) return { error: `a path is at most ${PATH_LIMITS.chars} characters` };
  if (p.startsWith("$")) {
    return (COMPUTED as readonly string[]).includes(p) ? { computed: p as ComputedName } : { error: "not a computed name Landlens knows" };
  }
  const segments: Segment[] = [];
  let rest = p;
  let first = true;
  while (rest.length) {
    let m: RegExpExecArray | null;
    if (rest.startsWith("[*]")) {
      segments.push({ all: true });
      rest = rest.slice(3);
    } else if ((m = INDEX.exec(rest))) {
      const n = Number(m[1]);
      if (n > PATH_LIMITS.index) return { error: `an index is at most ${PATH_LIMITS.index}` };
      segments.push({ index: n });
      rest = rest.slice(m[0].length);
    } else if ((m = QUOTED.exec(rest))) {
      if (FORBIDDEN.has(m[1]!)) return { error: "a path can't name __proto__, constructor or prototype" };
      segments.push({ key: m[1]! });
      rest = rest.slice(m[0].length);
    } else {
      if (!first) {
        if (!rest.startsWith(".")) return { error: "a path's parts are joined by . or [ ]" };
        rest = rest.slice(1);
      }
      m = NAME.exec(rest);
      if (!m) return { error: "a path's part must be a name, [n], [*] or [\"key\"]" };
      if (FORBIDDEN.has(m[0])) return { error: "a path can't name __proto__, constructor or prototype" };
      segments.push({ key: m[0] });
      rest = rest.slice(m[0].length);
    }
    first = false;
    if (segments.length > PATH_LIMITS.segments) return { error: `a path has at most ${PATH_LIMITS.segments} parts` };
  }
  return { segments };
}

export type ReadContext = {
  /** The kind when the object doesn't say (list items carry it once watch.ts fills it; plain rows don't). */
  kind?: string;
  /** The kind's API group, when known: kubectl's words for a Pod or a Node are core's only (computed.ts). */
  group?: string;
  owners?: OwnerIndex;
  now?: number;
};

const own = (o: unknown, k: string): unknown =>
  o !== null && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/** A scalar as a cell; anything else (an object, a list) is no value. */
export function toCell(v: unknown): Cell {
  if (typeof v === "string") return cellText(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  return null;
}

/** Read a parsed path from an object as one cell. */
export function readPath(obj: unknown, p: ParsedPath, ctx: ReadContext = {}): Cell {
  if ("computed" in p) return computed(p.computed, obj, ctx);
  const values: unknown[] = [];
  let visits = 0;
  let more = false;
  let many = false;
  const walk = (o: unknown, i: number): void => {
    if (values.length >= PATH_LIMITS.values) {
      more = true;
      return;
    }
    if (++visits > PATH_LIMITS.visits) {
      more = true;
      return;
    }
    if (i === p.segments.length) {
      if (o !== undefined && o !== null && typeof o !== "object") values.push(o);
      return;
    }
    const s = p.segments[i]!;
    if ("all" in s) {
      many = true;
      if (!Array.isArray(o)) return;
      // A bounded loop over the array, never a spread or a map of all of it.
      for (let j = 0; j < o.length; j++) {
        if (more) return;
        walk(o[j], i + 1);
      }
      return;
    }
    if ("index" in s) {
      if (Array.isArray(o) && s.index < o.length) walk(o[s.index], i + 1);
      return;
    }
    const v = own(o, s.key);
    if (v !== undefined) walk(v, i + 1);
  };
  walk(obj, 0);
  if (!many) return toCell(values[0]);
  if (!values.length) return null;
  const joined = values.map((v) => (typeof v === "number" && !Number.isFinite(v) ? "" : String(v))).join(", ");
  return cellText(more ? `${joined}, …` : joined);
}
