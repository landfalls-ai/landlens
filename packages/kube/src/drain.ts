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
// The run (D152) cordons with the request the review kept, then evicts exactly the pods the review listed, by uid,
// four at a time: a 429 is retried every 5 s until the run's 10 minutes are up (then the pod is `blocked`), a 404 or a
// 409 (the name now belongs to another pod) is `gone`, anything else `failed` in a fixed sentence. Stop sends no new
// eviction. The node is never uncordoned here: it stays cordoned in every ending.
import type { DrainBlock, DrainPlan, DrainPod, DrainPodState, DrainProgress } from "@landlens/contracts";
import { selects } from "./actions.js";
import type { Send } from "./changes.js";
import { inOrder } from "./edits.js";

export type { DrainPlan, DrainPod } from "@landlens/contracts";

/** Pods on a node and budgets in the cluster Landlens reads for one plan; past these the plan is partial. */
export const MAX_DRAIN_PODS = 2000;
export const MAX_BUDGETS = 2000;
const PAGE = 500;
/** A run's whole time, how often a 429 is tried again, and how often the pod list is read while pods terminate. */
export const DRAIN_LIMIT_MS = 10 * 60_000;
export const DRAIN_RETRY_MS = 5_000;
export const DRAIN_FOLLOW_MS = 2_000;
export const DRAIN_PARALLEL = 4;

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

/** One pod, classed (D150). Pods whose names aren't Kubernetes names are left out by the caller. */
function classify(p: any, pdbs: any[], opts: DrainOpts): DrainPod {
  const meta = p.metadata ?? {};
  const ref = (meta.ownerReferences ?? []).find((r: any) => r?.controller === true);
  const owner = ref && KIND.test(String(ref.kind)) && name(ref.name) ? { kind: String(ref.kind), name: String(ref.name) } : undefined;
  const phase = p.status?.phase;
  const cls: DrainPod["class"] = meta.deletionTimestamp ? "terminating"
    : meta.annotations?.["kubernetes.io/config.mirror"] !== undefined ? "mirror"
    : ref?.kind === "DaemonSet" ? "daemonset"
    : phase === "Succeeded" || phase === "Failed" ? "finished"
    : "evict";
  const emptyDir = (p.spec?.volumes ?? []).filter((v: any) => v?.emptyDir && name(v.name)).map((v: any) => String(v.name));
  const matching = pdbs.filter((b) => b?.metadata?.namespace === meta.namespace && selects(b?.spec?.selector, meta.labels));
  const budgets = matching.map((b) => name(b?.metadata?.name)).filter((x): x is string => !!x);
  const allowed = Number.isInteger(matching[0]?.status?.disruptionsAllowed) ? Number(matching[0].status.disruptionsAllowed) : 0;
  const budget = matching.length > 1 ? { many: budgets.slice(0, 5) } : matching.length === 1 && budgets[0] ? { name: budgets[0], allowed: Math.max(0, allowed) } : undefined;
  let blocked: DrainBlock | undefined;
  if (cls === "evict") {
    // The person's ticks first: they are what stops Apply; a budget only makes the run wait.
    if (!ref && !opts.bare) blocked = "needs-bare";
    else if (emptyDir.length && !opts.emptyDir) blocked = "needs-emptydir";
    else if (matching.length > 1) blocked = "many-budgets";
    else if (matching.length === 1 && allowed <= 0) blocked = "budget";
  }
  return {
    namespace: meta.namespace, name: meta.name, uid: meta.uid,
    ...(owner ? { owner } : {}),
    class: cls, bare: !ref, emptyDir,
    ...(budget && (cls === "evict") ? { budget } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

const moves = (p: DrainPod) => p.class === "evict" || p.class === "finished";

/** The counts a plan's head shows: to evict, blocked, and what stays. */
export function countPlan(pods: DrainPod[]): DrainPlan["counts"] {
  const blocked = pods.filter((p) => p.blocked).length;
  return { evict: pods.filter((p) => moves(p) && !p.blocked).length, blocked, skipped: pods.filter((p) => !moves(p)).length };
}

/** The drain plan (D150): pure, from the Node, the pods on it and the cluster's PodDisruptionBudgets. */
export function drainPlan(node: any, pods: any[], pdbs: any[], opts: DrainOpts, partial?: string): DrainPlan {
  const nodeName = String(node?.metadata?.name ?? "");
  const out = pods
    .filter((p) => p?.spec?.nodeName === nodeName && ns(p?.metadata?.namespace) && name(p?.metadata?.name) && UID.test(String(p?.metadata?.uid ?? "")))
    .map((p) => classify(p, pdbs, opts));
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

/** The pods on a node, all namespaces, by field selector. */
export const podsOnNode = (send: Send, node: string, cap = MAX_DRAIN_PODS) =>
  listAll(send, `/api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${node}`)}`, cap);

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
      if (pdbs.length > MAX_BUDGETS) partial ??= `More than ${MAX_BUDGETS.toLocaleString("en")} disruption budgets; Landlens can't check them all.`;
    }
  } else if (all.status && all.status !== 404) partial = `Landlens couldn't list disruption budgets (HTTP ${all.status}).`;
  else {
    pdbs = all.items;
    if (all.more) partial ??= `More than ${MAX_BUDGETS.toLocaleString("en")} disruption budgets; Landlens can't check them all.`;
  }
  return { node: n, plan: drainPlan(n, pods.items, pdbs, opts, partial) };
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
/** What a drain review keeps: the cordon request (none when the node was already cordoned) and the pods to evict. */
export type DrainKept = { node: string; cordon?: KeptRequest; pods: { namespace: string; name: string; uid: string }[] };
export type RunState = Omit<DrainProgress, "run" | "startedAt">;
export type RunEnd = RunState & { evicted: number; blocked: number; failed: number };

const CORDON_FAIL: Record<number, string> = {
  409: "The node changed since the preview. Nothing was evicted.",
  403: "Your role can't cordon this node. Nothing was evicted.",
  404: "The node is gone. Nothing was evicted.",
};
/** A failed eviction, in a fixed sentence per status (never the API's text). */
export function evictionFailure(status: number): string {
  if (status === 403) return "Your role can't evict pods here.";
  if (status === 500) return "The cluster couldn't evict it (HTTP 500); it may be under more than one disruption budget.";
  if (status === 400 || status === 422) return `The cluster refused the eviction (HTTP ${status}).`;
  return `The cluster answered HTTP ${status}.`;
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
  type Row = { namespace: string; name: string; uid: string; state: DrainPodState; note?: string; next: number; tried429?: boolean; accepted?: boolean };
  const rows: Row[] = o.kept.pods.map((p) => ({ ...p, state: "waiting", next: 0 }));
  let state: RunState["state"] = "cordoning";
  let note: string | undefined;
  const view = (): RunState => ({
    node: o.kept.node, state,
    pods: rows.map((r) => ({ namespace: r.namespace, name: r.name, state: r.state, ...(r.note ? { note: r.note } : {}) })),
    ...(note ? { note } : {}),
  });
  const tell = () => o.onProgress(view());
  const end = (): RunEnd => ({
    ...view(),
    evicted: rows.filter((r) => r.accepted).length,
    blocked: rows.filter((r) => r.state === "blocked").length,
    failed: rows.filter((r) => r.state === "failed").length,
  });
  tell();

  // 1. Cordon, with the request the review kept (pinned to the node's version).
  if (o.kept.cordon) {
    let status: number;
    try {
      status = (await o.send(o.kept.cordon)).status;
    } catch {
      status = -1;
    }
    if (status < 200 || status >= 300) {
      state = "failed";
      note = status === -1 ? "Landlens couldn't reach the cluster. Nothing was evicted." : CORDON_FAIL[status] ?? `The cluster answered HTTP ${status}. Nothing was evicted.`;
      tell();
      return end();
    }
  }
  state = "evicting";
  tell();

  const settled = (r: Row) => r.state === "gone" || r.state === "failed" || r.state === "blocked";
  const evict = async (r: Row) => {
    if (o.stopped()) return; // no new eviction after Stop
    r.state = "evicting";
    delete r.note;
    tell();
    let status: number;
    try {
      status = (await o.send(evictionRequest(r, false))).status;
    } catch {
      status = -1;
    }
    if (status >= 200 && status < 300) (r.state = "evicted", r.accepted = true);
    else if (status === 429) (r.state = "waiting", r.tried429 = true, r.next = now() + retry, r.note = "Waiting for its disruption budget");
    else if (status === 404) (r.state = "gone", r.note = "It was already gone");
    else if (status === 409) (r.state = "gone", r.note = "Another pod has its name now; not evicted");
    else if (status === -1) (r.state = "waiting", r.next = now() + retry, r.note = "Landlens couldn't reach the cluster; trying again");
    else (r.state = "failed", r.note = evictionFailure(status));
    tell();
  };

  for (;;) {
    if (o.stopped()) {
      state = "stopped";
      break;
    }
    if (now() >= deadline) {
      state = "timed-out";
      for (const r of rows) if (r.state === "waiting" && r.tried429) (r.state = "blocked", r.note = "Its disruption budget didn't allow it in time");
      break;
    }
    const due = rows.filter((r) => r.state === "waiting" && r.next <= now());
    if (due.length) await inOrder(due, DRAIN_PARALLEL, evict);
    // Evicted pods are followed in the node's pod list until their uid is gone from it.
    if (rows.some((r) => r.state === "evicted")) {
      try {
        const live = await podsOnNode(o.send, o.kept.node);
        if (!live.status && !live.more) {
          const uids = new Set(live.items.map((p) => p?.metadata?.uid));
          for (const r of rows) if (r.state === "evicted" && !uids.has(r.uid)) (r.state = "gone", r.note = "Evicted");
          tell();
        }
      } catch {
        // the next round reads again
      }
    }
    if (rows.every(settled)) {
      state = "done";
      break;
    }
    // Wait for the next retry or the next look at the pod list, waking for Stop.
    const nextRetry = Math.min(...rows.filter((r) => r.state === "waiting").map((r) => r.next), Infinity);
    const wait = Math.max(0, Math.min(rows.some((r) => r.state === "evicted") ? follow : Infinity, nextRetry - now(), deadline - now()));
    const until = now() + wait;
    while (now() < until && !o.stopped()) await sleep(Math.min(250, until - now()));
  }
  tell();
  return end();
}
