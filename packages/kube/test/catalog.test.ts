import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kubeconfigPaths, listContexts } from "../src/catalog.js";
import { withoutSecretValues } from "../src/client.js";

const write = (dir: string, name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe("listContexts", () => {
  it("merges files the way kubectl does and never reads credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-cat-"));
    const a = write(dir, "a", `
clusters: [{name: dev, cluster: {server: "https://dev:6443"}}]
users: [{name: me, user: {token: secret-token}}]
contexts: [{name: dev, context: {cluster: dev, user: me, namespace: apps}}]
current-context: dev
`);
    const b = write(dir, "b", `
clusters: [{name: dev, cluster: {server: "https://other"}}, {name: prod, cluster: {server: "https://prod:6443"}}]
contexts: [{name: prod, context: {cluster: prod, user: me}}, {name: dev, context: {cluster: prod, user: x}}]
current-context: prod
`);
    const got = listContexts([a, b, join(dir, "missing")]);
    expect(got).toEqual([
      { name: "dev", cluster: "dev", user: "me", server: "https://dev:6443", namespace: "apps", current: true },
      { name: "prod", cluster: "prod", user: "me", server: "https://prod:6443", current: false },
    ]);
    expect(JSON.stringify(got)).not.toContain("secret-token");
  });

  it("uses KUBECONFIG, else ~/.kube/config", () => {
    expect(kubeconfigPaths({ KUBECONFIG: "/a:/b" })).toEqual(["/a", "/b"]);
    expect(kubeconfigPaths({})[0]).toMatch(/\.kube\/config$/);
  });
});

describe("withoutSecretValues", () => {
  it("keeps keys and sizes, never values, and drops last-applied", () => {
    const s = withoutSecretValues({
      kind: "Secret",
      metadata: { name: "db", uid: "u", annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"data":{"pw":"aHVudGVyMg=="}}', keep: "x" } },
      data: { pw: "aHVudGVyMg==" },
      stringData: { token: "abc" },
    } as any);
    expect(JSON.stringify(s)).not.toMatch(/aHVudGVyMg|hunter2|"abc"/);
    expect(s).toMatchObject({ data: { pw: "<7 bytes>" }, metadata: { annotations: { keep: "x" } } });
    expect(withoutSecretValues({ kind: "ConfigMap", metadata: { name: "c", uid: "u" }, data: { a: "1" } } as any))
      .toMatchObject({ data: { a: "1" } });
  });
});
