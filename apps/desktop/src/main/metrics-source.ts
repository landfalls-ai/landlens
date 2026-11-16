// Cloud Monitoring as main hands it to MetricsService (wave 9 part 2, D182–D183), and the series a Claude session gets.
// Which GKE cluster a handle is, is GcpService.gkeOf's answer alone (D173), from the handle's own context, address and
// sidecar trust; the page can't name a source, a project or a cluster.
import type { MetricsSeries } from "@landlens/contracts";
import { NOT_GRANTED, type MetricsDeps, type MetricsService } from "@landlens/metrics";
import { connectedOf, type GcpService } from "./gcp";

type Clusters = Parameters<typeof connectedOf>[0];

/**
 * MetricsDeps.cloudMonitoring: not GKE says nothing; an unchosen project or an unread listing is a reason; else ask.
 * A session's call (`agent`) is decided first from what main holds (review of part 2, M1): the project gcloud's context
 * name says and whether it is chosen. A project the session may not read is `cloud-monitoring-not-granted` (chosen) or
 * nothing (not chosen, or not GKE's name) without gkeOf, so no gcloud run, listing, project search or query is made
 * for it; only a project the session may read goes on to gkeOf. MetricsService checks the project again (the second lock).
 */
export function cloudMonitoringSource(gcp: Pick<GcpService, "gkeOf" | "promAsk" | "chosenProjectOf">, clusters: Clusters, gkeHandles: ReadonlySet<string>): NonNullable<MetricsDeps["cloudMonitoring"]> {
  return async (handle, o) => {
    const connected = connectedOf(clusters, gkeHandles, handle);
    if (o.agent) {
      const project = gcp.chosenProjectOf(connected.context);
      if (!project) return undefined;
      if (!o.agent.projects.includes(project)) return { reason: { code: "cloud-monitoring-not-granted", message: NOT_GRANTED } };
    }
    const ref = await gcp.gkeOf(connected, { unread: true });
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
