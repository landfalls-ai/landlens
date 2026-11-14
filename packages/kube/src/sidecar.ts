// Starts and stops landlens-kube-proxy, the Go process that holds one cluster's credentials.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

export type SidecarOptions = {
  binary: string;
  context: string;
  /** KUBECONFIG-style list; empty means the default rules (KUBECONFIG or ~/.kube/config). */
  kubeconfig?: string;
  startTimeoutMs?: number;
  log?: (line: string) => void;
};

export type Sidecar = {
  /** http://127.0.0.1:<port> */
  url: string;
  /** Sent as X-Landlens-Sidecar on every request. Never leaves main. */
  secret: string;
  server: string;
  context: string;
  stop(): Promise<void>;
  exited: Promise<number | null>;
};

export const SIDECAR_HEADER = "X-Landlens-Sidecar";

export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const secret = randomBytes(32).toString("hex");
  const args = ["--context", opts.context];
  if (opts.kubeconfig) args.push("--kubeconfig", opts.kubeconfig);
  const child: ChildProcess = spawn(opts.binary, args, {
    // stdin stays open as a pipe: when Landlens dies, it closes and the sidecar exits.
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LANDLENS_SIDECAR_SECRET: secret },
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr.push(d);
    opts.log?.(d.trimEnd());
  });

  const ready = await new Promise<{ listening: string; server: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`landlens-kube-proxy for ${opts.context} did not start in time`));
    }, opts.startTimeoutMs ?? 30_000);
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`landlens-kube-proxy: unexpected output ${line.slice(0, 200)}`));
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(lastLine(stderr) || `landlens-kube-proxy exited with ${code}`));
    });
  });

  return {
    url: `http://${ready.listening}`,
    secret,
    server: ready.server,
    context: opts.context,
    exited,
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin?.end();
      const t = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(t);
    },
  };
}

/** The sidecar logs JSON via slog; show the human part. */
function lastLine(lines: string[]): string {
  const last = lines.join("").trim().split("\n").pop() ?? "";
  const m = /error="?([^"]+)"?/.exec(last);
  return m?.[1] ?? last;
}

/** A fresh self-signed certificate for 127.0.0.1 from the sidecar binary (Go's crypto/x509), kept in memory. */
export async function loopbackCert(binary: string): Promise<{ cert: string; key: string }> {
  const { execFile } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) =>
    execFile(binary, ["--loopback-cert"], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  const c = JSON.parse(out);
  if (typeof c.cert !== "string" || typeof c.key !== "string") throw new Error("landlens-kube-proxy: bad certificate output");
  return c;
}
