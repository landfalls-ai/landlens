// The agent's cluster tools: read-only, redacted, and phrased the way kubectl prints so Claude reads them easily.
// Every call goes through the front door with the session's own token (cluster.ts), so the policy and the audit
// trail apply to these exactly as to the agent's kubectl.
//
// Four of them have an MCP App (apps.ts): cluster_overview, metrics, describe and get_logs. Their text result is what
// it always was, for the model; the view gets the same facts as structuredContent, which the gateway keeps for the view
// and doesn't hand to Claude Code (docs/mcp.md).
import { FAILURE_LINE, type KubeObject, type MetricsSeries, type ResourceType } from "@landlens/contracts";
import { clusterHealth, healthText, KubeError } from "@landlens/kube";
import { age, nodeStatus, podReady, podRestarts, podStatus, type Tone } from "@landlens/kube/status";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stringify } from "yaml";
import { z } from "zod";
import { APP_URI, registerApps } from "./apps.js";
import { getJson, getText, pathFor, resolveKind, type AgentCluster } from "./cluster.js";
import { capResult, redactObject, redactText } from "./redact.js";
import { registerWriteTools } from "./writes.js";

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
/** What a tool body returns: its text, and for an app tool the data its view draws. */
type Out = string | { text: string; data: Record<string, unknown> };

/** The `_meta` key the gateway puts a call's id in, so the tools can tag their front-door requests with it. */
export const CALL_META = "landlens/callId";
const CALL_ID = /^c[0-9a-z]{1,24}$/;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const text = (s: string): Result => ({ content: [{ type: "text", text: capResult(redactText(s)) }] });
const failure = (err: unknown): Result => {
  const message = err instanceof KubeError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: redactText(message) }] };
};

type Extra = { _meta?: Record<string, unknown> };

/**
 * Run a tool body on the cluster as this call sees it (tagged with the gateway's call id when there is one). Kubernetes
 * and Landlens refusals come back as tool errors Claude can read and act on.
 */
const runner = (cluster: AgentCluster) => <A>(fn: (args: A, c: AgentCluster) => Promise<Out>) => async (args: A, extra?: Extra): Promise<Result> => {
  const id = extra?._meta?.[CALL_META];
  const c = typeof id === "string" && CALL_ID.test(id) && cluster.withCall ? cluster.withCall(id) : cluster;
  try {
    const out = await fn(args, c);
    if (typeof out === "string") return text(out);
    return { ...text(out.text), structuredContent: redactObject(out.data) as Record<string, unknown> };
  } catch (err) {
    return failure(err);
  }
};

const yaml = (o: unknown) => stringify(redactObject(o), { lineWidth: 0 });

/** Columns, padded like kubectl's. */
function table(header: string[], rows: string[][]): string {
  if (!rows.length) return "(none)";
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.min(60, Math.max(...all.map((r) => (r[i] ?? "").length))));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i]!))).join("  ")).join("\n");
}

const ago = (ts: string | undefined, now: number) => (ts ? age(Date.parse(ts), now) : "?");

const Kind = z.string().min(1).max(120).describe('A kind as kubectl takes it: "pods", "pod", "po", "deployments.apps", "Deployment"');
const Namespace = z.string().max(63).optional().describe("Namespace; omit for all namespaces or cluster-scoped kinds");

export function registerTools(server: McpServer, cluster: AgentCluster) {
  const run = runner(cluster);
  const kind = async (k: string) => resolveKind(await cluster.types(), k);
  const limitNote = cluster.namespaces?.length ? ` This session may only read namespaces ${cluster.namespaces.join(", ")}.` : "";
  registerApps(server);
  registerWriteTools(server, cluster);

  server.registerTool("api_resources", {
    title: "API resources",
    description: "The kinds this cluster serves (like kubectl api-resources): name, short names, group/version, scope." + limitNote,
    inputSchema: {},
    annotations: READ_ONLY,
  }, run(async () => {
    const types = await cluster.types();
    return table(["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"], types.map((t) => [
      t.resource, (t.shortNames ?? []).join(","), t.group ? `${t.group}/${t.version}` : t.version, String(t.namespaced), t.kind,
    ]));
  }));

  server.registerTool("list_resources", {
    title: "List resources",
    description: "List objects of one kind (like kubectl get), with a status summary for pods, deployments and nodes." + limitNote,
    inputSchema: {
      kind: Kind,
      namespace: Namespace,
      labelSelector: z.string().max(512).optional(),
      fieldSelector: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 100"),
    },
    annotations: READ_ONLY,
  }, run(async (a: { kind: string; namespace?: string; labelSelector?: string; fieldSelector?: string; limit?: number }, c) => {
    const t = await kind(a.kind);
    const q = new URLSearchParams({ limit: String(a.limit ?? 100) });
    if (a.labelSelector) q.set("labelSelector", a.labelSelector);
    if (a.fieldSelector) q.set("fieldSelector", a.fieldSelector);
    const list = await getJson(c, `${pathFor(t, t.namespaced ? a.namespace : undefined)}?${q}`);
    const items: KubeObject[] = list.items ?? [];
    const more = list.metadata?.continue ? `\n(more than ${items.length}; narrow with a namespace or selector)` : "";
    return `${t.kind} (${items.length})\n${rowsFor(t, items, Date.now())}${more}`;
  }));

  server.registerTool("get_resource", {
    title: "Get resource",
    description: "One object as YAML (managed fields, last-applied and env values removed; credentials scrubbed).",
    inputSchema: { kind: Kind, name: z.string().min(1).max(253), namespace: Namespace },
    annotations: READ_ONLY,
  }, run(async (a: { kind: string; name: string; namespace?: string }, c) => {
    const t = await kind(a.kind);
    return yaml(await getJson(c, pathFor(t, t.namespaced ? a.namespace : undefined, a.name)));
  }));

  registerAppTool(server, "describe", {
    title: "Describe",
    description: "One object with what explains it (like kubectl describe): its state, its owners up to the Deployment, " +
      "container states and last exits for pods, and its recent events. Start here for a failing workload.",
    inputSchema: { kind: Kind, name: z.string().min(1).max(253), namespace: Namespace },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: APP_URI.object } },
  }, run(async (a: { kind: string; name: string; namespace?: string }, c) => {
    const t = await kind(a.kind);
    const ns = t.namespaced ? a.namespace : undefined;
    const o: KubeObject = await getJson(c, pathFor(t, ns, a.name));
    const now = Date.now();
    const parts = [`${t.kind} ${ns ? `${ns}/` : ""}${o.metadata.name} (created ${ago(o.metadata.creationTimestamp, now)} ago)`];
    if (t.resource === "pods" && !t.group) parts.push(describePod(o));
    const owners = await ownerChain(c, o, ns);
    if (owners.length) parts.push("Owners:\n" + owners.map((s) => `  ${s}`).join("\n"));
    const events = await recentEvents(c, { uid: o.metadata.uid, namespace: ns });
    parts.push("Events:\n" + indent(eventsTable(events, now)));
    parts.push("Object:\n" + indent(yaml(o)));
    return { text: parts.join("\n\n"), data: objectCard(cluster.context, t, o, owners, events, now) };
  }));

  server.registerTool("get_events", {
    title: "Events",
    description: "Recent events, newest first; optionally for one object or only warnings. Kubernetes keeps events about an hour.",
    inputSchema: {
      namespace: Namespace,
      kind: z.string().max(63).optional().describe("Involved object's Kind, e.g. Pod"),
      name: z.string().max(253).optional().describe("Involved object's name"),
      warningsOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: READ_ONLY,
  }, run(async (a: { namespace?: string; kind?: string; name?: string; warningsOnly?: boolean; limit?: number }, c) =>
    eventsTable(await recentEvents(c, a), Date.now())));

  registerAppTool(server, "get_logs", {
    title: "Pod logs",
    description: "A container's log tail. Use previous: true to read the run before the last restart (why it crashed).",
    inputSchema: {
      name: z.string().min(1).max(253).describe("Pod name"),
      namespace: z.string().min(1).max(63),
      container: z.string().max(63).optional().describe("Needed when the pod has more than one container"),
      previous: z.boolean().optional(),
      tailLines: z.number().int().min(1).max(2000).optional().describe("Default 200"),
      sinceSeconds: z.number().int().min(1).optional(),
    },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: APP_URI.logs } },
  }, run(async (a: { name: string; namespace: string; container?: string; previous?: boolean; tailLines?: number; sinceSeconds?: number }, c) => {
    const q = new URLSearchParams({ tailLines: String(a.tailLines ?? 200) });
    if (a.container) q.set("container", a.container);
    if (a.previous) q.set("previous", "true");
    if (a.sinceSeconds) q.set("sinceSeconds", String(a.sinceSeconds));
    const pods = { group: "", version: "v1", resource: "pods" };
    const log = await getText(c, `${pathFor(pods, a.namespace, a.name)}/log?${q}`);
    const shown = log.trim() ? log : "(empty log)";
    const lines = capResult(redactText(log)).replace(/\n$/, "").split("\n").slice(-2000);
    // The kubelet sometimes answers 200 with why it couldn't read the log instead of a log.
    const unreadable = lines.length <= 2 && UNREADABLE_LOG.test(lines[0] ?? "") ? lines.join(" ") : undefined;
    return {
      text: shown,
      data: {
        context: cluster.context, pod: a.name, namespace: a.namespace, ...(a.container ? { container: a.container } : {}), previous: !!a.previous,
        lines: log.trim() ? lines : [], hits: unreadable ? [] : lines.flatMap((l, i) => (FAILURE_LINE.test(l) ? [i] : [])),
        ...(unreadable ? { unreadable } : {}),
      },
    };
  }));

  registerAppTool(server, "cluster_overview", {
    title: "Cluster overview",
    description: "What is wrong right now, problems first, grouped by owner: crash loops, failing probes, image pulls, " +
      "OOM kills, pending pods, workloads short of replicas, nodes not ready, expiring TLS certificates and recent warning " +
      "events, each with an id, then the checks that couldn't be made." + limitNote,
    inputSchema: { namespace: Namespace },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: APP_URI.health } },
  }, run(async (a: { namespace?: string }, c) => {
    // Certificates come from the person's own check, for the namespaces this call may see: the one asked, else the
    // session's limit, else all (D67). The session's token never reads a Secret.
    // A namespace outside the session's limit gets no certificates at all, whatever the reads around them do (the
    // front door refuses its pods today; this doesn't depend on that order: review of part 4, M1).
    const limit = cluster.namespaces?.length ? cluster.namespaces : undefined;
    const allowed = !a.namespace || !limit || limit.includes(a.namespace);
    const certNs = a.namespace ? [a.namespace] : limit;
    const certs = allowed ? (c.certs ?? cluster.certs) : undefined;
    const h = await clusterHealth((path) => getJson(c, path), {
      ...(a.namespace ? { namespace: a.namespace } : {}),
      ...(certs ? { certs: () => certs(certNs) } : {}),
    });
    return { text: healthText(h), data: { context: cluster.context, ...(a.namespace ? { namespace: a.namespace } : {}), health: h } };
  }));

  registerAppTool(server, "metrics", {
    title: "CPU and memory over time",
    description: "CPU and memory usage over the last 1h, 6h or 24h for the cluster, a node, a namespace, a pod, or a " +
      "Deployment, StatefulSet or DaemonSet, with requests and limits; from Clickland when Landlens has it, the cluster's " +
      "Prometheus once chosen, or Cloud Monitoring for a GKE cluster, else metrics-server sampled while Landlens is open. Use it to see whether a workload is near its limits or was killed for memory." + limitNote,
    inputSchema: {
      scope: z.enum(["cluster", "node", "namespace", "pod", "deployment", "statefulset", "daemonset"]).optional().describe("Default cluster"),
      namespace: z.string().max(63).optional().describe("Needed for namespace, pod and workload scopes"),
      name: z.string().max(253).optional().describe("The node, pod or workload; not for cluster or namespace"),
      range: z.enum(["1h", "6h", "24h"]).optional().describe("Default 1h"),
    },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: APP_URI.metrics } },
  }, run(async (a: { scope?: MetricsScopeName; namespace?: string; name?: string; range?: "1h" | "6h" | "24h" }, c) => {
    // c is the session's cluster tagged with this call: what metrics reads from the cluster (requests, limits,
    // allocatable, a workload's pods) goes through the front door with the session's token, under this call.
    const source = c.metrics ?? cluster.metrics;
    if (!source) throw new KubeError(503, "Landlens has no metrics source for this session.");
    const scope = a.scope ?? "cluster";
    const range = a.range ?? "1h";
    if (scope !== "cluster" && scope !== "node" && !a.namespace) throw new KubeError(400, `The ${scope} scope needs a namespace.`);
    if (scope !== "cluster" && scope !== "namespace" && !a.name) throw new KubeError(400, `The ${scope} scope needs a name.`);
    const limit = cluster.namespaces;
    if (limit?.length && (scope === "cluster" || scope === "node" || !limit.includes(a.namespace!))) {
      throw new KubeError(403, `This session may only read namespaces ${limit.join(", ")}.`);
    }
    const series = await source({ scope, range, ...(a.namespace && scope !== "cluster" && scope !== "node" ? { namespace: a.namespace } : {}), ...(a.name && scope !== "cluster" && scope !== "namespace" ? { name: a.name } : {}) });
    const what = scope === "cluster" ? `the cluster ${cluster.context}` : scope === "namespace" ? `namespace ${a.namespace}` : `${scope} ${a.namespace ? `${a.namespace}/` : ""}${a.name}`;
    return { text: metricsText(what, range, series), data: { context: cluster.context, scope, range, ...(a.namespace ? { namespace: a.namespace } : {}), ...(a.name ? { name: a.name } : {}), series: thin(series) } };
  }));

  server.registerTool("top", {
    title: "Resource usage",
    description: "CPU and memory now, from metrics-server (like kubectl top).",
    inputSchema: { what: z.enum(["pods", "nodes"]), namespace: Namespace },
    annotations: READ_ONLY,
  }, run(async (a: { what: "pods" | "nodes"; namespace?: string }, c) => {
    const t = { group: "metrics.k8s.io", version: "v1beta1", resource: a.what };
    let list: any;
    try {
      list = await getJson(c, pathFor(t, a.what === "pods" ? a.namespace : undefined));
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return "metrics-server is not installed in this cluster.";
      throw err;
    }
    const rows = (list.items ?? []).map((m: any) => {
      const cs: any[] = m.containers ?? [m];
      const cpu = cs.reduce((s, c) => s + cpuMillis(c.usage?.cpu), 0);
      const mem = cs.reduce((s, c) => s + memMi(c.usage?.memory), 0);
      return [...(a.what === "pods" ? [m.metadata.namespace] : []), m.metadata.name, `${Math.round(cpu)}m`, `${Math.round(mem)}Mi`];
    });
    return table([...(a.what === "pods" ? ["NAMESPACE"] : []), "NAME", "CPU", "MEMORY"], rows);
  }));

  server.registerTool("rollout_history", {
    title: "Rollout history",
    description: "A Deployment's revisions (its ReplicaSets): revision, age, images, ready replicas.",
    inputSchema: { name: z.string().min(1).max(253), namespace: z.string().min(1).max(63) },
    annotations: READ_ONLY,
  }, run(async (a: { name: string; namespace: string }, c) => {
    const d = await getJson(c, pathFor({ group: "apps", version: "v1", resource: "deployments" }, a.namespace, a.name));
    const sel = Object.entries(d.spec?.selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
    const q = new URLSearchParams({ limit: "100", ...(sel ? { labelSelector: sel } : {}) });
    const rs = await getJson(c, `${pathFor({ group: "apps", version: "v1", resource: "replicasets" }, a.namespace)}?${q}`);
    const now = Date.now();
    const mine = (rs.items ?? []).filter((r: any) => (r.metadata.ownerReferences ?? []).some((o: any) => o.uid === d.metadata.uid));
    mine.sort((x: any, y: any) => rev(y) - rev(x));
    return table(["REVISION", "REPLICASET", "AGE", "READY", "IMAGES"], mine.map((r: any) => [
      String(rev(r)), r.metadata.name, ago(r.metadata.creationTimestamp, now),
      `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}`,
      (r.spec?.template?.spec?.containers ?? []).map((c: any) => c.image).join(", "),
    ]));
  }));
}

const rev = (r: any) => Number(r.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
const indent = (s: string) => s.split("\n").map((l) => `  ${l}`).join("\n");

function rowsFor(t: ResourceType, items: KubeObject[], now: number): string {
  const ns = t.namespaced ? ["NAMESPACE"] : [];
  const nsOf = (o: KubeObject) => (t.namespaced ? [o.metadata.namespace ?? ""] : []);
  const created = (o: KubeObject) => ago(o.metadata.creationTimestamp, now);
  if (t.resource === "pods" && !t.group) {
    return table([...ns, "NAME", "READY", "STATUS", "RESTARTS", "AGE", "NODE"], items.map((o) => [
      ...nsOf(o), o.metadata.name, podReady(o).text, podStatus(o).text, podRestarts(o).text, created(o), o.spec?.nodeName ?? "",
    ]));
  }
  if (t.resource === "nodes" && !t.group) {
    return table(["NAME", "STATUS", "AGE", "VERSION"], items.map((o) => [
      o.metadata.name, nodeStatus(o).text, created(o), o.status?.nodeInfo?.kubeletVersion ?? "",
    ]));
  }
  if (["deployments", "statefulsets", "replicasets"].includes(t.resource) && t.group === "apps") {
    return table([...ns, "NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"], items.map((o) => [
      ...nsOf(o), o.metadata.name, `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}`,
      String(o.status?.updatedReplicas ?? 0), String(o.status?.availableReplicas ?? 0), created(o),
    ]));
  }
  return table([...ns, "NAME", "AGE"], items.map((o) => [...nsOf(o), o.metadata.name, created(o)]));
}

function describePod(o: KubeObject): string {
  const statuses = new Map<string, any>((o.status?.containerStatuses ?? []).map((c: any) => [c.name, c]));
  const lines = [`Status: ${podStatus(o).text}   Node: ${o.spec?.nodeName ?? "-"}   Ready: ${podReady(o).text}`];
  for (const c of o.spec?.containers ?? []) {
    const s = statuses.get(c.name);
    const state = s?.state ? Object.keys(s.state)[0] : "unknown";
    const detail = s?.state?.waiting?.reason ?? s?.state?.terminated?.reason ?? "";
    lines.push(`Container ${c.name}: ${state}${detail ? ` (${detail})` : ""}, ready ${s?.ready ?? false}, restarts ${s?.restartCount ?? 0}`);
    lines.push(`  image ${c.image}`);
    if (c.command || c.args) lines.push(`  command ${JSON.stringify([...(c.command ?? []), ...(c.args ?? [])])}`);
    const last = s?.lastState?.terminated;
    if (last) lines.push(`  last exit: ${last.reason ?? "?"} code ${last.exitCode} at ${last.finishedAt ?? "?"}${last.message ? `: ${last.message}` : ""}`);
    const envNames = (c.env ?? []).map((e: any) => e.name);
    if (envNames.length) lines.push(`  env names: ${envNames.join(", ")}`);
    for (const p of ["livenessProbe", "readinessProbe", "startupProbe"]) if (c[p]) lines.push(`  ${p}: ${JSON.stringify(c[p])}`);
    if (c.resources && Object.keys(c.resources).length) lines.push(`  resources: ${JSON.stringify(c.resources)}`);
  }
  for (const cond of o.status?.conditions ?? []) {
    if (cond.status !== "True") lines.push(`Condition ${cond.type}=${cond.status}${cond.reason ? ` (${cond.reason})` : ""}${cond.message ? `: ${cond.message}` : ""}`);
  }
  return lines.join("\n");
}

/** Pod → ReplicaSet → Deployment (and the like), from ownerReferences, three levels at most. */
async function ownerChain(cluster: AgentCluster, o: KubeObject, ns: string | undefined): Promise<string[]> {
  const out: string[] = [];
  let cur: KubeObject | undefined = o;
  for (let i = 0; i < 3 && cur; i++) {
    const ref: any = cur.metadata.ownerReferences?.find((r: any) => r.controller) ?? cur.metadata.ownerReferences?.[0];
    if (!ref) break;
    const group = String(ref.apiVersion ?? "").includes("/") ? String(ref.apiVersion).split("/")[0]! : "";
    const t = (await cluster.types()).find((x) => x.kind === ref.kind && x.group === group);
    if (!t) {
      out.push(`${ref.kind}/${ref.name}`);
      break;
    }
    try {
      cur = await getJson(cluster, pathFor(t, t.namespaced ? ns : undefined, ref.name));
    } catch {
      out.push(`${ref.kind}/${ref.name} (could not read)`);
      break;
    }
    const s: any = cur!.status ?? {};
    const ready = s.replicas !== undefined ? ` ready ${s.readyReplicas ?? 0}/${cur!.spec?.replicas ?? s.replicas}` : "";
    out.push(`${ref.kind}/${ref.name}${ready}`);
  }
  return out;
}

async function recentEvents(
  cluster: AgentCluster,
  a: { namespace?: string; kind?: string; name?: string; uid?: string; warningsOnly?: boolean; limit?: number },
): Promise<any[]> {
  const fields: string[] = [];
  if (a.uid) fields.push(`involvedObject.uid=${a.uid}`);
  if (a.kind) fields.push(`involvedObject.kind=${a.kind}`);
  if (a.name) fields.push(`involvedObject.name=${a.name}`);
  if (a.warningsOnly) fields.push("type=Warning");
  const q = new URLSearchParams({ limit: "500", ...(fields.length ? { fieldSelector: fields.join(",") } : {}) });
  const list = await getJson(cluster, `${pathFor({ group: "", version: "v1", resource: "events" }, a.namespace)}?${q}`);
  return [...(list.items ?? [])].sort((x, y) => when(y) - when(x)).slice(0, a.limit ?? 50);
}

const when = (e: any) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? 0);

function eventsTable(events: any[], now: number): string {
  return table(["AGE", "TYPE", "REASON", "OBJECT", "COUNT", "MESSAGE"], events.map((e: any) => [
    age(when(e), now), e.type ?? "", e.reason ?? "",
    `${e.involvedObject?.kind ?? ""}/${e.involvedObject?.namespace ? `${e.involvedObject.namespace}/` : ""}${e.involvedObject?.name ?? ""}`,
    String(e.count ?? 1), (e.message ?? "").replace(/\s+/g, " ").trim(),
  ]));
}

type MetricsScopeName = "cluster" | "node" | "namespace" | "pod" | "deployment" | "statefulset" | "daemonset";

/** Lines that look like the failure, for log output only: the log view and the dock's log wells use this one. */
export { FAILURE_LINE };

/** What the kubelet says instead of a log when it can't read one. */
export const UNREADABLE_LOG = /^(unable to retrieve container logs|failed to (get|try resolving|create fsnotify)|container "[^"]+" in pod "[^"]+" is (waiting to start|terminated)|previous terminated container "[^"]+" in pod "[^"]+" not found)/i;

/** What the object view draws: the facts describe prints, as data. */
function objectCard(context: string, t: ResourceType, o: KubeObject, owners: string[], events: any[], now: number): Record<string, unknown> {
  const pod = t.resource === "pods" && !t.group;
  const s: any = o.status ?? {};
  const st = pod ? podStatus(o) : workloadStatus(o);
  const statuses = new Map<string, any>((s.containerStatuses ?? []).map((c: any) => [c.name, c]));
  return {
    context,
    kind: t.kind,
    group: t.group,
    version: t.version,
    resource: t.resource,
    ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}),
    name: o.metadata.name,
    age: ago(o.metadata.creationTimestamp, now),
    ...(st ? { status: st } : {}),
    ...(pod ? { ready: podReady(o).text, restarts: podRestarts(o).text, node: o.spec?.nodeName ?? null } : {}),
    owners,
    containers: pod ? (o.spec?.containers ?? []).map((c: any) => {
      const cs = statuses.get(c.name);
      const state = cs?.state ? Object.keys(cs.state)[0] : "unknown";
      const last = cs?.lastState?.terminated;
      return {
        name: c.name, image: c.image, state, reason: cs?.state?.waiting?.reason ?? cs?.state?.terminated?.reason ?? null,
        ready: !!cs?.ready, restarts: cs?.restartCount ?? 0,
        ...(last ? { lastExit: { reason: last.reason ?? null, code: last.exitCode ?? null, message: last.message ?? null } } : {}),
      };
    }) : [],
    conditions: (s.conditions ?? []).map((c: any) => ({ type: c.type, ok: c.status === "True", reason: c.reason ?? null })),
    events: events.slice(0, 6).map((e: any) => ({ age: age(when(e), now), type: e.type ?? "", reason: e.reason ?? "", count: e.count ?? 1, message: String(e.message ?? "").replace(/\s+/g, " ").trim() })),
  };
}

function workloadStatus(o: KubeObject): { text: string; tone: Tone } | undefined {
  const s: any = o.status ?? {};
  const want = o.spec?.replicas;
  if (typeof want !== "number") return undefined;
  const ready = s.readyReplicas ?? s.availableReplicas ?? 0;
  if (want === 0) return { text: "Scaled to zero", tone: "muted" };
  return ready >= want ? { text: "Available", tone: "ok" } : { text: ready === 0 ? "Unavailable" : "Progressing", tone: ready === 0 ? "bad" : "warn" };
}

const cores = (v: number) => (v < 1 ? `${Math.round(v * 1000)}m` : `${Math.round(v * 100) / 100}`);
const bytes = (v: number) => (v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(1)}Gi` : `${Math.round(v / 2 ** 20)}Mi`);

/** A series key as the model may read it: a Kubernetes name (or "other"); anything else is not repeated. */
const keyText = (k: string) => (/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(k) ? k : "(unnamed)");
const finite = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v);
/** Most series lines per panel the model gets. */
const MAX_TEXT_SERIES = 40;

/** The model's view of a metrics series: per series latest, mean and max, and the reference lines. */
function metricsText(what: string, range: string, s: MetricsSeries): string {
  if (s.source === "none") return `No CPU or memory data for ${what}: ${s.reasons.map((r) => r.message).join(" ")}`;
  const panel = (name: string, p: MetricsSeries["cpu"], fmt: (v: number) => string) => {
    const lines = p.series.slice(0, MAX_TEXT_SERIES).map((l) => {
      const v = l.points.map((x) => x[1]).filter((x) => Number.isFinite(x));
      if (!v.length) return `  ${keyText(l.key)}: no samples`;
      return `  ${keyText(l.key)}: latest ${fmt(v[v.length - 1]!)}, mean ${fmt(v.reduce((a, b) => a + b, 0) / v.length)}, max ${fmt(Math.max(...v))}`;
    });
    if (p.series.length > MAX_TEXT_SERIES) lines.push(`  … and ${p.series.length - MAX_TEXT_SERIES} more`);
    const refs = [finite(p.request) ? `request ${fmt(p.request)}` : "", finite(p.limit) ? `limit ${fmt(p.limit)}` : "", finite(p.allocatable) ? `allocatable ${fmt(p.allocatable)}` : ""].filter(Boolean);
    return `${name}${refs.length ? ` (${refs.join(", ")})` : ""}:\n${lines.length ? lines.join("\n") : "  no samples"}`;
  };
  const source = s.source === "clickland" ? "Clickland" : s.source === "prometheus" ? "the cluster's Prometheus"
    : s.source === "cloud-monitoring" ? "Cloud Monitoring (GKE system metrics, 60 s samples)" : "metrics-server, sampled live";
  const notes = s.reasons.filter((r) => r.code === "live-only" || r.code === "cloud-monitoring-cut" || (s.source === "metrics-server" && r.code.startsWith("cloud-monitoring-"))).map((r) => r.message);
  const memory = s.source === "cloud-monitoring" ? "Memory (non-evictable)" : "Memory (working set)";
  return [`CPU and memory for ${what} over ${range} (from ${source}, one point every ${s.step}s, one series per ${s.by}).`, panel("CPU (cores)", s.cpu, cores), panel(memory, s.memory, bytes), ...notes].join("\n");
}

/** At most 240 points a series, so a 24h chart stays small in the call log and the view. */
function thin(s: MetricsSeries): MetricsSeries {
  const cut = (p: MetricsSeries["cpu"]) => ({ ...p, series: p.series.map((l) => {
    if (l.points.length <= 240) return l;
    const step = Math.ceil(l.points.length / 240);
    return { ...l, points: l.points.filter((_, i) => i % step === 0 || i === l.points.length - 1) };
  }) });
  return { ...s, cpu: cut(s.cpu), memory: cut(s.memory) };
}

function cpuMillis(v?: string): number {
  if (!v) return 0;
  if (v.endsWith("n")) return Number(v.slice(0, -1)) / 1e6;
  if (v.endsWith("u")) return Number(v.slice(0, -1)) / 1e3;
  if (v.endsWith("m")) return Number(v.slice(0, -1));
  return Number(v) * 1000;
}

function memMi(v?: string): number {
  if (!v) return 0;
  const m = /^(\d+(?:\.\d+)?)([KMGT]i?)?$/.exec(v);
  if (!m) return 0;
  const n = Number(m[1]);
  const f: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1e3 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576 };
  return m[2] ? n * (f[m[2]] ?? 1) : n / 1048576;
}
