// gcloud's sign-in, borrowed for one read at a time (spec D85). Landlens never runs `gcloud auth login` and stores no
// Google credential: it asks gcloud for the signed-in account and a short-lived access token, keeps the token in
// memory for 5 minutes (dropped on any 401), and hands it only to GcpClient.
//
// gcloud runs with execFile (no shell), at an absolute path, for at most 10 s, with HOME, PATH and CLOUDSDK_* only in
// its environment, so nothing else Landlens holds (a provider token, the sidecar's secrets) reaches it.
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

/** An account as gcloud names it: one email-shaped line, at most 254 characters. */
export const ACCOUNT_SHAPE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,24}$/;
/** An access token as gcloud prints it (ya29.…). Anything else is refused. */
export const TOKEN_SHAPE = /^[A-Za-z0-9._-]{20,4096}$/;
export const TOKEN_TTL = 5 * 60_000;
const RUN_LIMIT = 10_000;

/** Runs a program and gives its stdout; the default is execFile. */
export type Runner = (file: string, args: string[], opts: { env: Record<string, string>; timeout: number }) => Promise<string>;

export const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeout, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(Object.assign(new Error(`gcloud ${args.slice(0, 2).join(" ")} failed`), { code: (err as { code?: unknown }).code }));
      else resolve(String(stdout));
    });
  });

/** The environment gcloud gets: HOME, PATH (the login PATH, so it finds its Python) and its own CLOUDSDK_* settings. */
export function gcloudEnv(source: NodeJS.ProcessEnv, path?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (source.HOME) out.HOME = source.HOME;
  const p = path ?? source.PATH;
  if (p) out.PATH = p;
  for (const [k, v] of Object.entries(source)) if (k.startsWith("CLOUDSDK_") && v !== undefined) out[k] = v;
  return out;
}

export class GcloudAuth {
  private cached?: { account: string; token: string; at: number };
  private inflight?: Promise<string>;

  constructor(private readonly o: { gcloud: string; env: Record<string, string>; run?: Runner; now?: () => number }) {
    if (!isAbsolute(o.gcloud)) throw new Error("gcloud must be an absolute path");
  }

  private run(args: string[]): Promise<string> {
    return (this.o.run ?? execRunner)(this.o.gcloud, args, { env: this.o.env, timeout: RUN_LIMIT });
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** The account gcloud is signed in as, or undefined (none, or not shaped like one). */
  async account(): Promise<string | undefined> {
    let out: string;
    try {
      out = await this.run(["config", "get-value", "account"]);
    } catch {
      return undefined;
    }
    const a = out.trim();
    return a.length <= 254 && ACCOUNT_SHAPE.test(a) ? a : undefined;
  }

  /** An access token for `account`: the one held if it is under 5 minutes old, else a new one from gcloud. */
  async token(account: string): Promise<string> {
    if (!ACCOUNT_SHAPE.test(account)) throw new Error("not an account");
    const c = this.cached;
    if (c && c.account === account && this.now() - c.at < TOKEN_TTL) return c.token;
    // One gcloud at a time: parallel reads share the token being printed.
    this.inflight ??= (async () => {
      try {
        const out = (await this.run(["auth", "print-access-token", `--account=${account}`])).trim();
        if (!TOKEN_SHAPE.test(out)) throw new Error("gcloud printed something that isn't an access token");
        this.cached = { account, token: out, at: this.now() };
        return out;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** Forget the token (Google answered 401, or the account changed). */
  drop() {
    this.cached = undefined;
  }

  /** The token held now, if any: for cutting it out of log lines exactly. */
  held(): string | undefined {
    return this.cached?.token;
  }
}
