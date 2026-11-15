// Which kinds the cluster serves, from API discovery (aggregated v2 when the server has it, else per group).
import type { ResourceType } from "@landlens/contracts";
import type { KubeClient } from "./client.js";

const AGGREGATED = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;q=0.9";

export async function discover(client: KubeClient): Promise<ResourceType[]> {
  const [core, groups, crds] = await Promise.all([
    client.json("/api", { headers: { Accept: AGGREGATED } }),
    client.json("/apis", { headers: { Accept: AGGREGATED } }),
    crdNames(client),
  ]);
  const types = core?.kind === "APIGroupDiscoveryList" && groups?.kind === "APIGroupDiscoveryList"
    ? [...fromAggregated(core), ...fromAggregated(groups)]
    : await legacy(client, groups);
  return markCustom(types, crds);
}

/** The CRDs' names (`plural.group`), metadata only; undefined when your role can't list them. */
async function crdNames(client: KubeClient): Promise<Set<string> | undefined> {
  try {
    const list = await client.json("/apis/apiextensions.k8s.io/v1/customresourcedefinitions", {
      headers: { Accept: "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json;q=0.9" },
    });
    return new Set(((list?.items ?? []) as { metadata?: { name?: string } }[]).map((i) => i.metadata?.name ?? ""));
  } catch {
    return undefined;
  }
}

/** Groups Kubernetes itself serves (roughly: a CRD may also use a k8s.io group): used only without the CRD list. */
const BUILT_IN = /^(|apps|batch|autoscaling|policy)$|\.k8s\.io$/;

export function markCustom(types: ResourceType[], crds: Set<string> | undefined): ResourceType[] {
  return types.map((t) => {
    const custom = crds ? crds.has(`${t.resource}.${t.group}`) : !BUILT_IN.test(t.group);
    return custom ? { ...t, custom: true } : t;
  });
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
        ...(r.shortNames?.length ? { shortNames: r.shortNames } : {}),
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
    .map((r: any) => ({
      group, version, resource: r.name, kind: r.kind, namespaced: !!r.namespaced, verbs: r.verbs ?? [],
      ...(r.shortNames?.length ? { shortNames: r.shortNames } : {}),
    }));
}
