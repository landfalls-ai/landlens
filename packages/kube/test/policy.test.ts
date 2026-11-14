import { describe, expect, it } from "vitest";
import { agentApprovedPolicy, agentReadOnlyPolicy, authorize, isCanonicalPath, parseRequest, type Policy } from "../src/policy.js";

const agent = agentReadOnlyPolicy();
const ide: Policy = { access: "full" };
const allowed = (p: Policy, method: string, path: string) => authorize(p, parseRequest(method, path)).allow;

describe("parseRequest", () => {
  it.each([
    ["GET", "/api/v1/pods", { group: "", resource: "pods", verb: "list", namespace: undefined }],
    ["GET", "/api/v1/namespaces/a/pods?watch=true&resourceVersion=5", { resource: "pods", verb: "watch", namespace: "a" }],
    ["GET", "/api/v1/watch/namespaces/a/pods", { resource: "pods", verb: "watch", namespace: "a" }],
    ["GET", "/api/v1/namespaces/a/pods/p1", { resource: "pods", name: "p1", verb: "get" }],
    ["GET", "/api/v1/namespaces/a/pods/p1/log?follow=true", { resource: "pods", name: "p1", subresource: "log", verb: "get" }],
    ["GET", "/api/v1/namespaces/a/pods/p1/exec?command=sh", { subresource: "exec", verb: "connect" }],
    ["POST", "/api/v1/namespaces/a/pods/p1/portforward", { subresource: "portforward", verb: "connect" }],
    ["GET", "/api/v1/namespaces/a/services/s:80/proxy/metrics", { resource: "services", subresource: "proxy/metrics", verb: "connect" }],
    ["DELETE", "/apis/apps/v1/namespaces/a/deployments/d", { group: "apps", resource: "deployments", verb: "delete" }],
    ["DELETE", "/apis/apps/v1/namespaces/a/deployments", { verb: "deletecollection" }],
    ["PATCH", "/apis/apps/v1/namespaces/a/deployments/d/scale", { subresource: "scale", verb: "patch" }],
    ["GET", "/api/v1/namespaces/kube-system", { resource: "namespaces", name: "kube-system", verb: "get" }],
    ["GET", "/api/v1/namespaces", { resource: "namespaces", verb: "list" }],
  ])("%s %s", (method, path, want) => {
    expect(parseRequest(method, path)).toMatchObject({ kind: "resource", ...want });
  });

  it("treats discovery and version as non-resource", () => {
    for (const p of ["/api", "/apis", "/version", "/openapi/v3", "/apis/apps", "/api/v1"]) {
      expect(parseRequest("GET", p)).toMatchObject({ kind: "nonResource", verb: "get" });
    }
  });
});

describe("the agent's read-only policy", () => {
  it("reads workloads, logs, events, nodes and discovery", () => {
    for (const p of [
      "/api/v1/namespaces/a/pods", "/api/v1/namespaces/a/pods/p1", "/api/v1/namespaces/a/pods/p1/log?previous=true",
      "/api/v1/pods?watch=1", "/api/v1/nodes", "/apis/apps/v1/deployments", "/api/v1/events", "/apis", "/version",
      "/apis/metrics.k8s.io/v1beta1/namespaces/a/pods",
    ]) expect(allowed(agent, "GET", p), p).toBe(true);
  });

  it("never writes", () => {
    expect(allowed(agent, "DELETE", "/api/v1/namespaces/a/pods/p1")).toBe(false);
    expect(allowed(agent, "DELETE", "/api/v1/namespaces/a/pods")).toBe(false);
    expect(allowed(agent, "POST", "/apis/apps/v1/namespaces/a/deployments")).toBe(false);
    expect(allowed(agent, "PUT", "/apis/apps/v1/namespaces/a/deployments/d")).toBe(false);
    expect(allowed(agent, "PATCH", "/apis/apps/v1/namespaces/a/deployments/d/scale")).toBe(false);
    expect(allowed(agent, "POST", "/api/v1/namespaces/a/pods/p1/eviction")).toBe(false);
  });

  it("refuses server-side dry runs too: the agent proposes, Landlens applies", () => {
    expect(allowed(agent, "PATCH", "/apis/apps/v1/namespaces/a/deployments/d?dryRun=All")).toBe(false);
  });

  it("never opens a channel into a container or a service", () => {
    expect(allowed(agent, "GET", "/api/v1/namespaces/a/pods/p1/exec?command=sh&stdin=true")).toBe(false);
    expect(allowed(agent, "POST", "/api/v1/namespaces/a/pods/p1/exec?command=sh")).toBe(false);
    expect(allowed(agent, "GET", "/api/v1/namespaces/a/pods/p1/attach")).toBe(false);
    expect(allowed(agent, "POST", "/api/v1/namespaces/a/pods/p1/portforward")).toBe(false);
    expect(allowed(agent, "GET", "/api/v1/namespaces/a/services/s:80/proxy/admin")).toBe(false);
    expect(allowed(agent, "GET", "/api/v1/nodes/n1/proxy/configz")).toBe(false);
  });

  it("never reads Secrets, in any form", () => {
    expect(allowed(agent, "GET", "/api/v1/secrets")).toBe(false);
    expect(allowed(agent, "GET", "/api/v1/namespaces/a/secrets/db")).toBe(false);
    expect(allowed(agent, "GET", "/api/v1/namespaces/a/secrets?watch=true")).toBe(false);
    expect(allowed(agent, "GET", "/api/v1/watch/secrets")).toBe(false);
  });

  it("may ask the API server what it can do", () => {
    expect(allowed(agent, "POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews")).toBe(true);
    expect(allowed(agent, "POST", "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews")).toBe(true);
    expect(allowed(agent, "POST", "/apis/authorization.k8s.io/v1/subjectaccessreviews")).toBe(false);
  });

  it("stays inside its namespaces when limited", () => {
    const limited = agentReadOnlyPolicy(["landlens-dev"]);
    expect(allowed(limited, "GET", "/api/v1/namespaces/landlens-dev/pods")).toBe(true);
    expect(allowed(limited, "GET", "/api/v1/namespaces/kube-system/pods")).toBe(false);
    expect(allowed(limited, "GET", "/api/v1/pods")).toBe(false);
    expect(allowed(limited, "GET", "/apis/apps/v1/deployments?watch=true")).toBe(false);
    expect(allowed(limited, "GET", "/api/v1/nodes")).toBe(true);
    expect(allowed(limited, "GET", "/api/v1/namespaces")).toBe(true);
  });

  it("takes scope from discovery, and refuses kinds it can't place", () => {
    const limited = agentReadOnlyPolicy(["landlens-dev"]);
    const scope = new Map([["widgets.example.com", true], ["clusterthings.example.com", false]]);
    const scoped = (path: string) => authorize(limited, parseRequest("GET", path), (k) => scope.get(k)).allow;
    expect(scoped("/apis/example.com/v1/widgets")).toBe(false); // namespaced, all namespaces
    expect(scoped("/apis/example.com/v1/namespaces/landlens-dev/widgets")).toBe(true);
    expect(scoped("/apis/example.com/v1/clusterthings")).toBe(true);
    expect(scoped("/apis/other.io/v1/gadgets")).toBe(false); // unknown: fail closed
    expect(scoped("/apis/storage.k8s.io/v1/storageclasses")).toBe(true); // built-in cluster-scoped
  });
});

describe("non-resource paths for a read-only token", () => {
  it("allows version, discovery, OpenAPI and health only", () => {
    for (const p of ["/version", "/api", "/apis", "/api/v1", "/apis/apps", "/apis/apps/v1", "/openapi/v2", "/openapi/v3/apis/apps/v1",
      "/healthz", "/readyz/ping"]) expect(allowed(agent, "GET", p), p).toBe(true);
    for (const p of ["/metrics", "/logs/", "/logs/kube-apiserver.log", "/debug/pprof/heap", "/configz", "/flowcontrol"])
      expect(allowed(agent, "GET", p), p).toBe(false);
  });
});

describe("the IDE's full policy", () => {
  it("passes everything to the cluster's RBAC", () => {
    expect(allowed(ide, "DELETE", "/api/v1/namespaces/a/pods/p1")).toBe(true);
    expect(allowed(ide, "GET", "/api/v1/namespaces/a/pods/p1/exec")).toBe(true);
    expect(allowed(ide, "GET", "/api/v1/namespaces/a/secrets/db")).toBe(true);
  });
});

describe("isCanonicalPath", () => {
  it("refuses paths that could be read two ways", () => {
    for (const p of ["//api/v1/secrets", "/api/v1/namespaces/a/secret%73", "/api/v1/namespaces/a/x%2Fy", "/api/v1/../v1/secrets",
      "/api/v1/./secrets", "api/v1/pods", "/api\\v1", "/api/v1/pods#x", "/api/v1/pods\u0000", "/api/v1/po ds", "/api/v1/pods?x=\n"])
      expect(isCanonicalPath(p), JSON.stringify(p)).toBe(false);
    expect(isCanonicalPath("/api/v1/namespaces/a/pods?labelSelector=app%3Dx")).toBe(true);
  });
});

describe("the approval broker's write policy", () => {
  const approved = agentApprovedPolicy(["landlens-dev"]);
  it("reads, dry-runs and changes objects in its namespaces", () => {
    expect(allowed(approved, "GET", "/apis/apps/v1/namespaces/landlens-dev/deployments/d")).toBe(true);
    expect(allowed(approved, "PATCH", "/apis/apps/v1/namespaces/landlens-dev/deployments/d?dryRun=All")).toBe(true);
    expect(allowed(approved, "PATCH", "/apis/apps/v1/namespaces/landlens-dev/deployments/d")).toBe(true);
    expect(allowed(approved, "POST", "/api/v1/namespaces/landlens-dev/configmaps")).toBe(true);
    expect(allowed(approved, "DELETE", "/api/v1/namespaces/landlens-dev/configmaps/c")).toBe(true);
  });

  it("never touches Secrets or other namespaces", () => {
    expect(allowed(approved, "GET", "/api/v1/namespaces/landlens-dev/secrets/s")).toBe(false);
    expect(allowed(approved, "PATCH", "/api/v1/namespaces/landlens-dev/secrets/s")).toBe(false);
    expect(allowed(approved, "PATCH", "/apis/apps/v1/namespaces/kube-system/deployments/coredns")).toBe(false);
  });

  it("never opens a channel into a container or a service, and writes no non-resource path", () => {
    expect(allowed(approved, "POST", "/api/v1/namespaces/landlens-dev/pods/p1/exec?command=sh")).toBe(false);
    expect(allowed(approved, "GET", "/api/v1/namespaces/landlens-dev/pods/p1/attach")).toBe(false);
    expect(allowed(approved, "POST", "/api/v1/namespaces/landlens-dev/pods/p1/portforward")).toBe(false);
    expect(allowed(approved, "GET", "/api/v1/namespaces/landlens-dev/services/s:80/proxy/")).toBe(false);
    expect(allowed(approved, "POST", "/version")).toBe(false);
    expect(allowed(approved, "GET", "/metrics")).toBe(false);
  });

  it("allows only what the broker sends: no subresources, collections, watches or updates, nothing cluster-scoped", () => {
    expect(allowed(approved, "GET", "/apis/apps/v1/namespaces/landlens-dev/replicasets?labelSelector=app%3Dx")).toBe(true);
    for (const [m, p] of [
      ["POST", "/api/v1/namespaces/landlens-dev/serviceaccounts/default/token"],
      ["PATCH", "/api/v1/namespaces/landlens-dev/pods/p1/ephemeralcontainers"],
      ["PATCH", "/apis/apps/v1/namespaces/landlens-dev/deployments/d/status"],
      ["PATCH", "/apis/apps/v1/namespaces/landlens-dev/deployments/d/scale"],
      ["DELETE", "/api/v1/namespaces/landlens-dev/configmaps"],
      ["PUT", "/api/v1/namespaces/landlens-dev/configmaps/c"],
      ["GET", "/api/v1/namespaces/landlens-dev/configmaps"],
      ["GET", "/api/v1/namespaces/landlens-dev/configmaps?watch=true"],
      ["DELETE", "/api/v1/namespaces/landlens-dev"],
      ["PATCH", "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/x"],
      ["GET", "/api/v1/nodes/n1"],
    ] as const) expect(allowed(approved, m, p), `${m} ${p}`).toBe(false);
    // Without a namespace limit, a cluster-scoped object can be changed (the broker marks it danger).
    expect(allowed(agentApprovedPolicy(), "PATCH", "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/x")).toBe(true);
  });
});
