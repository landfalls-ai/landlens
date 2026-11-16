// The view runtime against OrbStack (wave 10 part 1): LANDLENS_INTEGRATION=orbstack pnpm test:integration.
// A view reads through a real front door with its own token (D209): its pods list goes live, Secrets are refused,
// env values and last-applied configuration never reach a row, Helm hands over eight fields, and the spec's [check]
// on metrics.k8s.io and pods/log is settled: both are reads the view's token is allowed (the audit says the request
// left the front door), and a cluster with no metrics-server says so.
//
// What it touches: a throwaway Deployment and ConfigMap (view-check-*, labelled scenario=view-check) made with
// kubectl apply in landlens-dev, scaled once, and deleted at the end. Nothing else is written.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceData } from "@landlens/contracts";
import { agentReadOnlyPolicy, ClusterManager, FrontDoor, frontDoorFetch, KubeClient, listReleases, loopbackCert, type AuditEntry } from "@landlens/kube";
import { SENTENCES } from "@landlens/views";
import { ViewRuntime, type ViewPush } from "../src/main/view-runtime";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
const NAME = `view-check-${randomBytes(3).toString("hex")}`;
const kubectl = async (...args: string[]) => (await exec("kubectl", ["--context", "orbstack", "-n", NS, ...args])).stdout;
const apply = (manifest: unknown) =>
  new Promise<void>((ok, fail) => {
    const p = spawn("kubectl", ["--context", "orbstack", "-n", NS, "apply", "-f", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(err))));
    p.stdin.end(JSON.stringify(manifest));
  });

const labels = { app: NAME, scenario: "view-check" };
const MANIFEST = {
  apiVersion: "v1",
  kind: "List",
  items: [
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: NAME, labels }, data: { note: "password=hunter2-in-a-configmap" } },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: NAME, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: NAME } },
        template: {
          metadata: { labels },
          spec: {
            terminationGracePeriodSeconds: 1,
            containers: [{
              name: "ticker", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
              env: [{ name: "DB_PASSWORD", value: "hunter2-in-env" }],
              command: ["sh", "-c", "i=0; while true; do echo \"tick $i token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"; i=$((i+1)); sleep 1; done"],
            }],
          },
        },
      },
    },
  ],
};

describe.runIf(run)("the view runtime on OrbStack", () => {
  let door: FrontDoor;
  let clusters: ClusterManager;
  let rt: ViewRuntime;
  let handle = "";
  const audit: AuditEntry[] = [];
  const pushes: ViewPush[] = [];
  const latest = (view: string, source: string): SourceData | undefined => [...pushes].reverse().find((p) => p.view === view && p.source === source)?.data;
  const wait = async (view: string, source: string, f: (d: SourceData) => boolean, ms = 60_000) => {
    const t0 = Date.now();
    for (;;) {
      const d = latest(view, source);
      if (d && f(d)) return d;
      if (Date.now() - t0 > ms) throw new Error(`timed out on ${source}: ${JSON.stringify(d)?.slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const doc = (sources: Record<string, unknown>) => ({ schema: 1, title: "check", sources, blocks: [{ type: "text", markdown: "x" }] });

  beforeAll(async () => {
    door = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    await door.start();
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    handle = (await clusters.connect("orbstack")).handle;
    rt = new ViewRuntime({
      clusters, frontDoor: door, push: (p) => pushes.push(p),
      helm: (h, ns) => listReleases(clusters.get(h).client, ns),
    });
    await apply(MANIFEST);
    await kubectl("rollout", "status", `deploy/${NAME}`, "--timeout=120s");
  }, 180_000);

  afterAll(async () => {
    rt?.closeAll();
    await kubectl("delete", "deploy,configmap", "-l", `app=${NAME}`, "--ignore-not-found", "--wait=true").catch(() => {});
    await clusters?.disconnectAll();
    await door?.stop();
  }, 120_000);

  it("a pods list goes live, with its workload, and no env value reaches a row", async () => {
    const id = rt.open({
      handle, namespaces: [NS],
      document: doc({ pods: { kind: "kube.list", resource: "pods", namespace: NS, labelSelector: `app=${NAME}`, fields: { name: "$name", owner: "$workload", status: "$status", env: "spec.containers[*].env[*].value" } } }),
    });
    let d = await wait(id, "pods", (x) => x.state === "ok" && x.rows.length === 1 && x.rows[0]!.status === "Running");
    expect(d.rows[0]!.owner).toBe(`Deployment/${NS}/${NAME}`);
    expect(d.rows[0]!.env).toBe("<redacted>");
    expect(JSON.stringify(d)).not.toContain("hunter2");
    await kubectl("scale", `deploy/${NAME}`, "--replicas=2");
    d = await wait(id, "pods", (x) => x.rows.length === 2);
    expect(d.truncated).toBe(false);
    const mine = audit.filter((e) => e.label === "view · orbstack");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.method === "GET" && e.access === "read")).toBe(true);
    rt.close(id);
  }, 120_000);

  it("a ConfigMap's last-applied configuration is gone and its credential-shaped data is scrubbed", async () => {
    const id = rt.open({
      handle,
      document: doc({ cm: { kind: "kube.list", resource: "configmaps", namespace: NS, labelSelector: `app=${NAME}`, fields: { name: "$name", applied: 'metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]', note: "data.note" } } }),
    });
    const d = await wait(id, "cm", (x) => x.state === "ok" && x.rows.length === 1);
    // kubectl apply wrote the annotation (with the data in it); the view's token strips it.
    expect((await kubectl("get", "configmap", NAME, "-o", "jsonpath={.metadata.annotations}"))).toContain("last-applied-configuration");
    expect(d.rows[0]!.applied).toBeNull();
    expect(d.rows[0]!.note).toBe("password=<redacted>");
    rt.close(id);
  }, 60_000);

  it("the view token's policy refuses Secrets, writes and namespaces outside its limit", async () => {
    const token = door.issueToken({ label: "view · orbstack", policy: agentReadOnlyPolicy([NS]), clusters: [handle] });
    const c = new KubeClient({ url: door.clusterUrl(handle), secret: "" }, frontDoorFetch({ certificate: door.certificate, token }));
    for (const [path, method] of [[`/api/v1/namespaces/${NS}/secrets`, "GET"], [`/api/v1/namespaces/${NS}/configmaps/${NAME}`, "DELETE"], ["/api/v1/namespaces/kube-system/pods", "GET"], ["/api/v1/secrets", "GET"]] as const) {
      const err = await c.json(path, { method }).catch((e) => e);
      expect(err?.status, `${method} ${path}`).toBe(403);
    }
    expect(await kubectl("get", "configmap", NAME, "-o", "name")).toContain(NAME);
    door.revokeToken(token);
    // And a document can't ask for Secrets at all.
    expect(() => rt.open({ handle, document: doc({ s: { kind: "kube.list", resource: "secrets" } }) })).toThrow(/isn't valid/);
  }, 60_000);

  it("[check] pods/log is a read the view's token is allowed: a workload's log, followed and scrubbed", async () => {
    const id = rt.open({ handle, namespaces: [NS], document: doc({ log: { kind: "kube.logs", namespace: NS, workload: { kind: "Deployment", name: NAME }, tailLines: 50 } }) });
    const d = await wait(id, "log", (x) => (x.lines?.length ?? 0) >= 3);
    expect(d.lines![0]!.text).toMatch(/^tick \d+ token=<redacted github token>$/);
    const logs = audit.filter((e) => e.label === "view · orbstack" && e.path.endsWith("/log"));
    expect(logs.length).toBeGreaterThan(0);
    // Every one was let through; a pod still starting may answer 400 itself, so at least one answered 200.
    expect(logs.every((e) => e.allowed)).toBe(true);
    expect(logs.some((e) => e.status === 200)).toBe(true);
    rt.close(id);
  }, 60_000);

  it("[check] metrics.k8s.io is a read the view's token is allowed; with no metrics-server, the source says so", async () => {
    const id = rt.open({ handle, namespaces: [NS], document: doc({ top: { kind: "kube.top", of: "pods", namespace: NS } }) });
    const d = await wait(id, "top", (x) => x.state !== "loading");
    const hasServer = !!(await exec("kubectl", ["--context", "orbstack", "get", "apiservices", "v1beta1.metrics.k8s.io", "-o", "name"]).catch(() => undefined));
    const asked = audit.filter((e) => e.label === "view · orbstack" && e.path.startsWith(`/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((e) => e.allowed)).toBe(true); // the front door let it through; the answer is the API server's
    if (hasServer) expect(d.state).toBe("ok");
    else {
      expect(asked[0]!.status).toBe(404);
      expect(d).toMatchObject({ state: "unavailable", message: SENTENCES.noMetricsServer, rows: [] });
    }
    rt.close(id);
  }, 60_000);

  it("Helm's releases are the eight fields, read as you", async () => {
    const id = rt.open({ handle, namespaces: [NS], document: doc({ h: { kind: "helm.releases", namespace: NS } }) });
    const d = await wait(id, "h", (x) => x.state === "ok");
    const demo = d.rows.find((r) => r.name === "landlens-demo");
    expect(demo, JSON.stringify(d.rows)).toBeDefined();
    expect(Object.keys(demo!).sort()).toEqual(["appVersion", "chart", "chartVersion", "name", "namespace", "revision", "status", "updated"]);
    rt.close(id);
  }, 60_000);

  it("closing a view revokes its token: its watches end", async () => {
    const id = rt.open({ handle, document: doc({ pods: { kind: "kube.list", resource: "pods", namespace: NS, labelSelector: `app=${NAME}` } }) });
    await wait(id, "pods", (x) => x.state === "ok");
    const before = audit.length;
    rt.close(id);
    await new Promise((r) => setTimeout(r, 1500));
    expect(audit.slice(before).filter((e) => e.label === "view · orbstack" && e.allowed)).toEqual([]);
  }, 30_000);
});
