// GKE's own suggestions for one cluster (wave 9, D176): the diagnosis recommender's ACTIVE insights and
// recommendations for the cluster's location, read with two GETs (at most ten pages of 100 each, 10 s a page), parsed
// with zod, and cut to this cluster's. The lists hold every cluster of the location, so a page left unread may hold
// this cluster's rows: then the answer says `cut` and the panel never says "no suggestions" (review of part 1, M2). Landlens never marks one accepted, claimed, dismissed, succeeded or failed: those
// are POSTs, and there is no POST in this package.
//
// Only this cluster's: an insight is kept when one of its targetResources is exactly this cluster
// (//container.googleapis.com/projects/<project id or number>/(locations|zones)/<location>/clusters/<name>). Another
// cluster of the location, and another project's cluster of the same name, are dropped. A recommendation joins its
// insight by associatedInsights[].insight, the whole name (or the insight's associatedRecommendations); one with no kept
// insight is dropped. Every string of Google's is cleaned (control, format and line-separator characters out) and cut;
// a user agent is the caller's own text, so it is redacted as well, before it is cut.
import { GKE_ADVICE_READ, type GkeAdvice, type GkeRef } from "@landlens/contracts";
import { redactText } from "@landlens/kube/redact";
import { z } from "zod";
import { checkProject, clean } from "./assets.js";
import type { GcpClient } from "./client.js";
import { GcpError, SENTENCES } from "./errors.js";
import { GKE_LOCATION, GKE_NAME } from "./gke.js";

export const INSIGHT_TYPE = "google.container.DiagnosisInsight";
export const RECOMMENDER = "google.container.DiagnosisRecommender";
/** The only filter sent: Google's documented example (D176). */
export const ACTIVE_FILTER = "stateInfo.state = ACTIVE";
export const ADVICE_PAGE = 100;
/** Pages read of each list (the location's every cluster): past them the answer says `cut` (review of part 1, M2). */
export const ADVICE_PAGES = GKE_ADVICE_READ / ADVICE_PAGE;
export const ADVICE_LIMIT_MS = 10_000;
/** The most suggestions one cluster shows. */
export const MAX_ADVICE = 50;

const str = z.string().max(100_000);
const Page = z.object({ insights: z.array(z.unknown()).optional(), recommendations: z.array(z.unknown()).optional(), nextPageToken: str.optional() }).passthrough();
const Insight = z.object({
  name: str,
  description: str.optional(),
  targetResources: z.array(str).max(1000).optional(),
  insightSubtype: str.optional(),
  content: z.unknown().optional(),
  lastRefreshTime: str.optional(),
  stateInfo: z.object({ state: str.optional() }).passthrough().optional(),
  category: str.optional(),
  severity: str.optional(),
  associatedRecommendations: z.array(z.object({ recommendation: str.optional() }).passthrough()).max(1000).optional(),
}).passthrough();
const Recommendation = z.object({
  name: str,
  description: str.optional(),
  priority: str.optional(),
  stateInfo: z.object({ state: str.optional() }).passthrough().optional(),
  associatedInsights: z.array(z.object({ insight: str.optional() }).passthrough()).max(1000).optional(),
}).passthrough();
type Insight = z.infer<typeof Insight>;
type Recommendation = z.infer<typeof Recommendation>;

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const SUBTYPE = /^[A-Z0-9_]{1,80}$/;
const NUMBER = /^\d{1,30}$/;
const SEVERITY: Record<string, GkeAdvice["severity"]> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" };
const CATEGORIES = new Set(["reliability", "cost", "security", "performance", "manageability", "sustainability"]);
const PRIORITY = new Set(["P1", "P2", "P3", "P4"]);
const RANK: Record<GkeAdvice["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

/** The last segment of a resource name, when it is an id's shape. */
const lastId = (name: string): string | undefined => {
  const id = name.split("/").at(-1) ?? "";
  return ID.test(id) ? id : undefined;
};

/** An ISO time, when the text is one Date reads. */
const iso = (s: unknown): string | undefined => {
  if (typeof s !== "string" || s.length > 64) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** The exact target names that are this cluster: by project id or number, under locations/ or zones/. */
export function clusterTargets(c: GkeRef): Set<string> {
  const out = new Set<string>();
  for (const p of [c.project, ...(c.number && NUMBER.test(c.number) ? [c.number] : [])]) {
    for (const where of ["locations", "zones"]) out.add(`//container.googleapis.com/projects/${p}/${where}/${c.location}/clusters/${c.name}`);
  }
  return out;
}

/** Up to ADVICE_PAGES pages of one list, ACTIVE only, 10 s a page; `cut` when Google had more. */
async function pages(client: GcpClient, c: GkeRef, path: string, key: "insights" | "recommendations"): Promise<{ list: unknown[]; cut: boolean }> {
  const list: unknown[] = [];
  let token: string | undefined;
  for (let i = 0; i < ADVICE_PAGES; i++) {
    const r = Page.safeParse(await client.get("recommender", path, { pageSize: String(ADVICE_PAGE), filter: ACTIVE_FILTER, pageToken: token }, c.project, { limitMs: ADVICE_LIMIT_MS }));
    if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
    list.push(...(r.data[key] ?? []));
    token = r.data.nextPageToken || undefined;
    if (!token) return { list, cut: false };
  }
  return { list, cut: true };
}

/** A user agent: cleaned, redacted, and only then cut, so a credential across the cut is still taken whole (L3). */
export const userAgent = (ua: string) => clean(redactText(clean(ua.replace(/\s+/g, " "), 4096)), 120);

/**
 * A recommender resource name with this cluster's project written one way: Google names a project by id or number
 * (review of part 1, L5), and the join compares whole names.
 */
const canonical = (name: string, c: GkeRef) =>
  name.replace(/^projects\/([^/]+)\//, (m, p: string) => (p === c.project || (!!c.number && p === c.number) ? "projects/=/" : m));

/** An API deprecation's APIs and callers (D176), or undefined for any other shape. */
function apisOf(content: unknown): GkeAdvice["apis"] {
  const list = (content as { apiDeprecationInsight?: unknown } | null | undefined)?.apiDeprecationInsight;
  if (!Array.isArray(list)) return undefined;
  const out: NonNullable<GkeAdvice["apis"]> = [];
  for (const raw of list.slice(0, 10)) {
    const a = raw as { api?: unknown; stopServingVersion?: unknown; deprecatedClientStats?: unknown } | null;
    if (!a || typeof a !== "object" || typeof a.api !== "string") continue;
    const clients: NonNullable<GkeAdvice["apis"]>[number]["clients"] = [];
    for (const s of Array.isArray(a.deprecatedClientStats) ? a.deprecatedClientStats.slice(0, 5) : []) {
      const x = s as { userAgent?: unknown; numberOfRequestsLast30Days?: unknown; lastRequestTime?: unknown } | null;
      if (!x || typeof x !== "object" || typeof x.userAgent !== "string") continue;
      // int64 arrives as a JSON string in Google's encoding; a number is taken too.
      const n = typeof x.numberOfRequestsLast30Days === "string" && /^\d{1,15}$/.test(x.numberOfRequestsLast30Days) ? Number(x.numberOfRequestsLast30Days) : x.numberOfRequestsLast30Days;
      const last = iso(x.lastRequestTime);
      clients.push({
        agent: userAgent(x.userAgent),
        ...(typeof n === "number" && Number.isFinite(n) && n >= 0 ? { requests: n } : {}),
        ...(last ? { last } : {}),
      });
    }
    out.push({ api: clean(a.api, 200), ...(typeof a.stopServingVersion === "string" ? { stops: clean(a.stopServingVersion, 20) } : {}), clients });
  }
  return out.length ? out : undefined;
}

/** Rows of a list that pass their schema; the rest are dropped (one odd row doesn't hide the others). */
function rows<T>(schema: z.ZodType<T>, list: unknown[]): T[] {
  const out: T[] = [];
  for (const x of list) {
    const r = schema.safeParse(x);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** One insight and its recommendation as a row of the panel. */
function toAdvice(i: Insight, id: string, rec: Recommendation | undefined): GkeAdvice {
  const raw = i.insightSubtype ?? "";
  const subtype = SUBTYPE.test(raw) ? raw : "OTHER";
  const topic = subtype.startsWith("DEPRECATION_") ? "deprecation" : "other";
  const category = (i.category ?? "").toLowerCase();
  const refreshed = iso(i.lastRefreshTime);
  const apis = topic === "deprecation" ? apisOf(i.content) : undefined;
  return {
    id, subtype, topic,
    severity: SEVERITY[i.severity ?? ""] ?? "unknown",
    category: CATEGORIES.has(category) ? (category as GkeAdvice["category"]) : "unknown",
    description: clean((i.description ?? "").replace(/\s+/g, " "), 300),
    ...(rec?.description ? { action: clean(rec.description.replace(/\s+/g, " "), 300) } : {}),
    ...(rec?.priority && PRIORITY.has(rec.priority) ? { priority: rec.priority as GkeAdvice["priority"] } : {}),
    ...(refreshed ? { refreshed } : {}),
    ...(apis ? { apis } : {}),
  };
}

/** Sorted: severity, deprecations first, the newest refresh first; at most 50. */
export function sortAdvice(list: GkeAdvice[]): GkeAdvice[] {
  return [...list].sort((a, b) =>
    RANK[a.severity] - RANK[b.severity]
    || (a.topic === b.topic ? 0 : a.topic === "deprecation" ? -1 : 1)
    || (b.refreshed ?? "").localeCompare(a.refreshed ?? "")).slice(0, MAX_ADVICE);
}

/**
 * The ACTIVE insights and recommendations of GKE's diagnosis recommender for this one cluster (D176). `cut`: a list had
 * more pages than are read, so this cluster may have more suggestions than `items` (M2).
 */
export async function gkeAdvice(client: GcpClient, c: GkeRef): Promise<{ items: GkeAdvice[]; cut: boolean }> {
  checkProject(c.project);
  if (!GKE_LOCATION.test(c.location) || !GKE_NAME.test(c.name)) throw new GcpError(400, "That isn't a GKE cluster.");
  const base = `/v1/projects/${c.project}/locations/${c.location}`;
  const [insightPages, recPages] = await Promise.all([
    pages(client, c, `${base}/insightTypes/${INSIGHT_TYPE}/insights`, "insights"),
    pages(client, c, `${base}/recommenders/${RECOMMENDER}/recommendations`, "recommendations"),
  ]);
  const targets = clusterTargets(c);
  // ACTIVE again here: a filter Google ignored doesn't bring back a dismissed or claimed row.
  const insights = rows(Insight, insightPages.list).filter((i) => i.stateInfo?.state === "ACTIVE" && (i.targetResources ?? []).some((t) => targets.has(t)));
  const recs = rows(Recommendation, recPages.list).filter((r) => r.stateInfo?.state === "ACTIVE");
  const out: GkeAdvice[] = [];
  const seen = new Set<string>();
  for (const i of insights) {
    const id = lastId(i.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const named = new Set((i.associatedRecommendations ?? []).map((r) => r.recommendation).filter((r): r is string => !!r).map((r) => canonical(r, c)));
    const me = canonical(i.name, c);
    const rec = recs.find((r) => (r.associatedInsights ?? []).some((a) => !!a.insight && canonical(a.insight, c) === me)) ?? recs.find((r) => named.has(canonical(r.name, c)));
    out.push(toAdvice(i, id, rec));
  }
  return { items: sortAdvice(out), cut: insightPages.cut || recPages.cut };
}
