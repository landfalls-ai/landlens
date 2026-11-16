// Drain (wave 8 part 2, D150–D152): the plan's classes and blocks from table-driven pods, the ticks, the caps; and,
// against the in-memory fake API, that a review sends only GETs and dry runs and spends nothing, and that a run
// cordons first, evicts only the reviewed uids, retries a 429 and ends it blocked, treats a replaced pod as gone, stops
// on Stop with the node left cordoned, and never deletes a pod or sends a zero grace period.
import { describe, expect, it } from "vitest";
import { DRAIN_FOLLOW_LIST_MS, drainPlan, dryRunEvictions, evictionRequest, listNodes, readDrain, RUN_NOTES, runDrain, runnable, toEvict, type DrainKept, type RunState } from "../src/drain.js";
import { prepareOp } from "../src/changes.js";
import { cordonBody } from "../src/actions.js";
import { FakeApi } from "./fake-api.js";

const node = (name = "node-1", unschedulable = false) => ({ metadata: { name }, spec: unschedulable ? { unschedulable: true } : {} });
let n = 0;
const pod = (name: string, o: { ns?: string; owner?: string; phase?: string; mirror?: boolean; deleting?: boolean; emptyDir?: string[]; labels?: Record<string, string>; node?: string } = {}) => ({
  metadata: {
    name, namespace: o.ns ?? "landlens-dev", uid: `u${++n}`, labels: o.labels ?? { app: name },
    ...(o.owner ? { ownerReferences: [{ kind: o.owner, name: `${name}-owner`, controller: true }] } : {}),
    ...(o.mirror ? { annotations: { "kubernetes.io/config.mirror": "x" } } : {}),
    ...(o.deleting ? { deletionTimestamp: "now" } : {}),
  },
  spec: { nodeName: o.node ?? "node-1", volumes: (o.emptyDir ?? []).map((v) => ({ name: v, emptyDir: {} })) },
  status: { phase: o.phase ?? "Running" },
});
const pdb = (name: string, app: string, allowed: number, ns = "landlens-dev") => ({ metadata: { name, namespace: ns }, spec: { selector: { matchLabels: { app } } }, status: { disruptionsAllowed: allowed } });
const NONE = { bare: false, emptyDir: false };

describe("the drain plan", () => {
  it("classes every pod as kubectl drain would, and blocks what needs a tick or a budget", () => {
    const pods = [
      pod("web-1", { owner: "ReplicaSet", labels: { app: "web" } }),
      pod("web-2", { owner: "ReplicaSet", labels: { app: "web" } }),
      pod("api-1", { owner: "ReplicaSet", labels: { app: "api" } }),
      pod("agent", { owner: "DaemonSet" }),
      pod("kube-apiserver", { mirror: true }),
      pod("done", { owner: "Job", phase: "Succeeded" }),
      pod("bare-done", { phase: "Failed" }),
      pod("going", { owner: "ReplicaSet", deleting: true }),
      pod("bare"),
      pod("cache", { owner: "ReplicaSet", emptyDir: ["cache", "tmp"] }),
      pod("two", { owner: "ReplicaSet", labels: { app: "two", tier: "x" } }),
      pod("elsewhere", { owner: "ReplicaSet", node: "node-2" }),
    ];
    const pdbs = [pdb("web-pdb", "web", 0), pdb("api-pdb", "api", 1), pdb("two-a", "two", 1), { ...pdb("two-b", "two", 1), spec: { selector: { matchLabels: { tier: "x" } } } }, pdb("other-ns", "api", 0, "default")];
    const plan = drainPlan(node(), pods, pdbs, NONE);
    const by = Object.fromEntries(plan.pods.map((p) => [p.name, p]));
    expect(by.elsewhere).toBeUndefined();
    expect(by["web-1"]).toMatchObject({ class: "evict", blocked: "budget", budget: { name: "web-pdb", allowed: 0 }, bare: false, owner: { kind: "ReplicaSet", name: "web-1-owner" } });
    expect(by["api-1"]).toMatchObject({ class: "evict", budget: { name: "api-pdb", allowed: 1 } });
    expect(by["api-1"]!.blocked).toBeUndefined();
    expect(by.agent).toMatchObject({ class: "daemonset" });
    expect(by["kube-apiserver"]).toMatchObject({ class: "mirror" });
    expect(by.done).toMatchObject({ class: "finished" });
    expect(by["bare-done"]).toMatchObject({ class: "finished", bare: true });
    expect(by["bare-done"]!.blocked).toBeUndefined(); // a finished pod is gone already: no tick needed
    expect(by.going).toMatchObject({ class: "terminating" });
    expect(by.bare).toMatchObject({ class: "evict", bare: true, blocked: "needs-bare" });
    expect(by.cache).toMatchObject({ class: "evict", emptyDir: ["cache", "tmp"], blocked: "needs-emptydir" });
    expect(by.two).toMatchObject({ blocked: "many-budgets", budget: { many: ["two-a", "two-b"] } });
    expect(plan.counts).toEqual({ evict: 3, blocked: 5, skipped: 3 });
    // Blocked first, then evicted, then what stays.
    expect(plan.pods.slice(0, 5).every((p) => p.blocked)).toBe(true);
    expect(plan.pods.slice(-3).map((p) => p.class).sort()).toEqual(["daemonset", "mirror", "terminating"]);
    expect(runnable(plan)).toBe(false);
  });

  it("the two ticks unblock bare and emptyDir pods; budget blocks alone may run, and are tried", () => {
    const pods = [pod("bare"), pod("cache", { owner: "ReplicaSet", emptyDir: ["c"] }), pod("web", { owner: "ReplicaSet" })];
    const pdbs = [pdb("web-pdb", "web", 0)];
    const ticked = drainPlan(node(), pods, pdbs, { bare: true, emptyDir: true });
    expect(ticked.pods.filter((p) => p.blocked).map((p) => [p.name, p.blocked])).toEqual([["web", "budget"]]);
    expect(runnable(ticked)).toBe(true);
    expect(toEvict(ticked).map((p) => p.name).sort()).toEqual(["bare", "cache", "web"]);
    const half = drainPlan(node(), pods, pdbs, { bare: true, emptyDir: false });
    expect(runnable(half)).toBe(false);
    expect(toEvict(half).map((p) => p.name).sort()).toEqual(["bare", "web"]);
  });

  it("is partial past 2,000 pods, and when a namespace's budgets can't be listed; a partial plan can't run", async () => {
    const api = new FakeApi().node("node-1");
    for (let i = 0; i < 2001; i++) api.pod("landlens-dev", `p-${i}`, { owner: { kind: "ReplicaSet", name: "rs" } });
    const big = await readDrain(api.send, "node-1", NONE);
    expect(big.plan.partial).toMatch(/More than 2,000 pods/);
    expect(big.plan.pods).toHaveLength(2000);
    expect(runnable(big.plan)).toBe(false);

    const small = new FakeApi().node("node-1");
    small.pod("landlens-dev", "a", { owner: { kind: "ReplicaSet", name: "rs" } });
    small.pod("default", "b", { owner: { kind: "ReplicaSet", name: "rs" } });
    small.refuse = (r) => (r.path.startsWith("/apis/policy/v1/poddisruptionbudgets") || r.path.startsWith("/apis/policy/v1/namespaces/default/") ? 403 : undefined);
    const p = await readDrain(small.send, "node-1", NONE);
    expect(p.plan.partial).toBe("Landlens couldn't list the disruption budgets in default (HTTP 403).");
    expect(runnable(p.plan)).toBe(false);
  });

  it("builds the eviction with the pod's uid, never a grace period, and says dry run twice when it is one", () => {
    const real = evictionRequest({ namespace: "landlens-dev", name: "web", uid: "u1" }, false);
    expect(real).toEqual({ method: "POST", path: "/api/v1/namespaces/landlens-dev/pods/web/eviction", contentType: "application/json", body: JSON.stringify({ apiVersion: "policy/v1", kind: "Eviction", metadata: { name: "web", namespace: "landlens-dev" }, deleteOptions: { preconditions: { uid: "u1" } } }) });
    const dry = evictionRequest({ namespace: "landlens-dev", name: "web", uid: "u1" }, true);
    expect(dry.path).toBe("/api/v1/namespaces/landlens-dev/pods/web/eviction?dryRun=All");
    expect(JSON.parse(dry.body).deleteOptions).toEqual({ preconditions: { uid: "u1" }, dryRun: ["All"] });
    expect(() => evictionRequest({ namespace: "../x", name: "web", uid: "u1" }, true)).toThrow();
    expect(() => evictionRequest({ namespace: "a", name: "w/eb", uid: "u1" }, true)).toThrow();
  });
});

/** The hands scenario on one node, in the fake: web under a budget that allows none, cache with emptyDir, a bare pod, a DaemonSet pod. */
function hands() {
  const api = new FakeApi().node("node-1").node("node-2");
  const rs = (n: string) => ({ kind: "ReplicaSet", name: `${n}-rs` });
  api.pod("landlens-dev", "web-a", { labels: { app: "web" }, owner: rs("web") });
  api.pod("landlens-dev", "web-b", { labels: { app: "web" }, owner: rs("web") });
  api.pdb("landlens-dev", "web-pdb", { selector: { app: "web" }, minAvailable: 2 });
  api.pod("landlens-dev", "cache", { owner: rs("cache"), emptyDir: ["cache"] });
  api.pod("landlens-dev", "db-0", { labels: { app: "db" }, owner: { kind: "StatefulSet", name: "db" } });
  api.pdb("landlens-dev", "db-pdb", { selector: { app: "db" }, maxUnavailable: 1 });
  api.pod("landlens-dev", "bare");
  api.pod("landlens-dev", "agent", { owner: { kind: "DaemonSet", name: "agent" } });
  api.pod("landlens-dev", "other", { node: "node-2", owner: rs("other") });
  return api;
}
const snapshot = (api: FakeApi) => JSON.stringify([...api.objects.entries()].sort());

describe("a drain review against the fake API", () => {
  it("reads, then asks the API server with dry runs only: nothing is cordoned, evicted or spent", async () => {
    const api = hands();
    const before = snapshot(api);
    const read = await readDrain(api.send, "node-1", { bare: true, emptyDir: true });
    const { plan, disagree } = await dryRunEvictions(api.send, read.plan);
    const writes = api.requests.filter((r) => r.method !== "GET");
    expect(writes.length).toBe(5); // web-a, web-b, cache, db-0, bare: each one dry-run eviction
    for (const w of writes) {
      expect(w.path).toMatch(/\/eviction\?dryRun=All$/);
      expect(w.body.deleteOptions.dryRun).toEqual(["All"]);
    }
    expect(snapshot(api)).toBe(before); // no pod gone, no budget spent, the node as it was
    expect(disagree).toBe(0);
    const by = Object.fromEntries(plan.pods.map((p) => [p.name, p]));
    expect(by["web-a"]).toMatchObject({ blocked: "budget", dry: { status: 429, reason: "budget" } });
    expect(by["db-0"]).toMatchObject({ dry: { status: 201 } });
    expect(by["db-0"]!.blocked).toBeUndefined();
    expect(by.agent!.dry).toBeUndefined(); // skipped pods aren't asked about
  });

  it("where the cluster disagrees with the plan's reading, the row shows the cluster's answer", async () => {
    const api = hands();
    const read = await readDrain(api.send, "node-1", { bare: true, emptyDir: true });
    // The budget's status read said 0; meanwhile it allows one.
    api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 1;
    api.recompute();
    const { plan, disagree } = await dryRunEvictions(api.send, read.plan);
    expect(disagree).toBe(2);
    expect(plan.pods.find((p) => p.name === "web-a")!.blocked).toBeUndefined();
    expect(plan.counts.blocked).toBe(0);
  });
});

describe("a drain run against the fake API", () => {
  /** A review's kept requests, as main keeps them: the cordon dry-run-checked by prepareOp, and the pods to evict. */
  async function review(api: FakeApi, opts = { bare: true, emptyDir: true }): Promise<DrainKept> {
    const { node: n, plan } = await readDrain(api.send, "node-1", opts);
    if (plan.cordoned) return { node: "node-1", nodeUid: n.metadata.uid, ticks: opts, pods: toEvict(plan) };
    const p = await prepareOp(api.send, { verb: "patch", patchType: "merge", type: { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false }, name: "node-1", body: cordonBody(true) }, { fieldManager: "landlens" });
    return { node: "node-1", nodeUid: n.metadata.uid, ticks: opts, cordon: { method: p.method, path: p.path, contentType: p.contentType!, body: p.body! }, pods: toEvict(plan) };
  }
  function clock() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("cordons first, evicts only the reviewed uids, retries the budget's 429 and reports it blocked at the end", async () => {
    const api = hands();
    const kept = await review(api);
    api.requests.length = 0;
    // A pod that arrives after the review is not the review's to evict.
    api.pod("landlens-dev", "late", { owner: { kind: "ReplicaSet", name: "late-rs" } });
    const seen: RunState[] = [];
    const c = clock();
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: (s) => seen.push(s), ...c, limitMs: 60_000 });
    const writes = api.requests.filter((r) => r.method !== "GET");
    expect(writes[0]).toMatchObject({ method: "PATCH", path: "/api/v1/nodes/node-1?fieldManager=landlens" });
    expect(writes[0]!.body).toEqual({ spec: { unschedulable: true }, metadata: { resourceVersion: expect.any(String) } });
    const evicted = writes.slice(1);
    expect(evicted.every((w) => w.method === "POST" && /\/eviction$/.test(w.path))).toBe(true);
    const names = new Set(evicted.map((w) => w.body.metadata.name));
    expect([...names].sort()).toEqual(["bare", "cache", "db-0", "web-a", "web-b"]);
    for (const w of evicted) expect(w.body.deleteOptions.preconditions.uid).toBe(kept.pods.find((p) => p.name === w.body.metadata.name)!.uid);
    // The budget's pods were tried every 5 s for the run's minute: 13 times each (0, 5, … 60 s).
    expect(evicted.filter((w) => w.body.metadata.name === "web-a").length).toBeGreaterThanOrEqual(12);
    expect(end.state).toBe("timed-out");
    expect(end.pods.filter((p) => p.state === "blocked").map((p) => p.name).sort()).toEqual(["web-a", "web-b"]);
    expect(end.pods.filter((p) => p.state === "gone").map((p) => p.name).sort()).toEqual(["bare", "cache", "db-0"]);
    expect({ evicted: end.evicted, blocked: end.blocked }).toEqual({ evicted: 3, blocked: 2 });
    expect(api.get("/api/v1/namespaces/landlens-dev/pods/late")).toBeDefined();
    expect(api.get("/api/v1/namespaces/landlens-dev/pods/agent")).toBeDefined();
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBe(true);
    expect(seen[0]!.state).toBe("cordoning");
    // Never a plain DELETE of a pod, never a zero grace period, never a dry run in the run.
    expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(JSON.stringify(api.requests)).not.toMatch(/gracePeriodSeconds|dryRun/);
  });

  it("ends done when every pod has left; evicted pods are followed in the pod list until they are gone", async () => {
    const api = hands();
    api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 0;
    api.recompute();
    const kept = await review(api);
    api.linger = 2;
    const c = clock();
    const states: string[] = [];
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: (s) => states.push(s.pods.find((p) => p.name === "web-a")?.state ?? ""), ...c });
    expect(end.state).toBe("done");
    expect(end.evicted).toBe(5);
    expect(end.pods.every((p) => p.state === "gone")).toBe(true);
    expect(states).toContain("evicted");
    expect(states.at(-1)).toBe("gone");
  });

  it("a pod replaced under the same name is not evicted: the uid precondition answers 409, and it is gone", async () => {
    const api = hands();
    const kept = await review(api, { bare: true, emptyDir: true });
    // The StatefulSet's db-0 is replaced: same name, new uid.
    api.objects.delete("/api/v1/namespaces/landlens-dev/pods/db-0");
    const fresh = api.pod("landlens-dev", "db-0", { labels: { app: "db" }, owner: { kind: "StatefulSet", name: "db" } });
    const c = clock();
    api.requests.length = 0;
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...c, limitMs: 10_000 });
    // Seen at the run's first reading (L7): not even asked.
    expect(end.pods.find((p) => p.name === "db-0")!).toMatchObject({ state: "gone", note: "It was already gone" });
    expect(api.requests.some((r) => r.path.endsWith("/pods/db-0/eviction"))).toBe(false);
    expect(api.get("/api/v1/namespaces/landlens-dev/pods/db-0").metadata.uid).toBe(fresh);

    // Replaced between that reading and its eviction: the uid precondition answers 409.
    const api2 = hands();
    const kept2 = await review(api2, { bare: true, emptyDir: true });
    let fresh2 = "";
    api2.answer = (r) => {
      if (r.path.endsWith("/pods/db-0/eviction") && !fresh2) {
        api2.objects.delete("/api/v1/namespaces/landlens-dev/pods/db-0");
        fresh2 = api2.pod("landlens-dev", "db-0", { labels: { app: "db" }, owner: { kind: "StatefulSet", name: "db" } });
      }
      return undefined;
    };
    const end2 = await runDrain({ send: api2.send, kept: kept2, stopped: () => false, onProgress: () => {}, ...clock(), limitMs: 10_000 });
    expect(end2.pods.find((p) => p.name === "db-0")!).toMatchObject({ state: "gone", note: "Another pod has its name now; not evicted" });
    expect(api2.get("/api/v1/namespaces/landlens-dev/pods/db-0").metadata.uid).toBe(fresh2);
  });

  it("Stop sends no new eviction, and the node stays cordoned", async () => {
    const api = hands();
    const kept = await review(api);
    api.requests.length = 0;
    let stop = false;
    let evictions = 0;
    const inner = api.send;
    const send: typeof api.send = async (r) => {
      if (r.path.endsWith("/eviction") && ++evictions === 1) stop = true; // Stop pressed while the first is in flight
      return inner(r);
    };
    const c = clock();
    const end = await runDrain({ send, kept, stopped: () => stop, onProgress: () => {}, ...c });
    expect(end.state).toBe("stopped");
    // Those already in flight (the first batch of four) finish; nothing is sent after.
    expect(evictions).toBeLessThanOrEqual(4);
    const after = api.requests.filter((r) => r.path.endsWith("/eviction")).length;
    expect(after).toBe(evictions);
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBe(true);
    expect(api.requests.some((r) => r.method === "PATCH" && r.body?.spec?.unschedulable === null)).toBe(false);
  });

  it("a node replaced since the preview stops the run before any request but reads", async () => {
    const api = hands();
    const kept = await review(api);
    api.get("/api/v1/nodes/node-1").metadata.uid = "another-node";
    api.requests.length = 0;
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end).toMatchObject({ state: "failed", note: RUN_NOTES.replaced });
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("L5: a node whose version moved since the preview is cordoned once more, pinned to the version just read", async () => {
    const api = hands();
    const kept = await review(api);
    // The kubelet's status report moves the version; the node is the same and still schedulable.
    api.get("/api/v1/nodes/node-1").metadata.resourceVersion = "999";
    api.requests.length = 0;
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock(), limitMs: 10_000 });
    const patches = api.requests.filter((r) => r.method === "PATCH");
    expect(patches.map((r) => r.body.metadata.resourceVersion)).toEqual([JSON.parse(kept.cordon!.body).metadata.resourceVersion, "999"]);
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBe(true);
    expect(end.state).not.toBe("failed");
    expect(api.requests.some((r) => r.path.endsWith("/eviction"))).toBe(true);
    // Moved again between the read and the second send: a conflict, and nothing evicted.
    const api2 = hands();
    const kept2 = await review(api2);
    const node = api2.get("/api/v1/nodes/node-1");
    node.metadata.resourceVersion = "999";
    api2.requests.length = 0;
    api2.answer = (r) => (r.method === "PATCH" ? (node.metadata.resourceVersion = String(Number(node.metadata.resourceVersion) + 1), undefined) : undefined);
    const end2 = await runDrain({ send: api2.send, kept: kept2, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end2).toMatchObject({ state: "failed", note: "The node changed since the preview. Nothing was evicted." });
    expect(api2.requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
    expect(api2.requests.some((r) => r.path.endsWith("/eviction"))).toBe(false);
  });

  it("M3: a node cordoned at the preview and uncordoned since gets no eviction", async () => {
    const api = hands();
    api.get("/api/v1/nodes/node-1").spec.unschedulable = true;
    const kept = await review(api);
    expect(kept.cordon).toBeUndefined();
    delete api.get("/api/v1/nodes/node-1").spec.unschedulable; // someone uncordons it in the review's 15 minutes
    api.requests.length = 0;
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end).toMatchObject({ state: "failed", note: RUN_NOTES.uncordoned });
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("M3: uncordoned during the run, no more evictions; the end says the node isn't cordoned", async () => {
    const api = hands();
    const kept = await review(api);
    let evictions = 0;
    api.answer = (r) => {
      // Someone uncordons the node after the first pass of evictions.
      if (r.path.endsWith("/eviction") && ++evictions === 5) delete api.get("/api/v1/nodes/node-1").spec.unschedulable;
      return undefined;
    };
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock(), limitMs: 60_000 });
    expect(end.state).toBe("failed");
    expect(end.note).toBe(RUN_NOTES.uncordonedDuring);
    // web-a and web-b were waiting on their budget: never tried again.
    expect(api.requests.filter((r) => r.path.endsWith("/eviction")).length).toBe(5);
    expect(end.cordoned).toBe(false);
  });

  it("M3: pods that arrived after the preview are counted at the end", async () => {
    const api = hands();
    api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 0;
    api.recompute();
    const kept = await review(api);
    api.pod("landlens-dev", "late", { owner: { kind: "ReplicaSet", name: "late-rs" } });
    api.pod("landlens-dev", "late-agent", { owner: { kind: "DaemonSet", name: "agent" } }); // stays: not counted
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end.state).toBe("done");
    expect(end).toMatchObject({ cordoned: true, arrived: 1 });
    expect(api.get("/api/v1/namespaces/landlens-dev/pods/late")).toBeDefined();
  });

  it("L7: a reviewed pod whose controller went since is not evicted without the bare tick", async () => {
    const api = hands();
    const kept = await review(api, { bare: false, emptyDir: true });
    expect(kept.pods.map((p) => p.name)).toContain("db-0");
    delete api.get("/api/v1/namespaces/landlens-dev/pods/db-0").metadata.ownerReferences; // orphaned
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock(), limitMs: 10_000 });
    expect(end.pods.find((p) => p.name === "db-0")).toMatchObject({ state: "blocked" });
    expect(api.requests.some((r) => r.path === "/api/v1/namespaces/landlens-dev/pods/db-0/eviction")).toBe(false);
    expect(api.get("/api/v1/namespaces/landlens-dev/pods/db-0")).toBeDefined();
  });

  it("L2: no eviction is sent after the run's time, even inside a pass", async () => {
    const api = hands();
    api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 0;
    api.recompute();
    const kept = await review(api);
    const c = clock();
    let t0 = 0;
    const sentAt: number[] = [];
    const send: typeof api.send = async (r) => {
      if (r.path.endsWith("/eviction")) {
        sentAt.push(c.now());
        await c.sleep(20_000); // a slow API server: each eviction takes 20 s
      }
      return api.send(r);
    };
    t0 = c.now();
    const end = await runDrain({ send, kept, stopped: () => false, onProgress: () => {}, ...c, limitMs: 30_000 });
    expect(sentAt.length).toBeGreaterThan(0);
    for (const at of sentAt) expect(at - t0).toBeLessThan(30_000);
    expect(end.state).toBe("timed-out");
    // Never reached: said as such, not left waiting.
    expect(end.pods.filter((p) => p.state === "waiting")).toEqual([]);
    expect(end.pods.some((p) => p.note === "Not tried: the drain's time was up")).toBe(true);
  });

  it("L3: evicted pods are followed by name, not by a cluster-wide list every round", async () => {
    const api = hands();
    api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 0;
    api.recompute();
    const kept = await review(api);
    api.linger = 6;
    api.requests.length = 0;
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end.state).toBe("done");
    const lists = api.requests.filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/pods?"));
    expect(lists).toHaveLength(2); // the run's first reading and its last
    expect(api.requests.filter((r) => r.method === "GET" && /^\/api\/v1\/namespaces\/landlens-dev\/pods\/[a-z0-9-]+$/.test(r.path)).length).toBeGreaterThanOrEqual(5);
  });

  it("L3: past 20 evicted pods, one list from the cache, at most every 5 s", async () => {
    const api = new FakeApi().node("node-1");
    for (let i = 0; i < 30; i++) api.pod("landlens-dev", `p-${i}`, { owner: { kind: "ReplicaSet", name: "rs" } });
    const kept = await review(api);
    api.linger = 40;
    api.requests.length = 0;
    const c = clock();
    const at: number[] = [];
    const send: typeof api.send = async (r) => {
      if (r.path.includes("resourceVersion=0")) at.push(c.now());
      return api.send(r);
    };
    await runDrain({ send, kept, stopped: () => false, onProgress: () => {}, ...c, limitMs: 60_000 });
    expect(at.length).toBeGreaterThan(1);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(DRAIN_FOLLOW_LIST_MS);
    expect(api.requests.some((r) => /^\/api\/v1\/namespaces\/landlens-dev\/pods\/p-\d+$/.test(r.path))).toBe(false);
  });

  it("L4: a 429 that isn't a budget's honours its Retry-After and ends 'too busy', not blocked", async () => {
    const api = hands();
    api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 0;
    api.recompute();
    const kept = await review(api);
    const c = clock();
    const tries: number[] = [];
    api.answer = (r) => {
      if (!r.path.endsWith("/pods/db-0/eviction")) return undefined;
      tries.push(c.now());
      return { status: 429, text: JSON.stringify({ kind: "Status", code: 429, reason: "TooManyRequests", details: { retryAfterSeconds: 20 } }), warnings: [] };
    };
    const end = await runDrain({ send: api.send, kept, stopped: () => false, onProgress: () => {}, ...c, limitMs: 60_000 });
    expect(tries.length).toBeGreaterThan(1);
    for (let i = 1; i < tries.length; i++) expect(tries[i]! - tries[i - 1]!).toBeGreaterThanOrEqual(20_000);
    expect(end.pods.find((p) => p.name === "db-0")).toMatchObject({ state: "failed", note: "The cluster was too busy to take it in time" });
    expect(end.blocked).toBe(0);
  });

  it("L6: a cordon whose answer is lost says the node may be cordoned; an eviction lost then 404 counts as evicted", async () => {
    const api = hands();
    const kept = await review(api);
    const lost: typeof api.send = async (r) => {
      if (r.method === "PATCH") throw Object.assign(new Error("timeout"), { status: 504 });
      return api.send(r);
    };
    const end = await runDrain({ send: lost, kept, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end).toMatchObject({ state: "failed", note: RUN_NOTES.cordonLost });

    const api2 = hands();
    api2.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").spec.minAvailable = 0;
    api2.recompute();
    const kept2 = await review(api2);
    let first = true;
    const once: typeof api2.send = async (r) => {
      if (r.path.endsWith("/pods/bare/eviction") && first) {
        first = false;
        await api2.send(r); // the cluster takes it; the answer never arrives
        throw Object.assign(new Error("timeout"), { status: 504 });
      }
      return api2.send(r);
    };
    const end2 = await runDrain({ send: once, kept: kept2, stopped: () => false, onProgress: () => {}, ...clock() });
    expect(end2.state).toBe("done");
    expect(end2.evicted).toBe(5);
    expect(end2.pods.find((p) => p.name === "bare")).toMatchObject({ state: "gone", note: "Evicted" });
  });
});

describe("the plan's edges (security review of part 2)", () => {
  it("L1: a namespace with more than 2,000 budgets is partial when the cluster-wide list is refused; so is a cluster-wide list past 2,000", async () => {
    const put = (api: FakeApi, ns: string, n: number) => {
      for (let i = 0; i < n; i++) {
        api.objects.set(`/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets/b-${i}`, {
          kind: "PodDisruptionBudget", metadata: { name: `b-${i}`, namespace: ns, uid: `b${i}`, resourceVersion: "1" },
          spec: { selector: { matchLabels: { app: `none-${i}` } } }, status: { disruptionsAllowed: 1 },
        });
      }
    };
    const one = new FakeApi().node("node-1");
    one.pod("landlens-dev", "a", { owner: { kind: "ReplicaSet", name: "rs" } });
    put(one, "landlens-dev", 2001);
    one.refuse = (r) => (r.path.startsWith("/apis/policy/v1/poddisruptionbudgets") ? 403 : undefined);
    const p = await readDrain(one.send, "node-1", NONE);
    expect(p.plan.partial).toMatch(/More than 2,000 disruption budgets/);
    expect(runnable(p.plan)).toBe(false);

    const all = new FakeApi().node("node-1");
    all.pod("landlens-dev", "a", { owner: { kind: "ReplicaSet", name: "rs" } });
    put(all, "default", 2001);
    const q = await readDrain(all.send, "node-1", NONE);
    expect(q.plan.partial).toMatch(/More than 2,000 disruption budgets/);
  });

  it("L12: a DaemonSet pod whose DaemonSet is gone is evicted as a bare pod; one whose DaemonSet is there stays", async () => {
    const api = new FakeApi().node("node-1");
    api.pod("landlens-dev", "lost-agent", { owner: { kind: "DaemonSet", name: "gone-ds" } });
    api.pod("landlens-dev", "agent", { owner: { kind: "DaemonSet", name: "agent" } });
    api.objects.delete("/apis/apps/v1/namespaces/landlens-dev/daemonsets/gone-ds");
    const p = await readDrain(api.send, "node-1", NONE);
    const by = Object.fromEntries(p.plan.pods.map((x) => [x.name, x]));
    expect(by["lost-agent"]).toMatchObject({ class: "evict", bare: true, orphan: true, blocked: "needs-bare" });
    expect(by.agent).toMatchObject({ class: "daemonset", bare: false });
    expect(by.agent!.orphan).toBeUndefined();
    const ticked = await readDrain(api.send, "node-1", { bare: true, emptyDir: false });
    expect(toEvict(ticked.plan).map((x) => x.name)).toEqual(["lost-agent"]);
    // Only reads.
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("L10: the nodes are read in pages", async () => {
    const api = new FakeApi();
    for (let i = 0; i < 501; i++) api.node(`n-${i}`);
    const got = await listNodes(api.send);
    expect(got.items).toHaveLength(501);
    expect(api.requests.filter((r) => r.path.startsWith("/api/v1/nodes?")).length).toBe(2);
  });
});
