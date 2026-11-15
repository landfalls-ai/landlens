// Your actions in main (wave 8 part 1, D143): every review and apply is one series as you with its own token; only
// the window that reviewed may apply, on that cluster, once, naming the review's digest; bulk and wide deletes ask in
// main's own dialog and a Cancel sends nothing; the type comes from discovery; one log row per apply.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
type Sent = { method: string; path: string; body?: string; token: string };
const sent: Sent[] = [];
let objects: Record<string, any> = {};
let refuse: ((r: { method: string; path: string }) => number | undefined) | undefined;
vi.mock("@landlens/kube-mcp", () => ({
  frontDoorSend: ({ token }: { token: string }) => async (r: { method: string; path: string; body?: string }) => {
    sent.push({ ...r, token });
    const status = refuse?.(r);
    if (status) return { status, text: JSON.stringify({ kind: "Status", message: `refused ${status}` }), warnings: [] };
    const path = r.path.split("?")[0]!;
    const dry = r.path.includes("dryRun=All") || (r.body ?? "").includes('"dryRun":["All"]');
    if (r.method === "GET") {
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
      if (!dry) objects[`${path}/${body.metadata.name}`] = body;
      return { status: 201, text: JSON.stringify(body), warnings: [] };
    }
    return { status: 405, text: "{}", warnings: [] };
  },
}));
import { ActionService, MAX_PREPARING } from "../src/main/actions";

const types = [
  { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "list", "patch", "delete"] },
  { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true, verbs: ["get", "delete"] },
  { group: "", version: "v1", resource: "namespaces", kind: "Namespace", namespaced: false, verbs: ["get", "delete"] },
  { group: "batch", version: "v1", resource: "cronjobs", kind: "CronJob", namespaced: true, verbs: ["get", "patch", "delete"] },
  { group: "batch", version: "v1", resource: "jobs", kind: "Job", namespaced: true, verbs: ["create", "get", "delete"] },
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

function setup(o: { now?: () => number } = {}) {
  sent.length = 0;
  refuse = undefined;
  objects = { [DEP]: web(), ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`/api/v1/namespaces/landlens-dev/configmaps/hands-cm-${n}`, cm(n)])) };
  let n = 0;
  const issue = vi.fn(() => String(++n % 10).repeat(64));
  const revoke = vi.fn();
  let gone: (h: string) => void = () => {};
  const clusters = { get: (h: string) => (h === "h1234567" ? { info: { context: "orbstack", server: "https://127.0.0.1:26443" } } : (() => { throw Object.assign(new Error("not connected"), { status: 404 }); })()), onGone: (f: (h: string) => void) => (gone = f), discovery: async () => types };
  const door = { issueToken: issue, revokeToken: revoke, clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "" };
  const rows: any[] = [];
  const counted: any[] = [];
  const log = { add: (e: any) => (rows.push(e), e), list: () => rows.slice().reverse() };
  const svc = new ActionService({ clusters: clusters as any, frontDoor: door as any, log: log as any, counted: (a) => counted.push(a), suffix: () => "a1b2c", ...(o.now ? { now: o.now } : {}) });
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
    const out = await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => { throw new Error("no dialog for a scale"); });
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
    expect(asked).toEqual([{ message: "Delete 3 ConfigMaps in landlens-dev on orbstack?", detail: "hands-cm-1\nhands-cm-2\nhands-cm-3", yes: "Delete 3" }]);
    expect(sent).toEqual([]);
    expect(rows.map((x) => x.outcome)).toEqual(["cancelled"]);
    const out = await svc.apply({ handle: "h1234567", id: r.id!, digest: r.digest! }, a, async () => true);
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
    const out = await svc.apply({ handle: "h1234567", id: ok.id!, digest: ok.digest! }, a, async () => true);
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
