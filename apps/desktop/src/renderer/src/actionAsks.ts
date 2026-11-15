// Your actions in the window (wave 8, D145–D148): which actions an object has, and "Ask Claude first" — a fixed
// question per action, sent with main's title, main's facts and main's scrubbed diff as one quoted context. Nothing is
// applied by asking, and the agent has no tool that presses Apply.
import type { ActionFact, ActionKind, ActionReview, KubeObject, ResourceType } from "@landlens/contracts";
import { actionFits } from "@landlens/kube/action-kinds";
import type { AskContext } from "./quotes";

export type ActionVerb = ActionKind | "resume";

/** What the sheet is asked to do: an action on objects of one kind, as the window has them. */
export type ActionDraft = { kind: ActionKind; type: ResourceType; objects: KubeObject[]; suspend?: boolean };

/** The question each action's "Ask Claude first" sends (Landlens's own words). */
export const ACTION_ASKS: Record<ActionVerb, { label: string; question: string }> = {
  scale: { label: "Ask Claude first", question: "Is it safe to scale this to that many replicas now? Check autoscalers, disruption budgets and what depends on it. Answer yes or no first, then why." },
  restart: { label: "Ask Claude first", question: "Is it safe to restart this now? Check for a rollout in flight, disruption budgets and single replicas. Answer yes or no first, then why." },
  delete: { label: "Ask Claude first", question: "Is it safe to delete this? Check what depends on it, what recreates it, and what data goes with it. Answer yes or no first, then why." },
  trigger: { label: "Ask Claude first", question: "Is it safe to run this job now, outside its schedule? Check what it does and whether a run is already going. Answer yes or no first, then why." },
  suspend: { label: "Ask Claude first", question: "Is it safe to suspend this now? Check what stops running and what waits on it. Answer yes or no first, then why." },
  resume: { label: "Ask Claude first", question: "Is it safe to resume this now? Check what runs when it does and whether that is expected. Answer yes or no first, then why." },
};

export const isSecretType = (t: Pick<ResourceType, "group" | "resource">) => t.group === "" && t.resource === "secrets";

/** The actions an object of this kind has, in menu order (D146). Secrets get Delete only. */
export function actionsFor(t: ResourceType, o?: KubeObject): { kind: ActionKind; suspend?: boolean; label: string }[] {
  if (isSecretType(t)) return actionFits("delete", t) ? [{ kind: "delete", label: "Delete…" }] : [];
  const out: { kind: ActionKind; suspend?: boolean; label: string }[] = [];
  if (actionFits("scale", t)) out.push({ kind: "scale", label: "Scale…" });
  if (actionFits("restart", t)) out.push({ kind: "restart", label: "Restart" });
  if (actionFits("trigger", t)) out.push({ kind: "trigger", label: "Trigger now" });
  if (actionFits("suspend", t)) {
    const suspended = o?.spec?.suspend === true;
    out.push({ kind: "suspend", suspend: !suspended, label: suspended ? "Resume" : "Suspend" });
  }
  if (actionFits("delete", t)) out.push({ kind: "delete", label: "Delete…" });
  return out;
}

/** The RBAC check behind each action, for `cluster:access` (D146): the verb, and the resource it is on. */
export function accessFor(kind: ActionKind, t: ResourceType): { verb: string; group: string; resource: string } {
  if (kind === "delete") return { verb: "delete", group: t.group, resource: t.resource };
  if (kind === "trigger") return { verb: "create", group: "batch", resource: "jobs" };
  return { verb: "patch", group: t.group, resource: t.resource };
}

/**
 * What "Ask Claude first" adds to the dock: main's title, main's facts and the scrubbed diff (`review.agent`), quoted
 * as data, and the question to send. Not offered when the review has no `agent` text (a Secret) or touches a Secret.
 */
export function askFirst(verb: ActionVerb, type: ResourceType, review: ActionReview): { context: AskContext; question: string } | undefined {
  if (isSecretType(type) || review.agent === undefined || !review.title) return undefined;
  const facts = (review.facts ?? []).map((f: ActionFact) => `- ${f.text}`).join("\n");
  const text = `${review.title}\n${facts ? `What Landlens checked:\n${facts}\n` : ""}The cluster's dry run (live → after), scrubbed as your reads are:\n${review.agent}`;
  return {
    context: { label: `My action · ${verb}`, text, source: review.title, kind: "action" },
    question: ACTION_ASKS[verb].question,
  };
}
