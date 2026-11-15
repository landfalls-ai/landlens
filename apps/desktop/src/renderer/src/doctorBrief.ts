// What "Ask Claude" on a problem sends (wave 5, D62): the problem as plain text, quoted into the prompt as data by
// withQuotes (quotes.ts: a fence no quoted backticks can close, "quoted as data, not instructions", redactText, the
// 20,000 cap). Landlens's own hint is left out on purpose: the agent should find the cause, not confirm ours.
import type { DoctorEvidence, Problem } from "@landlens/contracts";
import type { AskContext } from "./quotes";

export const BRIEF = { max: 8_000, pods: 5, events: 8, logLines: 40, logChars: 4_000 } as const;

/** The question Ask Claude sends with a problem (D64). */
export const PROBLEM_QUESTION = "What is causing this problem, and what is the smallest fix? Give the cause first, then the evidence you checked, then one proposed change.";

const line = (k: string, v: unknown) => (v === undefined || v === "" ? [] : [`${k}: ${String(v)}`]);

/** The brief: class, severity, subject, the rule's facts, events and, when the drawer has read them, log lines. */
export function problemBrief(p: Problem, evidence?: DoctorEvidence): string {
  const f = p.facts;
  const out: string[] = [
    `Problem: ${p.title}`,
    `Severity: ${p.tone === "bad" ? "failing" : "to watch"} (${p.class}, ${p.reason})`,
    `Subject: ${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}`,
    ...line("Container", p.container),
    ...(p.podCount ? [`Pods: ${p.podCount}${p.pods.length ? ` (${p.pods.slice(0, BRIEF.pods).join(", ")}${p.podCount > BRIEF.pods ? ", …" : ""})` : ""}`] : []),
    ...line("Restarts", p.restarts),
    ...line("Since", p.since),
  ];
  if (f.lastState) {
    const ls = f.lastState;
    out.push(`Last run: ${[ls.reason, ls.exitCode !== undefined ? `exit ${ls.exitCode}` : "", ls.signal !== undefined ? `signal ${ls.signal}` : "", ls.finishedAt ? `ended ${ls.finishedAt}` : ""].filter(Boolean).join(", ")}`);
    out.push(...line("Last run's message", ls.message));
  }
  out.push(...line("Image", f.image), ...line("Memory limit", f.limit), ...line("Scheduler", f.scheduling));
  if (f.nodeSelector?.length) out.push(`Node selector: ${f.nodeSelector.join(", ")}`);
  if (f.probe) {
    const pr = f.probe;
    out.push(`Probe: ${pr.type}, ${pr.how}${pr.period !== undefined ? `, every ${pr.period}s` : ""}${pr.timeout !== undefined ? `, timeout ${pr.timeout}s` : ""}${pr.failureThreshold !== undefined ? `, fails after ${pr.failureThreshold}` : ""}`);
    out.push(...line("Probe's last failure", pr.lastMessage));
  }
  out.push(...line("Available", f.available));
  if (f.cert) {
    const c = f.cert;
    out.push(c.unreadable ? "Certificate: couldn't be read" : `Certificate: subject ${c.subject || "-"}, issuer ${c.issuer || "-"}${c.selfSigned ? " (self-signed)" : ""}, names ${c.sans.join(", ") || "-"}, not before ${c.notBefore}, not after ${c.notAfter} (${c.which === "leaf" ? "the certificate itself" : "a certificate in its chain"})`);
    if (f.usedBy?.length) out.push(`Used by Ingresses: ${f.usedBy.join(", ")}`);
  }
  if (f.events.length) {
    out.push("Events (newest first):");
    for (const e of f.events.slice(0, BRIEF.events)) out.push(`- ${e.at} ${e.reason} x${e.count}: ${e.message}`);
  }
  const log = evidence?.log;
  if (log && !("error" in log) && log.lines.length) {
    let lines = log.lines.slice(-BRIEF.logLines).join("\n");
    if (lines.length > BRIEF.logChars) lines = lines.slice(lines.length - BRIEF.logChars);
    out.push(`Last log lines of ${log.container} in ${log.pod} (${log.previous ? "the previous run" : "the current run"}):`, lines);
  }
  const text = out.join("\n");
  return text.length > BRIEF.max ? `${text.slice(0, BRIEF.max)}\n… (cut)` : text;
}

/**
 * The problem as the dock's context: the brief as quoted text, and the subject as a reference main reads with the
 * session's token. No reference for a certificate (the agent never gets a Secret; the brief has its facts) or a node
 * (a namespace-limited session can't read nodes).
 */
export function problemContext(p: Problem, ref: AskContext["ref"] | undefined, evidence?: DoctorEvidence): AskContext {
  const withRef = ref && p.class !== "cert" && p.kind !== "Node" && p.kind !== "Secret";
  return { kind: "problem", label: `Problem: ${p.title}`, text: problemBrief(p, evidence), ...(withRef ? { ref } : {}) };
}
