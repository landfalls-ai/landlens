// What the tables remember (wave 8 part 3, D155) and the selection's rules (D156): the stored value's tolerant parser
// and its caps, the choices written back, how several namespaces are watched (D158), and Shift+click, the head's
// tri-state and pruning, and which kinds have bulk actions.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "@landlens/contracts";
import {
  allAnswer, bulkActions, bulkAllowed, chosenSort, headState, headToggled, hiddenOf, listKey, loadTableState, MAX_COLUMNS, MAX_CONTEXTS, MAX_KINDS,
  MAX_NAMESPACES, MAX_STORED, mergeEach, namespacesLabel, namespacesOf, NO_TABLE_STATE, nsKey, own, pruned, rangeToggled, readTableState,
  saveTableState, selectionFor, TABLE_KEY, toggled, unwatchedTitle, updateTableState, watchPlan, withHidden, withNamespaces, withSort,
  writeTableState, type WatchLike,
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

// The security review of part 3 (M4, L1, L5, L6, L8): each rule below fails its test with the rule taken out.
describe("security review of part 3: what the tables remember", () => {
  const SERVER = "https://127.0.0.1:26443";

  it("L1: a context or kind named like an Object.prototype member reads nothing, never an inherited function", () => {
    const s = loadTableState({ getItem: () => JSON.stringify({ hidden: { pods: ["age"] }, ns: { [nsKey("orbstack", SERVER)]: ["default"] } }) });
    for (const k of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(own(s.ns, k)).toBeUndefined();
      expect(hiddenOf(s, k)).toEqual([]);
      expect(chosenSort(s, k)).toEqual({ id: "name", dir: 1 });
    }
    expect(namespacesOf(s, "orbstack", SERVER)).toEqual(["default"]);
    expect(hiddenOf(s, "pods")).toEqual(["age"]);
  });

  it("L8: namespaces are kept per cluster, its context and its server: two kubeconfigs with one context name don't share them", () => {
    let s = withNamespaces(NO_TABLE_STATE, nsKey("dev", "https://a.example:6443"), ["team-a"]);
    s = withNamespaces(s, nsKey("dev", "https://b.example:6443"), ["team-b"]);
    expect(namespacesOf(s, "dev", "https://a.example:6443")).toEqual(["team-a"]);
    expect(namespacesOf(s, "dev", "https://b.example:6443")).toEqual(["team-b"]);
    expect(namespacesOf(s, "dev", "https://c.example:6443")).toEqual([]);
    expect(namespacesOf(readTableState(writeTableState(s)), "dev", "https://b.example:6443")).toEqual(["team-b"]);
  });

  it("L8: each choice is applied to the value as stored, so two windows keep each other's choices", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    // Both windows loaded nothing; the first chooses namespaces, the second (its copy still empty) hides a column.
    const first = loadTableState(storage);
    const second = loadTableState(storage);
    updateTableState(storage, first, (s) => withNamespaces(s, nsKey("orbstack", SERVER), ["landlens-dev"]));
    const after = updateTableState(storage, second, (s) => withHidden(s, "pods", ["node"]));
    expect(after.hidden).toEqual({ pods: ["node"] });
    expect(namespacesOf(after, "orbstack", SERVER)).toEqual(["landlens-dev"]);
    expect(namespacesOf(loadTableState(storage), "orbstack", SERVER)).toEqual(["landlens-dev"]);
    // Storage that can't be read: the window's own copy.
    const mine = withHidden(NO_TABLE_STATE, "pods", ["age"]);
    expect(updateTableState({ getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} }, mine, (s) => withSort(s, "pods", { id: "age", dir: -1 }))).toEqual({ ...mine, sort: { pods: { id: "age", dir: -1 } } });
  });

  it("L8: a value written is never larger than a read takes; the oldest entries go first and the newest choice stays", () => {
    const long = (i: number, j: number) => `n${i}-${j}-`.padEnd(63, "x");
    let s = NO_TABLE_STATE;
    for (let i = 0; i < MAX_CONTEXTS; i++) s = withNamespaces(s, nsKey(`ctx-${i}`, SERVER), Array.from({ length: MAX_NAMESPACES }, (_, j) => long(i, j)));
    for (let i = 0; i < MAX_KINDS; i++) s = withHidden(s, `kind${i}.example.com`, Array.from({ length: MAX_COLUMNS }, (_, j) => `c${j}`.padEnd(64, "y")));
    expect(JSON.stringify(s).length).toBeGreaterThan(MAX_STORED);
    const raw = writeTableState(s);
    expect(raw.length).toBeLessThanOrEqual(MAX_STORED);
    const back = readTableState(raw);
    expect(namespacesOf(back, `ctx-${MAX_CONTEXTS - 1}`, SERVER)).toHaveLength(MAX_NAMESPACES);
    expect(hiddenOf(back, `kind${MAX_KINDS - 1}.example.com`)).toHaveLength(MAX_COLUMNS);
    expect(namespacesOf(back, "ctx-0", SERVER)).toEqual([]);
  });
});

describe("security review of part 3: several namespaces (M4, L5, L6)", () => {
  const obj = (ns: string, name = `o-${ns}`): KubeObject => ({ metadata: { name, namespace: ns, uid: `${ns}/${name}` } }) as KubeObject;
  const nine = Array.from({ length: 9 }, (_, i) => `ns-${i}`);

  it("M4: with more than eight chosen, rows of a namespace not chosen never reach the table", () => {
    const plan = watchPlan(nine);
    expect(plan).toEqual({ all: true, filter: nine });
    const all: WatchLike = { items: [...nine.map((n) => obj(n)), obj("ns-tenth"), obj("kube-system")], loading: false };
    const a = allAnswer(plan as { all: true; filter: string[] }, all, nine);
    expect("state" in a && a.state.items.map((o) => o.metadata.namespace)).toEqual(nine);
    // No filter (none chosen): the whole cluster, as it came.
    expect(allAnswer({ all: true }, all, [])).toEqual({ state: all });
  });

  it("M4: a 403 on the all-namespaces watch watches the first eight one by one, and says which one it left out (L5)", () => {
    const a = allAnswer({ all: true, filter: nine }, { items: [], loading: false, error: { status: 403, message: "forbidden" } }, nine);
    expect(a).toEqual({ fallback: { each: nine.slice(0, 8), cut: 1 } });
    const plan = (a as { fallback: { each: string[]; cut?: number } }).fallback;
    const per = new Map<string, WatchLike>(plan.each.map((n) => [n, { items: [obj(n)], loading: false }]));
    const m = mergeEach(plan, per, nine);
    expect(m.items).toHaveLength(8);
    expect(m.cut).toBe(1);
    expect(m.left).toEqual(["ns-8"]);
    expect(unwatchedTitle(m)).toBe("Not watched (your role can't list across namespaces): ns-8");
    // Another error is the list's error, not a fallback.
    expect(allAnswer({ all: true, filter: nine }, { items: [], loading: false, error: { status: 500, message: "x" } }, nine)).toMatchObject({ state: { error: { status: 500 } } });
  });

  it("L5: a namespace whose own watch was refused is named; every one refused is the list's error", () => {
    const plan = { each: ["a", "b", "c"] };
    const no = { items: [], loading: false, error: { status: 403, message: "forbidden" } };
    const m = mergeEach(plan, new Map<string, WatchLike>([["a", { items: [obj("a")], loading: false }], ["b", no], ["c", no]]), plan.each);
    expect(m).toMatchObject({ failed: 2, refused: ["b", "c"] });
    expect(m.error).toBeUndefined();
    expect(unwatchedTitle(m)).toBe("Refused: b, c");
    expect(mergeEach(plan, new Map<string, WatchLike>([["a", no], ["b", no], ["c", no]]), plan.each).error).toEqual(no.error);
  });

  it("L6: rows show once one namespace has some; a skeleton only while none has", () => {
    const plan = { each: ["a", "b", "c"] };
    const first = mergeEach(plan, new Map<string, WatchLike>([["a", { items: [obj("a")], loading: false }]]), plan.each);
    expect(first).toMatchObject({ loading: false, partial: true });
    expect(first.items).toHaveLength(1);
    expect(mergeEach(plan, new Map<string, WatchLike>([["a", { items: [], loading: false }]]), plan.each)).toMatchObject({ loading: true, partial: true });
    const whole = mergeEach(plan, new Map<string, WatchLike>(plan.each.map((n) => [n, { items: [obj(n)], loading: false }])), plan.each);
    expect(whole.loading).toBe(false);
    expect(whole.partial).toBeUndefined();
  });
});

describe("security review of part 3: the selection (M2, M4)", () => {
  it("M4: a selection is of one list: read for another kind or other namespaces it is empty", () => {
    const s = { key: listKey("configmaps", ["landlens-dev"]), uids: new Set(["u1", "u2"]) };
    expect([...selectionFor(s, listKey("configmaps", ["landlens-dev"]))]).toEqual(["u1", "u2"]);
    expect(selectionFor(s, listKey("secrets", ["landlens-dev"])).size).toBe(0);
    expect(selectionFor(s, listKey("configmaps", ["landlens-dev", "default"])).size).toBe(0);
    expect(selectionFor(s, listKey("configmaps", [])).size).toBe(0);
  });

  it("M2: what stays selected is what the table shows: a row that leaves the segment leaves the selection", () => {
    // Five failing pods selected; two recover and leave the Failing segment's rows.
    const sel = new Set(["p1", "p2", "p3", "p4", "p5"]);
    expect([...pruned(sel, ["p1", "p3", "p5"])]).toEqual(["p1", "p3", "p5"]);
  });

  it("M4: more than 50 turns the bar's actions off", () => {
    expect([1, 50, 51, 0].map(bulkAllowed)).toEqual([true, true, false, false]);
  });
});
