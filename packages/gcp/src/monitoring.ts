// Cloud Monitoring (wave 9, D179, D185–D187): PromQL over HTTP, query_range only, GET only. The query is one Landlens built from
// fixed text and checked names (packages/metrics' cloud-monitoring.ts); this file never takes one from the page or the
// agent. The answer is handed back as Google sent it: the caller filters it to the cluster (a project's PromQL answers
// for its whole metrics scope, D181) before anything of it is drawn. A refused query's error echoes the query, so it is
// a fixed sentence here and its text goes nowhere (D175). `packages/metrics` never sees this client or the token: main
// hands it a function.
import { ContainerName, GCP_ALERTS_READ, GCP_ALERTS_SHOWN, NamespaceName, NodeName, type GcpAlert, type GkeRef } from "@landlens/contracts";
import { z } from "zod";
import { checkProject, outsideText } from "./assets.js";
import type { GcpClient } from "./client.js";
import { GcpError, SENTENCES } from "./errors.js";
import { GKE_LOCATION, GKE_NAME } from "./gke.js";

/** A GET's URL must stay short; D180's queries are well under this. */
export const PROM_QUERY_MAX = 6_000;
/** A PromQL call's own time limit (D179); the size cap is the client's 8 MB. */
export const PROM_LIMIT_MS = 10_000;

/**
 * One range query on `project`'s PromQL endpoint, as that project (X-Goog-User-Project). `fromMs` and `toMs` are
 * epoch milliseconds; `stepS` seconds. A query that is empty or too long, or a range that isn't one, is refused before
 * any request.
 */
export async function promRange(client: GcpClient, project: string, query: string, fromMs: number, toMs: number, stepS: number): Promise<unknown> {
  checkProject(project);
  if (typeof query !== "string" || !query || query.length > PROM_QUERY_MAX) throw new GcpError(400, "Landlens's query for Cloud Monitoring was too long.", `query of ${String(query?.length)} characters`);
  if (![fromMs, toMs, stepS].every((n) => typeof n === "number" && Number.isFinite(n)) || stepS < 1 || toMs < fromMs) {
    throw new GcpError(400, "Landlens's query for Cloud Monitoring had no time range.", "bad range");
  }
  return client.get(
    "monitoring",
    `/v1/projects/${project}/location/global/prometheus/api/v1/query_range`,
    { query, start: String(fromMs / 1000), end: String(toMs / 1000), step: String(stepS) },
    project,
    { limitMs: PROM_LIMIT_MS },
  );
}

// ---- Open alerts (wave 9 part 3, D185–D187) ------------------------------------------------------------------------
//
// alerts.list answers for the project's whole metrics scope, so main keeps only OPEN alerts whose resource names the
// project asked (`resource.labels.project_id`), and then only those whose resource is this cluster's. No `filter` is
// sent: its syntax is undocumented ([check 3]). A policy's name and documentation are written by whoever made the policy:
// they are cleaned, redacted and cut here (outsideText), shown as text, and reach Claude only quoted.

/** One page of the newest alerts (Google's default order is openTime desc), and the time a read may take. */
export const ALERTS_PAGE = GCP_ALERTS_READ;
export const ALERTS_LIMIT_MS = 15_000;
/** An alert policy is small; its read is held to 10 s and 1 MB. */
export const POLICY_LIMIT_MS = 10_000;
export const POLICY_MAX_BYTES = 1024 * 1024;
/** What an alert shows of its policy: up to five conditions, and the documentation's first 300 characters. */
export const POLICY_CONDITIONS = 5;
export const POLICY_DOC_MAX = 300;

const text = z.string().max(100_000);
const AlertsPage = z.object({ alerts: z.array(z.unknown()).max(100_000).optional(), nextPageToken: text.optional() }).passthrough();
// Only the fields Landlens reads: Google's row also has `metadata`, `log` and the policy's user labels, none of it
// cleaned, and none of it kept in main (review of part 3, L6).
const Alert = z.object({
  name: text,
  state: text.optional(),
  openTime: text.optional(),
  resource: z.object({ type: text.optional(), labels: z.record(z.string(), z.unknown()).optional() }).optional(),
  metric: z.object({ type: text.optional() }).optional(),
  policy: z.object({ name: text.optional(), displayName: text.optional(), severity: text.optional() }).optional(),
});
/**
 * The resource labels an alert of a GKE cluster is placed by (D186), and the legacy gke_container's `namespace_id` and
 * `pod_id` (security review of wave 9 part 4, M3); project_id is checked in openAlerts.
 */
const ALERT_LABELS = ["location", "cluster_name", "cluster", "namespace_name", "pod_name", "container_name", "node_name", "namespace", "namespace_id", "pod_id"] as const;
/**
 * A label key that says a resource may be a Kubernetes cluster's (M3): a cluster, namespace, pod, node or container as
 * a word of the key (cluster_name, namespace_id, canonical_service_namespace, …). Decided from the labels, not a list of
 * types: a type Landlens doesn't know with such a label still counts. [check] The real types' label keys are from
 * memory of Cloud Monitoring's monitored-resource list, not read from it.
 */
const KUBE_KEY = /(?:^|_)(?:cluster|namespace|pod|node|container)(?:_|$)/;
/** Resource types that are a cluster's, or may be (a VM may be a GKE node), whatever their labels say. */
const KUBE_TYPE = /^(?:k8s_|gke_)|^gce_instance$/;
/**
 * An open alert of the project as main keeps it: the fields clusterAlerts reads and nothing else of Google's row
 * (review of part 3, L6). Its text isn't cleaned yet: clusterAlerts does that.
 */
export type RawAlert = {
  name: string;
  openTime?: string;
  /**
   * `other`: for a resource that isn't a GKE cluster's (a VM, a load balancer), up to six of its labels, how the agent's
   * gcp_alerts says what it is about (wave 9 part 4, D192): keys of OTHER_LABEL's shape, values cleaned, redacted and
   * cut to 120 here, sorted by key. A cluster's resource keeps none: its subject says it.
   */
  resource?: {
    type?: string; labels?: Partial<Record<(typeof ALERT_LABELS)[number], string>>; other?: [string, string][];
    /** The resource is, or may be, a Kubernetes cluster's (KUBE_KEY, KUBE_TYPE): decided at the read from every label key. */
    kube?: true;
  };
  metric?: { type?: string };
  policy?: { name?: string; displayName?: string; severity?: string };
};
/** A label of a resource that isn't a cluster's, as gcp_alerts shows it (D192): its key's shape, at most six. */
const OTHER_LABEL = /^[a-z_]{1,40}$/;
export const OTHER_LABELS_MAX = 6;
const slim = (a: z.infer<typeof Alert>): RawAlert => {
  const l = a.resource?.labels ?? {};
  const labels: NonNullable<NonNullable<RawAlert["resource"]>["labels"]> = {};
  for (const k of ALERT_LABELS) if (typeof l[k] === "string") labels[k] = l[k];
  const other = (CLUSTER_RESOURCES as readonly string[]).includes(a.resource?.type ?? "") ? [] : Object.entries(l)
    .filter((e): e is [string, string] => e[0] !== "project_id" && OTHER_LABEL.test(e[0]) && typeof e[1] === "string")
    .sort((x, y) => x[0].localeCompare(y[0])).slice(0, OTHER_LABELS_MAX)
    .map(([k, v]): [string, string] => [k, outsideText(v, 120)]);
  const kube = KUBE_TYPE.test(a.resource?.type ?? "") || Object.keys(l).some((k) => KUBE_KEY.test(k));
  return {
    name: a.name,
    openTime: a.openTime,
    ...(a.resource ? { resource: { type: a.resource.type, labels, ...(other.length ? { other } : {}), ...(kube ? { kube: true as const } : {}) } } : {}),
    ...(a.metric ? { metric: { type: a.metric.type } } : {}),
    ...(a.policy ? { policy: { name: a.policy.name, displayName: a.policy.displayName, severity: a.policy.severity } } : {}),
  };
};
const Policy = z.object({
  name: text.optional(),
  conditions: z.array(z.object({ displayName: text.optional() }).passthrough()).max(1000).optional(),
  documentation: z.object({ content: text.optional() }).passthrough().optional(),
}).passthrough();

/** The resource types an alert of a GKE cluster names (D186). */
export const CLUSTER_RESOURCES = ["k8s_container", "k8s_pod", "k8s_node", "k8s_cluster", "prometheus_target"] as const;
const ALERT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const METRIC_TYPE = /^[A-Za-z0-9_./:-]{1,200}$/;
/**
 * Google's severity words ([check 2]: from memory, the reference page links an enum it doesn't print). Any other word,
 * or none, shows no severity: Landlens never guesses one.
 */
const ALERT_SEVERITY: Record<string, GcpAlert["severity"]> = { CRITICAL: "critical", ERROR: "error", WARNING: "warning" };
const SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const isNamespace = (s: unknown): s is string => typeof s === "string" && NamespaceName.safeParse(s).success;
const isPod = (s: unknown): s is string => typeof s === "string" && s.length <= 253 && SUBDOMAIN.test(s);
const isContainer = (s: unknown): s is string => typeof s === "string" && ContainerName.safeParse(s).success;
const isNode = (s: unknown): s is string => typeof s === "string" && NodeName.safeParse(s).success;

/**
 * The project's open alerts (D185): one page of the newest 1,000, 15 s, 8 MB, no filter. Kept: `state` OPEN and
 * `resource.labels.project_id` exactly the project asked (another project of the metrics scope never shows under this
 * one, nor is it counted: its count isn't this project's to show). `cut`: Google had more. `unreadable`: rows that
 * weren't an alert's shape, so whose they are is unknown, and rows of this project (or of none) whose state is neither
 * OPEN nor CLOSED, so whether they are open is unknown. `unplaced`: open alerts whose resource names no project (a
 * PromQL or log-based condition can aggregate the labels away), so they may be this cluster's (review of part 3, L1).
 */
export async function openAlerts(client: GcpClient, project: string): Promise<{ alerts: RawAlert[]; cut: boolean; unreadable: number; unplaced: number }> {
  checkProject(project);
  const r = AlertsPage.safeParse(await client.get("monitoring", `/v3/projects/${project}/alerts`, { pageSize: String(ALERTS_PAGE) }, project, { limitMs: ALERTS_LIMIT_MS }));
  if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
  const alerts: RawAlert[] = [];
  let unreadable = 0;
  let unplaced = 0;
  for (const x of r.data.alerts ?? []) {
    const a = Alert.safeParse(x);
    if (!a.success) {
      unreadable++;
      continue;
    }
    const owner = a.data.resource?.labels?.project_id;
    if (owner !== undefined && owner !== project) continue;
    if (a.data.state === "CLOSED") continue;
    if (a.data.state !== "OPEN") {
      unreadable++;
      continue;
    }
    if (owner === undefined) {
      unplaced++;
      continue;
    }
    alerts.push(slim(a.data));
  }
  return { alerts, cut: !!r.data.nextPageToken, unreadable, unplaced };
}

/** Whether an alert's resource is this cluster: a Kubernetes resource by location and cluster_name, or a Prometheus target by location and cluster. */
export function onCluster(a: RawAlert, c: GkeRef): boolean {
  const type = a.resource?.type;
  const l = a.resource?.labels ?? {};
  if (type === "prometheus_target") return l.location === c.location && l.cluster === c.name;
  return (CLUSTER_RESOURCES as readonly string[]).includes(type ?? "") && l.location === c.location && l.cluster_name === c.name;
}

/** What an alert is about, when every name it gives is a Kubernetes name; else none. */
function subjectOf(a: RawAlert): GcpAlert["subject"] {
  const l = a.resource?.labels ?? {};
  switch (a.resource?.type) {
    case "k8s_container":
      return isNamespace(l.namespace_name) && isPod(l.pod_name) && isContainer(l.container_name)
        ? { kind: "Pod", namespace: l.namespace_name, name: l.pod_name, container: l.container_name } : undefined;
    case "k8s_pod":
      return isNamespace(l.namespace_name) && isPod(l.pod_name) ? { kind: "Pod", namespace: l.namespace_name, name: l.pod_name } : undefined;
    case "k8s_node":
      return isNode(l.node_name) ? { kind: "Node", name: l.node_name } : undefined;
    case "prometheus_target":
      return isNamespace(l.namespace) ? { kind: "Namespace", namespace: l.namespace, name: l.namespace } : undefined;
    default:
      return undefined;
  }
}

/** An ISO time, when Date reads the text. */
const isoOf = (s: string | undefined): string | undefined => {
  if (!s || s.length > 64) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/**
 * This cluster's alerts among the project's open ones (D186), pure: newest first, at most 200. `others`: the project's
 * open alerts that don't name this cluster. `unreadable`: this cluster's alerts with no usable id or opening time
 * (dropped, but counted, so the list never reads as complete); `over`: this cluster's past the 200.
 */
export function clusterAlerts(raw: RawAlert[], c: GkeRef): { items: GcpAlert[]; others: number; unreadable: number; over: number } {
  const items: GcpAlert[] = [];
  let others = 0;
  let unreadable = 0;
  const seen = new Set<string>();
  const own = ownIds(c);
  for (const a of raw) {
    if (!onCluster(a, c)) {
      others++;
      continue;
    }
    const id = idOf(a);
    const row = toAlert(a, own);
    if (!row || seen.has(id)) {
      if (!seen.has(id)) unreadable++;
      continue;
    }
    seen.add(id);
    items.push(row);
  }
  items.sort((x, y) => y.opened.localeCompare(x.opened));
  return { items: items.slice(0, GCP_ALERTS_SHOWN), others, unreadable, over: Math.max(0, items.length - GCP_ALERTS_SHOWN) };
}

/** The project's id and (when known and of its shape) its number, by which its own policies are named. */
const ownIds = (c: { project: string; number?: string }) => {
  const numbered = !!c.number && /^\d{1,30}$/.test(c.number);
  return { ids: new Set([c.project, ...(numbered ? [c.number!] : [])]), numbered };
};
const idOf = (a: RawAlert) => a.name.split("/").at(-1) ?? "";

/** One open alert as a row, or undefined when it has no usable id or opening time (counted as unreadable by the caller). */
function toAlert(a: RawAlert, own: { ids: Set<string>; numbered: boolean }): GcpAlert | undefined {
  const id = idOf(a);
  const opened = isoOf(a.openTime);
  if (!ALERT_ID.test(id) || !opened) return undefined;
  const pol = /^projects\/([^/]+)\/alertPolicies\/(\d{1,30})$/.exec(a.policy?.name ?? "");
  const metric = a.metric?.type;
  const subject = subjectOf(a);
  const type = a.resource?.type ?? "";
  return {
    id, opened,
    policy: outsideText(a.policy?.displayName ?? "", 120),
    // A policy named by a project number, when this project's number is unknown, may be its own or another's: said,
    // not called another project's (review of part 3, L5). A project id never is all digits.
    ...(pol && own.ids.has(pol[1]!) ? { policyId: pol[2]! } : pol && !own.numbered && /^\d{1,30}$/.test(pol[1]!) ? { policyUnknown: true as const } : {}),
    severity: ALERT_SEVERITY[a.policy?.severity ?? ""] ?? "none",
    resourceType: RESOURCE_TYPE.test(type) ? type : "unknown",
    ...(metric && METRIC_TYPE.test(metric) ? { metric } : {}),
    ...(subject ? { subject } : {}),
  };
}
/** A monitored resource's type (k8s_container, gce_instance, …); another text shows as "unknown". */
const RESOURCE_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * An open alert of the project as the agent's gcp_alerts lists it (D192): the GKE cluster it is on, or its other labels.
 * `kube`: its resource is, or may be, a Kubernetes cluster's (M3); `namespace`: the namespace its labels name, when it is
 * a Kubernetes name. A limited session sees a `kube` row only with a namespace of its own (D195).
 */
export type ProjectAlert = GcpAlert & { cluster?: { location: string; name: string }; labels?: [string, string][]; kube?: true; namespace?: string };

/**
 * Every open alert of the project as gcp_alerts lists it (wave 9 part 4, D192), pure: newest first, one per id. A
 * Kubernetes resource or a Prometheus target names its GKE cluster (`cluster`, when both values are GKE's shapes);
 * another resource carries its labels (`other`, cleaned at the read). `unreadable` counts rows with no usable id or
 * opening time, so the list never reads as whole when some were dropped.
 */
export function alertRows(raw: RawAlert[], c: { project: string; number?: string }): { items: ProjectAlert[]; unreadable: number } {
  const own = ownIds(c);
  const items: ProjectAlert[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const a of raw) {
    const id = idOf(a);
    const row = toAlert(a, own);
    if (!row || seen.has(id)) {
      if (!seen.has(id)) unreadable++;
      continue;
    }
    seen.add(id);
    const l = a.resource?.labels ?? {};
    const type = a.resource?.type;
    const kube = !!a.resource?.kube || (CLUSTER_RESOURCES as readonly string[]).includes(type ?? "");
    // Any Kubernetes row names its cluster by cluster_name (a Prometheus target by cluster) and location (M3).
    const name = !kube ? undefined : type === "prometheus_target" ? l.cluster : l.cluster_name ?? l.cluster;
    const cluster = name && GKE_NAME.test(name) && l.location && GKE_LOCATION.test(l.location) ? { location: l.location, name } : undefined;
    // One namespace, said the same way by every key that names one; two different ones are none (it can't be told).
    const named = new Set([l.namespace_name, l.namespace, l.namespace_id].filter((x) => x !== undefined));
    const ns = named.size === 1 ? [...named][0] : undefined;
    items.push({
      ...row, ...(cluster ? { cluster } : {}), ...(a.resource?.other?.length ? { labels: a.resource.other } : {}),
      ...(kube ? { kube: true as const, ...(isNamespace(ns) ? { namespace: ns } : {}) } : {}),
    });
  }
  items.sort((x, y) => y.opened.localeCompare(x.opened));
  return { items, unreadable };
}

/** An alert policy's detail as an alert shows it (D187). */
export type AlertPolicyDetail = { conditions: string[]; documentation?: string; cut: boolean };

/**
 * One alert policy of the project (D187): `GET /v3/projects/<project>/alertPolicies/<digits>`, 10 s, 1 MB. Up to five
 * condition names (120 characters each) and the documentation as plain text: one line, cleaned, redacted, then cut to
 * 300 (`cut` says so). The documentation's links and the policy's labels are not read.
 */
export async function alertPolicy(client: GcpClient, project: string, policyId: string): Promise<AlertPolicyDetail> {
  checkProject(project);
  if (!/^\d{1,30}$/.test(policyId)) throw new GcpError(400, "That isn't an alert policy.");
  const r = Policy.safeParse(await client.get("monitoring", `/v3/projects/${project}/alertPolicies/${policyId}`, {}, project, { limitMs: POLICY_LIMIT_MS, maxBytes: POLICY_MAX_BYTES }));
  if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
  const conditions = (r.data.conditions ?? []).map((x) => outsideText(x.displayName ?? "", 120)).filter(Boolean).slice(0, POLICY_CONDITIONS);
  const content = r.data.documentation?.content ?? "";
  const whole = outsideText(content, 16_384);
  return {
    conditions,
    ...(whole ? { documentation: outsideText(content, POLICY_DOC_MAX) } : {}),
    cut: Array.from(whole).length > POLICY_DOC_MAX,
  };
}
