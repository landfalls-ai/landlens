// Your actions in main (wave 8 part 1, D143): every review and apply is one series as you with its own token; only
// the window that reviewed may apply, on that cluster, once, naming the review's digest; bulk and wide deletes ask in
// main's own dialog and a Cancel sends nothing; the type comes from discovery; one log row per apply, written before
// any request. The security review of part 1 (M1–M6, L1–L13) has a test per finding below the first block.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
type Sent = { method: string; path: string; body?: string; token: string };
const sent: Sent[] = [];
let objects: Record<string, any> = {};
let refuse: ((r: { method: string; path: string }) => number | undefined) | undefined;
/** Called before each request is answered: may throw, or hang (a promise that never settles). */
let before: ((r: { method: string; path: string; body?: string }) => void | Promise<void>) | undefined;
/** List bodies by path (HPAs, PDBs). */
let lists: Record<string, unknown> = {};
vi.mock("@landlens/kube-mcp", () => ({
  frontDoorSend: ({ token }: { token: string }) => async (r: { method: string; path: string; body?: string }) => {
    sent.push({ ...r, token });
    await before?.(r);
    const status = refuse?.(r);
    if (status) return { status, text: JSON.stringify({ kind: "Status", message: `refused ${status}` }), warnings: [] };
    const path = r.path.split("?")[0]!;
    const dry = r.path.includes("dryRun=All") || (r.body ?? "").includes('"dryRun":["All"]');
    if (r.method === "GET") {
      if (lists[path]) return { status: 200, text: JSON.stringify(lists[path]), warnings: [] };
      if (path.endsWith("/horizontalpodautoscalers") || path.endsWith("/poddisruptionbudgets")) return { status: 200, text: JSON.stringify({ items: [] }), warnings: [] };
      const o = objects[path];
      return o ? { status: 200, text: JSON.stringify(o), warnings: [] } : { status: 404, text: '{"kind":"Status","message":"not found"}', warnings: [] };
    }
    if (r.method === "PATCH") {
      const o = structuredClone(objects[path]);
      const body = JSON.parse(r.body!);
      if (body.metadata?.resourceVersion !== o.metadata.resourceVersion) return { status: 409, text: '{"kind":"Status","message":"modified"}', warnings: [] };
      o.spec = { ...o.spec, ...body.spec };
      if (!dry) objects[path] = { ...o, metadata: { ...o.metadata, resourceVersion: String(Number(o.metadata.resourceVersion) + 1) } };
      return { status: 200, text: JSON.stringify(o), warnings: [] };
    }
    if (r.method === "DELETE") {
      if (!dry) delete objects[path];
      return { status: 200, text: '{"kind":"Status","status":"Success"}', warnings: [] };
    }
    if (r.method === "POST") {
      const body = JSON.parse(r.body!);
      if (objects[`${path}/${body.metadata.name}`]) return { status: 409, text: '{"kind":"Status","reason":"AlreadyExists","message":"exists"}', warnings: [] };
      if (!dry) objects[`${path}/${body.metadata.name}`] = body;
      return { status: 201, text: JSON.stringify(body), warnings: [] };
    }
    return { status: 405, text: "{}", warnings: [] };
  },
}));
import type { ActionResult } from "@landlens/contracts";
import { serverHash } from "../src/main/action-log";
import { ActionService, APPLY_REQUEST_MS, BUDGET_MS, CARD_BUDGET, cardDigest, LOG_REFUSED, MAX_PREPARING, REVIEW_MS } from "../src/main/actions";

const types = [
  { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "list", "patch", "delete"] },
  { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true, verbs: ["get", "delete"] },
  { group: "", version: "v1", resource: "namespaces", kind: "Namespace", namespaced: false, verbs: ["get", "delete"] },
  { group: "batch", version: "v1", resource: "cronjobs", kind: "CronJob", namespaced: true, verbs: ["get", "patch", "delete"] },
  { group: "batch", version: "v1", resource: "jobs", kind: "Job", namespaced: true, verbs: ["create", "get", "delete"] },
  // Wide kinds (D143, M5), a PVC and its volumes, a CRD's own kind (M3).
  { group: "apiextensions.k8s.io", version: "v1", resource: "customresourcedefinitions", kind: "CustomResourceDefinition", namespaced: false, verbs: ["get", "delete"] },
  { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false, verbs: ["get", "delete"] },
  { group: "", version: "v1", resource: "persistentvolumes", kind: "PersistentVolume", namespaced: false, verbs: ["get", "delete"] },
  { group: "apiregistration.k8s.io", version: "v1", resource: "apiservices", kind: "APIService", namespaced: false, verbs: ["get", "delete"] },
  { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterrolebindings", kind: "ClusterRoleBinding", namespaced: false, verbs: ["get", "delete"] },
  { group: "", version: "v1", resource: "persistentvolumeclaims", kind: "PersistentVolumeClaim", namespaced: true, verbs: ["get", "delete"] },
  { group: "example.com", version: "v1", resource: "foobars", kind: "fooBar", namespaced: true, verbs: ["get", "delete"] },
];
const DEP = "/apis/apps/v1/namespaces/landlens-dev/deployments/hands-web";
const web = () => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "hands-web", namespace: "landlens-dev", uid: "w1", resourceVersion: "10", generation: 1 }, spec: { replicas: 2, template: { metadata: { labels: { app: "hands-web" } } } }, status: { replicas: 2, updatedReplicas: 2, observedGeneration: 1 } });
const cm = (n: number) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: `hands-cm-${n}`, namespace: "landlens-dev", uid: `c${n}`, resourceVersion: `${n}` }, data: { n: String(n) } });
const ref = { group: "apps", version: "v1", resource: "deployments", namespace: "landlens-dev", name: "hands-web" };
const cmRef = (n: number) => ({ group: "", version: "v1", resource: "configmaps", namespace: "landlens-dev", name: `hands-cm-${n}` });

function window() {
  const e = new EventEmitter() as EventEmitter & { isDestroyed(): boolean };
  e.isDestroyed = () => false;
  return e as any;
}

function setup(o: { now?: () => number; nodeWrites?: boolean; log?: Record<string, unknown> } = {}) {
  sent.length = 0;
  refuse = undefined;
  before = undefined;
  lists = {};
  objects = { [DEP]: web(), ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`/api/v1/namespaces/landlens-dev/configmaps/hands-cm-${n}`, cm(n)])) };
  let n = 0;
  const issue = vi.fn(() => String(++n % 10).repeat(64));
  const revoke = vi.fn();
  let gone: (h: string) => void = () => {};
  const clusters = { get: (h: string) => (h === "h1234567" ? { info: { context: "orbstack", server: "https://127.0.0.1:26443" } } : (() => { throw Object.assign(new Error("not connected"), { status: 404 }); })()), onGone: (f: (h: string) => void) => (gone = f), discovery: async () => types };
  const door = { issueToken: issue, revokeToken: revoke, clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "" };
  const rows: any[] = [];
  const counted: any[] = [];
  const log = {
    add: (e: any) => (rows.push(e), e),
    settle: (id: string, end: any) => {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...end };
    },
    list: (context: string, server: string) => rows.filter((x) => x.context === context && x.server === serverHash(server)).reverse(),
    ...o.log,
  };
  const svc = new ActionService({
    clusters: clusters as any, frontDoor: door as any, log: log as any, counted: (a) => counted.push(a), suffix: () => "a1b2c",
    ...(o.now ? { now: o.now } : {}), ...(o.nodeWrites ? { nodeWrites: () => true } : {}),
  });
  return { svc, issue, revoke, rows, counted, gone: (h: string) => gone(h) };
}

describe("your actions in main", () => {
  it("reviews and applies as you: a token per series, labelled with the action, revoked after; main's title and facts", async () => {
    const { svc, issue, revoke, rows, counted } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    expect(r.id).toMatch(/^ed/);
    expect(r.title).toBe("Scale deployment landlens-dev/hands-web to 3 replicas");
    expect(r.facts).toEqual([]);
    expect(r.native).toBeUndefined();
    expect(issue).toHaveBeenLastCalledWith({ label: "you · orbstack · scale landlens-dev/hands-web", policy: { access: "full" }, clusters: ["h1234567"] });
    expect(revoke).toHaveBeenCalledTimes(1);
    // The review's own series: read, the facts' reads and the dry run, all with the one token.
    const reviewToken = sent[0]!.token;
    expect(sent.every((s) => s.token === reviewToken)).toBe(true);
    const dry = sent.find((s) => s.method === "PATCH")!;
    expect(dry.path).toContain("dryRun=All");
    expect(JSON.parse(dry.body!)).toEqual({ spec: { replicas: 3 }, metadata: { resourceVersion: "10" } });
    sent.length = 0;
    const out = await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => { throw new Error("no dialog for a scale"); }) as { results: ActionResult[] };
    expect(out.results).toEqual([{ target: "deployment landlens-dev/hands-web", outcome: "applied" }]);
    expect(sent.map((s) => [s.method, s.path.includes("dryRun"), s.body])).toEqual([["PATCH", false, dry.body]]);
    expect(sent[0]!.token).not.toBe(reviewToken);
    expect(revoke).toHaveBeenLastCalledWith(sent[0]!.token);
    expect(objects[DEP].spec.replicas).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ context: "orbstack", who: "you", action: "scale", kind: "Deployment", namespace: "landlens-dev", names: ["hands-web"], detail: "2 → 3 replicas", outcome: "applied" });
    expect(rows[0].server).toMatch(/^[0-9a-f]{16}$/);
    expect(counted).toEqual([{ action: "scale", outcome: "applied" }]);
    // Once applied, it can't be sent again.
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true)).rejects.toThrow(/no such review/);
  });

  it("only the window that reviewed may apply, on that cluster, naming the review's digest", async () => {
    const { svc } = setup();
    const a = window();
    const b = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "restart", targets: [ref] } }, a);
    expect(r.title).toBe("Restart deployment landlens-dev/hands-web");
    sent.length = 0;
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, b, async () => true)).rejects.toThrow(/no such review/);
    await expect(svc.apply({ handle: "h7654321", id: r.id!, digest: r.digest! }, a, async () => true)).rejects.toThrow(/no such review/);
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: "f".repeat(64) }, a, async () => true)).rejects.toThrow(/isn't the review that was shown/);
    // A wrong digest drops the review: nothing can send it now.
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true)).rejects.toThrow(/no such review/);
    expect(sent.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("a bulk delete asks in main's own dialog: Cancel sends nothing and keeps the review; yes deletes each, pinned", async () => {
    const { svc, rows } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [1, 2, 3].map(cmRef) } }, a);
    expect(r.native).toBe(true);
    expect(r.title).toBe("Delete 3 configmaps in landlens-dev");
    const asked: any[] = [];
    sent.length = 0;
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked).toEqual([{ message: "Delete 3 ConfigMaps in landlens-dev on orbstack?", detail: "3 ConfigMaps: 3 in landlens-dev.\n\nlandlens-dev/hands-cm-1\nlandlens-dev/hands-cm-2\nlandlens-dev/hands-cm-3", yes: "Delete 3" }]);
    expect(sent).toEqual([]);
    expect(rows.map((x) => x.outcome)).toEqual(["cancelled"]);
    const out = await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true) as { results: ActionResult[] };
    expect(out.results.map((x) => x.outcome)).toEqual(["applied", "applied", "applied"]);
    const deletes = sent.filter((s) => s.method === "DELETE");
    expect(deletes.map((d) => JSON.parse(d.body!).preconditions)).toEqual([{ uid: "c1", resourceVersion: "1" }, { uid: "c2", resourceVersion: "2" }, { uid: "c3", resourceVersion: "3" }]);
    expect(deletes.every((d) => !d.body!.includes("dryRun"))).toBe(true);
    expect(objects["/api/v1/namespaces/landlens-dev/configmaps/hands-cm-4"]).toBeDefined();
    expect(rows.at(-1)).toMatchObject({ action: "delete", kind: "ConfigMap", names: ["hands-cm-1", "hands-cm-2", "hands-cm-3"], outcome: "applied" });
  });

  it("a Namespace's delete asks too, even alone; one ConfigMap's doesn't", async () => {
    const { svc } = setup();
    objects["/api/v1/namespaces/scratch"] = { apiVersion: "v1", kind: "Namespace", metadata: { name: "scratch", uid: "n1", resourceVersion: "3" } };
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [{ group: "", version: "v1", resource: "namespaces", name: "scratch" }] } }, a);
    expect(r.native).toBe(true);
    expect(r.facts).toEqual([{ tone: "bad", code: "namespace", text: "Deletes everything in it." }]);
    const asked: any[] = [];
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0].message).toBe("Delete Namespace scratch on orbstack?");
    expect(objects["/api/v1/namespaces/scratch"]).toBeDefined();
    const one = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(5)] } }, a);
    expect(one.native).toBeUndefined();
    // Two Namespaces at once: refused before any request.
    sent.length = 0;
    await expect(svc.review({ handle: "h1234567", action: { kind: "delete", targets: [{ group: "", version: "v1", resource: "namespaces", name: "a" }, { group: "", version: "v1", resource: "namespaces", name: "b" }] } }, a)).rejects.toThrow(/one at a time/);
    expect(sent).toEqual([]);
  });

  it("takes each type from discovery: a kind the cluster doesn't serve, or one the action doesn't take, is refused before any request", async () => {
    const { svc } = setup();
    const a = window();
    sent.length = 0;
    await expect(svc.review({ handle: "h1234567", action: { kind: "scale", target: { ...ref, resource: "widgets" }, replicas: 1 } }, a)).rejects.toThrow(/doesn't serve widgets/);
    await expect(svc.review({ handle: "h1234567", action: { kind: "scale", target: cmRef(1), replicas: 1 } }, a)).rejects.toThrow(/doesn't scale configmaps/);
    await expect(svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1), ref] } }, a)).rejects.toThrow(/One kind/);
    expect(sent).toEqual([]);
  });

  it("trigger: reads the CronJob as you, creates kubectl's Job, and logs the CronJob's name", async () => {
    const { svc, rows } = setup();
    objects["/apis/batch/v1/namespaces/landlens-dev/cronjobs/hands-report"] = {
      apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "hands-report", namespace: "landlens-dev", uid: "cj", resourceVersion: "4" },
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "r", image: "busybox:1.36", env: [{ name: "K", value: "v" }] }] } } } } }, status: {},
    };
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "trigger", target: { group: "batch", version: "v1", resource: "cronjobs", namespace: "landlens-dev", name: "hands-report" } } }, a);
    expect(r.title).toBe("Run cronjob landlens-dev/hands-report now");
    expect(r.operations![0]).toMatchObject({ verb: "create", kind: "Job", name: "hands-report-manual-a1b2c" });
    expect(r.facts!.map((f) => f.code)).toEqual(["runs-now"]);
    await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true);
    const job = objects["/apis/batch/v1/namespaces/landlens-dev/jobs/hands-report-manual-a1b2c"];
    expect(job.metadata.ownerReferences).toEqual([{ apiVersion: "batch/v1", kind: "CronJob", name: "hands-report", uid: "cj", controller: true }]);
    expect(job.spec.template.spec.containers[0].env).toEqual([{ name: "K", value: "v" }]);
    expect(rows.at(-1)).toMatchObject({ action: "trigger", kind: "CronJob", names: ["hands-report"], outcome: "applied" });
  });

  it("a refusal at the dry run is the cluster's reason, and nothing is kept; a conflict at apply is logged", async () => {
    const { svc, rows } = setup();
    const a = window();
    refuse = (q) => (q.method === "PATCH" && q.path.includes("dryRun") ? 403 : undefined);
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    expect(r.id).toBeUndefined();
    expect(r.problems![0]!.message).toBe("deployment landlens-dev/hands-web: refused 403");
    refuse = undefined;
    const ok = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    objects[DEP].metadata.resourceVersion = "11"; // someone changed it
    const out = await svc.apply({ handle: "h1234567", id: ok.id!, digest: ok.digest! }, a, async () => true) as { results: ActionResult[] };
    expect(out.results).toEqual([{ target: "deployment landlens-dev/hands-web", outcome: "conflict", message: "It changed after your review." }]);
    expect(objects[DEP].spec.replicas).toBe(2);
    expect(rows.at(-1).outcome).toBe("conflict");
  });

  it("keeps 20 reviews a window, forgets them when it goes or its cluster stops, and checks 8 at once at most", async () => {
    const { svc, gone } = setup();
    const a = window();
    const first = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    for (let i = 0; i < 20; i++) await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    await expect(svc.apply({ handle: "h1234567", id: first.id!, digest: first.digest! }, a, async () => true)).rejects.toThrow(/no such review/);
    const kept = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    a.emit("destroyed");
    await expect(svc.apply({ handle: "h1234567", id: kept.id!, digest: kept.digest! }, a, async () => true)).rejects.toThrow(/no such review/);
    const b = window();
    const other = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, b);
    gone("h1234567");
    await expect(svc.apply({ handle: "h1234567", id: other.id!, digest: other.digest! }, b, async () => true)).rejects.toThrow(/no such review/);
    // Eight reviews being checked at once from one window; the ninth is refused.
    const c = window();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    refuse = undefined;
    const slow = setup();
    const orig = (slow.svc as any).prepare.bind(slow.svc);
    (slow.svc as any).prepare = async (...args: unknown[]) => (await hold, orig(...args));
    const running = Array.from({ length: MAX_PREPARING }, () => slow.svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, c));
    await expect(slow.svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, c)).rejects.toThrow(/At most 8/);
    release();
    await Promise.all(running);
  });

  it("a review expires after 15 minutes", async () => {
    let t = 1_000_000;
    const { svc } = setup({ now: () => t });
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    t += 15 * 60_000;
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true)).rejects.toThrow(/no such review/);
  });
});

const no = async () => { throw new Error("main's dialog wasn't expected here"); };
const cmAt = (ns: string, name: string) => ({ group: "", version: "v1", resource: "configmaps", namespace: ns, name });
const putCm = (ns: string, name: string) => (objects[`/api/v1/namespaces/${ns}/configmaps/${name}`] = { apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace: ns, uid: `u-${ns}-${name}`, resourceVersion: "1" } });
const putDep = (name: string, extra: any = {}) => (objects[`/apis/apps/v1/namespaces/landlens-dev/deployments/${name}`] = { ...web(), metadata: { ...web().metadata, name, uid: `d-${name}` }, ...extra });
const depAt = (name: string) => ({ ...ref, name });

describe("security review of part 1: main's dialog says where everything is (M1)", () => {
  it("lists namespace/name, sorted by main, the flagged first, with counts by namespace; the window's order changes nothing", async () => {
    const { svc } = setup();
    const a = window();
    const names = Array.from({ length: 10 }, (_, i) => `hands-cm-${i + 1}`);
    for (const n of names) putCm("landlens-dev", n);
    putCm("kube-system", "coredns");
    putCm("kube-system", "kube-proxy");
    const targets = [...names.map((n) => cmAt("landlens-dev", n)), cmAt("kube-system", "coredns"), cmAt("kube-system", "kube-proxy")];
    const asked: any[] = [];
    const ask = async (q: any) => (asked.push(q), false);
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets } }, a);
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, ask)).rejects.toThrow(/Cancelled/);
    const r2 = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [...targets].reverse() } }, a);
    await expect(svc.apply({ handle: "h1234567", id: r2.id!, digest: r2.digest! }, a, ask)).rejects.toThrow(/Cancelled/);
    expect(asked[0].message).toBe("Delete 12 ConfigMaps in 2 namespaces on orbstack?");
    const lines = asked[0].detail.split("\n");
    expect(lines.slice(0, 5)).toEqual(["12 ConfigMaps: 2 in kube-system, 10 in landlens-dev.", "", "In a system namespace:", "kube-system/coredns", "kube-system/kube-proxy"]);
    expect(lines).toContain("landlens-dev/hands-cm-1");
    expect(asked[0].detail).not.toMatch(/more/);
    expect(asked[1]).toEqual(asked[0]);
  });

  it("never puts an object of another namespace behind \"and N more\"; the rest are counted by namespace", async () => {
    const { svc } = setup();
    const a = window();
    const names = Array.from({ length: 15 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    for (const n of names) putCm("landlens-dev", n);
    putCm("shop", "prices");
    const asked: any[] = [];
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [...names.map((n) => cmAt("landlens-dev", n)), cmAt("shop", "prices")] } }, a);
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    const lines = asked[0].detail.split("\n");
    expect(lines.slice(0, 4)).toEqual(["16 ConfigMaps: 15 in landlens-dev, 1 in shop.", "", "Outside landlens-dev:", "shop/prices"]);
    expect(lines.at(-1)).toBe("and 5 more in landlens-dev");
  });
});

describe("security review of part 1: a split bulk still reaches main's dialog (M2)", () => {
  it("a window's fourth card-approved object in a minute asks in main's dialog; another window has its own budget; a minute later the card is enough", async () => {
    let t = 1_000_000;
    const { svc } = setup({ now: () => t });
    const a = window();
    const b = window();
    for (const n of [1, 2, 3]) {
      const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(n)] } }, a);
      expect(r.native).toBeUndefined();
      await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
    }
    expect(CARD_BUDGET).toBe(3);
    const r4 = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(4)] } }, a);
    const asked: any[] = [];
    sent.length = 0;
    await expect(svc.apply({ handle: "h1234567", id: r4.id!, digest: r4.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0]).toMatchObject({ message: "Delete ConfigMap landlens-dev/hands-cm-4 on orbstack?", yes: "Delete" });
    expect(asked[0].detail).toMatch(/^This window has sent 3 changes in the last minute/);
    expect(sent.filter((x) => x.method === "DELETE")).toEqual([]);
    // Another window: its own budget.
    const rb = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(5)] } }, b);
    await svc.apply({ handle: "h1234567", id: rb.id!, digest: rb.digest! }, b, no);
    // A minute on, the card is enough again.
    t += BUDGET_MS;
    await svc.apply({ handle: "h1234567", id: r4.id!, digest: r4.digest! }, a, no);
    expect(objects["/api/v1/namespaces/landlens-dev/configmaps/hands-cm-4"]).toBeUndefined();
  });

  it("a scale counts too: a stream of single changes of any kind reaches the dialog", async () => {
    const { svc } = setup();
    const a = window();
    for (const n of [3, 4, 5]) {
      const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: n } }, a);
      await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
    }
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 0 } }, a);
    const asked: any[] = [];
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0].message).toBe("Scale deployment landlens-dev/hands-web to 0 replicas on orbstack?");
  });

  it("a restart of more than three workloads asks in main's dialog, listing each; three don't", async () => {
    const { svc } = setup();
    const a = window();
    for (const n of ["w1", "w2", "w3", "w4"]) putDep(n);
    const four = await svc.review({ handle: "h1234567", action: { kind: "restart", targets: ["w4", "w3", "w2", "w1"].map(depAt) } }, a);
    expect(four.native).toBe(true);
    const asked: any[] = [];
    sent.length = 0;
    await expect(svc.apply({ handle: "h1234567", id: four.id!, digest: four.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0]).toMatchObject({ message: "Restart 4 Deployments in landlens-dev on orbstack?", yes: "Restart 4" });
    expect(asked[0].detail).toBe("4 Deployments: 4 in landlens-dev.\n\nlandlens-dev/w1\nlandlens-dev/w2\nlandlens-dev/w3\nlandlens-dev/w4");
    expect(sent.filter((x) => x.method === "PATCH")).toEqual([]);
    const three = await svc.review({ handle: "h1234567", action: { kind: "restart", targets: ["w1", "w2", "w3"].map(depAt) } }, a);
    expect(three.native).toBeUndefined();
  });
});

describe("security review of part 1: every apply has its row, written first (M3)", () => {
  it("the row is on the log as sent before the first request goes, then settled", async () => {
    const { svc, rows } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1)] } }, a);
    const seen: string[][] = [];
    before = (q) => void (q.method === "DELETE" && !(q.body ?? "").includes("dryRun") && seen.push(rows.map((x) => x.outcome)));
    await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
    expect(seen).toEqual([["sent"]]);
    expect(rows.map((x) => x.outcome)).toEqual(["applied"]);
  });

  it("a log that can't take the row refuses the apply: nothing is sent, and the review stays", async () => {
    const { svc } = setup({ log: { add: () => { throw new Error("disk full"); } } });
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1)] } }, a);
    sent.length = 0;
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no)).rejects.toMatchObject({ status: 500, message: LOG_REFUSED });
    expect(sent).toEqual([]);
    const unsaved = setup({ log: { unsaved: true } });
    const r2 = await unsaved.svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1)] } }, a);
    sent.length = 0;
    await expect(unsaved.svc.apply({ handle: "h1234567", id: r2.id!, digest: r2.digest! }, a, no)).rejects.toMatchObject({ status: 500 });
    expect(sent).toEqual([]);
    expect(unsaved.rows.map((x) => x.outcome)).toEqual(["failed"]);
  });

  it("a delete of a custom kind named fooBar, and a scale from 20000, each leave a row", async () => {
    const { svc, rows } = setup();
    const a = window();
    objects["/apis/example.com/v1/namespaces/landlens-dev/foobars/one"] = { apiVersion: "example.com/v1", kind: "fooBar", metadata: { name: "one", namespace: "landlens-dev", uid: "f1", resourceVersion: "1" } };
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [{ group: "example.com", version: "v1", resource: "foobars", namespace: "landlens-dev", name: "one" }] } }, a);
    await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
    expect(rows.at(-1)).toMatchObject({ action: "delete", kind: "fooBar", group: "example.com", resource: "foobars", names: ["one"], outcome: "applied" });
    objects[DEP].spec.replicas = 20000;
    const s = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    await svc.apply({ handle: "h1234567", id: s.id!, digest: s.digest! }, a, no);
    expect(rows.at(-1)).toMatchObject({ action: "scale", detail: "20000 → 3 replicas", outcome: "applied" });
  });
});

describe("security review of part 1: facts are never silent (M4)", () => {
  it("reads every claim's volume, and past eight facts says how many more and keeps the loudest tone", async () => {
    const { svc } = setup();
    const a = window();
    const targets = Array.from({ length: 12 }, (_, i) => {
      const name = `data-${String(i).padStart(2, "0")}`;
      objects[`/api/v1/namespaces/landlens-dev/persistentvolumeclaims/${name}`] = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name, namespace: "landlens-dev", uid: `p${i}`, resourceVersion: "1" }, spec: { volumeName: `pv-${i}` } };
      objects[`/api/v1/persistentvolumes/pv-${i}`] = { apiVersion: "v1", kind: "PersistentVolume", metadata: { name: `pv-${i}` }, spec: { persistentVolumeReclaimPolicy: "Delete" } };
      return { group: "", version: "v1", resource: "persistentvolumeclaims", namespace: "landlens-dev", name };
    });
    sent.length = 0;
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets } }, a);
    expect(sent.filter((x) => x.method === "GET" && x.path.startsWith("/api/v1/persistentvolumes/"))).toHaveLength(12);
    expect(r.facts).toHaveLength(8);
    expect(r.facts!.at(-1)).toEqual({ tone: "bad", code: "more", text: "And 5 more: 5 serious." });
    const asked: any[] = [];
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0].detail).toMatch(/^12 of them: Its volume's reclaim policy is Delete: the data goes with it\./);
  });

  it("a read that throws while making facts says so instead of failing the review", async () => {
    const { svc } = setup();
    const a = window();
    before = (q) => {
      if (q.path.includes("/horizontalpodautoscalers")) throw new Error("socket hang up");
    };
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    expect(r.id).toMatch(/^ed/);
    expect(r.facts).toEqual([{ tone: "info", code: "couldnt-check", text: "Landlens couldn't check what else this touches." }]);
  });

  it("an autoscaler served only at autoscaling/v1 is still found (L10)", async () => {
    const { svc } = setup();
    const a = window();
    lists["/apis/autoscaling/v1/namespaces/landlens-dev/horizontalpodautoscalers"] = { items: [{ metadata: { name: "web-hpa" }, spec: { scaleTargetRef: { kind: "Deployment", name: "hands-web" }, minReplicas: 2, maxReplicas: 5 } }] };
    refuse = (q) => (q.path.startsWith("/apis/autoscaling/v2/") ? 404 : undefined);
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    expect(r.facts!.map((f) => f.code)).toEqual(["hpa"]);
  });
});

describe("security review of part 1: what asks in main's dialog alone (M5, M6)", () => {
  const one = async (svc: ActionService, target: any, nativeExpected: boolean) => {
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [target] } }, a);
    expect(r.id, JSON.stringify(r.problems)).toMatch(/^ed/);
    expect(!!r.native).toBe(nativeExpected);
    const asked: any[] = [];
    if (nativeExpected) await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    return asked[0];
  };

  it("each of the five wide kinds, a ClusterRoleBinding, and a PVC whose volume goes with it ask; a ConfigMap doesn't", async () => {
    const { svc } = setup({ nodeWrites: true });
    const put = (path: string, kind: string, name: string, extra: any = {}) => (objects[path] = { kind, metadata: { name, uid: `u-${name}`, resourceVersion: "1" }, ...extra });
    put("/apis/apiextensions.k8s.io/v1/customresourcedefinitions/foobars.example.com", "CustomResourceDefinition", "foobars.example.com");
    put("/api/v1/nodes/node-9", "Node", "node-9");
    put("/api/v1/persistentvolumes/pv-x", "PersistentVolume", "pv-x");
    put("/apis/apiregistration.k8s.io/v1/apiservices/v1beta1.metrics.k8s.io", "APIService", "v1beta1.metrics.k8s.io");
    put("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/cluster-admin", "ClusterRoleBinding", "cluster-admin");
    objects["/api/v1/namespaces/scratch"] = { kind: "Namespace", metadata: { name: "scratch", uid: "n1", resourceVersion: "3" } };
    const wide = [
      { group: "apiextensions.k8s.io", version: "v1", resource: "customresourcedefinitions", name: "foobars.example.com" },
      { group: "", version: "v1", resource: "nodes", name: "node-9" },
      { group: "", version: "v1", resource: "persistentvolumes", name: "pv-x" },
      { group: "apiregistration.k8s.io", version: "v1", resource: "apiservices", name: "v1beta1.metrics.k8s.io" },
      { group: "", version: "v1", resource: "namespaces", name: "scratch" },
      { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterrolebindings", name: "cluster-admin" },
    ];
    for (const t of wide) expect((await one(svc, t, true)).detail).toMatch(/cluster-scoped/);
    objects["/api/v1/namespaces/landlens-dev/persistentvolumeclaims/data"] = { kind: "PersistentVolumeClaim", metadata: { name: "data", namespace: "landlens-dev", uid: "c", resourceVersion: "1" }, spec: { volumeName: "pv-d" } };
    objects["/api/v1/persistentvolumes/pv-d"] = { kind: "PersistentVolume", metadata: { name: "pv-d" }, spec: { persistentVolumeReclaimPolicy: "Delete" } };
    const pvc = { group: "", version: "v1", resource: "persistentvolumeclaims", namespace: "landlens-dev", name: "data" };
    expect((await one(svc, pvc, true)).detail).toBe("Its volume's reclaim policy is Delete: the data goes with it.\n\nIt is deleted as soon as you confirm.");
    // A volume Landlens couldn't read asks too.
    objects["/api/v1/persistentvolumes/pv-d"].spec.persistentVolumeReclaimPolicy = "Retain";
    await one(svc, pvc, false);
    refuse = (q) => (q.path === "/api/v1/persistentvolumes/pv-d" ? 403 : undefined);
    expect((await one(svc, pvc, true)).detail).toMatch(/couldn't check every claim's volume/);
    refuse = undefined;
    await one(svc, cmRef(1), false);
  });

  it("a workload with ten pods or more asks", async () => {
    const { svc } = setup();
    putDep("big", { status: { replicas: 12 } });
    expect((await one(svc, depAt("big"), true)).detail).toMatch(/^Deletes 12 pods\./);
    await one(svc, ref, false);
  });

  it("refuses a cluster-scoped kind given a namespace, and the same object twice (L12)", async () => {
    const { svc } = setup();
    const a = window();
    sent.length = 0;
    await expect(svc.review({ handle: "h1234567", action: { kind: "delete", targets: [{ group: "", version: "v1", resource: "namespaces", namespace: "x", name: "scratch" }] } }, a)).rejects.toThrow(/is cluster-scoped/);
    await expect(svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1), cmRef(1)] } }, a)).rejects.toThrow(/named twice/);
    expect(sent).toEqual([]);
  });
});

describe("security review of part 1: the named rules, each with its test (M6, L2, L3, L7, L9, L12, L13)", () => {
  it("a second apply while main's dialog is up is refused, and isn't a conflict", async () => {
    const { svc } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [1, 2].map(cmRef) } }, a);
    let answer!: (yes: boolean) => void;
    const first = svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, () => new Promise<boolean>((res) => (answer = res)));
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true)).rejects.toMatchObject({ status: 429, message: "Landlens is already asking about this." });
    answer(false);
    await expect(first).rejects.toThrow(/Cancelled/);
  });

  for (const ev of ["did-start-navigation", "render-process-gone", "destroyed"] as const) {
    it(`a review whose window ${ev === "did-start-navigation" ? "navigated" : ev === "render-process-gone" ? "lost its renderer" : "went"} while the dialog was up sends nothing`, async () => {
      const { svc } = setup();
      const a = window();
      const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [1, 2].map(cmRef) } }, a);
      sent.length = 0;
      await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => {
        a.emit(ev, { isMainFrame: true, isSameDocument: false });
        return true;
      })).rejects.toThrow(/no such review/);
      expect(sent).toEqual([]);
    });
  }

  it("a same-document navigation keeps the window's reviews", async () => {
    const { svc } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    a.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
  });

  it("a review's reads and dry runs share one minute: past it, a 504 and nothing kept", async () => {
    let t = 1_000_000;
    const { svc } = setup({ now: () => t });
    const a = window();
    before = (q) => void (q.method === "GET" && (t += REVIEW_MS));
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    expect(r.id).toBeUndefined();
    expect(r.problems![0]!.message).toMatch(/took too long/);
  });

  it("each apply request has its own time limit: a hung API server ends the apply, said as maybe applied", async () => {
    const { svc, rows } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1)] } }, a);
    vi.useFakeTimers();
    try {
      before = (q) => (q.method === "DELETE" && !(q.body ?? "").includes("dryRun") ? new Promise<void>(() => {}) : undefined);
      const out = svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
      await vi.advanceTimersByTimeAsync(APPLY_REQUEST_MS);
      expect(((await out) as { results: ActionResult[] }).results).toEqual([{ target: "configmap landlens-dev/hands-cm-1", outcome: "failed", message: "The cluster didn't answer in time; it may have been applied. Check it." }]);
      expect(rows.at(-1).outcome).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the digest covers the card: the same requests with other facts are another review (L2)", async () => {
    const { svc } = setup();
    const a = window();
    const r1 = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    lists["/apis/autoscaling/v2/namespaces/landlens-dev/horizontalpodautoscalers"] = { items: [{ metadata: { name: "web-hpa" }, spec: { scaleTargetRef: { kind: "Deployment", name: "hands-web" }, minReplicas: 2, maxReplicas: 5 } }] };
    const r2 = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    expect(r2.operations).toEqual(r1.operations);
    expect(r2.facts).not.toEqual(r1.facts);
    expect(r2.digest).not.toBe(r1.digest);
    const { digest, ...card } = r2;
    const requests = (svc as any).reviews.get(r2.id).requests;
    expect(digest).toBe(cardDigest(card, requests));
    expect(cardDigest({ ...card, facts: [] }, requests)).not.toBe(digest);
    // r1's digest doesn't apply r2.
    await expect(svc.apply({ handle: "h1234567", id: r2.id!, digest: r1.digest! }, a, no)).rejects.toThrow(/isn't the review that was shown/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two Cancels drop the review: the third Apply finds nothing (L3)", async () => {
    const { svc, rows } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [1, 2].map(cmRef) } }, a);
    const go = () => svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => false);
    await expect(go()).rejects.toMatchObject({ status: 409, message: "Cancelled." });
    await expect(go()).rejects.toMatchObject({ status: 410 });
    await expect(go()).rejects.toMatchObject({ status: 404 });
    expect(rows.map((x) => x.outcome)).toEqual(["cancelled", "cancelled"]);
  });

  it("a Job whose name is taken at Apply says so, not \"changed after your review\" (L9)", async () => {
    const { svc } = setup();
    objects["/apis/batch/v1/namespaces/landlens-dev/cronjobs/hands-report"] = { apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "hands-report", namespace: "landlens-dev", uid: "cj", resourceVersion: "4" }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "r", image: "busybox:1.36" }] } } } } }, status: {} };
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "trigger", target: { group: "batch", version: "v1", resource: "cronjobs", namespace: "landlens-dev", name: "hands-report" } } }, a);
    objects["/apis/batch/v1/namespaces/landlens-dev/jobs/hands-report-manual-a1b2c"] = { metadata: { name: "hands-report-manual-a1b2c" } };
    const out = await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no) as { results: ActionResult[] };
    expect(out.results[0]).toMatchObject({ outcome: "conflict", message: "One of that name already exists; review again." });
  });

  it("the log is read for the connected cluster: its context and its server (L7)", async () => {
    const { svc, rows } = setup();
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "scale", target: ref, replicas: 3 } }, a);
    await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, no);
    rows.push({ ...rows[0], id: "acOTHEROTHEROTHER1", server: "0".repeat(16) });
    expect(svc.history("h1234567").map((x) => x.id)).toEqual([rows[0].id]);
  });
});

describe("part 3: a bulk action from the table's selection (D156)", () => {
  const CM = (n: number) => `/api/v1/namespaces/landlens-dev/configmaps/hands-cm-${n}`;

  it("an object refused at its dry run is left out: a problem on its own line; main's dialog, its count, the title and the log name only the rest", async () => {
    const { svc, rows } = setup();
    const a = window();
    refuse = (q) => (q.method === "DELETE" && q.path.startsWith(CM(2)) ? 403 : undefined);
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [1, 2, 3].map(cmRef) } }, a);
    expect(r.id).toMatch(/^ed/);
    expect(r.operations!.map((o) => o.name)).toEqual(["hands-cm-1", "hands-cm-3"]);
    expect(r.problems).toEqual([{ message: "configmap landlens-dev/hands-cm-2: refused 403" }]);
    expect(r.title).toBe("Delete 2 configmaps in landlens-dev");
    expect(r.native).toBe(true);
    const asked: any[] = [];
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0]).toEqual({ message: "Delete 2 ConfigMaps in landlens-dev on orbstack?", detail: "2 ConfigMaps: 2 in landlens-dev.\n\nlandlens-dev/hands-cm-1\nlandlens-dev/hands-cm-3", yes: "Delete 2" });
    refuse = undefined;
    sent.length = 0;
    const out = await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true) as { results: ActionResult[] };
    expect(out.results.map((x) => [x.target, x.outcome])).toEqual([["configmap landlens-dev/hands-cm-1", "applied"], ["configmap landlens-dev/hands-cm-3", "applied"]]);
    expect(sent.filter((s) => s.method === "DELETE").map((s) => s.path.split("?")[0])).toEqual([CM(1), CM(3)]);
    expect(objects[CM(2)]).toBeDefined();
    expect(rows.at(-1)).toMatchObject({ action: "delete", names: ["hands-cm-1", "hands-cm-3"], outcome: "applied" });
  });

  it("a bulk whose every object is refused has nothing to apply", async () => {
    const { svc } = setup();
    refuse = (q) => (q.method === "DELETE" ? 403 : undefined);
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [1, 2].map(cmRef) } }, window());
    expect(r.id).toBeUndefined();
    expect(r.problems).toHaveLength(2);
  });

  it("security review of part 3, M4: a bulk restart from the selection asks in main's dialog at four kept, not at three kept of four", async () => {
    const { svc } = setup();
    const a = window();
    for (const n of ["w1", "w2", "w3", "w4", "w5"]) putDep(n);
    const DEPS = "/apis/apps/v1/namespaces/landlens-dev/deployments/";
    refuse = (q) => (q.method === "PATCH" && q.path.startsWith(`${DEPS}w2`) ? 403 : undefined);
    // Five selected, one refused at its dry run: four kept, so main's dialog asks, naming the four.
    const five = await svc.review({ handle: "h1234567", action: { kind: "restart", targets: ["w1", "w2", "w3", "w4", "w5"].map(depAt) } }, a);
    expect(five.operations!.map((o) => o.name)).toEqual(["w1", "w3", "w4", "w5"]);
    expect(five.native).toBe(true);
    const asked: any[] = [];
    sent.length = 0;
    await expect(svc.apply({ handle: "h1234567", id: five.id!, digest: five.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0]).toMatchObject({ message: "Restart 4 Deployments in landlens-dev on orbstack?", yes: "Restart 4" });
    expect(asked[0].detail).not.toContain("w2");
    expect(sent.filter((x) => x.method === "PATCH")).toEqual([]);
    // Four selected, one refused: three kept, the card is enough.
    const four = await svc.review({ handle: "h1234567", action: { kind: "restart", targets: ["w1", "w2", "w3", "w4"].map(depAt) } }, a);
    expect(four.operations).toHaveLength(3);
    expect(four.native).toBeUndefined();
  });

  it("a bulk delete across namespaces (several chosen) still asks, naming each namespace", async () => {
    const { svc } = setup();
    objects["/api/v1/namespaces/default/configmaps/hands-cm-9"] = { ...cm(9), metadata: { ...cm(9).metadata, namespace: "default" } };
    const a = window();
    const r = await svc.review({ handle: "h1234567", action: { kind: "delete", targets: [cmRef(1), { ...cmRef(9), namespace: "default" }] } }, a);
    expect(r.native).toBe(true);
    const asked: any[] = [];
    await expect(svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async (q) => (asked.push(q), false))).rejects.toThrow(/Cancelled/);
    expect(asked[0].message).toBe("Delete 2 ConfigMaps in 2 namespaces on orbstack?");
    expect(asked[0].detail).toContain("default/hands-cm-9");
  });
});
