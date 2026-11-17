import { describe, expect, it } from "vitest";
import { issueLine, SENTENCES } from "../src/errors.js";
import { checkTimes, narrowLimits, VIEW_LIMITS, VIEW_TIMES } from "../src/limits.js";
import { applyPatch } from "../src/patch.js";
import { parseDocument, type ViewDocument } from "../src/schema.js";
import { full } from "./docs.js";

const base = (): ViewDocument => {
  const r = parseDocument(full());
  if (!r.ok) throw new Error("fixture");
  return r.document;
};
const patched = (ops: unknown, doc = base(), current = 1, at: unknown = 1) => applyPatch(doc, current, at, ops);
const okDoc = (ops: unknown) => {
  const r = patched(ops);
  if (!r.ok) throw new Error(r.issues.map(issueLine).join("; "));
  return r.document;
};
const refused = (ops: unknown, doc?: ViewDocument) => {
  const r = patched(ops, doc);
  if (r.ok) throw new Error("expected a refusal");
  return r.issues.map(issueLine);
};

describe("patches (D205)", () => {
  it("adds, removes, replaces and moves", () => {
    const d = okDoc([
      { op: "add", path: "/blocks/0/columns/-", value: { field: "node" } },
      { op: "add", path: "/sources/pods/fields/node", value: "$node" },
      { op: "replace", path: "/title", value: "Pods, with nodes" },
      { op: "remove", path: "/blocks/7" },
      { op: "move", from: "/blocks/0", path: "/blocks/1" },
    ]);
    expect(d.title).toBe("Pods, with nodes");
    expect(d.blocks[1]).toMatchObject({ type: "table", columns: [{ field: "name" }, { field: "restarts" }, { field: "node" }] });
    expect(d.blocks.some((b) => b.type === "text")).toBe(false);
    expect(d.sources.pods).toMatchObject({ fields: { node: "$node" } });
    // ~1 and ~0 in a pointer.
    const q = okDoc([{ op: "replace", path: '/sources/pods/fields/app', value: 'metadata.labels["a~b/c"]' }]);
    expect((q.sources.pods as { fields: Record<string, string> }).fields.app).toBe('metadata.labels["a~b/c"]');
  });

  it("leaves the document unchanged when a pointer goes nowhere or the result breaks the schema", () => {
    const doc = base();
    const before = JSON.stringify(doc);
    expect(refused([{ op: "replace", path: "/sources/nope/resource", value: "pods" }], doc)).toEqual(["/ops/0: no such place in the document"]);
    expect(refused([{ op: "remove", path: "/blocks/99" }], doc)).toEqual(["/ops/0: not an index of this list"]);
    expect(refused([{ op: "add", path: "/blocks/01", value: {} }], doc)).toEqual(["/ops/0: not an index of this list"]);
    expect(refused([{ op: "add", path: "/sources/pods/resource~2", value: 1 }], doc)).toEqual(["/ops/0: a ~ in a pointer must be ~0 or ~1"]);
    expect(refused([{ op: "add", path: "/__proto__/polluted", value: 1 }], doc)).toEqual(["/ops/0: a pointer can't name __proto__, constructor or prototype"]);
    expect(refused([{ op: "move", from: "/blocks", path: "/blocks/0" }], doc)).toEqual(["/ops/0: a move can't put something inside itself"]);
    expect(refused([{ op: "remove", path: "" }], doc)).toEqual(["/ops/0: the whole document can't be removed"]);
    // Valid ops whose result isn't a valid document: the schema's own sentences, nothing applied.
    expect(refused([{ op: "replace", path: "/blocks/0/columns/0/field", value: "ok" }, { op: "add", path: "/sources/pods/colour", value: "red" }], doc)).toEqual(["/sources/pods/colour: no such field"]);
    expect(refused([{ op: "replace", path: "/sources/pods/resource", value: "secrets" }], doc)).toEqual([`/sources/pods/resource: ${SENTENCES.secrets}`]);
    expect(JSON.stringify(doc)).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a patch on a version the view has left (D214)", () => {
    const r = patched([{ op: "replace", path: "/title", value: "x" }], base(), 3, 2);
    expect(r).toMatchObject({ ok: false, stale: 3 });
    if (!r.ok) expect(r.issues.map(issueLine)).toEqual([`/base: ${SENTENCES.stale(3)}`]);
  });

  it("checks the ops themselves: shape, 1–50 of them, pointers of at most 300 characters", () => {
    expect(refused([{ op: "copy", from: "/a", path: "/b" }])).toEqual(["/ops/0/op: not a known op"]);
    expect(refused([{ op: "add", path: "/title" }])).toEqual(["/ops/0/value: required"]);
    expect(refused([{ op: "test", path: "/title", value: "x" }])).toEqual(["/ops/0/op: not a known op"]);
    expect(refused([{ op: "replace", path: "title", value: "x" }])[0]).toMatch(/^\/ops\/0\/path: not a JSON Pointer/);
    expect(refused([])).toEqual(["/ops: at least 1 items"]);
    const n = (k: number) => Array.from({ length: k }, () => ({ op: "replace", path: "/title", value: "t" }));
    expect(okDoc(n(VIEW_LIMITS.patchOps)).title).toBe("t");
    expect(refused(n(VIEW_LIMITS.patchOps + 1))).toEqual(["/ops: at most 50 items"]);
    const p = (len: number) => [{ op: "replace", path: `/title${"x".repeat(len - 6)}`, value: "t" }];
    expect(refused(p(300))).toEqual(["/ops/0: no such place in the document"]);
    expect(refused(p(301))).toEqual(["/ops/0/path: at most 300 characters"]);
  });

  it("takes only JSON data from a value", () => {
    const d = okDoc([{ op: "replace", path: "/title", value: "x" }, { op: "add", path: "/blocks/-", value: JSON.parse('{"type":"text","markdown":"m"}') }]);
    expect(d.blocks.at(-1)).toEqual({ type: "text", markdown: "m" });
  });
});

describe("limits may only narrow (review lesson)", () => {
  it("narrows, and refuses raising, 0, NaN, Infinity and unknown limits", () => {
    expect(narrowLimits(VIEW_LIMITS, { rows: 10 }).rows).toBe(10);
    expect(narrowLimits(VIEW_LIMITS, { rows: VIEW_LIMITS.rows }).rows).toBe(2_000);
    for (const bad of [2_001, 0, -1, Number.NaN, Infinity, -Infinity, 1.5e10]) {
      expect(() => narrowLimits(VIEW_LIMITS, { rows: bad })).toThrow(RangeError);
    }
    expect(() => narrowLimits(VIEW_LIMITS, { bogus: 1 } as never)).toThrow(/no such limit/);
    expect(() => narrowLimits(VIEW_LIMITS, { rows: "5" as unknown as number })).toThrow(RangeError);
  });

  it("times are finite, from 1 ms to 10 minutes", () => {
    expect(checkTimes(VIEW_TIMES, { push: 5 }).push).toBe(5);
    for (const bad of [0, Number.NaN, Infinity, 600_001]) expect(() => checkTimes(VIEW_TIMES, { push: bad })).toThrow(RangeError);
  });
});
