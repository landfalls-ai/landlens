// frontDoorFetch (wave 10, D209): a view's KubeClient reaches the cluster only through the front door, with its own
// token: the token's policy refuses, its redaction scrubs, its revocation closes a watch, and the token goes nowhere else.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KubeClient, KubeError } from "../src/client.js";
import { frontDoorFetch } from "../src/frontdoor-fetch.js";
import { FrontDoor, type AuditEntry } from "../src/frontdoor.js";
import { agentReadOnlyPolicy } from "../src/policy.js";
import { loopbackCert, SIDECAR_HEADER } from "../src/sidecar.js";
import { ResourceWatcher, type WatcherEvent } from "../src/watch.js";

const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const tls = await loopbackCert(SIDECAR);
const SECRET = "s".repeat(64);
const HANDLE = "clusterAAAA1";

let sidecar: Server;
let seen: IncomingMessage[];
let watches: ServerResponse[];
let door: FrontDoor;
let audit: AuditEntry[];

const pod = (name: string) => ({
  metadata: { name, namespace: "landlens-dev", uid: `u-${name}`, resourceVersion: "5" },
  spec: { containers: [{ name: "c", env: [{ name: "DB_PASSWORD", value: "hunter2" }] }] },
});

beforeEach(async () => {
  seen = [];
  watches = [];
  sidecar = createServer((req, res) => {
    seen.push(req);
    const u = new URL(req.url!, "http://x");
    if (u.searchParams.get("watch") === "1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(JSON.stringify({ type: "ADDED", object: pod("b") }) + "\n");
      watches.push(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "5" }, items: [pod("a")] }));
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

const viewClient = (token: string) => new KubeClient({ url: door.clusterUrl(HANDLE), secret: "" }, frontDoorFetch({ certificate: tls.ca, token }));

describe("frontDoorFetch", () => {
  it("reads through the front door with the token, scrubbed by its policy, audited under its label", async () => {
    const token = door.issueToken({ label: "view · orbstack", policy: agentReadOnlyPolicy(["landlens-dev"]), clusters: [HANDLE] });
    const list = await viewClient(token).json("/api/v1/namespaces/landlens-dev/pods");
    expect(list.items[0].metadata.name).toBe("a");
    expect(JSON.stringify(list)).not.toContain("hunter2");
    // The front door added the sidecar's secret; the caller's (empty) header and the token never reached the sidecar.
    expect(seen[0]!.headers[SIDECAR_HEADER.toLowerCase()]).toBe(SECRET);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({ label: "view · orbstack" });
  });

  it("is refused what the token's policy refuses: Secrets, writes, other namespaces", async () => {
    const token = door.issueToken({ label: "view · orbstack", policy: agentReadOnlyPolicy(["landlens-dev"]), clusters: [HANDLE] });
    const c = viewClient(token);
    for (const [path, method] of [["/api/v1/namespaces/landlens-dev/secrets", "GET"], ["/api/v1/namespaces/landlens-dev/pods/a", "DELETE"], ["/api/v1/namespaces/kube-system/pods", "GET"]] as const) {
      const err = await c.json(path, { method }).catch((e) => e);
      expect(err).toBeInstanceOf(KubeError);
      expect(err.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("streams a watch, and the watch ends when the token is revoked", async () => {
    const token = door.issueToken({ label: "view · orbstack", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    const events: WatcherEvent[] = [];
    const w = new ResourceWatcher(viewClient(token), { group: "", version: "v1", resource: "pods", namespace: "landlens-dev" }, (e) => events.push(e), { batchMs: 10, backoffMs: 5000 }).start();
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(f()).toBe(true);
    };
    await until(() => w.snapshot().length === 2);
    expect(JSON.stringify(w.snapshot())).not.toContain("hunter2");
    door.revokeToken(token);
    await until(() => events.some((e) => e.type === "error"));
    await w.stop();
  });

  it("aborts a streaming answer when asked", async () => {
    const token = door.issueToken({ label: "view · orbstack", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    const ac = new AbortController();
    const res = await frontDoorFetch({ certificate: tls.ca, token })(`${door.clusterUrl(HANDLE)}/api/v1/pods?watch=1`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ac.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it("sends the token nowhere but the front door", async () => {
    const f = frontDoorFetch({ certificate: tls.ca, token: "t".repeat(64) });
    for (const url of [
      `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}/c/${HANDLE}/api/v1/pods`,
      `https://example.com/c/${HANDLE}/api/v1/pods`,
      `https://127.0.0.1.example.com:443/c/${HANDLE}/api`,
      `${door.url}/api/v1/pods`,
    ]) {
      await expect(f(url)).rejects.toThrow(/only reaches the front door/);
    }
    expect(seen).toHaveLength(0);
  });

  it("trusts only the front door's certificate", async () => {
    const other = await loopbackCert(SIDECAR);
    const token = door.issueToken({ label: "view · orbstack", policy: agentReadOnlyPolicy(), clusters: [HANDLE] });
    const c = new KubeClient({ url: door.clusterUrl(HANDLE), secret: "" }, frontDoorFetch({ certificate: other.ca, token }));
    await expect(c.json("/api/v1/pods")).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});
