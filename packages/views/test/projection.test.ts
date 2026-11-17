// Security review of wave 10 part 1, M5: a view keeps each watched object trimmed to what its document reads. A trimmed
// object holds nothing the source didn't ask for, and reads the same as the whole one.
import { describe, expect, it } from "vitest";
import { COMPUTED } from "../src/computed.js";
import { parsePath, readPath, type ParsedPath } from "../src/path.js";
import { BASE_KEEP, keepFor, keepKey, mergeKeep, project, type Keep } from "../src/projection.js";
import { parseFields } from "../src/rows.js";

const p = (s: string): ParsedPath => {
  const r = parsePath(s);
  if ("error" in r) throw new Error(r.error);
  return r;
};

const deployment = {
  apiVersion: "apps/v1", kind: "Deployment",
  metadata: {
    name: "api", namespace: "shop", uid: "u1", resourceVersion: "7", creationTimestamp: "2026-11-16T10:00:00Z",
    labels: { app: "api" }, annotations: { "example.com/big": "x".repeat(5_000), keep: "me" },
    ownerReferences: [{ kind: "Thing", name: "t", controller: true }],
  },
  spec: {
    replicas: 3, selector: { matchLabels: { app: "api" } },
    template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: "api:1", env: [{ name: "A", value: "<redacted>" }], resources: { requests: { cpu: "250m" } }, command: ["x".repeat(2_000)] }], volumes: [{ name: "v" }] } },
    strategy: { type: "RollingUpdate" },
  },
  status: { readyReplicas: 2, conditions: [{ type: "Available", status: "True", message: "y".repeat(3_000) }], observedGeneration: 4 },
};
const pod = {
  kind: "Pod",
  metadata: { name: "api-x", namespace: "shop", uid: "u2", labels: { app: "api" }, ownerReferences: [{ kind: "ReplicaSet", name: "api-1", controller: true }] },
  spec: { nodeName: "n1", containers: [{ name: "api", image: "api:1", args: ["z".repeat(4_000)], resources: { limits: { memory: "1Gi" } } }], initContainers: [{ name: "init", image: "i" }] },
  status: {
    phase: "Running", podIP: "10.0.0.1", containerStatuses: [{ name: "api", ready: true, restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff", message: "m".repeat(2_000) } }, lastState: { terminated: { message: "q".repeat(2_000) } } }],
    initContainerStatuses: [{ name: "init", ready: true, state: { terminated: { exitCode: 0, reason: "Completed" } } }],
  },
};
const event = { kind: "Event", metadata: { name: "e", namespace: "shop", uid: "u3" }, type: "Warning", reason: "BackOff", message: "boom", count: 3, lastTimestamp: "2026-11-16T10:00:00Z", involvedObject: { kind: "Pod", name: "api-x", namespace: "shop", uid: "x", fieldPath: "spec" }, source: { component: "kubelet" } };

/** Every path to a leaf of `o`, as dotted names (list elements as one). */
function leaves(o: unknown, at = ""): string[] {
  if (Array.isArray(o)) return o.flatMap((x) => leaves(x, at));
  if (o === null || typeof o !== "object") return [at];
  return Object.entries(o).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
}
/** Whether a dotted path lies under what `keep` keeps. */
function kept(keep: Keep, path: string): boolean {
  let k: Keep = keep;
  for (const part of path.split(".")) {
    if (k === true) return true;
    if (!Object.hasOwn(k, part)) return false;
    k = k[part]!;
  }
  return true;
}

describe("what a view keeps of an object", () => {
  it("keeps nothing the source didn't ask for: big annotations, env, args, messages and other fields go", () => {
    const fields = parseFields({ name: "$name", status: "$status", note: 'metadata.annotations["keep"]', image: "spec.template.spec.containers[0].image" });
    const keep = keepFor(fields);
    for (const o of [deployment, pod, event]) {
      const t = project(o, keep);
      for (const leaf of leaves(t)) expect(kept(keep, leaf), leaf).toBe(true);
    }
    const t = project(deployment, keep) as any;
    expect(t.metadata.annotations).toEqual({ keep: "me" });
    expect(t.spec.template.spec.containers[0]).not.toHaveProperty("env");
    expect(t.spec.template.spec.containers[0]).not.toHaveProperty("command");
    expect(t.spec).not.toHaveProperty("strategy");
    expect(t.status.conditions[0]).not.toHaveProperty("message");
    expect(JSON.stringify(project(pod, keep)).length).toBeLessThan(1_000);
    expect(project(event, keep)).not.toHaveProperty("source");
  });

  it("reads the same as the whole object, for every computed name and the paths it was made for", () => {
    const paths = ["spec.template.spec.containers[*].image", 'metadata.labels["app"]', "status.containerStatuses[0].restartCount", "reason", "message", "count", "spec.containers[0].args[0]", "status.podIP"];
    const keep = keepFor(parseFields(Object.fromEntries(paths.map((x, i) => [`f${i}`, x]))));
    const owners = new Map([["ReplicaSet/shop/api-1", { kind: "Deployment", name: "api" }]]);
    for (const o of [deployment, pod, event]) {
      const t = project(o, keep);
      for (const name of COMPUTED) expect(readPath(t, { computed: name }, { owners, now: 0 }), name).toEqual(readPath(o, { computed: name }, { owners, now: 0 }));
      for (const x of paths) expect(readPath(t, p(x)), x).toEqual(readPath(o, p(x)));
    }
  });

  it("merges what two sources on one watch read, and names it the same whichever comes first", () => {
    const a = keepFor(parseFields({ x: 'data["a"]' }));
    const b = keepFor(parseFields({ y: 'data["b"]', z: "spec" }));
    expect(keepKey(mergeKeep(a, b))).toBe(keepKey(mergeKeep(b, a)));
    expect(kept(mergeKeep(a, b), "data.a") && kept(mergeKeep(a, b), "data.b") && kept(mergeKeep(a, b), "spec.anything")).toBe(true);
    expect(keepKey(keepFor(parseFields({ n: "$name", s: "$status" })))).toBe(keepKey(BASE_KEEP));
  });
});
