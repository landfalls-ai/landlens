// Which source answers: Clickland when a key is stored and it answers for this cluster; else metrics-server sampled
// while Landlens is open; else nothing, with every reason and what fixes it.
import type { ClicklandTest, MetricsReason, MetricsRequest, MetricsSeries } from "@landlens/contracts";
import { ClicklandClient, ClicklandError, FILTERS_MISSING, honoursFilters, type ClicklandConfig } from "./clickland.js";
import { clicklandSeries, RANGE_MS } from "./clickland-series.js";
import { liveSeries } from "./live-series.js";
import { MetricsServerSampler, type Get, type SamplerOptions } from "./sampler.js";

export type MetricsDeps = {
  /** Clickland's stored address and key, if a key is stored; and the cluster name for a kubeconfig context. */
  clickland: () => { config?: ClicklandConfig; clusterName: (context: string) => string };
  /** A connected cluster: its kubeconfig context, and GET through its sidecar. Throws if not connected. */
  cluster: (handle: string) => { context: string; get: Get };
  fetch?: typeof fetch;
  now?: () => number;
  sampler?: SamplerOptions;
};

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

const REASON: Record<ClicklandError["kind"], MetricsReason["code"]> = {
  unreachable: "clickland-unreachable",
  unauthorized: "clickland-unauthorized",
  failed: "clickland-failed",
  "no-cluster": "clickland-no-cluster",
};

export class MetricsService {
  private readonly samplers = new Map<string, MetricsServerSampler>();
  /** Per Clickland URL: whether it honours `where`, checked at most every five minutes. */
  private readonly filters = new Map<string, { at: number; ok: boolean }>();
  constructor(private readonly deps: MetricsDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * `read`, when given, is how the series reads the cluster itself (requests, limits, allocatable, a workload's
   * pods): the metrics tool passes its session's front-door token. The IDE's charts read through the sidecar.
   */
  async series(req: MetricsRequest, opts: { read?: Get } = {}): Promise<MetricsSeries> {
    const cluster = this.deps.cluster(req.handle);
    const { config, clusterName } = this.deps.clickland();
    const reasons: MetricsReason[] = [];
    if (config) {
      try {
        const client = new ClicklandClient(config, this.deps.fetch);
        if (!(await this.filtersOk(client, config.url))) throw new ClicklandError("failed", FILTERS_MISSING(config.url));
        return await clicklandSeries(client, clusterName(cluster.context), req, this.now());
      } catch (err) {
        if (!(err instanceof ClicklandError)) throw err;
        reasons.push({ code: REASON[err.kind], message: err.message });
      }
    } else reasons.push({ code: "clickland-off", message: "Clickland isn't connected, so there is no history." });

    const sampler = this.sampler(req.handle, cluster.get);
    const served = await sampler.available();
    if (served.ok) {
      await sampler.touch();
      const out = await liveSeries(opts.read ?? cluster.get, sampler.samples(this.now() - RANGE_MS[req.range]), req, sampler.intervalMs / 1000, this.now());
      const span = RANGE_MS[req.range] > 3_600_000 ? " (at most the last hour)" : "";
      out.reasons = [...reasons, { code: "live-only", message: `Sampled from metrics-server every ${sampler.intervalMs / 1000}s since Landlens opened this view${span}.` }];
      return out;
    }
    reasons.push({ code: "no-metrics-server", message: served.message });
    const to = this.now();
    return { source: "none", reasons, step: 0, from: to - RANGE_MS[req.range], to, by: "container", cpu: { series: [] }, memory: { series: [] } };
  }

  /**
   * The Settings dialog's check: health, then one query for this cluster, with the given or the stored settings. A
   * stored key is only sent to the origin it was saved for; another address needs the key typed again. What comes
   * back is reported in Landlens's own words, never the answer's text, since the page chose the address.
   */
  async test(input: { handle?: string; url?: string; key?: string; cluster?: string }): Promise<ClicklandTest> {
    const stored = this.deps.clickland();
    const url = input.url ?? stored.config?.url;
    if (input.key === undefined && input.url && stored.config && originOf(input.url) !== originOf(stored.config.url)) {
      return { ok: false, steps: [{ name: "Settings", ok: false, detail: "The stored key is only sent to the address it was saved for. Type it again to test this address." }] };
    }
    const key = input.key ?? stored.config?.key;
    if (!url || !key) return { ok: false, steps: [{ name: "Settings", ok: false, detail: "Give Clickland's address and a key with the read scope." }] };
    const client = new ClicklandClient({ url, key }, this.deps.fetch);
    const steps: ClicklandTest["steps"] = [];
    try {
      const h = await client.health();
      steps.push({ name: "Health", ok: h.status === "ok", detail: `${h.status === "ok" ? "ok" : "not ok"}${h.version ? ` · version ${h.version}` : ""}` });
    } catch (err) {
      return { ok: false, steps: [{ name: "Health", ok: false, detail: (err as Error).message }] };
    }
    try {
      const ok = await honoursFilters(client, this.now());
      steps.push({ name: "Filters", ok, detail: ok ? "metric filters (where) supported" : FILTERS_MISSING(url) });
      this.filters.set(url, { at: this.now(), ok });
    } catch (err) {
      return { ok: false, steps: [...steps, { name: "Filters", ok: false, detail: (err as Error).message }] };
    }
    let cluster = input.cluster;
    if (!cluster && input.handle) {
      try {
        cluster = stored.clusterName(this.deps.cluster(input.handle).context);
      } catch {
        /* not connected */
      }
    }
    try {
      const to = this.now();
      const res = await client.query({
        metric: "k8s.node.cpu.usage",
        type: "gauge",
        aggregation: "avg",
        from: new Date(to - 3_600_000).toISOString(),
        to: new Date(to).toISOString(),
        service: "kubernetes",
        groupBy: "k8s.node.name",
        ...(cluster ? { where: { "k8s.cluster.name": cluster } } : {}),
      });
      const points = res.series.reduce((a, s) => a + s.points.length, 0);
      steps.push(
        points
          ? { name: "Query", ok: true, detail: `${res.series.length} node${res.series.length === 1 ? "" : "s"}, ${points} points in the last hour${cluster ? ` for “${cluster}”` : ""}` }
          : { name: "Query", ok: false, detail: `The key works, but there are no node samples${cluster ? ` for k8s.cluster.name “${cluster}”` : ""} in the last hour.` },
      );
    } catch (err) {
      steps.push({ name: "Query", ok: false, detail: (err as Error).message });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  private async filtersOk(client: ClicklandClient, url: string): Promise<boolean> {
    const known = this.filters.get(url);
    if (known && this.now() - known.at < 300_000) return known.ok;
    const ok = await honoursFilters(client, this.now());
    this.filters.set(url, { at: this.now(), ok });
    return ok;
  }

  private sampler(handle: string, get: Get) {
    let s = this.samplers.get(handle);
    if (!s) this.samplers.set(handle, (s = new MetricsServerSampler(get, this.deps.sampler)));
    return s;
  }

  /** A cluster disconnected: stop its sampler and drop its samples. */
  forget(handle: string) {
    this.samplers.get(handle)?.stop();
    this.samplers.delete(handle);
  }

  stopAll() {
    for (const h of [...this.samplers.keys()]) this.forget(h);
  }
}
