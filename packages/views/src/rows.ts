// A source's objects as rows (D207): each field read by its path, every string cleaned and cut (text.ts), and for a
// Kubernetes object the hidden `_ref` built from the object itself and the kind discovery named, never from the
// document's fields, so a row can't be pointed at anything else. Rows are made own-property only: the reader never
// sees an inherited key (transform.ts reads them the same way).
import { RowRef, type RowRef as RowRefT } from "@landlens/contracts";
import { statusOf } from "./computed.js";
import { parsePath, readPath, type Cell, type ParsedPath, type ReadContext } from "./path.js";

export type Tone = "ok" | "warn" | "bad" | "muted";
export type Row = { [field: string]: Cell | RowRefT | undefined; _ref?: RowRefT; _tone?: Tone };
export type KindRef = { group: string; version: string; resource: string; kind: string };

export const HIDDEN = ["_ref", "_tone"] as const;

/** Fields a `kube.list` row gets without `fields` (D207). */
export const LIST_FIELDS = { name: "$name", namespace: "$namespace", kind: "$kind", age: "$age", status: "$status" } as const;
/** A `kube.events` row's: what `kubectl get events` shows. */
export const EVENT_FIELDS = { type: "type", reason: "reason", object: "$object", message: "message", count: "count", last: "$last", namespace: "$namespace" } as const;

/** Parse a source's fields once; a field whose path doesn't parse was refused by the schema, so it is left out. */
export function parseFields(fields: Record<string, string>): [string, ParsedPath][] {
  const out: [string, ParsedPath][] = [];
  for (const [k, p] of Object.entries(fields)) {
    const parsed = parsePath(p);
    if (!("error" in parsed)) out.push([k, parsed]);
  }
  return out;
}

/** The object as a RowRef, checked by the same schema an IPC request is, else none. */
export function refOf(o: unknown, t: KindRef): RowRefT | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const m = (o as { metadata?: { name?: unknown; namespace?: unknown } }).metadata;
  const ref = { group: t.group, version: t.version, resource: t.resource, kind: t.kind, ...(typeof m?.namespace === "string" ? { namespace: m.namespace } : {}), name: m?.name };
  const ok = RowRef.safeParse(ref);
  return ok.success ? ok.data : undefined;
}

/** Kubernetes objects as rows, with `_ref` and `_tone`. */
export function objectRows(objects: readonly unknown[], fields: [string, ParsedPath][], t: KindRef, ctx: Omit<ReadContext, "kind"> = {}): Row[] {
  const read: ReadContext = { ...ctx, kind: t.kind, group: t.group };
  const out: Row[] = new Array(objects.length);
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const row: Row = {};
    for (const [k, p] of fields) row[k] = readPath(o, p, read);
    const ref = refOf(o, t);
    if (ref) row._ref = ref;
    const kind = typeof (o as { kind?: unknown })?.kind === "string" ? (o as { kind: string }).kind : t.kind;
    if (o && typeof o === "object" && (o as { metadata?: unknown }).metadata) row._tone = statusOf(kind, o as never, t.group).tone;
    out[i] = row;
  }
  return out;
}

/**
 * Plain rows (a top list, a doctor's problems, Helm summaries: already cells) through the document's fields, if any:
 * a path reads the plain row (computed names read nothing there). `_ref` and `_tone` are carried over as they are.
 */
export function plainRows(base: readonly Row[], fields: [string, ParsedPath][] | undefined): Row[] {
  if (!fields) return base.slice();
  return base.map((b) => {
    const row: Row = {};
    for (const [k, p] of fields) row[k] = "computed" in p ? null : readPath(b, p);
    if (b._ref) row._ref = b._ref;
    if (b._tone) row._tone = b._tone;
    return row;
  });
}
