// The agent's cluster tools: read-only, redacted, and phrased the way kubectl prints so Claude reads them easily.
// Every call goes through the front door with the session's own token (cluster.ts), so the policy and the audit
// trail apply to these exactly as to the agent's kubectl.
import type { KubeObject, ResourceType } from "@landlens/contracts";
import { KubeError } from "@landlens/kube";
import { age, nodeStatus, podReady, podRestarts, podStatus } from "@landlens/kube/status";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stringify } from "yaml";
import { z } from "zod";
import { getJson, getText, pathFor, resolveKind, type AgentCluster } from "./cluster.js";
import { capResult, redactObject, redactText } from "./redact.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const text = (s: string): Result => ({ content: [{ type: "text", text: capResult(redactText(s)) }] });
const failure = (err: unknown): Result => {
  const message = err instanceof KubeError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: redactText(message) }] };
};

/** Run a tool body; Kubernetes and Landlens refusals come back as tool errors Claude can read and act on. */
const run = <A>(fn: (args: A) => Promise<string>) => async (args: A): Promise<Result> => {
  try {
    return text(await fn(args));
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
  const kind = async (k: string) => resolveKind(await cluster.types(), k);
  const limitNote = cluster.namespaces?.length ? ` This session may only read namespaces ${cluster.namespaces.join(", ")}.` : "";

  server.registerTool("api_resources", {
    title: "API resources",
    description: "The kinds this cluster serves (like kubectl api-resources): name, short names, group/version, scope." + limitNote,
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
  }, run(async (a: { kind: string; namespace?: string; labelSelector?: string; fieldSelector?: string; limit?: number }) => {
    const t = await kind(a.kind);
    const q = new URLSearchParams({ limit: String(a.limit ?? 100) });
    if (a.labelSelector) q.set("labelSelector", a.labelSelector);
    if (a.fieldSelector) q.set("fieldSelector", a.fieldSelector);
    const list = await getJson(cluster, `${pathFor(t, t.namespaced ? a.namespace : undefined)}?${q}`);
    const items: KubeObject[] = list.items ?? [];
    const more = list.metadata?.continue ? `\n(more than ${items.length}; narrow with a namespace or selector)` : "";
    return `${t.kind} (${items.length})\n${rowsFor(t, items, Date.now())}${more}`;
  }));

  server.registerTool("get_resource", {
    title: "Get resource",
    description: "One object as YAML (managed fields, last-applied and env values removed; credentials scrubbed).",
    inputSchema: { kind: Kind, name: z.string().min(1).max(253), namespace: Namespace },
    annotations: READ_ONLY,
  }, run(async (a: { kind: string; name: string; namespace?: string }) => {
    const t = await kind(a.kind);
    return yaml(await getJson(cluster, pathFor(t, t.namespaced ? a.namespace : undefined, a.name)));
  }));

  server.registerTool("describe", {
    title: "Describe",
    description: "One object with what explains it (like kubectl describe): its state, its owners up to the Deployment, " +
      "container states and last exits for pods, and its recent events. Start here for a failing workload.",
    inputSchema: { kind: Kind, name: z.string().min(1).max(253), namespace: Namespace },
    annotations: READ_ONLY,
  }, run(async (a: { kind: string; name: string; namespace?: string }) => {
    const t = await kind(a.kind);
    const ns = t.namespaced ? a.namespace : undefined;
    const o: KubeObject = await getJson(cluster, pathFor(t, ns, a.name));
    const now = Date.now();
    const parts = [`${t.kind} ${ns ? `${ns}/` : ""}${o.metadata.name} (created ${ago(o.metadata.creationTimestamp, now)} ago)`];
    if (t.resource === "pods" && !t.group) parts.push(describePod(o));
    const owners = await ownerChain(cluster, o, ns);
    if (owners.length) parts.push("Owners:\n" + owners.map((s) => `  ${s}`).join("\n"));
    parts.push("Events:\n" + indent(await eventsText(cluster, { uid: o.metadata.uid, namespace: ns }, now)));
    parts.push("Object:\n" + indent(yaml(o)));
    return parts.join("\n\n");
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
  }, run(async (a: { namespace?: string; kind?: string; name?: string; warningsOnly?: boolean; limit?: number }) =>
    eventsText(cluster, a, Date.now())));

  server.registerTool("get_logs", {
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
  }, run(async (a: { name: string; namespace: string; container?: string; previous?: boolean; tailLines?: number; sinceSeconds?: number }) => {
    const q = new URLSearchParams({ tailLines: String(a.tailLines ?? 200) });
    if (a.container) q.set("container", a.container);
    if (a.previous) q.set("previous", "true");
    if (a.sinceSeconds) q.set("sinceSeconds", String(a.sinceSeconds));
    const pods = { group: "", version: "v1", resource: "pods" };
    const log = await getText(cluster, `${pathFor(pods, a.namespace, a.name)}/log?${q}`);
    return log.trim() ? log : "(empty log)";
  }));

  server.registerTool("cluster_overview", {
    title: "Cluster overview",
    description: "What is wrong right now, problems first: crash-looping, pending, image-pull and OOM-killed pods, " +
      "deployments short of replicas, nodes not ready, and recent warning events." + limitNote,
    inputSchema: { namespace: Namespace },
    annotations: READ_ONLY,
  }, run(async (a: { namespace?: string }) => overview(cluster, a.namespace)));

  server.registerTool("top", {
    title: "Resource usage",
    description: "CPU and memory now, from metrics-server (like kubectl top).",
    inputSchema: { what: z.enum(["pods", "nodes"]), namespace: Namespace },
    annotations: READ_ONLY,
  }, run(async (a: { what: "pods" | "nodes"; namespace?: string }) => {
    const t = { group: "metrics.k8s.io", version: "v1beta1", resource: a.what };
    let list: any;
    try {
      list = await getJson(cluster, pathFor(t, a.what === "pods" ? a.namespace : undefined));
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
  }, run(async (a: { name: string; namespace: string }) => {
    const d = await getJson(cluster, pathFor({ group: "apps", version: "v1", resource: "deployments" }, a.namespace, a.name));
    const sel = Object.entries(d.spec?.selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
    const q = new URLSearchParams({ limit: "100", ...(sel ? { labelSelector: sel } : {}) });
    const rs = await getJson(cluster, `${pathFor({ group: "apps", version: "v1", resource: "replicasets" }, a.namespace)}?${q}`);
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

async function eventsText(
  cluster: AgentCluster,
  a: { namespace?: string; kind?: string; name?: string; uid?: string; warningsOnly?: boolean; limit?: number },
  now: number,
): Promise<string> {
  const fields: string[] = [];
  if (a.uid) fields.push(`involvedObject.uid=${a.uid}`);
  if (a.kind) fields.push(`involvedObject.kind=${a.kind}`);
  if (a.name) fields.push(`involvedObject.name=${a.name}`);
  if (a.warningsOnly) fields.push("type=Warning");
  const q = new URLSearchParams({ limit: "500", ...(fields.length ? { fieldSelector: fields.join(",") } : {}) });
  const list = await getJson(cluster, `${pathFor({ group: "", version: "v1", resource: "events" }, a.namespace)}?${q}`);
  const when = (e: any) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? 0);
  const events = [...(list.items ?? [])].sort((x, y) => when(y) - when(x)).slice(0, a.limit ?? 50);
  return table(["AGE", "TYPE", "REASON", "OBJECT", "COUNT", "MESSAGE"], events.map((e: any) => [
    age(when(e), now), e.type ?? "", e.reason ?? "",
    `${e.involvedObject?.kind ?? ""}/${e.involvedObject?.namespace ? `${e.involvedObject.namespace}/` : ""}${e.involvedObject?.name ?? ""}`,
    String(e.count ?? 1), (e.message ?? "").replace(/\s+/g, " ").trim(),
  ]));
}

const BAD_WAITING = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName", "RunContainerError"]);

async function overview(cluster: AgentCluster, namespace?: string): Promise<string> {
  const now = Date.now();
  const problems: string[] = [];
  const pods = await getJson(cluster, `${pathFor({ group: "", version: "v1", resource: "pods" }, namespace)}?limit=2000`);
  for (const p of (pods.items ?? []) as KubeObject[]) {
    const id = `pod ${p.metadata.namespace}/${p.metadata.name}`;
    const status = podStatus(p).text;
    const restarts = podRestarts(p).sort;
    for (const c of p.status?.containerStatuses ?? []) {
      const waiting = c.state?.waiting?.reason;
      const last = c.lastState?.terminated;
      if (waiting && BAD_WAITING.has(waiting)) {
        problems.push(`${id}: ${waiting} in container ${c.name} (${c.restartCount} restarts)` +
          (last ? `; last exit ${last.reason ?? "?"} code ${last.exitCode}` : "") + (c.state.waiting.message ? `; ${c.state.waiting.message}` : ""));
      } else if (last?.reason === "OOMKilled") {
        problems.push(`${id}: container ${c.name} was OOMKilled (${c.restartCount} restarts)`);
      }
    }
    const created = Date.parse(p.metadata.creationTimestamp ?? "");
    if (p.status?.phase === "Pending" && now - created > 120_000 && !problems.some((x) => x.startsWith(id))) {
      const unsched = (p.status?.conditions ?? []).find((c: any) => c.type === "PodScheduled" && c.status === "False");
      problems.push(`${id}: Pending for ${age(created, now)}${unsched?.message ? `; ${unsched.message}` : ""}`);
    } else if (p.status?.phase === "Running" && podReady(p).tone !== "ok" && !problems.some((x) => x.startsWith(id))) {
      problems.push(`${id}: Running but not ready (${podReady(p).text})`);
    } else if (restarts >= 5 && !problems.some((x) => x.startsWith(id))) {
      problems.push(`${id}: ${restarts} restarts (${status})`);
    }
  }
  try {
    const deps = await getJson(cluster, `${pathFor({ group: "apps", version: "v1", resource: "deployments" }, namespace)}?limit=1000`);
    for (const d of deps.items ?? []) {
      const want = d.spec?.replicas ?? 1;
      const have = d.status?.availableReplicas ?? 0;
      if (have < want) problems.push(`deployment ${d.metadata.namespace}/${d.metadata.name}: ${have}/${want} available`);
    }
  } catch (err) {
    problems.push(`(deployments not readable: ${(err as Error).message})`);
  }
  if (!namespace) {
    try {
      const nodes = await getJson(cluster, "/api/v1/nodes");
      for (const n of nodes.items ?? []) {
        if (nodeStatus(n).tone !== "ok") problems.push(`node ${n.metadata.name}: ${nodeStatus(n).text}`);
        for (const c of n.status?.conditions ?? []) {
          if (c.type !== "Ready" && c.status === "True") problems.push(`node ${n.metadata.name}: ${c.type}`);
        }
      }
    } catch {
      // A namespace-limited session can't list nodes everywhere; skip.
    }
  }
  const warnings = await eventsText(cluster, { namespace, warningsOnly: true, limit: 25 }, now);
  const head = problems.length ? `Problems (${problems.length}):\n${problems.map((p) => `- ${p}`).join("\n")}` : "No failing pods, short deployments or unready nodes found.";
  return `${head}\n\nRecent warning events:\n${warnings}`;
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
