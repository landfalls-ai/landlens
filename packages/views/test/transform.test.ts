import { describe, expect, it } from "vitest";
import { ownerEntry } from "../src/computed.js";
import { objectRows, parseFields, type Row } from "../src/rows.js";
import { parseDocument } from "../src/schema.js";
import { checkTimes, narrowLimits, VIEW_LIMITS, VIEW_TIMES } from "../src/limits.js";
import { SENTENCES } from "../src/errors.js";
import { asNumber, deliver, fieldsAfter, get, JoinTooBig, runPipe, runStep, type PipeStep } from "../src/transform.js";

const ctx = (other: Record<string, Row[]> = {}, params: Record<string, string> = {}) => ({ params, rowsOf: (id: string) => other[id] });
const rows: Row[] = [
  { name: "a", restarts: 3, ns: "shop", cpu: 0.5 },
  { name: "B", restarts: 10, ns: "shop", cpu: 0.25 },
  { name: "c", restarts: "9", ns: "ledger", cpu: null },
  { name: "d", restarts: null, ns: "ledger", cpu: 1 },
];
const names = (rs: Row[]) => rs.map((r) => r.name);

describe("the eight steps (D208)", () => {
  it("filter: every condition, numbers as numbers, strings case-insensitively, params resolved", () => {
    const f = (c: unknown, params: Record<string, string> = {}) => names(runStep(rows, { filter: [c] } as PipeStep, ctx({}, params)));
    expect(f({ field: "restarts", op: "gt", value: 5 })).toEqual(["B", "c"]); // "9" is a number here
    expect(f({ field: "restarts", op: "gte", value: "10" })).toEqual(["B"]);
    expect(f({ field: "restarts", op: "lt", value: 4 })).toEqual(["a"]);
    expect(f({ field: "restarts", op: "lte", value: 3 })).toEqual(["a"]);
    expect(f({ field: "restarts", op: "eq", value: 9 })).toEqual(["c"]);
    expect(f({ field: "restarts", op: "ne", value: 9 })).toEqual(["a", "B", "d"]);
    expect(f({ field: "name", op: "contains", value: "b" })).toEqual(["B"]);
    expect(f({ field: "ns", op: "startsWith", value: "LED" })).toEqual(["c", "d"]);
    expect(f({ field: "ns", op: "endsWith", value: "OP" })).toEqual(["a", "B"]);
    expect(f({ field: "name", op: "in", value: ["a", "d", { param: "p" }] }, { p: "c" })).toEqual(["a", "c", "d"]);
    expect(f({ field: "cpu", op: "exists" })).toEqual(["a", "B", "d"]);
    expect(f({ field: "ns", op: "eq", value: { param: "ns" } }, { ns: "ledger" })).toEqual(["c", "d"]);
    // A parameter with no value matches nothing (not everything).
    expect(f({ field: "ns", op: "eq", value: { param: "missing" } })).toEqual([]);
    // "abc" and 5 aren't both numbers: compared as strings, never coerced to NaN matches.
    expect(names(runStep([{ name: "x", v: "abc" }], { filter: [{ field: "v", op: "gt", value: 5 }] }, ctx()))).toEqual(["x"]);
    expect(asNumber("1e3")).toBe(1000);
    expect(asNumber("12px")).toBeNaN();
  });

  it("sort: up to three keys, no value last both ways, stable", () => {
    expect(names(runStep(rows, { sort: [{ field: "restarts", dir: "desc" }] }, ctx()))).toEqual(["B", "c", "a", "d"]);
    expect(names(runStep(rows, { sort: [{ field: "restarts" }] }, ctx()))).toEqual(["a", "c", "B", "d"]);
    expect(names(runStep(rows, { sort: [{ field: "ns" }, { field: "cpu", dir: "desc" }] }, ctx()))).toEqual(["d", "c", "a", "B"]);
  });

  it("limit, rename, pick, derive", () => {
    expect(names(runStep(rows, { limit: 2 }, ctx()))).toEqual(["a", "B"]);
    expect(runStep(rows, { rename: { name: "pod" } }, ctx())[0]).toEqual({ pod: "a", restarts: 3, ns: "shop", cpu: 0.5 });
    expect(runStep(rows, { pick: ["name", "nope"] }, ctx())[0]).toEqual({ name: "a", nope: null });
    const d = runStep([{ a: 1, b: 4 }, { a: 1, b: 0 }, { a: "x", b: 1 }], { derive: { r: { fn: "ratio", of: ["a", "b"] }, p: { fn: "percent", of: ["a", "b"] }, df: { fn: "diff", of: ["b", "a"] }, s: { fn: "sum", of: ["a", "b"] } } }, ctx());
    expect(d[0]).toMatchObject({ r: 0.25, p: 25, df: 3, s: 5 });
    expect(d[1]).toMatchObject({ r: null, p: null, df: -1, s: 1 }); // never Infinity
    expect(d[2]).toMatchObject({ r: null, s: null }); // never NaN
  });

  it("group: by fields, and by [] as one total row, also over nothing", () => {
    const g = runStep(rows, { group: { by: ["ns"], agg: { n: { fn: "count" }, total: { fn: "sum", field: "restarts" }, top: { fn: "max", field: "cpu" }, avg: { fn: "avg", field: "restarts" }, low: { fn: "min", field: "restarts" }, first: { fn: "first", field: "name" }, kinds: { fn: "countDistinct", field: "name" }, some: { fn: "count", field: "cpu" } } } }, ctx());
    expect(g).toEqual([
      { ns: "shop", n: 2, total: 13, top: 0.5, avg: 6.5, low: 3, first: "a", kinds: 2, some: 2 },
      { ns: "ledger", n: 2, total: 9, top: 1, avg: 9, low: 9, first: "c", kinds: 2, some: 1 },
    ]);
    expect(runStep(rows, { group: { by: [], agg: { n: { fn: "count" } } } }, ctx())).toEqual([{ n: 4 }]);
    expect(runStep([], { group: { by: [], agg: { n: { fn: "count" }, s: { fn: "sum", field: "x" } } } }, ctx())).toEqual([{ n: 0, s: null }]);
  });

  it("join: pods by owner through $workload, across pods, ReplicaSets and Deployments", () => {
    const rs = { kind: "ReplicaSet", metadata: { name: "api-7d9", namespace: "shop", ownerReferences: [{ kind: "Deployment", name: "api", controller: true }] } };
    const owners = new Map([ownerEntry(rs, "ReplicaSet")!]);
    const pods = ["x1", "x2", "y1"].map((n) => ({
      kind: "Pod",
      metadata: { name: n, namespace: "shop", ownerReferences: [{ kind: "ReplicaSet", name: n.startsWith("x") ? "api-7d9" : "web-1", controller: true }] },
      status: { phase: "Running", containerStatuses: [{ restartCount: n === "x1" ? 2 : 1, ready: true, state: { running: {} } }] },
    }));
    const deploys = [{ kind: "Deployment", metadata: { name: "api", namespace: "shop" }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }];
    const t = (resource: string, kind: string, group = "") => ({ group, version: "v1", resource, kind });
    const podRows = objectRows(pods, parseFields({ name: "$name", owner: "$workload", restarts: "$restarts" }), t("pods", "Pod"), { owners });
    const depRows = objectRows(deploys, parseFields({ key: "$key", name: "$name" }), t("deployments", "Deployment", "apps"));
    const joined = runStep(depRows, { join: { with: "pods", on: { left: "key", right: "owner" }, agg: { pods: { fn: "count" }, restarts: { fn: "sum", field: "restarts" } }, take: { firstPod: "name" } } }, ctx({ pods: podRows }));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ key: "Deployment/shop/api", pods: 2, restarts: 3, firstPod: "x1" });
    // The left row keeps its own ref; nothing of the right side's refs comes across.
    expect(joined[0]!._ref).toEqual({ group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespace: "shop", name: "api" });
    // A left row with no match keeps its row, with no values taken and a count of 0.
    const none = runStep([{ key: "Deployment/shop/gone" }], { join: { with: "pods", on: { left: "key", right: "owner" }, agg: { pods: { fn: "count" } }, take: { firstPod: "name" } } }, ctx({ pods: podRows }));
    expect(none[0]).toEqual({ key: "Deployment/shop/gone", pods: 0, firstPod: null });
  });

  it("join: a Service's selector against pods' labels; an empty selector selects nothing", () => {
    const svc: Row[] = [{ name: "api", sel: "app=api, tier=web" }, { name: "none", sel: null }];
    const pods: Row[] = [{ pod: "p1", labels: "app=api, tier=web, x=y" }, { pod: "p2", labels: "app=api" }, { pod: "p3", labels: "app=api, tier=web" }];
    const out = runStep(svc, { join: { with: "pods", on: { selector: "sel", labels: "labels" }, agg: { n: { fn: "count" } } } }, ctx({ pods }));
    expect(out).toEqual([{ name: "api", sel: "app=api, tier=web", n: 2 }, { name: "none", sel: null, n: 0 }]);
  });

  it("join: numbers and numeric strings meet", () => {
    const out = runStep([{ id: 7 }, { id: "8" }], { join: { with: "o", on: { left: "id", right: "ref" }, take: { v: "v" } } }, ctx({ o: [{ ref: "7", v: "seven" }, { ref: 8, v: "eight" }] }));
    expect(out.map((r) => r.v)).toEqual(["seven", "eight"]);
  });

  it("reads own fields only: a row's inherited keys are no value", () => {
    const r: Row = { a: 1 };
    expect(get(r, "toString")).toBeNull();
    expect(get(r, "hasOwnProperty")).toBeNull();
    expect(names(runStep([{ name: "x" }], { filter: [{ field: "valueOf", op: "exists" }] }, ctx()))).toEqual([]);
  });

  it("cuts at 2,000 rows and says so", () => {
    const many = Array.from({ length: 2_001 }, (_, i) => ({ i }));
    expect(deliver(many.slice(0, 2_000))).toMatchObject({ total: 2_000, truncated: false });
    const cut = deliver(many);
    expect(cut.rows).toHaveLength(2_000);
    expect(cut).toMatchObject({ total: 2_001, truncated: true });
  });
});

describe("property: no step returns a key outside its declared fields", () => {
  // A small seeded generator (no dependency): the same 400 pipelines every run.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const FIELDS = ["a", "b", "c", "d", "e"];
  const val = () => pick([1, 2, "x", "B", null, true, 3.5, "7"]);
  const step = (): PipeStep => {
    const f = () => pick(FIELDS);
    switch (pick(["filter", "sort", "limit", "group", "join", "derive", "rename", "pick"] as const)) {
      case "filter": return { filter: [{ field: f(), op: pick(["eq", "gt", "contains", "exists", "in"] as const), value: pick([1, "x", ["x", 1]]) }] } as PipeStep;
      case "sort": return { sort: [{ field: f(), dir: pick(["asc", "desc"] as const) }] };
      case "limit": return { limit: 1 + Math.floor(rnd() * 5) };
      case "group": return { group: { by: [f()], agg: { [f()]: { fn: pick(["count", "sum", "first"] as const), field: f() } } } };
      case "join": return { join: { with: "other", on: { left: f(), right: f() }, take: { [f()]: f() }, agg: { [f()]: { fn: "count" } } } };
      case "derive": return { derive: { [f()]: { fn: pick(["ratio", "sum"] as const), of: [f(), f()] } } };
      case "rename": return { rename: { [f()]: f() } };
      case "pick": return { pick: [f(), f()] };
    }
  };
  it("holds for 400 random pipelines", () => {
    const other = Array.from({ length: 6 }, () => Object.fromEntries(FIELDS.map((k) => [k, val()])) as Row);
    for (let n = 0; n < 400; n++) {
      let declared = new Set(["a", "b", "c"]);
      let rs: Row[] = Array.from({ length: 8 }, () => ({ a: val(), b: val(), c: val(), _ref: { group: "", version: "v1", resource: "pods", kind: "Pod", name: "p" } }));
      const pipe = Array.from({ length: 1 + Math.floor(rnd() * 8) }, step);
      for (const s of pipe) {
        rs = runStep(rs, s, ctx({ other }));
        declared = fieldsAfter(s, declared);
        for (const r of rs) for (const k of Object.keys(r)) {
          if (k === "_ref" || k === "_tone") continue;
          expect(declared.has(k), `${k} after ${JSON.stringify(s)}`).toBe(true);
        }
      }
    }
  });

  it("the schema takes every step the generator makes", () => {
    const pipe = Array.from({ length: 8 }, step);
    const r = parseDocument({ schema: 1, title: "t", sources: { s: { kind: "kube.list", resource: "pods", pipe }, other: { kind: "kube.list", resource: "nodes" } }, blocks: [{ type: "text", markdown: "x" }] });
    expect(r.ok).toBe(true);
  });

  it("runPipe runs at most 8 steps", () => {
    expect(runPipe(rows, Array.from({ length: 12 }, () => ({ limit: 4 } as PipeStep)), ctx())).toHaveLength(4);
  });
});

// Security review of wave 10 part 1, M3: joins had no budget (10,000 × 10,000 on one key took 13.6 s of main's thread).
describe("a join's work budget", () => {
  const timed = <T>(f: () => T): { ms: number; out?: T; err?: unknown } => {
    const t0 = performance.now();
    try {
      const out = f();
      return { ms: performance.now() - t0, out };
    } catch (err) {
      return { ms: performance.now() - t0, err };
    }
  };
  const aggs = Object.fromEntries(["count", "sum", "avg", "min", "max", "first", "countDistinct"].map((fn, i) => [`a${i}`, { fn, field: "v" }]).concat([["a7", { fn: "sum", field: "v" }]]));

  it("a 10,000 × 10,000 value join on one shared key stops at the budget, fast", () => {
    const left: Row[] = Array.from({ length: 10_000 }, (_, i) => ({ k: "same", i }));
    const right: Row[] = Array.from({ length: 10_000 }, (_, i) => ({ k: "same", v: i }));
    const r = timed(() => runStep(left, { join: { with: "r", on: { left: "k", right: "k" }, agg: aggs as never } }, ctx({ r: right })));
    expect(r.err).toBeInstanceOf(JoinTooBig);
    expect((r.err as Error).message).toBe(SENTENCES.joinTooBig("r"));
    expect(r.ms).toBeLessThan(200);
  });

  it("a 5,000 × 10,000 selector join on shared labels stops at the budget, fast", () => {
    const left: Row[] = Array.from({ length: 5_000 }, (_, i) => ({ sel: "app=api, tier=web", i }));
    const right: Row[] = Array.from({ length: 10_000 }, (_, i) => ({ labels: `app=api, tier=web, n=${i}`, v: i }));
    const r = timed(() => runStep(left, { join: { with: "r", on: { selector: "sel", labels: "labels" }, agg: { n: { fn: "count" } } } }, ctx({ r: right })));
    expect(r.err).toBeInstanceOf(JoinTooBig);
    expect(r.ms).toBeLessThan(200);
  });

  it("a big join within the budget is worked out, fast: by the rarest label, not by every right row", () => {
    // 2,000 Services, 10,000 pods, each Service selecting its 5 pods by a label all of them share and one of their own.
    const left: Row[] = Array.from({ length: 2_000 }, (_, i) => ({ sel: `app=shop, part=p${i}` }));
    const right: Row[] = Array.from({ length: 10_000 }, (_, i) => ({ labels: `app=shop, part=p${i % 2_000}`, v: 1 }));
    const r = timed(() => runStep(left, { join: { with: "r", on: { selector: "sel", labels: "labels" }, agg: { n: { fn: "count" } } } }, ctx({ r: right })));
    expect(r.err).toBeUndefined();
    expect(r.out!.every((x) => x.n === 5)).toBe(true);
    expect(r.ms).toBeLessThan(500);
  });

  it("the budget is the caller's when narrower: at it the join runs, past it it stops", () => {
    const step = { join: { with: "r", on: { left: "k", right: "k" }, agg: { n: { fn: "count" } } } } as PipeStep;
    // 2 right rows indexed, then 2 left rows each matching 2 (1 + 2 × 1): 2 + 3 + 3 = 8.
    const two: Row[] = [{ k: 1 }, { k: 1 }];
    expect(runStep(two, step, { ...ctx({ r: two }), joinWork: 8 }).map((x) => x.n)).toEqual([2, 2]);
    expect(() => runStep(two, step, { ...ctx({ r: two }), joinWork: 7 })).toThrow(JoinTooBig);
  });
});

// Security review of wave 10 part 1, L7: an inherited name was taken as a limit or a time.
describe("limits and times: own names only", () => {
  it("refuses toString, constructor and hasOwnProperty", () => {
    for (const k of ["toString", "constructor", "hasOwnProperty"]) {
      expect(() => narrowLimits({ ...VIEW_LIMITS }, { [k]: 1 } as never)).toThrow(/no such limit/);
      expect(() => checkTimes({ ...VIEW_TIMES }, { [k]: 1 } as never)).toThrow(/no such time/);
    }
  });
});
