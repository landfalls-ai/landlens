// A shell in a pod: the Kubernetes exec API over a WebSocket, through the front door, with a token issued for this
// terminal alone. No kubectl and no local process: bytes go between the WebSocket and the window's terminal.
//
// The channel protocol (v5.channel.k8s.io, else v4): every binary message starts with a channel byte. 0 stdin,
// 1 stdout, 2 stderr, 3 the exit status (a Status object), 4 the terminal size; v5 adds 255, "close this channel".
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";

export const EXEC_PROTOCOLS = ["v5.channel.k8s.io", "v4.channel.k8s.io"];

/** Bash if the container has it, else sh: the shell a person expects, in images that have only one. */
export const AUTO_SHELL = ["/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -il; else exec sh -i; fi"];

export type ExecTarget = {
  /** The cluster's front door URL (https://127.0.0.1:port/c/<handle>). */
  url: string;
  /** The front door's CA (PEM), pinned. */
  certificate: string;
  token: string;
  namespace: string;
  pod: string;
  container: string;
  command: string[];
};

/** How it ended: the shell exited (with a code), the connection dropped, or the API server refused the upgrade. */
export type ExecExit = { ended: "exit" | "lost" | "refused"; code?: number; status?: number; message?: string };

export type ExecSession = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
};

/** The exec path with its query: each command word is its own `command` parameter. */
export function execPath(t: Pick<ExecTarget, "namespace" | "pod" | "container" | "command">): string {
  const q = new URLSearchParams({ container: t.container, stdin: "true", stdout: "true", stderr: "true", tty: "true" });
  for (const c of t.command) q.append("command", c);
  return `/api/v1/namespaces/${encodeURIComponent(t.namespace)}/pods/${encodeURIComponent(t.pod)}/exec?${q}`;
}

/** The exit a Status on channel 3 reports: Success is 0; a NonZeroExitCode carries its code. */
export function exitOf(status: string): ExecExit {
  try {
    const s = JSON.parse(status) as { status?: string; message?: string; reason?: string; details?: { causes?: { reason?: string; message?: string }[] } };
    if (s.status === "Success") return { ended: "exit", code: 0 };
    const code = s.details?.causes?.find((c) => c.reason === "ExitCode")?.message;
    return { ended: "exit", ...(code !== undefined && /^\d+$/.test(code) ? { code: Number(code) } : {}), ...(s.message ? { message: s.message } : {}) };
  } catch {
    return { ended: "exit", message: status.slice(0, 500) };
  }
}

export function openExec(t: ExecTarget, on: { open(): void; data(text: string): void; exit(e: ExecExit): void }): ExecSession {
  const url = t.url.replace(/^https:/, "wss:") + execPath(t);
  const ws = new WebSocket(url, EXEC_PROTOCOLS, {
    ca: t.certificate,
    headers: { Authorization: `Bearer ${t.token}` },
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
  const out = new StringDecoder("utf8");
  const err = new StringDecoder("utf8");
  let exit: ExecExit | undefined;
  let done = false;
  let opened = false;
  let size: [number, number] | undefined;
  const finish = (e: ExecExit) => {
    if (done) return;
    done = true;
    on.exit(e);
  };
  const sendSize = () => {
    if (size && ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([Buffer.from([4]), Buffer.from(JSON.stringify({ Width: size[0], Height: size[1] }))]));
  };

  ws.on("open", () => {
    opened = true;
    on.open();
    sendSize();
  });
  ws.on("message", (raw: Buffer, binary: boolean) => {
    const b = binary ? raw : Buffer.from(raw);
    if (!b.length) return;
    const body = b.subarray(1);
    switch (b[0]) {
      case 1:
        return on.data(out.write(body));
      case 2:
        return on.data(err.write(body));
      case 3:
        exit = exitOf(body.toString("utf8"));
        return;
    }
  });
  // The API server answers a refused upgrade with HTTP: its status says why (403 RBAC, 404 no such pod).
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
      finish({ ended: "refused", status, message });
    });
  });
  ws.on("error", (e) => finish({ ended: opened ? "lost" : "refused", message: e.message }));
  ws.on("close", () => finish(exit ?? { ended: opened ? "lost" : "refused", message: "The connection closed." }));

  return {
    write(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(data, "utf8")]));
    },
    resize(cols, rows) {
      size = [Math.max(1, Math.min(1000, Math.floor(cols))), Math.max(1, Math.min(1000, Math.floor(rows)))];
      sendSize();
    },
    close() {
      if (ws.readyState === WebSocket.OPEN && ws.protocol === EXEC_PROTOCOLS[0]) ws.send(Buffer.from([255, 0])); // close stdin
      ws.close();
      setTimeout(() => ws.terminate(), 1000).unref();
    },
  };
}
