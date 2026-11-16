// Projects and their resources, read-only (spec D87): Resource Manager's projects:search and Cloud Asset's
// searchAllResources, paged, capped and checked. Every answer is zod-checked; every string that reaches the page is
// cut to 300 characters and stripped of control and format characters; a resource keeps at most 20 labels.
import { GCP_MAX_RESOURCES, GCP_PAGE, GcpAssetType, GcpProjectId, GcpQuery, GcpResourceName, type GcpProject, type GcpResource, type GcpTypeCount } from "@landlens/contracts";
import { z } from "zod";
import type { GcpClient } from "./client.js";
import { GcpError, SENTENCES } from "./errors.js";

export const MAX_PROJECTS = 2000;
export const MAX_PAGES = GCP_MAX_RESOURCES / GCP_PAGE;
/** The resource's JSON shown in the drawer is cut here. */
export const MAX_JSON = 256 * 1024;
export const READ_MASK = "name,assetType,displayName,location,state,createTime,updateTime,parentFullResourceName,labels";

const str = z.string().max(100_000);
const ProjectsPage = z.object({
  projects: z.array(z.object({ name: str.optional(), projectId: str.optional(), displayName: str.optional(), state: str.optional() }).passthrough()).optional(),
  nextPageToken: str.optional(),
});
const SearchResult = z.object({
  name: str,
  assetType: str,
  displayName: str.optional(),
  location: str.optional(),
  state: str.optional(),
  createTime: str.optional(),
  updateTime: str.optional(),
  parentFullResourceName: str.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  versionedResources: z.array(z.object({ version: str.optional(), resource: z.unknown().optional() }).passthrough()).optional(),
}).passthrough();
const SearchPage = z.object({ results: z.array(SearchResult).optional(), nextPageToken: str.optional() });

/**
 * Control, format and line/paragraph-separator characters out (bidi overrides, zero-width, U+2028/U+2029, and the
 * astral ones: the tag block U+E0000–U+E007F, which a person can't see and a model reads, and musical format marks),
 * then at most `max` characters. By Unicode property with the `u` flag, so nothing outside the BMP slips past (review
 * of wave 9 part 1, L2).
 */
export function clean(s: string, max = 300): string {
  const out = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  if (out.length <= max) return out;
  // Cut by code point, so a pair (an emoji) is never split into a lone surrogate (review of part 4, L4).
  const points = Array.from(out);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : out;
}

/** Control and format characters (bidi overrides, zero-width, line separators) a JSON text may carry in its strings. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
/**
 * A resource's JSON with every invisible character written as its `\uXXXX` escape: the same data, but a bidi override
 * can't reorder what the drawer shows (review of part 4, L4). They can only be inside strings, where the escape is
 * valid JSON.
 */
export const escapeInvisible = (json: string) => json.replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** All of a resource's labels, keys and values together, at most this many characters (review of part 4, L7). */
export const LABELS_MAX = 2_000;

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
  return r.data;
};

/** A checked project id, or a 400. */
export function checkProject(p: string): string {
  if (!GcpProjectId.safeParse(p).success) throw new GcpError(400, "That isn't a project id.");
  return p;
}

/** Every ACTIVE project you can see, at most 2,000. */
export async function searchProjects(client: GcpClient): Promise<{ projects: GcpProject[]; cut: boolean }> {
  const out: GcpProject[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PROJECTS / GCP_PAGE + 1; page++) {
    const body = parse(ProjectsPage, await client.get("cloudresourcemanager", "/v3/projects:search", { pageSize: String(GCP_PAGE), pageToken: token }));
    for (const p of body.projects ?? []) {
      if (p.state !== "ACTIVE" || !p.projectId || !GcpProjectId.safeParse(p.projectId).success) continue;
      if (out.length >= MAX_PROJECTS) return { projects: out, cut: true };
      const number = /^projects\/(\d{1,30})$/.exec(p.name ?? "")?.[1] ?? "";
      out.push({ id: p.projectId, name: clean(p.displayName || p.projectId, 300), number });
    }
    token = body.nextPageToken || undefined;
    if (!token) return { projects: out, cut: false };
  }
  return { projects: out, cut: true };
}

/** A search result as the page gets it. */
export function toResource(r: z.infer<typeof SearchResult>): GcpResource {
  const labels: (readonly [string, string])[] = [];
  let room = LABELS_MAX;
  for (const [k, v] of Object.entries(r.labels ?? {}).slice(0, 20)) {
    const pair = [clean(k, 63), clean(v, 300)] as const;
    room -= pair[0].length + pair[1].length;
    if (room < 0) break;
    labels.push(pair);
  }
  return {
    name: clean(r.name, 1000),
    assetType: clean(r.assetType, 161),
    ...(r.displayName ? { displayName: clean(r.displayName) } : {}),
    ...(r.location ? { location: clean(r.location) } : {}),
    ...(r.state ? { state: clean(r.state) } : {}),
    ...(r.createTime ? { createTime: clean(r.createTime, 40) } : {}),
    ...(r.updateTime ? { updateTime: clean(r.updateTime, 40) } : {}),
    ...(r.parentFullResourceName ? { parent: clean(r.parentFullResourceName) } : {}),
    ...(labels.length ? { labels: Object.fromEntries(labels) } : {}),
  };
}

/**
 * Every resource of a project, at most 10 pages of 500 (then `cut`). `query` is the person's Cloud Asset query, passed
 * as typed (a read as them); `assetTypes` narrows by type.
 */
export async function searchResources(client: GcpClient, project: string, o: { query?: string; assetType?: string; signal?: AbortSignal } = {}): Promise<{ items: GcpResource[]; cut: boolean }> {
  checkProject(project);
  if (o.query !== undefined && !GcpQuery.safeParse(o.query).success) throw new GcpError(400, "A query is one line of at most 500 characters.");
  if (o.assetType !== undefined && !GcpAssetType.safeParse(o.assetType).success) throw new GcpError(400, "That isn't an asset type.");
  const items: GcpResource[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (o.signal?.aborted) throw new GcpError(0, "Stopped.");
    const body = parse(SearchPage, await client.get("cloudasset", `/v1/projects/${project}:searchAllResources`, {
      pageSize: String(GCP_PAGE), pageToken: token, readMask: READ_MASK, query: o.query, assetTypes: o.assetType,
    }, project));
    for (const r of body.results ?? []) {
      if (items.length >= GCP_MAX_RESOURCES) return { items, cut: true };
      if (r.name.startsWith("//")) items.push(toResource(r));
    }
    token = body.nextPageToken || undefined;
    if (!token) return { items, cut: false };
  }
  return { items, cut: !!token };
}

/**
 * One resource by its full name, with its own configuration (versionedResources[0].resource): `config` is the whole
 * parsed object, for main to scrub before anything reaches the agent; `json` is the drawer's copy, cut at 256 KB.
 * Only the drawer's copy is ever cut (review of part 5, M1): what the agent gets is scrubbed first, from `config`.
 */
export async function getResource(client: GcpClient, project: string, name: string): Promise<{ resource: GcpResource; json?: string; cut: boolean; config?: unknown } | undefined> {
  checkProject(project);
  if (!GcpResourceName.safeParse(name).success) throw new GcpError(400, "That isn't a resource name.");
  const body = parse(SearchPage, await client.get("cloudasset", `/v1/projects/${project}:searchAllResources`, {
    pageSize: "1", readMask: `${READ_MASK},versionedResources`, query: `name="${name}"`,
  }, project));
  const r = (body.results ?? []).find((x) => x.name === name);
  if (!r) return undefined;
  const own = r.versionedResources?.[0]?.resource;
  if (own === undefined || own === null || typeof own !== "object") return { resource: toResource(r), cut: false };
  const json = escapeInvisible(JSON.stringify(own, null, 2));
  return json.length > MAX_JSON ? { resource: toResource(r), json: json.slice(0, MAX_JSON), cut: true, config: own } : { resource: toResource(r), json, cut: false, config: own };
}

/** Asset types with their counts, most first then by name; built from the cached list (search has no count call). */
export function countTypes(items: GcpResource[]): GcpTypeCount[] {
  const by = new Map<string, number>();
  for (const r of items) by.set(r.assetType, (by.get(r.assetType) ?? 0) + 1);
  return [...by].map(([assetType, count]) => ({ assetType, count })).sort((a, b) => a.assetType.localeCompare(b.assetType));
}

/** The service a type belongs to, from its host: compute.googleapis.com/Instance → compute. */
export function serviceOf(assetType: string): string {
  const host = assetType.split("/")[0] ?? "";
  return host.replace(/\.googleapis\.com$/, "") || host;
}
