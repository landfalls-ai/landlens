// What a question was about, worked out in main from the prompt main is about to send (D129, D130), never from a flag
// the window sets: the quote heads quotes.ts writes ("A problem Landlens's doctor found (…)", "Log lines from Clickland
// I selected (…)", …), the doctor brief's own lines, and the objects attached as references. Text the person typed that
// looks like a head only changes an enum. Only names leave: a subject's kind, namespace and name, each checked by
// records.ts, and a problem's class from the closed set.
import { redactText } from "@landlens/kube/redact";
import { PROBLEM_CLASSES, type Ask } from "./records.js";

const HEADS: [RegExp, Ask][] = [
  [/^A problem Landlens's doctor found \(/m, "problem"],
  [/^Log lines from Clickland I selected \(|^Last log lines of [^\n]* from Clickland's history/m, "clickland-logs"],
  [/^Output of a Landflow run I chose \(/m, "landflow"],
  [/^(?:A Google Cloud resource \(|Google Cloud project: [a-z][a-z0-9-]{4,28}[a-z0-9]$)/m, "gcp"],
  [/^Log lines I selected \(/m, "logs"],
  [/^Terminal output I selected \(/m, "terminal"],
  [/^A change I am making \(/m, "edit"],
  // "Ask Claude first" on one of your actions (wave 8, D148): counted with the edits, a change you are about to make.
  [/^An action I'm about to take in Landlens \(/m, "edit"],
  [/^A Helm release, as Landlens read it/m, "helm"],
];

export type AskOf = { ask: Ask; subject?: { kind?: string; namespace?: string; name?: string }; problem?: string };

/**
 * The ask kind, the problem's class and subject (from the brief's "Severity:" and "Subject:" lines) or the first
 * attached object's. Values are only candidates: main keeps a brief's subject only if the doctor reports a problem
 * about it, and turnSpan checks each against its pattern or set.
 */
export function askOf(text: string, refs: { kind?: string; namespace?: string; name: string }[]): AskOf {
  const ask = HEADS.find(([re]) => re.test(text))?.[1] ?? (refs.length ? "object" : "none");
  if (ask === "problem") {
    const cls = /^Severity: (?:failing|to watch) \(([a-z]+), /m.exec(text)?.[1];
    const subj = /^Subject: ([A-Z][A-Za-z0-9]{0,62}) (?:([a-z0-9][-a-z0-9]{0,62})\/)?([a-z0-9][-a-z0-9.]{0,252})$/m.exec(text);
    return {
      ask,
      ...(cls && (PROBLEM_CLASSES as readonly string[]).includes(cls) ? { problem: cls } : {}),
      // A line typed or quoted into the prompt can say anything: a name holding a long hex run (a key, a digest) is no
      // object's (L1), and main keeps a subject only when the doctor's own report names it (telemetry.ts).
      ...(subj && !/[0-9a-fA-F]{32,}/.test(subj[0]) ? { subject: { kind: subj[1]!, ...(subj[2] ? { namespace: subj[2] } : {}), name: subj[3]! } } : {}),
    };
  }
  const ref = refs[0];
  return { ask, ...(ref ? { subject: { ...(ref.kind ? { kind: ref.kind } : {}), ...(ref.namespace ? { namespace: ref.namespace } : {}), name: ref.name } } : {}) };
}

/** A problem's title from a doctor brief ("Problem: orders-api is crash-looping"), for the brain's draft: one line. */
export function problemTitleOf(text: string): string | undefined {
  const t = /^Problem: ([^\n]{1,120})$/m.exec(text)?.[1]?.trim();
  // Nothing a scrub would change, and no long hex run (a key or digest with no prefix; review of part 5, M5).
  return t && /^[A-Za-z0-9][A-Za-z0-9 ._/:'()-]*$/.test(t) && redactText(t) === t && !/[0-9a-fA-F]{32,}/.test(t) ? t : undefined;
}
