// Which kinds the cluster serves, from API discovery (aggregated v2 when the server has it, else per group).
import type { ResourceType } from "@landlens/contracts";
import type { KubeClient } from "./client.js";

const AGGREGATED = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;q=0.9";

export async function discover(client: KubeClient): Promise<ResourceType[]> {
  const [core, groups] = await Promise.all([
    client.json("/api", { headers: { Accept: AGGREGATED } }),
    client.json("/apis", { headers: { Accept: AGGREGATED } }),
  ]);
  if (core?.kind === "APIGroupDiscoveryList" && groups?.kind === "APIGroupDiscoveryList") {
    return [...fromAggregated(core), ...fromAggregated(groups)];
  }
  return legacy(client, groups);
}

/** Aggregated discovery: one document per side, preferred version first. */
export function fromAggregated(list: any): ResourceType[] {
  const out: ResourceType[] = [];
  for (const g of list.items ?? []) {
    const group: string = g.metadata?.name ?? "";
    const v = g.versions?.[0]; // the server lists the preferred version first
    if (!v) continue;
    for (const r of v.resources ?? []) {
      out.push({
        group,
        version: v.version,
        resource: r.resource,
        kind: r.responseKind?.kind ?? r.resource,
        namespaced: r.scope === "Namespaced",
        verbs: r.verbs ?? [],
      });
    }
  }
  return out;
}

async function legacy(client: KubeClient, groups: any): Promise<ResourceType[]> {
  const lists: { group: string; version: string; path: string }[] = [{ group: "", version: "v1", path: "/api/v1" }];
  for (const g of groups?.groups ?? []) {
    const pv = g.preferredVersion?.version ?? g.versions?.[0]?.version;
    if (pv) lists.push({ group: g.name, version: pv, path: `/apis/${g.name}/${pv}` });
  }
  const results = await Promise.allSettled(lists.map((l) => client.json(l.path)));
  const out: ResourceType[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return; // an unavailable aggregated API shouldn't hide the rest
    const l = lists[i]!;
    out.push(...fromResourceList(l.group, l.version, r.value));
  });
  return out;
}

export function fromResourceList(group: string, version: string, list: any): ResourceType[] {
  return (list.resources ?? [])
    .filter((r: any) => !String(r.name).includes("/")) // subresources such as pods/log
    .map((r: any) => ({ group, version, resource: r.name, kind: r.kind, namespaced: !!r.namespaced, verbs: r.verbs ?? [] }));
}
