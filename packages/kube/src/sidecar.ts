// Starts and stops landlens-kube-proxy, the Go process that holds one cluster's credentials.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

export type SidecarOptions = {
  binary: string;
  context: string;
  /** KUBECONFIG-style list; empty means the default rules (KUBECONFIG or ~/.kube/config). */
  kubeconfig?: string;
  /**
   * Variables set over Landlens's own environment (minus its secrets) for this sidecar and the exec plugins client-go
   * runs from it: a GKE cluster's gets the login PATH, so gcloud finds its Python (D91).
   */
  env?: Record<string, string>;
  /**
   * `env` is the whole environment, not set over Landlens's (review of part 5, L6): a GKE cluster's sidecar and the
   * gcloud its exec plugin runs get gcloud's allowlist only (HOME, PATH, CLOUDSDK_*, proxies).
   */
  envOnly?: boolean;
  /**
   * The sidecar refuses to dial loopback, link-local, unspecified and multicast addresses, checked on the address it
   * resolved (review of part 5, L1): a GKE cluster's, unless it is the development fake's.
   */
  refuseLocal?: boolean;
  startTimeoutMs?: number;
  log?: (line: string) => void;
};

/**
 * Whom the sidecar trusts to be the cluster, from its Ready line (security review of wave 9 part 1, M1): `ca` is the
 * hex SHA-256 of the DER of every certificate of the context's CA ("" for the system roots); the three flags say
 * insecure-skip-tls-verify, tls-server-name and proxy-url are set.
 */
export type SidecarTls = { ca: string; insecure: boolean; serverName: boolean; proxy: boolean };

/** The Ready line's `tls`, when it is that shape; undefined otherwise (an older sidecar), which counts as unknown. */
export function readyTls(v: unknown): SidecarTls | undefined {
  const t = v as Partial<SidecarTls> | null | undefined;
  if (!t || typeof t !== "object" || typeof t.ca !== "string" || !/^([0-9a-f]{64})?$/.test(t.ca)) return undefined;
  if (typeof t.insecure !== "boolean" || typeof t.serverName !== "boolean" || typeof t.proxy !== "boolean") return undefined;
  return { ca: t.ca, insecure: t.insecure, serverName: t.serverName, proxy: t.proxy };
}

export type Sidecar = {
  /** http://127.0.0.1:<port> */
  url: string;
  /** Sent as X-Landlens-Sidecar on every request. Never leaves main. */
  secret: string;
  server: string;
  /** Whom it trusts to be the cluster; undefined when its Ready line didn't say. */
  tls?: SidecarTls;
  context: string;
  pid: number | undefined;
  stop(): Promise<void>;
  exited: Promise<number | null>;
};

export const SIDECAR_HEADER = "X-Landlens-Sidecar";

export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const secret = randomBytes(32).toString("hex");
  const args = ["--context", opts.context];
  if (opts.kubeconfig) args.push("--kubeconfig", opts.kubeconfig);
  if (opts.refuseLocal) args.push("--refuse-local");
  const child: ChildProcess = spawn(opts.binary, args, {
    // stdin stays open as a pipe: its first line is the secret (never the environment, which any same-user process
    // can read with `ps eww`), and when Landlens dies it closes and the sidecar exits.
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.envOnly ? withoutLandlensSecrets(opts.env ?? {}) : { ...withoutLandlensSecrets(process.env), ...withoutLandlensSecrets(opts.env ?? {}) },
  });
  child.stdin?.on("error", () => {}); // EPIPE if it exits early; `exited` reports that
  child.stdin?.write(secret + "\n");
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr.push(d);
    opts.log?.(d.trimEnd());
  });

  const ready = await new Promise<{ listening: string; server: string; tls?: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`landlens-kube-proxy for ${opts.context} did not start in time`));
    }, opts.startTimeoutMs ?? 30_000);
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", (line) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(line);
        if (typeof r?.listening !== "string" || typeof r?.server !== "string") throw new Error("shape");
        resolve(r);
      } catch {
        child.kill();
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

  const tls = readyTls(ready.tls);
  return {
    url: `http://${ready.listening}`,
    secret,
    server: ready.server,
    ...(tls ? { tls } : {}),
    context: opts.context,
    pid: child.pid,
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

/** Child processes never inherit Landlens's own secrets (the agent's token, an old sidecar secret). */
export function withoutLandlensSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.LANDLENS_SIDECAR_SECRET;
  delete out.LANDLENS_TOKEN;
  return out;
}

/** The sidecar logs JSON via slog; show the human part. */
function lastLine(lines: string[]): string {
  const last = lines.join("").trim().split("\n").pop() ?? "";
  const m = /error="?([^"]+)"?/.exec(last);
  return m?.[1] ?? last;
}

/** A fresh self-signed certificate for 127.0.0.1 from the sidecar binary (Go's crypto/x509), kept in memory. */
/** The front door's serving certificate and key, and the one-run CA that signed it (what clients pin). */
export type LoopbackCert = { cert: string; key: string; ca: string };

export async function loopbackCert(binary: string): Promise<LoopbackCert> {
  const { execFile } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) =>
    execFile(binary, ["--loopback-cert"], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  const c = JSON.parse(out);
  if (typeof c.cert !== "string" || typeof c.key !== "string" || typeof c.ca !== "string") throw new Error("landlens-kube-proxy: bad certificate output");
  return c;
}
