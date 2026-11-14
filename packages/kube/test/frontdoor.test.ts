import { createServer, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { connect } from "node:tls";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrontDoor, type AuditEntry } from "../src/frontdoor.js";
import { agentReadOnlyPolicy } from "../src/policy.js";
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
