// The ⌘K palette's rules (D44): which actions fit a kind, how a name matches, and what a query's first word means.
import type { SearchEntry } from "@landlens/contracts";
import { ArrowRightLeft, Pencil, ScrollText, Sparkles, SquareTerminal, type LucideIcon } from "lucide-react";

export type Verb = "logs" | "shell" | "forward" | "edit" | "ask";
/** An object the palette can act on: its kind and name (D45), nothing of its content. */
export type Target = SearchEntry;


export const VERBS: Record<Verb, { label: (name: string) => string; icon: LucideIcon; kinds?: string[] }> = {
  logs: { label: (n) => `Logs of ${n}`, icon: ScrollText, kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"] },
  shell: { label: (n) => `Open shell in ${n}`, icon: SquareTerminal, kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"] },
  forward: { label: (n) => `Forward a port of ${n}`, icon: ArrowRightLeft, kinds: ["Pod", "Service"] },
  edit: { label: (n) => `Edit ${n}`, icon: Pencil },
  ask: { label: (n) => `Ask Claude about ${n}`, icon: Sparkles },
};
const VERB_ORDER: Verb[] = ["logs", "shell", "forward", "edit", "ask"];
export const verbsFor = (t: Pick<Target, "kind" | "group" | "resource">): Verb[] =>
  VERB_ORDER.filter((v) => (v !== "edit" || !(t.group === "" && t.resource === "secrets")) && (!VERBS[v].kinds || VERBS[v].kinds!.includes(t.kind)));

/** How well `name` answers `q`: 0 starts with it, 1 contains it, 2 has its letters in order; undefined, no match. */
export function score(name: string, q: string): number | undefined {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 2 : undefined;
}

/** Splits a query into a verb (its first word) and the rest. */
export function parseQuery(raw: string): { verb?: Verb; text: string; commands: boolean } {
  const q = raw.trimStart();
  if (q.startsWith(">")) return { text: q.slice(1).trim().toLowerCase(), commands: true };
  const m = /^(logs|shell|forward|edit|ask)(?:\s+|$)(.*)$/i.exec(q);
  if (m) return { verb: m[1]!.toLowerCase() as Verb, text: m[2]!.trim().toLowerCase(), commands: false };
  return { text: q.trim().toLowerCase(), commands: false };
}

