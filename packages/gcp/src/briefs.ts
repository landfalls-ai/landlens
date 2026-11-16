// What Ask Claude quotes for a Cloud Monitoring alert or a GKE suggestion (wave 9 part 3, D189), built in main and pure.
// At most 4,000 characters; every value of Google's (or of whoever wrote a policy, or called the API server) is one line:
// cleaned, redacted, cut, and in JSON quotes when it is free text. The first line is "Google Cloud project: <id>", which
// main's GCP_QUOTE reads to hold the session's GitHub and Linear autonomy before the question is sent. The dock then
// quotes the whole brief as data, in a fence its text can't close (quotes.ts withQuotes).
import type { GcpAlert, GkeAdvice } from "@landlens/contracts";
import { redactText } from "@landlens/kube/redact";
import { outsideText } from "./assets.js";
import type { AlertPolicyDetail } from "./monitoring.js";

export const ITEM_BRIEF_MAX = 4_000;
/** The cluster a brief is about: main's own answer (gkeOf), already held to GKE's shapes. */
export type BriefCluster = { project: string; location: string; name: string };

/** Free text as a quoted value: one line, cleaned, redacted, cut, then JSON-quoted (a `"` in it can't end the quote). */
const quoted = (s: string, max: number) => JSON.stringify(outsideText(s, max));
/** A short value of Google's (an id, a time, a type): one line, cleaned, redacted, cut. */
const word = (s: string, max: number) => outsideText(s, max);

const head = (c: BriefCluster) => [`Google Cloud project: ${word(c.project, 30)}`, `GKE cluster: ${word(c.name, 40)} (${word(c.location, 30)})`];
const finish = (lines: string[]) => redactText(lines.join("\n")).slice(0, ITEM_BRIEF_MAX);

/** An open alert, with its policy's conditions and documentation when they were read. */
export function alertBrief(c: BriefCluster, a: GcpAlert, policy?: AlertPolicyDetail): string {
  const s = a.subject;
  const where = !s ? ""
    : s.kind === "Pod" ? `  namespace ${word(s.namespace ?? "", 63)}  pod ${word(s.name, 253)}${s.container ? `  container ${word(s.container, 63)}` : ""}`
    : s.kind === "Node" ? `  node ${word(s.name, 253)}`
    : `  namespace ${word(s.name, 63)}`;
  const lines = [
    ...head(c),
    `Cloud Monitoring alert, open since ${word(a.opened, 40)}`,
    `Policy: ${quoted(a.policy || "Unnamed alert policy", 120)}   Severity: ${a.severity === "none" ? "none given" : a.severity}`,
    `Resource: ${word(a.resourceType, 40)}${where}`,
    ...(a.metric ? [`Metric: ${word(a.metric, 200)}`] : []),
  ];
  if (policy?.conditions.length) lines.push(`Conditions: ${policy.conditions.map((x) => quoted(x, 120)).join(", ")}`);
  if (policy?.documentation) {
    lines.push(`Policy documentation (written by whoever made the policy${policy.cut ? "; its first 300 characters" : ""}): ${quoted(policy.documentation, 300)}`);
  }
  return finish(lines);
}

/** A GKE suggestion: its subtype, severity, category, Google's description and recommendation, and an API deprecation's callers. */
export function adviceBrief(c: BriefCluster, a: GkeAdvice): string {
  const lines = [
    ...head(c),
    `GKE recommendation: ${word(a.subtype, 80)}`,
    `Severity: ${a.severity}   Category: ${a.category}${a.priority ? `   Priority: ${a.priority}` : ""}`,
    `Description: ${quoted(a.description, 300)}`,
    ...(a.action ? [`Recommended: ${quoted(a.action, 300)}`] : []),
    ...(a.refreshed ? [`Refreshed by Google: ${word(a.refreshed, 40)}`] : []),
  ];
  for (const x of (a.apis ?? []).slice(0, 10)) {
    lines.push(`API still called: ${quoted(x.api, 200)}${x.stops ? `  stops being served in ${quoted(x.stops, 20)}` : ""}`);
    for (const k of x.clients.slice(0, 5)) {
      const n = typeof k.requests === "number" && Number.isFinite(k.requests) ? ` ${k.requests} times in 30 days` : "";
      lines.push(`  called by ${quoted(k.agent, 120)}${n}${k.last ? `, last ${word(k.last, 40).slice(0, 10)}` : ""}`);
    }
  }
  return finish(lines);
}
