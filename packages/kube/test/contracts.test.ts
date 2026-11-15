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
});
