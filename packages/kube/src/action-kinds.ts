// Which kinds each of your actions takes (wave 8, D141), with no Node imports: main builds from it and the window
// offers from it, so the menu and main agree.
import type { ActionKind } from "@landlens/contracts";

/** The kinds each action takes, as `resource.group` (core kinds have no group). Delete takes any kind that deletes. */
export const ACTION_KINDS: Record<Exclude<ActionKind, "delete">, readonly string[]> = {
  scale: ["deployments.apps", "statefulsets.apps", "replicasets.apps"],
  restart: ["deployments.apps", "statefulsets.apps", "daemonsets.apps"],
  trigger: ["cronjobs.batch"],
  suspend: ["cronjobs.batch", "jobs.batch"],
};
/** Kinds never deleted in bulk, and asked about in main's own dialog even alone (D141, D143). */
export const WIDE_DELETES: ReadonlySet<string> = new Set([
  "namespaces", "customresourcedefinitions.apiextensions.k8s.io", "nodes", "persistentvolumes", "apiservices.apiregistration.k8s.io",
]);
export const keyOf = (t: { group: string; resource: string }) => (t.group ? `${t.resource}.${t.group}` : t.resource);

/** Whether an action takes this kind (delete: whatever discovery says can be deleted). */
export function actionFits(kind: ActionKind, t: { group: string; resource: string; verbs?: string[] }): boolean {
  if (kind === "delete") return (t.verbs ?? []).includes("delete");
  return ACTION_KINDS[kind].includes(keyOf(t));
}
