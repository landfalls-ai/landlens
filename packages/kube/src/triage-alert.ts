// What Landlens sends to Landflow about a problem or an object (docs/family.md#landflow-on-a-resource, wave 7 D120,
// D125). Pure: main calls these with the problem from the doctor's current report, the cluster's name and the person's
// choices (a severity, whether to add log lines or the object's YAML); nothing here takes text from the window.
//
// The alert is Landflow's Generic shape (plugins/triage/src/lib/alert.ts `fromGeneric`: title, severity, service, id,
// description, status, environment, labels), which Normalize Alert's `auto` reads when no known format matches; none
// of its matchers (an `alerts` list, AlarmName, `data`/`culprit`, `rule`, `alert`, Datadog's alert_*) is in it. With
// today's triage flow the dedup key is a hash of source, title and service, so a second send of one problem attaches
// to the room the first opened.
import type { FlowInput, Problem, TriageAlert, TriageSeverity } from "@landlens/contracts";
import { redactText, scrubCut } from "./redact.js";

export const TRIAGE = { description: 4_000, logLines: 40, logChars: 2_000, events: 8, pods: 5, yaml: 32 * 1024 } as const;

/** The severity a sheet starts at (D120): failing is sev2, to watch is sev3; the person picks. */
export const defaultSeverity = (p: Pick<Problem, "tone">): TriageSeverity => (p.tone === "bad" ? "sev2" : "sev3");

/** A name as it may go into an alert: one line, printable, at most 100 characters. */
export function alertName(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "unnamed";
}

const line = (k: string, v: unknown) => (v === undefined || v === "" ? [] : [`${k}: ${String(v)}`]);

/**
 * The problem's facts and events as lines, as Ask Claude's brief has them (doctorBrief.ts) but never its log lines and
 * never Landlens's own hint: the triage flow decides.
 */
export function problemFacts(p: Problem): string[] {
  const f = p.facts;
  const out: string[] = [
    `Subject: ${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}`,
    ...line("Container", p.container),
    ...(p.podCount ? [`Pods: ${p.podCount}${p.pods.length ? ` (${p.pods.slice(0, TRIAGE.pods).join(", ")}${p.podCount > TRIAGE.pods ? ", …" : ""})` : ""}`] : []),
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
    out.push(`Probe: ${pr.type}, ${pr.how}`);
    out.push(...line("Probe's last failure", pr.lastMessage));
  }
  out.push(...line("Available", f.available));
  if (f.cert) out.push(f.cert.unreadable ? "Certificate: couldn't be read" : `Certificate: subject ${f.cert.subject || "-"}, not after ${f.cert.notAfter}`);
  if (f.events.length) {
    out.push("Events (newest first):");
    for (const e of f.events.slice(0, TRIAGE.events)) out.push(`- ${e.at} ${e.reason} x${e.count}: ${e.message}`);
  }
  return out;
}

/** Log lines the person ticked, as they go in: the last 40, each scrubbed, at most 2,000 characters together. */
export type AlertLogs = { container: string; pod: string; lines: string[]; source?: "clickland" };

/**
 * The alert for a problem (D120). `cluster` is the cluster's name (the kubeconfig context); `logs` only when the person
 * ticked "Include the last 40 log lines". The description is the problem's one-line detail and its facts, then the log
 * lines, every part through redactText, at most 4,000 characters (the facts are cut first, the lines kept).
 */
export function alertFor(p: Problem, cluster: string, choices: { severity: TriageSeverity; logs?: AlertLogs }): TriageAlert {
  const env = alertName(cluster);
  const kind = alertName(p.kind);
  const name = alertName(p.name);
  const ns = p.namespace ? alertName(p.namespace) : undefined;
  const id = `landlens:${env}:${ns ? `${ns}/` : ""}${kind}/${name}:${p.class}`;
  let tail = "";
  if (choices.logs?.lines.length) {
    const l = choices.logs;
    // Scrubbed whole, then cut from the start (security review of part 3, M1): a private key logged across lines is
    // taken whole, and a key the 40-line window opened or closed without its other end is taken too.
    const text = scrubCut(l.lines.slice(-TRIAGE.logLines).join("\n"), TRIAGE.logChars, true).text;
    tail = `\nLast log lines of ${alertName(l.container)} in ${alertName(l.pod)}${l.source === "clickland" ? " (from Clickland's history)" : ""}:\n${text}`;
  }
  const head = redactText([p.detail, ...problemFacts(p)].join("\n"));
  const room = TRIAGE.description - tail.length;
  const description = (head.length > room ? `${head.slice(0, Math.max(0, room - 8))}\n… (cut)` : head) + tail;
  return {
    source: "landlens",
    title: alertName(p.title),
    severity: choices.severity,
    service: name,
    environment: env,
    status: "firing",
    id,
    fingerprint: id,
    description: description.slice(0, TRIAGE.description),
    labels: { cluster: env, ...(ns ? { namespace: ns } : {}), kind, name, class: p.class, reason: alertName(p.reason) },
    entity: { kind: kind.toLowerCase(), id: `${ns ? `${ns}/` : ""}${name}` },
  };
}

/**
 * A flow's input for an object (D125): names, the problem it was started from (class, reason, title), and the object's
 * YAML only when ticked, already redacted by the caller (redactObject: no Secret values, no env[].value), cut here at
 * 32 KiB.
 */
export function flowInput(o: { cluster: string; namespace?: string; kind: string; apiVersion: string; name: string; problem?: Pick<Problem, "class" | "reason" | "title">; yaml?: string }): FlowInput {
  return {
    landlens: 1,
    cluster: alertName(o.cluster),
    ...(o.namespace ? { namespace: alertName(o.namespace) } : {}),
    kind: alertName(o.kind),
    apiVersion: alertName(o.apiVersion),
    name: alertName(o.name),
    ...(o.problem ? { problem: { class: o.problem.class, reason: alertName(o.problem.reason), title: alertName(o.problem.title) } } : {}),
    ...(o.yaml !== undefined ? { yaml: o.yaml.length > TRIAGE.yaml ? `${o.yaml.slice(0, TRIAGE.yaml)}\n# … (cut at 32 KiB)` : o.yaml } : {}),
  };
}
