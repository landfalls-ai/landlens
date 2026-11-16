// What the tables remember (wave 8 part 3, D155) and the selection's rules (D156). Pure, so a test reaches every rule
// without a DOM (apps/desktop/test/table-state.test.ts); Workspace holds the state and writes it back.
//
// Stored in localStorage under `landlens.table.v1`: the columns you hid and the sort you chose per kind
// (`resource` or `resource.group`), and the namespaces you chose per context. The value is read through a tolerant
// parser: at most 200 kinds and 200 contexts, 40 column ids of at most 64 characters a kind, 50 namespaces a context,
// Kubernetes names only; anything else is dropped, and an unreadable value is no choices.
import type { ResourceType } from "@landlens/contracts";
import { actionFits, keyOf, WIDE_DELETES } from "@landlens/kube/action-kinds";

export const TABLE_KEY = "landlens.table.v1";

export type Sort = { id: string; dir: 1 | -1 };
export type TableState = { hidden: Record<string, string[]>; sort: Record<string, Sort>; ns: Record<string, string[]> };
export const NO_TABLE_STATE: TableState = { hidden: {}, sort: {}, ns: {} };

export const MAX_KINDS = 200;
export const MAX_CONTEXTS = 200;
export const MAX_COLUMNS = 40;
export const MAX_COLUMN_ID = 64;
export const MAX_NAMESPACES = 50;
/** The most objects one bulk action takes (D141's 50). */
export const MAX_BULK = 50;

/** A kind's key: `resource` for core kinds, `resource.group` otherwise (lowercase DNS shapes, as discovery gives). */
export const kindKey = (t: Pick<ResourceType, "group" | "resource">) => keyOf(t);

const KIND_KEY = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
/** A namespace's name: a DNS-1123 label. */
export const NAMESPACE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Keys an object can't safely take from stored text (a `__proto__` key would set the prototype). */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

const isKind = (k: string) => k.length <= 253 && KIND_KEY.test(k) && !RESERVED.has(k);
const isContext = (k: string) => k.length > 0 && k.length <= 253 && !CONTROL.test(k) && !RESERVED.has(k);
const isColumn = (c: unknown): c is string => typeof c === "string" && c.length > 0 && c.length <= MAX_COLUMN_ID && !CONTROL.test(c);
const isNamespace = (n: unknown): n is string => typeof n === "string" && NAMESPACE.test(n);

const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Each key that passes, with its value made good; a value that can't be is dropped. At most `max` keys. */
function pick<T>(v: unknown, key: (k: string) => boolean, value: (x: unknown) => T | undefined, max: number): Record<string, T> {
  const out: Record<string, T> = {};
  const r = record(v);
  if (!r) return out;
  let n = 0;
  for (const k of Object.keys(r)) {
    if (n >= max) break;
    if (!key(k)) continue;
    const x = value(r[k]);
    if (x === undefined) continue;
    out[k] = x;
    n++;
  }
  return out;
}
const columnList = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.filter(isColumn))].slice(0, MAX_COLUMNS) : undefined);
const nsList = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.filter(isNamespace))].slice(0, MAX_NAMESPACES) : undefined);
const sortOf = (v: unknown): Sort | undefined => {
  const r = record(v);
  return r && isColumn(r.id) && (r.dir === 1 || r.dir === -1) ? { id: r.id, dir: r.dir } : undefined;
};

/** A stored value, or no choices for anything unusable (bad JSON, an old or hand-edited shape). Never throws. */
export function readTableState(raw: string | null): TableState {
  if (raw === null || raw.trim() === "" || raw.length > 512 * 1024) return NO_TABLE_STATE;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return NO_TABLE_STATE;
  }
  const r = record(v);
  if (!r) return NO_TABLE_STATE;
  return {
    hidden: pick(r.hidden, isKind, columnList, MAX_KINDS),
    sort: pick(r.sort, isKind, sortOf, MAX_KINDS),
    ns: pick(r.ns, isContext, nsList, MAX_CONTEXTS),
  };
}

export const writeTableState = (s: TableState): string => JSON.stringify(s);

/** Read from storage; storage that throws is no choices. */
export function loadTableState(storage: Pick<Storage, "getItem">): TableState {
  try {
    return readTableState(storage.getItem(TABLE_KEY));
  } catch {
    return NO_TABLE_STATE;
  }
}
/** Write to storage; storage that throws keeps the choice for this window only and says so with false. */
export function saveTableState(storage: Pick<Storage, "setItem">, s: TableState): boolean {
  try {
    storage.setItem(TABLE_KEY, writeTableState(s));
    return true;
  } catch {
    return false;
  }
}

/** Drops the oldest entry of a map past its cap, so a new choice is always kept. */
function capped<T>(m: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(m);
  if (keys.length <= max) return m;
  const out: Record<string, T> = {};
  for (const k of keys.slice(keys.length - max)) out[k] = m[k]!;
  return out;
}
function without<T>(m: Record<string, T>, k: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of Object.keys(m)) if (x !== k) out[x] = m[x]!;
  return out;
}

/** The columns hidden for a kind (Name never is). An empty list forgets the kind. */
export function withHidden(s: TableState, kind: string, ids: string[]): TableState {
  if (!isKind(kind)) return s;
  const clean = [...new Set(ids.filter((c) => isColumn(c) && c !== "name"))].slice(0, MAX_COLUMNS);
  const rest = without(s.hidden, kind);
  return { ...s, hidden: clean.length ? capped({ ...rest, [kind]: clean }, MAX_KINDS) : rest };
}
/** The sort chosen for a kind. */
export function withSort(s: TableState, kind: string, sort: Sort): TableState {
  if (!isKind(kind) || !sortOf(sort)) return s;
  return { ...s, sort: capped({ ...without(s.sort, kind), [kind]: { id: sort.id, dir: sort.dir } }, MAX_KINDS) };
}
/** The namespaces chosen in a context (none: all of them). */
export function withNamespaces(s: TableState, context: string, ns: string[]): TableState {
  if (!isContext(context)) return s;
  const clean = [...new Set(ns.filter(isNamespace))].slice(0, MAX_NAMESPACES);
  const rest = without(s.ns, context);
  return { ...s, ns: clean.length ? capped({ ...rest, [context]: clean }, MAX_CONTEXTS) : rest };
}

/** "All namespaces", the one name, or "3 namespaces": the toolbar button's words. */
export const namespacesLabel = (ns: string[]) => (!ns.length ? "All namespaces" : ns.length === 1 ? ns[0]! : `${ns.length} namespaces`);

/**
 * How a list of a namespaced kind is watched for the namespaces chosen (D158): none, the whole cluster; one, that
 * namespace; two to eight, one watch each, merged by uid; more, the whole cluster filtered in the window (and, if the
 * account can't list across namespaces, the first eight).
 */
export const MAX_WATCHES = 8;
export function watchPlan(ns: string[], allRefused = false): { all: true; filter?: string[] } | { each: string[]; cut?: number } {
  if (!ns.length) return { all: true };
  if (ns.length <= MAX_WATCHES) return { each: ns };
  return allRefused ? { each: ns.slice(0, MAX_WATCHES), cut: ns.length - MAX_WATCHES } : { all: true, filter: ns };
}

// The selection (D156): uids of the current list only.

/** Toggle one row. */
export function toggled(sel: ReadonlySet<string>, uid: string): Set<string> {
  const out = new Set(sel);
  if (out.has(uid)) out.delete(uid);
  else out.add(uid);
  return out;
}
/**
 * Shift+click: every row from the last toggled one (the anchor) to this one, in the order the table shows, takes the
 * state the clicked row takes. Without an anchor still in the list, it is a single toggle.
 */
export function rangeToggled(sel: ReadonlySet<string>, order: readonly string[], anchor: string | undefined, uid: string): Set<string> {
  const to = order.indexOf(uid);
  const from = anchor === undefined ? -1 : order.indexOf(anchor);
  if (to < 0 || from < 0) return toggled(sel, uid);
  const on = !sel.has(uid);
  const out = new Set(sel);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    if (on) out.add(order[i]!);
    else out.delete(order[i]!);
  }
  return out;
}
/** What stays selected when the watch changes: only uids still listed. The same set when nothing left. */
export function pruned(sel: ReadonlySet<string>, present: Iterable<string>): ReadonlySet<string> {
  if (!sel.size) return sel;
  const here = new Set(present);
  for (const uid of sel) if (!here.has(uid)) return new Set([...sel].filter((u) => here.has(u)));
  return sel;
}
/** The head's tri-state checkbox over the rows the filter shows. */
export function headState(sel: ReadonlySet<string>, shown: readonly string[]): "none" | "some" | "all" {
  const n = shown.filter((u) => sel.has(u)).length;
  return n === 0 ? "none" : n === shown.length ? "all" : "some";
}
/** The head's click: all shown rows on, or (when all are) off; rows outside the filter keep their state. */
export function headToggled(sel: ReadonlySet<string>, shown: readonly string[]): Set<string> {
  const out = new Set(sel);
  if (headState(sel, shown) === "all") for (const u of shown) out.delete(u);
  else for (const u of shown) out.add(u);
  return out;
}

/**
 * The actions a kind has in bulk (D156): Restart for the three workload kinds, Delete for any kind that deletes and
 * isn't one main deletes one at a time (D141). Every bulk apply still goes through main's rules (D143).
 */
export function bulkActions(t: Pick<ResourceType, "group" | "resource" | "verbs">): ("restart" | "delete")[] {
  const out: ("restart" | "delete")[] = [];
  if (actionFits("restart", t)) out.push("restart");
  if (actionFits("delete", t) && !WIDE_DELETES.has(keyOf(t))) out.push("delete");
  return out;
}
