// What the tables remember (wave 8 part 3, D155) and the selection's rules (D156): the stored value's tolerant parser
// and its caps, the choices written back, how several namespaces are watched (D158), and Shift+click, the head's
// tri-state and pruning, and which kinds have bulk actions.
import { describe, expect, it } from "vitest";
import {
  bulkActions, headState, headToggled, loadTableState, MAX_COLUMNS, MAX_KINDS, MAX_NAMESPACES, namespacesLabel, NO_TABLE_STATE, pruned, rangeToggled,
  readTableState, saveTableState, TABLE_KEY, toggled, watchPlan, withHidden, withNamespaces, withSort, writeTableState,
} from "../src/renderer/src/tableState";

const t = (group: string, resource: string, verbs = ["get", "list", "delete"]) => ({ group, resource, verbs });

describe("what the tables remember (D155)", () => {
  it("reads back what it wrote", () => {
    let s = withHidden(NO_TABLE_STATE, "configmaps", ["age"]);
    s = withSort(s, "deployments.apps", { id: "ready", dir: -1 });
    s = withNamespaces(s, "orbstack", ["landlens-dev", "default"]);
    expect(readTableState(writeTableState(s))).toEqual({ hidden: { configmaps: ["age"] }, sort: { "deployments.apps": { id: "ready", dir: -1 } }, ns: { orbstack: ["landlens-dev", "default"] } });
  });

  it("an unreadable or odd value is no choices, never an error", () => {
    for (const raw of [null, "", "nope", "[]", "42", '"x"', '{"hidden":5}', "{".repeat(10)]) expect(readTableState(raw)).toEqual(NO_TABLE_STATE);
    expect(readTableState("x".repeat(600 * 1024))).toEqual(NO_TABLE_STATE);
    expect(loadTableState({ getItem: () => { throw new Error("SecurityError"); } })).toEqual(NO_TABLE_STATE);
    expect(saveTableState({ setItem: () => { throw new Error("QuotaExceeded"); } }, NO_TABLE_STATE)).toBe(false);
    const store: Record<string, string> = {};
    expect(saveTableState({ setItem: (k, v) => (store[k] = v) }, withHidden(NO_TABLE_STATE, "pods", ["node"]))).toBe(true);
    expect(JSON.parse(store[TABLE_KEY]!)).toEqual({ hidden: { pods: ["node"] }, sort: {}, ns: {} });
  });

  it("keeps only Kubernetes names and short column ids, within the caps", () => {
    const hidden: Record<string, unknown> = {
      pods: ["age", "age", 5, "", "x".repeat(65), "bad\u0007id", ...Array.from({ length: 60 }, (_, i) => `c${i}`)],
      "Not A Kind": ["age"],
      "deployments.apps": "age",
    };
    for (let i = 0; i < 250; i++) hidden[`kind${i}.example.com`] = ["age"];
    const ns = {
      orbstack: ["landlens-dev", "Bad_NS", "-x", "a".repeat(64), ...Array.from({ length: 80 }, (_, i) => `ns-${i}`)],
      "ctx\nnewline": ["default"],
    };
    const s = readTableState(JSON.stringify({ hidden, sort: { pods: { id: "age", dir: 2 }, "jobs.batch": { id: "age", dir: -1 } }, ns }));
    expect(s.hidden.pods).toHaveLength(MAX_COLUMNS);
    expect(s.hidden.pods!.slice(0, 2)).toEqual(["age", "c0"]);
    expect(s.hidden["Not A Kind"]).toBeUndefined();
    expect(s.hidden["deployments.apps"]).toBeUndefined();
    expect(Object.keys(s.hidden)).toHaveLength(MAX_KINDS);
    expect(s.sort).toEqual({ "jobs.batch": { id: "age", dir: -1 } });
    expect(s.ns.orbstack![0]).toBe("landlens-dev");
    expect(s.ns.orbstack).toHaveLength(MAX_NAMESPACES);
    expect(s.ns.orbstack).not.toContain("Bad_NS");
    expect(s.ns["ctx\nnewline"]).toBeUndefined();
  });

  it("a __proto__ key in the stored text sets nothing on the state's prototype", () => {
    const s = readTableState('{"hidden":{"__proto__":["age"]},"ns":{"__proto__":["default"],"constructor":["x"]},"sort":{"__proto__":{"id":"a","dir":1}}}');
    expect(s).toEqual(NO_TABLE_STATE);
    expect(Object.getPrototypeOf(s.hidden)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(s.ns)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).age).toBeUndefined();
    expect(withNamespaces(NO_TABLE_STATE, "__proto__", ["default"])).toEqual(NO_TABLE_STATE);
  });

  it("Name is never hidden; an empty choice forgets the kind; the newest choice stays past the cap", () => {
    expect(withHidden(NO_TABLE_STATE, "pods", ["name", "age"]).hidden).toEqual({ pods: ["age"] });
    expect(withHidden(withHidden(NO_TABLE_STATE, "pods", ["age"]), "pods", []).hidden).toEqual({});
    let s = NO_TABLE_STATE;
    for (let i = 0; i < MAX_KINDS; i++) s = withSort(s, `k${i}`, { id: "age", dir: 1 });
    s = withSort(s, "newest", { id: "age", dir: 1 });
    expect(Object.keys(s.sort)).toHaveLength(MAX_KINDS);
    expect(s.sort.newest).toBeDefined();
    expect(s.sort.k0).toBeUndefined();
    expect(withNamespaces(withNamespaces(NO_TABLE_STATE, "orbstack", ["a"]), "orbstack", []).ns).toEqual({});
  });

  it("names the button's choice", () => {
    expect([[], ["landlens-dev"], ["a", "b", "c"]].map(namespacesLabel)).toEqual(["All namespaces", "landlens-dev", "3 namespaces"]);
  });
});

describe("several namespaces are watched (D158)", () => {
  it("none: the cluster; one to eight: one watch each; more: the cluster filtered, or the first eight when that is refused", () => {
    expect(watchPlan([])).toEqual({ all: true });
    expect(watchPlan(["a"])).toEqual({ each: ["a"] });
    const eight = Array.from({ length: 8 }, (_, i) => `n${i}`);
    expect(watchPlan(eight)).toEqual({ each: eight });
    const twelve = Array.from({ length: 12 }, (_, i) => `n${i}`);
    expect(watchPlan(twelve)).toEqual({ all: true, filter: twelve });
    expect(watchPlan(twelve, true)).toEqual({ each: twelve.slice(0, 8), cut: 4 });
  });
});

describe("the selection (D156)", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("a click toggles one; Shift+click takes the range from the last toggled row, in the shown order, to the clicked row's new state", () => {
    let s = toggled(new Set(), "b");
    expect([...s]).toEqual(["b"]);
    s = rangeToggled(s, order, "b", "d");
    expect([...s].sort()).toEqual(["b", "c", "d"]);
    // Upwards, and off: the clicked row was on, so the range goes off.
    s = rangeToggled(s, order, "d", "c");
    expect([...s].sort()).toEqual(["b"]);
    // No anchor (or one that left): a single toggle.
    expect([...rangeToggled(new Set(), order, "gone", "e")]).toEqual(["e"]);
    expect([...rangeToggled(new Set(), order, undefined, "e")]).toEqual(["e"]);
  });

  it("the head is none, some or all of the rows shown; its click takes them all or, when all are, clears them, leaving others alone", () => {
    expect(headState(new Set(), order)).toBe("none");
    expect(headState(new Set(["a", "zz"]), order)).toBe("some");
    expect(headState(new Set(order), order)).toBe("all");
    expect([...headToggled(new Set(["zz"]), ["a", "b"])].sort()).toEqual(["a", "b", "zz"]);
    expect([...headToggled(new Set(["a", "b", "zz"]), ["a", "b"])]).toEqual(["zz"]);
  });

  it("a uid that leaves the watch leaves the selection; nothing left, the same set", () => {
    const s = new Set(["a", "b"]);
    expect([...pruned(s, ["a", "c"])]).toEqual(["a"]);
    expect(pruned(s, ["a", "b", "c"])).toBe(s);
  });

  it("bulk: Restart for the three workload kinds, Delete for any kind that deletes but those deleted one at a time", () => {
    expect(bulkActions(t("apps", "deployments", ["patch", "delete"]))).toEqual(["restart", "delete"]);
    expect(bulkActions(t("apps", "daemonsets", ["patch", "delete"]))).toEqual(["restart", "delete"]);
    expect(bulkActions(t("apps", "replicasets", ["patch", "delete"]))).toEqual(["delete"]);
    expect(bulkActions(t("", "configmaps"))).toEqual(["delete"]);
    expect(bulkActions(t("", "secrets"))).toEqual(["delete"]);
    expect(bulkActions(t("", "configmaps", ["get", "list"]))).toEqual([]);
    for (const [g, r] of [["", "namespaces"], ["", "nodes"], ["", "persistentvolumes"], ["apiextensions.k8s.io", "customresourcedefinitions"], ["apiregistration.k8s.io", "apiservices"]] as const) {
      expect(bulkActions(t(g, r))).toEqual([]);
    }
  });
});
