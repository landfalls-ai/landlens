// Your actions (wave 8, D141–D142): pure builders from an action and the objects main read, to the operations the
// person's review dry-runs, plus the facts beside the diff. Kinds are fixed here; anything else is refused before a
// request. Every sentence is Landlens's own, with names checked as Kubernetes names and numbers as numbers: nothing
// from a message, a label value or an annotation is copied in.
//
// Scale and restart send the same bodies as the agent's `scale` and `rollout_restart` tools (kube-mcp's writes.ts
// builds them here). Trigger makes the Job `kubectl create job --from=cronjob/<name>` makes: the CronJob's job
// template, its labels and annotations, `cronjob.kubernetes.io/instantiate: manual`, and one owner reference to the
// CronJob with `controller: true` (checked live against kubectl 1.33: it sets no `blockOwnerDeletion`, which would
// also need permission on the CronJob's finalizers).
import type { ActionFact, ActionKind } from "@landlens/contracts";
import type { ChangeOp, ChangeTarget } from "./changes.js";
import { ACTION_KINDS, actionFits, keyOf, WIDE_DELETES, wideDelete } from "./action-kinds.js";

export { ACTION_KINDS, actionFits, keyOf, WIDE_DELETES, wideDelete };

export type ActionTarget = { type: ChangeTarget & { verbs?: string[] }; namespace?: string; name: string };

export const MAX_TARGETS = 50;
export const MAX_FACTS = 8;
/** A workload whose delete takes at least this many pods asks in main's own dialog (security review of part 1, M5). */
export const MANY_PODS = 10;

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** The agent's `scale` body too. */
export const scaleBody = (replicas: number) => ({ spec: { replicas } });
/** kubectl's and the agent's `rollout_restart` body: the template's restartedAt annotation, set to now. */
export const restartBody = (now: Date) => ({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": now.toISOString() } } } } });

/**
 * A triggered Job's name: the CronJob's cut to 50, `-manual-`, and 5 of [a-z0-9] (main's random). A Job's name is
 * also a label value, so it must fit 63: 50 + 8 + 5. A cut that ends in `-` or `.` loses them, so the name stays a
 * label (security review of part 1, L9).
 */
export function triggerName(cronJob: string, suffix: string): string {
  if (!/^[a-z0-9]{5}$/.test(suffix)) throw new ActionError("not a suffix");
  return `${cronJob.slice(0, 50).replace(/[-.]+$/, "")}-manual-${suffix}`;
}

/** The Job a manual run of a CronJob creates, as kubectl makes it. The template is the person's read, unscrubbed. */
export function triggerJob(cronJob: any, suffix: string): Record<string, any> {
  const tmpl = cronJob?.spec?.jobTemplate;
  if (!tmpl?.spec) throw new ActionError("This CronJob has no job template.");
  const name = triggerName(String(cronJob.metadata.name), suffix);
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: cronJob.metadata.namespace,
      ...(tmpl.metadata?.labels ? { labels: structuredClone(tmpl.metadata.labels) } : {}),
      annotations: { ...structuredClone(tmpl.metadata?.annotations ?? {}), "cronjob.kubernetes.io/instantiate": "manual" },
      ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: cronJob.metadata.name, uid: cronJob.metadata.uid, controller: true }],
    },
    spec: structuredClone(tmpl.spec),
  };
}

export type BuildInput =
  | { kind: "scale"; targets: ActionTarget[]; replicas: number }
  | { kind: "restart"; targets: ActionTarget[]; now: Date }
  | { kind: "delete"; targets: ActionTarget[] }
  | { kind: "trigger"; targets: ActionTarget[]; cronJob: any; jobs: ChangeTarget; suffix: string }
  | { kind: "suspend"; targets: ActionTarget[]; suspend: boolean }
  | { kind: "cordon"; targets: ActionTarget[]; on: boolean };

/**
 * Cordon and uncordon (D149): a merge patch of the Node's `spec.unschedulable`, `true` or `null` (kubectl uncordon
 * removes the field). prepareOp pins it to the version read.
 */
export const cordonBody = (on: boolean) => ({ spec: { unschedulable: on ? true : null } });

/** Checks an action's targets: one kind, one that the action takes, at most 50, each once, never a wide kind in bulk. */
export function checkTargets(kind: ActionKind, targets: ActionTarget[]) {
  if (!targets.length) throw new ActionError("An action needs an object.");
  if (targets.length > MAX_TARGETS) throw new ActionError(`At most ${MAX_TARGETS} at once.`);
  // The same object twice would inflate the dialog's count and answer a spurious "gone" (security review, L12).
  if (new Set(targets.map((t) => `${t.namespace ?? ""}/${t.name}`)).size !== targets.length) throw new ActionError("The same object is named twice.");
  const k = keyOf(targets[0]!.type);
  if (targets.some((t) => keyOf(t.type) !== k)) throw new ActionError("One kind at a time.");
  if (!actionFits(kind, targets[0]!.type)) throw new ActionError(`Landlens doesn't ${kind} ${targets[0]!.type.resource}.`);
  if ((kind === "scale" || kind === "trigger" || kind === "suspend" || kind === "cordon" || kind === "drain") && targets.length !== 1) throw new ActionError(`One object to ${kind}.`);
  if (kind === "delete" && targets.length > 1 && WIDE_DELETES.has(k)) throw new ActionError(`${targets[0]!.type.kind} objects are deleted one at a time.`);
  for (const t of targets) {
    if (t.type.namespaced && !t.namespace) throw new ActionError(`${t.type.kind} ${t.name} needs a namespace.`);
    if (!t.type.namespaced && t.namespace) throw new ActionError(`${t.type.kind} is cluster-scoped.`);
  }
}

/** The operations an action sends (D141). */
export function buildOps(a: BuildInput): ChangeOp[] {
  checkTargets(a.kind, a.targets);
  const at = (t: ActionTarget) => ({ type: strip(t.type), ...(t.namespace ? { namespace: t.namespace } : {}), name: t.name });
  switch (a.kind) {
    case "scale":
      if (!Number.isInteger(a.replicas) || a.replicas < 0 || a.replicas > 1000) throw new ActionError("Replicas go from 0 to 1000.");
      return [{ verb: "patch", patchType: "merge", ...at(a.targets[0]!), body: scaleBody(a.replicas) }];
    case "restart":
      return a.targets.map((t) => ({ verb: "patch", patchType: "strategic", ...at(t), body: restartBody(a.now) }));
    case "delete":
      return a.targets.map((t) => ({ verb: "delete", ...at(t) }));
    case "suspend":
      return [{ verb: "patch", patchType: "merge", ...at(a.targets[0]!), body: { spec: { suspend: a.suspend } } }];
    case "cordon":
      return [{ verb: "patch", patchType: "merge", ...at(a.targets[0]!), body: cordonBody(a.on) }];
    case "trigger": {
      const t = a.targets[0]!;
      if (a.cronJob?.metadata?.name !== t.name || a.cronJob?.metadata?.namespace !== t.namespace) throw new ActionError("That isn't the CronJob asked for.");
      const job = triggerJob(a.cronJob, a.suffix);
      return [{ verb: "create", type: strip(a.jobs), namespace: t.namespace!, name: job.metadata.name, body: job }];
    }
  }
}

const strip = (t: ChangeTarget & { verbs?: string[] }): ChangeTarget => ({ group: t.group, version: t.version, resource: t.resource, kind: t.kind, namespaced: t.namespaced });

// ---- Facts (D142) ------------------------------------------------------------------------------------------------

const NAME = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
/** A kind as a CRD may name it: a DNS-1035 label once lowercased (so `fooBar` and `my-Kind` are kinds too). */
const KIND = /^[A-Za-z](?:[-A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
/** A Kubernetes name, or undefined: never text that isn't one. */
export const nameOf = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 253 && NAME.test(v) ? v : undefined);
const kindOf = (v: unknown): string | undefined => (typeof v === "string" && KIND.test(v) ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : undefined);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A read that failed: its status, for "Landlens couldn't check …". */
export type Unread = { status: number };
const unread = (x: unknown): x is Unread => !!x && typeof x === "object" && !Array.isArray(x) && typeof (x as Unread).status === "number";

export type FactInput = {
  kind: ActionKind;
  /** The target objects as main read them (a Secret's values already lengths). */
  objects: { group: string; resource: string; kind: string; obj: any }[];
  replicas?: number;
  suspend?: boolean;
  /** scale: the namespace's HorizontalPodAutoscalers and PodDisruptionBudgets, or the status their list answered. */
  hpas?: any[] | Unread;
  pdbs?: any[] | Unread;
  /** delete of a PVC: its bound PersistentVolume by name, or the status its read answered. Every bound PVC's is read. */
  pvs?: Record<string, any | Unread>;
  /** The lists that stopped at their limit with more to read (L10): said, never silent. */
  cut?: ("autoscalers" | "disruption budgets")[];
  /** cordon: on (true) or off; the pods on the node now (a count), and every Node (for "the only one"). */
  on?: boolean;
  nodePods?: number | Unread;
  nodes?: any[] | Unread;
};

/** A Node that takes new pods: Ready, and not cordoned. */
export const schedulable = (n: any) => n?.spec?.unschedulable !== true && (n?.status?.conditions ?? []).some((c: any) => c?.type === "Ready" && c?.status === "True");

/** Whether a label selector (matchLabels and matchExpressions) selects these labels. An empty selector selects all. */
export function selects(sel: any, labels: Record<string, string> | undefined): boolean {
  const l = labels ?? {};
  if (!sel || typeof sel !== "object") return false;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (l[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.hasOwn(l, e?.key);
    const vals: string[] = Array.isArray(e?.values) ? e.values : [];
    if (e?.operator === "In" && !(has && vals.includes(l[e.key]!))) return false;
    if (e?.operator === "NotIn" && has && vals.includes(l[e.key]!)) return false;
    if (e?.operator === "Exists" && !has) return false;
    if (e?.operator === "DoesNotExist" && has) return false;
    if (!["In", "NotIn", "Exists", "DoesNotExist"].includes(e?.operator)) return false;
  }
  return true;
}

const couldnt = (what: string, status: number): ActionFact => ({ tone: "info", code: "couldnt-check", text: `Landlens couldn't check for ${what} here (HTTP ${num(status) ?? "error"}).` });

/** A Deployment's or StatefulSet's restart that leaves its only pod's place empty for a moment. */
function gapOnRestart(resource: string, o: any): boolean {
  const replicas = num(o?.spec?.replicas) ?? 1;
  if (replicas !== 1) return false;
  if (resource === "statefulsets") return true;
  const s = o?.spec?.strategy ?? {};
  if (s.type === "Recreate") return true;
  const mu = s.rollingUpdate?.maxUnavailable;
  if (typeof mu === "number") return mu >= 1;
  if (typeof mu === "string" && /^\d+%$/.test(mu)) return Math.floor((Number(mu.slice(0, -1)) / 100) * replicas) >= 1;
  return false; // the default, 25% of 1, rounds down to 0
}

const WORKLOADS = new Set(["deployments.apps", "statefulsets.apps", "replicasets.apps", "daemonsets.apps", "jobs.batch"]);
function podsOf(key: string, o: any): number | undefined {
  const st = o?.status ?? {};
  if (key === "daemonsets.apps") return num(st.currentNumberScheduled);
  if (key === "jobs.batch") return num(st.active);
  return num(st.replicas);
}

/** The facts for one object (without the name prefix several objects get). */
function factsFor(i: FactInput, x: FactInput["objects"][number]): ActionFact[] {
  const o = x.obj ?? {};
  const key = keyOf(x);
  const out: ActionFact[] = [];
  switch (i.kind) {
    case "scale": {
      const name = o.metadata?.name;
      const owner = (o.metadata?.ownerReferences ?? []).find((r: any) => r?.controller === true);
      if (owner && kindOf(owner.kind)) {
        const n = nameOf(owner.name);
        out.push({ tone: "warn", code: "owner-sets-back", text: `${kindOf(owner.kind)}${n ? ` ${n}` : ""} manages its replicas; it will set this back.` });
      }
      if (unread(i.hpas)) out.push(couldnt("autoscalers", i.hpas.status));
      else for (const h of i.hpas ?? []) {
        const ref = h?.spec?.scaleTargetRef;
        if (ref?.kind !== x.kind || ref?.name !== name) continue;
        const hn = nameOf(h?.metadata?.name);
        const min = num(h?.spec?.minReplicas) ?? 1;
        const max = num(h?.spec?.maxReplicas);
        out.push({ tone: "warn", code: "hpa", text: `HorizontalPodAutoscaler ${hn ?? "here"} sets replicas between ${min} and ${max ?? "its maximum"}; it will set this back.` });
      }
      if (unread(i.pdbs)) out.push(couldnt("disruption budgets", i.pdbs.status));
      else for (const p of i.pdbs ?? []) {
        const min = num(p?.spec?.minAvailable);
        if (min === undefined || i.replicas === undefined || i.replicas >= min) continue;
        if (!selects(p?.spec?.selector, o.spec?.template?.metadata?.labels)) continue;
        out.push({ tone: "warn", code: "pdb-min", text: `PodDisruptionBudget ${nameOf(p?.metadata?.name) ?? "here"} wants ${min} available.` });
      }
      for (const what of i.cut ?? []) out.push({ tone: "info", code: "list-cut", text: `Landlens read the first 500 ${what} here; there are more it didn't check.` });
      break;
    }
    case "restart": {
      if (x.resource === "daemonsets") {
        const n = num(o.status?.desiredNumberScheduled);
        if (n !== undefined) out.push({ tone: "info", code: "daemonset-nodes", text: `Restarts a pod on each of ${plural(n, "node")}.` });
      } else if (gapOnRestart(x.resource, o)) out.push({ tone: "warn", code: "single-pod", text: "Its only pod restarts: expect a gap." });
      const want = num(o.spec?.replicas);
      const updated = num(o.status?.updatedReplicas) ?? 0;
      const seen = num(o.status?.observedGeneration);
      const gen = num(o.metadata?.generation);
      if ((x.resource !== "daemonsets" && want !== undefined && updated < want) || (seen !== undefined && gen !== undefined && seen < gen)) {
        out.push({ tone: "warn", code: "rollout", text: "A rollout is already in progress." });
      }
      break;
    }
    case "delete": {
      const owner = (o.metadata?.ownerReferences ?? []).find((r: any) => r?.controller === true);
      const pod = key === "pods";
      if (owner) out.push(ownerFact(key, owner));
      else if (pod) out.push({ tone: "warn", code: "not-recreated", text: "Nothing will recreate it." });
      const fin = Array.isArray(o.metadata?.finalizers) ? o.metadata.finalizers.length : 0;
      if (fin) out.push({ tone: "info", code: "finalizers", text: `It has ${plural(fin, "finalizer")}: deletion waits for them.` });
      if (WORKLOADS.has(key)) {
        const n = podsOf(key, o);
        if (n) out.push({ tone: "warn", code: "deletes-pods", text: `Deletes its ${plural(n, "pod")}.` });
      }
      if (key === "persistentvolumeclaims") {
        const pvName = nameOf(o.spec?.volumeName);
        const pv = pvName ? i.pvs?.[pvName] : undefined;
        if (pvName && pv === undefined) out.push({ tone: "info", code: "couldnt-check", text: "Landlens didn't read its volume's reclaim policy." });
        else if (unread(pv)) out.push(couldnt("its volume's reclaim policy", pv.status));
        else if (pv?.spec?.persistentVolumeReclaimPolicy === "Delete") out.push({ tone: "bad", code: "pv-delete", text: "Its volume's reclaim policy is Delete: the data goes with it." });
        else if (pv?.spec?.persistentVolumeReclaimPolicy === "Retain") out.push({ tone: "info", code: "pv-retain", text: "Its volume's reclaim policy is Retain: the volume and its data stay." });
      }
      if (key === "namespaces") out.push({ tone: "bad", code: "namespace", text: "Deletes everything in it." });
      if (key === "secrets" && o.type === "helm.sh/release.v1") {
        const m = /^sh\.helm\.release\.v1\.(.+)\.v(\d{1,6})$/.exec(String(o.metadata?.name ?? ""));
        const release = nameOf(m?.[1]);
        out.push({ tone: "warn", code: "helm-release", text: release ? `This is Helm's record of release ${release}, revision ${Number(m![2])}.` : "This is one of Helm's release records." });
      }
      break;
    }
    case "trigger": {
      out.push({ tone: "info", code: "runs-now", text: "Runs now, once, outside the schedule." });
      if (o.spec?.suspend === true) out.push({ tone: "info", code: "suspended", text: "The CronJob is suspended; this Job still runs." });
      if (o.spec?.concurrencyPolicy === "Forbid" && Array.isArray(o.status?.active) && o.status.active.length) {
        out.push({ tone: "warn", code: "forbid-active", text: "A Job of it is running; Forbid applies to the schedule, not to this one." });
      }
      break;
    }
    case "suspend": {
      if (key === "jobs.batch" && i.suspend && num(o.status?.active)) out.push({ tone: "warn", code: "suspend-deletes", text: "Suspending deletes its running pods." });
      break;
    }
    case "cordon": {
      if (!i.on) {
        out.push({ tone: "info", code: "uncordon", text: "New pods can be scheduled on it again." });
        break;
      }
      const only = !unread(i.nodes) && !!i.nodes && !i.nodes.some((n) => n?.metadata?.name !== o.metadata?.name && schedulable(n));
      if (unread(i.nodes)) out.push(couldnt("other nodes", i.nodes.status));
      else if (only) out.push({ tone: "bad", code: "only-node", text: "This is the only node that takes new pods." });
      if (unread(i.nodePods)) out.push(couldnt("the pods on it", i.nodePods.status));
      else if (i.nodePods !== undefined) {
        const n = num(i.nodePods) ?? 0;
        out.push({ tone: "info", code: "pods-stay", text: `${plural(n, "pod")} keep${n === 1 ? "s" : ""} running; new ones ${only ? "stay Pending" : "go elsewhere"}.` });
      }
      break;
    }
    case "drain":
      break; // the plan is its facts (drain.ts)
  }
  return out;
}

/** Controllers that make a new one of what they own when it is deleted, by what they own. */
const REMAKES: Record<string, readonly string[]> = {
  pods: ["ReplicaSet", "StatefulSet", "DaemonSet", "ReplicationController"],
  "replicasets.apps": ["Deployment"],
  "controllerrevisions.apps": ["StatefulSet", "DaemonSet"],
};
/** What a controller owner does after its object is deleted, in words that hold for that owner (L10). */
function ownerFact(key: string, owner: any): ActionFact {
  const k = kindOf(owner?.kind);
  const n = nameOf(owner?.name);
  const who = `${k ?? "Its controller"}${n ? ` ${n}` : ""}`;
  if (k && REMAKES[key]?.includes(k)) return { tone: "info", code: "recreated", text: `${who} will make ${key === "pods" ? "a new pod" : "a new one"}.` };
  if (key === "pods" && k === "Job") return { tone: "info", code: "recreated", text: `${who} makes a new pod only if it hasn't finished.` };
  if (key === "jobs.batch" && k === "CronJob") return { tone: "info", code: "owner-schedule", text: `${who} doesn't make this Job again; its next Job comes on its schedule.` };
  return { tone: "info", code: "owner", text: `${who} owns it; whether it makes a new one is up to it.` };
}

/**
 * Every fact for an action, loudest first; with several objects, each fact starts with its object's name. Main
 * decides from these (asksInMain) before they are cut for the card.
 */
export function factList(i: FactInput): ActionFact[] {
  const many = i.objects.length > 1;
  const out: ActionFact[] = [];
  for (const x of i.objects) {
    for (const f of factsFor(i, x)) {
      const n = nameOf(x.obj?.metadata?.name);
      out.push(many ? { ...f, text: `${n ?? "One object"}: ${f.text}` } : f);
    }
  }
  // The loudest first, then in order; a repeated "couldn't check" once.
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  const seen = new Set<string>();
  return out
    .filter((f) => (f.code === "couldnt-check" ? !seen.has(f.text) && !!seen.add(f.text) : true))
    .map((f, n) => ({ f, n }))
    .sort((a, b) => rank[a.f.tone] - rank[b.f.tone] || a.n - b.n)
    .map((x) => x.f);
}

/**
 * At most 8 facts on a card (D142), never silence (security review of part 1, M4): past 8, the last says how many
 * more there are and of which tones, and takes the loudest tone among them.
 */
export function capFacts(fs: ActionFact[], max = MAX_FACTS): ActionFact[] {
  if (fs.length <= max) return fs;
  const kept = fs.slice(0, max - 1);
  const rest = fs.slice(max - 1);
  const n = (t: ActionFact["tone"]) => rest.filter((f) => f.tone === t).length;
  const parts = [n("bad") ? `${n("bad")} serious` : "", n("warn") ? plural(n("warn"), "warning") : "", n("info") ? plural(n("info"), "note") : ""].filter(Boolean);
  const tone = n("bad") ? "bad" : n("warn") ? "warn" : "info";
  return [...kept, { tone, code: "more", text: `And ${rest.length} more: ${parts.join(", ")}.` }];
}

/** Up to 8 facts for an action (D142), the last saying what was left out. */
export const actionFacts = (i: FactInput): ActionFact[] => capFacts(factList(i));

/**
 * Why a delete asks in main's own dialog even for one object (D143; widened by the security review of part 1, M5), in
 * main's sentences: a wide kind (every cluster-scoped kind), any serious fact (a PVC whose volume goes with it, a
 * Namespace), a PVC whose volume Landlens couldn't check, or a workload with 10 pods or more. Empty: the card's own
 * second click is enough (bulk asks anyway).
 */
export function asksInMain(kind: ActionKind, targets: ActionTarget[], facts: ActionFact[], objects: { group: string; resource: string; obj: any }[] = []): string[] {
  if (kind !== "delete" || !targets.length) return [];
  const t = targets[0]!.type;
  const out: string[] = [];
  if (!t.namespaced) out.push(`${kindOf(t.kind) ?? "This kind"} is cluster-scoped: it isn't in any namespace.`);
  // A serious fact once per code; with several objects, how many of them it is about (their names are in the dialog).
  const many = targets.length > 1;
  const bad = new Map<string, { text: string; n: number }>();
  for (const f of facts) {
    if (f.tone !== "bad") continue;
    const text = many && f.code !== "more" ? f.text.slice(f.text.indexOf(": ") + 2) : f.text;
    const had = bad.get(f.code);
    bad.set(f.code, { text: had?.text ?? text, n: (had?.n ?? 0) + 1 });
  }
  for (const { text, n } of bad.values()) out.push(many ? `${n} of them: ${text}` : text);
  if (keyOf(t) === "persistentvolumeclaims" && facts.some((f) => f.code === "couldnt-check")) out.push("Landlens couldn't check every claim's volume: its data may go with it.");
  const pods = objects.reduce((sum, x) => sum + (WORKLOADS.has(keyOf(x)) ? podsOf(keyOf(x), x.obj) ?? 0 : 0), 0);
  if (pods >= MANY_PODS) out.push(`Deletes ${plural(pods, "pod")}.`);
  return [...new Set(out)];
}
