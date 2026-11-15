// Custom resources' columns (D40): the served version's additionalPrinterColumns (priority 0), read from the CRD,
// between Name/Namespace and Age, plus a Status column from a Ready or Available condition.
//
// Printer columns use kubectl's JSONPath without braces. This reads the subset CRDs use, without eval: `.a.b`,
// `['a.b']`, `[0]`, `[-1]`, `[*]` and filters `[?(@.type=="Ready")]` (== and != against a string, number or
// boolean). Anything else (`..`, ranges, functions) reads as nothing.
import type { KubeObject } from "@landlens/contracts";
import { age, type Tone } from "@landlens/kube/status";
import type { Cell, Column } from "./kinds";

export type PrinterColumn = { name: string; type: string; format?: string; jsonPath: string; description?: string; priority?: number };

type Step = { key: string } | { index: number } | { all: true } | { filter: string[]; op: "==" | "!="; value: unknown };

const MAX_PATH = 512;
const MAX_RESULTS = 50;

/** Parse a JSONPath into steps, or undefined when it uses anything this reader doesn't. */
export function parsePath(path: string): Step[] | undefined {
  let p = path.trim();
  if (p.startsWith("{") && p.endsWith("}")) p = p.slice(1, -1).trim();
  if (!p || p.length > MAX_PATH || p.includes("..")) return undefined;
  if (p.startsWith("$")) p = p.slice(1);
  const steps: Step[] = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === ".") {
      // A dotted name; `\.` is a dot inside the name (kubectl's escape for label keys).
      let key = "";
      i++;
      while (i < p.length && p[i] !== "." && p[i] !== "[") {
        if (p[i] === "\\" && p[i + 1] === ".") (key += "."), (i += 2);
        else if (/[A-Za-z0-9_\-/]/.test(p[i]!)) key += p[i++];
        else return undefined; // a function call, an operator, a space: not this subset
      }
      if (!key) return undefined;
      steps.push({ key });
    } else if (p[i] === "[") {
      const end = closing(p, i);
      if (end < 0) return undefined;
      const inner = p.slice(i + 1, end).trim();
      i = end + 1;
      let m: RegExpExecArray | null;
      if (inner === "*") steps.push({ all: true });
      else if ((m = /^-?\d+$/.exec(inner))) steps.push({ index: Number(inner) });
      else if ((m = /^(['"])(.*)\1$/.exec(inner))) steps.push({ key: m[2]! });
      else if ((m = /^\?\(\s*@((?:\.[A-Za-z0-9_-]+)+)\s*(==|!=)\s*(.+?)\s*\)$/.exec(inner))) {
        const value = literal(m[3]!);
        if (value === undefined) return undefined;
        steps.push({ filter: m[1]!.slice(1).split("."), op: m[2] as "==" | "!=", value });
      } else return undefined;
    } else return undefined;
  }
  return steps;
}

function closing(p: string, open: number): number {
  let quote = "";
  for (let j = open + 1; j < p.length; j++) {
    const c = p[j]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "]") return j;
  }
  return -1;
}

function literal(s: string): unknown {
  const q = /^(['"])(.*)\1$/.exec(s);
  if (q) return q[2];
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  return undefined;
}

const own = (o: unknown, k: string): unknown =>
  o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/** Every value the path reaches, at most 50. */
export function readPath(obj: unknown, path: string): unknown[] {
  const steps = parsePath(path);
  if (!steps) return [];
  let cur: unknown[] = [obj];
  for (const s of steps) {
    const next: unknown[] = [];
    for (const v of cur) {
      if ("key" in s) {
        const x = own(v, s.key);
        if (x !== undefined) next.push(x);
      } else if ("index" in s) {
        if (Array.isArray(v)) {
          const x = v[s.index < 0 ? v.length + s.index : s.index];
          if (x !== undefined) next.push(x);
        }
      } else if ("all" in s) {
        // A bounded loop, not a spread: a 300,000-item array would overflow the stack (security review, finding 7).
        const items = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
        for (let i = 0; i < items.length && next.length < MAX_RESULTS; i++) next.push(items[i]);
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length && next.length < MAX_RESULTS; i++) {
          const item = v[i];
          let x: unknown = item;
          for (const k of s.filter) x = own(x, k);
          if ((x === s.value) === (s.op === "==")) next.push(item);
        }
      }
      if (next.length >= MAX_RESULTS) break;
    }
    cur = next.slice(0, MAX_RESULTS);
    if (!cur.length) break;
  }
  return cur;
}

/** The served version's priority-0 columns, from a CRD (v1). */
export function printerColumns(crd: KubeObject, version: string): PrinterColumn[] {
  const v = ((crd.spec?.versions ?? []) as { name: string; additionalPrinterColumns?: PrinterColumn[] }[]).find((x) => x.name === version);
  return (v?.additionalPrinterColumns ?? []).filter((c) => !c.priority && typeof c.jsonPath === "string" && typeof c.name === "string").slice(0, 12);
}

/** A value as cell text, at most 300 characters whatever its type (security review, finding 8). */
const cut = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
const show = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return cut(String(v));
  try {
    return cut(JSON.stringify(v) ?? "");
  } catch {
    return "";
  }
};

/** A printer column as a table column: dates as ages, numbers right-aligned, booleans as a word with a tone. */
export function printerColumn(c: PrinterColumn, i: number): Column {
  const id = `pc${i}`;
  const read = (o: KubeObject) => readPath(o, c.jsonPath);
  const base = { id, label: c.name, width: "minmax(80px, 1fr)", ...(c.description ? { description: c.description } : {}) };
  switch (c.type) {
    case "date":
      return { ...base, width: "72px", kind: "age", cell: (o, now) => {
        const t = Date.parse(show(read(o)[0]));
        return Number.isFinite(t) ? { text: age(t, now), sort: -t, title: show(read(o)[0]) } : { text: "" };
      } };
    case "integer":
    case "number":
      return { ...base, width: "minmax(64px, 96px)", num: true, cell: (o) => {
        const vs = read(o);
        const n = Number(vs[0]);
        return { text: cut(vs.map(show).join(", ")), ...(Number.isFinite(n) ? { sort: n } : {}) };
      } };
    case "boolean":
      return { ...base, width: "minmax(64px, 96px)", kind: "bool", cell: (o) => {
        const v = read(o)[0];
        const on = v === true || v === "true" || v === "True";
        return v === undefined ? { text: "" } : { text: on ? "true" : "false", tone: on ? "ok" : "muted" };
      } };
    default:
      return { ...base, cell: (o) => {
        const text = read(o).map(show).join(", ");
        return { text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
      } };
  }
}

/** A Ready or Available condition, the pod way: quiet when True, the reason in bad when False, muted when Unknown. */
export function conditionCell(o: KubeObject): Cell | undefined {
  // A custom resource's status has whatever shape its CRD allows: only an array of objects with string fields counts.
  const raw: unknown = o.status?.conditions;
  if (!Array.isArray(raw)) return undefined;
  const cs = raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)).slice(0, 100);
  const c = cs.find((x) => x.type === "Ready") ?? cs.find((x) => x.type === "Available");
  if (!c) return undefined;
  const type = c.type as string;
  const reason = typeof c.reason === "string" ? cut(c.reason) : "";
  const message = typeof c.message === "string" ? c.message.slice(0, 1000) : "";
  const tone: Tone = c.status === "True" ? "ok" : c.status === "False" ? "bad" : "muted";
  const text = c.status === "True" ? type : c.status === "False" ? reason || `Not ${type.toLowerCase()}` : "Unknown";
  return { text, tone, ...(message ? { title: message } : {}) };
}

export const conditionColumn: Column = {
  id: "status", label: "Status", width: "minmax(110px, 160px)",
  cell: (o) => conditionCell(o) ?? { text: "" },
};

/** Columns for a custom resource's list: Name, Namespace, its printer columns, Status, Age. */
export function customColumns(base: Column[], cols: PrinterColumn[], withStatus: boolean): Column[] {
  const head = base.filter((c) => c.id === "name" || c.id === "namespace");
  const tail = base.filter((c) => c.id === "age");
  // The CRD's own Age column duplicates ours.
  const mine = cols.filter((c) => !(c.type === "date" && c.jsonPath.replace(/\s/g, "") === ".metadata.creationTimestamp")).map(printerColumn);
  const hasStatus = cols.some((c) => /^(status|ready)$/i.test(c.name));
  return [...head, ...mine, ...(withStatus && !hasStatus ? [conditionColumn] : []), ...tail];
}
