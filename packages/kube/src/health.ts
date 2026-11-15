// What is wrong in a cluster right now, problems first. One computation for the Overview page (with your own
// access) and the agent's cluster_overview tool (with the session's token, through the front door).
import type { ClusterHealth, DoctorCheck, DoctorCheckState, HealthEvent, KubeObject, Problem } from "@landlens/contracts";
import { type CertInput, diagnose, warningRows } from "./doctor.js";
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

/** The sentence for each check that couldn't run or ran on part of the data (D56): fewer checks, said plainly. */
export { CHECK_SENTENCES, checkSentence, missingChecks } from "./checks.js";
import { missingChecks } from "./checks.js";

const state = (e: any): DoctorCheckState => (e?.status === 403 || e?.status === 401 ? "forbidden" : "error");

/**
 * A list in pages of 500, at most `max` (security review, part 2, finding 1: one big answer could pass the 32 MB cap and
 * fail outright). A page that fails after others were read keeps those (partial); more than `max` is partial too.
 * The first page's failure is thrown. The API server can't sort, so the cap leaves out whatever comes last.
 */
export async function listPages(get: GetJson, path: string, max: number, params: Record<string, string> = {}): Promise<{ items: KubeObject[]; partial: boolean }> {
  const out: KubeObject[] = [];
  let cont: string | undefined;
  do {
    const q = new URLSearchParams({ limit: String(Math.min(500, max)), ...params, ...(cont ? { continue: cont } : {}) });
    let page: any;
    try {
      page = await get(`${path}?${q}`);
    } catch (e) {
      if (!out.length) throw e;
      return { items: out, partial: true };
    }
    out.push(...((Array.isArray(page?.items) ? page.items : []) as KubeObject[]));
    cont = typeof page?.metadata?.continue === "string" && page.metadata.continue ? page.metadata.continue : undefined;
  } while (cont && out.length < max);
  return { items: out.slice(0, max), partial: !!cont || out.length > max };
}

/** Warning events, at most `max`: the doctor's events source. */
export function warningEvents(get: GetJson, namespace: string | undefined, max = 2000): Promise<{ items: KubeObject[]; partial: boolean }> {
  return listPages(get, ns(namespace, "events"), max, { fieldSelector: "type=Warning" });
}

/** The doctor's list sizes: pods are the one required source. */
export const LIST_MAX = { pods: 5000, workloads: 2000, nodes: 2000 } as const;

export type HealthOptions = {
  namespace?: string;
  now?: number;
  warnings?: number;
  /**
   * Certificate facts from someone who may read Secrets (the agent's token never can, D67), with how far that read
   * got: `pending` while it hasn't finished, `partial` when some Secrets were left out.
   */
  certs?: () => Promise<{ state: DoctorCheckState; certs?: CertInput[] }>;
};

/** Counts and the doctor's problems from one set of reads (D46): the agent's cluster_overview and tests use it. */
export async function clusterHealth(get: GetJson, opts: HealthOptions = {}): Promise<ClusterHealth> {
  const now = opts.now ?? Date.now();
  const namespace = opts.namespace;
  const checks: Record<DoctorCheck, DoctorCheckState> = { pods: "ok", workloads: "ok", nodes: namespace ? "off" : "ok", events: "ok", certs: "off" };
  const podList = await listPages(get, ns(namespace, "pods"), LIST_MAX.pods);
  const pods = podList.items;
  if (podList.partial) checks.pods = "partial";
  const list = (path: string, check: DoctorCheck, max: number) => listPages(get, path, max).then((l) => {
    if (l.partial && checks[check] === "ok") checks[check] = "partial";
    return l.items;
  }, (e) => {
    if (checks[check] === "ok" || state(e) === "forbidden") checks[check] = state(e);
    return undefined;
  });
  const [deployments, statefulsets, daemonsets, nodes, events, certs] = await Promise.all([
    list(ns(namespace, "deployments", "apps"), "workloads", LIST_MAX.workloads),
    list(ns(namespace, "statefulsets", "apps"), "workloads", LIST_MAX.workloads),
    list(ns(namespace, "daemonsets", "apps"), "workloads", LIST_MAX.workloads),
    namespace ? Promise.resolve(undefined) : list("/api/v1/nodes", "nodes", LIST_MAX.nodes),
    warningEvents(get, namespace).then((r) => ((checks.events = r.partial ? "partial" : "ok"), r.items), (e) => ((checks.events = state(e)), undefined)),
    opts.certs ? opts.certs().then((c) => ((checks.certs = c.state), c.certs), () => ((checks.certs = "error"), undefined)) : Promise.resolve(undefined),
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
    if (!p?.metadata) continue;
    pods.total++;
    namespaces.add(p.metadata.namespace ?? "");
    try {
      pods.restarts += podRestarts(p).sort;
      const status = podStatus(p);
      if (status.tone === "bad") pods.failing++;
      else if (p.status?.phase === "Succeeded") pods.succeeded++;
      else if (p.status?.phase === "Running") pods.running++;
      else pods.pending++;
    } catch {
      pods.failing++; // a pod whose status can't be read isn't counted as healthy
    }
  }
  let deployments: ClusterHealth["deployments"] = null;
  if (deploymentList) {
    deployments = { total: 0, available: 0 };
    for (const d of deploymentList) {
      if (!d?.metadata) continue;
      deployments.total++;
      if ((d.status?.availableReplicas ?? 0) >= (d.spec?.replicas ?? 1)) deployments.available++;
    }
  }
  let nodes: ClusterHealth["nodes"] = null;
  if (nodeList) {
    nodes = { total: 0, ready: 0, items: [] };
    for (const n of nodeList) {
      if (!n?.metadata?.name || (n.status?.conditions !== undefined && !Array.isArray(n.status.conditions)) || (n.status?.conditions ?? []).some((c: unknown) => !c)) continue;
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

/**
 * The last hour's warning events, newest first (the Overview's "Recent warnings"). Read by the doctor's rules, so the
 * same events are dropped: forged future dates, objects not named like one, malformed items (part 2 review, finding 4).
 */
export function recentWarnings(events: KubeObject[], now: number, max = 25): HealthEvent[] {
  return warningRows(events, now).slice(0, max).map((e) => ({
    at: e.at, ...(e.namespace ? { namespace: e.namespace } : {}), kind: e.kind, name: e.name, reason: e.reason, message: e.message, count: e.count,
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
