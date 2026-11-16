// Your actions in the window (wave 8, D145–D148): which actions an object has, and "Ask Claude first" — a fixed
// question per action, sent with main's title, main's facts and main's scrubbed diff as one quoted context. Nothing is
// applied by asking, and the agent has no tool that presses Apply.
import type { ActionFact, ActionKind, ActionReview, KubeObject, ResourceType } from "@landlens/contracts";
import { actionFits } from "@landlens/kube/action-kinds";
import type { AskContext } from "./quotes";

export type ActionVerb = ActionKind | "resume" | "uncordon";

/** D153's sentence, as main says it: a development build sends nothing to nodes it wasn't told it may. */
export const PREVIEW_ONLY = "Development build: preview only. Nothing is sent to nodes on this cluster.";

/**
 * What the sheet is asked to do: an action on objects of one kind, as the window has them. `suspend`: suspend (true)
 * or resume; `on`: cordon (true) or uncordon; `run`: a drain running in main to re-attach to (M4).
 */
export type ActionDraft = { kind: ActionKind; type: ResourceType; objects: KubeObject[]; suspend?: boolean; on?: boolean; run?: string };

/** The sheet's own title for a draft, before main has reviewed it. */
export function sheetTitle(d: ActionDraft): string {
  const one = d.objects.length === 1 ? d.objects[0]!.metadata.name : `${d.objects.length} ${d.type.resource}`;
  switch (d.kind) {
    case "scale": return `Scale ${one}`;
    case "restart": return `Restart ${one}`;
    case "delete": return `Delete ${one}`;
    case "trigger": return `Run ${one} now`;
    case "suspend": return `${d.suspend ? "Suspend" : "Resume"} ${one}`;
    case "cordon": return `${d.on === false ? "Uncordon" : "Cordon"} ${one}`;
    case "drain": return `Drain ${one}`;
  }
}

/**
 * The sheet's heading: main's title once there is a review, so a bulk that left objects out says "Delete 5" above a
 * card of five, not the six selected (security review of part 3, L4); the draft's own title before.
 */
export const sheetHeading = (d: ActionDraft, review?: Pick<ActionReview, "title">): string => review?.title ?? sheetTitle(d);

/** The question each action's "Ask Claude first" sends (Landlens's own words). */
export const ACTION_ASKS: Record<ActionVerb, { label: string; question: string }> = {
  scale: { label: "Ask Claude first", question: "Is it safe to scale this to that many replicas now? Check autoscalers, disruption budgets and what depends on it. Answer yes or no first, then why." },
  restart: { label: "Ask Claude first", question: "Is it safe to restart this now? Check for a rollout in flight, disruption budgets and single replicas. Answer yes or no first, then why." },
  delete: { label: "Ask Claude first", question: "Is it safe to delete this? Check what depends on it, what recreates it, and what data goes with it. Answer yes or no first, then why." },
  trigger: { label: "Ask Claude first", question: "Is it safe to run this job now, outside its schedule? Check what it does and whether a run is already going. Answer yes or no first, then why." },
  suspend: { label: "Ask Claude first", question: "Is it safe to suspend this now? Check what stops running and what waits on it. Answer yes or no first, then why." },
  resume: { label: "Ask Claude first", question: "Is it safe to resume this now? Check what runs when it does and whether that is expected. Answer yes or no first, then why." },
  cordon: { label: "Ask Claude first", question: "Is it safe to cordon this node now? Check whether other nodes can take new pods and what would stay pending. Answer yes or no first, then why." },
  uncordon: { label: "Ask Claude first", question: "Is it safe to uncordon this node now? Check whether whatever it was cordoned for is over. Answer yes or no first, then why." },
  // The drain's own sheet asks with the plan as names, classes and counts (D154), not a diff.
  drain: { label: "Ask Claude", question: "Which blockers matter, and what is a safe order?" },
};

/** A verb as the sheet, the log and the asks name it. */
export const verbOf = (d: Pick<ActionDraft, "kind" | "suspend" | "on">): ActionVerb =>
  d.kind === "suspend" && !d.suspend ? "resume" : d.kind === "cordon" && d.on === false ? "uncordon" : d.kind;

export const isSecretType = (t: Pick<ResourceType, "group" | "resource">) => t.group === "" && t.resource === "secrets";

/** The actions an object of this kind has, in menu order (D146). Secrets get Delete only. */
export function actionsFor(t: ResourceType, o?: KubeObject): { kind: ActionKind; suspend?: boolean; on?: boolean; label: string }[] {
  if (isSecretType(t)) return actionFits("delete", t) ? [{ kind: "delete", label: "Delete…" }] : [];
  const out: { kind: ActionKind; suspend?: boolean; on?: boolean; label: string }[] = [];
  if (actionFits("scale", t)) out.push({ kind: "scale", label: "Scale…" });
  if (actionFits("restart", t)) out.push({ kind: "restart", label: "Restart" });
  if (actionFits("trigger", t)) out.push({ kind: "trigger", label: "Trigger now" });
  if (actionFits("suspend", t)) {
    const suspended = o?.spec?.suspend === true;
    out.push({ kind: "suspend", suspend: !suspended, label: suspended ? "Resume" : "Suspend" });
  }
  // A node (D149, D154): Cordon or Uncordon by its state, then Drain.
  if (actionFits("cordon", t)) {
    const cordoned = o?.spec?.unschedulable === true;
    out.push({ kind: "cordon", on: !cordoned, label: cordoned ? "Uncordon" : "Cordon" });
  }
  if (actionFits("drain", t)) out.push({ kind: "drain", label: "Drain…" });
  if (actionFits("delete", t)) out.push({ kind: "delete", label: "Delete…" });
  return out;
}

/** The RBAC check behind each action, for `cluster:access` (D146): the verb, and the resource it is on. */
export function accessFor(kind: ActionKind, t: ResourceType): { verb: string; group: string; resource: string; subresource?: string } {
  if (kind === "delete") return { verb: "delete", group: t.group, resource: t.resource };
  if (kind === "trigger") return { verb: "create", group: "batch", resource: "jobs" };
  // A drain cordons (patch nodes, the menu's Cordon checks that) and evicts pods in any namespace.
  if (kind === "drain") return { verb: "create", group: "", resource: "pods", subresource: "eviction" };
  return { verb: "patch", group: t.group, resource: t.resource };
}

/**
 * What "Ask Claude first" adds to the dock: main's title, main's facts and the scrubbed diff (`review.agent`), quoted
 * as data, and the question to send. Not offered when the review has no `agent` text (a Secret) or touches a Secret.
 */
export function askFirst(verb: ActionVerb, type: ResourceType, review: ActionReview, objects: KubeObject[] = []): { context: AskContext; question: string } | undefined {
  if (isSecretType(type) || review.agent === undefined || !review.title) return undefined;
  const facts = (review.facts ?? []).map((f: ActionFact) => `- ${f.text}`).join("\n");
  const text = `${review.title}\n${facts ? `What Landlens checked:\n${facts}\n` : ""}The cluster's dry run (live → after), scrubbed as your reads are:\n${review.agent}`;
  return {
    // Where the diff is from, so a session limited to some namespaces isn't sent it from others (L11).
    context: { label: `My action · ${verb}`, text, source: review.title, kind: "action", namespaces: [...new Set(objects.map((o) => (type.namespaced ? o.metadata.namespace ?? "" : "")))] },
    question: ACTION_ASKS[verb].question,
  };
}
