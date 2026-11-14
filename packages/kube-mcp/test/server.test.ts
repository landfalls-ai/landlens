import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResourceType } from "@landlens/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentCluster } from "../src/cluster.js";
import { McpHost } from "../src/server.js";

const now = new Date().toISOString();
const types: ResourceType[] = [
  { group: "", version: "v1", resource: "pods", kind: "Pod", namespaced: true, verbs: ["get", "list"], shortNames: ["po"] },
  { group: "", version: "v1", resource: "events", kind: "Event", namespaced: true, verbs: ["list"] },
  { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "list"], shortNames: ["deploy"] },
  { group: "apps", version: "v1", resource: "replicasets", kind: "ReplicaSet", namespaced: true, verbs: ["get", "list"], shortNames: ["rs"] },
  { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false, verbs: ["get", "list"] },
];

const pod = {
  kind: "Pod",
  metadata: {
    name: "orders-api-7d9f-x1", namespace: "landlens-dev", uid: "pod-uid", creationTimestamp: now,
    ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "orders-api-7d9f", uid: "rs-uid", controller: true }],
    managedFields: [{ manager: "kubectl" }],
  },
  spec: {
    nodeName: "orbstack",
    containers: [{ name: "api", image: "busybox:1.36", command: ["sh", "-c", "exit 1"], env: [{ name: "DB_PASSWORD", value: "hunter2hunter2" }] }],
  },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }],
    containerStatuses: [{
      name: "api", ready: false, restartCount: 7,
      state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
      lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: now } },
    }],
  },
};
const rs = { kind: "ReplicaSet", metadata: { name: "orders-api-7d9f", namespace: "landlens-dev", uid: "rs-uid", ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "orders-api", uid: "d-uid", controller: true }] }, spec: { replicas: 1 }, status: { replicas: 1, readyReplicas: 0 } };
const deploy = { kind: "Deployment", metadata: { name: "orders-api", namespace: "landlens-dev", uid: "d-uid" }, spec: { replicas: 1 }, status: { replicas: 1, availableReplicas: 0 } };
const event = { metadata: { name: "e1", namespace: "landlens-dev" }, type: "Warning", reason: "BackOff", count: 30, lastTimestamp: now, involvedObject: { kind: "Pod", namespace: "landlens-dev", name: "orders-api-7d9f-x1", uid: "pod-uid" }, message: "Back-off restarting failed container api" };

/** A cluster that answers like the front door would, recording every path. */
function fakeCluster(): AgentCluster & { paths: string[] } {
  const paths: string[] = [];
  const routes: Record<string, unknown> = {
    "/api/v1/namespaces/landlens-dev/pods/orders-api-7d9f-x1": pod,
    "/api/v1/namespaces/landlens-dev/pods": { kind: "PodList", items: [pod], metadata: {} },
    "/api/v1/pods": { kind: "PodList", items: [pod], metadata: {} },
    "/apis/apps/v1/namespaces/landlens-dev/replicasets/orders-api-7d9f": rs,
    "/apis/apps/v1/namespaces/landlens-dev/deployments/orders-api": deploy,
    "/apis/apps/v1/deployments": { items: [deploy] },
    "/api/v1/namespaces/landlens-dev/events": { items: [event] },
    "/api/v1/events": { items: [event] },
    "/api/v1/nodes": { items: [{ metadata: { name: "orbstack" }, status: { conditions: [{ type: "Ready", status: "True" }] } }] },
  };
  return {
    context: "orbstack",
    paths,
    types: async () => types,
    get: async (path, accept) => {
      paths.push(path);
      const p = path.split("?")[0]!;
      if (p.endsWith("/log")) return { status: 200, text: `starting orders-api\nFATAL: DATABASE_URL is not set (token=${"a".repeat(20)})\n` };
      if (p.includes("/secrets")) return { status: 403, text: JSON.stringify({ kind: "Status", message: "Landlens: this token may not access secrets", code: 403 }) };
      const body = routes[p];
      return body ? { status: 200, text: JSON.stringify(body) } : { status: 404, text: JSON.stringify({ kind: "Status", message: `${p} not found`, code: 404 }) };
    },
  };
}

let host: McpHost;
let cluster: ReturnType<typeof fakeCluster>;
let client: Client;
const calls: { label: string; tool?: string; status: number }[] = [];

beforeAll(async () => {
  host = new McpHost((e) => calls.push(e));
  await host.start();
  cluster = fakeCluster();
  const token = host.addSession(cluster, "agent 1");
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});

afterAll(async () => {
  await client?.close();
  await host?.stop();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c: any) => c.text).join("\n") as string, isError: !!r.isError };
};

describe("landlens-kube MCP server", () => {
  it("lists read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["api_resources", "cluster_overview", "describe", "get_events", "get_logs", "get_resource", "list_resources", "rollout_history", "top"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
  });

  it("puts the crash loop first in the overview", async () => {
    const { text } = await call("cluster_overview");
    expect(text).toMatch(/pod landlens-dev\/orders-api-7d9f-x1: CrashLoopBackOff in container api \(7 restarts\); last exit Error code 1/);
    expect(text).toContain("deployment landlens-dev/orders-api: 0/1 available");
    expect(text).toContain("Back-off restarting failed container api");
  });

  it("describes a pod with its owners, last exit and events, without secrets", async () => {
    const { text } = await call("describe", { kind: "po", name: "orders-api-7d9f-x1", namespace: "landlens-dev" });
    expect(text).toContain("Container api: waiting (CrashLoopBackOff), ready false, restarts 7");
    expect(text).toContain("last exit: Error code 1");
    expect(text).toContain("ReplicaSet/orders-api-7d9f ready 0/1");
    expect(text).toContain("Deployment/orders-api ready 0/1");
    expect(text).toContain("BackOff");
    expect(text).toContain("env names: DB_PASSWORD");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("managedFields");
  });

  it("reads the previous run's log, scrubbed", async () => {
    const { text } = await call("get_logs", { name: "orders-api-7d9f-x1", namespace: "landlens-dev", previous: true, tailLines: 50 });
    expect(text).toContain("FATAL: DATABASE_URL is not set");
    expect(text).not.toContain("a".repeat(20));
    expect(cluster.paths.at(-1)).toBe("/api/v1/namespaces/landlens-dev/pods/orders-api-7d9f-x1/log?tailLines=50&previous=true");
  });

  it("lists pods the way kubectl prints them", async () => {
    const { text } = await call("list_resources", { kind: "pods", namespace: "landlens-dev" });
    expect(text).toMatch(/NAMESPACE\s+NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE\s+NODE/);
    expect(text).toMatch(/orders-api-7d9f-x1\s+0\/1\s+CrashLoopBackOff\s+7/);
  });

  it("returns refusals and bad names as tool errors, not crashes", async () => {
    expect(await call("get_resource", { kind: "secrets", name: "db", namespace: "landlens-dev" })).toMatchObject({ isError: true });
    const unknown = await call("get_resource", { kind: "widgets", name: "x" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toContain("api_resources");
    expect(await call("get_resource", { kind: "pods", name: "../secrets", namespace: "landlens-dev" })).toMatchObject({ isError: true });
    expect(cluster.paths.some((p) => p.includes(".."))).toBe(false);
  });

  it("records tool calls for the session", () => {
    expect(calls.some((c) => c.label === "agent 1" && c.tool === "describe" && c.status === 200)).toBe(true);
  });

  it("refuses callers without the session token, browsers, and other host names", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(host.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${"f".repeat(64)}` })).status).toBe(401);
    const token = host.addSession(fakeCluster(), "agent 2");
    expect((await post({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
    host.removeSession(token);
    expect((await post({ Authorization: `Bearer ${token}` })).status).toBe(401);
  });
});
