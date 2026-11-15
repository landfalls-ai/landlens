// Helm releases (wave 4, part 4): decoded from Helm's release Secrets in main, with no secret values for the window.
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { coalesce, decodeRelease, getRelease, hideSecrets, isSensitiveKey, listReleases, manifestForWindow, MAX_DECODED, wholeDocuments } from "../src/helm.js";
import { redactText } from "../src/redact.js";
import type { KubeClient } from "../src/client.js";

/** A release Secret's `data.release`: Helm's base64(gzip(JSON)), then the API's base64. */
const encode = (release: unknown, gzip = true) => {
  const json = Buffer.from(JSON.stringify(release));
  const helm = (gzip ? gzipSync(json) : json).toString("base64");
  return Buffer.from(helm).toString("base64");
};

const MANIFEST = `---
# Source: demo/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: demo-auth
type: Opaque
data:
  password: "czNjcmV0LWRldi1wYXNz"
stringData:
  token: plain-token-value
---
# Source: demo/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo
data:
  message: hello
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
  namespace: other
`;

const release = (version: number, over: Record<string, unknown> = {}) => ({
  name: "demo", namespace: "shop", version,
  info: { status: version === 2 ? "deployed" : "superseded", description: version === 2 ? "Upgrade complete" : "Install complete", notes: "Visit http://demo", first_deployed: "2026-11-15T00:00:00Z", last_deployed: `2026-11-15T0${version}:00:00Z` },
  chart: { metadata: { name: "demo", version: "0.1.0", appVersion: "1.0.0", description: "A demo" }, values: { replicaCount: 1, message: "hello", auth: { adminPassword: "", existingSecret: "" }, image: { repository: "busybox", tag: "1.36" } } },
  config: { message: version === 2 ? "hi" : "hello", auth: { adminPassword: "s3cret-dev-pass", apiKey: "demo-key-123456" }, image: null },
  manifest: MANIFEST,
  ...over,
});

function fakeClient(secrets: Record<string, { labels: Record<string, string>; data?: string; namespace?: string }>) {
  const json = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path.includes("/secrets?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const sel = Object.fromEntries(q.get("labelSelector")!.split(",").map((kv) => kv.split("=")));
      const ns = /\/namespaces\/([^/]+)\/secrets/.exec(path)?.[1];
      return { items: Object.entries(secrets)
        .filter(([, s]) => (!ns || (s.namespace ?? "shop") === ns) && Object.entries(sel).every(([k, v]) => s.labels[k] === v))
        .map(([name, s]) => ({ metadata: { name, namespace: s.namespace ?? "shop", labels: s.labels } })) };
    }
    const m = /\/namespaces\/([^/]+)\/secrets\/([^/?]+)$/.exec(path);
    const s = m && secrets[m[2]!];
    if (!s) throw Object.assign(new Error("not found"), { status: 404 });
    return { data: s.data === undefined ? {} : { release: s.data } };
  });
  return { client: { json } as unknown as KubeClient, json };
}

const labels = (name: string, version: number, status: string) => ({ owner: "helm", name, version: String(version), status });

describe("Helm releases", () => {
  it("decodes a release, gzipped or not, and refuses one that decompresses past the limit", () => {
    expect(decodeRelease(encode(release(1))).chart?.metadata?.name).toBe("demo");
    expect(decodeRelease(encode(release(1), false)).name).toBe("demo");
    const bomb = Buffer.from(gzipSync(Buffer.alloc(MAX_DECODED + 1024, 0x20)).toString("base64")).toString("base64");
    expect(() => decodeRelease(bomb)).toThrow(/over 16 MB/);
    expect(() => decodeRelease(Buffer.from("not base64 json").toString("base64"))).toThrow(/can't decode/);
  });

  it("lists the latest revision of each release, through metadata first, and counts the unreadable", async () => {
    const { client, json } = fakeClient({
      "sh.helm.release.v1.demo.v1": { labels: labels("demo", 1, "superseded"), data: encode(release(1)) },
      "sh.helm.release.v1.demo.v2": { labels: labels("demo", 2, "deployed"), data: encode(release(2)) },
      "sh.helm.release.v1.broken.v1": { labels: labels("broken", 1, "failed"), data: "!!" },
      "sh.helm.release.v1.api.v3": { labels: labels("api", 3, "deployed"), namespace: "apps", data: encode(release(2, { name: "api" })) },
    });
    const { releases, unreadable } = await listReleases(client);
    expect(releases).toEqual([
      { name: "api", namespace: "apps", revision: 3, status: "deployed", chart: "demo", chartVersion: "0.1.0", appVersion: "1.0.0", updated: "2026-11-15T02:00:00Z" },
      { name: "broken", namespace: "shop", revision: 1, status: "failed", chart: "", chartVersion: "", appVersion: "" },
      { name: "demo", namespace: "shop", revision: 2, status: "deployed", chart: "demo", chartVersion: "0.1.0", appVersion: "1.0.0", updated: "2026-11-15T02:00:00Z" },
    ]);
    expect(unreadable).toBe(1);
    // The list asks for metadata only, of helm's own Secrets, and reads only the latest revision's data.
    const first = json.mock.calls[0]!;
    expect(first[0]).toBe("/api/v1/secrets?labelSelector=owner%3Dhelm&fieldSelector=type%3Dhelm.sh%2Frelease.v1");
    expect(first[1]?.headers).toEqual({ Accept: expect.stringContaining("PartialObjectMetadataList") });
    expect(json.mock.calls.some(([p]) => p.endsWith("demo.v1"))).toBe(false);
    expect((await listReleases(client, "apps")).releases.map((r) => r.name)).toEqual(["api"]);
  });

  it("gives the window values with secrets hidden, the manifest without Secret values, its objects and the history", async () => {
    const { client } = fakeClient({
      "sh.helm.release.v1.demo.v1": { labels: labels("demo", 1, "superseded"), data: encode(release(1)) },
      "sh.helm.release.v1.demo.v2": { labels: labels("demo", 2, "deployed"), data: encode(release(2)) },
    });
    const d = await getRelease(client, "shop", "demo");
    expect(d.release).toMatchObject({ name: "demo", revision: 2, status: "deployed" });
    expect(d.latest).toBe(2);
    expect(d.notes).toBe("Visit http://demo");
    expect(d.values.user).toBe("message: hi\nauth:\n  adminPassword: <hidden · 15 characters>\n  apiKey: <hidden · 15 characters>\nimage: null\n");
    expect(d.hidden).toEqual({ user: 2, all: 2 });
    // All values: the chart's under yours; your null removes the chart's image.
    expect(d.values.all).toBe("replicaCount: 1\nmessage: hi\nauth:\n  adminPassword: <hidden · 15 characters>\n  existingSecret: \"\"\n  apiKey: <hidden · 15 characters>\n");
    for (const v of [d.values.user, d.values.all, d.manifest]) expect(v).not.toMatch(/s3cret-dev-pass|demo-key-123456|czNjcmV0LWRldi1wYXNz|plain-token-value/);
    expect(d.manifest).toContain("# Source: demo/templates/secret.yaml");
    expect(d.manifest).toContain("password: <hidden · 20 base64 characters>");
    expect(d.manifest).toContain("token: <hidden · 17 characters>");
    expect(d.manifest).toContain("message: hello");
    expect(d.manifestHidden).toBe(2);
    expect(d.objects).toEqual([
      { kind: "Secret", name: "demo-auth", apiVersion: "v1", namespace: "shop" },
      { kind: "ConfigMap", name: "demo", apiVersion: "v1", namespace: "shop" },
      { kind: "Deployment", name: "demo", apiVersion: "apps/v1", namespace: "other" },
    ]);
    expect(d.history.map((h) => [h.revision, h.status, h.description])).toEqual([[2, "deployed", "Upgrade complete"], [1, "superseded", "Install complete"]]);

    const old = await getRelease(client, "shop", "demo", 1);
    expect(old.release.revision).toBe(1);
    expect(old.latest).toBe(2);
    expect(old.values.user).toContain("message: hello");
    await expect(getRelease(client, "shop", "demo", 9)).rejects.toMatchObject({ status: 404 });
    await expect(getRelease(client, "shop", "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("knows a secret's key from a pointer to one", () => {
    for (const k of ["password", "adminPassword", "root-password", "postgresPassword", "secret", "clientSecret", "token", "authToken", "apiKey", "api_key", "secretKey", "accessKey", "privateKey", "credentials", "dsn", "connectionString", "webhookUrl"]) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
    for (const k of ["existingSecret", "secretName", "secretKeyRef", "tokenKey", "passwordKey", "tokenTTL", "passwordEnabled", "usePassword", "existingSecretPasswordKey", "replicas", "key", "name"]) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });

  it("hides credential-shaped text anywhere, merges like Helm, and never touches a prototype", () => {
    const h = hideSecrets({ url: "postgres://app:hunter22@db:5432/app", note: "ok", list: [{ password: "x1" }], n: 3, flag: true, empty: { password: "" } });
    expect(h.value).toEqual({ url: "postgres://app:<redacted>@db:5432/app", note: "ok", list: [{ password: "<hidden · 2 characters>" }], n: 3, flag: true, empty: { password: "" } });
    expect(h.hidden).toBe(2);
    expect(coalesce({ a: { b: 1, c: 2 }, d: 1 }, { a: { c: 3 }, d: null, e: [1] })).toEqual({ a: { b: 1, c: 3 }, e: [1] });
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    expect(coalesce({}, evil)).toEqual({ a: 1 });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("drops a manifest document it can't read rather than show it raw", () => {
    const m = manifestForWindow("apiVersion: v1\nkind: Secret\nmetadata: {name: x}\ndata:\n  k: v\n  - broken: [\n", "shop");
    expect(m.text).not.toContain("k: v");
    expect(m.text).toContain("couldn't read");
  });

  describe("the security review's cases (wave 4, part 4)", () => {
    it("knows a user's password, plurals and env names are secrets, and switches are not", () => {
      for (const k of ["userPassword", "user_password", "userToken", "userSecret", "userApiKey", "passwords", "tokens", "apiKeys", "DB_PASSWORD", "PRIVATE_KEY", "secret_key"]) expect(isSensitiveKey(k), k).toBe(true);
      for (const k of ["usePassword", "enablePassword", "createToken", "existingSecret", "tokenKey", "passwordKey", "secretKeyRef", "secretName"]) expect(isSensitiveKey(k), k).toBe(false);
    });

    it("hides everything under a secret's key but its pointers, and an env entry's value", () => {
      const h = hideSecrets({ token: ["abc12345", "def67890"], password: { value: "hunter22", name: "keep-me", enabled: true }, env: [{ name: "DB_PASSWORD", value: "pg-pass-1" }, { name: "LOG_LEVEL", value: "debug" }] });
      expect(h.value).toEqual({
        token: ["<hidden · 8 characters>", "<hidden · 8 characters>"],
        password: { value: "<hidden · 8 characters>", name: "keep-me", enabled: true },
        env: [{ name: "DB_PASSWORD", value: "<hidden · 9 characters>" }, { name: "LOG_LEVEL", value: "debug" }],
      });
      expect(h.literals.sort()).toEqual(["abc12345", "def67890", "hunter22", "pg-pass-1"]);
    });

    it("hides the values' secrets in the notes and the rest of the manifest, and a Secret inside a List", async () => {
      const MAN = `${MANIFEST}---
apiVersion: v1
kind: ConfigMap
metadata: {name: leaky}
data:
  conf: "admin=s3cret-dev-pass"
---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Secret
    metadata: {name: inner}
    data: {password: "aW5uZXI="}
`;
      const { client } = fakeClient({ "sh.helm.release.v1.demo.v1": { labels: labels("demo", 1, "deployed"), data: encode(release(1, { manifest: MAN, info: { status: "deployed", notes: "Log in with s3cret-dev-pass, Bearer abcdefghijklmnopqrstu" } })) } });
      const d = await getRelease(client, "shop", "demo");
      expect(d.notes).toBe("Log in with <hidden>, <redacted auth header>");
      expect(d.manifest).not.toContain("s3cret-dev-pass");
      expect(d.manifest).not.toContain("aW5uZXI=");
      expect(d.manifest).toContain("password: <hidden · 8 base64 characters>");
    });

    it("cuts the manifest at a document's start, never inside one", () => {
      const a = "kind: ConfigMap\nmetadata: {name: a}\n";
      const b = "---\napiVersion: v1\ndata:\n  password: c2VjcmV0\nkind: Secret\n";
      expect(wholeDocuments(a + b, a.length + 10)).toEqual({ shown: a, cut: true });
      expect(wholeDocuments(a + b, 10_000)).toEqual({ shown: a + b, cut: false });
    });

    it("scrubs long text in linear time, and a label that isn't a time is no time", async () => {
      const t = Date.now();
      redactText("a.".repeat(200_000));
      expect(Date.now() - t).toBeLessThan(2000);
      expect(hideSecrets({ note: "x".repeat(50_000) }).value).toEqual({ note: expect.stringMatching(/… \(33616 more characters\)$/) });
      const { client } = fakeClient({ "sh.helm.release.v1.demo.v1": { labels: { ...labels("demo", 1, "deployed"), modifiedAt: "soon" }, data: encode(release(1, { info: { status: "deployed" } })) } });
      expect((await getRelease(client, "shop", "demo")).release.updated).toBeUndefined();
    });
  });
});
