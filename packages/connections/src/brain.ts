// A session's summary for Landflow's brain (docs/family.md#a-sessions-summary-to-the-brain, wave 7 D134): one
// `work.session` event, drafted by rules from the session's own record, shown on a sheet, edited by the person and sent
// only on their click. This file is pure: the draft's rules, and the checks of Landflow's validateWorkEvent that
// Landlens mirrors (landflow packages/protocol/src/work-events.ts, origin/main 898d9099: WORK_LIMITS, one-line title,
// no path on the person's machine, a long title that reads like code). Landflow checks and redacts again.
import type { WorkDraft, WorkVisibility } from "@landlens/contracts";

/** Landflow's WORK_LIMITS, as far as Landlens sends fields. */
export const WORK_LIMITS = { source: 40, sourceId: 200, title: 200, summary: 500, hint: 120, count: 1_000_000, codeTitle: 80 } as const;

/** Whether free text holds a path on someone's machine (Landflow's containsMachinePath, copied). */
export const containsMachinePath = (text: string): boolean =>
  /(?:^|[\s"'`(=:@<[])(?:\/(?:Users|home|root|private|Volumes|mnt|var\/folders)\/|~\/|[A-Za-z]:\\|\\\\[A-Za-z0-9])/.test(text) || /file:\/\//i.test(text);

/** Text that reads like source code (Landflow's looksLikeCode, copied). */
export function looksLikeCode(text: string): boolean {
  if (/\r|\n/.test(text)) return true;
  const signs = [/[{}]/, /;\s*\S/, /=>/, /\(\s*\)/, /\b(?:function|const|let|var|import|return|class)\b\s*[\w({[]/].filter((p) => p.test(text)).length;
  return signs >= 2;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** The event's checks, as Landflow would answer them, in Landlens's words: the first problem, or undefined. */
export function checkWork(e: WorkDraft): string | undefined {
  if (e.kind !== "work.session" || e.source !== "landlens") return "Landlens sends only its own work.session events.";
  if (!e.sourceId || e.sourceId.length > WORK_LIMITS.sourceId) return "The session's id isn't one Landflow takes.";
  const title = e.title.trim();
  if (!title) return "Give it a title.";
  if (title.length > WORK_LIMITS.title) return `The title is at most ${WORK_LIMITS.title} characters.`;
  if (/[\r\n]/.test(title) || CONTROL.test(title)) return "The title is one line.";
  if (title.length > WORK_LIMITS.codeTitle && looksLikeCode(title)) return "The title reads like code. Describe the work in a line.";
  if (containsMachinePath(title)) return "The title holds a path on your machine. Describe the work without it.";
  if (e.summary.length > WORK_LIMITS.summary) return `The summary is at most ${WORK_LIMITS.summary} characters.`;
  if (CONTROL.test(e.summary)) return "The summary has a control character in it.";
  if (containsMachinePath(e.summary)) return "The summary holds a path on your machine. Describe the work without it.";
  for (const [k, v] of [["team", e.team], ["initiative", e.initiative]] as const) {
    if (v === undefined) continue;
    if (v.length > WORK_LIMITS.hint) return `The ${k} is at most ${WORK_LIMITS.hint} characters.`;
    if (/[\r\n]/.test(v) || CONTROL.test(v)) return `The ${k} is one line.`;
    if (containsMachinePath(v)) return `The ${k} holds a path on your machine.`;
  }
  if (!ISO.test(e.occurredAt) || !Number.isFinite(Date.parse(e.occurredAt))) return "The session's start isn't a time.";
  if (e.endedAt !== undefined && (!ISO.test(e.endedAt) || !Number.isFinite(Date.parse(e.endedAt)))) return "The session's end isn't a time.";
  if (!Number.isInteger(e.turns) || e.turns < 0 || e.turns > WORK_LIMITS.count) return "The number of turns isn't one Landflow takes.";
  if (!(["private", "team", "org"] as WorkVisibility[]).includes(e.visibility)) return "Visibility is private, team or org.";
  return undefined;
}

/** What main knows of a session, counted by main: never a prompt, an answer or a tool's arguments. */
export type SessionFacts = {
  session: string;
  /** The cluster's context name. */
  cluster: string;
  namespaces?: string[];
  /** The first problem the session was asked about (a doctor title: "orders-api is crash-looping"). */
  problem?: string;
  createdAt: string;
  updatedAt: string;
  questions: number;
  /** Gateway calls that ran, and of those the cluster reads (landlens-kube). */
  tools: number;
  reads: number;
  proposed: number;
  applied: number;
  rejected: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A context name fit for a title: one line of name characters, no path; else "a cluster". */
const clusterWords = (c: string) => (/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(c) && !containsMachinePath(c) ? c : "a cluster");

/** The facts as the sheet lists them. */
export function factLines(f: SessionFacts): string[] {
  return [
    plural(f.questions, "question"),
    `${plural(f.tools, "tool call")}, ${plural(f.reads, "cluster read")}`,
    f.proposed ? `${plural(f.proposed, "change")} proposed: ${f.applied} applied, ${f.rejected} rejected` : "no change proposed",
  ];
}

/** The rule-drafted event (D134): every field from the session's own record; private; no repo, areas, url or PRs. */
export function draftWork(f: SessionFacts): WorkDraft {
  const cluster = clusterWords(f.cluster);
  const ns = f.namespaces?.length === 1 ? f.namespaces[0] : undefined;
  const title = f.problem ? `Looked into ${f.problem} on ${cluster}` : ns ? `Worked on ${cluster}/${ns} with Claude` : `Worked on ${cluster} with Claude`;
  const changes = f.proposed ? `proposed ${plural(f.proposed, "change")}, ${f.applied} applied${f.rejected ? `, ${f.rejected} rejected` : ""}` : "no changes";
  const summary = `${plural(f.questions, "question")}; ${plural(f.tools, "tool call")} (${plural(f.reads, "cluster read")}); ${changes}.`;
  return {
    kind: "work.session", source: "landlens", sourceId: f.session, occurredAt: f.createdAt, endedAt: f.updatedAt,
    turns: f.questions, title: title.slice(0, WORK_LIMITS.title), summary: summary.slice(0, WORK_LIMITS.summary), visibility: "private",
  };
}
