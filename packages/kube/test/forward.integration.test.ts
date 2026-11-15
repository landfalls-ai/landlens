// Port-forward against the OrbStack cluster, through the front door with a forward token:
// LANDLENS_INTEGRATION=orbstack pnpm test:integration. Needs deploy/scenarios/workbench.yaml (shop-front) in
// landlens-dev; writes nothing.
import { execFile } from "node:child_process";
import { get } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClusterManager } from "../src/clusters.js";
import { bridge, listenLocal, type BridgeError, type Listener } from "../src/forward.js";
import { FrontDoor, type AuditEntry } from "../src/frontdoor.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
const kubectl = (...args: string[]) => exec("kubectl", ["--context", "orbstack", "-n", NS, ...args]);
const fetchText = (port: number) => new Promise<{ status: number; body: string }>((ok, fail) => {
  get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
  }).on("error", fail);
});

describe.runIf(run)("port-forward on OrbStack", () => {
  const audit: AuditEntry[] = [];
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";
  let pod = "";
  const servers: Listener[] = [];

  beforeAll(async () => {
    await kubectl("apply", "-f", resolve(__dirname, "../../../deploy/scenarios/workbench.yaml"));
    await kubectl("rollout", "status", "deploy/shop-front", "--timeout=90s");
    pod = (await kubectl("get", "pod", "-l", "app=shop-front", "-o", "jsonpath={.items[0].metadata.name}")).stdout.trim();
    door = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
  }, 120_000);

  afterAll(async () => {
    for (const s of servers) s.close();
    await clusters?.disconnectAll();
    await door?.stop();
  });

  const forward = async (token: string, port: number) => {
    const errors: BridgeError[] = [];
    const s = await listenLocal(0, (c) => void bridge({ url: door.clusterUrl(handle), certificate: door.certificate, token, namespace: NS, pod, port }, c, { error: (e) => errors.push(e) }));
    servers.push(s);
    return { port: s.port, errors };
  };

  it("serves the pod's port on 127.0.0.1, as you, for several connections at once", async () => {
    const label = "you · orbstack · forward test";
    const token = door.issueToken({ label, policy: { access: "forward", pod: { namespace: NS, name: pod }, port: 8080 }, clusters: [handle] });
    const f = await forward(token, 8080);
    const answers = await Promise.all([1, 2, 3].map(() => fetchText(f.port)));
    for (const a of answers) expect(a).toEqual({ status: 200, body: "<h1>shop-front</h1>\n" });
    expect(f.errors).toEqual([]);
    expect(audit.filter((e) => e.label === label && e.path.endsWith(`/pods/${pod}/portforward`)).length).toBeGreaterThanOrEqual(3);
    door.revokeToken(token);
  }, 30_000);

  it("says nothing listens on a port the pod doesn't serve", async () => {
    const token = door.issueToken({ label: "you · orbstack · forward test", policy: { access: "forward", pod: { namespace: NS, name: pod }, port: 9999 }, clusters: [handle] });
    const f = await forward(token, 9999);
    await fetchText(f.port).catch(() => undefined);
    await expect.poll(() => f.errors[0]?.message, { timeout: 10_000 }).toBe("Nothing is listening on port 9999 in the pod (connection refused).");
    door.revokeToken(token);
  }, 20_000);

  it("refuses another port with the forward token, and a revoked token", async () => {
    const token = door.issueToken({ label: "you · orbstack · forward test", policy: { access: "forward", pod: { namespace: NS, name: pod }, port: 8080 }, clusters: [handle] });
    // The token says 8080; this forward asks for 22.
    const wrong = await forward(token, 22);
    await fetchText(wrong.port).catch(() => undefined);
    await expect.poll(() => wrong.errors[0]?.status, { timeout: 10_000 }).toBe(403);
    door.revokeToken(token);
    const revoked = await forward(token, 8080);
    await fetchText(revoked.port).catch(() => undefined);
    await expect.poll(() => revoked.errors[0]?.status, { timeout: 10_000 }).toBe(401);
  }, 30_000);

  /** The status the front door answers an upgrade with: 101 when it upgrades. */
  const upgrade = (token: string, path: string, method: string, headers: Record<string, string>) => new Promise<number>((ok, fail) => {
    const u = new URL(door.clusterUrl(handle) + path);
    const req = httpsRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, ca: door.certificate, agent: false,
      headers: { Authorization: `Bearer ${token}`, Connection: "Upgrade", ...headers } });
    req.on("upgrade", (_res, socket) => (socket.destroy(), ok(101)));
    req.on("response", (res) => (res.resume(), ok(res.statusCode ?? 0)));
    req.on("error", fail);
    req.end();
  });

  it("opens only a v4.channel.k8s.io WebSocket for exactly its port: no SPDY, no tunnel, no extra keys (review finding 1)", async () => {
    const token = door.issueToken({ label: "you · orbstack · forward test", policy: { access: "forward", pod: { namespace: NS, name: pod }, port: 8080 }, clusters: [handle] });
    const path = `/api/v1/namespaces/${NS}/pods/${pod}/portforward`;
    const ws = { Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
    // The control: the WebSocket the bridge uses upgrades.
    expect(await upgrade(token, `${path}?ports=8080`, "GET", { ...ws, "Sec-WebSocket-Protocol": "v4.channel.k8s.io" })).toBe(101);
    // kubectl's SPDY dialer (POST, Upgrade: SPDY/3.1) chooses its ports inside the stream, not in the URL.
    expect(await upgrade(token, `${path}?ports=8080`, "POST", { Upgrade: "SPDY/3.1", "X-Stream-Protocol-Version": "portforward.k8s.io" })).toBe(403);
    // SPDY tunnelled through a WebSocket (kubectl 1.30+).
    expect(await upgrade(token, `${path}?ports=8080`, "GET", { ...ws, "Sec-WebSocket-Protocol": "SPDY/3.1+portforward.k8s.io" })).toBe(403);
    expect(await upgrade(token, `${path}?ports=8080`, "GET", { ...ws, "Sec-WebSocket-Protocol": "SPDY/3.1+portforward.k8s.io, v4.channel.k8s.io" })).toBe(403);
    // Another port in the query, under any key.
    for (const q of ["ports=8080&ports=22", "ports=8080&port=22", "ports=8080,22", "ports=22", "Ports=8080"]) {
      expect(await upgrade(token, `${path}?${q}`, "GET", { ...ws, "Sec-WebSocket-Protocol": "v4.channel.k8s.io" }), q).toBe(403);
    }
    door.revokeToken(token);
  }, 30_000);
});
