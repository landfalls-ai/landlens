// D205: a follow-up changes a view with a few JSON Patch ops (RFC 6902 `add`, `remove`, `replace`, `move` on JSON
// Pointers of at most 300 characters) against the version it read. The patched document is validated whole, as a
// render_view document is; a patch that fails anywhere changes nothing.
import { z } from "zod";
import { issuesOf, SENTENCES, type Issue } from "./errors.js";
import { VIEW_LIMITS } from "./limits.js";
import { parseDocument, type ViewDocument } from "./schema.js";

const Pointer = z.string().max(300).regex(/^(\/[^/]*)*$/, "not a JSON Pointer (it starts with /, or is empty for the whole document)");
export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: Pointer, value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: Pointer }).strict(),
  z.object({ op: z.literal("replace"), path: Pointer, value: z.unknown() }).strict(),
  z.object({ op: z.literal("move"), from: Pointer, path: Pointer }).strict(),
]).superRefine((o, ctx) => {
  if ((o.op === "add" || o.op === "replace") && !("value" in o)) ctx.addIssue({ code: "custom", message: "required", path: ["value"] });
});
export type PatchOp = z.output<typeof PatchOp>;
export const PatchOps = z.array(PatchOp).min(1).max(VIEW_LIMITS.patchOps);

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

class PatchError extends Error {}

/** A pointer's tokens, `~1` and `~0` read back; any other `~` is refused. */
function tokens(p: string): string[] {
  if (p === "") return [];
  return p.slice(1).split("/").map((t) => {
    if (/~(?![01])/.test(t)) throw new PatchError("a ~ in a pointer must be ~0 or ~1");
    const out = t.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN.has(out)) throw new PatchError("a pointer can't name __proto__, constructor or prototype");
    return out;
  });
}

type Container = Record<string, unknown> | unknown[];
const isContainer = (v: unknown): v is Container => v !== null && typeof v === "object";

/** The container a pointer's last token is in, and that token. */
function parent(doc: unknown, toks: string[]): { c: Container; last: string } {
  let cur: unknown = doc;
  for (const t of toks.slice(0, -1)) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(t) || Number(t) >= cur.length) throw new PatchError("no such place in the document");
      cur = cur[Number(t)];
    } else if (isContainer(cur) && Object.hasOwn(cur, t)) cur = (cur as Record<string, unknown>)[t];
    else throw new PatchError("no such place in the document");
  }
  if (!isContainer(cur)) throw new PatchError("no such place in the document");
  return { c: cur, last: toks[toks.length - 1]! };
}

const index = (a: unknown[], t: string, add: boolean): number => {
  if (add && t === "-") return a.length;
  if (!/^(0|[1-9]\d*)$/.test(t)) throw new PatchError("not an index of this list");
  const i = Number(t);
  if (i > a.length || (!add && i === a.length)) throw new PatchError("not an index of this list");
  return i;
};

function read(doc: unknown, toks: string[]): unknown {
  if (!toks.length) return doc;
  const { c, last } = parent(doc, toks);
  if (Array.isArray(c)) return c[index(c, last, false)];
  if (!Object.hasOwn(c, last)) throw new PatchError("no such place in the document");
  return c[last];
}

function add(doc: unknown, toks: string[], value: unknown): unknown {
  if (!toks.length) return value;
  const { c, last } = parent(doc, toks);
  if (Array.isArray(c)) c.splice(index(c, last, true), 0, value);
  else Object.defineProperty(c, last, { value, enumerable: true, writable: true, configurable: true });
  return doc;
}

function remove(doc: unknown, toks: string[]): unknown {
  if (!toks.length) throw new PatchError("the whole document can't be removed");
  const { c, last } = parent(doc, toks);
  if (Array.isArray(c)) c.splice(index(c, last, false), 1);
  else if (Object.hasOwn(c, last)) delete c[last];
  else throw new PatchError("no such place in the document");
  return doc;
}

export type Patched = { ok: true; document: ViewDocument } | { ok: false; issues: Issue[]; stale?: number };

/**
 * Apply ops to the document at version `current`, if `base` is that version (D214: Claude never patches a version the
 * person left). The result is validated whole; on any failure the document given is unchanged.
 */
export function applyPatch(doc: ViewDocument, current: number, base: unknown, ops: unknown): Patched {
  if (base !== current) return { ok: false, issues: [{ pointer: "/base", message: SENTENCES.stale(current) }], stale: current };
  const parsed = PatchOps.safeParse(ops, { reportInput: true });
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error).map((i) => ({ ...i, pointer: `/ops${i.pointer}` })) };
  // A copy through JSON: the stored document is never touched, and nothing but data is in the copy.
  let next: unknown = JSON.parse(JSON.stringify(doc));
  for (const [i, op] of parsed.data.entries()) {
    try {
      const path = tokens(op.path);
      if (op.op === "add") next = add(next, path, structuredJson(op.value));
      else if (op.op === "remove") next = remove(next, path);
      else if (op.op === "replace") {
        read(next, path);
        next = path.length ? add(remove(next, path), path, structuredJson(op.value)) : structuredJson(op.value);
      } else {
        const from = tokens(op.from);
        if (op.path === op.from) continue;
        if (op.path.startsWith(`${op.from}/`)) throw new PatchError("a move can't put something inside itself");
        const value = read(next, from);
        next = add(remove(next, from), path, value);
      }
    } catch (e) {
      if (e instanceof PatchError) return { ok: false, issues: [{ pointer: `/ops/${i}`, message: e.message }] };
      throw e;
    }
  }
  const checked = parseDocument(next);
  return checked.ok ? checked : { ok: false, issues: checked.issues };
}

/** A value from Claude, as JSON data only (no undefined, functions or prototypes). */
function structuredJson(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}
