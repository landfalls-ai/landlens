// The computed names a field may use instead of a path (D207): each one function over a Kubernetes object, reusing
// kube's status.ts (kubectl's words) and metrics' quantity.ts (CPU in cores, memory in bytes). They read the object
// as the view's token got it (scrubbed); nothing here reads anything else.
import { nodeStatus, podReady, podRestarts, podStatus, type Tone } from "@landlens/kube/status";
import { containerResources, totals } from "@landlens/metrics";
import { cellText } from "./text.js";
import type { Cell, ReadContext } from "./path.js";

export const COMPUTED = [
  "$name", "$namespace", "$kind", "$key", "$age", "$status", "$tone", "$ready", "$restarts", "$node", "$images",
  "$workload", "$cpuRequest", "$cpuLimit", "$memoryRequest", "$memoryLimit", "$labels", "$replicas",
  // Not in the spec's list (part 1): a Service's or a workload's selector as `k=v, …` (what a selector join reads), and
  // an event's object and last time (a kube.events row's defaults).
  "$selector", "$object", "$last",
] as const;
export type ComputedName = (typeof COMPUTED)[number];

/**
 * Who controls what, for `$workload`'s one hop: `Kind/namespace/name` of a ReplicaSet or Job → its controller, from
 * the view's hidden ReplicaSet and Job watches. Only these two kinds are kept, and only the controller's kind and name.
 */
export type OwnerIndex = ReadonlyMap<string, { kind: string; name: string }>;

type Obj = {
  kind?: unknown;
  metadata?: { name?: unknown; namespace?: unknown; creationTimestamp?: unknown; labels?: unknown; ownerReferences?: unknown };
  spec?: any;
  status?: any;
  [k: string]: unknown;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const keyOf = (kind: string, namespace: string | undefined, name: string) => (namespace ? `${kind}/${namespace}/${name}` : `${kind}/${name}`);

/** The controller owner reference, if any (the one with controller: true). */
function controllerOf(o: Obj): { kind: string; name: string } | undefined {
  const refs = o.metadata?.ownerReferences;
  if (!Array.isArray(refs)) return undefined;
  for (let i = 0; i < Math.min(refs.length, 20); i++) {
    const r = refs[i];
    if (isObj(r) && r.controller === true && typeof r.kind === "string" && typeof r.name === "string") return { kind: r.kind, name: r.name };
  }
  return undefined;
}

/** `k=v, …` of a string map, sorted, at most 50 pairs. */
function pairs(m: unknown): string | null {
  if (!isObj(m)) return null;
  const out: string[] = [];
  for (const k of Object.keys(m).sort()) {
    if (out.length >= 50) break;
    const v = m[k];
    if (typeof v === "string") out.push(`${k}=${v}`);
  }
  return out.length ? cellText(out.join(", ")) : null;
}

function podSpecOf(o: Obj): any {
  return o.spec?.template?.spec ?? o.spec?.jobTemplate?.spec?.template?.spec ?? o.spec;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "ReplicaSet", "DaemonSet"]);

function replicas(kind: string, o: Obj): { ready: number; desired: number } | undefined {
  if (kind === "DaemonSet") return { ready: num(o.status?.numberReady) ?? 0, desired: num(o.status?.desiredNumberScheduled) ?? 0 };
  if (WORKLOADS.has(kind)) return { ready: num(o.status?.readyReplicas) ?? 0, desired: num(o.spec?.replicas) ?? 1 };
  return undefined;
}

const PHASE_TONE: Record<string, Tone> = {
  Running: "ok", Succeeded: "ok", Bound: "ok", Active: "ok", Available: "ok", Ready: "ok", Complete: "ok",
  Pending: "warn", Released: "warn", Terminating: "muted", Lost: "bad", Failed: "bad", Unknown: "muted",
};

/** `$status` and `$tone` in one: kubectl's words for pods and nodes, ready against desired for workloads. */
export function statusOf(kind: string, o: Obj): { text: string; tone: Tone } {
  if (kind === "Pod") return podStatus(o as never);
  if (kind === "Node") return nodeStatus(o as never);
  const r = replicas(kind, o);
  if (r) {
    if (r.desired === 0) return { text: "Scaled to 0", tone: "muted" };
    if (r.ready >= r.desired) return { text: "Ready", tone: "ok" };
    return r.ready === 0 ? { text: "Unavailable", tone: "bad" } : { text: "Updating", tone: "warn" };
  }
  if (kind === "Job") {
    const conds: unknown[] = Array.isArray(o.status?.conditions) ? o.status.conditions.slice(0, 20) : [];
    const has = (t: string) => conds.some((c) => isObj(c) && c.type === t && c.status === "True");
    if (has("Complete")) return { text: "Complete", tone: "ok" };
    if (has("Failed")) return { text: "Failed", tone: "bad" };
    if (o.spec?.suspend === true) return { text: "Suspended", tone: "muted" };
    return { text: "Running", tone: "ok" };
  }
  if (kind === "CronJob") return o.spec?.suspend === true ? { text: "Suspended", tone: "muted" } : { text: "Active", tone: "ok" };
  if (kind === "Event") return o.type === "Warning" ? { text: "Warning", tone: "warn" } : { text: str(o.type) ?? "Normal", tone: "muted" };
  const phase = str(o.status?.phase);
  if (phase) return { text: cellText(phase, 64), tone: PHASE_TONE[phase] ?? "muted" };
  const conds: unknown[] = Array.isArray(o.status?.conditions) ? o.status.conditions.slice(0, 20) : [];
  const ready = conds.find((c) => isObj(c) && c.type === "Ready") as Record<string, unknown> | undefined;
  if (ready) return ready.status === "True" ? { text: "Ready", tone: "ok" } : { text: "NotReady", tone: "bad" };
  return { text: "", tone: "muted" };
}

function resources(o: Obj, which: "cpu" | "memory", what: "request" | "limit"): number | null {
  const spec = podSpecOf(o);
  const cs = Array.isArray(spec?.containers) ? spec.containers.slice(0, 50) : [];
  const per = containerResources(cs.filter((c: unknown) => isObj(c) && typeof c.name === "string"));
  const t = totals(Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v[which]])), Object.keys(per));
  const v = t[what];
  return v !== undefined && Number.isFinite(v) ? v : null;
}

/** The time an event last happened, in ms. */
function lastSeen(o: Obj): number | null {
  for (const v of [o.lastTimestamp, o.eventTime, (o.series as any)?.lastObservedTime, o.firstTimestamp, o.metadata?.creationTimestamp]) {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function computed(name: ComputedName, raw: unknown, ctx: ReadContext = {}): Cell {
  // Only an object with metadata is a Kubernetes object; kubectl's helpers read it without asking.
  if (!isObj(raw) || !isObj(raw.metadata)) return null;
  const o = raw as Obj;
  const kind = str(o.kind) ?? ctx.kind ?? "";
  const n = str(o.metadata?.name);
  const ns = str(o.metadata?.namespace);
  switch (name) {
    case "$name": return n !== undefined ? cellText(n) : null;
    case "$namespace": return ns !== undefined ? cellText(ns) : null;
    case "$kind": return kind ? cellText(kind, 64) : null;
    case "$key": return n !== undefined && kind ? cellText(keyOf(kind, ns, n)) : null;
    case "$age": {
      const t = Date.parse(str(o.metadata?.creationTimestamp) ?? "");
      return Number.isFinite(t) ? t : null;
    }
    case "$status": return statusOf(kind, o).text || null;
    case "$tone": return statusOf(kind, o).tone;
    case "$ready": {
      if (kind === "Pod") return podReady(o as never).text;
      const r = replicas(kind, o);
      return r ? `${r.ready}/${r.desired}` : null;
    }
    case "$replicas": {
      const r = replicas(kind, o);
      return r ? `${r.ready}/${r.desired}` : null;
    }
    case "$restarts": return kind === "Pod" ? podRestarts(o as never).sort : null;
    case "$node": return kind === "Pod" ? (str(o.spec?.nodeName) ? cellText(o.spec.nodeName) : null) : kind === "Node" && n ? cellText(n) : null;
    case "$images": {
      const spec = podSpecOf(o);
      const cs: unknown[] = Array.isArray(spec?.containers) ? spec.containers.slice(0, 20) : [];
      const images = cs.flatMap((c) => (isObj(c) && typeof c.image === "string" ? [c.image] : []));
      return images.length ? cellText(images.join(", ")) : null;
    }
    case "$workload": {
      if (n === undefined || !kind) return null;
      const c = controllerOf(o);
      if (!c) return cellText(keyOf(kind, ns, n));
      // One hop: a ReplicaSet's Deployment, a Job's CronJob, when the view's hidden watches know them.
      if (c.kind === "ReplicaSet" || c.kind === "Job") {
        const top = ctx.owners?.get(keyOf(c.kind, ns, c.name));
        if (top) return cellText(keyOf(top.kind, ns, top.name));
      }
      return cellText(keyOf(c.kind, ns, c.name));
    }
    case "$cpuRequest": return resources(o, "cpu", "request");
    case "$cpuLimit": return resources(o, "cpu", "limit");
    case "$memoryRequest": return resources(o, "memory", "request");
    case "$memoryLimit": return resources(o, "memory", "limit");
    case "$labels": return pairs(o.metadata?.labels);
    case "$selector": {
      if (kind === "Service") return pairs(o.spec?.selector);
      return pairs(o.spec?.selector?.matchLabels);
    }
    case "$object": {
      const io = o.involvedObject as Record<string, unknown> | undefined;
      if (!isObj(io) || typeof io.kind !== "string" || typeof io.name !== "string") return null;
      return cellText(keyOf(io.kind, str(io.namespace), io.name));
    }
    case "$last": return kind === "Event" ? lastSeen(o) : null;
  }
}

/** The controller of a ReplicaSet or Job, for the owner index (nothing else of the object is kept). */
export function ownerEntry(o: unknown, kind: "ReplicaSet" | "Job"): [string, { kind: string; name: string }] | undefined {
  if (!isObj(o)) return undefined;
  const ob = o as Obj;
  const n = str(ob.metadata?.name);
  const c = controllerOf(ob);
  return n && c ? [keyOf(kind, str(ob.metadata?.namespace), n), c] : undefined;
}
