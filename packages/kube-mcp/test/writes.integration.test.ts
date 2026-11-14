// The agent's write tools against OrbStack: each change dry-run, shown, and applied only on approval, through the
// real front door, with the session's approved token for the broker and the read-only token for everything else.
// Works on its own Deployment in landlens-dev (made and removed here).
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/kube-mcp test:integration
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentChange } from "@landlens/contracts";
import { agentApprovedPolicy, agentReadOnlyPolicy, ChangeBroker, ClusterManager, FrontDoor, loopbackCert, type AuditEntry, type ChangeDecision } from "@landlens/kube";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frontDoorCluster, frontDoorSend } from "../src/cluster.js";
import { kubeMcpServer } from "../src/server.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
const NAME = "landlens-writes-test";
const exec = promisify(execFile);
const kubectl = (...args: string[]) => exec("kubectl", ["--context", "orbstack", "-n", NS, ...args]).then((r) => r.stdout);

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${NAME}, namespace: ${NS}, labels: { app: ${NAME} } }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${NAME} } }
  template:
    metadata: { labels: { app: ${NAME} } }
    spec:
      containers:
        - name: app
          image: busybox:1.36
          command: ["sh", "-c", "sleep 3600"]
          env: [{ name: MODE, value: "one" }]
          resources: { requests: { cpu: 5m, memory: 8Mi }, limits: { memory: 16Mi } }
`;

describe.runIf(run)("the agent's write tools on OrbStack", () => {
  let frontDoor: FrontDoor;
  let clusters: ClusterManager;
  let client: Client;
  const audit: AuditEntry[] = [];
  const shown: AgentChange[] = [];
  /** What the next change gets; may act on the cluster first (to make a conflict). */
  let answer: (c: AgentChange) => Promise<ChangeDecision> = async () => ({ decision: "reject" });

  beforeAll(async () => {
    await kubectl("delete", "deployment", NAME, "--ignore-not-found", "--wait=true");
    await kubectl("delete", "configmap", `${NAME}-cm`, "--ignore-not-found");
    const p = execFile("kubectl", ["--context", "orbstack", "apply", "-f", "-"]);
    p.stdin!.end(MANIFEST);
    await new Promise((r) => p.on("exit", r));

    frontDoor = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    await frontDoor.start();
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor });
    const { handle } = await clusters.connect("orbstack");
    const types = await clusters.discovery(handle);
    const token = frontDoor.issueToken({ label: "agent w", policy: agentReadOnlyPolicy([NS]), clusters: [handle] });
    const approved = frontDoor.issueToken({ label: "agent w · approved", policy: agentApprovedPolicy([NS]), clusters: [handle] });
    const broker = new ChangeBroker({
      session: "s-test",
      send: frontDoorSend({ url: frontDoor.clusterUrl(handle), certificate: frontDoor.certificate, token: approved }),
      namespaces: [NS],
      ask: (c) => (shown.push(c), answer(c)),
      update: () => {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await kubeMcpServer(frontDoorCluster({
      url: frontDoor.clusterUrl(handle), certificate: frontDoor.certificate, token, context: "orbstack", types: async () => types,
      namespaces: [NS], propose: (change, signal) => broker.propose(change, signal),
    })).connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  }, 90_000);

  afterAll(async () => {
    await client?.close();
    await clusters?.disconnectAll();
    await frontDoor?.stop();
    await kubectl("delete", "deployment", NAME, "--ignore-not-found", "--wait=false").catch(() => {});
    await kubectl("delete", "configmap", `${NAME}-cm`, "--ignore-not-found").catch(() => {});
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join("\n") as string, isError: !!r.isError };
  };
  const replicas = async () => Number(await kubectl("get", "deployment", NAME, "-o", "jsonpath={.spec.replicas}"));
  const writes = (since: number) => audit.slice(since).filter((e) => e.method !== "GET");

  it("applies a scale you approve, after a dry run, with the approved token", async () => {
    answer = async () => ({ decision: "approve" });
    const before = audit.length;
    const r = await call("scale", { name: NAME, namespace: NS, replicas: 2, reason: "test" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/approved, and Landlens applied it: deployment landlens-dev\/landlens-writes-test patched/);
    expect(await replicas()).toBe(2);
    const op = shown.at(-1)!.operations[0]!;
    expect(op.diff.lines.filter((l) => l.t === "-" || l.t === "+").map((l) => l.text.trim())).toEqual(["replicas: 1", "replicas: 2"]);
    expect(writes(before).map((e) => [e.label, e.method, !!e.dryRun, e.status])).toEqual([
      ["agent w · approved", "PATCH", true, 200],
      ["agent w · approved", "PATCH", false, 200],
    ]);
  });

  it("never applies a change you reject; only its dry run reached the API server", async () => {
    answer = async () => ({ decision: "reject", note: "keep two" });
    const before = audit.length;
    const r = await call("scale", { name: NAME, namespace: NS, replicas: 5, reason: "test" });
    expect(r.text).toContain('rejected this change; nothing was applied. Their note: "keep two"');
    expect(await replicas()).toBe(2);
    expect(writes(before).every((e) => e.dryRun)).toBe(true);
    expect(writes(before)).toHaveLength(1);
  });

  it("applies nothing when the object changes between the dry run and your yes", async () => {
    answer = async () => {
      await kubectl("annotate", "deployment", NAME, `landlens.test/touched=${Date.now()}`, "--overwrite");
      return { decision: "approve" };
    };
    const r = await call("scale", { name: NAME, namespace: NS, replicas: 3, reason: "test" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/409.*changed after the dry run/);
    expect(await replicas()).toBe(2);
  });

  it("restarts, then rolls back to the revision before, with the real template (env values the agent never saw)", async () => {
    answer = async () => ({ decision: "approve" });
    const restart = await call("rollout_restart", { name: NAME, namespace: NS, reason: "test" });
    expect(restart.isError, restart.text).toBe(false);
    expect(shown.at(-1)!.operations[0]!.risk).toContain("restarts-pods");
    await new Promise((r) => setTimeout(r, 1500)); // the controller writes the new ReplicaSet's revision
    const undo = await call("rollout_undo", { name: NAME, namespace: NS, reason: "test" });
    expect(undo.isError, undo.text).toBe(false);
    const tmpl = JSON.parse(await kubectl("get", "deployment", NAME, "-o", "jsonpath={.spec.template}"));
    expect(tmpl.metadata.annotations?.["kubectl.kubernetes.io/restartedAt"]).toBeUndefined();
    expect(tmpl.spec.containers[0].env).toEqual([{ name: "MODE", value: "one" }]);
  });

  it("creates from a manifest and deletes, each approved", async () => {
    answer = async () => ({ decision: "approve" });
    const cm = `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: ${NAME}-cm }\ndata: { a: "1" }\n`;
    const created = await call("apply_manifest", { manifest: cm, namespace: NS, reason: "test" });
    expect(created.isError, created.text).toBe(false);
    expect(shown.at(-1)!.operations[0]!).toMatchObject({ verb: "create", diff: { removed: 0 } });
    expect(await kubectl("get", "configmap", `${NAME}-cm`, "-o", "jsonpath={.data.a}")).toBe("1");
    answer = async () => ({ decision: "reject" });
    const kept = await call("delete", { kind: "configmap", name: `${NAME}-cm`, namespace: NS, reason: "test" });
    expect(kept.text).toContain("rejected");
    expect(await kubectl("get", "configmap", `${NAME}-cm`, "-o", "jsonpath={.data.a}")).toBe("1");
    answer = async () => ({ decision: "approve" });
    const del = await call("delete", { kind: "configmap", name: `${NAME}-cm`, namespace: NS, reason: "test" });
    expect(del.isError, del.text).toBe(false);
    expect(shown.at(-1)!.operations[0]!.risk).toEqual(["deletes"]);
    await expect(kubectl("get", "configmap", `${NAME}-cm`)).rejects.toThrow(/NotFound/);
  });

  it("won't propose Secrets, other namespaces, or values the agent saw redacted", async () => {
    const asked = shown.length;
    const s = await call("delete", { kind: "secret", name: "x", namespace: NS, reason: "test" });
    expect(s).toMatchObject({ isError: true });
    expect(s.text).toMatch(/never lets the agent change secrets/);
    const other = await call("scale", { name: "coredns", namespace: "kube-system", replicas: 0, reason: "test" });
    expect(other.text).toMatch(/may only change namespaces landlens-dev/);
    const red = await call("patch", { kind: "deployment", name: NAME, namespace: NS, reason: "test",
      patch: { spec: { template: { spec: { containers: [{ name: "app", env: [{ name: "MODE", value: "<redacted>" }] }] } } } } });
    expect(red.text).toMatch(/hid from you/);
    expect(shown.length).toBe(asked);
  });
});
