// The ⌘K palette's names across kinds (wave 4, part 4; D45): metadata-only lists in capped pages, names out, nothing else.
import { describe, expect, it, vi } from "vitest";
import type { ResourceType } from "@landlens/contracts";
import { MAX_PER_KIND, searchIndex } from "../src/search.js";
import type { KubeClient } from "../src/client.js";

const type = (group: string, resource: string, kind: string, namespaced = true, verbs = ["list", "watch", "get"]): ResourceType =>
  ({ group, version: "v1", resource, kind, namespaced, verbs });

describe("the palette's names", () => {
  it("lists each searchable kind the cluster serves, metadata only, in pages, and passes on names and namespaces alone", async () => {
    const jsonText = vi.fn(async (path: string, _opts: { maxBytes: number; headers?: Record<string, string> }) => {
      const page = (value: unknown) => ({ value, bytes: JSON.stringify(value).length });
      const q = new URLSearchParams(path.split("?")[1]);
      if (path.startsWith("/api/v1/secrets")) return page({ items: [{ metadata: { name: "db-auth", namespace: "shop", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"czNjcmV0\"}}" } }, data: { password: "czNjcmV0" } }] });
      if (path.startsWith("/apis/apps/v1/deployments"))
        return q.get("continue") ? page({ items: [{ metadata: { name: "api", namespace: "shop" } }] }) : page({ items: [{ metadata: { name: "web", namespace: "shop" } }], metadata: { continue: "abc" } });
      // A kind that never ends: cut at the cap.
      if (path.startsWith("/api/v1/configmaps")) return page({ items: Array.from({ length: 500 }, (_, i) => ({ metadata: { name: `cm-${q.get("continue") ?? ""}-${i}`, namespace: "x" } })), metadata: { continue: `${Number(q.get("continue") ?? 0) + 1}` } });
      if (path.startsWith("/api/v1/nodes")) return page({ items: [{ metadata: { name: "orbstack" } }, { metadata: { name: 7 } }] });
      if (path.startsWith("/api/v1/pods")) throw Object.assign(new Error("forbidden"), { status: 403 });
      return page({ items: [] });
    });
    const types = [
      type("", "pods", "Pod"), type("apps", "deployments", "Deployment"), type("", "secrets", "Secret"), type("", "nodes", "Node", false),
      type("", "configmaps", "ConfigMap"), type("", "events", "Event"), type("example.com", "widgets", "Widget"), type("", "services", "Service", true, ["get"]),
    ];
    const r = await searchIndex({ jsonText } as unknown as KubeClient, types);
    const notCm = r.entries.filter((e) => e.resource !== "configmaps");
    expect(notCm).toEqual([
      { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", name: "web", namespace: "shop" },
      { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", name: "api", namespace: "shop" },
      { group: "", version: "v1", resource: "secrets", kind: "Secret", name: "db-auth", namespace: "shop" },
      { group: "", version: "v1", resource: "nodes", kind: "Node", name: "orbstack" },
    ]);
    expect(r.entries.filter((e) => e.resource === "configmaps")).toHaveLength(MAX_PER_KIND);
    expect(JSON.stringify(r)).not.toContain("czNjcmV0");
    expect(r.unreadable).toEqual(["pods"]);
    expect(r.cut).toEqual(["configmaps"]);
    // Only searchable kinds that can be listed; metadata only, in capped pages of 500.
    expect(new Set(jsonText.mock.calls.map(([p]) => p.split("?")[0]))).toEqual(new Set(["/api/v1/pods", "/apis/apps/v1/deployments", "/api/v1/secrets", "/api/v1/nodes", "/api/v1/configmaps"]));
    for (const [p, o] of jsonText.mock.calls) {
      expect(p).toContain("limit=500");
      expect(o.headers).toEqual({ Accept: expect.stringContaining("as=PartialObjectMetadataList") });
      expect(o.maxBytes).toBe(16 * 1048576);
    }
  });
});
