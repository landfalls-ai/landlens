// What is wrong in a cluster right now, problems first. One computation for the Overview page (with your own
// access) and the agent's cluster_overview tool (with the session's token, through the front door).
import type { ClusterHealth, HealthEvent, HealthProblem, KubeObject } from "@landlens/contracts";
import { age, nodeStatus, podReady, podRestarts, podStatus } from "./status.js";

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

export async function clusterHealth(get: GetJson, opts: { namespace?: string; now?: number; warnings?: number } = {}): Promise<ClusterHealth> {
  const now = opts.now ?? Date.now();
  const namespace = opts.namespace;
  const problems: HealthProblem[] = [];
  const pods = { total: 0, running: 0, succeeded: 0, pending: 0, failing: 0, restarts: 0 };
  const namespaces = new Set<string>();

  const podList = await get(`${ns(namespace, "pods")}?limit=5000`);
  for (const p of (podList.items ?? []) as KubeObject[]) {
    pods.total++;
    namespaces.add(p.metadata.namespace ?? "");
    const restarts = podRestarts(p).sort;
    pods.restarts += restarts;
    const status = podStatus(p);
    if (status.tone === "bad") pods.failing++;
    else if (p.status?.phase === "Succeeded") pods.succeeded++;
    else if (p.status?.phase === "Running") pods.running++;
    else pods.pending++;

    const base = { kind: "Pod" as const, namespace: p.metadata.namespace, name: p.metadata.name };
    const before = problems.length;
    for (const c of p.status?.containerStatuses ?? []) {
      const waiting: string | undefined = c.state?.waiting?.reason;
      const last = c.lastState?.terminated;
      const exit = last ? `; last exit ${last.reason ?? "?"} code ${last.exitCode}` : "";
      if (waiting && BAD_WAITING.has(waiting)) {
        problems.push({
          ...base, reason: waiting, tone: "bad", container: c.name, restarts: c.restartCount,
          detail: `in container ${c.name} (${c.restartCount} restarts)${exit}${c.state.waiting.message ? `; ${c.state.waiting.message}` : ""}`,
        });
      } else if (last?.reason === "OOMKilled") {
        problems.push({ ...base, reason: "OOMKilled", tone: "bad", container: c.name, restarts: c.restartCount, detail: `container ${c.name} was OOMKilled (${c.restartCount} restarts)` });
      }
    }
    if (problems.length > before) continue;
    const created = Date.parse(p.metadata.creationTimestamp ?? "");
    if (p.status?.phase === "Pending" && now - created > 120_000) {
      const unsched = (p.status?.conditions ?? []).find((c: any) => c.type === "PodScheduled" && c.status === "False");
      problems.push({ ...base, reason: "Pending", tone: "warn", detail: `for ${age(created, now)}${unsched?.message ? `; ${unsched.message}` : ""}` });
    } else if (p.status?.phase === "Running" && podReady(p).tone !== "ok") {
      problems.push({ ...base, reason: "NotReady", tone: "warn", detail: `Running but not ready (${podReady(p).text})` });
    } else if (restarts >= 5) {
      problems.push({ ...base, reason: "Restarts", tone: "warn", restarts, detail: `${restarts} restarts (${status.text})` });
    }
  }

  let deployments: ClusterHealth["deployments"] = null;
  try {
    const list = await get(`${ns(namespace, "deployments", "apps")}?limit=2000`);
    deployments = { total: 0, available: 0 };
    for (const d of list.items ?? []) {
      deployments.total++;
      const want = d.spec?.replicas ?? 1;
      const have = d.status?.availableReplicas ?? 0;
      if (have >= want) deployments.available++;
      else problems.push({ kind: "Deployment", namespace: d.metadata.namespace, name: d.metadata.name, reason: "Unavailable", tone: have === 0 ? "bad" : "warn", detail: `${have}/${want} available` });
    }
  } catch {
    // Not readable with this access; the page and the tool say so by leaving it null.
  }

  let nodes: ClusterHealth["nodes"] = null;
  if (!namespace) {
    try {
      const list = await get("/api/v1/nodes");
      nodes = { total: 0, ready: 0, items: [] };
      for (const n of list.items ?? []) {
        const ready = nodeStatus(n).tone === "ok";
        nodes.total++;
        if (ready) nodes.ready++;
        else problems.push({ kind: "Node", name: n.metadata.name, reason: "NotReady", tone: "bad", detail: nodeStatus(n).text });
        for (const c of n.status?.conditions ?? []) {
          if (c.type !== "Ready" && c.status === "True") problems.push({ kind: "Node", name: n.metadata.name, reason: c.type, tone: "warn", detail: c.message ?? c.type });
        }
        const roles = Object.keys(n.metadata.labels ?? {}).filter((l) => l.startsWith("node-role.kubernetes.io/")).map((l) => l.slice(24));
        nodes.items.push({ name: n.metadata.name, ready, version: n.status?.nodeInfo?.kubeletVersion ?? "", roles });
      }
    } catch {
      // A namespace-limited token can't list nodes.
    }
  }

  const q = new URLSearchParams({ limit: "500", fieldSelector: "type=Warning" });
  const events = await get(`${ns(namespace, "events")}?${q}`).then((l) => l.items ?? [], () => []);
  const when = (e: any) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? 0);
  const warnings: HealthEvent[] = [...events].sort((x, y) => when(y) - when(x)).slice(0, opts.warnings ?? 25).map((e: any) => ({
    at: new Date(when(e) || now).toISOString(),
    ...(e.involvedObject?.namespace ? { namespace: e.involvedObject.namespace } : {}),
    kind: e.involvedObject?.kind ?? "",
    name: e.involvedObject?.name ?? "",
    reason: e.reason ?? "",
    message: String(e.message ?? "").replace(/\s+/g, " ").trim(),
    count: e.count ?? 1,
  }));

  // Worst first: failing before warnings, then by restarts.
  problems.sort((a, b) => (a.tone === b.tone ? (b.restarts ?? 0) - (a.restarts ?? 0) : a.tone === "bad" ? -1 : 1));
  return { at: new Date(now).toISOString(), nodes, pods, deployments, namespaces: namespaces.size, problems, warnings };
}

/** The health as the agent reads it: problems one per line, then the warning events. */
export function healthText(h: ClusterHealth, now = Date.parse(h.at)): string {
  const line = (p: HealthProblem) =>
    p.kind === "Pod"
      ? p.reason === "OOMKilled" || p.reason === "Pending" || p.reason === "NotReady" || p.reason === "Restarts"
        ? `pod ${p.namespace}/${p.name}: ${p.reason === "Pending" ? `Pending ${p.detail}` : p.detail}`
        : `pod ${p.namespace}/${p.name}: ${p.reason} ${p.detail}`
      : p.kind === "Deployment"
        ? `deployment ${p.namespace}/${p.name}: ${p.detail}`
        : `node ${p.name}: ${p.detail}`;
  const head = h.problems.length
    ? `Problems (${h.problems.length}):\n${h.problems.map((p) => `- ${line(p)}`).join("\n")}`
    : "No failing pods, short deployments or unready nodes found.";
  const counts = `Pods: ${h.pods.total} (${h.pods.running} running, ${h.pods.pending} pending, ${h.pods.failing} failing)` +
    (h.deployments ? `; deployments ${h.deployments.available}/${h.deployments.total} available` : "") +
    (h.nodes ? `; nodes ${h.nodes.ready}/${h.nodes.total} ready` : "");
  const warnings = h.warnings.length
    ? h.warnings.map((e) => `- ${age(Date.parse(e.at), now)} ${e.reason} ${e.kind}/${e.namespace ? `${e.namespace}/` : ""}${e.name} (x${e.count}): ${e.message}`).join("\n")
    : "none";
  return `${head}\n\n${counts}\n\nRecent warning events:\n${warnings}`;
}
