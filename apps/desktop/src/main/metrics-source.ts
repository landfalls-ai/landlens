// Cloud Monitoring as main hands it to MetricsService (wave 9 part 2, D182–D183), and the series a Claude session gets.
// Which GKE cluster a handle is, is GcpService.gkeOf's answer alone (D173), from the handle's own context, address and
// sidecar trust; the page can't name a source, a project or a cluster.
import type { MetricsSeries } from "@landlens/contracts";
import type { MetricsDeps, MetricsService } from "@landlens/metrics";
import { connectedOf, type GcpService } from "./gcp";

type Clusters = Parameters<typeof connectedOf>[0];

/** MetricsDeps.cloudMonitoring: not GKE says nothing; an unchosen project or an unread listing is a reason; else ask. */
export function cloudMonitoringSource(gcp: Pick<GcpService, "gkeOf" | "promAsk">, clusters: Clusters, gkeHandles: ReadonlySet<string>): NonNullable<MetricsDeps["cloudMonitoring"]> {
  return async (handle) => {
    const ref = await gcp.gkeOf(connectedOf(clusters, gkeHandles, handle), { unread: true });
    if (!ref) return undefined;
    if ("hint" in ref) return { reason: { code: "cloud-monitoring-not-chosen", message: ref.hint } };
    if ("unread" in ref) return { reason: { code: "cloud-monitoring-failed", message: ref.unread } };
    return { cluster: ref, ask: gcp.promAsk(ref) };
  };
}

/**
 * The series a session's `metrics` tool reads: what it reads of the cluster goes with the session's own token (`read`),
 * and it reads no Cloud Monitoring yet. The grant that covers metrics, and the session's projects and hold, are part
 * 4's (D190, D194); until then its Google projects are none, and the answer says why (cloud-monitoring-not-granted).
 */
export function sessionSeries(metrics: Pick<MetricsService, "series">) {
  return (handle: string, r: Omit<Parameters<MetricsService["series"]>[0], "handle">, read?: (path: string) => Promise<any>): Promise<MetricsSeries> =>
    metrics.series({ handle, ...r }, { ...(read ? { read } : {}), agent: { projects: [], hold: () => {} } });
}
