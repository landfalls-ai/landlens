// Nodes in main (wave 8 part 2, D149–D154), against the in-memory fake API (packages/kube/test/fake-api.ts): no real
// node is ever cordoned or drained. D153: an unpackaged build not told it may write to a context's nodes sends no
// request with a write verb or a dry run to a node or an eviction (the fake's record), and builds its reviews from
// reads, preview only, with nothing to apply; told, it dry-runs; packaged, the variable doesn't matter. A drain's Apply
// asks in main's dialog (Cancel sends nothing), answers with a run at once, evicts only the reviewed uids with its own
// token, pushes progress to its window only, stops on Stop (only from that window) or when its window goes, leaves
// the node cordoned, and writes one log row.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
type Sent = { method: string; path: string; body?: string; token: string };
const sent: Sent[] = [];
let api: FakeApi;
vi.mock("@landlens/kube-mcp", () => ({
  frontDoorSend: ({ token }: { token: string }) => async (r: { method: string; path: string; body?: string }) => {
    sent.push({ ...r, token });
    return api.send(r);
  },
}));
import type { ActionReview, DrainProgress } from "@landlens/contracts";
import { FakeApi } from "../../../packages/kube/test/fake-api";
import { ActionService, cardDigest, fenced, nodeWrite, nodeWritesFrom, PREVIEW_ONLY } from "../src/main/actions";

const types = [
  { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false, verbs: ["get", "list", "patch", "delete"] },
  { group: "", version: "v1", resource: "pods", kind: "Pod", namespaced: true, verbs: ["get", "list", "delete"] },
];
const H = "h1234567";

function window() {
  const e = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; send: (c: string, p: unknown) => void; pushed: { channel: string; payload: any }[]; destroyed: boolean };
  e.pushed = [];
  e.destroyed = false;
  e.isDestroyed = () => e.destroyed;
  e.send = (channel, payload) => e.pushed.push({ channel, payload });
  return e as any;
}

/** The hands scenario on one node of two, in the fake. */
function cluster() {
  api = new FakeApi().node("node-1").node("node-2");
  const rs = (n: string) => ({ kind: "ReplicaSet", name: `${n}-rs` });
  api.pod("landlens-dev", "web-a", { labels: { app: "web" }, owner: rs("web") });
  api.pod("landlens-dev", "web-b", { labels: { app: "web" }, owner: rs("web") });
  api.pdb("landlens-dev", "web-pdb", { selector: { app: "web" }, minAvailable: 2 });
  api.pod("landlens-dev", "cache", { owner: rs("cache"), emptyDir: ["cache"] });
  api.pod("landlens-dev", "bare");
  api.pod("landlens-dev", "agent", { owner: { kind: "DaemonSet", name: "agent" } });
  return api;
}

function setup(o: { writes?: (c: string) => boolean } = {}) {
  sent.length = 0;
  cluster();
  let n = 0;
  const issue = vi.fn(() => String(++n % 10).repeat(64));
  const revoke = vi.fn();
  let gone: (h: string) => void = () => {};
  const clusters = { get: (h: string) => (h === H ? { info: { context: "orbstack", server: "https://127.0.0.1:26443" } } : (() => { throw Object.assign(new Error("not connected"), { status: 404 }); })()), onGone: (f: (h: string) => void) => (gone = f), discovery: async () => types };
  const door = { issueToken: issue, revokeToken: revoke, clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "" };
  const rows: any[] = [];
  const counted: any[] = [];
  const log = {
    add: (e: any) => (rows.push(e), e),
    settle: (id: string, end: any) => {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...end };
    },
    list: () => rows.slice().reverse(),
  };
  let t = 1_000_000;
  const svc = new ActionService({
    clusters: clusters as any, frontDoor: door as any, log: log as any, counted: (a) => counted.push(a),
    ...(o.writes ? { nodeWrites: o.writes } : {}),
    now: () => t, sleep: async (ms) => void (t += ms), drainLimitMs: 30_000,
  });
  return { svc, issue, revoke, rows, counted, gone: (h: string) => gone(h) };
}

/** Requests that wrote to a node or evicted a pod, or carried a dry run (D153's test). */
const nodeTouches = () => api.requests.filter((r) => r.method !== "GET" && (/\/api\/v1\/nodes/.test(r.path) || /\/eviction/.test(r.path) || /dryRun/.test(r.path) || JSON.stringify(r.body ?? "").includes("dryRun")));
const drain = (bare = true, emptyDir = true) => ({ handle: H, action: { kind: "drain" as const, node: "node-1", bare, emptyDir } });

describe("D153: a development build sends nothing to nodes unless told", () => {
  it("unpackaged and not listed: cordon and drain are previews from reads, with nothing to apply and no node write sent", async () => {
    const { svc } = setup({ writes: nodeWritesFrom({}, false) });
    const a = window();
    const c = await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: true } }, a);
    expect(c.previewOnly).toBe(true);
    expect(c.id).toBeUndefined();
    expect(c.title).toBe("Cordon node node-1");
    // Landlens's own reading of the patch, shown as a diff, with the cluster-wide tag.
    expect(c.operations![0]!.diff.lines.filter((l) => l.t === "+").map((l) => l.text.trim())).toContain("unschedulable: true");
    expect(c.operations![0]!.risk).toEqual(["cluster-scoped"]);
    expect(c.facts!.map((f) => f.code)).toEqual(["pods-stay"]);
    const d = await svc.review(drain(), a);
    expect(d.previewOnly).toBe(true);
    expect(d.id).toBeUndefined();
    expect(d.plan!.counts).toEqual({ evict: 2, blocked: 2, skipped: 1 });
    expect(d.plan!.pods.every((p) => p.dry === undefined)).toBe(true);
    // A Node's delete is a node write too.
    const del = await svc.review({ handle: H, action: { kind: "delete", targets: [{ group: "", version: "v1", resource: "nodes", name: "node-1" }] } }, a);
    expect(del.id).toBeUndefined();
    expect(del.problems![0]!.message).toContain(PREVIEW_ONLY);
    expect(nodeTouches()).toEqual([]);
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBeUndefined();
  });

  it("with no rule given at all, the same: the safe default", async () => {
    const { svc } = setup();
    await svc.review(drain(), window());
    await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: true } }, window());
    expect(nodeTouches()).toEqual([]);
  });

  it("listed: the cordon's dry run and the dry-run evictions are sent, and the reviews can be applied", async () => {
    const { svc } = setup({ writes: nodeWritesFrom({ LANDLENS_NODE_WRITES: "kind-x, orbstack" }, false) });
    const c = await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: true } }, window());
    expect(c.id).toMatch(/^ed/);
    expect(c.previewOnly).toBeUndefined();
    const d = await svc.review(drain(), window());
    expect(d.id).toMatch(/^ed/);
    expect(d.native).toBe(true);
    const touches = nodeTouches();
    expect(touches.some((r) => r.method === "PATCH" && r.path.startsWith("/api/v1/nodes/node-1?") && r.path.includes("dryRun=All"))).toBe(true);
    expect(touches.filter((r) => r.path.endsWith("/eviction?dryRun=All")).length).toBe(4);
    // Every one a dry run: nothing written, nothing spent.
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBeUndefined();
    expect(api.get("/apis/policy/v1/namespaces/landlens-dev/poddisruptionbudgets/web-pdb").status.disruptedPods).toEqual({});
    expect(api.podsOn("node-1")).toHaveLength(5);
  });

  it("packaged ignores the variable; unpackaged takes exact names only", () => {
    expect(nodeWritesFrom({}, true)("orbstack")).toBe(true);
    expect(nodeWritesFrom({ LANDLENS_NODE_WRITES: "" }, true)("anything")).toBe(true);
    expect(nodeWritesFrom({}, false)("orbstack")).toBe(false);
    expect(nodeWritesFrom({ LANDLENS_NODE_WRITES: "orbstack-2" }, false)("orbstack")).toBe(false);
    expect(nodeWritesFrom({ LANDLENS_NODE_WRITES: "*" }, false)("orbstack")).toBe(false);
  });

  it("the fence refuses every node write and eviction, dry run or not, however the path is spelled; reads pass", async () => {
    for (const r of [
      { method: "PATCH", path: "/api/v1/nodes/node-1?dryRun=All" }, { method: "PATCH", path: "/api/v1/nodes/node-1" },
      { method: "DELETE", path: "/api/v1/nodes/node-1" }, { method: "POST", path: "/api/v1/nodes" }, { method: "PUT", path: "//api/v1//nodes/node-1" },
      { method: "POST", path: "/api/v1/namespaces/a/pods/b/eviction" }, { method: "POST", path: "/api/v1/namespaces/a/pods/b/eviction?dryRun=All" },
    ]) expect([r.path, nodeWrite(r)]).toEqual([r.path, true]);
    for (const r of [{ method: "GET", path: "/api/v1/nodes/node-1" }, { method: "PATCH", path: "/apis/apps/v1/namespaces/a/deployments/nodes" }, { method: "DELETE", path: "/api/v1/namespaces/a/configmaps/eviction-notes" }]) {
      expect([r.path, nodeWrite(r)]).toEqual([r.path, false]);
    }
    const inner = vi.fn(async () => ({ status: 200, text: "{}", warnings: [] }));
    await expect(fenced(inner)({ method: "PATCH", path: "/api/v1/nodes/node-1" })).rejects.toMatchObject({ status: 403, message: PREVIEW_ONLY });
    expect(inner).not.toHaveBeenCalled();
    await fenced(inner)({ method: "GET", path: "/api/v1/nodes/node-1" });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("cordon and drain, told it may (against the fake API only)", () => {
  const ALLOW = () => true;

  it("cordons: main's title and facts, the pinned patch, a log row; uncordon sends null", async () => {
    const { svc, rows, issue } = setup({ writes: ALLOW });
    const a = window();
    const r = await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: true } }, a);
    expect(issue).toHaveBeenLastCalledWith(expect.objectContaining({ label: "you · orbstack · cordon node-1" }));
    expect(r.facts).toEqual([{ tone: "info", code: "pods-stay", text: "5 pods keep running; new ones go elsewhere." }]);
    expect(r.operations![0]!.risk).toContain("cluster-scoped");
    api.requests.length = 0;
    const out = await svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async () => { throw new Error("no dialog for a cordon"); });
    expect(out).toEqual({ results: [{ target: "node node-1", outcome: "applied" }] });
    expect(api.requests.map((q) => [q.method, q.path, q.body])).toEqual([["PATCH", "/api/v1/nodes/node-1?fieldManager=landlens", { spec: { unschedulable: true }, metadata: { resourceVersion: expect.any(String) } }]]);
    expect(rows.at(-1)).toMatchObject({ action: "cordon", kind: "Node", names: ["node-1"], outcome: "applied" });
    expect((await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: true } }, a)).problems).toEqual([{ message: "node-1 is already cordoned." }]);
    const u = await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: false } }, a);
    expect(u.title).toBe("Uncordon node node-1");
    await svc.apply({ handle: H, id: u.id!, digest: u.digest! }, a, async () => true);
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBeUndefined();
    expect(rows.at(-1)).toMatchObject({ action: "uncordon", outcome: "applied" });
  });

  it("says when the node is the only one that takes new pods", async () => {
    const { svc } = setup({ writes: ALLOW });
    api.get("/api/v1/nodes/node-2").spec.unschedulable = true;
    const r = await svc.review({ handle: H, action: { kind: "cordon", node: "node-1", on: true } }, window());
    expect(r.facts![0]).toEqual({ tone: "bad", code: "only-node", text: "This is the only node that takes new pods." });
    expect(r.facts![1]).toEqual({ tone: "info", code: "pods-stay", text: "5 pods keep running; new ones stay Pending." });
  });

  it("a drain waiting on a tick, or partial, has no id: main can't be asked to run it", async () => {
    const { svc } = setup({ writes: ALLOW });
    const r = await svc.review(drain(false, true), window());
    expect(r.plan!.pods.find((p) => p.name === "bare")!.blocked).toBe("needs-bare");
    expect(r.id).toBeUndefined();
  });

  it("asks in main's dialog first; Cancel sends nothing and keeps the review", async () => {
    const { svc, rows } = setup({ writes: ALLOW });
    const a = window();
    const r = await svc.review(drain(), a);
    api.requests.length = 0;
    const asked: any[] = [];
    await expect(svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toMatchObject({ status: 409, message: "Cancelled." });
    expect(asked).toEqual([{
      message: "Drain node-1 on orbstack?",
      detail: "2 pods will be evicted, 2 are blocked by a disruption budget and will be retried, 1 DaemonSet pod stay.\nThe node stays cordoned until you uncordon it.\n\n4 Pods: 4 in landlens-dev.\n\nlandlens-dev/bare\nlandlens-dev/cache\nlandlens-dev/web-a\nlandlens-dev/web-b",
      yes: "Drain",
    }]);
    expect(api.requests).toEqual([]);
    expect(rows.map((x) => x.outcome)).toEqual(["cancelled"]);
    // Kept: the same review can still be applied.
    const out = await svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async () => true);
    expect(out).toEqual({ run: r.id });
  });

  async function started(o: { stopAt?: number } = {}) {
    const s = setup({ writes: ALLOW });
    const a = window();
    const r: ActionReview = await s.svc.review(drain(), a);
    api.requests.length = 0;
    sent.length = 0;
    // A pod that arrives after the review is not the review's to evict.
    api.pod("landlens-dev", "late", { owner: { kind: "ReplicaSet", name: "late-rs" } });
    let evictions = 0;
    let rowsAtFirstWrite: string[] | undefined;
    const inner = api.send.bind(api);
    (api as any).send = async (q: any) => {
      if (q.method !== "GET") rowsAtFirstWrite ??= s.rows.map((x) => x.outcome);
      if (o.stopAt !== undefined && q.path.endsWith("/eviction") && ++evictions === o.stopAt) s.svc.stop(r.id!, a);
      return inner(q);
    };
    const out = await s.svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async () => true) as { run: string };
    return { ...s, a, r, run: out.run, get rowsAtFirstWrite() { return rowsAtFirstWrite; } };
  }

  it("runs in main: answers at once, cordons, evicts only the reviewed uids with its own token, pushes progress to its window, logs one row", async () => {
    const { a, r, run, rows, revoke, issue, counted, rowsAtFirstWrite } = await started();
    expect(run).toBe(r.id);
    // The row was written, as sent, before the cordon went (security review of part 1, M3).
    expect(rowsAtFirstWrite).toEqual(["sent"]);
    await vi.waitFor(() => expect(rows[0]?.outcome).not.toBe("sent"));
    expect(rows).toHaveLength(1);
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ label: "you · orbstack · drain node-1" }));
    const token = sent[0]!.token;
    expect(sent.every((s) => s.token === token)).toBe(true);
    expect(revoke).toHaveBeenLastCalledWith(token);
    const writes = api.requests.filter((q) => q.method !== "GET");
    expect(writes[0]).toMatchObject({ method: "PATCH", path: "/api/v1/nodes/node-1?fieldManager=landlens" });
    const evicted = new Set(writes.slice(1).map((w) => w.body.metadata.name));
    expect([...evicted].sort()).toEqual(["bare", "cache", "web-a", "web-b"]);
    expect(api.get("/api/v1/namespaces/landlens-dev/pods/late")).toBeDefined();
    expect(api.requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(JSON.stringify(api.requests)).not.toMatch(/gracePeriodSeconds|dryRun/);
    // Progress: only on action:progress, to this window, naming the run; the last says how it ended.
    const pushes = a.pushed.map((p: { channel: string }) => p.channel);
    expect(new Set(pushes)).toEqual(new Set(["action:progress"]));
    const last = a.pushed.at(-1)!.payload as DrainProgress;
    expect(last).toMatchObject({ run, node: "node-1", state: "timed-out" });
    expect(last.pods.filter((p) => p.state === "blocked").map((p) => p.name).sort()).toEqual(["web-a", "web-b"]);
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBe(true);
    expect(rows[0]).toMatchObject({ action: "drain", kind: "Node", names: ["node-1"], detail: "2 evicted, 2 blocked", outcome: "partial" });
    expect(counted.at(-1)).toEqual({ action: "drain", outcome: "partial" });
  });

  it("Stop is the starting window's only; it sends no new eviction, the node stays cordoned, the log says stopped", async () => {
    const s = setup({ writes: ALLOW });
    const a = window();
    const b = window();
    const r = await s.svc.review(drain(), a);
    const out = await s.svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async () => true) as { run: string };
    expect(() => s.svc.stop(out.run, b)).toThrow(/no such run/);
    s.svc.stop(out.run, a);
    await vi.waitFor(() => expect(s.rows[0]?.outcome).not.toBe("sent"));
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ action: "drain", outcome: "stopped" });
    expect(api.get("/api/v1/nodes/node-1").spec.unschedulable).toBe(true);
    expect(api.requests.some((q) => q.method === "PATCH" && q.body?.spec?.unschedulable === null)).toBe(false);
    expect(b.pushed).toEqual([]);
  });

  it("a run ends with its window", async () => {
    const s = setup({ writes: ALLOW });
    const a = window();
    const r = await s.svc.review(drain(), a);
    await s.svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async () => true);
    a.emit("render-process-gone");
    await vi.waitFor(() => expect(s.rows[0]?.outcome).not.toBe("sent"));
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].outcome).toBe("stopped");
  });

  it("main's dialog names every pod it evicts in a system namespace, and counts them by namespace (M1)", async () => {
    const { svc } = setup({ writes: ALLOW });
    api.pod("kube-system", "coredns-1", { owner: { kind: "ReplicaSet", name: "coredns" } });
    const a = window();
    const r = await svc.review(drain(), a);
    const asked: any[] = [];
    await expect(svc.apply({ handle: H, id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0].detail).toContain("5 Pods: 1 in kube-system, 4 in landlens-dev.\n\nIn a system namespace:\nkube-system/coredns-1\n\nlandlens-dev/bare");
  });

  it("a drain's digest covers its plan and main's dialog, not only the requests it keeps (L2)", async () => {
    const { svc } = setup({ writes: ALLOW });
    const a = window();
    const r = await svc.review(drain(), a);
    const { digest, ...card } = r;
    const kept = (svc as any).reviews.get(r.id).drain;
    expect(digest).toBe(cardDigest(card, kept));
    // Another plan with the same kept requests (one more pod that stays) is another digest.
    const other = { ...card, plan: { ...card.plan!, counts: { ...card.plan!.counts, skipped: card.plan!.counts.skipped + 1 } } };
    expect(cardDigest(other, kept)).not.toBe(digest);
  });

  it("one run per node; a digest that isn't the review's drops it; another window can't apply it", async () => {
    const s = setup({ writes: ALLOW });
    const a = window();
    const r1 = await s.svc.review(drain(), a);
    const r2 = await s.svc.review(drain(), a);
    await expect(s.svc.apply({ handle: H, id: r1.id!, digest: r1.digest! }, window(), async () => true)).rejects.toMatchObject({ status: 404 });
    await s.svc.apply({ handle: H, id: r1.id!, digest: r1.digest! }, a, async () => true);
    await expect(s.svc.apply({ handle: H, id: r2.id!, digest: r2.digest! }, a, async () => true)).rejects.toMatchObject({ status: 409, message: "A drain of this node is already running." });
    const r3 = await s.svc.review(drain(), a);
    await expect(s.svc.apply({ handle: H, id: r3.id!, digest: "0".repeat(64) }, a, async () => true)).rejects.toMatchObject({ status: 409 });
    await expect(s.svc.apply({ handle: H, id: r3.id!, digest: r3.digest! }, a, async () => true)).rejects.toMatchObject({ status: 404 });
  });
});
