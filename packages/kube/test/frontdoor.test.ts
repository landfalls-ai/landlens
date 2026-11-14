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
const call = (path: string, token?: string, method = "GET") =>
  new Promise<{ status: number; json: () => Promise<any> }>((ok, fail) => {
    const req = httpsRequest(door.url + path, { method, ca: tls.cert, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
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
        ca: tls.cert,
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
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.cert }, () => {
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
      const s = connect({ port: Number(new URL(door.url).port), host: "127.0.0.1", ca: tls.cert }, () => {
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
