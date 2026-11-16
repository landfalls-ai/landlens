// Cloud Monitoring as main hands it to MetricsService (wave 9 part 2, D182–D183), and the series a Claude session gets.
// Which GKE cluster a handle is, is GcpService.gkeOf's answer alone (D173), from the handle's own context, address and
// sidecar trust; the page can't name a source, a project or a cluster.
import type { MetricsSeries } from "@landlens/contracts";
import { NOT_GRANTED, SESSION_READS, type MetricsDeps, type MetricsService } from "@landlens/metrics";
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
      if (!o.agent.projects().includes(project)) return { reason: { code: "cloud-monitoring-not-granted", message: NOT_GRANTED } };
    }
    const ref = await gcp.gkeOf(connected, { unread: true });
    if (!ref) return undefined;
    if ("hint" in ref) return { reason: { code: "cloud-monitoring-not-chosen", message: ref.hint } };
    if ("unread" in ref) return { reason: { code: "cloud-monitoring-failed", message: ref.unread } };
    // A session's queries go in the agents' own share of the waiting line, and a 403 or 429 they get isn't kept for the
    // person's charts (security review of wave 9 part 4, L3).
    return { cluster: ref, ask: gcp.promAsk(ref, o.agent ? { agent: true } : {}) };
  };
}

/**
 * The series a session's `metrics` tool reads: what it reads of the cluster goes with the session's own token (`read`),
 * and Cloud Monitoring only for a project `google.projects()` gives now (the session's Google grant as it began, less
 * what was withdrawn since: D194, review of part 4 M1), holding its autonomy with `google.hold` before the first query
 * leaves, and at most SESSION_READS calls a minute that ask Cloud Monitoring per session (each `google` is one session's;
 * L3). A call without `google` (Preview before its session is open, or any caller that forgets it) reads with no
 * project: never as the IDE's own charts do.
 */
export function sessionSeries(metrics: Pick<MetricsService, "series">, o: { now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const spent = new WeakMap<object, number[]>();
  const take = (google: object) => {
    const t = now();
    const calls = (spent.get(google) ?? []).filter((x) => t - x < 60_000);
    spent.set(google, calls);
    if (calls.length >= SESSION_READS) return false;
    calls.push(t);
    return true;
  };
  return (handle: string, r: Omit<Parameters<MetricsService["series"]>[0], "handle">, read?: (path: string) => Promise<any>, google?: { projects(): string[]; hold(): void }): Promise<MetricsSeries> =>
    metrics.series({ handle, ...r }, {
      ...(read ? { read } : {}),
      agent: { projects: () => [...(google?.projects() ?? [])], hold: () => google?.hold(), take: () => !!google && take(google) },
    });
}
