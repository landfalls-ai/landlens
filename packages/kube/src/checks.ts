// What the doctor couldn't check, in one sentence each (D56): the Problems page's strip and the end of the agent's
// cluster_overview. Pure, so the window imports it too (`@landlens/kube/checks`).
import type { DoctorCheck, DoctorCheckState } from "@landlens/contracts";

export const CHECK_SENTENCES: Record<Exclude<DoctorCheck, "pods">, string> = {
  certs: "Can't read Secrets here, so certificates aren't checked.",
  events: "Can't read events here, so failing probes and warning events aren't checked; pods that are running but not ready are still listed.",
  workloads: "Can't read Deployments, StatefulSets or DaemonSets here, so short workloads aren't checked.",
  nodes: "Can't read nodes here.",
};
const NOUNS: Record<DoctorCheck, string> = { pods: "pods", workloads: "Deployments, StatefulSets and DaemonSets", nodes: "nodes", events: "warning events", certs: "TLS Secrets" };
export function checkSentence(k: DoctorCheck, s: DoctorCheckState): string | undefined {
  if (s === "partial") return `Only part of the ${NOUNS[k]} could be read (a limit was reached or some reads failed), so some problems may be missing.`;
  if (s === "skipped") return k === "certs"
    ? "Certificates are read with the person's access only for what Landlens's window is showing (its namespace, or all of them), so they weren't checked here."
    : `The ${NOUNS[k]} weren't read for this.`;
  if (s === "pending") return `Still reading the ${NOUNS[k]}, so ${k === "certs" ? "certificates" : "they"} aren't checked yet.`;
  if (s === "error") return `Couldn't read the ${NOUNS[k]} just now, so they weren't checked this time.`;
  if (s === "forbidden" && k !== "pods") return CHECK_SENTENCES[k];
  return undefined;
}
export function missingChecks(checks: Partial<Record<DoctorCheck, DoctorCheckState>> | undefined): string[] {
  const out: string[] = [];
  for (const k of ["pods", "workloads", "events", "nodes", "certs"] as const) {
    const t = checks?.[k] ? checkSentence(k, checks[k]!) : undefined;
    if (t) out.push(t);
  }
  return out;
}
