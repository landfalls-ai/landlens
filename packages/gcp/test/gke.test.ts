// GKE clusters in the catalog (D91): the clusters as listed, the kubeconfig Landlens writes for them in its own data
// folder (no token in it; an exec plugin that asks gcloud at an absolute path), the file's modes, and the plugin run
// for real against the fake gcloud.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caFingerprint, checkCa, checkEndpoint, GKE_CONTEXT, gkeKubeconfig, listClusters, publicCluster, writeGkeKubeconfig, type GkeClusterFull } from "../src/gke.js";
import { FAKE_CLUSTER_CA, FAKE_LEAF_CERT, FakeGcp, GCP_ACCOUNT, GCP_TOKEN } from "./fake-gcp.js";
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
      { name: "to-me", location: "us-central1", endpoint: "127.0.0.1:26443", masterAuth: { clusterCaCertificate: FAKE_CLUSTER_CA } },
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

  it("L1 (review of part 5): only a canonical dotted quad or a gke.goog name; never another spelling of loopback or the metadata server", () => {
    // Forms Go's resolver reads as 127.0.0.1 or 169.254.169.254.
    for (const e of ["0x7f.0.0.1", "0127.0.0.1", "127.1", "2130706433", "0x7f000001", "0xa9.0xfe.0xa9.0xfe", "0169.254.169.254", "169.254.169.254:80", "10.0.0.010"]) {
      expect(checkEndpoint(e, false), e).toBe("");
      expect(checkEndpoint(e, true), `${e}, with the fake`).toBe("");
    }
    // DNS names that resolve somewhere local, or anywhere but GKE's DNS endpoints.
    for (const e of ["metadata.google.internal", "metadata", "anything.internal", "localtest.me", "evil.example", "gke.goog.evil.example", "localhost", "a.localhost"]) expect(checkEndpoint(e), e).toBe("");
    // Reserved, multicast and broadcast; private ranges are allowed (private clusters).
    for (const e of ["224.0.0.1", "255.255.255.255", "240.0.0.1", "0.1.2.3"]) expect(checkEndpoint(e), e).toBe("");
    for (const e of ["10.0.0.2", "172.16.0.2", "192.168.1.2", "100.64.0.1", "34.120.18.77:443"]) expect(checkEndpoint(e), e).toBe(e);
    expect(checkEndpoint("gke-dc6d549babec45f49a431dc9ca926da159ca-518563762004.us-central1-c.gke.goog")).not.toBe("");
    expect(checkEndpoint("127.0.0.1:26443", true)).toBe("127.0.0.1:26443");
    expect(checkEndpoint("localhost:6443", true)).toBe("");
    expect(checkEndpoint("203.0.113.17:0443")).toBe("");
  });

  it("M1 (review of wave 9 part 1): a CA's fingerprint is the one landlens-kube-proxy reports (main_test.go)", () => {
    // The same constant as sidecar/kube-proxy/main_test.go's fakeClusterCAFP: the two sides compare these.
    expect(caFingerprint(FAKE_CLUSTER_CA)).toBe("a20a863e00045e5b656f2018980676f61dda45d44e12af370e874bca5b5eed97");
    expect(caFingerprint(FAKE_LEAF_CERT)).not.toBe(caFingerprint(FAKE_CLUSTER_CA));
    // Line endings and wrapping don't change it: only the certificates' bytes count.
    const pem = Buffer.from(FAKE_CLUSTER_CA, "base64").toString("latin1");
    expect(caFingerprint(Buffer.from(pem.replace(/\n/g, "\r\n")).toString("base64"))).toBe(caFingerprint(FAKE_CLUSTER_CA));
  });

  it("L2 (review of part 5): an IP endpoint needs a valid cluster CA; a gke.goog DNS endpoint uses the system roots", async () => {
    expect(checkCa(FAKE_CLUSTER_CA)).toBe(FAKE_CLUSTER_CA);
    expect(checkCa(FAKE_LEAF_CERT)).toBeUndefined();
    expect(checkCa("LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t")).toBeUndefined(); // the header alone isn't a certificate
    expect(checkCa(undefined)).toBeUndefined();
    const dns = "gke-0a1b2c3d4e-268401937752.us-central1.gke.goog";
    fake.clusters.set("payments-core", [
      { name: "no-ca", location: "us-central1", endpoint: "203.0.113.40" },
      { name: "bad-ca", location: "us-central1", endpoint: "203.0.113.41", masterAuth: { clusterCaCertificate: FAKE_LEAF_CERT } },
      { name: "no-ca-dns", location: "us-central1", endpoint: "203.0.113.42", controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: dns } } },
      { name: "good", location: "us-central1", endpoint: "203.0.113.43", masterAuth: { clusterCaCertificate: FAKE_CLUSTER_CA }, controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: dns } } },
    ]);
    try {
      const cs = await listClusters(clientFor(fake).client, "payments-core");
      expect(cs.map((c) => [c.name, c.endpoint, !!c.ca])).toEqual([
        ["no-ca", "", false],
        ["bad-ca", "", false],
        ["no-ca-dns", dns, false],
        ["good", "203.0.113.43", true],
      ]);
      // The DNS endpoint is kept beside the IP it doesn't open (security review of wave 9 part 4, M2), never twice.
      expect(cs.map((c) => c.dns)).toEqual([undefined, undefined, undefined, dns]);
      expect(publicCluster(cs[3]!)).not.toHaveProperty("dns");
      expect(publicCluster(cs[3]!)).not.toHaveProperty("ca");
      const doc = parse(gkeKubeconfig(cs, FAKE_GCLOUD, GCP_ACCOUNT));
      expect(doc.clusters.map((c: { name: string; cluster: Record<string, string> }) => [c.name, c.cluster.server, "certificate-authority-data" in c.cluster])).toEqual([
        ["gke_payments-core_us-central1_no-ca-dns", `https://${dns}`, false],
        ["gke_payments-core_us-central1_good", "https://203.0.113.43", true],
      ]);
      // An IP endpoint handed in without a CA is never written: the system roots would check it.
      expect(parse(gkeKubeconfig([cluster({ ca: undefined })], FAKE_GCLOUD, GCP_ACCOUNT)).clusters).toEqual([]);
    } finally {
      fake.clusters.delete("payments-core");
    }
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
