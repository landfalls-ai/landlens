// The ⌘K palette's rules (D44): which actions fit a kind, how a name matches, and what a query's first word means.
import type { SearchEntry } from "@landlens/contracts";
import { ArrowRightLeft, CircleCheck, CircleSlash, LogOut, Pencil, Play, RotateCcw, Scale, ScrollText, Sparkles, SquareTerminal, Trash2, type LucideIcon } from "lucide-react";

export type Verb = "logs" | "shell" | "forward" | "edit" | "ask" | ActionVerb;
/** Your actions from ⌘K (wave 8, D146): each opens the action sheet; nothing is sent from the palette. */
export type ActionVerb = "scale" | "restart" | "trigger" | "cordon" | "uncordon" | "drain" | "delete";
export const ACTION_VERBS: readonly ActionVerb[] = ["scale", "restart", "trigger", "cordon", "uncordon", "drain", "delete"];
export const isActionVerb = (v: string | undefined): v is ActionVerb => (ACTION_VERBS as readonly string[]).includes(v ?? "");
/** An object the palette can act on: its kind and name (D45), nothing of its content. */
export type Target = SearchEntry;


export const VERBS: Record<Verb, { label: (name: string) => string; icon: LucideIcon; kinds?: string[] }> = {
  logs: { label: (n) => `Logs of ${n}`, icon: ScrollText, kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"] },
  shell: { label: (n) => `Open shell in ${n}`, icon: SquareTerminal, kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"] },
  forward: { label: (n) => `Forward a port of ${n}`, icon: ArrowRightLeft, kinds: ["Pod", "Service"] },
  edit: { label: (n) => `Edit ${n}`, icon: Pencil },
  ask: { label: (n) => `Ask Claude about ${n}`, icon: Sparkles },
  scale: { label: (n) => `Scale ${n}…`, icon: Scale, kinds: ["Deployment", "StatefulSet", "ReplicaSet"] },
  restart: { label: (n) => `Restart ${n}`, icon: RotateCcw, kinds: ["Deployment", "StatefulSet", "DaemonSet"] },
  trigger: { label: (n) => `Run ${n} now`, icon: Play, kinds: ["CronJob"] },
  // Nodes (wave 8 part 2, D154): each opens the sheet on its review; Drain's is a preview.
  cordon: { label: (n) => `Cordon ${n}`, icon: CircleSlash, kinds: ["Node"] },
  uncordon: { label: (n) => `Uncordon ${n}`, icon: CircleCheck, kinds: ["Node"] },
  drain: { label: (n) => `Drain ${n}…`, icon: LogOut, kinds: ["Node"] },
  delete: { label: (n) => `Delete ${n}…`, icon: Trash2 },
};
/** Delete last: never the first row an object offers (D146). */
const VERB_ORDER: Verb[] = ["logs", "shell", "forward", "edit", "scale", "restart", "trigger", "cordon", "uncordon", "drain", "ask", "delete"];
/** Kinds whose group is not the one an action's kind table names are left out (a CRD named Deployment). */
const GROUP_OF: Partial<Record<Verb, string>> = { scale: "apps", restart: "apps", trigger: "batch", cordon: "", uncordon: "", drain: "" };
export const verbsFor = (t: Pick<Target, "kind" | "group" | "resource">): Verb[] =>
  VERB_ORDER.filter((v) => (v !== "edit" || !(t.group === "" && t.resource === "secrets")) && (!VERBS[v].kinds || VERBS[v].kinds!.includes(t.kind)) && (GROUP_OF[v] === undefined || GROUP_OF[v] === t.group));

/** How well `name` answers `q`: 0 starts with it, 1 contains it, 2 has its letters in order; undefined, no match. */
export function score(name: string, q: string): number | undefined {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 2 : undefined;
}

/** Splits a query into a verb (its first word) and the rest; a first word of `problems` searches only problems (D61). */
export function parseQuery(raw: string): { verb?: Verb; text: string; commands: boolean; problems?: true } {
  const q = raw.trimStart();
  if (q.startsWith(">")) return { text: q.slice(1).trim().toLowerCase(), commands: true };
  const pm = /^problems(?:\s+|$)(.*)$/i.exec(q);
  if (pm) return { text: pm[1]!.trim().toLowerCase(), commands: false, problems: true };
  const m = /^(logs|shell|forward|edit|ask|scale|restart|trigger|cordon|uncordon|drain|delete)(?:\s+|$)(.*)$/i.exec(q);
  if (m) return { verb: m[1]!.toLowerCase() as Verb, text: m[2]!.trim().toLowerCase(), commands: false };
  return { text: q.trim().toLowerCase(), commands: false };
}

