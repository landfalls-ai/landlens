// What is wrong in a cluster right now, problems first. One computation for the Overview page (with your own
// access) and the agent's cluster_overview tool (with the session's token, through the front door).
import type { ClusterHealth, DoctorCheck, DoctorCheckState, HealthEvent, KubeObject, Problem } from "@landlens/contracts";
import { type CertInput, cleanText as clean, diagnose } from "./doctor.js";
import { age, nodeStatus, podRestarts, podStatus } from "./status.js";

/** GET a path and parse its JSON; throws with `status` on an HTTP error. */
export type GetJson = (path: string) => Promise<any>;

/** Waiting reasons that mean a container can't run, not that it is still starting. */
export const BAD_WAITING = new Set([
  "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError",
  "InvalidImageName", "RunContainerError",
]);

const ns = (namespace: string | undefined, resource: string, group = "", version = "v1") => {
  const base = group ? `/apis/${group}/${version}` : `/api/${version}`;
  return `${base}${namespace ? `/namespaces/${namespace}` : ""}/${resource}`;
};

/** The sentence for each check that couldn't run (D56): fewer checks, said plainly. */
export const CHECK_SENTENCES: Record<Exclude<DoctorCheck, "pods">, string> = {
  certs: "Can't read Secrets here, so certificates aren't checked.",
  events: "Can't read events here, so failing probes and warning events aren't checked; pods that are running but not ready are still listed.",
  workloads: "Can't read Deployments, StatefulSets or DaemonSets here, so short workloads aren't checked.",
  nodes: "Can't read nodes here.",
};
export function missingChecks(checks: Partial<Record<DoctorCheck, DoctorCheckState>> | undefined): string[] {
  const out: string[] = [];
  for (const k of ["workloads", "events", "nodes", "certs"] as const) if (checks?.[k] === "forbidden" || checks?.[k] === "error") out.push(CHECK_SENTENCES[k]);
  return out;
}

const state = (e: any): DoctorCheckState => (e?.status === 403 || e?.status === 401 || /\b403\b|forbidden/i.test(String(e?.message ?? "")) ? "forbidden" : "error");

/** Warning events, newest pages first, at most `max`. */
export async function warningEvents(get: GetJson, namespace: string | undefined, max = 2000): Promise<KubeObject[]> {
  const out: KubeObject[] = [];
  let cont: string | undefined;
  do {
    const q = new URLSearchParams({ limit: "500", fieldSelector: "type=Warning", ...(cont ? { continue: cont } : {}) });
    const page = await get(`${ns(namespace, "events")}?${q}`);
    out.push(...((page?.items ?? []) as KubeObject[]));
    cont = page?.metadata?.continue || undefined;
  } while (cont && out.length < max);
  return out.slice(0, max);
}

export type HealthOptions = {
  namespace?: string;
  now?: number;
  warnings?: number;
  /** Certificate facts from someone who may read Secrets (the agent's token never can, D67). */
  certs?: () => Promise<CertInput[] | undefined>;
};

/** Counts and the doctor's problems from one set of reads (D46): the agent's cluster_overview and tests use it. */
export async function clusterHealth(get: GetJson, opts: HealthOptions = {}): Promise<ClusterHealth> {
  const now = opts.now ?? Date.now();
  const namespace = opts.namespace;
  const checks: Record<DoctorCheck, DoctorCheckState> = { pods: "ok", workloads: "ok", nodes: namespace ? "off" : "ok", events: "ok", certs: "off" };
  const pods = ((await get(`${ns(namespace, "pods")}?limit=5000`)).items ?? []) as KubeObject[];
  const list = (path: string, check: DoctorCheck) => get(path).then((l) => (l.items ?? []) as KubeObject[], (e) => ((checks[check] = state(e)), undefined));
  const [deployments, statefulsets, daemonsets, nodes, events, certs] = await Promise.all([
    list(`${ns(namespace, "deployments", "apps")}?limit=2000`, "workloads"),
    list(`${ns(namespace, "statefulsets", "apps")}?limit=2000`, "workloads"),
    list(`${ns(namespace, "daemonsets", "apps")}?limit=2000`, "workloads"),
    namespace ? Promise.resolve(undefined) : list("/api/v1/nodes", "nodes"),
    warningEvents(get, namespace).catch((e) => ((checks.events = state(e)), undefined)),
    opts.certs ? opts.certs().then((c) => ((checks.certs = c ? "ok" : "forbidden"), c), () => ((checks.certs = "error"), undefined)) : Promise.resolve(undefined),
  ]);
  const report = diagnose({
    pods, ...(deployments ? { deployments } : {}), ...(statefulsets ? { statefulsets } : {}), ...(daemonsets ? { daemonsets } : {}),
    ...(nodes ? { nodes } : {}), ...(events ? { events } : {}), ...(certs ? { certs } : {}), checks,
  }, now);
  return { ...healthCounts(pods, deployments, nodes, now), problems: report.problems, cut: report.cut, checks: report.checks, warnings: recentWarnings(events ?? [], now, opts.warnings ?? 25) };
}

/** The Overview's tiles: pods by state, deployments available, nodes ready. */
export function healthCounts(podList: KubeObject[], deploymentList: KubeObject[] | undefined, nodeList: KubeObject[] | undefined, now: number): Omit<ClusterHealth, "problems" | "warnings" | "checks" | "cut"> {
  const pods = { total: 0, running: 0, succeeded: 0, pending: 0, failing: 0, restarts: 0 };
  const namespaces = new Set<string>();
  for (const p of podList) {
    pods.total++;
    namespaces.add(p.metadata.namespace ?? "");
    pods.restarts += podRestarts(p).sort;
    const status = podStatus(p);
    if (status.tone === "bad") pods.failing++;
    else if (p.status?.phase === "Succeeded") pods.succeeded++;
    else if (p.status?.phase === "Running") pods.running++;
    else pods.pending++;
  }
  let deployments: ClusterHealth["deployments"] = null;
  if (deploymentList) {
    deployments = { total: 0, available: 0 };
    for (const d of deploymentList) {
      deployments.total++;
      if ((d.status?.availableReplicas ?? 0) >= (d.spec?.replicas ?? 1)) deployments.available++;
    }
  }
  let nodes: ClusterHealth["nodes"] = null;
  if (nodeList) {
    nodes = { total: 0, ready: 0, items: [] };
    for (const n of nodeList) {
      const ready = nodeStatus(n).tone === "ok";
      nodes.total++;
      if (ready) nodes.ready++;
      const roles = Object.keys(n.metadata.labels ?? {}).filter((l) => l.startsWith("node-role.kubernetes.io/")).map((l) => l.slice(24));
      nodes.items.push({ name: n.metadata.name, ready, version: n.status?.nodeInfo?.kubeletVersion ?? "", roles });
    }
  }
  void now;
  return { at: new Date(now).toISOString(), nodes, pods, deployments, namespaces: namespaces.size };
}

/** The last hour's warning events, newest first (the Overview's "Recent warnings"). */
export function recentWarnings(events: KubeObject[], now: number, max = 25): HealthEvent[] {
  const when = (e: any) => Date.parse(e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? 0);
  return (events as any[])
    .filter((e) => (!e.type || e.type === "Warning") && now - when(e) <= 3_600_000)
    .sort((x, y) => when(y) - when(x))
    .slice(0, max)
    .map((e) => ({
      at: new Date(when(e) || now).toISOString(),
      ...(e.involvedObject?.namespace ? { namespace: e.involvedObject.namespace } : {}),
      kind: clean(e.involvedObject?.kind, 64),
      name: clean(e.involvedObject?.name, 253),
      reason: clean(e.reason, 64),
      message: clean(e.message),
      count: Number(e.series?.count ?? e.count) || 1,
    }));
}

/** The health as the agent reads it: one line per problem (worst first, with its id), what wasn't checked, counts, events. */
export function healthText(h: ClusterHealth, now = Date.parse(h.at)): string {
  const where = (p: Problem) => `${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}`;
  const line = (p: Problem) => `- [${p.tone === "bad" ? "failing" : "to watch"}] ${where(p)}: ${p.title}${p.detail ? ` (${p.detail})` : ""}. id: ${p.id}`;
  const head = h.problems.length
    ? `Problems (${h.problems.length}${h.cut ? ", the first 500" : ""}):\n${h.problems.map(line).join("\n")}`
    : "No problems found.";
  const missing = missingChecks(h.checks);
  const counts = `Pods: ${h.pods.total} (${h.pods.running} running, ${h.pods.pending} pending, ${h.pods.failing} failing)` +
    (h.deployments ? `; deployments ${h.deployments.available}/${h.deployments.total} available` : "") +
    (h.nodes ? `; nodes ${h.nodes.ready}/${h.nodes.total} ready` : "");
  const warnings = h.warnings.length
    ? h.warnings.map((e) => `- ${age(Date.parse(e.at), now)} ${e.reason} ${e.kind}/${e.namespace ? `${e.namespace}/` : ""}${e.name} (x${e.count}): ${e.message}`).join("\n")
    : "none in the last hour";
  return `${head}${missing.length ? `\n\nNot checked: ${missing.join(" ")}` : ""}\n\n${counts}\n\nRecent warning events:\n${warnings}`;
}
