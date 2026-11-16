// The Views page's native blocks (wave 10 part 3, viewBlocks.ts): each format as words, tones only from the closed set,
// a table's columns for ResourceTable, a stat, a chart's bars and lines, the selection's actions (a block's choice
// never gets Delete), and the sort tweak. Every value comes out as text.
import type { ResourceType, RowRef, ViewRow } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import {
  barsOf, bulkOffered, cellWords, chipOf, linesOf, logLines, oneKind, refKey, rowObjects, rowOf, selectionActions, sortKey, statOf, tableColumns, toneOf, tweakSort, unitWords,
} from "../src/renderer/src/viewBlocks";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ref = (name: string, o: Partial<RowRef> = {}): RowRef => ({ group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespace: "landlens-dev", name, ...o });
const type = (o: Partial<ResourceType>): ResourceType => ({ group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "list", "delete", "patch"], ...o });

describe("cellWords: a cell as words by its format", () => {
  it("writes each format", () => {
    expect(cellWords(1234.5, "number")).toBe("1,234.5");
    expect(cellWords(NOW - 3 * 3_600_000, "age", NOW)).toBe("3h");
    expect(cellWords(512, "bytes")).toBe("512 B");
    expect(cellWords(3 * 1024 ** 3, "bytes")).toBe("3.0 GiB");
    expect(cellWords(0.25, "cpu")).toBe("250m");
    expect(cellWords(2.456, "cpu")).toBe("2.46");
    expect(cellWords(12.34, "percent")).toBe("12.3%");
    for (const f of ["text", "status", "ref", "mono"] as const) expect(cellWords(42, f)).toBe("42");
    expect(cellWords("Running", "status")).toBe("Running");
    expect(cellWords(true)).toBe("true");
  });

  it("writes nothing for what a cell never holds, and markup stays text", () => {
    for (const v of [null, undefined, { a: 1 }, [1, 2], () => 1, NaN, Infinity]) expect(cellWords(v as never, "number")).toBe("");
    expect(cellWords("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("tones, sort keys and rows", () => {
  it("takes a tone only from the closed set", () => {
    for (const t of ["ok", "warn", "bad", "muted"]) expect(toneOf(t)).toBe(t);
    for (const t of ["danger", "OK", "bad red", 1, null, "tone-bad\" onmouseover=\"x"]) expect(toneOf(t)).toBeUndefined();
  });

  it("sorts numbers as numbers and ages newest first", () => {
    expect(sortKey(10, "number")).toBe(10);
    expect(sortKey(NOW, "age")).toBe(-NOW);
    expect(sortKey("b")).toBe("b");
    expect(sortKey(true)).toBe(1);
  });

  it("gives each row a stable uid: its object's, else its place; two rows of one object stay apart", () => {
    const rows: ViewRow[] = [{ name: "api", _ref: ref("api") }, { name: "api", _ref: ref("api") }, { name: "total" }];
    const objs = rowObjects(rows, "name");
    expect(objs.map((o) => o.metadata.uid)).toEqual([refKey(ref("api")), `${refKey(ref("api"))}#1`, "row-2"]);
    expect(objs.map((o) => o.metadata.name)).toEqual(["api", "api", "total"]);
    expect(rowOf(objs[2]!)).toBe(rows[2]);
  });
});

describe("tableColumns: a view's columns for ResourceTable", () => {
  const rows: ViewRow[] = [
    { name: "api", status: "CrashLoopBackOff", restarts: 7, cpu: 0.5, health: "bad", _ref: ref("api"), _tone: "bad" },
    { name: "web", status: "Running", restarts: 0, cpu: 1.5, health: "excellent", _ref: ref("web"), _tone: "ok" },
  ];
  const cols = tableColumns([
    { field: "name", header: "Name" }, { field: "status", format: "status" }, { field: "restarts", format: "number" },
    { field: "cpu", format: "cpu", toneField: "health", width: 90 }, { field: "name", header: "Again" },
  ]);
  const objs = rowObjects(rows, "name");

  it("keeps the field as the id (unique), the header as the label and a width given", () => {
    expect(cols.map((c) => c.id)).toEqual(["name", "status", "restarts", "cpu", "name_"]);
    expect(cols.map((c) => c.label)).toEqual(["Name", "status", "restarts", "cpu", "Again"]);
    expect(cols[3]!.width).toBe("90px");
    expect(cols[2]!.num).toBe(true);
  });

  it("writes each cell as words, its tone from toneField or (status) the row's own, never another word", () => {
    expect(cols[0]!.cell(objs[0]!, NOW)).toEqual({ text: "api", sort: "api" });
    expect(cols[1]!.cell(objs[0]!, NOW)).toMatchObject({ text: "CrashLoopBackOff", tone: "bad" });
    expect(cols[3]!.cell(objs[0]!, NOW)).toMatchObject({ text: "500m", sort: 0.5, tone: "bad" });
    // "excellent" isn't a tone: no class from data.
    expect(cols[3]!.cell(objs[1]!, NOW).tone).toBeUndefined();
  });
});

describe("stat, charts and logs", () => {
  it("reads a stat from the first row, with a tone and a sparkline", () => {
    const rows: ViewRow[] = [{ n: 11, t: "bad", s: 3 }, { n: 2, s: 5 }, { s: "x" }];
    expect(statOf(rows, { field: "n", toneField: "t", sparkField: "s" })).toEqual({ text: "11", tone: "bad", spark: [3, 5] });
    expect(statOf([], { field: "n" })).toEqual({ text: "—", spark: [] });
    expect(statOf([{ n: 3 * 1024 ** 2 }], { field: "n", format: "bytes" }).text).toBe("3.0 MiB");
  });

  it("ranks bars largest first and leaves out rows without a number", () => {
    const rows: ViewRow[] = [{ ns: "a", cpu: 1 }, { ns: "b", cpu: 3 }, { ns: "c", cpu: "x" }, { cpu: 2 }];
    expect(barsOf(rows, "ns", "cpu")).toEqual([{ key: "b", value: 3 }, { key: "#4", value: 2 }, { key: "a", value: 1 }]);
    expect(barsOf(Array.from({ length: 50 }, (_, i) => ({ v: i })), undefined, "v")).toHaveLength(20);
  });

  it("puts lines in x's order, times as times, gaps where y isn't a number", () => {
    const t0 = NOW - 120_000;
    const l = linesOf([{ at: t0 + 60_000, a: 2 }, { at: t0, a: 1, b: 5 }], "at", ["a", "b"]);
    expect(l).toEqual({ xs: [t0, t0 + 60_000], time: true, series: [{ key: "a", values: [1, 2] }, { key: "b", values: [5, null] }] });
    expect(linesOf([{ k: "x", a: 1 }, { k: "y", a: 2 }], "k", ["a"]).xs).toEqual([0, 1]);
  });

  it("writes a chart's numbers in its unit", () => {
    expect(unitWords("cpu")(0.2)).toBe("200m");
    expect(unitWords("bytes")(2048)).toBe("2.0 KiB");
    expect(unitWords("percent")(33.333)).toBe("33.3%");
    expect(unitWords("count")(12_345)).toBe("12,345");
  });

  it("shows only failures when asked", () => {
    const lines = [{ n: 1, text: "ok", failure: false }, { n: 2, text: "boom", failure: true }];
    expect(logLines(lines).length).toBe(2);
    expect(logLines(lines, true)).toEqual([lines[1]]);
    expect(logLines(undefined)).toEqual([]);
  });
});

describe("the selection bar's actions (D156, D219)", () => {
  it("gives your own selection the kind's bulk actions, and a block's never Delete", () => {
    expect(selectionActions(type({}), "you")).toEqual(["restart", "delete"]);
    expect(selectionActions(type({}), "block")).toEqual(["restart"]);
    expect(selectionActions(type({ group: "", resource: "pods", kind: "Pod" }), "you")).toEqual(["delete"]);
    expect(selectionActions(type({ group: "", resource: "pods", kind: "Pod" }), "block")).toEqual([]);
    // A kind main deletes one at a time (D141) has no bulk delete for anyone.
    expect(selectionActions(type({ group: "", resource: "namespaces", kind: "Namespace", namespaced: false }), "you")).toEqual([]);
    expect(selectionActions(undefined, "you")).toEqual([]);
  });

  it("finds the one kind of a selection, or none for several", () => {
    expect(oneKind([ref("a"), ref("b")])).toEqual({ group: "apps", version: "v1", resource: "deployments", kind: "Deployment" });
    expect(oneKind([ref("a"), ref("p", { group: "", resource: "pods", kind: "Pod" })])).toBeUndefined();
    expect(oneKind([])).toBeUndefined();
    // The same resource name in two groups is two kinds (L2's M13): a Longhorn "nodes" isn't core's.
    expect(oneKind([ref("n1", { group: "", resource: "nodes", kind: "Node" }), ref("n2", { group: "longhorn.io", resource: "nodes", kind: "Node" })])).toBeUndefined();
  });

  it("never lets a bulk Delete start from a selection a block chose any row of, whatever the bar shows (L2's M15)", () => {
    expect(bulkOffered("delete", "block")).toBe(false);
    expect(bulkOffered("restart", "block")).toBe(true);
    expect(bulkOffered("delete", "you")).toBe(true);
  });
});

describe("a chip from the drawer over a view (security review of part 3, L5)", () => {
  const typeOf = (r: { group: string; resource: string }) => (r.resource === "pods" ? { kind: "Pod" } : r.resource === "deployments" ? { kind: "Deployment" } : undefined);
  it("takes the object's own kind, never the drawer's; nothing for a kind it doesn't know or a Secret", () => {
    // The drawer shows a Deployment; its Pods tab asks about a pod.
    expect(chipOf({ group: "", version: "v1", resource: "pods", namespace: "landlens-dev", name: "api-1" }, typeOf)).toEqual({ group: "", version: "v1", resource: "pods", kind: "Pod", namespace: "landlens-dev", name: "api-1" });
    expect(chipOf({ group: "x.io", version: "v1", resource: "widgets", name: "w" }, typeOf)).toBeUndefined();
    expect(chipOf({ group: "", version: "v1", resource: "secrets", namespace: "landlens-dev", name: "s" }, () => ({ kind: "Secret" }))).toBeUndefined();
  });
});

describe("the sort tweak (D214)", () => {
  it("keeps the person's sort while the version has its column; otherwise Claude's order", () => {
    const cols = [{ id: "name" }, { id: "restarts" }];
    expect(tweakSort({ id: "restarts", dir: -1 }, cols)).toEqual({ id: "restarts", dir: -1 });
    expect(tweakSort({ id: "gone", dir: 1 }, cols)).toEqual({ id: "", dir: 1 });
    expect(tweakSort(undefined, cols)).toEqual({ id: "", dir: 1 });
  });
});
