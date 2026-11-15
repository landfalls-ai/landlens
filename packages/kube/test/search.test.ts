// The ⌘K palette's names across kinds (wave 4, part 4; D45): metadata-only lists, names out, nothing else.
import { describe, expect, it, vi } from "vitest";
import type { ResourceType } from "@landlens/contracts";
import { MAX_PER_KIND, searchIndex } from "../src/search.js";
import type { KubeClient } from "../src/client.js";

const type = (group: string, resource: string, kind: string, namespaced = true, verbs = ["list", "watch", "get"]): ResourceType =>
  ({ group, version: group === "apps" ? "v1" : "v1", resource, kind, namespaced, verbs });

describe("the palette's names", () => {
  it("lists each searchable kind the cluster serves, metadata only, and passes on names and namespaces alone", async () => {
    const json = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.startsWith("/api/v1/secrets")) return { items: [{ metadata: { name: "db-auth", namespace: "shop", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"czNjcmV0\"}}" } }, data: { password: "czNjcmV0" } }] };
      if (path.startsWith("/apis/apps/v1/deployments")) return { items: [{ metadata: { name: "web", namespace: "shop" } }], metadata: { continue: "abc" } };
      if (path.startsWith("/api/v1/nodes")) return { items: [{ metadata: { name: "orbstack" } }, { metadata: { name: 7 } }] };
      if (path.startsWith("/api/v1/pods")) throw Object.assign(new Error("forbidden"), { status: 403 });
      return { items: [] };
    });
    const types = [
      type("", "pods", "Pod"), type("apps", "deployments", "Deployment"), type("", "secrets", "Secret"), type("", "nodes", "Node", false),
      type("", "events", "Event"), type("example.com", "widgets", "Widget"), type("", "configmaps", "ConfigMap", true, ["get"]),
    ];
    const r = await searchIndex({ json } as unknown as KubeClient, types);
    expect(r.entries).toEqual([
      { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", name: "web", namespace: "shop" },
      { group: "", version: "v1", resource: "secrets", kind: "Secret", name: "db-auth", namespace: "shop" },
      { group: "", version: "v1", resource: "nodes", kind: "Node", name: "orbstack" },
    ]);
    expect(JSON.stringify(r)).not.toContain("czNjcmV0");
    expect(r.unreadable).toEqual(["pods"]);
    expect(r.cut).toEqual(["deployments"]);
    // Only the searchable kinds that can be listed, each metadata only and capped.
    const paths = json.mock.calls.map(([p]) => p).sort();
    expect(paths).toEqual([`/api/v1/nodes?limit=${MAX_PER_KIND}`, `/api/v1/pods?limit=${MAX_PER_KIND}`, `/api/v1/secrets?limit=${MAX_PER_KIND}`, `/apis/apps/v1/deployments?limit=${MAX_PER_KIND}`]);
    for (const [, init] of json.mock.calls) expect(init?.headers).toEqual({ Accept: expect.stringContaining("as=PartialObjectMetadataList") });
  });
});
