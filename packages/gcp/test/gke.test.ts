// GKE clusters in the catalog (D91): the clusters as listed, the kubeconfig Landlens writes for them in its own data
// folder (no token in it; an exec plugin that asks gcloud at an absolute path), the file's modes, and the plugin run
// for real against the fake gcloud.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEndpoint, GKE_CONTEXT, gkeKubeconfig, listClusters, writeGkeKubeconfig, type GkeClusterFull } from "../src/gke.js";
import { FakeGcp, GCP_ACCOUNT, GCP_TOKEN } from "./fake-gcp.js";
import { clientFor, FAKE_GCLOUD, sdkDir } from "./helpers.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());

const run = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(args[0]!, args.slice(1), { env, timeout: 10_000 }, (e, out, err) => resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) })));

describe("listClusters", () => {
  it("keeps each cluster's CA for the kubeconfig and gcloud's context names", async () => {
    const cs = await listClusters(clientFor(fake).client, "demo-shop");
    expect(cs.map((c) => c.context)).toEqual(["gke_demo-shop_us-central1_shop-prod", "gke_demo-shop_europe-west1-b_shop-staging", "gke_demo-shop_us-east1_batch-jobs"]);
    expect(cs[0]!.ca).toMatch(/^LS0t/);
    expect(cs[2]!.ca).toBeUndefined();
    for (const c of cs) expect(GKE_CONTEXT.test(c.context)).toBe(true);
  });

  it("refuses a local or link-local control plane unless it is the development fake's", async () => {
    fake.clusters.set("payments-core", [
      { name: "to-me", location: "us-central1", endpoint: "127.0.0.1:26443" },
      { name: "metadata", location: "us-central1", endpoint: "169.254.169.254" },
      { name: "weird", location: "us-central1", endpoint: "https://evil.example/x" },
    ]);
    try {
      const plain = await listClusters(clientFor(fake).client, "payments-core");
      expect(plain.map((c) => c.endpoint)).toEqual(["", "", ""]);
      const dev = await listClusters(clientFor(fake).client, "payments-core", { allowLocal: true });
      expect(dev.map((c) => c.endpoint)).toEqual(["127.0.0.1:26443", "", ""]);
    } finally {
      fake.clusters.delete("payments-core");
    }
  });

  it("checks addresses: IPv4 or a DNS name, a port only as given", () => {
    expect(checkEndpoint("203.0.113.17")).toBe("203.0.113.17");
    expect(checkEndpoint("gke-0a1b.us-east1.gke.goog")).toBe("gke-0a1b.us-east1.gke.goog");
    expect(checkEndpoint("300.1.1.1")).toBe("");
    expect(checkEndpoint("a b")).toBe("");
    expect(checkEndpoint("localhost:6443")).toBe("");
    expect(checkEndpoint("0.0.0.0")).toBe("");
    expect(checkEndpoint("169.254.169.254", true)).toBe("");
  });
});

const cluster = (over: Partial<GkeClusterFull> = {}): GkeClusterFull => ({
  project: "demo-shop", location: "us-central1", name: "shop-prod", status: "RUNNING", version: "1.33", endpoint: "203.0.113.17",
  context: "gke_demo-shop_us-central1_shop-prod", ca: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t", ...over,
});

describe("the GKE kubeconfig", () => {
  it("has one cluster, user and context per openable cluster, an exec plugin with gcloud's absolute path, and no token", () => {
    const text = gkeKubeconfig([cluster(), cluster({ name: "nowhere", context: "gke_demo-shop_us-central1_nowhere", endpoint: "" })], FAKE_GCLOUD, GCP_ACCOUNT);
    const doc = parse(text);
    expect(doc.contexts).toEqual([{ name: "gke_demo-shop_us-central1_shop-prod", context: { cluster: "gke_demo-shop_us-central1_shop-prod", user: "gke_demo-shop_us-central1_shop-prod" } }]);
    expect(doc.clusters[0].cluster).toEqual({ server: "https://203.0.113.17", "certificate-authority-data": "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t" });
    const exec = doc.users[0].user.exec;
    expect(exec).toMatchObject({ apiVersion: "client.authentication.k8s.io/v1", command: "/bin/sh", interactiveMode: "Never", provideClusterInfo: false });
    expect(exec.args.slice(2)).toEqual(["landlens-gke", FAKE_GCLOUD, GCP_ACCOUNT]);
    expect(text).not.toContain(GCP_TOKEN);
    expect(text).not.toMatch(/token:/);
  });

  it("refuses a relative gcloud or an account that isn't one", () => {
    expect(() => gkeKubeconfig([cluster()], "gcloud", GCP_ACCOUNT)).toThrow(/absolute/);
    expect(() => gkeKubeconfig([cluster()], FAKE_GCLOUD, "x; rm -rf /")).toThrow(/account/);
  });

  it("is written 0600 in a 0700 folder", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "landlens-gke-")), "gke");
    const file = writeGkeKubeconfig(dir, "x: 1\n");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeGkeKubeconfig(dir, "x: 2\n");
    expect(readFileSync(file, "utf8")).toBe("x: 2\n");
  });

  it("its exec plugin prints an ExecCredential with gcloud's token for the account, and refuses anything else", async () => {
    const exec = parse(gkeKubeconfig([cluster()], FAKE_GCLOUD, GCP_ACCOUNT)).users[0].user.exec;
    const dir = sdkDir();
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", CLOUDSDK_CONFIG: dir };
    const ok = await run([exec.command, ...exec.args], env);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual({ apiVersion: "client.authentication.k8s.io/v1", kind: "ExecCredential", status: { token: GCP_TOKEN } });
    expect(readFileSync(join(dir, "calls"), "utf8").trim()).toBe(`auth print-access-token --account=${GCP_ACCOUNT}`);
    // Something not shaped like a token (a quote that would break the JSON, a newline-free injection) is refused.
    writeFileSync(join(dir, "token"), 'ya29.abc","kind":"x"' + "a".repeat(30));
    const bad = await run([exec.command, ...exec.args], env);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toBe("");
    expect(bad.err).toMatch(/gcloud gave no access token/);
    writeFileSync(join(dir, "token"), "short");
    expect((await run([exec.command, ...exec.args], env)).code).not.toBe(0);
    writeFileSync(join(dir, "fail"), "");
    expect((await run([exec.command, ...exec.args], env)).code).not.toBe(0);
  });
});
