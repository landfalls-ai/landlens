import type { AgentChange } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { agentSafe, ChangeBroker, diffLines, MAX_REFUSED, risks, type ChangeDecision, type ChangeOp, type Send } from "../src/index.js";

const deployments = { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true };
const secrets = { group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true };
const roles = { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterroles", kind: "ClusterRole", namespaced: false };

const deployment = (rv = "100", replicas = 1, image = "orders:1") => ({
  apiVersion: "apps/v1", kind: "Deployment",
  metadata: { name: "orders-api", namespace: "landlens-dev", resourceVersion: rv, uid: "u1", generation: 1, managedFields: [{ manager: "kubectl" }] },
  spec: { replicas, template: { spec: { containers: [{ name: "app", image }] } } },
  status: { availableReplicas: 0 },
});

/** A pretend API server: one Deployment; records every request; dry runs answer the patched object. */
function fakeCluster(opts: { rv?: string; warn?: string[]; moveOnBeforeApply?: boolean } = {}) {
  let obj: any = deployment(opts.rv);
  const log: { method: string; path: string; contentType?: string; body?: any }[] = [];
  const send: Send = async (r) => {
    log.push({ method: r.method, path: r.path, ...(r.contentType ? { contentType: r.contentType } : {}), ...(r.body ? { body: JSON.parse(r.body) } : {}) });
    // Like the API server: a DELETE with a body reads its options, dryRun included, from the body only.
    const dry = r.method === "DELETE" && r.body ? (JSON.parse(r.body).dryRun ?? []).includes("All") : r.path.includes("dryRun=All");
    if (r.method === "GET") return obj ? { status: 200, text: JSON.stringify(obj), warnings: [] } : { status: 404, text: '{"kind":"Status","message":"not found"}', warnings: [] };
    const body = JSON.parse(r.body!);
    const want = Array.isArray(body) ? body[0].value : r.method === "DELETE" ? body.preconditions.resourceVersion : body.metadata?.resourceVersion;
    if (want !== undefined && want !== obj.metadata.resourceVersion) return { status: 409, text: '{"kind":"Status","message":"the object has been modified"}', warnings: [] };
    let next = structuredClone(obj);
    if (r.method === "PATCH" && !Array.isArray(body)) next.spec = { ...next.spec, ...(body.spec ?? {}) };
    if (r.method === "DELETE") next = null;
    if (!dry) {
      obj = next && { ...next, metadata: { ...next.metadata, resourceVersion: String(Number(obj.metadata.resourceVersion) + 1), generation: 2 } };
      return { status: 200, text: JSON.stringify(obj ?? { kind: "Status", status: "Success" }), warnings: [] };
    }
    if (opts.moveOnBeforeApply) obj = { ...obj, metadata: { ...obj.metadata, resourceVersion: "101" } };
    return { status: 200, text: JSON.stringify(next ?? deployment()), warnings: opts.warn ?? [] };
  };
  return { send, log, get: () => obj };
}

const scale = (replicas: number): ChangeOp => ({ verb: "patch", type: deployments, namespace: "landlens-dev", name: "orders-api", patchType: "merge", body: { spec: { replicas } } });

function broker(send: Send, answer: (c: AgentChange) => ChangeDecision | Promise<ChangeDecision> | "never", extra: { namespaces?: string[]; ttlMs?: number } = {}) {
  const seen: AgentChange[] = [];
  const b = new ChangeBroker({
    session: "s1", send, ...extra,
    ask: (c, signal) => {
      seen.push(c);
      const a = answer(c);
      if (a === "never") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return Promise.resolve(a);
    },
    update: (c) => seen.push(c),
  });
  return { b, seen };
}

describe("the approval broker", () => {
  it("dry-runs, shows the diff, and applies the exact request it checked when you approve", async () => {
    const k = fakeCluster({ warn: ["spec.replicas is high"] });
    const { b, seen } = broker(k.send, () => ({ decision: "approve" }));
    const out = await b.propose({ tool: "scale", title: "Scale", reason: "more", operations: [scale(3)] });
    expect(out).toEqual({ state: "applied", results: ["deployment landlens-dev/orders-api patched (generation 2)"] });
    const shown = seen[0]!;
    expect(shown.state).toBe("waiting");
    expect(shown.operations[0]!.diff.lines.filter((l) => l.t !== " " && l.t !== "…").map((l) => `${l.t}${l.text}`)).toEqual(["-  replicas: 1", "+  replicas: 3"]);
    expect(shown.operations[0]!.warnings).toEqual(["spec.replicas is high"]);
    // Status and bookkeeping never reach the diff.
    expect(JSON.stringify(shown.operations[0]!.diff)).not.toMatch(/managedFields|availableReplicas|resourceVersion/);
    const writes = k.log.filter((l) => l.method === "PATCH");
    expect(writes.map((w) => w.path)).toEqual([
      "/apis/apps/v1/namespaces/landlens-dev/deployments/orders-api?fieldManager=landlens-agent&dryRun=All",
      "/apis/apps/v1/namespaces/landlens-dev/deployments/orders-api?fieldManager=landlens-agent",
    ]);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(writes[1]!.body.metadata.resourceVersion).toBe("100");
    expect(seen.map((c) => c.state)).toEqual(["waiting", "applying", "applied"]);
  });

  it("never applies a rejected change; the note goes back to the agent", async () => {
    const k = fakeCluster();
    const { b } = broker(k.send, () => ({ decision: "reject", note: "not on Friday" }));
    expect(await b.propose({ tool: "scale", title: "Scale", reason: "", operations: [scale(3)] })).toEqual({ state: "rejected", note: "not on Friday" });
    expect(k.log.filter((l) => l.method !== "GET").every((l) => l.path.includes("dryRun=All"))).toBe(true);
    expect(k.get().spec.replicas).toBe(1);
  });

  it("applies nothing if the object changed after the dry run: a conflict, and the agent is told to read again", async () => {
    const k = fakeCluster({ moveOnBeforeApply: true });
    const { b } = broker(k.send, () => ({ decision: "approve" }));
    const out = await b.propose({ tool: "scale", title: "Scale", reason: "", operations: [scale(3)] });
    expect(out).toMatchObject({ state: "failed", stage: "apply" });
    expect((out as { error: string }).error).toMatch(/409.*changed after the dry run/);
    expect(k.get().spec.replicas).toBe(1);
  });

  it("deletes with the uid and resourceVersion as preconditions, and shows the whole object as removed", async () => {
    const k = fakeCluster();
    const { b, seen } = broker(k.send, () => ({ decision: "approve" }));
    const out = await b.propose({ tool: "delete", title: "Delete", reason: "", operations: [{ verb: "delete", type: deployments, namespace: "landlens-dev", name: "orders-api" }] });
    expect(out.state).toBe("applied");
    const del = k.log.filter((l) => l.method === "DELETE");
    expect(del[0]!.body.dryRun).toEqual(["All"]);
    expect(del[1]!.body.dryRun).toBeUndefined();
    expect(del[1]!.body.preconditions).toEqual({ uid: "u1", resourceVersion: "100" });
    const op = seen[0]!.operations[0]!;
    expect(op.risk).toEqual(["deletes"]);
    expect(op.diff.added).toBe(0);
    expect(op.diff.lines.every((l) => l.t === "-")).toBe(true);
  });

  it("a rejected delete deletes nothing: its dry run says dryRun in the body, where the API server reads it", async () => {
    const k = fakeCluster();
    const { b } = broker(k.send, () => ({ decision: "reject" }));
    expect((await b.propose({ tool: "delete", title: "", reason: "", operations: [{ verb: "delete", type: deployments, namespace: "landlens-dev", name: "orders-api" }] })).state).toBe("rejected");
    expect(k.get()).not.toBeNull();
  });

  it("refuses Secrets, namespaces outside the session's, and manifests that don't match before any request", async () => {
    const k = fakeCluster();
    const { b, seen } = broker(k.send, () => ({ decision: "approve" }), { namespaces: ["landlens-dev"] });
    const s = await b.propose({ tool: "delete", title: "", reason: "", operations: [{ verb: "delete", type: secrets, namespace: "landlens-dev", name: "db" }] });
    expect(s).toMatchObject({ state: "failed", stage: "check" });
    const ns = await b.propose({ tool: "scale", title: "", reason: "", operations: [{ ...scale(2), namespace: "kube-system" }] });
    expect(ns).toMatchObject({ state: "failed", stage: "check", error: expect.stringContaining("landlens-dev") });
    const mismatch = await b.propose({ tool: "apply_manifest", title: "", reason: "", operations: [{ verb: "patch", patchType: "apply", type: deployments, namespace: "landlens-dev", name: "orders-api", body: { ...deployment(), metadata: { name: "other" } } }] });
    expect(mismatch).toMatchObject({ state: "failed", stage: "check", error: expect.stringContaining("metadata.name") });
    expect(k.log).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("asks you even about a change that would change nothing: answering the agent at once would confirm a hidden value", async () => {
    const k = fakeCluster();
    const { b, seen } = broker(k.send, () => ({ decision: "reject" }));
    expect(await b.propose({ tool: "scale", title: "", reason: "", operations: [scale(1)] })).toEqual({ state: "rejected" });
    expect(seen[0]!.operations[0]!.diff).toMatchObject({ added: 0, removed: 0 });
  });

  it("doesn't ask about one the dry run refuses, and tells the agent why without the values the API server quoted", async () => {
    const k = fakeCluster();
    const refusing: Send = async (r) => (r.method === "GET" ? k.send(r) : { status: 422, text: '{"kind":"Status","message":"spec.template.spec.containers[0].imagePullPolicy: Unsupported value: \\"postgres://u:hunter2@db\\": supported values: \\"Always\\", spec.replicas: Invalid value: -1: must be greater than or equal to 0"}', warnings: [] });
    const { b, seen } = broker(refusing, () => ({ decision: "approve" }));
    const out = await b.propose({ tool: "scale", title: "", reason: "", operations: [scale(-1)] });
    expect(out).toMatchObject({ state: "failed", stage: "dry-run", error: expect.stringContaining("422: spec.template.spec.containers[0].imagePullPolicy: Unsupported value: \"…\"") });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).toContain("spec.replicas: Invalid value: …: must be");
    expect(seen).toEqual([]);
  });

  it("refuses JSON patch operations that read values (copy, move, test), unnamed objects and whole-object updates", async () => {
    const k = fakeCluster();
    const { b, seen } = broker(k.send, () => ({ decision: "approve" }));
    const json = (body: unknown[]): ChangeOp => ({ verb: "patch", type: deployments, namespace: "landlens-dev", name: "orders-api", patchType: "json", body });
    for (const body of [
      [{ op: "copy", from: "/spec/template/spec/containers/0/env/0/value", path: "/metadata/annotations/x" }],
      [{ op: "move", from: "/spec/replicas", path: "/spec/x" }],
      [{ op: "test", path: "/spec/template/spec/containers/0/env/0/value", value: "guess" }],
      [{ op: "add", path: "/metadata/annotations/x", value: "1", from: "/spec" }],
    ]) expect(await b.propose({ tool: "patch", title: "", reason: "", operations: [json(body)] })).toMatchObject({ state: "failed", stage: "check", error: expect.stringContaining("only add, replace and remove") });
    expect(await b.propose({ tool: "delete", title: "", reason: "", operations: [{ verb: "delete", type: deployments, namespace: "landlens-dev", name: "" }] })).toMatchObject({ state: "failed", error: expect.stringContaining("names one object") });
    expect(await b.propose({ tool: "x", title: "", reason: "", operations: [{ verb: "update", type: deployments, namespace: "landlens-dev", name: "orders-api", body: deployment() }] })).toMatchObject({ state: "failed", error: expect.stringContaining("whole-object updates") });
    expect(seen).toEqual([]);
    expect(k.log).toEqual([]);
  });

  it("stops taking proposals from a session after too many refusals", async () => {
    const k = fakeCluster();
    const { b } = broker(k.send, () => ({ decision: "approve" }));
    const bad: ChangeOp = { verb: "patch", type: secrets, namespace: "landlens-dev", name: "s", patchType: "merge", body: {} };
    for (let i = 0; i < MAX_REFUSED; i++) await b.propose({ tool: "patch", title: "", reason: "", operations: [bad] });
    expect(await b.propose({ tool: "scale", title: "", reason: "", operations: [scale(3)] })).toMatchObject({ state: "failed", error: expect.stringContaining("takes no more") });
  });

  it("sends nothing for a create by apply if the object appeared after the dry run", async () => {
    let exists = false;
    const log: string[] = [];
    const cm = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c", namespace: "landlens-dev" }, data: { a: "1" } };
    const send: Send = async (r) => {
      log.push(`${r.method} ${r.path}`);
      if (r.method === "GET") return exists ? { status: 200, text: JSON.stringify(cm), warnings: [] } : { status: 404, text: '{"kind":"Status","message":"not found"}', warnings: [] };
      return { status: 200, text: JSON.stringify(cm), warnings: [] };
    };
    const { b } = broker(send, () => {
      exists = true; // someone creates it while you look
      return { decision: "approve" };
    });
    const configmaps = { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true };
    const out = await b.propose({ tool: "apply_manifest", title: "", reason: "", operations: [{ verb: "patch", type: configmaps, namespace: "landlens-dev", name: "c", patchType: "apply", body: cm }] });
    expect(out).toMatchObject({ state: "failed", stage: "apply", error: expect.stringContaining("created by someone else") });
    expect(log.filter((l) => l.startsWith("PATCH") && !l.includes("dryRun"))).toEqual([]);
  });

  it("expires after its time, and is withdrawn when the turn ends; neither applies anything", async () => {
    const k = fakeCluster();
    const { b, seen } = broker(k.send, () => "never", { ttlMs: 20 });
    expect(await b.propose({ tool: "scale", title: "", reason: "", operations: [scale(3)] })).toEqual({ state: "expired" });
    expect(seen.at(-1)!.state).toBe("expired");
    const { b: b2, seen: seen2 } = broker(k.send, () => "never");
    const turn = new AbortController();
    const p = b2.propose({ tool: "scale", title: "", reason: "", operations: [scale(3)] }, turn.signal);
    await new Promise((r) => setTimeout(r, 5));
    turn.abort();
    expect(await p).toEqual({ state: "withdrawn" });
    expect(seen2.at(-1)!.state).toBe("withdrawn");
    expect(k.get().spec.replicas).toBe(1);
    expect(k.log.filter((l) => l.method === "PATCH" && !l.path.includes("dryRun"))).toEqual([]);
  });

  it("puts a resourceVersion test first in a JSON patch", async () => {
    const k = fakeCluster();
    const { b } = broker(k.send, () => ({ decision: "reject" }));
    await b.propose({ tool: "patch", title: "", reason: "", operations: [{ verb: "patch", patchType: "json", type: deployments, namespace: "landlens-dev", name: "orders-api", body: [{ op: "replace", path: "/spec/replicas", value: 2 }] }] }).catch(() => {});
    const patch = k.log.find((l) => l.method === "PATCH")!;
    expect(patch.contentType).toBe("application/json-patch+json");
    expect(patch.body[0]).toEqual({ op: "test", path: "/metadata/resourceVersion", value: "100" });
  });
});

describe("risk tags", () => {
  it("flag deletes, RBAC, cluster scope, images, restarts and scaling to zero", () => {
    expect(risks({ verb: "patch", type: roles, name: "x" }, {}, {})).toEqual(["rbac", "cluster-scoped"]);
    const b = deployment();
    expect(risks(scale(0), b, deployment("1", 0))).toEqual(["scales-to-zero"]);
    expect(risks(scale(1), b, deployment("1", 1, "orders:2"))).toEqual(["changes-image", "restarts-pods"]);
  });

  it("flag what a pod spec could reach, in any kind, and a new workload", () => {
    const jobs = { group: "batch", version: "v1", resource: "jobs", kind: "Job", namespaced: true };
    const job = (spec: object) => ({ kind: "Job", spec: { template: { spec: { containers: [{ name: "x", image: "busybox" }], ...spec } } } });
    const create: ChangeOp = { verb: "patch", type: jobs, namespace: "landlens-dev", name: "j", patchType: "apply" };
    expect(risks(create, null, job({ volumes: [{ name: "s", secret: { secretName: "db" } }] }))).toEqual(["reads-secret", "new-workload"]);
    expect(risks(create, null, job({ hostNetwork: true, serviceAccountName: "admin" }))).toEqual(["host-access", "service-account", "new-workload"]);
    const priv = { kind: "Job", spec: { template: { spec: { containers: [{ name: "x", image: "busybox", securityContext: { privileged: true }, env: [{ name: "P", valueFrom: { secretKeyRef: { name: "db", key: "p" } } }] }] } } } };
    expect(risks(create, job({}), priv)).toEqual(["reads-secret", "privileged", "restarts-pods"]);
    // A custom resource that wraps a pod template is read the same way.
    const rollouts = { group: "argoproj.io", version: "v1alpha1", resource: "rollouts", kind: "Rollout", namespaced: true };
    const ro = (image: string) => ({ kind: "Rollout", spec: { template: { spec: { containers: [{ name: "a", image }] } } } });
    expect(risks({ verb: "patch", type: rollouts, namespace: "n", name: "r", patchType: "merge" }, ro("a:1"), ro("a:2"))).toEqual(["changes-image", "restarts-pods"]);
    // A restart stamps the template's annotations only.
    const d = deployment();
    const restarted = structuredClone(d) as any;
    restarted.spec.template.metadata = { annotations: { "kubectl.kubernetes.io/restartedAt": "now" } };
    expect(risks(scale(1), d, restarted)).toEqual(["restarts-pods"]);
    // What was already there isn't flagged again.
    expect(risks({ ...create, verb: "patch" }, priv, priv)).toEqual([]);
  });
});

describe("what the agent hears of an API server's error", () => {
  it("has no quoted values and no Invalid value", () => {
    expect(agentSafe('metadata.annotations: Invalid value: "s3cr3t-value": must be no more than 63 characters')).toBe('metadata.annotations: Invalid value: "…": must be no more than 63 characters');
    expect(agentSafe("spec.x: Invalid value: 12345678: must be small")).toBe("spec.x: Invalid value: …: must be small");
    expect(agentSafe('a "quoted \\"escaped\\" value" here')).toBe('a "…" here');
  });
});

describe("the diff", () => {
  it("folds unchanged runs and numbers both sides", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const b = a.replace("l10", "L10");
    const d = diffLines(a, b);
    expect(d).toMatchObject({ added: 1, removed: 1 });
    expect(d.lines[0]).toEqual({ t: "…", text: "7 unchanged lines" });
    expect(d.lines.find((l) => l.t === "+")).toEqual({ t: "+", text: "L10", newNo: 11 });
    expect(d.lines.at(-1)).toEqual({ t: "…", text: "6 unchanged lines" });
  });

  it("shows a create as all added and a delete as all removed", () => {
    expect(diffLines("", "a\nb")).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines("a\nb", "")).toMatchObject({ added: 0, removed: 2 });
  });
});

describe("security review of wave 8 part 1, L1: the agent's broker keeps no unscrubbed objects", () => {
  it("prepareOp returns the objects before and after only when asked (the person's actions)", async () => {
    const k = fakeCluster();
    const { b } = broker(k.send, () => "never");
    const agent = await (b as any).prepare(scale(3));
    expect("current" in agent || "after" in agent).toBe(false);
    const { prepareOp } = await import("../src/changes.js");
    const mine = await prepareOp(k.send, scale(3), { fieldManager: "landlens", hideSecrets: true, keepObjects: true });
    expect((mine.current as any).spec.replicas).toBe(1);
    expect((mine.after as any).spec.replicas).toBe(3);
  });
});
