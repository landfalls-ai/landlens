// Your actions in main (wave 8 part 1, D143): Scale, Restart, Delete, Trigger, Suspend and Resume, sent as you.
//
// The window names an action's closed shape and its targets. Main resolves each target's type from the cluster's
// discovery, reads what the action needs as you, builds every request (packages/kube actions.ts), and dry-runs each
// through the same preparation as the agent's changes (EditBroker.reviewOps → prepareOp). The review is kept under an
// `ed…` id; the window gets the diff, risks, main's own title and facts, and a digest over all of that and the kept
// requests. Apply names the id and the digest and nothing else, and sends exactly the kept requests, once. Main asks in
// its own dialog first for bulk and wide deletes, deletes with a serious fact, bulk restarts, and any apply past a
// window's budget of card-approved changes a minute (security review of part 1, M1, M2, M5); the dialog names every
// flagged object. Cancel sends nothing; a second Cancel drops the review. Every series of requests has its own token
// (`you · <context> · <action> <target>`, full access to that one cluster, revoked at its end), so the cluster's RBAC
// decides and the front door's audit names it. One row per apply goes to the action log, written before any request.
//
// Nodes (part 2, D149–D154): cordon and uncordon are one pinned merge patch, reviewed like any action. A drain's
// review is a plan (drain.ts) from reads, the cordon request and the API server's dry-run evictions; it keeps the
// cordon request and the pods to evict by uid, and its Apply starts a run in main that answers at once, pushes its
// progress to the window that started it, stops on Stop, with its window or its cluster, and leaves the node
// cordoned. Main keeps each window's runs (latest state and plan) so the window can re-attach and Stop is always
// reachable (security review of part 2, M1, M4). A development build sends nothing to a node, dry run or not, unless
// LANDLENS_NODE_WRITES names the cluster (D153): the front door refuses it for every token (M5), and every series this
// service sends goes through the same fence as well.
import { createHash, randomBytes } from "node:crypto";
import type { Action, ActionFact, ActionLogEntry, ActionResult, ActionReview, ChangeOperation, DrainProgress, DrainRun, Request } from "@landlens/contracts";
import {
  actionFacts, ActionError, apiPath, applyMergePatch, asksInMain, buildOps, capFacts, checkTargets, clean, cordonBody, diffLines, DrainError, dryRunEvictions,
  EDIT_FIELD_MANAGER, EDIT_TTL_MS, EditBroker, EditError, factList, inOrder, keyOf, listNodes, nameOf, NODE_WRITES_OFF, nodeWrite, podsOnNode, prepareOp, readDrain, risks, runDrain, runnable, schedulable, toEvict,
  type ActionTarget, type ChangeOp, type ClusterManager, type DrainKept, type DrainPlan, type FactInput, type FrontDoor, type Prepared, type RunEnd, type RunState,
  type Send, type Unread,
} from "@landlens/kube";
import { stringify } from "yaml";
import type { WebContents } from "electron";
import { logEntry, type ActionLog } from "./action-log";
import { asYou } from "./as-you";
import type { Confirm } from "./native-confirm";

/** Reviews a window may hold at once (the oldest goes), and may have being prepared at once. */
export const MAX_REVIEWS = 20;
export const MAX_PREPARING = 8;
/** A review's reads and dry runs share this. */
export const REVIEW_MS = 60_000;
/** Each request of an apply, and of a drain's run, waits at most this long (security review of part 1, L12). */
export const APPLY_REQUEST_MS = 30_000;
/**
 * Objects a window may change on the card alone in a minute (security review of part 1, M2): past this, main asks in
 * its own dialog, so a bulk split into singles still reaches it. A restart of more than this many asks at review.
 */
export const CARD_BUDGET = 3;
export const BUDGET_MS = 60_000;
/** Cancels in main's dialog a review survives: the second drops it (L3). */
export const MAX_CANCELS = 2;
/** When the action log can't take the row, nothing is sent (M3). */
export const LOG_REFUSED = "Landlens couldn't write its action log, so nothing was sent.";

type LogPart = Pick<ActionLogEntry, "action" | "kind" | "names"> & { group?: string; resource?: string; namespace?: string; detail?: string };
export type Question = { message: string; detail: string; yes: string };
type Review = {
  wc: WebContents;
  handle: string;
  expires: number;
  /** What Apply must name: the SHA-256 over the card main answered and the kept requests (L2). */
  digest: string;
  /** The edit broker's digest of the kept requests alone, which its apply checks again. */
  requests?: string;
  /** Main's own question (D143), decided here from what main resolved, never from the window. */
  question: Question;
  /** Asked before every Apply of this review (bulk, wide, serious); otherwise only past the window's budget (M2). */
  native: boolean;
  /** The objects it changes, for the window's budget. */
  objects: number;
  asking?: boolean;
  cancels: number;
  log: LogPart;
  /** A drain's kept requests (D151): the cordon, and the pods to evict by uid. Nothing else can be evicted by it. */
  drain?: DrainKept;
  /** A drain's plan as the card showed it, for the window that re-attaches to its run (M4). */
  plan?: DrainPlan;
  /** A drain's node, for dropping an older review of it (M2). */
  node?: string;
};
type Run = {
  wc: WebContents; handle: string; node: string; stop: boolean; startedAt: number;
  /** What the window re-attaches to (M1, M4): the plan it runs and its latest state; kept a while after it ends. */
  plan: DrainPlan; last: DrainProgress; ended: boolean; endedAt?: number;
  /** The action log's row, and whether quitting settled it already (L9). */
  row: string; log: LogPart; quit?: boolean;
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A send whose every request ends by `deadline()` (the review's shared minute, or each apply request's own limit). */
function bounded(raw: Send, left: () => number, message: string): Send {
  return (q) => {
    const ms = left();
    if (ms <= 0) return Promise.reject(fail(504, message));
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      raw(q).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(fail(504, message)), ms))),
    ]);
  };
}
const SLOW_REVIEW = "The cluster took too long to answer; nothing was changed.";
const SLOW_APPLY = "The cluster didn't answer in time.";

/** The digest of a card (L2): SHA-256 over the review main answered (diff, risks, title, facts, plan, native) and the kept requests. */
export const cardDigest = (review: Omit<ActionReview, "digest">, kept: unknown) => createHash("sha256").update(JSON.stringify({ review, kept })).digest("hex");

/** Runs at once: one per node, two per cluster (D152). */
export const MAX_RUNS_PER_CLUSTER = 2;
/** How long an ended run stays for its window to read (M1, M4). */
export const ENDED_KEEP_MS = 10 * 60_000;
/** A drain review a newer one of the same node in the same window replaced (M2, L11). */
export const SUPERSEDED = "A newer review of this drain replaced this one.";
/** Progress pushes to the window, at most four a second. */
export const PROGRESS_MS = 250;

/** D153's words, on the sheet and in every refusal of the fence (the front door's own, M5). */
export const PREVIEW_ONLY = NODE_WRITES_OFF;
export { nodeWrite };
/** The fence: a series that may not write to nodes refuses any request that would, before it leaves Landlens. */
export const fenced = (send: Send): Send => async (r) => {
  if (nodeWrite(r)) throw fail(403, PREVIEW_ONLY);
  return send(r);
};
/** A cluster as D153's rule names it: its kubeconfig context and its API server. */
export type NodeCluster = { context: string; server: string };
/** An API server's host and port as an entry names it: `https://127.0.0.1:6443` is `127.0.0.1:6443`. */
const hostOf = (server: string) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(server) ? server : `https://${server}`).host;
  } catch {
    return undefined;
  }
};
/**
 * Which clusters a build may send node writes to (D153): a packaged app, any; an unpackaged one, only those named in
 * LANDLENS_NODE_WRITES (comma-separated `<context>@<host>:<port>`, the context and its API server both: a context's
 * name alone could point anywhere, security review of part 2, L8). The front door and ActionService both ask it. No
 * test or script names orbstack.
 */
export function nodeWritesFrom(env: NodeJS.ProcessEnv, packaged: boolean): (c: NodeCluster) => boolean {
  if (packaged) return () => true;
  const named = (env.LANDLENS_NODE_WRITES ?? "").split(",").map((x) => x.trim()).filter(Boolean).flatMap((x) => {
    const at = x.lastIndexOf("@");
    const host = at > 0 ? hostOf(x.slice(at + 1)) : undefined;
    return host ? [{ context: x.slice(0, at), host }] : [];
  });
  return (c) => named.some((n) => n.context === c.context && n.host === hostOf(c.server));
}

export type ActionDeps = {
  clusters: Pick<ClusterManager, "get" | "onGone" | "discovery">;
  frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
  log: Pick<ActionLog, "add" | "settle" | "list"> & { readonly unsaved?: boolean };
  /** Telemetry's count (D147): the action and its outcome, closed words only. */
  counted?: (a: { action: string; outcome: string }) => void;
  /** D153: whether this build may write to the nodes of a cluster. Absent: never (the safe default). */
  nodeWrites?: (c: NodeCluster) => boolean;
  /** Tests: the clock, and the trigger's random suffix; a drain run's sleep and time limit. */
  now?: () => number;
  suffix?: () => string;
  sleep?: (ms: number) => Promise<void>;
  drainLimitMs?: number;
};

const A_Z0_9 = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomSuffix = () => [...randomBytes(5)].map((b) => A_Z0_9[b % 36]).join("");

export class ActionService {
  /** Its own broker: no other service's reviews share its ids. */
  private readonly edits = new EditBroker();
  private readonly reviews = new Map<string, Review>();
  private readonly preparing = new Map<WebContents, number>();
  private readonly watched = new WeakSet<WebContents>();
  /** Drains running in main, by run id (the review's id). */
  private readonly runs = new Map<string, Run>();
  /** When each object a window changed was sent, for its budget (M2). */
  private readonly spent = new WeakMap<WebContents, number[]>();
  /** The latest drain review of each node a window asked for (M2, L11): an older one stops at its next request. */
  private readonly drainGen = new WeakMap<WebContents, Map<string, number>>();
  private gen = 0;

  constructor(private readonly d: ActionDeps) {
    d.clusters.onGone((handle) => {
      for (const [k, v] of this.reviews) if (v.handle === handle) this.drop(k);
      for (const r of this.runs.values()) if (r.handle === handle) r.stop = true;
    });
  }

  /** Whether this series may write to nodes (D153); if not, every request goes through the fence. */
  private mayWriteNodes(handle: string): boolean {
    const info = this.d.clusters.get(handle).info;
    return !!this.d.nodeWrites?.({ context: info.context, server: info.server });
  }
  private guard(handle: string, send: Send): Send {
    return this.mayWriteNodes(handle) ? send : fenced(send);
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  /** A window's reviews end with its page: when it goes, reloads or its renderer dies (the rule of edit reviews). */
  private own(wc: WebContents) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    const end = () => {
      for (const [k, v] of this.reviews) if (v.wc === wc) this.drop(k);
      for (const r of this.runs.values()) if (r.wc === wc) r.stop = true; // a run ends with its window (D152)
    };
    wc.on("did-start-navigation", (e: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (e.isMainFrame && !e.isSameDocument) end();
    });
    wc.on("render-process-gone", end);
    wc.once("destroyed", () => {
      end();
      this.watched.delete(wc);
      for (const [k, r] of this.runs) if (r.wc === wc && r.ended) this.runs.delete(k);
    });
  }

  private drop(id: string) {
    this.reviews.delete(id);
    this.edits.discard(id);
  }

  /** Each target's type, from the cluster's discovery (never from the window), and the targets in one list. */
  private async resolve(handle: string, a: Action): Promise<ActionTarget[]> {
    const types = await this.d.clusters.discovery(handle);
    const refs = a.kind === "cordon" || a.kind === "drain" ? [{ group: "", version: "v1", resource: "nodes", name: a.node }] : "targets" in a ? a.targets : [a.target];
    return refs.map((ref) => {
      const t = types.find((x) => x.group === ref.group && x.version === ref.version && x.resource === ref.resource);
      if (!t) throw fail(404, `This cluster doesn't serve ${ref.resource}.`);
      return { type: { group: t.group, version: t.version, resource: t.resource, kind: t.kind, namespaced: t.namespaced, verbs: t.verbs }, ...(ref.namespace ? { namespace: ref.namespace } : {}), name: ref.name };
    });
  }

  async review(r: Request<"action:review">, wc: WebContents): Promise<ActionReview> {
    const busy = this.preparing.get(wc) ?? 0;
    if (busy >= MAX_PREPARING) throw fail(429, `At most ${MAX_PREPARING} actions are checked at once.`);
    this.preparing.set(wc, busy + 1);
    try {
      return await this.prepare(r, wc);
    } finally {
      const n = (this.preparing.get(wc) ?? 1) - 1;
      if (n > 0) this.preparing.set(wc, n);
      else this.preparing.delete(wc);
    }
  }

  private async prepare(r: Request<"action:review">, wc: WebContents): Promise<ActionReview> {
    const a = r.action;
    const targets = await this.resolve(r.handle, a);
    try {
      checkTargets(a.kind, targets);
    } catch (e) {
      throw fail(400, (e as Error).message);
    }
    const t0 = targets[0]!;
    if (a.kind === "cordon" || a.kind === "drain") return this.prepareNode(r, wc, a, t0);
    const what = targets.length === 1 ? `${t0.namespace ? `${t0.namespace}/` : ""}${t0.name}` : `${targets.length} ${t0.type.resource}`;
    const verb = a.kind === "suspend" && !a.suspend ? "resume" : a.kind;
    const deadline = this.now + REVIEW_MS;
    const res = await asYou(this.d, r.handle, `${verb} ${what}`, async (unguarded): Promise<{ review: ActionReview; detail?: string; reasons?: string[]; kept?: ActionTarget[] }> => {
      // Every series goes through D153's fence (a Node's delete is a node write too).
      // The review's reads and dry runs share one minute.
      const send = bounded(this.guard(r.handle, unguarded), () => deadline - this.now, SLOW_REVIEW);
      let ops: ChangeOp[];
      let cronJob: any;
      try {
        if (a.kind === "trigger") {
          // The template is read as you, unscrubbed, so its env values survive into the Job.
          const got = await send({ method: "GET", path: apiPath(t0.type, t0.namespace, t0.name) });
          if (got.status !== 200) return { review: { problems: [{ message: got.status === 404 ? "That CronJob is gone." : got.status === 403 ? `Your role can't read cronjobs in ${t0.namespace}.` : `The cluster answered HTTP ${got.status}.` }] } as ActionReview };
          cronJob = JSON.parse(got.text);
          const jobs = (await this.d.clusters.discovery(r.handle)).find((x) => x.group === "batch" && x.resource === "jobs" && x.version === "v1");
          if (!jobs) throw fail(404, "This cluster doesn't serve batch/v1 jobs.");
          ops = buildOps({ kind: "trigger", targets, cronJob, jobs: { group: jobs.group, version: jobs.version, resource: jobs.resource, kind: jobs.kind, namespaced: jobs.namespaced }, suffix: (this.d.suffix ?? randomSuffix)() });
        } else if (a.kind === "scale") ops = buildOps({ kind: "scale", targets, replicas: a.replicas });
        else if (a.kind === "restart") ops = buildOps({ kind: "restart", targets, now: new Date(this.now) });
        else if (a.kind === "suspend") ops = buildOps({ kind: "suspend", targets, suspend: a.suspend });
        else if (a.kind === "delete") ops = buildOps({ kind: "delete", targets });
        else throw fail(400, "Not an action Landlens takes this way.");
      } catch (e) {
        if (e instanceof ActionError) throw fail(e.status, e.message);
        throw e;
      }
      // Several objects (part 3, D156): one refused at the dry run is left out, shown as a problem on its own line, and
      // the rest stand. Everything after this (facts, main's dialog, its count, the title, the log) is about the kept.
      const review = await this.edits.reviewOps(send, ops, { leaveOut: targets.length > 1 });
      if (!review.id) {
        const { prepared: _none, ...rest } = review;
        return { review: rest as ActionReview };
      }
      const kept = keptTargets(targets, review.prepared);
      let facts: ActionFact[];
      try {
        facts = await this.facts(send, a, kept, review.prepared, cronJob);
      } catch {
        facts = [{ tone: "info", code: "couldnt-check", text: "Landlens couldn't check what else this touches." }];
      }
      // Main's dialog is decided from every fact, before they are cut to the card's eight (M4, M5).
      const reasons = asksInMain(a.kind, kept, facts, review.prepared.map((p) => ({ group: p.op.type.group, resource: p.op.type.resource, obj: p.current })));
      const before = (review.prepared[0]?.current as any)?.spec?.replicas;
      const detail = a.kind === "scale" && typeof before === "number" ? `${before} → ${a.replicas} replica${a.replicas === 1 ? "" : "s"}` : undefined;
      // The current objects go once the facts are made: nothing of them is kept.
      const { prepared: _drop, ...rest } = review;
      return { review: { ...rest, facts: capFacts(facts) } as ActionReview, reasons, kept, ...(detail ? { detail } : {}) };
    });
    const { review: out, detail, reasons, kept: keptOrAll } = res as { review: ActionReview; detail?: string; reasons?: string[]; kept?: ActionTarget[] };
    if (!out.id) return out;
    const kept = keptOrAll ?? targets;
    const context = this.d.clusters.get(r.handle).info.context;
    const title = titleOf(a, kept);
    const native = asksAlways(a, kept, reasons ?? []);
    const { digest: requests, ...card } = { ...out, title, ...(native ? { native: true as const } : {}) };
    const digest = cardDigest(card, requests);
    this.remember(out.id, {
      wc, handle: r.handle, expires: this.now + EDIT_TTL_MS, digest, ...(requests ? { requests } : {}),
      question: questionOf(a, kept, context, reasons ?? []), native, objects: a.kind === "trigger" ? 1 : kept.length, cancels: 0,
      log: {
        action: verb, kind: t0.type.kind, group: t0.type.group, resource: t0.type.resource,
        ...(kept[0]!.namespace && kept.every((t) => t.namespace === kept[0]!.namespace) ? { namespace: kept[0]!.namespace } : {}),
        names: a.kind === "trigger" ? [t0.name] : kept.map((t) => t.name), ...(detail ? { detail } : {}),
      },
    });
    return { ...card, digest };
  }

  /** The facts' reads, as you in the review's own series, then main's sentences (D142). */
  private async facts(send: Send, a: Action, targets: ActionTarget[], prepared: Prepared[], cronJob: any): Promise<ActionFact[]> {
    const t0 = targets[0]!;
    const cut: NonNullable<FactInput["cut"]> = [];
    const list = async (path: string, what?: NonNullable<FactInput["cut"]>[number]): Promise<any[] | Unread> => {
      const r = await send({ method: "GET", path });
      if (r.status === 404) return []; // the API isn't served: nothing of that kind can be here
      if (r.status !== 200) return { status: r.status };
      const body = JSON.parse(r.text);
      if (what && body?.metadata?.continue) cut.push(what); // more than the 500 read: said, never silent (L10)
      return (body.items ?? []) as any[];
    };
    const input: FactInput = {
      kind: a.kind,
      objects: a.kind === "trigger"
        ? [{ group: t0.type.group, resource: t0.type.resource, kind: t0.type.kind, obj: cronJob }]
        : prepared.map((p) => ({ group: p.op.type.group, resource: p.op.type.resource, kind: p.op.type.kind, obj: p.current })),
      ...(a.kind === "scale" ? { replicas: a.replicas } : {}),
      ...(a.kind === "suspend" ? { suspend: a.suspend } : {}),
    };
    if (a.kind === "scale" && t0.namespace) {
      // autoscaling/v2, or v1 where v2 isn't served (L10): a 404 on both is "none".
      const hpas = await list(`/apis/autoscaling/v2/namespaces/${t0.namespace}/horizontalpodautoscalers?limit=500`, "autoscalers");
      input.hpas = Array.isArray(hpas) && !hpas.length ? await list(`/apis/autoscaling/v1/namespaces/${t0.namespace}/horizontalpodautoscalers?limit=500`, "autoscalers") : hpas;
      input.pdbs = await list(`/apis/policy/v1/namespaces/${t0.namespace}/poddisruptionbudgets?limit=500`, "disruption budgets");
    }
    if (a.kind === "delete" && keyOf(t0.type) === "persistentvolumeclaims") {
      // Every bound claim's volume, four at a time (M4): no claim goes without its reclaim policy or a "couldn't".
      input.pvs = {};
      const pvs = [...new Set(prepared.map((p) => nameOf((p.current as any)?.spec?.volumeName)).filter((x): x is string => !!x))];
      const got = await inOrder(pvs, 4, async (pv) => {
        try {
          const r = await send({ method: "GET", path: `/api/v1/persistentvolumes/${pv}` });
          return r.status === 200 ? JSON.parse(r.text) : { status: r.status };
        } catch (e) {
          return { status: (e as { status?: number }).status ?? 0 };
        }
      });
      pvs.forEach((pv, i) => (input.pvs![pv] = got[i]));
    }
    if (cut.length) input.cut = [...new Set(cut)];
    return factList(input);
  }

  /** Keep a review for its window: expired ones go, and a window holds at most 20 (the oldest goes first). */
  private remember(id: string, v: Review) {
    for (const [k, x] of this.reviews) if (x.expires <= this.now) this.drop(k);
    this.own(v.wc);
    const mine = [...this.reviews].filter(([, x]) => x.wc === v.wc);
    if (mine.length >= MAX_REVIEWS) this.drop(mine[0]![0]);
    this.reviews.set(id, v);
  }

  async apply(r: Request<"action:apply">, wc: WebContents, confirm: Confirm): Promise<{ results: ActionResult[] } | { run: string }> {
    const v = this.reviews.get(r.id);
    if (!v || v.wc !== wc || v.handle !== r.handle || v.expires <= this.now) throw fail(404, "no such review");
    // Not a conflict: the dialog for this review is up (L13).
    if (v.asking) throw fail(429, "Landlens is already asking about this.");
    if (v.digest !== r.digest) {
      this.drop(r.id);
      throw fail(409, "This isn't the review that was shown; review again.");
    }
    const info = this.d.clusters.get(r.handle).info; // throws for a cluster that's gone, before the review is used up
    if (v.drain) this.runRoom(r.handle, v.drain.node);
    // Main's dialog: always for this review, or because the window has changed enough on the card this minute (M2).
    const recent = this.recent(wc);
    const over = !v.native && recent + v.objects > CARD_BUDGET;
    if (v.native || over) {
      const q = over ? { ...v.question, detail: `${budgetLine(recent)}${v.question.detail ? `\n\n${v.question.detail}` : ""}` } : v.question;
      v.asking = true;
      let yes = false;
      try {
        yes = await confirm(q);
      } finally {
        v.asking = false;
      }
      // The review may have gone while the dialog was up (the window reloaded, the cluster stopped).
      const here = this.reviews.get(r.id) === v && v.expires > this.now;
      if (!yes) {
        this.record(info, v.log, "cancelled");
        // A page can't raise the dialog without end, nor flush the log with cancels (L3).
        if (++v.cancels >= MAX_CANCELS && here) {
          this.drop(r.id);
          throw fail(410, "Cancelled twice. Review it again to be asked once more.");
        }
        throw fail(409, "Cancelled.");
      }
      if (!here) throw fail(404, "no such review");
    }
    if (v.drain) this.runRoom(r.handle, v.drain.node);
    // The row is written before any request goes; if it can't be, nothing goes (M3).
    const row = this.begin(info, v.log);
    this.reviews.delete(r.id);
    this.spend(wc, v.objects);
    if (v.drain) return { run: this.startRun(r.id, v, wc, row, v.plan!) };
    const t = v.log.names.length === 1 ? `${v.log.namespace ? `${v.log.namespace}/` : ""}${v.log.names[0]}` : `${v.log.names.length} ${v.log.kind.toLowerCase()}s`;
    let each: ActionResult[];
    try {
      const out = await asYou(this.d, r.handle, `${v.log.action} ${t}`, (send) =>
        this.edits.apply(bounded(this.guard(r.handle, send), () => APPLY_REQUEST_MS, SLOW_APPLY), r.id, { each: true, ...(v.requests ? { digest: v.requests } : {}) }));
      each = out.each ?? [];
    } catch (e) {
      this.settle(row, v.log, "failed");
      if (e instanceof EditError) throw fail(e.status, e.message);
      throw e;
    }
    const outcomes = new Set(each.map((x) => x.outcome === "gone" ? "applied" : x.outcome));
    const outcome = outcomes.size === 1 ? ([...outcomes][0] as "applied" | "conflict" | "failed") : outcomes.size ? "partial" : "failed";
    const applied = each.filter((x) => x.outcome === "applied" || x.outcome === "gone").length;
    this.settle(row, v.log, outcome, each.length > 1 && outcome === "partial" ? `${applied} of ${each.length}` : undefined);
    return { results: each };
  }

  /** Objects this window has had sent in the last minute (M2). */
  private recent(wc: WebContents): number {
    const now = this.now;
    const xs = (this.spent.get(wc) ?? []).filter((t) => t > now - BUDGET_MS);
    this.spent.set(wc, xs);
    return xs.length;
  }
  private spend(wc: WebContents, n: number) {
    this.spent.set(wc, [...(this.spent.get(wc) ?? []), ...Array.from({ length: n }, () => this.now)]);
  }

  /** The apply's row, as `sent`, before any request (M3): a row that can't be made or kept refuses the apply. */
  private begin(info: { context: string; server: string }, log: LogPart): string {
    let id: string;
    try {
      id = this.d.log.add(logEntry({ context: info.context, server: info.server, ...log, outcome: "sent" })).id;
    } catch {
      throw fail(500, LOG_REFUSED);
    }
    if (this.d.log.unsaved) {
      try {
        this.d.log.settle(id, { outcome: "failed" });
      } catch {
        // kept as sent in memory; nothing goes
      }
      throw fail(500, LOG_REFUSED);
    }
    return id;
  }

  /** The row's ending, and telemetry's count. The row was written before the send; its ending is checked the same way. */
  private settle(id: string, log: LogPart, outcome: ActionLogEntry["outcome"], detail?: string) {
    try {
      this.d.log.settle(id, { outcome, ...(detail ? { detail } : {}) });
    } catch {
      // the row stays `sent`: still a row for what was sent
    }
    this.d.counted?.({ action: log.action, outcome });
  }

  /** A row for what didn't send (a Cancel in main's dialog). */
  private record(info: { context: string; server: string }, log: LogPart, outcome: ActionLogEntry["outcome"]) {
    try {
      this.d.log.add(logEntry({ context: info.context, server: info.server, ...log, outcome }));
    } catch {
      // nothing was sent; the dialog's answer stands
    }
    this.d.counted?.({ action: log.action, outcome });
  }

  discard(id: string, wc: WebContents) {
    if (this.reviews.get(id)?.wc !== wc) return;
    this.drop(id);
  }

  /** Stop a drain (D152): only the window that started it; no new eviction is sent; the node stays cordoned. */
  stop(run: string, wc: WebContents) {
    const r = this.runs.get(run);
    if (!r || r.wc !== wc || r.ended) throw fail(404, "no such run");
    r.stop = true;
  }

  /**
   * This window's drains on this cluster (M1, M4): running, and ended in the last ten minutes, each with its plan and
   * latest state, so the window can re-attach to one whose sheet it lost, and read an ending it missed. Another
   * window's runs are not listed.
   */
  runsOf(handle: string, wc: WebContents): DrainRun[] {
    this.prune();
    return [...this.runs.values()].filter((r) => r.wc === wc && r.handle === handle)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => ({ progress: r.last, plan: r.plan, ended: r.ended }));
  }

  /** Drains running in this process: quitting asks about them first (L9). */
  liveRuns(): number {
    return [...this.runs.values()].filter((r) => !r.ended).length;
  }

  /**
   * Landlens is quitting with drains running (L9): each is stopped and its row settled now, as `stopped`, since the
   * process won't live to see the run end. The node stays cordoned.
   */
  quit() {
    for (const r of this.runs.values()) {
      if (r.ended || r.quit) continue;
      r.stop = true;
      r.quit = true;
      this.settle(r.row, r.log, "stopped", "Landlens quit during the drain");
    }
  }

  private prune() {
    for (const [k, r] of this.runs) if (r.ended && (r.endedAt ?? 0) + ENDED_KEEP_MS <= this.now) this.runs.delete(k);
  }

  /** Whether a drain of this node may start: one per node, two per cluster. */
  private runRoom(handle: string, node: string) {
    this.prune();
    const here = [...this.runs.values()].filter((x) => x.handle === handle && !x.ended);
    if (here.some((x) => x.node === node)) throw fail(409, "A drain of this node is already running.");
    if (here.length >= MAX_RUNS_PER_CLUSTER) throw fail(429, `At most ${MAX_RUNS_PER_CLUSTER} drains run on a cluster at once.`);
  }

  /**
   * The run (D152), in main: its own token for its whole length (`you · <context> · drain <node>`), revoked at its
   * end; progress to the window that started it, at most four times a second; one log row when it ends.
   */
  private startRun(id: string, v: Review, wc: WebContents, row: string, plan: DrainPlan): string {
    const kept = v.drain!;
    const startedAt = this.now;
    let seq = 0;
    const run: Run = {
      wc, handle: v.handle, node: kept.node, stop: false, startedAt, plan, ended: false, row, log: v.log,
      last: { run: id, node: kept.node, state: "cordoning", pods: kept.pods.map((p) => ({ namespace: p.namespace, name: p.name, state: "waiting" })), startedAt, seq: 0 },
    };
    this.runs.set(id, run);
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: DrainProgress | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      last = Date.now();
      if (pending && !wc.isDestroyed()) wc.send("action:progress", pending);
    };
    // Main keeps every state at once (what action:runs answers, M1); the window's pushes are throttled.
    const push = (s: RunState, now = false) => {
      pending = { ...s, run: id, startedAt, seq: ++seq };
      run.last = pending;
      const wait = PROGRESS_MS - (Date.now() - last);
      if (now || wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    };
    const total = kept.pods.length;
    void asYou(this.d, v.handle, `drain ${kept.node}`, (send) => runDrain({
      send: bounded(this.guard(v.handle, send), () => APPLY_REQUEST_MS, SLOW_APPLY), kept, stopped: () => run.stop, onProgress: (s) => push(s),
      ...(this.d.now ? { now: this.d.now } : {}), ...(this.d.sleep ? { sleep: this.d.sleep } : {}), ...(this.d.drainLimitMs ? { limitMs: this.d.drainLimitMs } : {}),
    }))
      .then((end: RunEnd) => {
        const { evicted: _e, blocked: _b, failed: _f, ...state } = end;
        push(state, true);
        const gone = end.pods.filter((p) => p.state === "gone").length;
        // Pods that arrived after the preview, or a node no longer cordoned, are not "applied" (M3).
        const outcome: ActionLogEntry["outcome"] = end.state === "stopped" ? "stopped"
          : end.state === "failed" ? (/changed since/.test(end.note ?? "") ? "conflict" : end.evicted ? "partial" : "failed")
          : gone === total && !end.arrived && end.cordoned !== false ? "applied" : gone === 0 && end.evicted === 0 ? "failed" : "partial";
        const detail = `${end.evicted} evicted, ${end.blocked} blocked${end.arrived ? `, ${end.arrived} arrived after the preview` : ""}${end.cordoned === false ? ", no longer cordoned" : ""}`;
        if (!run.quit) this.settle(row, v.log, outcome, detail);
      }, () => {
        push({ node: kept.node, state: "failed", pods: kept.pods.map((p) => ({ namespace: p.namespace, name: p.name, state: "waiting" })), note: "Landlens couldn't run the drain. The node may be cordoned." }, true);
        if (!run.quit) this.settle(row, v.log, "failed");
      })
      .finally(() => {
        run.ended = true;
        run.endedAt = this.now;
        if (wc.isDestroyed()) this.runs.delete(id);
      });
    return id;
  }

  /**
   * Cordon and drain reviews (D149–D151). A development build not told it may write to this context's nodes builds
   * them from reads only, marked previewOnly, with no id: nothing to apply (D153).
   */
  private async prepareNode(r: Request<"action:review">, wc: WebContents, a: Extract<Action, { kind: "cordon" | "drain" }>, t0: ActionTarget): Promise<ActionReview> {
    const info = this.d.clusters.get(r.handle).info;
    const allowed = this.mayWriteNodes(r.handle);
    const verb = a.kind === "cordon" ? (a.on ? "cordon" : "uncordon") : "drain";
    const deadline = this.now + REVIEW_MS;
    const title = titleOf(a, [t0]);
    // A drain review supersedes this window's earlier ones of the same node (M2, L11): they stop at their next request
    // and get no id, and a kept one is dropped. One review per window and node is ever at work.
    const slot = `${r.handle}/${a.node}`;
    const mine = a.kind === "drain" ? ++this.gen : 0;
    if (a.kind === "drain") {
      let gens = this.drainGen.get(wc);
      if (!gens) this.drainGen.set(wc, (gens = new Map()));
      gens.set(slot, mine);
      for (const [k, v] of this.reviews) if (v.wc === wc && v.drain && v.handle === r.handle && v.node === a.node) this.drop(k);
    }
    const current = () => a.kind !== "drain" || this.drainGen.get(wc)?.get(slot) === mine;
    type Out = { review: ActionReview; keep?: { drain?: DrainKept; native?: Question; counts?: DrainPlan["counts"] } };
    const out = await asYou(this.d, r.handle, `${verb} ${a.node}`, async (unguarded): Promise<Out> => {
      const timed = bounded(this.guard(r.handle, unguarded), () => deadline - this.now, SLOW_REVIEW);
      const send: Send = (q) => (current() ? timed(q) : Promise.reject(fail(409, SUPERSEDED)));
      const problem = (message: string): Out => ({ review: { problems: [{ message }] } });
      if (a.kind === "cordon") {
        const got = await send({ method: "GET", path: `/api/v1/nodes/${a.node}` });
        if (got.status === 404) return problem("That node is gone.");
        if (got.status === 403) return problem("Your role can't read nodes.");
        if (got.status !== 200) return problem(`The cluster answered HTTP ${got.status}.`);
        const node = JSON.parse(got.text);
        const cordoned = node?.spec?.unschedulable === true;
        if (a.on && cordoned) return problem(`${a.node} is already cordoned.`);
        if (!a.on && !cordoned) return problem(`${a.node} isn't cordoned.`);
        const facts = await this.cordonFacts(send, a.on, node);
        const [op] = buildOps({ kind: "cordon", targets: [t0], on: a.on });
        if (!allowed) {
          // Landlens's own reading of the patch, not the cluster's dry run: nothing is sent to the node.
          const after = applyMergePatch(structuredClone(node), cordonBody(a.on));
          const diff = diffLines(stringify(clean(node), { lineWidth: 0 }), stringify(clean(after), { lineWidth: 0 }));
          const shown: ChangeOperation = { verb: "patch", kind: "Node", group: "", name: a.node, diff, warnings: [], risk: risks(op!, node, after) };
          return { review: { operations: [shown], facts, previewOnly: true } };
        }
        const review = await this.edits.reviewOps(send, [op!]);
        const { prepared: _drop, ...rest } = review;
        return { review: { ...rest, facts } };
      }
      // Drain: the plan from reads, then (when this build may) the API server's own word and the cordon's dry run.
      const ticks = { bare: a.bare, emptyDir: a.emptyDir };
      let plan: DrainPlan;
      let node: any;
      try {
        ({ plan, node } = await readDrain(send, a.node, ticks));
      } catch (e) {
        if (e instanceof DrainError) return problem(e.message);
        throw e;
      }
      // L10: the drain says, as cordon does, when no other node takes new pods: every evicted pod stays Pending.
      const facts = await this.drainFacts(send, a.node);
      if (!allowed) return { review: { plan, previewOnly: true, ticks, ...(facts.length ? { facts } : {}) } };
      const asked = await dryRunEvictions(send, plan);
      plan = asked.plan;
      const disagree = { ...(asked.disagree ? { disagree: asked.disagree } : {}), ticks, ...(facts.length ? { facts } : {}) };
      if (!runnable(plan)) return { review: { plan, ...disagree } };
      let cordon: DrainKept["cordon"];
      if (!plan.cordoned) {
        const [op] = buildOps({ kind: "cordon", targets: [t0], on: true });
        let p: Prepared;
        try {
          p = await prepareOp(send, op!, { fieldManager: EDIT_FIELD_MANAGER, hideSecrets: true });
        } catch (e) {
          const s = (e as { status?: number }).status;
          if (s === 504) throw e;
          return { review: { plan, ...disagree, problems: [{ message: s === 403 ? "Your role can't cordon this node." : s === 409 ? "The node changed while Landlens read it; review again." : "The cluster refused the cordon's dry run." }], ...(s === 409 ? { conflict: true } : {}) } };
        }
        cordon = { method: p.method, path: p.path, contentType: p.contentType ?? "application/json", body: p.body ?? "" };
      }
      const nodeUid = typeof node?.metadata?.uid === "string" ? node.metadata.uid : undefined;
      return {
        review: { plan, ...disagree },
        keep: {
          drain: { node: a.node, ...(nodeUid ? { nodeUid } : {}), ticks, ...(cordon ? { cordon } : {}), pods: toEvict(plan) },
          native: drainQuestion(a.node, info.context, plan, facts), counts: plan.counts,
        },
      };
    }).catch((e) => {
      if (!current()) return { review: { problems: [{ message: SUPERSEDED }] } } as Out;
      throw e;
    });
    // Replaced while it was at work: no id, whatever it found (M2).
    if (!current()) return { title, problems: [{ message: SUPERSEDED }] };
    const review: ActionReview = { ...out.review, title };
    if (review.previewOnly || (review.problems?.length && !review.id)) return review;
    const log = { kind: "Node", group: "", resource: "nodes", names: [a.node] };
    if (a.kind === "cordon") {
      if (!review.id) return review;
      // The digest covers the card main answered, as for every action (L2).
      const { digest: requests, ...card } = review;
      const digest = cardDigest(card, requests);
      this.remember(review.id, {
        wc, handle: r.handle, expires: this.now + EDIT_TTL_MS, digest, ...(requests ? { requests } : {}),
        question: { message: `${title} on ${info.context}?`, detail: "", yes: a.on ? "Cordon" : "Uncordon" }, native: false, objects: 1, cancels: 0,
        log: { action: verb, ...log },
      });
      return { ...card, digest };
    }
    if (!out.keep?.drain) return review;
    // The drain's review is main's own: its id, and the digest of the plan main answered, its dialog and exactly what
    // Apply will send (L2).
    const id = `ed${randomBytes(12).toString("base64url")}`;
    // The ticks are in the card and so in the digest (M2), and main's dialog names what they let go.
    const card: ActionReview = { ...review, id, native: true };
    const digest = cardDigest(card, out.keep.drain);
    this.remember(id, { wc, handle: r.handle, expires: this.now + EDIT_TTL_MS, digest, question: out.keep.native!, native: true, objects: 1, cancels: 0, drain: out.keep.drain, plan: review.plan!, node: a.node, log: { action: "drain", ...log } });
    return { ...card, digest };
  }

  /** A drain's facts (L10): the only node that takes new pods, or that the other nodes couldn't be read. */
  private async drainFacts(send: Send, node: string): Promise<ActionFact[]> {
    let nodes: Awaited<ReturnType<typeof listNodes>>;
    try {
      nodes = await listNodes(send);
    } catch (e) {
      if ((e as { status?: number }).status === 504 || (e as { status?: number }).status === 409) throw e;
      return [{ tone: "info", code: "couldnt-check", text: "Landlens couldn't check the other nodes." }];
    }
    if (nodes.status) return [{ tone: "info", code: "couldnt-check", text: `Landlens couldn't check the other nodes (HTTP ${nodes.status}).` }];
    if (nodes.items.some((n) => n?.metadata?.name !== node && schedulable(n))) return [];
    return [{ tone: "bad", code: "only-node", text: "No other node takes new pods: every pod evicted stays Pending." }];
  }

  /** Cordon's facts (D149): how many pods stay on it, and whether it is the only node that takes new ones. */
  private async cordonFacts(send: Send, on: boolean, node: any): Promise<ActionFact[]> {
    if (!on) return actionFacts({ kind: "cordon", on, objects: [{ group: "", resource: "nodes", kind: "Node", obj: node }] });
    const pods = await podsOnNode(send, String(node.metadata.name));
    // Every node, in pages (L10).
    const nodes = await listNodes(send);
    const input: FactInput = {
      kind: "cordon", on, objects: [{ group: "", resource: "nodes", kind: "Node", obj: node }],
      nodePods: pods.status ? { status: pods.status } : pods.items.filter((p) => !["Succeeded", "Failed"].includes(p?.status?.phase)).length,
      nodes: nodes.status ? { status: nodes.status } as Unread : nodes.items,
    };
    return actionFacts(input);
  }

  /** The connected cluster's rows (L7): its context and its API server. */
  history(handle: string, limit?: number): ActionLogEntry[] {
    const info = this.d.clusters.get(handle).info;
    return this.d.log.list(info.context, info.server, limit);
  }
}

const one = (t: ActionTarget) => `${t.type.kind.toLowerCase()} ${t.namespace ? `${t.namespace}/` : ""}${t.name}`;
const many = (ts: ActionTarget[]) => {
  const ns = ts[0]!.namespace;
  return `${ts.length} ${ts[0]!.type.resource}${ns && ts.every((t) => t.namespace === ns) ? ` in ${ns}` : ""}`;
};

/** Main's words for the card's title (D144): the verb and checked names, never text from the window. */
export function titleOf(a: Action, ts: ActionTarget[]): string {
  const t = ts[0]!;
  switch (a.kind) {
    case "scale": return `Scale ${one(t)} to ${a.replicas} replica${a.replicas === 1 ? "" : "s"}`;
    case "restart": return ts.length === 1 ? `Restart ${one(t)}` : `Restart ${many(ts)}`;
    case "delete": return ts.length === 1 ? `Delete ${one(t)}` : `Delete ${many(ts)}`;
    case "trigger": return `Run ${one(t)} now`;
    case "suspend": return `${a.suspend ? "Suspend" : "Resume"} ${one(t)}`;
    case "cordon": return `${a.on ? "Cordon" : "Uncordon"} node ${t.name}`;
    case "drain": return `Drain node ${t.name}`;
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A kind's plural for main's sentences: ConfigMaps, Ingresses, NetworkPolicies. */
export const kinds = (k: string) => (/(s|x|ch|sh)$/.test(k) ? `${k}es` : /[^aeiou]y$/.test(k) ? `${k.slice(0, -1)}ies` : `${k}s`);

/** A namespace whose objects are the cluster's own: flagged wherever it shows in main's dialog (M1). */
export const systemNamespace = (ns: string) => /^kube-/.test(ns) || /-system$/.test(ns);

/**
 * Main's dialog's list of objects (security review of part 1, M1): sorted by main, the dangerous first. Counts by
 * namespace always; then every flagged object by namespace/name (cluster-scoped, in a system namespace, or outside the
 * namespace most of them are in), then the rest by namespace/name, the first ten and "and N more in <namespace>". A
 * wide or flagged object is never behind "and N more"; the order the window sent doesn't matter.
 */
export function targetLines(objs: { namespace?: string; name: string }[], kind: string): string {
  const full = (t: { namespace?: string; name: string }) => (t.namespace ? `${t.namespace}/${t.name}` : t.name);
  const byNs = new Map<string, number>();
  for (const t of objs) byNs.set(t.namespace ?? "", (byNs.get(t.namespace ?? "") ?? 0) + 1);
  const most = [...byNs].filter(([ns]) => ns).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const several = [...byNs.keys()].length > 1;
  const FLAGS = ["Cluster-scoped", "In a system namespace", "Outside " + (most ?? "its namespace")] as const;
  const flag = (t: { namespace?: string }) => (!t.namespace ? 0 : systemNamespace(t.namespace) ? 1 : several && t.namespace !== most ? 2 : 3);
  const sorted = [...objs].sort((a, b) => flag(a) - flag(b) || full(a).localeCompare(full(b)));
  const lines: string[] = [];
  if (objs.length > 1) {
    const where = [...byNs].sort((a, b) => a[0].localeCompare(b[0])).map(([ns, n]) => (ns ? `${n} in ${ns}` : `${n} cluster-scoped`));
    lines.push(`${count(objs.length, kind, kinds(kind))}: ${where.join(", ")}.`);
  }
  for (let f = 0; f < 3; f++) {
    const these = sorted.filter((t) => flag(t) === f);
    if (!these.length) continue;
    lines.push("", `${FLAGS[f]}:`, ...these.map(full));
  }
  const rest = sorted.filter((t) => flag(t) === 3);
  if (rest.length) {
    lines.push("", ...rest.slice(0, 10).map(full));
    if (rest.length > 10) lines.push(`and ${rest.length - 10} more in ${rest[0]!.namespace}`);
  }
  return lines.join("\n").replace(/^\n/, "");
}

/**
 * Main's dialog before a drain (D152): the node, the context, the plan's counts, what the two ticks let go (bare pods
 * deleted for good, emptyDir data lost, each named: security review of part 2, M2), the only node (L10), and the pods
 * it evicts by namespace (M1). All from main's own plan, never from the window.
 */
export function drainQuestion(node: string, context: string, plan: DrainPlan, facts: ActionFact[] = []): Question {
  const ds = plan.pods.filter((p) => p.class === "daemonset").length;
  const parts = [
    `${count(plan.counts.evict, "pod")} will be evicted`,
    ...(plan.counts.blocked ? [`${plan.counts.blocked} ${plan.counts.blocked === 1 ? "is" : "are"} blocked by a disruption budget and will be retried`] : []),
    ...(plan.counts.skipped ? [`${count(plan.counts.skipped, ds === plan.counts.skipped ? "DaemonSet pod" : "pod")} stay`] : []),
  ];
  const evicted = toEvict(plan);
  const uids = new Set(evicted.map((p) => p.uid));
  const kept = plan.pods.filter((p) => uids.has(p.uid));
  const bare = kept.filter((p) => p.bare && p.class === "evict");
  const empty = kept.filter((p) => p.emptyDir.length);
  const full = (p: { namespace: string; name: string }) => `${p.namespace}/${p.name}`;
  const loss = [
    ...(bare.length ? [`${count(bare.length, "pod")} ${bare.length === 1 ? "is" : "are"} recreated by nothing and deleted for good:`, ...bare.map(full)] : []),
    ...(empty.length ? [`${bare.length ? "\n" : ""}${count(empty.length, "pod")} lose${empty.length === 1 ? "s" : ""} emptyDir data:`, ...empty.map((p) => `${full(p)} (${p.emptyDir.join(", ")})`)] : []),
  ];
  const only = facts.filter((f) => f.code === "only-node").map((f) => f.text);
  return {
    message: `Drain ${node} on ${context}?`,
    detail: [
      `${parts.join(", ")}.\nThe node stays cordoned until you uncordon it.`,
      ...only,
      ...(loss.length ? [loss.join("\n")] : []),
      ...(evicted.length ? [targetLines(evicted, "Pod")] : []),
    ].join("\n\n"),
    yes: "Drain",
  };
}

/**
 * Whether Apply asks in main's own dialog every time (D143, widened by the security review of part 1, M2 and M5): a
 * delete of more than one object, or one main has reasons for (asksInMain: a cluster-scoped kind, a serious fact, an
 * unchecked volume, many pods); a restart of more than CARD_BUDGET workloads. Other applies ask past the budget.
 */
export function asksAlways(a: Action, ts: ActionTarget[], reasons: string[]): boolean {
  if (a.kind === "delete") return ts.length > 1 || reasons.length > 0;
  if (a.kind === "restart") return ts.length > CARD_BUDGET;
  return false;
}

/**
 * The targets whose operation passed its dry run (part 3, D156), in the window's order: a bulk review keeps those and
 * leaves the refused out, so main's dialog, its count, the title and the log name only what Apply can send.
 */
export function keptTargets(targets: ActionTarget[], prepared: { op: { namespace?: string; name: string } }[]): ActionTarget[] {
  if (prepared.length === targets.length) return targets;
  const ok = new Set(prepared.map((p) => `${p.op.namespace ?? ""}/${p.op.name}`));
  return targets.filter((t) => ok.has(`${t.namespace ?? ""}/${t.name}`));
}

/** The dialog's line when a window is past its budget (M2). */
export const budgetLine = (recent: number) =>
  `This window has sent ${count(recent, "change")} in the last minute. Past ${CARD_BUDGET}, Landlens asks here as well as on its card.`;

/** Main's own question for a review (D143, M1): what, where, why, and every flagged object. */
export function questionOf(a: Action, ts: ActionTarget[], context: string, reasons: string[]): Question {
  const t = ts[0]!;
  const kind = t.type.kind;
  const verb = a.kind === "delete" ? "Delete" : a.kind === "restart" ? "Restart" : a.kind === "scale" ? "Scale" : a.kind === "trigger" ? "Run" : a.kind === "suspend" ? (a.suspend ? "Suspend" : "Resume") : a.kind === "cordon" ? (a.on ? "Cordon" : "Uncordon") : "Drain";
  const ns = t.namespace && ts.every((x) => x.namespace === t.namespace) ? ` in ${t.namespace}` : "";
  const nss = new Set(ts.map((x) => x.namespace ?? "")).size;
  const message = ts.length === 1
    ? (a.kind === "delete" ? `Delete ${kind} ${t.namespace ? `${t.namespace}/` : ""}${t.name} on ${context}?` : `${titleOf(a, ts)} on ${context}?`)
    : `${verb} ${ts.length} ${kinds(kind)}${ns || (nss > 1 ? ` in ${nss} namespaces` : "")} on ${context}?`;
  const why = reasons.join("\n");
  const list = ts.length > 1 ? targetLines(ts, kind) : a.kind === "delete" ? "It is deleted as soon as you confirm." : "";
  return { message, detail: [why, list].filter(Boolean).join("\n\n"), yes: ts.length > 1 ? `${verb} ${ts.length}` : verb };
}

/**
 * The question before quitting (D23, and the security review of part 2, L9): sessions that close, drains that stop.
 * A drain stopped this way leaves its node cordoned and its row in the action log as `stopped`.
 */
export function quitQuestion(sessions: number, drains: number): { message: string; detail: string } {
  const what = [sessions ? count(sessions, "session") : "", drains ? count(drains, "drain") : ""].filter(Boolean).join(" and ");
  const detail = [
    sessions ? "Every shell and terminal open in Landlens closes with it." : "",
    drains ? `${drains === 1 ? "The drain stops" : "The drains stop"}: no more pods are evicted, ${drains === 1 ? "its node stays" : "their nodes stay"} cordoned, and Recent actions says stopped.` : "",
  ].filter(Boolean).join(" ");
  return { message: `${what} will end`, detail };
}
