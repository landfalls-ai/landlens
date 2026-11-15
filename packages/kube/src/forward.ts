// Port-forward (wave 4, part 3): a port on 127.0.0.1 that reaches a pod's port, through the front door, as you.
// No kubectl: each local connection opens the Kubernetes port-forward API over its own WebSocket, with a token that
// may forward only that pod's one port (policy "forward").
//
// The protocol (v4.channel.k8s.io): every binary message starts with a channel byte. For one port, channel 0 carries
// the data and channel 1 the kubelet's errors; the first two bytes on each channel are the port (little-endian),
// written once by the server. The client writes plain data on channel 0. A WebSocket can't half-close, so the
// connection ends when either side closes.
import { createServer, type Server, type Socket } from "node:net";
import WebSocket from "ws";
import type { KubeObject } from "@landlens/contracts";

export const FORWARD_PROTOCOL = "v4.channel.k8s.io";
/** The address every forward listens on: only this Mac can reach it. */
export const LOOPBACK = "127.0.0.1";
/** What the window may ask for: not the ports below 1024 (root's on macOS anyway). */
export const MIN_LOCAL_PORT = 1024;
/** Past this many bytes queued for the pod, stop reading the local connection. */
const HIGH = 1024 * 1024, LOW = 256 * 1024;
/** After the local side half-closes, wait this long for the pod's side before closing. */
const LINGER_MS = 30_000;

export type BridgeTarget = {
  /** The cluster's front door URL (https://127.0.0.1:port/c/<handle>). */
  url: string;
  certificate: string;
  token: string;
  namespace: string;
  pod: string;
  port: number;
};

/** Why a connection failed: the API server refused the upgrade (status), or the kubelet couldn't reach the port. */
export type BridgeError = { message: string; status?: number };

export function forwardPath(t: Pick<BridgeTarget, "namespace" | "pod" | "port">): string {
  return `/api/v1/namespaces/${encodeURIComponent(t.namespace)}/pods/${encodeURIComponent(t.pod)}/portforward?ports=${t.port}`;
}

/** Bridge one local connection to the pod's port. Returns a function that closes both sides. */
export function bridge(t: BridgeTarget, socket: Socket, on: { error(e: BridgeError): void; open?(): void }): () => void {
  const ws = new WebSocket(t.url.replace(/^https:/, "wss:") + forwardPath(t), [FORWARD_PROTOCOL], {
    ca: t.certificate,
    headers: { Authorization: `Bearer ${t.token}` },
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
  const prefix = [2, 2]; // the port bytes still to skip on channels 0 and 1
  let errText = "";
  let done = false;
  let linger: ReturnType<typeof setTimeout> | undefined;
  // Nothing is read from the local side until the pod's side is open.
  socket.pause();

  const close = () => {
    if (done) return;
    done = true;
    if (linger) clearTimeout(linger);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    setTimeout(() => ws.terminate(), 1000).unref();
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  const fail = (e: BridgeError) => {
    if (!done) on.error(e);
    close();
  };

  const toPod = (b: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(Buffer.concat([Buffer.from([0]), b]), () => {
      if (socket.isPaused() && ws.bufferedAmount < LOW) socket.resume();
    });
    if (ws.bufferedAmount > HIGH) socket.pause();
  };

  socket.on("data", toPod);
  socket.on("end", () => {
    // The local side is done sending; the pod may still answer.
    linger = setTimeout(close, LINGER_MS);
    linger.unref();
  });
  socket.on("close", close);
  socket.on("error", close);
  socket.on("drain", () => ws.resume());

  ws.on("open", () => {
    on.open?.();
    socket.resume();
  });
  ws.on("message", (raw: Buffer, binary: boolean) => {
    let b = binary ? raw : Buffer.from(raw);
    if (!b.length) return;
    const ch = b[0]!;
    if (ch > 1) return;
    b = b.subarray(1);
    const skip = Math.min(prefix[ch]!, b.length);
    prefix[ch] = prefix[ch]! - skip;
    b = b.subarray(skip);
    if (!b.length) return;
    if (ch === 0) {
      if (!socket.write(b)) ws.pause();
    } else {
      errText += b.toString("utf8").slice(0, 2000);
    }
  });
  ws.on("unexpected-response", (_req, res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => (text += c.slice(0, 4000)));
    res.on("end", () => {
      const status = res.statusCode ?? 0;
      let message = `HTTP ${status}`;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // not a Status
      }
      fail({ message, status });
    });
  });
  ws.on("error", (e) => fail({ message: e.message }));
  ws.on("close", () => (errText ? fail({ message: kubeletError(errText, t.port) }) : close()));
  return close;
}

/**
 * The kubelet's error, in a person's words where it is a familiar one: "an error occurred forwarding 8080 -> 8080:
 * error forwarding port 8080 to pod …: failed to execute portforward in network namespace …: failed to connect to
 * localhost:8080 inside namespace …: connect: connection refused" says nothing listens there.
 */
export function kubeletError(text: string, forwarded?: number): string {
  const t = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
  const port = /forwarding (?:port )?(\d+)/.exec(t)?.[1] ?? forwarded;
  if (/connection refused/i.test(t)) return `Nothing is listening on port ${port ?? "?"} in the pod (connection refused).`;
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

/** Listen on 127.0.0.1:port. Rejects with EADDRINUSE when the port is taken. */
export function listenLocal(port: number, onConnection: (s: Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: false }, onConnection);
    server.once("error", reject);
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** Whether 127.0.0.1:port can be listened on now. */
export async function isPortFree(port: number): Promise<boolean> {
  try {
    const s = await listenLocal(port, (c) => c.destroy());
    await new Promise((r) => s.close(r));
    return true;
  } catch {
    return false;
  }
}

/** A port the system says is free (above 1023). */
export async function anyFreePort(): Promise<number> {
  const s = await listenLocal(0, (c) => c.destroy());
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * The local port to offer for a remote one (D33): the same port when it is free and above 1023; for a low port, the
 * 8000s (80 → 8080, 443 → 8443); then the next few; else any free port.
 */
export async function suggestPort(remote: number, free: (p: number) => Promise<boolean> = isPortFree, any: () => Promise<number> = anyFreePort): Promise<number> {
  const first = remote >= MIN_LOCAL_PORT ? remote : remote < 1000 ? 8000 + remote : 10000 + remote;
  for (let p = first; p < first + 10 && p <= 65535; p++) if (await free(p)) return p;
  return any();
}

// --- Choosing the pod ---

export const podReady = (p: KubeObject) =>
  !p.metadata.deletionTimestamp && p.status?.phase === "Running" && (p.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True");

/** A Service's port by its number: the target is a number, a container port's name, or (absent) the same number. */
export function servicePort(svc: KubeObject, port: number): { target: number | string; name?: string } | undefined {
  const p = ((svc.spec?.ports ?? []) as { port: number; targetPort?: number | string; name?: string; protocol?: string }[])
    .find((x) => x.port === port && (x.protocol ?? "TCP") === "TCP");
  if (!p) return undefined;
  return { target: p.targetPort ?? p.port, ...(p.name ? { name: p.name } : {}) };
}

/** The pod's port for a target: a number as it is, a name by the containers' ports. */
export function podPort(pod: KubeObject, target: number | string): number | undefined {
  if (typeof target === "number") return target;
  if (/^\d+$/.test(target)) return Number(target);
  for (const c of (pod.spec?.containers ?? []) as { ports?: { name?: string; containerPort: number; protocol?: string }[] }[]) {
    const p = c.ports?.find((x) => x.name === target && (x.protocol ?? "TCP") === "TCP");
    if (p) return p.containerPort;
  }
  return undefined;
}

/** The ready pod to forward to, and its port: the oldest ready one, so a forward stays put while others come and go. */
export function pickPod(pods: KubeObject[], target: number | string): { pod: KubeObject; port: number } | undefined {
  const ready = pods.filter(podReady).sort((a, b) => (a.metadata.creationTimestamp ?? "").localeCompare(b.metadata.creationTimestamp ?? "") || a.metadata.name.localeCompare(b.metadata.name));
  for (const pod of ready) {
    const port = podPort(pod, target);
    if (port !== undefined && port >= 1 && port <= 65535) return { pod, port };
  }
  return undefined;
}

/** A label selector for a list's query. */
export const selectorQuery = (sel: Record<string, string>) => Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(",");
