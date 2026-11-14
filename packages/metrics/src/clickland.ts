// The Clickland API client, used only from Electron main. The key goes only to the configured URL, in the
// Authorization header; redirects are refused so it can't be carried elsewhere, and no error message repeats it.
//
// What Clickland answers is checked before anything uses it: its series reach the page's charts and, through the
// metrics tool, the model. So every answer must have the expected shape; series keys must be Kubernetes names (node,
// namespace, pod, container), timestamps real times, values finite and not negative; at most 200 series of 4,000
// points. Anything else is refused as a whole, and errors are Landlens's own words, never the answer's text.
import { z } from "zod";

export type ClicklandConfig = { url: string; key: string };
export type ClicklandFailure = "unreachable" | "unauthorized" | "failed" | "no-cluster";

export class ClicklandError extends Error {
  constructor(public readonly kind: ClicklandFailure, message: string) {
    super(message);
  }
}

/** POST /api/metrics/query (Clickland's MetricQueryRequest). */
export type ClicklandQuery = {
  metric: string;
  type: "gauge";
  aggregation: "avg" | "max";
  from: string;
  to: string;
  service?: string;
  groupBy?: string;
  where?: Record<string, string>;
};
export type ClicklandSeries = { bucketSeconds: number; series: { key: string; points: [string, number][] }[] };

export const MAX_SERIES = 200;
export const MAX_POINTS = 4000;
/** A Kubernetes object name (DNS-1123 subdomain; labels and "other" fit too), or "" for samples without the label. */
const NAME = /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?)?$/;
const Time = z.string().max(40).refine((t) => Number.isFinite(Date.parse(t)), "not a time");
const SeriesAnswer = z.object({
  bucketSeconds: z.number().finite().min(0).max(86_400),
  series: z
    .array(z.object({
      key: z.string().max(253).regex(NAME, "not a Kubernetes name"),
      // Gaps (null) are dropped; a value must be finite and not negative (cores, bytes, counts).
      points: z.array(z.tuple([Time, z.number().finite().min(0).nullable()])).max(MAX_POINTS),
    }))
    .max(MAX_SERIES),
});
const HealthAnswer = z.object({ status: z.string().max(32), version: z.string().max(64).optional() });

/** Clickland's series answer, checked; throws ClicklandError("failed") if it isn't one. */
export function parseSeries(raw: unknown): ClicklandSeries {
  const r = SeriesAnswer.safeParse(raw);
  if (!r.success) throw new ClicklandError("failed", "Clickland's answer didn't look like metrics, so Landlens didn't use it.");
  return {
    bucketSeconds: r.data.bucketSeconds,
    series: r.data.series.map((s) => ({ key: s.key, points: s.points.filter((p): p is [string, number] => p[1] !== null) })),
  };
}

export class ClicklandClient {
  private readonly base: string;
  constructor(
    private readonly config: ClicklandConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {
    this.base = config.url.replace(/\/+$/, "");
  }

  /** GET /api/health (no key needed, none sent). Only "ok" or not, and a version that looks like one. */
  async health(): Promise<{ status: string; version?: string }> {
    const r = HealthAnswer.safeParse(await this.call("GET", "/api/health", undefined, false));
    if (!r.success) throw new ClicklandError("failed", "Clickland's health answer wasn't one.");
    const version = r.data.version && /^[0-9A-Za-z.+_-]{1,40}$/.test(r.data.version) ? r.data.version : undefined;
    return { status: r.data.status === "ok" ? "ok" : "not ok", ...(version ? { version } : {}) };
  }

  async query(q: ClicklandQuery): Promise<ClicklandSeries> {
    return parseSeries(await this.call("POST", "/api/metrics/query", q, true));
  }

  private async call<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: "application/json",
          ...(auth ? { authorization: `Bearer ${this.config.key}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const why = (err as Error).name === "TimeoutError" ? `no answer in ${this.timeoutMs / 1000}s` : "connection failed";
      throw new ClicklandError("unreachable", `Clickland at ${this.base} didn't answer (${why}).`);
    }
    if (res.status === 401 || res.status === 403)
      throw new ClicklandError("unauthorized", `Clickland refused the key (${res.status}): it needs the read scope.`);
    // Never the answer's text: the address may be one the page chose, and the message reaches the page and the model.
    if (!res.ok) throw new ClicklandError("failed", `Clickland answered HTTP ${res.status}.`);
    const text = await res.text().catch(() => "");
    if (text.length > 20_000_000) throw new ClicklandError("failed", "Clickland's answer was too large.");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClicklandError("failed", "Clickland's answer wasn't JSON.");
    }
  }
}

/**
 * Whether this Clickland honours `where` (Clickland specs/001-metrics-filters). One that predates it drops the field
 * and answers for every pod, so a query for a cluster name nothing has must come back empty.
 */
export async function honoursFilters(client: ClicklandClient, now = Date.now()): Promise<boolean> {
  const res = await client.query({
    metric: "k8s.node.cpu.usage",
    type: "gauge",
    aggregation: "avg",
    from: new Date(now - 3_600_000).toISOString(),
    to: new Date(now).toISOString(),
    service: "kubernetes",
    where: { "k8s.cluster.name": "landlens-filter-probe.invalid" },
  });
  return res.series.length === 0;
}

export const FILTERS_MISSING = (url: string) =>
  `Clickland at ${url} ignores metric filters, so it would mix every pod's data: it predates \`where\` (Clickland specs/001-metrics-filters). Update it.`;
