// Which source answers: Clickland when a key is stored and it answers for this cluster; else metrics-server sampled
// while Landlens is open; else nothing, with every reason and what fixes it.
import type { ClicklandTest, MetricsReason, MetricsRequest, MetricsSeries } from "@landlens/contracts";
import { ClicklandClient, ClicklandError, type ClicklandConfig } from "./clickland.js";
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

const REASON: Record<ClicklandError["kind"], MetricsReason["code"]> = {
  unreachable: "clickland-unreachable",
  unauthorized: "clickland-unauthorized",
  failed: "clickland-failed",
  "no-cluster": "clickland-no-cluster",
};

export class MetricsService {
  private readonly samplers = new Map<string, MetricsServerSampler>();
  constructor(private readonly deps: MetricsDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  async series(req: MetricsRequest): Promise<MetricsSeries> {
    const cluster = this.deps.cluster(req.handle);
    const { config, clusterName } = this.deps.clickland();
    const reasons: MetricsReason[] = [];
    if (config) {
      try {
        return await clicklandSeries(new ClicklandClient(config, this.deps.fetch), clusterName(cluster.context), req, this.now());
      } catch (err) {
        if (!(err instanceof ClicklandError)) throw err;
        reasons.push({ code: REASON[err.kind], message: err.message });
      }
    } else reasons.push({ code: "clickland-off", message: "Clickland isn't connected, so there is no history." });

    const sampler = this.sampler(req.handle, cluster.get);
    const served = await sampler.available();
    if (served.ok) {
      await sampler.touch();
      const out = await liveSeries(cluster.get, sampler.samples(this.now() - RANGE_MS[req.range]), req, sampler.intervalMs / 1000, this.now());
      const span = RANGE_MS[req.range] > 3_600_000 ? " (at most the last hour)" : "";
      out.reasons = [...reasons, { code: "live-only", message: `Sampled from metrics-server every ${sampler.intervalMs / 1000}s since Landlens opened this view${span}.` }];
      return out;
    }
    reasons.push({ code: "no-metrics-server", message: served.message });
    const to = this.now();
    return { source: "none", reasons, step: 0, from: to - RANGE_MS[req.range], to, by: "container", cpu: { series: [] }, memory: { series: [] } };
  }

  /** The Settings dialog's check: health, then one query for this cluster, with the given or the stored settings. */
  async test(input: { handle?: string; url?: string; key?: string; cluster?: string }): Promise<ClicklandTest> {
    const stored = this.deps.clickland();
    const url = input.url ?? stored.config?.url;
    const key = input.key ?? stored.config?.key;
    if (!url || !key) return { ok: false, steps: [{ name: "Settings", ok: false, detail: "Give Clickland's address and a key with the read scope." }] };
    const client = new ClicklandClient({ url, key }, this.deps.fetch);
    const steps: ClicklandTest["steps"] = [];
    try {
      const h = await client.health();
      steps.push({ name: "Health", ok: h.status === "ok", detail: `${h.status}${h.version ? ` · version ${h.version}` : ""}` });
    } catch (err) {
      return { ok: false, steps: [{ name: "Health", ok: false, detail: (err as Error).message }] };
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
