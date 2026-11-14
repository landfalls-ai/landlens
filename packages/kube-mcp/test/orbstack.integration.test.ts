// The agent's cluster tools against OrbStack, through the real front door with an agent token, the way a session
// uses them. Needs deploy/scenarios/crashloop.yaml applied (landlens-dev/orders-api).
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/kube-mcp test:integration
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentReadOnlyPolicy, ClusterManager, FrontDoor, loopbackCert, type AuditEntry } from "@landlens/kube";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frontDoorCluster } from "../src/cluster.js";
import { McpHost } from "../src/server.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");

describe.runIf(run)("landlens-kube tools on OrbStack", () => {
  let frontDoor: FrontDoor;
  let clusters: ClusterManager;
  let mcp: McpHost;
  let client: Client;
  const audit: AuditEntry[] = [];

  beforeAll(async () => {
    frontDoor = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    await frontDoor.start();
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor });
    const { handle } = await clusters.connect("orbstack");
    const types = await clusters.discovery(handle);
    const token = frontDoor.issueToken({ label: "agent test", policy: agentReadOnlyPolicy(), clusters: [handle] });
    mcp = new McpHost();
    await mcp.start();
    const mcpToken = mcp.addSession(frontDoorCluster({ url: frontDoor.clusterUrl(handle), certificate: frontDoor.certificate, token, context: "orbstack", types: async () => types }), "agent test");
    client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await mcp?.stop();
    await clusters?.disconnectAll();
    await frontDoor?.stop();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join("\n") as string, isError: !!r.isError };
  };
  const podName = async () => /orders-api-[a-z0-9]+-[a-z0-9]+/.exec((await call("list_resources", { kind: "pods", namespace: "landlens-dev" })).text)?.[0];

  it("finds the crash loop in the overview", async () => {
    const r = await call("cluster_overview");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/landlens-dev\/orders-api-\S+: (CrashLoopBackOff|Error)/);
  });

  it("reads the previous run's log", async () => {
    const name = await podName();
    expect(name).toBeTruthy();
    const r = await call("get_logs", { name, namespace: "landlens-dev", previous: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("FATAL: DATABASE_URL is not set");
  });

  it("describes the pod and reads its ConfigMap", async () => {
    const d = await call("describe", { kind: "pod", name: await podName(), namespace: "landlens-dev" });
    expect(d.isError, d.text).toBe(false);
    expect(d.text).toContain("Deployment/orders-api");
    const cm = await call("get_resource", { kind: "configmap", name: "orders-api-config", namespace: "landlens-dev" });
    expect(cm.isError, cm.text).toBe(false);
    expect(cm.text).toContain("DATABASE_HOST");
  });

  it("is refused Secrets by the front door, and says so", async () => {
    const r = await call("list_resources", { kind: "secrets", namespace: "landlens-dev" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("may not access secrets");
    expect(audit.some((a) => a.allowed && a.path.includes("secrets"))).toBe(false);
  });
});
