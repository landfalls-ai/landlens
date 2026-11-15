// gcloud's sign-in (D85): the fake gcloud only; Landlens stores nothing and hands gcloud a small environment.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_SHAPE, execRunner, GcloudAuth, gcloudEnv, TOKEN_TTL, type Runner } from "../src/auth.js";
import { GCP_ACCOUNT, GCP_TOKEN } from "./fake-gcp.js";
import { FAKE_GCLOUD, sdkDir } from "./helpers.js";

const env = (dir: string) => gcloudEnv({ HOME: process.env.HOME, PATH: process.env.PATH, CLOUDSDK_CONFIG: dir, GH_TOKEN: "ghp_x", LANDLENS_SIDECAR_SECRET: "s", AWS_SECRET_ACCESS_KEY: "a" });

describe("GcloudAuth with the fake gcloud", () => {
  it("reads the account and a token, and gives gcloud HOME, PATH and CLOUDSDK_* only", async () => {
    const dir = sdkDir();
    const auth = new GcloudAuth({ gcloud: FAKE_GCLOUD, env: env(dir) });
    expect(await auth.account()).toBe(GCP_ACCOUNT);
    expect(await auth.token(GCP_ACCOUNT)).toBe(GCP_TOKEN);
    const seen = readFileSync(join(dir, "env"), "utf8").split("\n").map((l) => l.split("=")[0]).filter((k) => k && !["PWD", "SHLVL", "_", "OLDPWD"].includes(k!));
    expect(new Set(seen)).toEqual(new Set(["HOME", "PATH", "CLOUDSDK_CONFIG", "CLOUDSDK_CORE_DISABLE_PROMPTS"]));
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual(["config get-value account", `auth print-access-token --account=${GCP_ACCOUNT}`]);
  });

  it("is signed out when gcloud has no account, or one that isn't shaped like an email", async () => {
    const dir = sdkDir();
    writeFileSync(join(dir, "account"), "");
    expect(await new GcloudAuth({ gcloud: FAKE_GCLOUD, env: env(dir) }).account()).toBeUndefined();
    writeFileSync(join(dir, "account"), "--impersonate-service-account=x");
    expect(await new GcloudAuth({ gcloud: FAKE_GCLOUD, env: env(dir) }).account()).toBeUndefined();
    expect(ACCOUNT_SHAPE.test(`${"a".repeat(64)}@example.com`)).toBe(true);
    expect(ACCOUNT_SHAPE.test("a b@example.com")).toBe(false);
  });

  it("refuses a token that isn't one, and a failing gcloud", async () => {
    const dir = sdkDir();
    writeFileSync(join(dir, "token"), "Please run gcloud auth login to continue.");
    await expect(new GcloudAuth({ gcloud: FAKE_GCLOUD, env: env(dir) }).token(GCP_ACCOUNT)).rejects.toThrow(/isn't an access token/);
    const d2 = sdkDir();
    writeFileSync(join(d2, "fail"), "");
    await expect(new GcloudAuth({ gcloud: FAKE_GCLOUD, env: env(d2) }).token(GCP_ACCOUNT)).rejects.toThrow(/failed/);
  });

  it("keeps a token 5 minutes in memory, shares one gcloud between parallel reads, and drops it on request", async () => {
    let t = 0;
    let runs = 0;
    const run: Runner = async (_f, args) => (args[0] === "auth" ? (runs++, `ya29.token-${runs}-${"x".repeat(20)}`) : GCP_ACCOUNT);
    const auth = new GcloudAuth({ gcloud: "/usr/bin/gcloud", env: {}, run, now: () => t });
    const [a, b] = await Promise.all([auth.token(GCP_ACCOUNT), auth.token(GCP_ACCOUNT)]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    t = TOKEN_TTL - 1;
    expect(await auth.token(GCP_ACCOUNT)).toBe(a);
    t = TOKEN_TTL;
    expect(await auth.token(GCP_ACCOUNT)).not.toBe(a);
    auth.drop();
    // Dropped: the next read asks gcloud again (held() still names the last token, only for cutting it from logs).
    await auth.token(GCP_ACCOUNT);
    expect(runs).toBe(3);
  });

  it("runs gcloud only at an absolute path, with a checked account and no shell", async () => {
    expect(() => new GcloudAuth({ gcloud: "gcloud", env: {} })).toThrow(/absolute/);
    const calls: string[][] = [];
    const run: Runner = async (f, args) => (calls.push([f, ...args]), GCP_TOKEN);
    const auth = new GcloudAuth({ gcloud: "/opt/gcloud/bin/gcloud", env: {}, run });
    await expect(auth.token("x; rm -rf ~")).rejects.toThrow(/not an account/);
    await auth.token(GCP_ACCOUNT);
    expect(calls).toEqual([["/opt/gcloud/bin/gcloud", "auth", "print-access-token", `--account=${GCP_ACCOUNT}`]]);
  });
});

describe("Fable's security review of part 4, fixed", () => {
  it("L1: the last token gcloud gave is still known after a drop, to cut it out of log lines", async () => {
    const auth = new GcloudAuth({ gcloud: FAKE_GCLOUD, env: env(sdkDir()) });
    await auth.token(GCP_ACCOUNT);
    auth.drop();
    expect(auth.held()).toBe(GCP_TOKEN);
  });

  it("part 5 L6: gcloud's environment (a GKE sidecar's whole one) keeps the proxy variables and nothing else of Landlens's", () => {
    const e = gcloudEnv({ HOME: "/h", PATH: "/p", HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", GH_TOKEN: "ghp_x", LANDLENS_TOKEN: "t", KUBECONFIG: "/k" });
    expect(e).toEqual({ HOME: "/h", PATH: "/p", HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", CLOUDSDK_CORE_DISABLE_PROMPTS: "1" });
  });

  it("L3: gcloud is told never to ask, and gets no input: a prompt fails at once instead of waiting out the limit", async () => {
    expect(gcloudEnv({}).CLOUDSDK_CORE_DISABLE_PROMPTS).toBe("1");
    const dir = mkdtempSync(join(tmpdir(), "landlens-prompt-"));
    const script = join(dir, "asks.sh");
    writeFileSync(script, "#!/bin/sh\nread answer\necho \"read: [$answer]\"\n", { mode: 0o755 });
    const started = Date.now();
    expect(await execRunner(script, [], { env: {}, timeout: 3_000 })).toBe("read: []\n");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
