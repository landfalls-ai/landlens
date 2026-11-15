// Your actions in main (wave 8 part 1, D143): Scale, Restart, Delete, Trigger, Suspend and Resume, sent as you.
//
// The window names an action's closed shape and its targets. Main resolves each target's type from the cluster's
// discovery, reads what the action needs as you, builds every request (packages/kube actions.ts), and dry-runs each
// through the same preparation as the agent's changes (EditBroker.reviewOps → prepareOp). The review is kept under an
// `ed…` id with the SHA-256 of its requests; the window gets the diff, risks, main's own title and facts, and the
// digest. Apply names the id and the digest and nothing else, and sends exactly the kept requests, once. Bulk and wide
// deletes ask in main's own dialog first; Cancel sends nothing and keeps the review. Every series of requests has its
// own token (`you · <context> · <action> <target>`, full access to that one cluster, revoked at its end), so the
// cluster's RBAC decides and the front door's audit names it. One row per apply goes to the action log.
import { randomBytes } from "node:crypto";
import type { Action, ActionFact, ActionLogEntry, ActionResult, ActionReview, Request } from "@landlens/contracts";
import {
  actionFacts, ActionError, apiPath, buildOps, checkTargets, EDIT_TTL_MS, EditBroker, EditError, keyOf, nameOf, WIDE_DELETES,
  type ActionTarget, type ChangeOp, type ClusterManager, type FactInput, type FrontDoor, type Prepared, type Send, type Unread,
} from "@landlens/kube";
import type { WebContents } from "electron";
import { logEntry, type ActionLog } from "./action-log";
import { asYou } from "./as-you";
import type { Confirm } from "./native-confirm";

/** Reviews a window may hold at once (the oldest goes), and may have being prepared at once. */
export const MAX_REVIEWS = 20;
export const MAX_PREPARING = 8;
/** A review's reads and dry runs share this. */
export const REVIEW_MS = 60_000;

type LogPart = Pick<ActionLogEntry, "action" | "kind" | "names"> & { namespace?: string; detail?: string };
type Review = {
  wc: WebContents;
  handle: string;
  expires: number;
  digest: string;
  /** Main's own question before Apply (D143), decided here from what main resolved, never from the window. */
  native?: { message: string; detail: string; yes: string };
  asking?: boolean;
  log: LogPart;
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export type ActionDeps = {
  clusters: Pick<ClusterManager, "get" | "onGone" | "discovery">;
  frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
  log: Pick<ActionLog, "add" | "list">;
  /** Telemetry's count (D147): the action and its outcome, closed words only. */
  counted?: (a: { action: string; outcome: string }) => void;
  /** Tests: the clock, and the trigger's random suffix. */
  now?: () => number;
  suffix?: () => string;
};

const A_Z0_9 = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomSuffix = () => [...randomBytes(5)].map((b) => A_Z0_9[b % 36]).join("");

export class ActionService {
  /** Its own broker: no other service's reviews share its ids. */
  private readonly edits = new EditBroker();
  private readonly reviews = new Map<string, Review>();
  private readonly preparing = new Map<WebContents, number>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(private readonly d: ActionDeps) {
    d.clusters.onGone((handle) => {
      for (const [k, v] of this.reviews) if (v.handle === handle) this.drop(k);
    });
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
    };
    wc.on("did-start-navigation", (e: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (e.isMainFrame && !e.isSameDocument) end();
    });
    wc.on("render-process-gone", end);
    wc.once("destroyed", () => (end(), this.watched.delete(wc)));
  }

  private drop(id: string) {
    this.reviews.delete(id);
    this.edits.discard(id);
  }

  /** Each target's type, from the cluster's discovery (never from the window), and the targets in one list. */
  private async resolve(handle: string, a: Action): Promise<ActionTarget[]> {
    const types = await this.d.clusters.discovery(handle);
    const refs = "targets" in a ? a.targets : [a.target];
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
    const what = targets.length === 1 ? `${t0.namespace ? `${t0.namespace}/` : ""}${t0.name}` : `${targets.length} ${t0.type.resource}`;
    const verb = a.kind === "suspend" && !a.suspend ? "resume" : a.kind;
    const deadline = this.now + REVIEW_MS;
    const res = await asYou(this.d, r.handle, `${verb} ${what}`, async (raw): Promise<{ review: ActionReview; detail?: string }> => {
      // The review's reads and dry runs share one minute.
      const send: Send = (q) => {
        const left = deadline - this.now;
        if (left <= 0) return Promise.reject(fail(504, "The cluster took too long to answer; nothing was changed."));
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          raw(q).finally(() => clearTimeout(timer)),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(fail(504, "The cluster took too long to answer; nothing was changed.")), left))),
        ]);
      };
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
        else ops = buildOps({ kind: "delete", targets });
      } catch (e) {
        if (e instanceof ActionError) throw fail(e.status, e.message);
        throw e;
      }
      const review = await this.edits.reviewOps(send, ops);
      if (!review.id) {
        const { prepared: _none, ...rest } = review;
        return { review: rest as ActionReview };
      }
      let facts: ActionFact[];
      try {
        facts = await this.facts(send, a, targets, review.prepared, cronJob);
      } catch {
        facts = [{ tone: "info", code: "couldnt-check", text: "Landlens couldn't check what else this touches." }];
      }
      const before = (review.prepared[0]?.current as any)?.spec?.replicas;
      const detail = a.kind === "scale" && typeof before === "number" ? `${before} → ${a.replicas} replica${a.replicas === 1 ? "" : "s"}` : undefined;
      // The current objects go once the facts are made: nothing of them is kept.
      const { prepared: _drop, ...rest } = review;
      return { review: { ...rest, facts } as ActionReview, ...(detail ? { detail } : {}) };
    });
    const { review: out, detail } = res as { review: ActionReview; detail?: string };
    if (!out.id) return out;
    const context = this.d.clusters.get(r.handle).info.context;
    const title = titleOf(a, targets);
    const native = nativeOf(a, targets, context);
    this.remember(out.id, {
      wc, handle: r.handle, expires: this.now + EDIT_TTL_MS, digest: out.digest!,
      ...(native ? { native } : {}),
      log: { action: verb, kind: t0.type.kind, ...(t0.namespace && targets.every((t) => t.namespace === t0.namespace) ? { namespace: t0.namespace } : {}), names: a.kind === "trigger" ? [t0.name] : targets.map((t) => t.name), ...(detail ? { detail } : {}) },
    });
    return { ...out, title, ...(native ? { native: true as const } : {}) };
  }

  /** The facts' reads, as you in the review's own series, then main's sentences (D142). */
  private async facts(send: Send, a: Action, targets: ActionTarget[], prepared: Prepared[], cronJob: any): Promise<ActionFact[]> {
    const t0 = targets[0]!;
    const list = async (path: string): Promise<any[] | Unread> => {
      const r = await send({ method: "GET", path });
      if (r.status === 404) return []; // the API isn't served: nothing of that kind can be here
      if (r.status !== 200) return { status: r.status };
      return (JSON.parse(r.text).items ?? []) as any[];
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
      input.hpas = await list(`/apis/autoscaling/v2/namespaces/${t0.namespace}/horizontalpodautoscalers?limit=500`);
      input.pdbs = await list(`/apis/policy/v1/namespaces/${t0.namespace}/poddisruptionbudgets?limit=500`);
    }
    if (a.kind === "delete" && keyOf(t0.type) === "persistentvolumeclaims") {
      input.pvs = {};
      for (const p of prepared.slice(0, 10)) {
        const pv = nameOf((p.current as any)?.spec?.volumeName);
        if (!pv) continue;
        const r = await send({ method: "GET", path: `/api/v1/persistentvolumes/${pv}` });
        input.pvs[pv] = r.status === 200 ? JSON.parse(r.text) : { status: r.status };
      }
    }
    return actionFacts(input);
  }

  /** Keep a review for its window: expired ones go, and a window holds at most 20 (the oldest goes first). */
  private remember(id: string, v: Review) {
    for (const [k, x] of this.reviews) if (x.expires <= this.now) this.drop(k);
    this.own(v.wc);
    const mine = [...this.reviews].filter(([, x]) => x.wc === v.wc);
    if (mine.length >= MAX_REVIEWS) this.drop(mine[0]![0]);
    this.reviews.set(id, v);
  }

  async apply(r: Request<"action:apply">, wc: WebContents, confirm: Confirm): Promise<{ results: ActionResult[] }> {
    const v = this.reviews.get(r.id);
    if (!v || v.wc !== wc || v.handle !== r.handle || v.expires <= this.now) throw fail(404, "no such review");
    if (v.asking) throw fail(409, "Landlens is already asking about this.");
    if (v.digest !== r.digest) {
      this.drop(r.id);
      throw fail(409, "This isn't the review that was shown; review again.");
    }
    const info = this.d.clusters.get(r.handle).info; // throws for a cluster that's gone, before the review is used up
    if (v.native) {
      v.asking = true;
      let yes = false;
      try {
        yes = await confirm(v.native);
      } finally {
        v.asking = false;
      }
      if (!yes) {
        this.record(info, v.log, "cancelled");
        throw fail(409, "Cancelled.");
      }
      // The review may have gone while the dialog was up (the window reloaded, the cluster stopped).
      if (this.reviews.get(r.id) !== v || v.expires <= this.now) throw fail(404, "no such review");
    }
    this.reviews.delete(r.id);
    const t = v.log.names.length === 1 ? `${v.log.namespace ? `${v.log.namespace}/` : ""}${v.log.names[0]}` : `${v.log.names.length} ${v.log.kind.toLowerCase()}s`;
    let each: ActionResult[];
    try {
      const out = await asYou(this.d, r.handle, `${v.log.action} ${t}`, (send) => this.edits.apply(send, r.id, { each: true, digest: v.digest }));
      each = out.each ?? [];
    } catch (e) {
      if (e instanceof EditError) throw fail(e.status, e.message);
      throw e;
    }
    const outcomes = new Set(each.map((x) => x.outcome === "gone" ? "applied" : x.outcome));
    const outcome = outcomes.size === 1 ? ([...outcomes][0] as "applied" | "conflict" | "failed") : outcomes.size ? "partial" : "failed";
    const applied = each.filter((x) => x.outcome === "applied" || x.outcome === "gone").length;
    this.record(info, { ...v.log, ...(each.length > 1 && outcome === "partial" ? { detail: `${applied} of ${each.length}` } : {}) }, outcome);
    return { results: each };
  }

  private record(info: { context: string; server: string }, log: LogPart, outcome: ActionLogEntry["outcome"]) {
    try {
      this.d.log.add(logEntry({ context: info.context, server: info.server, ...log, outcome }));
    } catch {
      // a row that doesn't check is not written; the action itself stands
    }
    this.d.counted?.({ action: log.action, outcome });
  }

  discard(id: string, wc: WebContents) {
    if (this.reviews.get(id)?.wc !== wc) return;
    this.drop(id);
  }

  history(context: string, limit?: number): ActionLogEntry[] {
    return this.d.log.list(context, limit);
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
  }
}

/** Main's own dialog before Apply (D143): a delete of more than one object, or of a wide kind. */
export function nativeOf(a: Action, ts: ActionTarget[], context: string): Review["native"] {
  if (a.kind !== "delete") return undefined;
  const t = ts[0]!;
  if (ts.length === 1 && !WIDE_DELETES.has(keyOf(t.type))) return undefined;
  const kind = ts.length === 1 ? t.type.kind : `${t.type.kind}s`;
  const ns = t.namespace && ts.every((x) => x.namespace === t.namespace) ? ` in ${t.namespace}` : "";
  if (ts.length === 1) return { message: `Delete ${t.type.kind} ${t.name} on ${context}?`, detail: t.type.resource === "namespaces" && !t.type.group ? "Everything in it is deleted with it." : "It is deleted as soon as you confirm.", yes: "Delete" };
  const names = ts.slice(0, 10).map((x) => x.name).join("\n");
  return {
    message: `Delete ${ts.length} ${kind}${ns} on ${context}?`,
    detail: `${names}${ts.length > 10 ? `\nand ${ts.length - 10} more` : ""}`,
    yes: `Delete ${ts.length}`,
  };
}
