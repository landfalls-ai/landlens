// How each kind is shown: where it sits in the sidebar and which columns its table has. Kinds the cluster serves but
// that aren't listed here still get a generic table (name, namespace, age) under their API group.
import type { KubeObject, ResourceType } from "@landlens/contracts";
import { age, podStatus, podReady, podRestarts, nodeStatus, nodeRoles, type Tone } from "@landlens/kube/status";

export type Cell = { text: string; tone?: Tone; title?: string; sort?: number | string };
export type Column = {
  id: string; label: string; cell: (o: KubeObject, now: number) => Cell; width?: string;
  /** Right-aligned mono (numbers). */
  num?: boolean;
  /** How a printer column's cell is drawn: an age, or a boolean as an icon and word. */
  kind?: "age" | "bool";
  description?: string;
};

/** The sidebar's last section (D38): Definitions, then each custom API group. */
export const CUSTOM = "Custom resources";

type Spec = { group: string; resource: string; label: string; section: string; columns?: Column[] };

const name: Column = { id: "name", label: "Name", cell: (o) => ({ text: o.metadata.name }), width: "minmax(180px, 2fr)" };
const namespace: Column = { id: "namespace", label: "Namespace", cell: (o) => ({ text: o.metadata.namespace ?? "" }), width: "minmax(100px, 140px)" };
const ageCol: Column = {
  id: "age",
  label: "Age",
  cell: (o, now) => {
    const t = Date.parse(o.metadata.creationTimestamp ?? "");
    return { text: age(t, now), sort: -t, title: o.metadata.creationTimestamp ?? "" };
  },
  width: "56px",
};

const replicas = (ready: (o: KubeObject) => number, want: (o: KubeObject) => number): Column => ({
  id: "ready",
  label: "Ready",
  cell: (o) => {
    const r = ready(o) ?? 0;
    const w = want(o) ?? 0;
    // Ready is the status of a workload: none ready is a failure, some is a warning.
    return { text: `${r}/${w}`, tone: r >= w ? "ok" : r === 0 ? "bad" : "warn", sort: w - r };
  },
  width: "64px",
});

const text = (id: string, label: string, f: (o: KubeObject) => unknown, width?: string): Column => ({
  id,
  label,
  cell: (o) => ({ text: String(f(o) ?? "") }),
  ...(width ? { width } : {}),
});

export const SPECS: Spec[] = [
  { section: "Workloads", group: "", resource: "pods", label: "Pods", columns: [
    name, namespace,
    { id: "ready", label: "Ready", cell: (o) => podReady(o), width: "60px" },
    { id: "status", label: "Status", cell: (o) => podStatus(o), width: "minmax(150px, 180px)" },
    { id: "restarts", label: "Restarts", cell: (o) => podRestarts(o), width: "72px" },
    text("node", "Node", (o) => o.spec?.nodeName, "minmax(90px, 150px)"),
    ageCol,
  ] },
  { section: "Workloads", group: "apps", resource: "deployments", label: "Deployments", columns: [
    name, namespace, replicas((o) => o.status?.readyReplicas, (o) => o.spec?.replicas),
    text("updated", "Up to date", (o) => o.status?.updatedReplicas ?? 0, "90px"),
    text("available", "Available", (o) => o.status?.availableReplicas ?? 0, "90px"), ageCol,
  ] },
  { section: "Workloads", group: "apps", resource: "statefulsets", label: "StatefulSets", columns: [
    name, namespace, replicas((o) => o.status?.readyReplicas, (o) => o.spec?.replicas), ageCol,
  ] },
  { section: "Workloads", group: "apps", resource: "daemonsets", label: "DaemonSets", columns: [
    name, namespace, replicas((o) => o.status?.numberReady, (o) => o.status?.desiredNumberScheduled), ageCol,
  ] },
  { section: "Workloads", group: "apps", resource: "replicasets", label: "ReplicaSets", columns: [
    name, namespace, replicas((o) => o.status?.readyReplicas, (o) => o.spec?.replicas), ageCol,
  ] },
  { section: "Workloads", group: "batch", resource: "jobs", label: "Jobs", columns: [
    name, namespace, text("completions", "Completions", (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}`, "110px"), ageCol,
  ] },
  { section: "Workloads", group: "batch", resource: "cronjobs", label: "CronJobs", columns: [
    name, namespace, text("schedule", "Schedule", (o) => o.spec?.schedule), text("suspend", "Suspend", (o) => o.spec?.suspend ? "yes" : "no", "80px"),
    text("last", "Last schedule", (o) => o.status?.lastScheduleTime ?? ""), ageCol,
  ] },
  { section: "Network", group: "", resource: "services", label: "Services", columns: [
    name, namespace, text("type", "Type", (o) => o.spec?.type, "110px"), text("ip", "Cluster IP", (o) => o.spec?.clusterIP),
    text("ports", "Ports", (o) => (o.spec?.ports ?? []).map((p: any) => `${p.port}${p.nodePort ? ":" + p.nodePort : ""}/${p.protocol}`).join(", ")),
    ageCol,
  ] },
  { section: "Network", group: "networking.k8s.io", resource: "ingresses", label: "Ingresses", columns: [
    name, namespace, text("hosts", "Hosts", (o) => (o.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean).join(", ")), ageCol,
  ] },
  { section: "Network", group: "discovery.k8s.io", resource: "endpointslices", label: "Endpoint slices" },
  { section: "Network", group: "networking.k8s.io", resource: "networkpolicies", label: "Network policies" },
  { section: "Config", group: "", resource: "configmaps", label: "ConfigMaps", columns: [
    name, namespace, text("keys", "Keys", (o) => Object.keys((o as any).data ?? {}).join(", ")), ageCol,
  ] },
  { section: "Config", group: "", resource: "secrets", label: "Secrets", columns: [
    name, namespace, text("type", "Type", (o) => (o as any).type), text("keys", "Keys", (o) => Object.keys((o as any).data ?? {}).length, "60px"), ageCol,
  ] },
  { section: "Config", group: "autoscaling", resource: "horizontalpodautoscalers", label: "HPAs" },
  { section: "Config", group: "policy", resource: "poddisruptionbudgets", label: "Pod disruption budgets" },
  { section: "Storage", group: "", resource: "persistentvolumeclaims", label: "Volume claims", columns: [
    name, namespace, text("status", "Status", (o) => o.status?.phase, "90px"), text("cap", "Capacity", (o) => o.status?.capacity?.storage, "90px"),
    text("class", "Class", (o) => o.spec?.storageClassName), ageCol,
  ] },
  { section: "Storage", group: "", resource: "persistentvolumes", label: "Volumes" },
  { section: "Storage", group: "storage.k8s.io", resource: "storageclasses", label: "Storage classes" },
  { section: "Access", group: "", resource: "serviceaccounts", label: "Service accounts" },
  { section: "Access", group: "rbac.authorization.k8s.io", resource: "roles", label: "Roles" },
  { section: "Access", group: "rbac.authorization.k8s.io", resource: "rolebindings", label: "Role bindings" },
  { section: "Access", group: "rbac.authorization.k8s.io", resource: "clusterroles", label: "Cluster roles" },
  { section: "Access", group: "rbac.authorization.k8s.io", resource: "clusterrolebindings", label: "Cluster role bindings" },
  { section: "Cluster", group: "", resource: "nodes", label: "Nodes", columns: [
    name, { id: "status", label: "Status", cell: (o) => nodeStatus(o), width: "130px" }, text("roles", "Roles", nodeRoles),
    text("version", "Version", (o) => o.status?.nodeInfo?.kubeletVersion, "130px"), ageCol,
  ] },
  { section: "Cluster", group: "", resource: "namespaces", label: "Namespaces", columns: [
    name, text("status", "Status", (o) => o.status?.phase, "100px"), ageCol,
  ] },
  { section: "Cluster", group: "", resource: "events", label: "Events", columns: [
    { id: "type", label: "Type", cell: (o) => ({ text: String((o as any).type ?? ""), tone: (o as any).type === "Warning" ? "bad" : "muted" }), width: "80px" },
    text("reason", "Reason", (o) => (o as any).reason, "150px"), namespace,
    text("object", "Object", (o) => `${(o as any).involvedObject?.kind}/${(o as any).involvedObject?.name}`),
    text("message", "Message", (o) => (o as any).message, "minmax(260px, 3fr)"),
    text("count", "Count", (o) => (o as any).count ?? 1, "60px"),
    { id: "last", label: "Last seen", cell: (o, now) => {
      const t = Date.parse(String((o as any).lastTimestamp ?? (o as any).eventTime ?? o.metadata.creationTimestamp ?? ""));
      return { text: age(t, now), sort: -t };
    }, width: "80px" },
  ] },
  { section: CUSTOM, group: "apiextensions.k8s.io", resource: "customresourcedefinitions", label: "Definitions", columns: [
    name, text("group", "Group", (o) => o.spec?.group), text("kind", "Kind", (o) => o.spec?.names?.kind),
    text("scope", "Scope", (o) => o.spec?.scope, "110px"), ageCol,
  ] },
];

export const SECTIONS = ["Workloads", "Network", "Config", "Storage", "Access", "Cluster"];

/** `group`: a custom kind's API group, its sub-heading under Custom resources (D38). */
export type NavItem = { type: ResourceType; label: string; section: string; columns: Column[]; group?: string };

/** Build the sidebar from what the cluster actually serves: known kinds in their sections, the rest by API group. */
export function buildNav(types: ResourceType[]): NavItem[] {
  const listable = types.filter((t) => t.verbs.includes("list") && t.verbs.includes("watch"));
  const known = new Map(SPECS.map((s) => [`${s.group}/${s.resource}`, s]));
  const out: NavItem[] = [];
  for (const s of SPECS) {
    const t = listable.find((x) => x.group === s.group && x.resource === s.resource);
    if (t) out.push({ type: t, label: s.label, section: s.section, columns: s.columns ?? genericColumns(t) });
  }
  const seen = new Set<string>();
  for (const t of listable) {
    const k = `${t.group}/${t.resource}`;
    if (known.has(k) || seen.has(k)) continue;
    // Legacy duplicates of core kinds and noisy internals add nothing to the sidebar.
    if (t.group === "events.k8s.io" || t.group === "metrics.k8s.io" || t.resource === "componentstatuses" || t.resource === "bindings") continue;
    seen.add(k);
    if (t.custom) out.push({ type: t, label: t.kind, section: CUSTOM, group: t.group, columns: genericColumns(t) });
    else out.push({ type: t, label: t.kind, section: t.group || "core", columns: genericColumns(t) });
  }
  return out;
}

export function genericColumns(t: ResourceType): Column[] {
  return t.namespaced ? [name, namespace, ageCol] : [name, ageCol];
}
