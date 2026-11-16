// Drain (wave 8 part 2, D150–D152): the plan, the reads it is made from, the dry-run evictions that ask the API server
// for its own word, and the run.
//
// The plan is pure: from the Node, the pods on it and the PodDisruptionBudgets, what kubectl drain would do with each
// pod (as Freelens invokes it), minus `--force` and `--delete-emptydir-data` as defaults: DaemonSet pods and static
// pods' mirrors are skipped, finished pods are evicted without a budget check, terminating pods are left, a pod
// nothing recreates (bare) or one with emptyDir data is blocked until the person ticks its box, and a budget that
// allows no disruption (or several budgets on one pod, which the eviction API refuses) blocks. Landlens never bypasses
// a budget and never deletes a pod: every pod leaves through the eviction API, with its uid as a precondition and the
// pod's own grace period.
//
// The run (D152) first reads the node and its pods again (security review of part 2, M3, L7): the same node, still
// cordoned if the review found it so, and only the reviewed pods still on it with what the ticks allowed (a pod whose
// controller went since is not evicted without the bare tick). It cordons with the request the review kept (pinned to
// the node's version; on a 409 it re-reads and, for the same node still schedulable, sends once more with the new
// version, L5), then evicts exactly the pods the review listed, by uid, four at a time, reading the node before each
// pass and stopping if it was uncordoned. A budget's 429 is retried every 5 s, another 429 after its Retry-After
// (L4), until the run's 10 minutes are up, and no eviction is sent after them (L2); a 404 or a 409 (the name now
// belongs to another pod) is `gone`, anything else `failed` in a fixed sentence. Evicted pods are followed by name, or
// past 20 by one list from the API server's cache (L3). Stop sends no new eviction. At the end it reads the node and
// its pods once more: whether it is still cordoned, and how many pods arrived after the preview (M3). The node is
// never uncordoned here.
import type { DrainBlock, DrainPlan, DrainPod, DrainPodState, DrainProgress } from "@landlens/contracts";
import { selects } from "./actions.js";
import type { Send } from "./changes.js";
import { inOrder } from "./edits.js";

export type { DrainPlan, DrainPod } from "@landlens/contracts";

/** Pods on a node and budgets in the cluster Landlens reads for one plan; past these the plan is partial. */
export const MAX_DRAIN_PODS = 2000;
export const MAX_BUDGETS = 2000;
const PAGE = 500;
/** A run's whole time, how often a 429 is tried again, and how often evicted pods are looked at while they terminate. */
export const DRAIN_LIMIT_MS = 10 * 60_000;
export const DRAIN_RETRY_MS = 5_000;
export const DRAIN_FOLLOW_MS = 2_000;
export const DRAIN_PARALLEL = 4;
/** The longest a 429's Retry-After is honoured (L4). */
export const DRAIN_RETRY_AFTER_MAX_MS = 30_000;
/** Evicted pods followed one GET each (as kubectl does); past this, one list of the node's pods from the cache (L3). */
export const FOLLOW_BY_NAME = 20;
/** Past FOLLOW_BY_NAME, the list is read at most this often. */
export const DRAIN_FOLLOW_LIST_MS = 5_000;
/** DaemonSets read for a plan, to find pods whose DaemonSet is gone (L12). */
const MAX_DAEMONSETS = 200;

const SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const KIND = /^[A-Z][A-Za-z0-9]{0,62}$/;
const UID = /^[A-Za-z0-9-]{1,64}$/;
const name = (v: unknown) => (typeof v === "string" && v.length <= 253 && SUBDOMAIN.test(v) ? v : undefined);
const ns = (v: unknown) => (typeof v === "string" && v.length <= 63 && LABEL.test(v) ? v : undefined);

export type DrainOpts = { bare: boolean; emptyDir: boolean };

/** A plan's error before any plan exists: the node is gone, or your role can't read what a plan needs. */
export class DrainError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A pod's controller owner reference, if it has one. */
const controllerOf = (p: any) => (p?.metadata?.ownerReferences ?? []).find((r: any) => r?.controller === true);
/** The key of a DaemonSet in `orphans`: `<namespace>/<name>`. */
export const daemonSetKey = (namespace: string, ds: string) => `${namespace}/${ds}`;

/** One pod, classed (D150). Pods whose names aren't Kubernetes names are left out by the caller. */
function classify(p: any, pdbs: any[], opts: DrainOpts, orphans?: ReadonlySet<string>): DrainPod {
  const meta = p.metadata ?? {};
  const ref = controllerOf(p);
  const owner = ref && KIND.test(String(ref.kind)) && name(ref.name) ? { kind: String(ref.kind), name: String(ref.name) } : undefined;
  const phase = p.status?.phase;
  // A DaemonSet pod whose DaemonSet is gone comes back from nothing: it is evicted as a bare pod (L12), as kubectl
  // refuses it without --force.
  const orphan = ref?.kind === "DaemonSet" && !!orphans?.has(daemonSetKey(meta.namespace, String(ref.name)));
  const cls: DrainPod["class"] = meta.deletionTimestamp ? "terminating"
    : meta.annotations?.["kubernetes.io/config.mirror"] !== undefined ? "mirror"
    : ref?.kind === "DaemonSet" && !orphan ? "daemonset"
    : phase === "Succeeded" || phase === "Failed" ? "finished"
    : "evict";
  const bare = !ref || orphan;
  const emptyDir = (p.spec?.volumes ?? []).filter((v: any) => v?.emptyDir && name(v.name)).map((v: any) => String(v.name));
  const matching = pdbs.filter((b) => b?.metadata?.namespace === meta.namespace && selects(b?.spec?.selector, meta.labels));
  const budgets = matching.map((b) => name(b?.metadata?.name)).filter((x): x is string => !!x);
  const allowed = Number.isInteger(matching[0]?.status?.disruptionsAllowed) ? Number(matching[0].status.disruptionsAllowed) : 0;
  const budget = matching.length > 1 ? { many: budgets.slice(0, 5) } : matching.length === 1 && budgets[0] ? { name: budgets[0], allowed: Math.max(0, allowed) } : undefined;
  let blocked: DrainBlock | undefined;
  if (cls === "evict") {
    // The person's ticks first: they are what stops Apply; a budget only makes the run wait.
    if (bare && !opts.bare) blocked = "needs-bare";
    else if (emptyDir.length && !opts.emptyDir) blocked = "needs-emptydir";
    else if (matching.length > 1) blocked = "many-budgets";
    else if (matching.length === 1 && allowed <= 0) blocked = "budget";
  }
  return {
    namespace: meta.namespace, name: meta.name, uid: meta.uid,
    ...(owner ? { owner } : {}),
    class: cls, bare, emptyDir,
    ...(budget && (cls === "evict") ? { budget } : {}),
    ...(blocked ? { blocked } : {}),
    ...(orphan && cls !== "terminating" && cls !== "mirror" ? { orphan: true as const } : {}),
  };
}

const moves = (p: DrainPod) => p.class === "evict" || p.class === "finished";

/** The counts a plan's head shows: to evict, blocked, and what stays. */
export function countPlan(pods: DrainPod[]): DrainPlan["counts"] {
  const blocked = pods.filter((p) => p.blocked).length;
  return { evict: pods.filter((p) => moves(p) && !p.blocked).length, blocked, skipped: pods.filter((p) => !moves(p)).length };
}

/**
 * The drain plan (D150): pure, from the Node, the pods on it and the cluster's PodDisruptionBudgets. `orphans`: the
 * DaemonSets (daemonSetKey) read as gone (L12).
 */
export function drainPlan(node: any, pods: any[], pdbs: any[], opts: DrainOpts, partial?: string, orphans?: ReadonlySet<string>): DrainPlan {
  const nodeName = String(node?.metadata?.name ?? "");
  const out = pods
    .filter((p) => p?.spec?.nodeName === nodeName && ns(p?.metadata?.namespace) && name(p?.metadata?.name) && UID.test(String(p?.metadata?.uid ?? "")))
    .map((p) => classify(p, pdbs, opts, orphans));
  // Blocked first, then what is evicted, then what stays; by namespace and name within each.
  const rank = (p: DrainPod) => (p.blocked ? 0 : moves(p) ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  return { node: nodeName, cordoned: node?.spec?.unschedulable === true, pods: out, counts: countPlan(out), ...(partial ? { partial } : {}) };
}

/** The pods a run evicts: those that move and aren't blocked by a tick (budget blocks are tried, and reported). */
export function toEvict(plan: DrainPlan): { namespace: string; name: string; uid: string }[] {
  return plan.pods.filter((p) => moves(p) && p.blocked !== "needs-bare" && p.blocked !== "needs-emptydir").map((p) => ({ namespace: p.namespace, name: p.name, uid: p.uid }));
}

/** Whether a plan may be run: nothing waits on a tick, and it is complete. Budget blocks may run (D154). */
export const runnable = (plan: DrainPlan) => !plan.partial && !plan.pods.some((p) => p.blocked === "needs-bare" || p.blocked === "needs-emptydir");

/**
 * The eviction of one pod: `policy/v1` Eviction with the pod's uid as a precondition and no grace period of its own
 * (the pod's applies). A dry run says so twice, in the query (so admission treats the request as a dry run) and in
 * its DeleteOptions (where the eviction handler reads it); the API server requires the two to match.
 */
export function evictionRequest(p: { namespace: string; name: string; uid: string }, dry: boolean) {
  if (!ns(p.namespace) || !name(p.name) || !UID.test(p.uid)) throw new DrainError("Not a pod Landlens can evict.", 400);
  return {
    method: "POST",
    path: `/api/v1/namespaces/${p.namespace}/pods/${p.name}/eviction${dry ? "?dryRun=All" : ""}`,
    contentType: "application/json",
    body: JSON.stringify({
      apiVersion: "policy/v1", kind: "Eviction", metadata: { name: p.name, namespace: p.namespace },
      deleteOptions: { preconditions: { uid: p.uid }, ...(dry ? { dryRun: ["All"] } : {}) },
    }),
  };
}

/**
 * Whether a 429 names a disruption budget: the eviction API's `DisruptionBudget` cause. A StatusCause's type is
 * serialized as `reason` (metav1.StatusCause, json:"reason"), as the live check showed.
 */
function budgetCause(text: string): boolean {
  try {
    return (JSON.parse(text)?.details?.causes ?? []).some((c: any) => c?.reason === "DisruptionBudget");
  } catch {
    return false;
  }
}

async function listAll(send: Send, path: string, cap: number): Promise<{ items: any[]; status?: number; more?: boolean }> {
  const items: any[] = [];
  let cont = "";
  for (;;) {
    const r = await send({ method: "GET", path: `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE}${cont ? `&continue=${encodeURIComponent(cont)}` : ""}` });
    if (r.status !== 200) return { items, status: r.status };
    const body = JSON.parse(r.text);
    items.push(...(Array.isArray(body.items) ? body.items : []));
    cont = typeof body.metadata?.continue === "string" ? body.metadata.continue : "";
    if (items.length > cap) return { items: items.slice(0, cap), more: true };
    if (!cont) return { items };
  }
}

/**
 * The pods on a node, all namespaces, by field selector. `cached`: from the API server's watch cache
 * (`resourceVersion=0`), not a consistent read through etcd (L3); for following a run, never for a plan.
 */
export const podsOnNode = (send: Send, node: string, cap = MAX_DRAIN_PODS, cached = false) =>
  listAll(send, `/api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${node}`)}${cached ? "&resourceVersion=0" : ""}`, cap);

/**
 * The reads a plan is made from, as you (D150): the Node, its pods, and the budgets. Only GETs. Past 2,000 pods or
 * budgets, or when a namespace's budgets can't be listed, the plan is partial and can't be run.
 */
export async function readDrain(send: Send, node: string, opts: DrainOpts): Promise<{ node: any; plan: DrainPlan }> {
  if (!name(node)) throw new DrainError("Not a node name.", 400);
  const got = await send({ method: "GET", path: `/api/v1/nodes/${node}` });
  if (got.status === 404) throw new DrainError("That node is gone.", 404);
  if (got.status === 403) throw new DrainError("Your role can't read nodes.", 403);
  if (got.status !== 200) throw new DrainError(`The cluster answered HTTP ${got.status}.`, 502);
  const n = JSON.parse(got.text);
  const pods = await podsOnNode(send, node);
  if (pods.status === 403) throw new DrainError("Your role can't list pods in every namespace.", 403);
  if (pods.status) throw new DrainError(`The cluster answered HTTP ${pods.status}.`, 502);
  let partial: string | undefined = pods.more ? `More than ${MAX_DRAIN_PODS.toLocaleString("en")} pods are on this node; Landlens only drains what it can show.` : undefined;
  let pdbs: any[] = [];
  const all = await listAll(send, "/apis/policy/v1/poddisruptionbudgets", MAX_BUDGETS);
  if (all.status === 403) {
    // A role that can't list budgets cluster-wide may still list them where the pods are.
    const spaces = [...new Set(pods.items.map((p) => p?.metadata?.namespace).filter((x) => ns(x)))].sort();
    for (const s of spaces) {
      const one = await listAll(send, `/apis/policy/v1/namespaces/${s}/poddisruptionbudgets`, MAX_BUDGETS);
      if (one.status === 404) continue;
      if (one.status) {
        partial ??= `Landlens couldn't list the disruption budgets in ${s} (HTTP ${one.status}).`;
        continue;
      }
      pdbs.push(...one.items);
      // One namespace past the cap is cut at it (L1): `more`, not only the sum, says so.
      if (one.more || pdbs.length > MAX_BUDGETS) partial ??= `More than ${MAX_BUDGETS.toLocaleString("en")} disruption budgets; Landlens can't check them all.`;
    }
  } else if (all.status && all.status !== 404) partial = `Landlens couldn't list disruption budgets (HTTP ${all.status}).`;
  else {
    pdbs = all.items;
    if (all.more) partial ??= `More than ${MAX_BUDGETS.toLocaleString("en")} disruption budgets; Landlens can't check them all.`;
  }
  return { node: n, plan: drainPlan(n, pods.items, pdbs, opts, partial, await goneDaemonSets(send, pods.items)) };
}

/**
 * The DaemonSets that own pods on the node and are gone (L12): each read once, four at a time; a 404 is gone, anything
 * else leaves the pod where kubectl would (it stays). Only GETs.
 */
async function goneDaemonSets(send: Send, pods: any[]): Promise<Set<string>> {
  const keys = new Map<string, { namespace: string; name: string }>();
  for (const p of pods) {
    const ref = controllerOf(p);
    const space = p?.metadata?.namespace;
    if (ref?.kind !== "DaemonSet" || !ns(space) || !name(ref.name) || p?.metadata?.deletionTimestamp) continue;
    keys.set(daemonSetKey(space, ref.name), { namespace: space, name: ref.name });
  }
  const gone = new Set<string>();
  await inOrder([...keys].slice(0, MAX_DAEMONSETS), DRAIN_PARALLEL, async ([k, d]) => {
    try {
      const r = await send({ method: "GET", path: `/apis/apps/v1/namespaces/${d.namespace}/daemonsets/${d.name}` });
      if (r.status === 404) gone.add(k);
    } catch (e) {
      if ((e as { status?: number }).status === 504) throw e;
    }
  });
  return gone;
}

/** Every Node, in pages (L10): the drain's and cordon's "the only node that takes new pods". */
export async function listNodes(send: Send): Promise<{ items: any[]; status?: number }> {
  const all = await listAll(send, "/api/v1/nodes", 5000);
  return all.status ? { items: [], status: all.status } : { items: all.items };
}

/**
 * The API server's word (D151): a dry-run eviction of each pod the plan would move, four at a time. The answer goes
 * on the pod (`dry`); where it disagrees with the plan's reading, the cluster's answer wins on that row. Dry runs
 * change nothing: the eviction handler checks the budget and returns before spending it (pkg/registry/core/pod/
 * storage/eviction.go, checkAndDecrement), and the pod's delete is a dry run too.
 */
export async function dryRunEvictions(send: Send, plan: DrainPlan): Promise<{ plan: DrainPlan; disagree: number }> {
  let disagree = 0;
  const pods = await inOrder(plan.pods, DRAIN_PARALLEL, async (p): Promise<DrainPod> => {
    if (!moves(p)) return p;
    let status: number;
    let text = "";
    try {
      const r = await send(evictionRequest(p, true));
      status = r.status;
      text = r.text;
    } catch (e) {
      const s = (e as { status?: number }).status;
      if (s === 504) throw e; // the review's minute is up: the whole review says so
      return p;
    }
    const reason = status === 429 && budgetCause(text) ? "budget" as const : status === 403 ? "forbidden" as const : status >= 200 && status < 300 ? undefined : "other" as const;
    const q: DrainPod = { ...p, dry: { status, ...(reason ? { reason } : {}) } };
    if (status >= 200 && status < 300 && (p.blocked === "budget" || p.blocked === "many-budgets")) {
      disagree++;
      delete q.blocked;
    } else if (reason === "budget" && !p.blocked) {
      disagree++;
      q.blocked = "budget";
    } else if (status === 500 && !p.blocked && p.budget && "many" in p.budget) {
      q.blocked = "many-budgets";
    }
    return q;
  });
  return { plan: { ...plan, pods, counts: countPlan(pods) }, disagree };
}

// ---- The run (D152) ----------------------------------------------------------------------------------------------

export type KeptRequest = { method: string; path: string; contentType: string; body: string };
/**
 * What a drain review keeps: the node's uid, the ticks it was reviewed with, the cordon request (none when the node was
 * already cordoned) and the pods to evict.
 */
export type DrainKept = { node: string; nodeUid?: string; ticks: DrainOpts; cordon?: KeptRequest; pods: { namespace: string; name: string; uid: string }[] };
export type RunState = Omit<DrainProgress, "run" | "startedAt" | "seq">;
export type RunEnd = RunState & { evicted: number; blocked: number; failed: number };

const CORDON_FAIL: Record<number, string> = {
  409: "The node changed since the preview. Nothing was evicted.",
  403: "Your role can't cordon this node. Nothing was evicted.",
  404: "The node is gone. Nothing was evicted.",
};
/** The run's fixed sentences (M3, L6). */
export const RUN_NOTES = {
  unreachable: "Landlens couldn't reach the cluster. Nothing was evicted.",
  cordonLost: "Landlens didn't hear back from the cordon. Nothing was evicted; the node may be cordoned.",
  uncordoned: "The node was uncordoned since the preview. Nothing was evicted.",
  replaced: "The node was replaced since the preview. Nothing was evicted.",
  podsUnread: "Landlens couldn't read the pods on the node again. Nothing was evicted.",
  uncordonedDuring: "The node was uncordoned during the drain. Landlens stopped evicting.",
} as const;
/** A failed eviction, in a fixed sentence per status (never the API's text). */
export function evictionFailure(status: number): string {
  if (status === 403) return "Your role can't evict pods here.";
  if (status === 500) return "The cluster couldn't evict it (HTTP 500); it may be under more than one disruption budget.";
  if (status === 400 || status === 422) return `The cluster refused the eviction (HTTP ${status}).`;
  return `The cluster answered HTTP ${status}.`;
}

/** A 429's Status: whether it names a disruption budget, and the Retry-After the API server put in its details (L4). */
function tooMany(text: string): { budget: boolean; retryAfterMs?: number } {
  try {
    const body = JSON.parse(text);
    const after = Number(body?.details?.retryAfterSeconds);
    return { budget: budgetCause(text), ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: Math.min(after * 1000, DRAIN_RETRY_AFTER_MAX_MS) } : {}) };
  } catch {
    return { budget: false };
  }
}

/** The kept cordon with another resourceVersion (L5): the same patch, pinned to the version just read. */
function repin(r: KeptRequest, version: string): KeptRequest {
  const body = JSON.parse(r.body);
  return { ...r, body: JSON.stringify({ ...body, metadata: { ...(body.metadata ?? {}), resourceVersion: version } }) };
}

export async function runDrain(o: {
  send: Send;
  kept: DrainKept;
  stopped: () => boolean;
  onProgress: (s: RunState) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limitMs?: number;
  retryMs?: number;
  followMs?: number;
}): Promise<RunEnd> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = o.limitMs ?? DRAIN_LIMIT_MS;
  const retry = o.retryMs ?? DRAIN_RETRY_MS;
  const follow = o.followMs ?? DRAIN_FOLLOW_MS;
  const deadline = now() + limit;
  const node = o.kept.node;
  type Cause = "budget" | "busy" | "unreachable";
  type Row = { namespace: string; name: string; uid: string; state: DrainPodState; note?: string; next: number; cause?: Cause; accepted?: boolean; lost?: boolean };
  const rows: Row[] = o.kept.pods.map((p) => ({ ...p, state: "waiting", next: 0 }));
  let state: RunState["state"] = "cordoning";
  let note: string | undefined;
  let after: { cordoned?: boolean; arrived?: number } = {};
  const view = (): RunState => ({
    node, state,
    pods: rows.map((r) => ({ namespace: r.namespace, name: r.name, state: r.state, ...(r.note ? { note: r.note } : {}) })),
    ...(note ? { note } : {}),
    ...after,
  });
  const tell = () => o.onProgress(view());
  const end = (): RunEnd => ({
    ...view(),
    evicted: rows.filter((r) => r.accepted).length,
    blocked: rows.filter((r) => r.state === "blocked").length,
    failed: rows.filter((r) => r.state === "failed").length,
  });
  const failed = (why: string) => {
    state = "failed";
    note = why;
    tell();
    return end();
  };
  const readNode = async (): Promise<{ status: number; node?: any }> => {
    try {
      const r = await o.send({ method: "GET", path: `/api/v1/nodes/${node}` });
      return r.status === 200 ? { status: 200, node: JSON.parse(r.text) } : { status: r.status };
    } catch {
      return { status: -1 };
    }
  };
  const nodeFail = (status: number) => (status === -1 ? RUN_NOTES.unreachable : CORDON_FAIL[status] ?? `The cluster answered HTTP ${status}. Nothing was evicted.`);
  const sameNode = (n: any) => !o.kept.nodeUid || n?.metadata?.uid === o.kept.nodeUid;
  tell();

  // 0. The node and its pods as they are now (M3, L7): the same node; cordoned still, if the review found it so; and
  //    of the reviewed pods only those still on it, still what the ticks allowed.
  const first = await readNode();
  if (first.status !== 200) return failed(nodeFail(first.status));
  if (!sameNode(first.node)) return failed(RUN_NOTES.replaced);
  if (!o.kept.cordon && first.node?.spec?.unschedulable !== true) return failed(RUN_NOTES.uncordoned);
  let live: Awaited<ReturnType<typeof podsOnNode>>;
  try {
    live = await podsOnNode(o.send, node);
  } catch {
    return failed(RUN_NOTES.podsUnread);
  }
  if (live.status || live.more) return failed(RUN_NOTES.podsUnread);
  const byUid = new Map(live.items.map((p) => [p?.metadata?.uid, p]));
  for (const r of rows) {
    const p = byUid.get(r.uid);
    if (!p) (r.state = "gone", r.note = "It was already gone");
    else if (p.metadata?.deletionTimestamp) (r.state = "gone", r.note = "It was already going");
    else if (!controllerOf(p) && !o.kept.ticks.bare) (r.state = "blocked", r.note = "Nothing recreates it now (its controller went since the preview). Not evicted.");
  }

  // 1. Cordon, with the request the review kept (pinned to the node's version). Already cordoned: nothing to send.
  if (o.kept.cordon && first.node?.spec?.unschedulable !== true) {
    const cordon = async (r: KeptRequest) => {
      try {
        return (await o.send(r)).status;
      } catch {
        return -1;
      }
    };
    let status = await cordon(o.kept.cordon);
    if (status === 409) {
      // L5: the kubelet moves a Node's version every few minutes. The same node, still schedulable: once more, pinned
      // to the version just read; cordoned by someone else meanwhile: it is what the run needs.
      const again = await readNode();
      if (again.status === 200 && sameNode(again.node)) {
        status = again.node?.spec?.unschedulable === true ? 200 : await cordon(repin(o.kept.cordon, String(again.node?.metadata?.resourceVersion ?? "")));
      }
    }
    if (status === -1) return failed(RUN_NOTES.cordonLost);
    if (status < 200 || status >= 300) return failed(CORDON_FAIL[status] ?? `The cluster answered HTTP ${status}. Nothing was evicted.`);
  }
  state = "evicting";
  tell();

  const settled = (r: Row) => r.state === "gone" || r.state === "failed" || r.state === "blocked";
  const evict = async (r: Row) => {
    if (o.stopped() || now() >= deadline) return; // no new eviction after Stop, or after the run's time (L2)
    r.state = "evicting";
    delete r.note;
    tell();
    let status: number;
    let text = "";
    try {
      const got = await o.send(evictionRequest(r, false));
      status = got.status;
      text = got.text;
    } catch {
      status = -1;
    }
    if (status >= 200 && status < 300) (r.state = "evicted", r.accepted = true, delete r.cause);
    else if (status === 429) {
      const t = tooMany(text);
      r.state = "waiting";
      r.cause = t.budget ? "budget" : "busy";
      r.next = now() + Math.max(retry, t.budget ? 0 : t.retryAfterMs ?? 0);
      r.note = t.budget ? "Waiting for its disruption budget" : "The cluster is busy; trying again";
    } else if ((status === 404 || status === 409) && r.lost) {
      // An earlier answer was lost (L6): the pod left after it, so that eviction was most likely accepted.
      (r.state = "gone", r.accepted = true, r.note = "Evicted");
    } else if (status === 404) (r.state = "gone", r.note = "It was already gone");
    else if (status === 409) (r.state = "gone", r.note = "Another pod has its name now; not evicted");
    else if (status === -1) (r.state = "waiting", r.lost = true, r.cause = "unreachable", r.next = now() + retry, r.note = "Landlens didn't hear back; trying again");
    else (r.state = "failed", r.note = evictionFailure(status));
    tell();
  };

  // Evicted pods are followed until their uid is gone from the node (L3): one GET each, or past FOLLOW_BY_NAME one
  // list of the node's pods from the API server's cache, at most every 5 s.
  let listedAt = -Infinity;
  const followEvicted = async () => {
    const evicted = rows.filter((r) => r.state === "evicted");
    if (!evicted.length) return;
    if (evicted.length <= FOLLOW_BY_NAME) {
      await inOrder(evicted, DRAIN_PARALLEL, async (r) => {
        try {
          const got = await o.send({ method: "GET", path: `/api/v1/namespaces/${r.namespace}/pods/${r.name}` });
          if (got.status === 404 || (got.status === 200 && JSON.parse(got.text)?.metadata?.uid !== r.uid)) (r.state = "gone", r.note = "Evicted");
        } catch {
          // the next round looks again
        }
      });
    } else if (now() - listedAt >= DRAIN_FOLLOW_LIST_MS) {
      listedAt = now();
      try {
        const got = await podsOnNode(o.send, node, MAX_DRAIN_PODS, true);
        if (!got.status && !got.more) {
          const uids = new Set(got.items.map((p) => p?.metadata?.uid));
          for (const r of evicted) if (!uids.has(r.uid)) (r.state = "gone", r.note = "Evicted");
        }
      } catch {
        // the next round reads again
      }
    }
    tell();
  };

  for (;;) {
    if (o.stopped()) {
      state = "stopped";
      for (const r of rows) if (r.state === "waiting") r.note = "Not evicted: the drain was stopped";
      break;
    }
    if (now() >= deadline) {
      state = "timed-out";
      // Every row still waiting says why it wasn't evicted (L4): only a budget's 429 is "blocked".
      for (const r of rows) {
        if (r.state !== "waiting") continue;
        if (r.cause === "budget") (r.state = "blocked", r.note = "Its disruption budget didn't allow it in time");
        else if (r.cause === "busy") (r.state = "failed", r.note = "The cluster was too busy to take it in time");
        else if (r.cause === "unreachable") (r.state = "failed", r.note = "Landlens didn't hear back in time");
        else (r.state = "failed", r.note = "Not tried: the drain's time was up");
      }
      break;
    }
    const due = rows.filter((r) => r.state === "waiting" && r.next <= now());
    if (due.length) {
      // The cordon is kept (M3): before each pass the node is read; uncordoned or replaced, no more evictions.
      const n = await readNode();
      if (n.status === 200 && (!sameNode(n.node) || n.node?.spec?.unschedulable !== true)) {
        state = "failed";
        note = RUN_NOTES.uncordonedDuring;
        for (const r of rows) if (r.state === "waiting") (r.state = "failed", r.note = "Not evicted: the node was uncordoned");
        break;
      }
      if (n.status === 200) await inOrder(due, DRAIN_PARALLEL, evict);
    }
    await followEvicted();
    if (rows.every(settled)) {
      state = "done";
      break;
    }
    // Wait for the next retry or the next look at evicted pods, waking for Stop.
    const nextRetry = Math.min(...rows.filter((r) => r.state === "waiting").map((r) => r.next), Infinity);
    const wait = Math.max(0, Math.min(rows.some((r) => r.state === "evicted") ? follow : Infinity, nextRetry - now(), deadline - now()));
    const until = now() + wait;
    while (now() < until && !o.stopped()) await sleep(Math.min(250, until - now()));
  }

  // The end, read once more (M3): is the node still cordoned, and did pods arrive after the preview?
  const n = await readNode();
  if (n.status === 200) after.cordoned = sameNode(n.node) && n.node?.spec?.unschedulable === true;
  try {
    const got = await podsOnNode(o.send, node);
    if (!got.status) {
      const reviewed = new Set(o.kept.pods.map((p) => p.uid));
      const plan = drainPlan(n.node ?? { metadata: { name: node } }, got.items, [], { bare: true, emptyDir: true });
      const arrived = plan.pods.filter((p) => moves(p) && !reviewed.has(p.uid)).length;
      if (arrived) after.arrived = arrived;
    }
  } catch {
    // said by its absence: the sheet doesn't claim what it didn't read
  }
  after = { ...after };
  tell();
  return end();
}
