import { createServer, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { connect } from "node:tls";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrontDoor, NODE_WRITES_OFF, nodeWrite, type AuditEntry } from "../src/frontdoor.js";
import { agentApprovedPolicy, agentReadOnlyPolicy } from "../src/policy.js";
import { ChangeBroker, type Send } from "../src/changes.js";
import { loopbackCert } from "../src/sidecar.js";

const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const tls = await loopbackCert(SIDECAR);

/** A fake sidecar that records what reached it. */
let sidecar: Server;
let seen: IncomingMessage[];
let door: FrontDoor;
let audit: AuditEntry[];
const SECRET = "s".repeat(64);
const HANDLE = "clusterAAAA1";

beforeEach(async () => {
  seen = [];
  sidecar = createServer((req, res) => {
    seen.push(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ kind: "PodList", path: req.url }));
  });
  await new Promise<void>((r) => sidecar.listen(0, "127.0.0.1", r));
  audit = [];
  door = new FrontDoor(tls, (e) => audit.push(e));
  await door.start();
  door.addCluster(HANDLE, { url: `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`, secret: SECRET });
});

afterEach(async () => {
  await door.stop();
  sidecar.closeAllConnections();
  await new Promise((r) => sidecar.close(r));
});

/** HTTPS to the front door, trusting only its certificate. */
const call = (path: string, token?: string, method = "GET", extra: Record<string, string> = {}) =>
  new Promise<{ status: number; json: () => Promise<any> }>((ok, fail) => {
    const req = httpsRequest(door.url + path, { method, ca: tls.ca, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode!, json: async () => JSON.parse(body) }));
    });
    req.on("error", fail);
    req.end();
  });

describe("FrontDoor", () => {
  it("refuses requests without a token it issued", async () => {
    for (const t of [undefined, "f".repeat(64), "not-hex"]) {
      const res = await call(`/c/${HANDLE}/api/v1/pods`, t);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ kind: "Status", reason: "Unauthorized" });
    }
    expect(seen).toHaveLength(0);
  });

  it("forwards allowed requests with the sidecar secret and without the caller's token", async () => {
    const token = door.issueToken({ label: "agent 1", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    const res = await call(`/c/${HANDLE}/api/v1/namespaces/a/pods?limit=1`, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: "/api/v1/namespaces/a/pods?limit=1" });
    expect(seen[0]!.headers["x-landlens-sidecar"]).toBe(SECRET);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({ label: "agent 1", allowed: true, status: 200, path: "/api/v1/namespaces/a/pods" });
  });

  it("files a request under the MCP call that made it, and doesn't forward the call header", async () => {
    const token = door.issueToken({ label: "agent 1", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    await call(`/c/${HANDLE}/api/v1/pods`, token, "GET", { "X-Landlens-Call": "cmh2k9x1" });
    expect(audit.at(-1)).toMatchObject({ allowed: true, call: "cmh2k9x1" });
    expect(seen[0]!.headers["x-landlens-call"]).toBeUndefined();
    await call(`/c/${HANDLE}/api/v1/pods`, token, "GET", { "X-Landlens-Call": "not a call; DROP" });
    expect(audit.at(-1)!.call).toBeUndefined();
  });

  it("enforces the token's policy before anything reaches the cluster", async () => {
    const token = door.issueToken({ label: "agent 1", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    const del = await call(`/c/${HANDLE}/api/v1/namespaces/a/pods/p1`, token, "DELETE");
    expect(del.status).toBe(403);
    expect((await del.json()).message).toContain("read-only token");
    expect((await call(`/c/${HANDLE}/api/v1/namespaces/a/secrets`, token)).status).toBe(403);
    expect((await call(`/c/${HANDLE}//api/v1/secrets`, token)).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(audit.filter((a) => !a.allowed)).toHaveLength(3);
  });

  it("keeps each token to its clusters, and revocation is immediate", async () => {
    const token = door.issueToken({ label: "agent 2", policy: { access: "full" }, clusters: ["otherCluster1"] });
    expect((await call(`/c/${HANDLE}/api/v1/pods`, token)).status).toBe(403);
    const ide = door.issueToken({ label: "ide", policy: { access: "full" }, clusters: [HANDLE] });
    expect((await call(`/c/${HANDLE}/api/v1/namespaces/a/pods/p1`, ide, "DELETE")).status).toBe(200);
    door.revokeToken(ide);
    expect((await call(`/c/${HANDLE}/api/v1/pods`, ide)).status).toBe(401);
  });

  it("refuses impersonation for every token", async () => {
    const ide = door.issueToken({ label: "ide", policy: { access: "full" }, clusters: [HANDLE] });
    const status = await new Promise<number>((ok, fail) => {
      const req = httpsRequest(door.url + `/c/${HANDLE}/api/v1/pods`, {
        ca: tls.ca,
        headers: { Authorization: `Bearer ${ide}`, "Impersonate-User": "system:admin", "Impersonate-Group": "system:masters" },
      }, (res) => {
        res.resume();
        ok(res.statusCode!);
      });
      req.on("error", fail);
      req.end();
    });
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ allowed: false, reason: expect.stringContaining("impersonation") });
  });

  it("audits an upgrade with the cluster's answer", async () => {
    sidecar.on("upgrade", (req, socket) => {
      seen.push(req);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.end();
    });
    const ide = door.issueToken({ label: "ide", policy: { access: "full" }, clusters: [HANDLE] });
    const res = await new Promise<string>((resolve) => {
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.ca }, () => {
        s.write(`GET /c/${HANDLE}/api/v1/namespaces/a/pods/p1/exec?command=sh HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${ide}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
    });
    expect(res).toMatch(/^HTTP\/1.1 101/);
    expect(seen[0]!.headers["x-landlens-sidecar"]).toBe(SECRET);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({ label: "ide", allowed: true, status: 101 });
  });

  it("closes a token's open upgrades and streams when it is revoked", async () => {
    // The cluster holds both open: an exec that never ends, and a watch that sends one event and waits.
    const upgraded: { destroy(): void }[] = [];
    sidecar.on("upgrade", (_req, socket) => {
      upgraded.push(socket);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    sidecar.removeAllListeners("request");
    sidecar.on("request", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"type":"ADDED"}\n');
    });
    const token = door.issueToken({ label: "you · terminal", policy: { access: "full" }, clusters: [HANDLE] });
    const other = door.issueToken({ label: "ide", policy: { access: "full" }, clusters: [HANDLE] });
    // Each resolves to { closed } once open (a bare promise would be adopted, waiting for the close).
    const opened = (t: string) => new Promise<{ closed: Promise<void> }>((ok) => {
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.ca }, () => {
        s.write(`GET /c/${HANDLE}/api/v1/namespaces/a/pods/p1/exec?command=sh HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${t}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      const closed = new Promise<void>((done) => s.on("close", () => done()));
      s.once("data", () => ok({ closed }));
    });
    const watch = new Promise<{ closed: Promise<void> }>((ok, fail) => {
      const req = httpsRequest(door.url + `/c/${HANDLE}/api/v1/pods?watch=true`, { ca: tls.ca, agent: false, headers: { Authorization: `Bearer ${token}` } }, (res) => {
        const closed = new Promise<void>((done) => res.on("close", () => done()).on("error", () => done()));
        res.once("data", () => ok({ closed }));
      });
      req.on("error", fail);
      req.end();
    });
    const exec = await opened(token);
    const stream = await watch;
    const kept = await opened(other);
    let keptClosed = false;
    void kept.closed.then(() => (keptClosed = true));
    door.revokeToken(token);
    await exec.closed;
    await stream.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(keptClosed).toBe(false);
    door.revokeToken(other);
    await kept.closed;
    for (const u of upgraded) u.destroy();
  });

  it("refuses an upgrade (exec) for a read-only token", async () => {
    const token = door.issueToken({ label: "agent 1", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    const res = await new Promise<string>((resolve) => {
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.ca }, () => {
        s.write(`GET /c/${HANDLE}/api/v1/namespaces/a/pods/p1/exec?command=sh HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
    });
    expect(res).toMatch(/^HTTP\/1.1 403/);
    expect(seen).toHaveLength(0);
  });

  it("lets a forward token open only the v4.channel.k8s.io WebSocket, not SPDY or SPDY over a WebSocket", async () => {
    sidecar.on("upgrade", (req, socket) => {
      seen.push(req);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.end();
    });
    const token = door.issueToken({ label: "you · fwd", policy: { access: "forward", pod: { namespace: "a", name: "p1" }, port: 8080 }, clusters: [HANDLE] });
    const send = (method: string, headers: string) => new Promise<string>((resolve) => {
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.ca }, () => {
        s.write(`${method} /c/${HANDLE}/api/v1/namespaces/a/pods/p1/portforward?ports=8080 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\n${headers}\r\n`);
      });
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
    });
    expect(await send("POST", "Upgrade: SPDY/3.1\r\nX-Stream-Protocol-Version: portforward.k8s.io\r\n")).toMatch(/^HTTP\/1.1 403/);
    expect(await send("GET", "Upgrade: websocket\r\nSec-WebSocket-Protocol: SPDY/3.1+portforward.k8s.io\r\n")).toMatch(/^HTTP\/1.1 403/);
    expect(await send("GET", "Upgrade: websocket\r\nSec-WebSocket-Protocol: v4.channel.k8s.io, SPDY/3.1+portforward.k8s.io\r\n")).toMatch(/^HTTP\/1.1 403/);
    expect(seen).toHaveLength(0);
    expect(await send("GET", "Upgrade: websocket\r\nSec-WebSocket-Protocol: v4.channel.k8s.io\r\n")).toMatch(/^HTTP\/1.1 101/);
    expect(seen).toHaveLength(1);
    // Not as a plain request either.
    const plain = await call(`/c/${HANDLE}/api/v1/namespaces/a/pods/p1/portforward?ports=8080`, token);
    expect(plain.status).toBe(403);
  });
});

describe("FrontDoor: an object token (wave 8 part 4, D162)", () => {
  const SECRET_PATH = "/api/v1/namespaces/landlens-dev/secrets/hands-secret";
  const MARK = "LLMARK-frontdoor-object-token-test-0000";
  const policy = { access: "object" as const, object: { group: "", resource: "secrets", namespace: "landlens-dev", name: "hands-secret" } };

  it("lets one GET of its object through, unscrubbed, and is unknown after it", async () => {
    sidecar.removeAllListeners("request");
    sidecar.on("request", (req, res) => {
      seen.push(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ kind: "Secret", metadata: { name: "hands-secret", namespace: "landlens-dev", uid: "u1" }, data: { password: Buffer.from(MARK).toString("base64") } }));
    });
    const token = door.issueToken({ label: "you · orbstack · secret landlens-dev/hands-secret", policy, clusters: [HANDLE] });
    const first = await call(`/c/${HANDLE}${SECRET_PATH}`, token);
    expect(first.status).toBe(200);
    expect(Buffer.from((await first.json()).data.password, "base64").toString()).toBe(MARK);
    const second = await call(`/c/${HANDLE}${SECRET_PATH}`, token);
    expect(second.status).toBe(401);
    expect(seen).toHaveLength(1);
    // The audit names the Secret and its policy, and holds nothing of its body.
    const mine = audit.filter((e) => e.label.includes("hands-secret"));
    expect(mine[0]).toMatchObject({ method: "GET", path: SECRET_PATH, allowed: true, status: 200, access: "object" });
    expect(JSON.stringify(audit)).not.toContain(MARK);
    expect(JSON.stringify(audit)).not.toContain(Buffer.from(MARK).toString("base64"));
  });

  it("refuses another object, a list, a watch and a write, and these don't use it up", async () => {
    const token = door.issueToken({ label: "you · secret", policy, clusters: [HANDLE] });
    for (const [m, p] of [["GET", "/api/v1/namespaces/landlens-dev/secrets/other"], ["GET", "/api/v1/namespaces/landlens-dev/secrets"], ["GET", `${SECRET_PATH}?watch=1`], ["DELETE", SECRET_PATH], ["GET", "/version"]] as const) {
      expect((await call(`/c/${HANDLE}${p}`, token, m)).status, `${m} ${p}`).toBe(403);
    }
    expect(seen).toHaveLength(0);
    expect((await call(`/c/${HANDLE}${SECRET_PATH}`, token)).status).toBe(200);
  });

  it("opens no upgraded connection", async () => {
    const token = door.issueToken({ label: "you · secret", policy, clusters: [HANDLE] });
    const res = await new Promise<string>((resolve) => {
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.ca }, () => {
        s.write(`GET /c/${HANDLE}${SECRET_PATH} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
    });
    expect(res).toMatch(/^HTTP\/1.1 403/);
    expect(seen).toHaveLength(0);
  });
});

describe("FrontDoor scrubbing for agent tokens", () => {
  /** What the fake cluster answers next: content type, body (string or chunks), extra headers. */
  let answer: { type: string; body: string | string[]; headers?: Record<string, string> };
  let s: Server;
  let d: FrontDoor;
  const H = "clusterBBBB2";
  const pod = (name: string) => ({
    metadata: {
      name,
      annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"env":[{"name":"DB","value":"hunter2hunter2"}]}' },
      managedFields: [{ manager: "kubectl" }],
    },
    spec: { containers: [{ name: "app", env: [{ name: "DATABASE_URL", value: "postgres://app:hunter2@db/app" }] }] },
  });

  beforeEach(async () => {
    seen = [];
    s = createServer((req, res) => {
      seen.push(req);
      res.writeHead(200, { "Content-Type": answer.type, ...answer.headers });
      for (const c of [answer.body].flat()) res.write(c);
      res.end();
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    d = new FrontDoor(tls);
    await d.start();
    d.addCluster(H, { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, secret: SECRET });
  });

  afterEach(async () => {
    await d.stop();
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  });

  const get = (path: string, token: string, accept = "application/vnd.kubernetes.protobuf,application/json") =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = httpsRequest(d.url + `/c/${H}` + path, { ca: tls.ca, headers: { Authorization: `Bearer ${token}`, Accept: accept, "Accept-Encoding": "gzip" } }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (x) => (body += x)).on("end", () => ok({ status: res.statusCode!, body }));
      });
      req.on("error", fail);
      req.end();
    });
  const agent = () => d.issueToken({ label: "agent", policy: agentReadOnlyPolicy(), clusters: [H] });

  it("scrubs a list the way the MCP tools do, and asks the cluster for uncompressed JSON", async () => {
    answer = { type: "application/json", body: JSON.stringify({ kind: "PodList", items: [pod("a"), pod("b")] }) };
    const r = await get("/api/v1/namespaces/x/pods", agent());
    expect(r.status).toBe(200);
    expect(r.body).not.toContain("hunter2");
    const list = JSON.parse(r.body);
    expect(list.items[1].spec.containers[0].env[0]).toEqual({ name: "DATABASE_URL", value: "<redacted>" });
    expect(list.items[0].metadata.managedFields).toBeUndefined();
    expect(seen[0]!.headers.accept).toBe("application/json");
    expect(seen[0]!.headers["accept-encoding"]).toBeUndefined();
  });

  it("scrubs watch events one by one", async () => {
    const ev = (n: string) => JSON.stringify({ type: "ADDED", object: pod(n) }) + "\n";
    const two = ev("a") + ev("b");
    answer = { type: "application/json;stream=watch", body: [two.slice(0, 40), two.slice(40)] };
    const r = await get("/api/v1/namespaces/x/pods?watch=true", agent());
    const lines = r.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.object.metadata.name)).toEqual(["a", "b"]);
    expect(r.body).not.toContain("hunter2");
  });

  it("scrubs logs as text", async () => {
    answer = { type: "text/plain", body: "connecting to postgres://app:hunter2@db/app\npassword=hunter2hunter2\n" };
    const r = await get("/api/v1/namespaces/x/pods/a/log", agent(), "*/*");
    expect(r.body).toContain("connecting to postgres://app:<redacted>@db/app");
    expect(r.body).not.toContain("hunter2");
  });

  it("refuses what it can't read rather than pass it through", async () => {
    answer = { type: "application/vnd.kubernetes.protobuf", body: "k8s\0hunter2" };
    let r = await get("/api/v1/namespaces/x/pods", agent());
    expect(r.status).toBe(502);
    expect(r.body).not.toContain("hunter2");
    answer = { type: "application/json", body: "{}", headers: { "Content-Encoding": "gzip" } };
    r = await get("/api/v1/namespaces/x/pods", agent());
    expect(r.status).toBe(502);
  });

  it("leaves the IDE's own token alone", async () => {
    answer = { type: "application/json", body: JSON.stringify(pod("a")) };
    const ide = d.issueToken({ label: "ide", policy: { access: "full" }, clusters: [H] });
    const r = await get("/api/v1/namespaces/x/pods/a", ide);
    expect(r.body).toContain("hunter2");
  });
});

// D153 in the front door (security review of wave 8 part 2, M5, L8): a development build sends no node write and no
// eviction, dry run or not, through any token (your actions, the YAML editor, the agent's broker and its dry runs,
// kube-mcp, kubectl in a terminal), unless the rule names the cluster by context and API server.
describe("FrontDoor: node writes (D153)", () => {
  let s: Server;
  let reached: string[];
  let d: FrontDoor;
  const H = "clusterNNNN1";
  const SERVER = "https://127.0.0.1:26443";
  async function open(opts: ConstructorParameters<typeof FrontDoor>[2], upstream: { context?: string; server?: string } = { context: "kind-x", server: SERVER }) {
    reached = [];
    s = createServer((req, res) => {
      reached.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.method === "GET" && req.url === "/api/v1/nodes/node-1"
        ? JSON.stringify({ apiVersion: "v1", kind: "Node", metadata: { name: "node-1", uid: "n1", resourceVersion: "5" }, spec: {} })
        : "{}");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    d = new FrontDoor(tls, () => {}, opts);
    await d.start();
    d.addCluster(H, { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, secret: SECRET, ...upstream });
  }
  afterEach(async () => {
    await d?.stop();
    s?.closeAllConnections();
    await new Promise((r) => s?.close(r));
  });
  const send = (method: string, path: string, token: string) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      // A fresh connection each: the door answers a refusal without reading the body.
      const req = httpsRequest(d.url + `/c/${H}` + path, { method, agent: false, ca: tls.ca, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (x) => (body += x)).on("end", () => ok({ status: res.statusCode!, body }));
      });
      req.on("error", fail);
      req.end(method === "GET" || method === "DELETE" ? undefined : "{}");
    });
  const WRITES: [string, string][] = [
    ["PATCH", "/api/v1/nodes/node-1"], ["PATCH", "/api/v1/nodes/node-1?dryRun=All"], ["PUT", "/api/v1/nodes/node-1"],
    ["PATCH", "/api/v1/nodes/node-1/status"], ["DELETE", "/api/v1/nodes/node-1"], ["DELETE", "/api/v1/nodes"], ["POST", "/api/v1/nodes"],
    ["POST", "/api/v1/nodes/node-1/proxy/x"],
    ["POST", "/api/v1/namespaces/a/pods/b/eviction"], ["POST", "/api/v1/namespaces/a/pods/b/eviction?dryRun=All"],
  ];

  it("with no rule: refused for every token, full access and the agent's approved one included; nothing is proxied; reads pass", async () => {
    await open({});
    for (const policy of [{ access: "full" as const }, agentApprovedPolicy()]) {
      const t = d.issueToken({ label: "you", policy, clusters: [H] });
      for (const [m, p] of WRITES) {
        const r = await send(m, p, t);
        expect([m, p, r.status]).toEqual([m, p, 403]);
        expect(JSON.parse(r.body).message).toBe(`Landlens: ${NODE_WRITES_OFF}`);
      }
    }
    expect(reached).toEqual([]);
    const ide = d.issueToken({ label: "ide", policy: { access: "full" }, clusters: [H] });
    const g = await send("GET", "/api/v1/nodes/node-1", ide); expect(g.status).toBe(200);
    // Not a node write: another kind named "nodes", a config map named "eviction".
    expect((await send("PATCH", "/apis/apps/v1/namespaces/a/deployments/nodes", ide)).status).toBe(200);
    expect((await send("DELETE", "/api/v1/namespaces/a/configmaps/eviction-notes", ide)).status).toBe(200);
    expect(reached).toEqual(["GET /api/v1/nodes/node-1", "PATCH /apis/apps/v1/namespaces/a/deployments/nodes", "DELETE /api/v1/namespaces/a/configmaps/eviction-notes"]);
  });

  it("with a rule: only the cluster it names by context and server; a cluster opened without them gets none", async () => {
    const seenBy: { context: string; server: string }[] = [];
    const rule = (c: { context: string; server: string }) => (seenBy.push(c), c.context === "kind-x" && c.server === SERVER);
    await open({ nodeWrites: rule });
    const t = d.issueToken({ label: "you", policy: { access: "full" }, clusters: [H] });
    expect((await send("PATCH", "/api/v1/nodes/node-1", t)).status).toBe(200);
    expect(seenBy).toEqual([{ context: "kind-x", server: SERVER }]);
    await d.stop();
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    await open({ nodeWrites: rule }, { context: "kind-x", server: "https://10.0.0.9:6443" });
    const t2 = d.issueToken({ label: "you", policy: { access: "full" }, clusters: [H] });
    expect((await send("PATCH", "/api/v1/nodes/node-1", t2)).status).toBe(403);
    await d.stop();
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    await open({ nodeWrites: () => true }, {});
    const t3 = d.issueToken({ label: "you", policy: { access: "full" }, clusters: [H] });
    expect((await send("POST", "/api/v1/namespaces/a/pods/b/eviction", t3)).status).toBe(403);
    expect(reached).toEqual([]);
  });

  it("the agent's change broker: a nodes patch is refused at its dry run, before you are asked; nothing reaches the node", async () => {
    await open({});
    const token = d.issueToken({ label: "agent approved", policy: agentApprovedPolicy(), clusters: [H] });
    const send: Send = (r) => new Promise((ok, fail) => {
      const req = httpsRequest(d.url + `/c/${H}` + r.path, {
        method: r.method, agent: false, ca: tls.ca,
        headers: { Authorization: `Bearer ${token}`, ...(r.contentType ? { "Content-Type": r.contentType } : {}), ...(r.body !== undefined ? { "Content-Length": String(Buffer.byteLength(r.body)) } : {}) },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (x) => (text += x)).on("end", () => ok({ status: res.statusCode!, text, warnings: [] }));
      });
      req.on("error", fail);
      req.end(r.body);
    });
    let asked = 0;
    const broker = new ChangeBroker({ session: "s1", send, ask: async () => (asked++, { decision: "approve" }), update: () => {} });
    const out = await broker.propose({
      tool: "patch", title: "Cordon node-1", reason: "asked to",
      operations: [{ verb: "patch", patchType: "merge", type: { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false }, name: "node-1", body: { spec: { unschedulable: true } } }],
    });
    expect(out).toMatchObject({ state: "failed", stage: "dry-run" });
    expect(asked).toBe(0);
    expect(reached.filter((x) => !x.startsWith("GET "))).toEqual([]);
  });

  it("nodeWrite: every write and eviction, however spelled; reads are not", () => {
    for (const [m, p] of WRITES) expect([m, p, nodeWrite({ method: m, path: p })]).toEqual([m, p, true]);
    expect(nodeWrite({ method: "patch", path: "//api/v1//nodes/x" })).toBe(true);
    for (const [m, p] of [["GET", "/api/v1/nodes/n"], ["HEAD", "/api/v1/nodes"], ["GET", "/api/v1/watch/nodes"], ["POST", "/api/v1/namespaces/a/pods"]]) {
      expect([m, p, nodeWrite({ method: m!, path: p! })]).toEqual([m, p, false]);
    }
  });
});
