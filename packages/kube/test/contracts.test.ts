import { channels, ResourceRef } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { refPath } from "../src/client.js";

describe("IPC contracts", () => {
  it("accept real Kubernetes names", () => {
    for (const ref of [
      { group: "", version: "v1", resource: "pods", namespace: "kube-system", name: "coredns-7db6d8ff4d-x2v5k" },
      { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterroles", name: "system:controller:job-controller" },
      { group: "apiextensions.k8s.io", version: "v1", resource: "customresourcedefinitions", name: "widgets.example.com" },
      { group: "", version: "v1", resource: "events", namespace: "a", name: "p1.17f2a3b4c5d6e7f8" },
    ]) expect(ResourceRef.safeParse(ref).success, ref.name).toBe(true);
  });

  it("refuse anything that could change the API path", () => {
    const base = { group: "", version: "v1", resource: "pods", namespace: "a", name: "p1" };
    for (const bad of [
      { resource: "secrets?x=" }, { resource: "secrets/x" }, { name: ".." }, { name: "." }, { name: "a/b" }, { name: "a%2fb" },
      { name: "a?b" }, { name: "a#b" }, { name: "a\\b" }, { name: "a b" }, { name: "a\u0000" }, { namespace: "../kube-system" },
      { namespace: "A" }, { group: "apps/v1" }, { version: "v1/../" }, { name: "" },
    ]) expect(ResourceRef.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it("build only canonical paths from what they accept", () => {
    const ref = ResourceRef.parse({ group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterroles", name: "system:aggregate-to-view" });
    expect(refPath(ref)).toBe("/apis/rbac.authorization.k8s.io/v1/clusterroles/system:aggregate-to-view");
  });

  it("hold handles, uids and subscriptions to their shapes", () => {
    expect(channels["resource:events"].safeParse({ handle: "short", uid: "u" }).success).toBe(false);
    expect(channels["resource:events"].safeParse({ handle: "handleAAAA1", uid: "0f8e-12" }).success).toBe(true);
    expect(channels["resource:events"].safeParse({ handle: "handleAAAA1", uid: "x,involvedObject.name=y" }).success).toBe(false);
    expect(channels["cluster:access"].safeParse({ handle: "handleAAAA1", checks: [{ verb: "*", group: "*", resource: "*" }] }).success).toBe(true);
  });

  it("hold a forward to Kubernetes names and ports above 1023 on this Mac", () => {
    const start = channels["forward:start"];
    const ok = { handle: "handleAAAA1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: 8080, keep: true };
    expect(start.safeParse(ok).success).toBe(true);
    for (const bad of [
      { localPort: 80 }, { localPort: 65536 }, { port: 0 }, { port: 8080.5 }, { kind: "node" },
      { namespace: "Shop" }, { namespace: "a/b" }, { name: "x/../../kube-system" }, { name: "web?a=b" }, { name: ".." },
    ]) expect(start.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(start.safeParse({ ...ok, extra: 1 }).data).not.toHaveProperty("extra");
    for (const ch of ["forward:stop", "forward:remove", "forward:open"] as const) {
      expect(channels[ch].safeParse({ id: "fwAAAAAAAAAA" }).success).toBe(true);
      expect(channels[ch].safeParse({ id: "fw../../x" }).success).toBe(false);
    }
    expect(channels["forward:check"].safeParse({ port: 1023 }).success).toBe(false);
  });

  it("hold connections to a provider, a flow id and a token of that provider's shape", () => {
    const gh = "ghp_" + "a".repeat(36);
    const lin = "lin_api_" + "b".repeat(40);
    const token = channels["conn:token"];
    expect(token.safeParse({ provider: "github", token: gh }).success).toBe(true);
    expect(token.safeParse({ provider: "github", token: "github_pat_11AB" + "c".repeat(40) }).success).toBe(true);
    expect(token.safeParse({ provider: "linear", token: lin }).success).toBe(true);
    for (const bad of [
      { provider: "github", token: lin }, { provider: "linear", token: gh }, { provider: "gitlab", token: gh },
      { provider: "github", token: gh + "\n" }, { provider: "github", token: ` ${gh}` }, { provider: "github", token: "ghp_short" },
      { provider: "github", token: "ghp_" + "a".repeat(400) }, { provider: "github", token: "Bearer " + gh },
    ]) expect(token.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    expect(channels["conn:cancel"].safeParse({ flow: "fl" + "A".repeat(16) }).success).toBe(true);
    for (const flow of ["fl" + "A".repeat(15), "fl../../" + "A".repeat(10), "xx" + "A".repeat(16)]) expect(channels["conn:cancel"].safeParse({ flow }).success).toBe(false);
    expect(channels["conn:linear-signin"].safeParse({ mode: "autonomous" }).success).toBe(false);
    expect(channels["conn:set"].safeParse({ provider: "linear", mode: "read", readsAuto: false }).success).toBe(true);
    // No channel takes an address.
    expect(channels["conn:test"].safeParse({ provider: "github", url: "https://evil.example" }).data).not.toHaveProperty("url");
  });
  it("hold Google Cloud names to Google's shapes before they reach a path or a query (D87)", () => {
    const res = channels["gcp:resources"];
    expect(res.safeParse({ project: "demo-shop", assetType: "compute.googleapis.com/Instance", query: "state:RUNNING", offset: 500 }).success).toBe(true);
    for (const bad of [
      { project: "Demo-Shop" }, { project: "demo" }, { project: "demo-shop-" }, { project: "demo-shop/../x" }, { project: "demo-shop:x" },
      { project: "demo-shop", assetType: "compute.googleapis.com" }, { project: "demo-shop", assetType: "compute.googleapis.com/../x" },
      { project: "demo-shop", query: "a\nb" }, { project: "demo-shop", query: "x".repeat(501) }, { project: "demo-shop", offset: 5001 },
    ]) expect(res.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const one = channels["gcp:resource"];
    expect(one.safeParse({ project: "demo-shop", name: "//storage.googleapis.com/demo-shop-assets" }).success).toBe(true);
    for (const name of ['//x/a" OR name:*', "//x/a\\b", "storage.googleapis.com/x", "//x/a\u0007", "//" + "a".repeat(1000)]) {
      expect(one.safeParse({ project: "demo-shop", name }).success, name.slice(0, 40)).toBe(false);
    }
    expect(channels["gcp:choose"].safeParse({ projects: Array.from({ length: 21 }, (_, i) => `project-${i + 10}`) }).success).toBe(false);
    // No channel takes an address or a token.
    expect(channels["gcp:status"].safeParse({ endpoint: "http://127.0.0.1:1" }).data).not.toHaveProperty("endpoint");
    expect(channels["gcp:projects"].safeParse({ token: "ya29.x" }).data).not.toHaveProperty("token");
  });

  it("takes Claude's Google Cloud reading only on its own channel, and no cloud cluster's yes from the page (part 5, L3)", () => {
    // gcp:choose no longer turns on what Claude reads (L6 of part 4's review): the key is dropped.
    expect(channels["gcp:choose"].safeParse({ projects: ["demo-shop"], agentRead: true }).data).not.toHaveProperty("agentRead");
    expect(channels["gcp:agent-read"].safeParse({ on: true }).success).toBe(true);
    expect(channels["gcp:agent-read"].safeParse({ on: "yes" }).success).toBe(false);
    // Main asks the cloud-cluster question in a native dialog: a page's `cloud: true` is dropped, never a yes.
    expect(channels["cluster:connect"].safeParse({ context: "gke_demo-shop_us-central1_shop-prod", cloud: true }).data).not.toHaveProperty("cloud");
    expect(channels["cluster:connect"].safeParse({ context: "x", kubeconfig: "/tmp/k" }).data).not.toHaveProperty("kubeconfig");
  });
});

// Security review of wave 7 part 3, L10: Clickland's channels refuse what main would refuse again (the second line).
describe("Clickland's history channels", () => {
  const scope = { kind: "pod", namespace: "landlens-dev", name: "ledger-worker-1" };
  const base = { handle: "handle-0001", scope, range: "1h" };
  it("refuse a filter past 200 characters or with a line break, a scope name with a quote, an uppercase trace id", () => {
    expect(channels["clickland:logs"].safeParse({ ...base, filter: "x".repeat(200) }).success).toBe(true);
    expect(channels["clickland:logs"].safeParse({ ...base, filter: "x".repeat(201) }).success).toBe(false);
    expect(channels["clickland:logs"].safeParse({ ...base, filter: "a\nb" }).success).toBe(false);
    expect(channels["clickland:logs"].safeParse({ ...base, scope: { ...scope, name: `x" OR y` } }).success).toBe(false);
    expect(channels["clickland:traces"].safeParse({ ...base, scope: { ...scope, namespace: `a"b` } }).success).toBe(false);
    expect(channels["clickland:trace"].safeParse({ handle: "handle-0001", id: "ab" }).success).toBe(true);
    expect(channels["clickland:trace"].safeParse({ handle: "handle-0001", id: "AB" }).success).toBe(false);
    expect(channels["clickland:open"].safeParse({ ...base, signal: "logs", trace: "ABC" }).success).toBe(false);
    expect(channels["clickland:open"].safeParse({ ...base, signal: "logs", scope: { ...scope, container: "Worker" } }).success).toBe(false);
  });
});

describe("your actions' channels (wave 8, D144)", () => {
  const ref = { group: "apps", version: "v1", resource: "deployments", namespace: "landlens-dev", name: "hands-web" };
  const review = channels["action:review"];
  it("take an action's closed shape and nothing else", () => {
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "scale", target: ref, replicas: 3 } }).success).toBe(true);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "delete", targets: [ref, { ...ref, name: "b" }] } }).success).toBe(true);
    // A title, a body, a path, an extra field, a kind that isn't one: refused.
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "scale", target: ref, replicas: 3, title: "Scale nothing" } }).success).toBe(false);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "scale", target: { ...ref, body: {} }, replicas: 3 } }).success).toBe(false);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "patch", target: ref } }).success).toBe(false);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "scale", target: ref, replicas: 1001 } }).success).toBe(false);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "delete", targets: Array.from({ length: 51 }, () => ref) } }).success).toBe(false);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "delete", targets: [{ ...ref, name: "../x" }] } }).success).toBe(false);
    expect(review.safeParse({ handle: "handle-0001", action: { kind: "trigger", target: ref }, native: true }).success).toBe(false);
  });
  it("apply names a review and its digest only", () => {
    const apply = channels["action:apply"];
    expect(apply.safeParse({ handle: "handle-0001", id: "edAAAAAAAAAAAA", digest: "a".repeat(64) }).success).toBe(true);
    expect(apply.safeParse({ handle: "handle-0001", id: "edAAAAAAAAAAAA" }).success).toBe(false);
    expect(apply.safeParse({ handle: "handle-0001", id: "edAAAAAAAAAAAA", digest: "a".repeat(64), confirmed: true }).success).toBe(false);
    expect(channels["action:log"].safeParse({ context: "orbstack", limit: 500 }).success).toBe(false);
  });
});
