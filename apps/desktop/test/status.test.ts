import type { KubeObject, ResourceType } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { buildNav } from "../src/renderer/src/kinds";
import { age, nodeRoles, nodeStatus, podReady, podRestarts, podStatus } from "@landlens/kube/status";

const pod = (status: any, extra: Partial<KubeObject> = {}): KubeObject =>
  ({ metadata: { name: "p", uid: "u" }, spec: { containers: [{ name: "a" }, { name: "b" }] }, status, ...extra }) as KubeObject;

describe("podStatus", () => {
  it("shows a crashlooping container's reason over the phase", () => {
    expect(podStatus(pod({ phase: "Running", containerStatuses: [
      { name: "a", ready: true, state: { running: {} } },
      { name: "b", ready: false, state: { waiting: { reason: "CrashLoopBackOff" } }, restartCount: 7 },
    ] }))).toEqual({ text: "CrashLoopBackOff", tone: "bad" });
  });

  it("is Running when every container runs", () => {
    expect(podStatus(pod({ phase: "Running", containerStatuses: [
      { ready: true, state: { running: {} } }, { ready: true, state: { running: {} } },
    ] }))).toEqual({ text: "Running", tone: "ok" });
  });

  it("reports init containers and OOMKilled", () => {
    expect(podStatus(pod({ phase: "Pending", initContainerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }] },
      { spec: { initContainers: [{}], containers: [{}] } } as any)).text).toBe("Init:0/1");
    expect(podStatus(pod({ phase: "Running", containerStatuses: [{ state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] })))
      .toEqual({ text: "OOMKilled", tone: "bad" });
  });

  it("says Terminating while deleting", () => {
    expect(podStatus(pod({ phase: "Running" }, { metadata: { name: "p", uid: "u", deletionTimestamp: "2026-01-01T00:00:00Z" } })).text)
      .toBe("Terminating");
  });

  it("counts ready containers and restarts", () => {
    const p = pod({ containerStatuses: [{ ready: true, restartCount: 2 }, { ready: false, restartCount: 7 }] });
    expect(podReady(p)).toMatchObject({ text: "1/2", tone: "warn" });
    expect(podRestarts(p)).toMatchObject({ text: "9", tone: "bad" });
  });
});

describe("nodes", () => {
  it("reads Ready and roles", () => {
    const n = { metadata: { name: "n", uid: "u", labels: { "node-role.kubernetes.io/control-plane": "" } },
      spec: { unschedulable: true }, status: { conditions: [{ type: "Ready", status: "True" }] } } as KubeObject;
    expect(nodeStatus(n)).toEqual({ text: "Ready,SchedulingDisabled", tone: "bad" });
    expect(nodeRoles(n)).toBe("control-plane");
  });
});

describe("age", () => {
  it("prints like kubectl", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(age(now - 45_000, now)).toBe("45s");
    expect(age(now - 30 * 60_000, now)).toBe("30m");
    expect(age(now - 5 * 3600_000, now)).toBe("5h");
    expect(age(now - 3 * 86400_000, now)).toBe("3d");
    expect(age(NaN, now)).toBe("");
  });
});

describe("buildNav", () => {
  const t = (group: string, resource: string, kind: string, namespaced = true, verbs = ["list", "watch", "get"]): ResourceType =>
    ({ group, version: "v1", resource, kind, namespaced, verbs });
  it("puts known kinds in sections, other listable kinds under their group, and skips the rest", () => {
    const nav = buildNav([
      t("", "pods", "Pod"), t("apps", "deployments", "Deployment"), t("", "nodes", "Node", false),
      t("example.com", "widgets", "Widget"), t("", "bindings", "Binding", true, ["create"]),
      t("metrics.k8s.io", "pods", "PodMetrics", true, ["get", "list"]), t("events.k8s.io", "events", "Event"),
    ]);
    expect(nav.map((n) => [n.section, n.label])).toEqual([
      ["Workloads", "Pods"], ["Workloads", "Deployments"], ["Cluster", "Nodes"], ["example.com", "Widget"],
    ]);
    expect(nav.at(-1)!.columns.map((c) => c.id)).toEqual(["name", "namespace", "age"]);
  });
  it("puts custom kinds under Custom resources by group, with Definitions first (D38)", () => {
    const nav = buildNav([
      t("apiextensions.k8s.io", "customresourcedefinitions", "CustomResourceDefinition", false),
      { ...t("k3s.cattle.io", "addons", "Addon"), custom: true },
      { ...t("cert-manager.io", "certificates", "Certificate"), custom: true },
      t("example.com", "widgets", "Widget"),
    ]);
    expect(nav.map((n) => [n.section, n.label, n.group])).toEqual([
      ["Custom resources", "Definitions", undefined],
      ["Custom resources", "Addon", "k3s.cattle.io"],
      ["Custom resources", "Certificate", "cert-manager.io"],
      ["example.com", "Widget", undefined],
    ]);
  });
});

// Security review of wave 10 part 1, L2: an object of another shape (a custom resource named Pod or Node) never throws.
describe("kubectl's words over odd shapes", () => {
  it("reads maps, nulls and strings where lists belong as nothing, never throwing", () => {
    const odd = { metadata: { name: "x" }, spec: { containers: { a: 1 }, initContainers: "no" }, status: { conditions: { Ready: { status: "True" } }, containerStatuses: { api: { restartCount: 9 } }, initContainerStatuses: [null] } } as unknown as KubeObject;
    expect(nodeStatus(odd)).toEqual({ text: "NotReady", tone: "bad" });
    expect(() => podStatus(odd)).not.toThrow();
    expect(podReady(odd).text).toBe("0/0");
    expect(podRestarts(odd).sort).toBe(0);
    const strange = { metadata: { name: "y" }, status: { reason: { not: "a string" }, containerStatuses: [{ restartCount: "7", state: { waiting: { reason: 42 } } }] } } as unknown as KubeObject;
    expect(typeof podStatus(strange).text).toBe("string");
    expect(podRestarts(strange).sort).toBe(0);
  });
});
