import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CertFact, KubeObject } from "@landlens/contracts";
import { diagnose, subjectOf } from "../src/doctor.js";

const now = Date.parse("2026-11-15T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const MARKER = "WORKLOAD-WROTE-THIS-91c2";

const pod = (name: string, extra: any = {}, owner?: { kind: string; name: string; hash?: string }): KubeObject => ({
  metadata: {
    name, namespace: "shop", creationTimestamp: ago(30 * MIN),
    ...(owner ? { ownerReferences: [{ kind: owner.kind, name: owner.name, controller: true }], labels: owner.hash ? { "pod-template-hash": owner.hash } : {} } : {}),
  },
  spec: { containers: [{ name: "api", image: "shop/api:1.2", resources: { limits: { memory: "64Mi" } }, readinessProbe: { httpGet: { path: "/ready", port: 8081 }, periodSeconds: 5 }, env: [{ name: "PASSWORD", value: MARKER }] }] },
  ...extra,
});
const rsPod = (name: string, deploy: string, extra: any) => pod(name, extra, { kind: "ReplicaSet", name: `${deploy}-7d9f8`, hash: "7d9f8" });
const crash = (exitCode: number, restarts = 7) => ({
  status: { phase: "Running", containerStatuses: [{ name: "api", ready: false, restartCount: restarts, state: { waiting: { reason: "CrashLoopBackOff", message: `back-off ${MARKER}` } }, lastState: { terminated: { reason: "Error", exitCode, finishedAt: ago(MIN), message: MARKER } } }] },
});
const event = (kind: string, name: string, reason: string, message: string, at = ago(MIN), extra: any = {}): any => ({
  type: "Warning", reason, message, count: 3, firstTimestamp: ago(20 * MIN), lastTimestamp: at, involvedObject: { kind, namespace: "shop", name, ...extra },
});
const deploy = (name: string, want: number, have: number, extra: any = {}): any => ({
  metadata: { name, namespace: "shop", creationTimestamp: ago(60 * MIN), generation: 2 },
  spec: { replicas: want },
  status: { observedGeneration: 2, availableReplicas: have, conditions: [{ type: "Available", status: have >= want ? "True" : "False", lastTransitionTime: ago(10 * MIN) }], ...extra },
});

describe("diagnose: rules", () => {
  it("groups a Deployment's crash-looping pods into one problem", () => {
    const pods = [1, 2, 3, 4, 5].map((i) => rsPod(`worker-7d9f8-${i}`, "worker", crash(2, i)));
    const r = diagnose({ pods, deployments: [deploy("worker", 5, 0)] }, now);
    expect(r.problems).toHaveLength(1);
    const p = r.problems[0]!;
    expect(p).toMatchObject({ class: "crashloop", tone: "bad", kind: "Deployment", name: "worker", group: "apps", resource: "deployments", podCount: 5, restarts: 5, container: "api", reason: "CrashLoopBackOff" });
    expect(p.pods).toHaveLength(5);
    expect(p.title).toBe("worker is crash-looping");
    expect(p.detail).toBe("container api · exit 2 (Error) · 5 restarts · 5 pods");
    expect(p.facts.available).toBe("0/5");
    expect(p.hint.cause).toMatch(/exits with code 2/);
    expect(p.id).toBe("crashloop|Deployment/shop/worker|api|CrashLoopBackOff");
  });

  it("names the cause from the exit code", () => {
    const cause = (code: number) => diagnose({ pods: [pod("p", crash(code))] }, now).problems[0]!.hint.cause;
    expect(cause(137)).toMatch(/SIGKILL/);
    expect(cause(127)).toMatch(/not found in the image/);
    expect(cause(0)).toMatch(/keep running/);
  });

  it("finds OOM kills, with the limit, and lets them age out once running again", () => {
    const oom = (finished: number, running: boolean) => pod("p", { status: { phase: "Running", containerStatuses: [{ name: "api", ready: running, restartCount: 4, state: running ? { running: {} } : { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: ago(finished) } } }] } });
    const bad = diagnose({ pods: [oom(MIN, false)] }, now).problems[0]!;
    expect(bad).toMatchObject({ class: "oom", tone: "bad", reason: "OOMKilled" });
    expect(bad.hint.cause).toContain("(64Mi)");
    expect(diagnose({ pods: [oom(10 * MIN, true)] }, now).problems[0]).toMatchObject({ class: "oom", tone: "warn" });
    expect(diagnose({ pods: [oom(90 * MIN, true)] }, now).problems).toEqual([]);
  });

  it("reads image pull errors and says why from the message, without repeating it", () => {
    const p = diagnose({ pods: [pod("p", { status: { phase: "Pending", containerStatuses: [{ name: "api", restartCount: 0, state: { waiting: { reason: "ImagePullBackOff", message: `manifest unknown ${MARKER}` } } }] } })] }, now).problems[0]!;
    expect(p).toMatchObject({ class: "image", tone: "bad" });
    expect(p.hint.cause).toBe("The image or tag shop/api:1.2 doesn't exist in the registry.");
  });

  it("finds pods no node can take, and turns bad after 15 minutes", () => {
    const pending = (age: number) => pod("p", { metadata: { name: "p", namespace: "shop", creationTimestamp: ago(age) }, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available: 1 node(s) didn't match Pod's node affinity/selector." }] } });
    expect(diagnose({ pods: [pending(MIN)] }, now).problems).toEqual([]);
    const p = diagnose({ pods: [pending(5 * MIN)] }, now).problems[0]!;
    expect(p).toMatchObject({ class: "pending", reason: "Unschedulable", tone: "warn", title: "p can't be scheduled" });
    expect(p.facts.scheduling).toContain("node affinity/selector");
    expect(p.hint.cause).toMatch(/labels this pod asks for/);
    expect(diagnose({ pods: [pending(20 * MIN)] }, now).problems[0]!.tone).toBe("bad");
  });

  it("names a pending pod's reason from its events (FailedMount)", () => {
    const p = pod("p", { status: { phase: "Pending", containerStatuses: [{ name: "api", state: { waiting: { reason: "ContainerCreating" } } }] } });
    const r = diagnose({ pods: [p], events: [event("Pod", "p", "FailedMount", 'configmap "tpl" not found')] }, now);
    expect(r.problems[0]).toMatchObject({ class: "pending", reason: "FailedMount" });
    expect(r.problems[0]!.hint.cause).toMatch(/ConfigMap, Secret or claim/);
    expect(r.problems[0]!.facts.events[0]).toEqual({ at: ago(MIN), reason: "FailedMount", message: 'configmap "tpl" not found', count: 3 });
  });

  it("finds failing readiness and liveness probes from Unhealthy events, with the probe's config", () => {
    const running = pod("p", { status: { phase: "Running", conditions: [{ type: "Ready", status: "False", lastTransitionTime: ago(20 * MIN) }], containerStatuses: [{ name: "api", ready: false, restartCount: 0, state: { running: {} } }] } });
    const r = diagnose({ pods: [running], events: [event("Pod", "p", "Unhealthy", "Readiness probe failed: dial tcp 10.0.0.1:8081: connect: connection refused", ago(MIN), { fieldPath: "spec.containers{api}" })] }, now);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ class: "probe", reason: "ReadinessProbe", tone: "warn", container: "api" });
    expect(r.problems[0]!.facts.probe).toMatchObject({ type: "readiness", how: "GET :8081/ready", period: 5, timeout: 1, failureThreshold: 3 });
    expect(r.problems[0]!.hint.cause).toContain("(GET :8081/ready)");

    const live = pod("q", { spec: { containers: [{ name: "api", livenessProbe: { exec: { command: ["cat", MARKER] } } }] }, status: { phase: "Running", containerStatuses: [{ name: "api", ready: true, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { exitCode: 137, reason: "Error", finishedAt: ago(MIN) } } }] } });
    const l = diagnose({ pods: [live], events: [event("Pod", "q", "Unhealthy", "Liveness probe failed: cat: can't open", ago(MIN), { fieldPath: "spec.containers{api}" })] }, now).problems;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ class: "probe", reason: "LivenessProbe", tone: "bad" });
    expect(l[0]!.facts.probe!.how).toBe("exec");
  });

  it("makes a readiness problem bad when its owner has none available", () => {
    const p = rsPod("cart-7d9f8-1", "cart", { status: { phase: "Running", containerStatuses: [{ name: "api", ready: false, state: { running: {} } }] } });
    const r = diagnose({ pods: [p], deployments: [deploy("cart", 1, 0)], events: [event("Pod", "cart-7d9f8-1", "Unhealthy", "Readiness probe failed: x")] }, now);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ class: "probe", kind: "Deployment", name: "cart", tone: "bad" });
    expect(r.problems[0]!.facts.available).toBe("0/1");
  });

  it("falls back to not ready when events can't be read, and lists short workloads on their own", () => {
    const p = pod("p", { status: { phase: "Running", conditions: [{ type: "Ready", status: "False", lastTransitionTime: ago(5 * MIN) }], containerStatuses: [{ name: "api", ready: false, state: { running: {} } }] } });
    expect(diagnose({ pods: [p] }, now).problems[0]).toMatchObject({ class: "notready", tone: "warn" });
    const r = diagnose({ pods: [], deployments: [deploy("web", 3, 1), deploy("api", 2, 0, { conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", lastTransitionTime: ago(10 * MIN) }] })] }, now);
    expect(r.problems.map((x) => `${x.name} ${x.class} ${x.tone} ${x.reason}`)).toEqual(["api unavailable bad ProgressDeadlineExceeded", "web unavailable warn Unavailable"]);
  });

  it("files leftover warning events by owner and reason, and drops events of pods that are gone", () => {
    const r = diagnose({
      pods: [], events: [
        event("PersistentVolumeClaim", "archive", "ProvisioningFailed", 'storageclass "x" not found'),
        event("PersistentVolumeClaim", "archive", "ProvisioningFailed", 'storageclass "x" not found'),
        event("Pod", "gone-1", "BackOff", "x"),
        event("Pod", "old", "BackOff", "x", ago(2 * 60 * MIN)),
      ],
    }, now);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ class: "warning", kind: "PersistentVolumeClaim", resource: "persistentvolumeclaims", reason: "ProvisioningFailed", title: "archive: ProvisioningFailed warnings", detail: "ProvisioningFailed ×6 · persistentvolumeclaim archive" });
    expect(r.problems[0]!.facts.events).toEqual([{ at: ago(MIN), reason: "ProvisioningFailed", message: 'storageclass "x" not found', count: 6 }]);
    expect(r.problems[0]!.hint.cause).toMatch(/storage class/);
  });

  it("checks certificates against fixed thresholds", () => {
    const cert = (notAfter: number, extra: Partial<CertFact> = {}): CertFact => ({ notBefore: ago(100 * 24 * 60 * MIN), notAfter: new Date(notAfter).toISOString(), which: "leaf", subject: "shop.test", issuer: "ca", sans: ["shop.test"], selfSigned: false, ...extra });
    const day = 24 * 60 * MIN;
    const r = diagnose({
      pods: [],
      certs: [
        { namespace: "shop", name: "expired", fact: cert(now - 3 * day) },
        { namespace: "shop", name: "soon", fact: cert(now + day) },
        { namespace: "shop", name: "later", fact: cert(now + 10 * day) },
        { namespace: "shop", name: "fine", fact: cert(now + 300 * day) },
        { namespace: "shop", name: "garbage", fact: { ...cert(0), unreadable: true } },
      ],
      ingresses: [{ metadata: { name: "shop", namespace: "shop", uid: "i1" }, spec: { tls: [{ secretName: "expired" }] } }],
    }, now);
    expect(r.problems.map((p) => `${p.name} ${p.reason} ${p.tone}`)).toEqual(["expired Expired bad", "soon Expiring bad", "later Expiring warn", "garbage Unreadable warn"]);
    expect(r.problems[0]).toMatchObject({ kind: "Secret", resource: "secrets", title: "expired expired 3d ago", since: new Date(now - 3 * day).toISOString() });
    expect(r.problems[0]!.facts.usedBy).toEqual(["shop"]);
    expect(r.problems[1]!.title).toBe("soon expires in 24h");
  });

  it("finds nodes not ready or under pressure", () => {
    const node: any = { metadata: { name: "n1" }, status: { conditions: [{ type: "Ready", status: "False" }, { type: "MemoryPressure", status: "True" }] } };
    expect(diagnose({ pods: [], nodes: [node] }, now).problems.map((p) => `${p.kind} ${p.reason} ${p.tone}`)).toEqual(["Node NotReady bad", "Node MemoryPressure warn"]);
  });
});

describe("diagnose: order, caps and safety", () => {
  it("puts failing before to-watch, then by class, then by pod count", () => {
    const r = diagnose({
      pods: [
        pod("a", { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "api", ready: true, restartCount: 6, state: { running: {} }, lastState: { terminated: { exitCode: 1, finishedAt: ago(MIN) } } }] } }),
        pod("b", crash(1)),
        pod("c", { status: { phase: "Pending", containerStatuses: [{ name: "api", state: { waiting: { reason: "ErrImagePull" } } }] } }),
      ],
    }, now);
    expect(r.problems.map((p) => `${p.name} ${p.class}`)).toEqual(["b crashloop", "c image", "a restarts"]);
  });

  it("caps problems at 500 and says so", () => {
    const pods = Array.from({ length: 520 }, (_, i) => pod(`p${i}`, crash(1)));
    const r = diagnose({ pods }, now);
    expect(r.problems).toHaveLength(500);
    expect(r.cut).toBe(true);
  });

  it("never copies env values, exec commands or workload-written text into a hint", () => {
    const evs = [event("Pod", "p", "BackOff", MARKER)];
    const r = diagnose({ pods: [pod("p", crash(1))], events: evs }, now);
    const p = r.problems[0]!;
    expect(JSON.stringify(p.hint)).not.toContain(MARKER);
    expect(JSON.stringify({ ...p, facts: { ...p.facts, events: [], lastState: {} } })).not.toContain(MARKER);
  });

  it("strips control characters from workload text", () => {
    const r = diagnose({ pods: [], events: [event("ConfigMap", "c", "Bad", "line one\nline two\u0007 three")] }, now);
    expect(r.problems[0]!.facts.events[0]!.message).toBe("line one line two three");
  });

  it("finds a pod's owner without reading it", () => {
    expect(subjectOf(rsPod("w-7d9f8-1", "w", {}))).toEqual({ kind: "Deployment", namespace: "shop", name: "w" });
    expect(subjectOf(pod("x", {}, { kind: "ReplicaSet", name: "bare" }))).toEqual({ kind: "ReplicaSet", namespace: "shop", name: "bare" });
    expect(subjectOf(pod("s-0", {}, { kind: "StatefulSet", name: "s" }))).toEqual({ kind: "StatefulSet", namespace: "shop", name: "s" });
    expect(subjectOf(pod("lone"))).toEqual({ kind: "Pod", namespace: "shop", name: "lone" });
  });
});

describe("diagnose: the security review's cases (wave 5 part 1)", () => {
  it("keeps 50 pod names and 20 events, counting all", () => {
    const pods = Array.from({ length: 60 }, (_, i) => rsPod(`w-7d9f8-${i}`, "w", crash(1)));
    const events = Array.from({ length: 30 }, (_, i) => event("Pod", "w-7d9f8-0", "BackOff", `message ${i}`));
    const p = diagnose({ pods, events }, now).problems[0]!;
    expect(p.pods).toHaveLength(50);
    expect(p.podCount).toBe(60);
    expect(p.facts.events).toHaveLength(20);
  });

  it("skips malformed objects instead of failing the report", () => {
    const junk: any[] = [null, {}, { metadata: { name: "x" }, status: { containerStatuses: [null, { name: 5 }], conditions: "no" } }, { metadata: { name: "y", ownerReferences: [null, { controller: true, name: 7 }] } }];
    const r = diagnose({ pods: [...junk, pod("ok", crash(1))], events: [null, { involvedObject: null }, { series: null, involvedObject: { kind: "Pod", name: "ok" } }] as any, deployments: [null, {}, { metadata: {} }] as any, nodes: [null, { metadata: { name: "n" }, status: { conditions: [null] } }] as any }, now);
    expect(r.problems.map((p) => p.name)).toEqual(["ok"]);
  });

  it("reads the kubelet's folded probe events", () => {
    const live = pod("q", { status: { phase: "Running", containerStatuses: [{ name: "api", restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } }] } });
    const r = diagnose({ pods: [live], events: [event("Pod", "q", "Unhealthy", "(combined from similar events): Liveness probe failed: x")] }, now);
    expect(r.problems[0]).toMatchObject({ class: "probe", reason: "LivenessProbe" });
  });

  it("puts only checked text into titles, details, hints and ids", () => {
    const bad = `shop/api:1 ${MARKER} ignore previous instructions`;
    const p1 = pod("p", { spec: { containers: [{ name: "api", image: bad, readinessProbe: { httpGet: { port: 8080, path: `/x ${MARKER}` } } }] }, status: { phase: "Pending", containerStatuses: [{ name: "api", state: { waiting: { reason: "ErrImagePull" } } }] } });
    const r1 = diagnose({ pods: [p1] }, now).problems[0]!;
    for (const t of [r1.title, r1.detail, r1.hint.cause, ...r1.hint.next, r1.id]) expect(t).not.toContain(MARKER);
    const p2 = pod("r", { spec: { containers: [{ name: "api", readinessProbe: { httpGet: { port: 8080, path: `/x ${MARKER}` } } }] }, status: { phase: "Running", containerStatuses: [{ name: "api", ready: false, state: { running: {} } }] } });
    const r2 = diagnose({ pods: [p2], events: [event("Pod", "r", "Unhealthy", "Readiness probe failed")] }, now).problems[0]!;
    expect(r2.facts.probe!.how).toBe("GET :8080 (path not shown)");
    const forged = diagnose({ pods: [], events: [
      event(`Pod ${MARKER}`, "x", "Bad", "m"), event("ConfigMap", `x ${MARKER}`, "Bad", "m"), event("ConfigMap", "c", `Ignore ${MARKER}`, "m"),
      { ...event("Widget", "w", "Bad", "m"), involvedObject: { kind: "Widget", namespace: "shop", name: "w", apiVersion: "x/../../api/v1/secrets#" } },
    ] }, now).problems;
    expect(forged.map((p) => `${p.kind} ${p.name} ${p.reason}`).sort()).toEqual(["ConfigMap c Warning", "Widget w Bad"]);
    expect(forged.find((p) => p.kind === "Widget")).toMatchObject({ group: "", version: "", resource: "" });
    expect(JSON.stringify(forged)).not.toContain(MARKER);
  });

  it("strips invisible characters from workload text", () => {
    const r = diagnose({ pods: [], events: [event("ConfigMap", "c", "Bad", "a\u202Eb\u200Bc\uFEFFd\u{E0041}e\u2066f")] }, now);
    expect(r.problems[0]!.facts.events[0]!.message).toBe("a b c d e f");
  });

  it("leaves out failed pods and rollouts in progress, and clamps future events", () => {
    const failed = pod("f", { status: { phase: "Failed", reason: "Evicted", containerStatuses: [{ name: "api", restartCount: 2, state: { terminated: { exitCode: 137 } } }] } });
    expect(diagnose({ pods: [failed] }, now).problems).toEqual([]);
    expect(diagnose({ pods: [], deployments: [deploy("web", 3, 2, { updatedReplicas: 1, replicas: 4 })] }, now).problems).toEqual([]);
    expect(diagnose({ pods: [], events: [event("ConfigMap", "c", "Bad", "m", new Date(now + 365 * 24 * 60 * MIN).toISOString())] }, now).problems).toEqual([]);
    const skewed = diagnose({ pods: [], events: [event("ConfigMap", "c", "Bad", "m", new Date(now + MIN).toISOString())] }, now);
    expect(skewed.problems[0]!.facts.events[0]!.at).toBe(new Date(now).toISOString());
  });

  it("keeps a pending pod's id when its newest event changes", () => {
    const p = pod("p", { status: { phase: "Pending" } });
    const a = diagnose({ pods: [p], events: [event("Pod", "p", "FailedMount", "x", ago(MIN)), { ...event("Pod", "p", "FailedScheduling", "y", ago(2 * MIN)), count: 1 }] }, now).problems[0]!;
    const b = diagnose({ pods: [p], events: [{ ...event("Pod", "p", "FailedScheduling", "y", ago(0)), count: 1 }, event("Pod", "p", "FailedMount", "x", ago(MIN))] }, now).problems[0]!;
    expect(a.id).toBe(b.id);
    expect(a.reason).toBe("FailedMount");
  });
});

// Recorded from the doctor scenarios on OrbStack (deploy/scenarios/doctor), so the rules meet real objects.
describe("diagnose: the scenarios", () => {
  const file = join(import.meta.dirname, "fixtures", "doctor", "landlens-dev.json");
  const rec = JSON.parse(readFileSync(file, "utf8"));
  const r = diagnose({ pods: rec.pods, deployments: rec.deployments, events: rec.events }, Date.parse(rec.at));
  const find = (name: string) => r.problems.find((p) => p.name === name);
  const cases: [name: string, cls: string, tone: string, cause: RegExp, podCount?: number][] = [
    ["orders-api", "crashloop", "bad", /exits with code 1/],
    ["ledger-worker", "crashloop", "bad", /exits with code 2/, 5],
    ["gpu-trainer", "pending", "warn", /labels this pod asks for/],
    ["thumbnailer", "oom", "bad", /memory limit \(24Mi\)/],
    ["cart-api", "probe", "bad", /readiness probe \(tcp :8081\)/],
    ["search-indexer", "probe", "bad", /liveness probe \(exec\)/],
    ["reports", "image", "bad", /registry\.invalid\/shop\/reports:9\.9\.9/],
    ["invoice-renderer", "pending", "warn", /ConfigMap, Secret or claim/],
    ["invoice-archive", "warning", "warn", /storage class/],
  ];
  for (const [name, cls, tone, cause, podCount] of cases) {
    it(`${name}: ${cls}`, () => {
      const p = find(name);
      expect(p, `${name} in ${r.problems.map((x) => x.name).join(", ")}`).toBeDefined();
      expect(p).toMatchObject({ class: cls, tone });
      expect(p!.hint.cause).toMatch(cause);
      if (podCount) expect(p!.podCount).toBe(podCount);
    });
  }
});
