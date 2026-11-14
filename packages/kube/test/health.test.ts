import { describe, expect, it } from "vitest";
import { clusterHealth, healthText } from "../src/health.js";

const now = Date.parse("2026-11-14T12:00:00Z");
const pod = (name: string, ns: string, extra: any) => ({ metadata: { name, namespace: ns, creationTimestamp: "2026-11-14T10:00:00Z" }, spec: { containers: [{ name: "api" }] }, ...extra });
const running = (name: string, ns: string, restarts = 0) => pod(name, ns, { status: { phase: "Running", containerStatuses: [{ name: "api", ready: true, restartCount: restarts, state: { running: {} } }] } });
const data: Record<string, any> = {
  "/api/v1/pods": { items: [
    running("web-1", "shop"),
    running("flaky-1", "shop", 9),
    pod("orders-api-1", "landlens-dev", { status: { phase: "Running", containerStatuses: [{ name: "api", ready: false, restartCount: 11, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "Error", exitCode: 1 } } }] } }),
    pod("stuck-1", "shop", { status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", message: "0/1 nodes are available" }] } }),
  ] },
  "/apis/apps/v1/deployments": { items: [
    { metadata: { name: "orders-api", namespace: "landlens-dev" }, spec: { replicas: 1 }, status: { availableReplicas: 0 } },
    { metadata: { name: "web", namespace: "shop" }, spec: { replicas: 2 }, status: { availableReplicas: 2 } },
  ] },
  "/api/v1/nodes": { items: [{ metadata: { name: "n1", labels: { "node-role.kubernetes.io/control-plane": "" } }, status: { nodeInfo: { kubeletVersion: "v1.36.5" }, conditions: [{ type: "Ready", status: "True" }] } }] },
  "/api/v1/events": { items: [{ type: "Warning", reason: "BackOff", message: "Back-off restarting failed container api", count: 40, lastTimestamp: "2026-11-14T11:59:00Z", involvedObject: { kind: "Pod", namespace: "landlens-dev", name: "orders-api-1" } }] },
};
const get = async (path: string) => {
  const key = path.split("?")[0]!;
  if (!(key in data)) throw Object.assign(new Error("not found"), { status: 404 });
  return data[key];
};

describe("clusterHealth", () => {
  it("counts, and puts failing workloads before warnings", async () => {
    const h = await clusterHealth(get, { now });
    expect(h.pods).toEqual({ total: 4, running: 2, succeeded: 0, pending: 1, failing: 1, restarts: 20 });
    expect(h.deployments).toEqual({ total: 2, available: 1 });
    expect(h.nodes).toMatchObject({ total: 1, ready: 1, items: [{ name: "n1", roles: ["control-plane"] }] });
    expect(h.namespaces).toBe(2);
    expect(h.problems.map((p) => `${p.kind}/${p.name} ${p.reason} ${p.tone}`)).toEqual([
      "Pod/orders-api-1 CrashLoopBackOff bad",
      "Deployment/orders-api Unavailable bad",
      "Pod/flaky-1 Restarts warn",
      "Pod/stuck-1 Pending warn",
    ]);
    expect(h.warnings[0]).toMatchObject({ reason: "BackOff", name: "orders-api-1", count: 40 });
  });

  it("reads as the agent's overview", async () => {
    const t = healthText(await clusterHealth(get, { now }));
    expect(t).toContain("pod landlens-dev/orders-api-1: CrashLoopBackOff in container api (11 restarts); last exit Error code 1");
    expect(t).toContain("pod shop/stuck-1: Pending for 2h; 0/1 nodes are available");
    expect(t).toContain("Back-off restarting failed container api");
  });

  it("leaves out what the access can't read", async () => {
    const h = await clusterHealth(async (p) => (p.includes("nodes") || p.includes("deployments") ? Promise.reject(new Error("403")) : get(p)), { now });
    expect(h.nodes).toBeNull();
    expect(h.deployments).toBeNull();
  });
});
