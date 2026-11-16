// Your actions (wave 8, D141–D142): what each action sends, which kinds it takes, and the facts beside the diff.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { actionFacts, actionFits, asksInMain, buildOps, capFacts, cordonBody, factList, restartBody, scaleBody, selects, triggerJob, triggerName, type ActionTarget } from "../src/actions.js";

const T = {
  deployments: { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "patch", "delete"] },
  statefulsets: { group: "apps", version: "v1", resource: "statefulsets", kind: "StatefulSet", namespaced: true, verbs: ["patch", "delete"] },
  daemonsets: { group: "apps", version: "v1", resource: "daemonsets", kind: "DaemonSet", namespaced: true, verbs: ["patch", "delete"] },
  cronjobs: { group: "batch", version: "v1", resource: "cronjobs", kind: "CronJob", namespaced: true, verbs: ["patch", "delete"] },
  jobs: { group: "batch", version: "v1", resource: "jobs", kind: "Job", namespaced: true, verbs: ["create", "patch", "delete"] },
  configmaps: { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true, verbs: ["delete"] },
  namespaces: { group: "", version: "v1", resource: "namespaces", kind: "Namespace", namespaced: false, verbs: ["delete"] },
  pods: { group: "", version: "v1", resource: "pods", kind: "Pod", namespaced: true, verbs: ["delete"] },
  events: { group: "", version: "v1", resource: "events", kind: "Event", namespaced: true, verbs: ["get", "list"] },
};
const at = (type: ActionTarget["type"], name: string, namespace: string | undefined = "landlens-dev"): ActionTarget => ({ type, name, ...(type.namespaced && namespace ? { namespace } : {}) });

const cronJob = {
  apiVersion: "batch/v1", kind: "CronJob",
  metadata: { name: "hands-report", namespace: "landlens-dev", uid: "cj-uid", resourceVersion: "9" },
  spec: {
    schedule: "0 0 31 2 *", concurrencyPolicy: "Forbid",
    jobTemplate: {
      metadata: { labels: { app: "hands-report" }, annotations: { team: "ops" } },
      spec: { backoffLimit: 0, template: { spec: { restartPolicy: "Never", containers: [{ name: "r", image: "busybox:1.36", env: [{ name: "DB_PASSWORD", value: "hunter2" }] }] } } },
    },
  },
  status: {},
};

describe("what each action sends (D141)", () => {
  it("scale: a merge patch of replicas, the agent's body", () => {
    const [op] = buildOps({ kind: "scale", targets: [at(T.deployments, "hands-web")], replicas: 3 });
    expect(op).toEqual({ verb: "patch", patchType: "merge", type: { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true }, namespace: "landlens-dev", name: "hands-web", body: { spec: { replicas: 3 } } });
    expect(op!.body).toEqual(scaleBody(3));
    expect(() => buildOps({ kind: "scale", targets: [at(T.deployments, "x")], replicas: 1001 })).toThrow(/0 to 1000/);
    expect(() => buildOps({ kind: "scale", targets: [at(T.daemonsets, "x")], replicas: 1 })).toThrow(/doesn't scale daemonsets/);
  });

  it("restart: a strategic patch of the template's restartedAt, the agent's body, one per target", () => {
    const now = new Date("2026-11-16T00:00:00.000Z");
    const ops = buildOps({ kind: "restart", targets: [at(T.deployments, "a"), at(T.deployments, "b")], now });
    expect(ops.map((o) => [o.verb, o.patchType, o.name])).toEqual([["patch", "strategic", "a"], ["patch", "strategic", "b"]]);
    expect(ops[0]!.body).toEqual({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": "2026-11-16T00:00:00.000Z" } } } } });
    expect(ops[0]!.body).toEqual(restartBody(now));
  });

  it("the agent's scale and rollout_restart tools build their bodies with the same functions", () => {
    const src = readFileSync(resolve(__dirname, "../../kube-mcp/src/writes.ts"), "utf8");
    expect(src).toContain("body: scaleBody(a.replicas)");
    expect(src).toContain("const body = restartBody(new Date());");
  });

  it("delete: one DELETE per object; a mix of kinds, a wide kind in bulk, more than 50, or a kind that doesn't delete is refused", () => {
    const ops = buildOps({ kind: "delete", targets: [at(T.configmaps, "a"), at(T.configmaps, "b")] });
    expect(ops.map((o) => [o.verb, o.name, o.body])).toEqual([["delete", "a", undefined], ["delete", "b", undefined]]);
    expect(() => buildOps({ kind: "delete", targets: [at(T.configmaps, "a"), at(T.pods, "b")] })).toThrow(/One kind/);
    expect(() => buildOps({ kind: "delete", targets: [at(T.namespaces, "a"), at(T.namespaces, "b")] })).toThrow(/one at a time/);
    expect(buildOps({ kind: "delete", targets: [at(T.namespaces, "a")] })[0]).toMatchObject({ verb: "delete", name: "a" });
    expect(() => buildOps({ kind: "delete", targets: Array.from({ length: 51 }, (_, i) => at(T.configmaps, `c${i}`)) })).toThrow(/At most 50/);
    expect(() => buildOps({ kind: "delete", targets: [at(T.events, "e")] })).toThrow(/doesn't delete events/);
    expect(() => buildOps({ kind: "delete", targets: [{ type: T.configmaps, name: "a" }] })).toThrow(/needs a namespace/);
  });

  it("suspend and resume: a merge patch of spec.suspend, CronJobs and Jobs only", () => {
    expect(buildOps({ kind: "suspend", targets: [at(T.cronjobs, "r")], suspend: true })[0]!.body).toEqual({ spec: { suspend: true } });
    expect(buildOps({ kind: "suspend", targets: [at(T.jobs, "j")], suspend: false })[0]!.body).toEqual({ spec: { suspend: false } });
    expect(actionFits("suspend", T.deployments)).toBe(false);
  });

  it("trigger: kubectl's Job: the template, its labels and annotations, the manual annotation, one controller owner; env values survive", () => {
    const [op] = buildOps({ kind: "trigger", targets: [at(T.cronjobs, "hands-report")], cronJob, jobs: T.jobs, suffix: "a1b2c" });
    expect(op).toMatchObject({ verb: "create", namespace: "landlens-dev", name: "hands-report-manual-a1b2c", type: { resource: "jobs", group: "batch" } });
    const job = op!.body as any;
    expect(job.metadata).toEqual({
      name: "hands-report-manual-a1b2c", namespace: "landlens-dev", labels: { app: "hands-report" },
      annotations: { team: "ops", "cronjob.kubernetes.io/instantiate": "manual" },
      ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "hands-report", uid: "cj-uid", controller: true }],
    });
    expect(job.spec).toEqual(cronJob.spec.jobTemplate.spec);
    expect(job.spec.template.spec.containers[0].env[0].value).toBe("hunter2");
    // A copy: the CronJob read isn't changed.
    job.spec.backoffLimit = 9;
    expect(cronJob.spec.jobTemplate.spec.backoffLimit).toBe(0);
  });

  it("trigger: a 52-character CronJob makes a 63-character Job name; the suffix is 5 of [a-z0-9]", () => {
    const long = "x".repeat(52);
    expect(triggerName(long, "abcde")).toHaveLength(63);
    expect(triggerName(long, "abcde")).toBe(`${"x".repeat(50)}-manual-abcde`);
    expect(() => triggerName("a", "ABCDE")).toThrow();
    expect(() => triggerJob({ metadata: { name: "a" }, spec: {} }, "abcde")).toThrow(/no job template/);
    // Not the CronJob asked for: refused.
    expect(() => buildOps({ kind: "trigger", targets: [at(T.cronjobs, "other")], cronJob, jobs: T.jobs, suffix: "a1b2c" })).toThrow(/isn't the CronJob/);
  });
});

const MARK = "LLMARK-annotation-or-message-0000000000";
const deployment = (o: { replicas?: number; strategy?: unknown; updated?: number; gen?: number; seen?: number; labels?: Record<string, string> } = {}) => ({
  kind: "Deployment",
  metadata: { name: "hands-web", namespace: "landlens-dev", generation: o.gen ?? 1, annotations: { note: MARK } },
  spec: { replicas: o.replicas ?? 2, ...(o.strategy ? { strategy: o.strategy } : {}), template: { metadata: { labels: o.labels ?? { app: "hands-web" } } } },
  status: { replicas: o.replicas ?? 2, updatedReplicas: o.updated ?? o.replicas ?? 2, observedGeneration: o.seen ?? o.gen ?? 1 },
});
const obj = (resource: string, o: any, group = "apps", kind = "Deployment") => ({ group, resource, kind, obj: o });

describe("facts: what the diff doesn't say (D142)", () => {
  it("scale: an autoscaler that sets it back, a budget it goes under, and a read that failed", () => {
    const hpa = { metadata: { name: "hands-web-hpa" }, spec: { scaleTargetRef: { kind: "Deployment", name: "hands-web" }, minReplicas: 2, maxReplicas: 10 }, status: { message: MARK } };
    const pdb = { metadata: { name: "hands-web-pdb", annotations: { x: MARK } }, spec: { minAvailable: 2, selector: { matchLabels: { app: "hands-web" } } } };
    const f = actionFacts({ kind: "scale", replicas: 1, objects: [obj("deployments", deployment())], hpas: [hpa], pdbs: [pdb] });
    expect(f.map((x) => [x.tone, x.code, x.text])).toEqual([
      ["warn", "hpa", "HorizontalPodAutoscaler hands-web-hpa sets replicas between 2 and 10; it will set this back."],
      ["warn", "pdb-min", "PodDisruptionBudget hands-web-pdb wants 2 available."],
    ]);
    expect(actionFacts({ kind: "scale", replicas: 3, objects: [obj("deployments", deployment())], hpas: [], pdbs: [pdb] })).toEqual([]);
    const no = actionFacts({ kind: "scale", replicas: 1, objects: [obj("deployments", deployment())], hpas: { status: 403 }, pdbs: { status: 403 } });
    expect(no.map((x) => x.text)).toEqual(["Landlens couldn't check for autoscalers here (HTTP 403).", "Landlens couldn't check for disruption budgets here (HTTP 403)."]);
    expect(no.every((x) => x.code === "couldnt-check")).toBe(true);
  });

  it("restart: a gap with one pod, a rollout in flight, a DaemonSet's nodes", () => {
    const one = (strategy?: unknown) => actionFacts({ kind: "restart", objects: [obj("deployments", deployment({ replicas: 1, ...(strategy ? { strategy } : {}) }))] }).map((x) => x.code);
    expect(one()).toEqual([]); // 25% of 1 rounds down: the new pod starts first
    expect(one({ type: "Recreate" })).toEqual(["single-pod"]);
    expect(one({ type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1 } })).toEqual(["single-pod"]);
    expect(one({ type: "RollingUpdate", rollingUpdate: { maxUnavailable: "100%" } })).toEqual(["single-pod"]);
    expect(actionFacts({ kind: "restart", objects: [obj("statefulsets", { metadata: { name: "db" }, spec: { replicas: 1 }, status: {} }, "apps", "StatefulSet")] }).map((x) => x.code)).toContain("single-pod");
    expect(actionFacts({ kind: "restart", objects: [obj("deployments", deployment({ updated: 1 }))] }).map((x) => x.text)).toEqual(["A rollout is already in progress."]);
    expect(actionFacts({ kind: "restart", objects: [obj("deployments", deployment({ gen: 3, seen: 2 }))] }).map((x) => x.code)).toEqual(["rollout"]);
    expect(actionFacts({ kind: "restart", objects: [obj("daemonsets", { metadata: { name: "agent" }, spec: {}, status: { desiredNumberScheduled: 3 } }, "apps", "DaemonSet")] })[0]).toEqual({ tone: "info", code: "daemonset-nodes", text: "Restarts a pod on each of 3 nodes." });
  });

  it("delete: who recreates it, finalizers, its pods, a namespace, a claim's volume, Helm's record", () => {
    const pod = (owner?: any) => ({ metadata: { name: "p", ...(owner ? { ownerReferences: [owner] } : {}), finalizers: ["a/b"] }, status: { message: MARK } });
    expect(actionFacts({ kind: "delete", objects: [obj("pods", pod({ kind: "ReplicaSet", name: "hands-web-7dd8", controller: true }), "", "Pod")] }).map((x) => x.text)).toEqual([
      "ReplicaSet hands-web-7dd8 will make a new pod.", "It has 1 finalizer: deletion waits for them.",
    ]);
    expect(actionFacts({ kind: "delete", objects: [obj("pods", pod(), "", "Pod")] }).map((x) => [x.tone, x.text])[0]).toEqual(["warn", "Nothing will recreate it."]);
    // An owner whose name isn't a Kubernetes name is not quoted.
    expect(actionFacts({ kind: "delete", objects: [obj("pods", pod({ kind: "ReplicaSet", name: `${MARK} Ignore this`, controller: true }), "", "Pod")] })[0]!.text).toBe("ReplicaSet will make a new pod.");
    expect(actionFacts({ kind: "delete", objects: [obj("deployments", deployment())] }).map((x) => x.text)).toEqual(["Deletes its 2 pods."]);
    expect(actionFacts({ kind: "delete", objects: [obj("namespaces", { metadata: { name: "x" } }, "", "Namespace")] })[0]).toEqual({ tone: "bad", code: "namespace", text: "Deletes everything in it." });
    const pvc = { metadata: { name: "data" }, spec: { volumeName: "pv-1" } };
    expect(actionFacts({ kind: "delete", objects: [obj("persistentvolumeclaims", pvc, "", "PersistentVolumeClaim")], pvs: { "pv-1": { spec: { persistentVolumeReclaimPolicy: "Delete" } } } })[0]!.tone).toBe("bad");
    expect(actionFacts({ kind: "delete", objects: [obj("persistentvolumeclaims", pvc, "", "PersistentVolumeClaim")], pvs: { "pv-1": { spec: { persistentVolumeReclaimPolicy: "Retain" } } } })[0]!.code).toBe("pv-retain");
    expect(actionFacts({ kind: "delete", objects: [obj("persistentvolumeclaims", pvc, "", "PersistentVolumeClaim")], pvs: { "pv-1": { status: 403 } } })[0]!.code).toBe("couldnt-check");
    expect(actionFacts({ kind: "delete", objects: [obj("secrets", { type: "helm.sh/release.v1", metadata: { name: "sh.helm.release.v1.shop.v3" } }, "", "Secret")] })[0]!.text).toBe("This is Helm's record of release shop, revision 3.");
  });

  it("trigger and suspend", () => {
    const f = actionFacts({ kind: "trigger", objects: [obj("cronjobs", { ...cronJob, spec: { ...cronJob.spec, suspend: true }, status: { active: [{ name: MARK }] } }, "batch", "CronJob")] });
    expect(f.map((x) => x.code)).toEqual(["forbid-active", "runs-now", "suspended"]);
    expect(actionFacts({ kind: "suspend", suspend: true, objects: [obj("jobs", { metadata: { name: "j" }, status: { active: 2 } }, "batch", "Job")] })[0]!.text).toBe("Suspending deletes its running pods.");
    expect(actionFacts({ kind: "suspend", suspend: false, objects: [obj("jobs", { metadata: { name: "j" }, status: { active: 2 } }, "batch", "Job")] })).toEqual([]);
  });

  it("several objects: each fact names its object; at most 8, the loudest first; no text from an annotation or a message", () => {
    const objects = Array.from({ length: 6 }, (_, i) => obj("pods", { metadata: { name: `p${i}`, finalizers: ["x"], annotations: { a: MARK } }, status: { message: MARK } }, "", "Pod"));
    const f = actionFacts({ kind: "delete", objects });
    expect(f).toHaveLength(8);
    expect(f[0]!.text).toBe("p0: Nothing will recreate it.");
    expect(f.slice(0, 6).every((x) => x.tone === "warn")).toBe(true);
    expect(JSON.stringify(f)).not.toContain("LLMARK");
  });

  it("label selectors: matchLabels and every expression operator", () => {
    expect(selects({ matchLabels: { a: "1" } }, { a: "1", b: "2" })).toBe(true);
    expect(selects({ matchExpressions: [{ key: "a", operator: "In", values: ["1"] }, { key: "c", operator: "DoesNotExist" }] }, { a: "1" })).toBe(true);
    expect(selects({ matchExpressions: [{ key: "a", operator: "NotIn", values: ["1"] }] }, { a: "1" })).toBe(false);
    expect(selects({ matchExpressions: [{ key: "a", operator: "Exists" }] }, {})).toBe(false);
    expect(selects({ matchExpressions: [{ key: "a", operator: "Bogus" }] }, { a: "1" })).toBe(false);
    expect(selects({}, { a: "1" })).toBe(true);
  });
});

describe("cordon (wave 8 part 2, D149)", () => {
  const nodes = { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false, verbs: ["get", "patch", "delete"] };
  const node = (name: string, o: { unschedulable?: boolean; ready?: boolean } = {}) => ({ metadata: { name }, spec: o.unschedulable ? { unschedulable: true } : {}, status: { conditions: [{ type: "Ready", status: o.ready === false ? "False" : "True" }] } });
  it("is a merge patch of spec.unschedulable, true or null, on a Node only, one at a time", () => {
    expect(buildOps({ kind: "cordon", targets: [at(nodes, "n1")], on: true })).toEqual([{ verb: "patch", patchType: "merge", type: { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false }, name: "n1", body: { spec: { unschedulable: true } } }]);
    expect(cordonBody(false)).toEqual({ spec: { unschedulable: null } });
    expect(() => buildOps({ kind: "cordon", targets: [at(T.deployments, "web")], on: true })).toThrow(/doesn't cordon/);
    expect(() => buildOps({ kind: "cordon", targets: [at(nodes, "n1"), at(nodes, "n2")], on: true })).toThrow(/One object/);
    expect(actionFits("drain", nodes)).toBe(true);
    expect(actionFits("drain", T.pods)).toBe(false);
  });
  it("says how many pods stay, and when it is the only node that takes new ones; never a name that isn't one", () => {
    const one = [{ group: "", resource: "nodes", kind: "Node", obj: node("n1") }];
    expect(actionFacts({ kind: "cordon", on: true, objects: one, nodePods: 12, nodes: [node("n1"), node("n2")] })).toEqual([{ tone: "info", code: "pods-stay", text: "12 pods keep running; new ones go elsewhere." }]);
    // n2 is cordoned and n3 not ready: n1 is the only one.
    expect(actionFacts({ kind: "cordon", on: true, objects: one, nodePods: 1, nodes: [node("n1"), node("n2", { unschedulable: true }), node("n3", { ready: false })] })).toEqual([
      { tone: "bad", code: "only-node", text: "This is the only node that takes new pods." },
      { tone: "info", code: "pods-stay", text: "1 pod keeps running; new ones stay Pending." },
    ]);
    expect(actionFacts({ kind: "cordon", on: true, objects: one, nodePods: { status: 403 }, nodes: { status: 403 } }).map((f) => f.text)).toEqual([
      "Landlens couldn't check for other nodes here (HTTP 403).", "Landlens couldn't check for the pods on it here (HTTP 403).",
    ]);
    expect(actionFacts({ kind: "cordon", on: false, objects: one })).toEqual([{ tone: "info", code: "uncordon", text: "New pods can be scheduled on it again." }]);
  });
});

describe("security review of part 1", () => {
  const T2 = {
    pvcs: { group: "", version: "v1", resource: "persistentvolumeclaims", kind: "PersistentVolumeClaim", namespaced: true, verbs: ["delete"] },
    crbs: { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterrolebindings", kind: "ClusterRoleBinding", namespaced: false, verbs: ["delete"] },
    widgets: { group: "example.com", version: "v1", resource: "widgets", kind: "Widget", namespaced: false, verbs: ["delete"] },
    replicasets: { group: "apps", version: "v1", resource: "replicasets", kind: "ReplicaSet", namespaced: true, verbs: ["patch"] },
  };
  const pvc = (i: number) => ({ group: "", resource: "persistentvolumeclaims", kind: "PersistentVolumeClaim", obj: { metadata: { name: `data-${i}` }, spec: { volumeName: `pv-${i}` } } });

  it("M4: 30 claims on Delete volumes: seven facts and \"and 23 more\", serious, so all 30 are counted", () => {
    const pvs = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pv-${i}`, { spec: { persistentVolumeReclaimPolicy: "Delete" } }]));
    const facts = actionFacts({ kind: "delete", objects: Array.from({ length: 30 }, (_, i) => pvc(i)), pvs });
    expect(facts).toHaveLength(8);
    expect(facts.slice(0, 7).every((f) => f.code === "pv-delete")).toBe(true);
    expect(facts[7]).toEqual({ tone: "bad", code: "more", text: "And 23 more: 23 serious." });
  });

  it("M4: a claim whose volume wasn't read says so; twenty of them are twenty facts, counted past the cut", () => {
    const pvs = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`pv-${i}`, { spec: { persistentVolumeReclaimPolicy: "Retain" } }]));
    const all = factList({ kind: "delete", objects: Array.from({ length: 30 }, (_, i) => pvc(i)), pvs });
    expect(all.filter((f) => f.code === "couldnt-check")).toHaveLength(20);
    expect(all.find((f) => f.code === "couldnt-check")!.text).toBe("data-10: Landlens didn't read its volume's reclaim policy.");
    expect(capFacts(all).at(-1)).toEqual({ tone: "info", code: "more", text: "And 23 more: 23 notes." });
  });

  it("M4: past the cut the loudest tone stays, with the counts by tone", () => {
    const f = (tone: "bad" | "warn" | "info", n: number) => Array.from({ length: n }, () => ({ tone, code: "x", text: "x" }));
    expect(capFacts([...f("bad", 7), ...f("warn", 2), ...f("info", 3)]).at(-1)).toEqual({ tone: "warn", code: "more", text: "And 5 more: 2 warnings, 3 notes." });
    expect(capFacts(f("info", 8))).toHaveLength(8);
  });

  it("M5: a ClusterRoleBinding, a cluster-scoped custom resource and a claim whose volume goes with it ask in main; a ConfigMap doesn't", () => {
    expect(asksInMain("delete", [{ type: T2.crbs, name: "admin" }], [])).toEqual(["ClusterRoleBinding is cluster-scoped: it isn't in any namespace."]);
    expect(asksInMain("delete", [{ type: T2.widgets, name: "w" }], [])).toHaveLength(1);
    const pvFacts = actionFacts({ kind: "delete", objects: [pvc(1)], pvs: { "pv-1": { spec: { persistentVolumeReclaimPolicy: "Delete" } } } });
    expect(asksInMain("delete", [at(T2.pvcs, "data-1")], pvFacts)).toEqual(["Its volume's reclaim policy is Delete: the data goes with it."]);
    const unread = actionFacts({ kind: "delete", objects: [pvc(1)], pvs: { "pv-1": { status: 403 } } });
    expect(asksInMain("delete", [at(T2.pvcs, "data-1")], unread)).toEqual(["Landlens couldn't check every claim's volume: its data may go with it."]);
    expect(asksInMain("delete", [at(T.configmaps, "c")], [])).toEqual([]);
    expect(asksInMain("delete", [at(T.deployments, "big")], [], [{ group: "apps", resource: "deployments", obj: { status: { replicas: 10 } } }])).toEqual(["Deletes 10 pods."]);
    expect(asksInMain("delete", [at(T.deployments, "small")], [], [{ group: "apps", resource: "deployments", obj: { status: { replicas: 9 } } }])).toEqual([]);
    expect(asksInMain("scale", [at(T.deployments, "x")], [{ tone: "bad", code: "x", text: "x" }])).toEqual([]);
  });

  it("L9: a cut CronJob name loses a trailing - or . so the Job's name is a label", () => {
    const n = triggerName(`${"a".repeat(49)}-bcd`, "a1b2c");
    expect(n).toBe(`${"a".repeat(49)}-manual-a1b2c`);
    expect(triggerName(`${"a".repeat(48)}.-x`, "a1b2c")).toBe(`${"a".repeat(48)}-manual-a1b2c`);
    expect(n.length).toBeLessThanOrEqual(63);
  });

  it("L10: owners say what they do: a CronJob doesn't remake its Job; a Deployment sets a ReplicaSet's scale back; a cut list is said", () => {
    const job = { group: "batch", resource: "jobs", kind: "Job", obj: { metadata: { name: "r-1", ownerReferences: [{ kind: "CronJob", name: "report", controller: true }] } } };
    expect(actionFacts({ kind: "delete", objects: [job] })).toEqual([{ tone: "info", code: "owner-schedule", text: "CronJob report doesn't make this Job again; its next Job comes on its schedule." }]);
    const podOfJob = { group: "", resource: "pods", kind: "Pod", obj: { metadata: { name: "p", ownerReferences: [{ kind: "Job", name: "r-1", controller: true }] } } };
    expect(actionFacts({ kind: "delete", objects: [podOfJob] })[0]!.text).toBe("Job r-1 makes a new pod only if it hasn't finished.");
    const rs = { group: "apps", resource: "replicasets", kind: "ReplicaSet", obj: { metadata: { name: "web-1", ownerReferences: [{ kind: "Deployment", name: "web", controller: true }] }, spec: {} } };
    expect(actionFacts({ kind: "scale", objects: [rs], replicas: 3, hpas: [], pdbs: [] })).toEqual([{ tone: "warn", code: "owner-sets-back", text: "Deployment web manages its replicas; it will set this back." }]);
    expect(actionFacts({ kind: "delete", objects: [{ ...rs, obj: { metadata: rs.obj.metadata } }] })[0]!.text).toBe("Deployment web will make a new one.");
    const dep = { group: "apps", resource: "deployments", kind: "Deployment", obj: { metadata: { name: "web" }, spec: {} } };
    expect(actionFacts({ kind: "scale", objects: [dep], replicas: 3, hpas: [], pdbs: [], cut: ["autoscalers"] })).toEqual([{ tone: "info", code: "list-cut", text: "Landlens read the first 500 autoscalers here; there are more it didn't check." }]);
    // A CRD's kind is a kind (M3's rule), in an owner too.
    const owned = { group: "", resource: "pods", kind: "Pod", obj: { metadata: { name: "p", ownerReferences: [{ kind: "fooBar", name: "f", controller: true }] } } };
    expect(actionFacts({ kind: "delete", objects: [owned] })[0]!.text).toBe("fooBar f owns it; whether it makes a new one is up to it.");
  });

  it("L12: the same object twice is refused", () => {
    expect(() => buildOps({ kind: "delete", targets: [at(T.configmaps, "a"), at(T.configmaps, "a")] })).toThrow(/named twice/);
    expect(buildOps({ kind: "delete", targets: [at(T.configmaps, "a"), at(T.configmaps, "a", "other")] })).toHaveLength(2);
  });
});
