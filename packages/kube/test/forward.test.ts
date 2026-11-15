import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { KubeObject } from "@landlens/contracts";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { bridge, forwardPath, upgradeRefusal, isPortFree, kubeletError, listenLocal, pickPod, podPort, servicePort, suggestPort, type BridgeError } from "../src/forward.js";

const pod = (name: string, o: { ready?: boolean; created?: string; ports?: { name?: string; containerPort: number }[]; deleting?: boolean } = {}): KubeObject => ({
  apiVersion: "v1", kind: "Pod",
  metadata: { name, namespace: "shop", uid: name, creationTimestamp: o.created ?? "2026-11-15T00:00:00Z", ...(o.deleting ? { deletionTimestamp: "2026-11-15T01:00:00Z" } : {}) },
  spec: { containers: [{ name: "app", ports: o.ports ?? [] }] },
  status: { phase: "Running", conditions: [{ type: "Ready", status: o.ready === false ? "False" : "True" }] },
} as KubeObject);

/** A stand-in for the kubelet's side: the port prefix on both channels, then an echo in capitals, or an error. */
async function fakeKubelet(mode: "echo" | "refused" | "status403" | "chatty", body403 = JSON.stringify({ message: "pods is forbidden x" })) {
  const http = createServer((_req, res) => (res.writeHead(403, { "content-type": "application/json" }), res.end(JSON.stringify({ message: "pods \"web-1\" is forbidden" }))));
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("v4.channel.k8s.io") ? "v4.channel.k8s.io" : false) });
  const seen: { url?: string; auth?: string } = {};
  http.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {}); // the bridge drops a body it won't read
    seen.url = req.url;
    seen.auth = req.headers.authorization;
    if (mode === "status403") {
      return socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body403)}\r\n\r\n${body403}`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(Buffer.from([0, 0x90, 0x1f]));
      ws.send(Buffer.from([1, 0x90, 0x1f]));
      if (mode === "chatty") {
        // Error text without end: only the first 4000 characters are kept.
        for (let i = 0; i < 200; i++) ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(2000, "e")]));
        return ws.close();
      }
      if (mode === "refused") {
        ws.send(Buffer.concat([Buffer.from([1]), Buffer.from("an error occurred forwarding 8080 -> 8080: error forwarding port 8080 to pod abc: connect: connection refused")]));
        return ws.close();
      }
      ws.on("message", (m: Buffer) => {
        const body = m.subarray(1).toString();
        if (body === "bye") return ws.close();
        ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(body.toUpperCase())]));
      });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/c/h`, seen, close: () => new Promise((r) => (wss.close(), http.close(r))) };
}

const servers: { close(): unknown }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function forwardTo(url: string) {
  const errors: BridgeError[] = [];
  const server = await listenLocal(0, (s) => void bridge({ url, certificate: "", token: "t0k", namespace: "shop", pod: "web-1", port: 8080 }, s, { error: (e) => errors.push(e) }));
  servers.push(server);
  return { port: server.port, errors };
}
const connect = (port: number) => new Promise<Socket>((r) => {
  const c = createConnection({ port, host: "127.0.0.1" }, () => r(c));
});
const say = (host: string, port: number) => new Promise<string>((r, fail) => {
  let t = "";
  const c = createConnection({ port, host }, () => {});
  c.on("data", (d) => (t += d)).on("close", () => r(t)).on("error", fail);
});
const read = (c: Socket) => new Promise<string>((r) => {
  let t = "";
  c.on("data", (d) => (t += d));
  c.on("close", () => r(t));
});

describe("port-forward", () => {
  it("asks for one port of one pod", () => {
    expect(forwardPath({ namespace: "shop", pod: "web-1", port: 8080 })).toBe("/api/v1/namespaces/shop/pods/web-1/portforward?ports=8080");
  });

  it("carries bytes both ways, without the port prefix, with the token, and ends when the pod's side does", async () => {
    const k = await fakeKubelet("echo");
    servers.push(k);
    const f = await forwardTo(k.url);
    const c = await connect(f.port);
    const got = read(c);
    c.write("hello");
    await new Promise((r) => setTimeout(r, 100));
    c.write("bye");
    expect(await got).toBe("HELLO");
    expect(k.seen).toEqual({ url: "/c/h/api/v1/namespaces/shop/pods/web-1/portforward?ports=8080", auth: "Bearer t0k" });
    expect(f.errors).toEqual([]);
  });

  it("says nothing is listening when the kubelet's connection is refused, and closes", async () => {
    const k = await fakeKubelet("refused");
    servers.push(k);
    const f = await forwardTo(k.url);
    const c = await connect(f.port);
    expect(await read(c)).toBe("");
    expect(f.errors).toEqual([{ message: "Nothing is listening on port 8080 in the pod (connection refused)." }]);
  });

  it("reports a refused upgrade with its status", async () => {
    const k = await fakeKubelet("status403");
    servers.push(k);
    const f = await forwardTo(k.url);
    const c = await connect(f.port);
    await read(c);
    expect(f.errors).toEqual([{ message: "pods is forbidden x", status: 403 }]);
  });

  it("reads a refused upgrade's message only when it is text, and closes the local side before reporting it", async () => {
    // A hostile cluster's answer: a message that is not a string used to throw in main and leave the socket open.
    const k = await fakeKubelet("status403", JSON.stringify({ message: { not: "a string" } }));
    servers.push(k);
    const errors: BridgeError[] = [];
    const server = await listenLocal(0, (s) => void bridge({ url: k.url, certificate: "", token: "t", namespace: "shop", pod: "web-1", port: 8080 }, s, {
      error: (e) => {
        errors.push(e);
        throw new Error("a careless handler");
      },
    }));
    servers.push(server);
    const c = await connect(server.port);
    await read(c);
    expect(c.destroyed || c.readableEnded).toBe(true);
    expect(errors).toEqual([{ message: "HTTP 403", status: 403 }]);
    expect(upgradeRefusal(JSON.stringify({ message: "no\u001b[31m way" }), 403)).toBe("no[31m way");
    expect(upgradeRefusal("x".repeat(5000), 500)).toBe("HTTP 500");
    expect(upgradeRefusal(JSON.stringify({ message: "m".repeat(400) }), 403)).toHaveLength(301);
  });

  it("keeps at most 4000 characters of the kubelet's error text, and of a refused body", async () => {
    const k = await fakeKubelet("chatty");
    servers.push(k);
    const f = await forwardTo(k.url);
    await read(await connect(f.port));
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]!.message.length).toBeLessThanOrEqual(301);

    const big = await fakeKubelet("status403", JSON.stringify({ message: "m", pad: "p".repeat(1024 * 1024) }));
    servers.push(big);
    const g = await forwardTo(big.url);
    await read(await connect(g.port));
    expect(g.errors).toEqual([{ message: "HTTP 403", status: 403 }]);
  });

  it("listens on 127.0.0.1 and [::1] only, and refuses a port that is taken on any address", async () => {
    const s = await listenLocal(0, (c) => c.end("landlens"));
    servers.push(s);
    // Both loopbacks answer; nothing listens on the wildcard.
    for (const host of ["127.0.0.1", "::1"]) expect(await say(host, s.port)).toBe("landlens");
    await expect(listenLocal(s.port, () => {})).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await isPortFree(s.port)).toBe(false);
    // Another program on the wildcard, or on [::1] alone, makes the port taken.
    for (const host of ["0.0.0.0", "::", "::1"]) {
      const other = createNetServer().listen(0, host);
      await new Promise((r) => other.once("listening", r));
      const port = (other.address() as AddressInfo).port;
      expect(await isPortFree(port), host).toBe(false);
      await expect(listenLocal(port, () => {})).rejects.toMatchObject({ code: "EADDRINUSE" });
      await new Promise((r) => other.close(r));
    }
  });

  it("offers the same port above 1023, the 8000s for a low one, then the next free", async () => {
    const taken = new Set([8080, 3000]);
    const free = async (p: number) => !taken.has(p);
    expect(await suggestPort(5432, free)).toBe(5432);
    expect(await suggestPort(80, free)).toBe(8081);
    expect(await suggestPort(443, free)).toBe(8443);
    expect(await suggestPort(3000, free)).toBe(3001);
    expect(await suggestPort(3000, async () => false, async () => 54321)).toBe(54321);
  });

  it("finds a Service's target, and the oldest ready pod with that port", () => {
    const svc = { metadata: { name: "web" }, spec: { ports: [{ port: 80, targetPort: "http", name: "web" }, { port: 81 }, { port: 53, protocol: "UDP" }] } } as KubeObject;
    expect(servicePort(svc, 80)).toEqual({ target: "http", name: "web" });
    expect(servicePort(svc, 81)).toEqual({ target: 81 });
    expect(servicePort(svc, 53)).toBeUndefined();
    const pods = [
      pod("new", { created: "2026-11-15T02:00:00Z", ports: [{ name: "http", containerPort: 8080 }] }),
      pod("old-unready", { created: "2026-11-15T00:00:00Z", ready: false, ports: [{ name: "http", containerPort: 8080 }] }),
      pod("old-leaving", { created: "2026-11-15T00:00:00Z", deleting: true, ports: [{ name: "http", containerPort: 8080 }] }),
      pod("mid-no-port", { created: "2026-11-15T01:00:00Z" }),
    ];
    expect(pickPod(pods, "http")).toMatchObject({ pod: { metadata: { name: "new" } }, port: 8080 });
    expect(pickPod(pods, 9000)).toMatchObject({ pod: { metadata: { name: "mid-no-port" } }, port: 9000 });
    expect(pickPod(pods.slice(1, 3), 9000)).toBeUndefined();
    expect(podPort(pods[0]!, "8080")).toBe(8080);
    expect(podPort(pods[0]!, "grpc")).toBeUndefined();
  });

  it("puts the kubelet's errors in a person's words, without controls", () => {
    expect(kubeletError("an error occurred forwarding 9999 -> 9999: x: connect: connection refused")).toBe("Nothing is listening on port 9999 in the pod (connection refused).");
    expect(kubeletError("odd\x1b[31m failure")).toBe("odd[31m failure");
    expect(kubeletError("x".repeat(400))).toHaveLength(301);
  });
});
