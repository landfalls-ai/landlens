// The Problems page's rules (D58, D61): the class chips, the filters, the two sections, which problems have logs, and
// how ⌘K matches a problem. Pure, so apps/desktop/test/problems.test.ts runs them without a window.
import type { Problem, ProblemClass } from "@landlens/contracts";
import { score } from "./paletteRules";

/** Chip labels, in the doctor's order (packages/kube/src/doctor.ts). */
export const CLASS_LABEL: Record<ProblemClass, string> = {
  oom: "Out of memory",
  probe: "Probes",
  crashloop: "Crash loops",
  image: "Images",
  config: "Config",
  start: "Start failures",
  pending: "Pending",
  notready: "Not ready",
  restarts: "Restarts",
  unavailable: "Short workloads",
  node: "Nodes",
  warning: "Warnings",
  cert: "Certificates",
};
const CLASS_ORDER = Object.keys(CLASS_LABEL) as ProblemClass[];

export type Severity = "all" | "bad" | "warn";
export type ProblemFilter = { severity: Severity; cls?: ProblemClass; text: string };

const subjectText = (p: Problem) => `${p.title} ${p.kind} ${p.namespace ?? ""} ${p.name}`.toLowerCase();

/** Severity, then a class, then text over title, kind, namespace and name. The order is the doctor's (worst first). */
export function filterProblems(ps: Problem[], f: ProblemFilter): Problem[] {
  const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return ps.filter((p) =>
    (f.severity === "all" || p.tone === f.severity) &&
    (!f.cls || p.class === f.cls) &&
    words.every((w) => subjectText(p).includes(w)));
}

/** The chips: each class with a count over 0, after the severity filter, in the doctor's order. */
export function classCounts(ps: Problem[], severity: Severity): { cls: ProblemClass; label: string; n: number }[] {
  const n = new Map<ProblemClass, number>();
  for (const p of ps) if (severity === "all" || p.tone === severity) n.set(p.class, (n.get(p.class) ?? 0) + 1);
  return CLASS_ORDER.filter((c) => n.get(c)).map((c) => ({ cls: c, label: CLASS_LABEL[c], n: n.get(c)! }));
}

/** "Failing" then "To watch", each keeping the doctor's order; empty sections are left out. */
export function sections(ps: Problem[]): { tone: "bad" | "warn"; label: string; items: Problem[] }[] {
  const out = [
    { tone: "bad" as const, label: "Failing", items: ps.filter((p) => p.tone === "bad") },
    { tone: "warn" as const, label: "To watch", items: ps.filter((p) => p.tone === "warn") },
  ];
  return out.filter((s) => s.items.length);
}

/** Main gives logs for these (apps/desktop/src/main/doctor.ts, `evidence`): a run that ended or was killed. */
export function hasLogs(p: Problem): boolean {
  return p.class === "crashloop" || p.class === "oom" || p.class === "start" || p.class === "restarts" ||
    (p.class === "probe" && p.facts.probe?.type !== "readiness");
}

/** "Deployment landlens-dev/cart-api". */
export const subjectOf = (p: Pick<Problem, "kind" | "namespace" | "name">) => `${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}`;

/** ⌘K (D61): problems whose title or name matches, best first; with no text, the worst `max`. */
export function matchProblems(ps: Problem[], text: string, max: number): Problem[] {
  const q = text.trim().toLowerCase();
  if (!q) return ps.slice(0, max);
  return ps
    .map((p, i) => ({ p, i, s: Math.min(score(p.name, q) ?? 9, score(p.title, q) ?? 9, (p.namespace ? score(`${p.namespace}/${p.name}`, q) : undefined) ?? 9) }))
    .filter((r) => r.s < 9)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, max)
    .map((r) => r.p);
}

/**
 * The problem the drawer shows, kept when its id leaves the report (D59): `goneAt` is when it was first missing, and
 * clears if it comes back.
 */
export type HeldProblem = { id: string; last: Problem; goneAt?: number };
export function holdProblem(held: HeldProblem | undefined, ps: Problem[] | undefined, now: number): HeldProblem | undefined {
  if (!held || !ps) return held;
  const p = ps.find((x) => x.id === held.id);
  if (p) return p === held.last && !held.goneAt ? held : { id: p.id, last: p };
  return held.goneAt ? held : { ...held, goneAt: now };
}

/** The badge a sidebar item shows: failures in red, else warnings in amber. */
export type Badge = { tone: "bad" | "warn"; n: number };

/**
 * All problems, or those about one kind. For "Pod", every problem that has pods (D57): a Deployment's crash loop
 * also marks Pods, since that is where its pods are.
 */
export function badgeFor(problems: Problem[], kind?: Problem["kind"]): Badge | undefined {
  const mine = kind ? problems.filter((p) => p.kind === kind || (kind === "Pod" && p.podCount > 0)) : problems;
  const bad = mine.filter((p) => p.tone === "bad").length;
  if (bad) return { tone: "bad", n: bad };
  const warn = mine.length;
  return warn ? { tone: "warn", n: warn } : undefined;
}
