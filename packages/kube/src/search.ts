// The ⌘K palette's objects across kinds (wave 4, part 4; D45): names only, from metadata-only lists read as you.
// Nothing but a kind, a name and a namespace leaves this file, so a Secret's name can be found and its data never
// travels (a metadata list carries no data, and its annotations are dropped here too).
import type { ResourceType, SearchEntry } from "@landlens/contracts";
import { apiPath, type KubeClient } from "./client.js";

/** The kinds the palette searches (D45): workloads, Services, Ingresses, ConfigMaps, Secrets, claims, nodes, namespaces. */
export const SEARCH_KINDS: readonly { group: string; resource: string }[] = [
  { group: "", resource: "pods" },
  { group: "apps", resource: "deployments" },
  { group: "apps", resource: "statefulsets" },
  { group: "apps", resource: "daemonsets" },
  { group: "batch", resource: "jobs" },
  { group: "batch", resource: "cronjobs" },
  { group: "", resource: "services" },
  { group: "networking.k8s.io", resource: "ingresses" },
  { group: "", resource: "configmaps" },
  { group: "", resource: "secrets" },
  { group: "", resource: "persistentvolumeclaims" },
  { group: "", resource: "nodes" },
  { group: "", resource: "namespaces" },
];
/** At most this many names of one kind; a kind with more says so. */
export const MAX_PER_KIND = 2000;
/** Read in pages of this many, each at most 16 MB (metadata carries annotations), all of a kind at most 64 MB. */
const PAGE = 500;
const MAX_PAGE_BYTES = 16 * 1048576;
const MAX_KIND_BYTES = 64 * 1048576;
const META = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json;q=0.9";

export type SearchIndex = { entries: SearchEntry[]; cut: string[]; unreadable: string[] };

/** Every searchable kind the cluster serves, listed at once; a kind you can't list is named, not fatal. */
export async function searchIndex(client: KubeClient, types: ResourceType[], signal?: AbortSignal): Promise<SearchIndex> {
  const served = SEARCH_KINDS.map((k) => types.find((t) => t.group === k.group && t.resource === k.resource && t.verbs.includes("list"))).filter((t): t is ResourceType => !!t);
  const cut: string[] = [];
  const unreadable: string[] = [];
  const lists = await Promise.all(served.map(async (t) => {
    try {
      // Pages, each capped as it streams in, so annotations can't make one read hold gigabytes (security review,
      // part 4, finding 10).
      const out: SearchEntry[] = [];
      let next = "";
      let bytes = 0;
      do {
        const q = new URLSearchParams({ limit: String(PAGE), ...(next ? { continue: next } : {}) });
        const page = await client.jsonText(`${apiPath(t)}?${q}`, { headers: { Accept: META }, maxBytes: MAX_PAGE_BYTES, ...(signal ? { signal } : {}) });
        bytes += page.bytes;
        for (const o of ((page.value.items ?? []) as { metadata?: { name?: unknown; namespace?: unknown } }[])) {
          const name = o.metadata?.name;
          const ns = o.metadata?.namespace;
          if (typeof name === "string") out.push({ group: t.group, version: t.version, resource: t.resource, kind: t.kind, name, ...(t.namespaced && typeof ns === "string" ? { namespace: ns } : {}) });
        }
        next = typeof page.value.metadata?.continue === "string" ? page.value.metadata.continue : "";
      } while (next && out.length < MAX_PER_KIND && bytes < MAX_KIND_BYTES);
      if (next) cut.push(t.resource);
      return out.slice(0, MAX_PER_KIND);
    } catch {
      unreadable.push(t.resource);
      return [];
    }
  }));
  return { entries: lists.flat(), cut, unreadable };
}
