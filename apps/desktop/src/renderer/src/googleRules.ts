// What the "Google suggests" panel and the Cloud Monitoring alerts say (wave 9, D178, D188–D189), kept apart from the
// bridge so tests can read it: each severity's badge and word, a suggestion's meta line, the one command a sentence may
// offer to copy, an alert's lines, the sentences that keep a cut or failed read from reading as "none", and what Ask
// Claude sends for an alert or a suggestion.
import { GCP_ALERTS_READ, GCP_ALERTS_SHOWN, GKE_ADVICE_READ, type GcpAlert, type GcpClusterItem, type GcpClusterView, type GkeAdvice } from "@landlens/contracts";
import type { HeldAlert } from "./problemRules";
import type { AskContext } from "./quotes";

/** A severity as a badge: a tone and a word, never colour alone. */
export const SEVERITY_BADGE: Record<GkeAdvice["severity"], { tone: "bad" | "warn" | "muted"; word: string }> = {
  critical: { tone: "bad", word: "Critical" },
  high: { tone: "bad", word: "High" },
  medium: { tone: "warn", word: "Medium" },
  low: { tone: "muted", word: "Low" },
  unknown: { tone: "muted", word: "Unknown" },
};

/** "EXEC_PROBE_TIMEOUT" as "Exec probe timeout". */
export function subtypeWords(subtype: string): string {
  const w = subtype.toLowerCase().replace(/_/g, " ").trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : "Other";
}

/** "today", "yesterday", "2 days ago", from an ISO time; "" when it isn't one. */
export function daysAgo(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The line under a suggestion: "Deprecation · reliability · refreshed 2 days ago". */
export function adviceMeta(a: GkeAdvice, now: number): string {
  const when = daysAgo(a.refreshed, now);
  return [
    a.topic === "deprecation" ? "Deprecation" : subtypeWords(a.subtype),
    a.category === "unknown" ? "" : a.category,
    when ? `refreshed ${when}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * The command a fixed sentence names in backticks, when it is one Landlens offers to copy: turning an API on, or
 * signing in to gcloud. Any other text between backticks is shown, not offered.
 */
export function copyableCommand(sentence: string): string | undefined {
  for (const m of sentence.matchAll(/`([^`]{1,200})`/g)) {
    const c = m[1]!;
    if (/^gcloud services enable [a-z]+\.googleapis\.com --project [a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c) || c === "gcloud auth login") return c;
  }
  return undefined;
}

/** A fixed sentence as parts: plain text, and the commands it names in backticks (shown as code, still text). */
export function sentenceParts(sentence: string): { text: string; code: boolean }[] {
  return sentence.split("`").map((text, i) => ({ text, code: i % 2 === 1 })).filter((p) => p.text);
}

/** The all-clear, said only when Google's whole list was read and none of it is this cluster's. */
export const ALL_CLEAR = "Google has no suggestions for this cluster.";

/**
 * What the panel says besides its rows (review of part 1, M2): the all-clear only when nothing was cut; when Google had
 * more than Landlens reads, that sentence instead (in place of the all-clear, or under a partial list); else nothing.
 */
export function adviceLine(count: number, cut: boolean, where: { project: string; location: string }): { allClear: boolean; text: string } | undefined {
  if (cut) return { allClear: false, text: `Only the first ${GKE_ADVICE_READ.toLocaleString("en-US")} suggestions of ${where.project} in ${where.location} were read; this cluster may have more.` };
  return count ? undefined : { allClear: true, text: ALL_CLEAR };
}

/** The count beside the title: "3", "3+" when the list was cut, nothing for a cut list with none of this cluster's. */
export function adviceCount(count: number, cut: boolean): string | undefined {
  if (!cut) return String(count);
  return count ? `${count}+` : undefined;
}

/**
 * Calls `ask` and hands on only the latest call's answer (review of part 1, T6): a slow answer to an earlier call (the
 * previous cluster's, after a switch, or a read overtaken by Check again) never replaces a newer one, nor its error.
 */
export function latestOnly<A extends unknown[], T>(ask: (...a: A) => Promise<T>, on: { value: (v: T) => void; error: (e: unknown) => void }) {
  let seq = 0;
  return (...a: A): void => {
    const mine = ++seq;
    ask(...a).then(
      (v) => mine === seq && on.value(v),
      (e: unknown) => mine === seq && on.error(e),
    );
  };
}

// ---- Cloud Monitoring's alerts (wave 9 part 3, D188–D189) -----------------------------------------------------------

/** An alert's severity as a badge: a tone and a word; none for "none" (an unknown word is never guessed). */
export const ALERT_BADGE: Record<GcpAlert["severity"], { tone: "bad" | "warn"; word: string } | undefined> = {
  critical: { tone: "bad", word: "Critical" },
  error: { tone: "bad", word: "Error" },
  warning: { tone: "warn", word: "Warning" },
  none: undefined,
};

/** The policy's name as shown; an empty one is named for what it is. */
export const policyName = (a: GcpAlert) => a.policy || "Unnamed alert policy";

/** "Alert · Pod shop/orders-api-7c9f" (and its container), "Alert · Node gke-…", "Alert · Namespace monitoring", "Alert · cluster". */
export function alertSubjectLine(a: GcpAlert): string {
  const s = a.subject;
  if (!s) return a.resourceType === "k8s_cluster" ? "Alert · cluster" : `Alert · ${a.resourceType}`;
  if (s.kind === "Pod") return `Alert · Pod ${s.namespace}/${s.name}${s.container ? ` (${s.container})` : ""}`;
  return `Alert · ${s.kind} ${s.name}`;
}

/** How long an alert has been open: "42 min", "3 h", "2 days"; "" when the time isn't one. */
export function openFor(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(1, Math.floor((now - t) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

const n = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;

/** The view's alerts when it is a GKE cluster's and they were read; undefined otherwise. */
export const alertsOf = (v: GcpClusterView | undefined) => (v?.gke && !("error" in v.alerts) ? v.alerts : undefined);

/**
 * Whether this cluster's alert list may be missing some: a cut, an unreadable row, more than are shown, or open alerts
 * that don't say which project they are about (review of part 3, L1).
 */
export const alertsPartial = (v: GcpClusterView | undefined) => {
  const a = alertsOf(v);
  return !!a && (a.cut || a.unreadable > 0 || a.over > 0 || a.unplaced > 0);
};

/** Google's view of a cluster that may be GKE couldn't be read (review of part 3, M1): main's sentence, or none. */
export const viewUnread = (v: GcpClusterView | undefined) => (v && !v.gke && v.unread ? v.unread : undefined);

/**
 * What the Problems page's strip "Some checks were skipped" adds for Cloud Monitoring (D188): the read failed, Google had
 * more than the 1,000 read, rows couldn't be read, or this cluster has more than the 200 shown. Each keeps an empty
 * section from reading as "no alerts".
 */
export function alertNotes(v: GcpClusterView | undefined): string[] {
  const unread = viewUnread(v);
  if (unread) return [`Google's view of this cluster couldn't be read: ${unread}`];
  if (!v?.gke) return [];
  const p = v.cluster.project;
  if ("error" in v.alerts) return [`Cloud Monitoring's alerts for ${p} weren't read: ${v.alerts.error}`];
  const a = v.alerts;
  return [
    ...(a.cut ? [`Only the newest ${GCP_ALERTS_READ.toLocaleString("en-US")} alerts of ${p} were read; this cluster may have more open alerts.`] : []),
    ...(a.unreadable ? [`${n(a.unreadable, "alert")} in Cloud Monitoring's answer couldn't be read, so this list may be missing some.`] : []),
    ...(a.over ? [`Showing the newest ${GCP_ALERTS_SHOWN} of this cluster's open alerts; ${a.over.toLocaleString("en-US")} more aren't shown.`] : []),
    ...(a.unplaced ? [`${n(a.unplaced, "open alert")} in Cloud Monitoring's answer ${a.unplaced === 1 ? "doesn't" : "don't"} say which project or cluster ${a.unplaced === 1 ? "it is" : "they are"} about.`] : []),
  ];
}

/** Under the section: the project's open alerts that don't name this cluster, and this cluster's outside the chosen namespaces. */
export function alertOthers(v: GcpClusterView | undefined, outside: number): string[] {
  const a = alertsOf(v);
  if (!a || !v?.gke) return [];
  return [
    ...(outside ? [`${n(outside, "open alert")} of this cluster ${outside === 1 ? "is" : "are"} outside the chosen namespaces.`] : []),
    ...(a.others ? [`${n(a.others, "other open alert")} in ${v.cluster.project} ${a.others === 1 ? "doesn't" : "don't"} name this cluster.`] : []),
  ];
}

/** The all-clear for alerts: only when the whole answer was read and none of it is this cluster's. */
export const NO_ALERTS = "Cloud Monitoring has no open alerts for this cluster.";

/** The count beside "From Cloud Monitoring" and on the Alerts segment: "3", "3+" when the list may be missing some. */
export const alertCount = (shown: number, v: GcpClusterView | undefined) => `${shown}${alertsPartial(v) ? "+" : ""}`;

/**
 * The Overview's line under the Problems panel's head (D188): "2 open Cloud Monitoring alerts" (a link to Problems with
 * the Alerts segment), or why they couldn't all be read. Nothing when the whole answer was read and there are none.
 */
export function overviewAlerts(v: GcpClusterView | undefined): { text: string; tone: "warn" | "muted" } | undefined {
  if (!v?.gke) return viewUnread(v) ? { text: "Cloud Monitoring's open alerts couldn't be read", tone: "muted" } : undefined;
  if ("error" in v.alerts) return { text: "Cloud Monitoring's open alerts couldn't be read", tone: "muted" };
  const k = v.alerts.items.length;
  if (k) return { text: `${alertCount(k, v)} open Cloud Monitoring alert${k === 1 && !alertsPartial(v) ? "" : "s"}`, tone: "warn" };
  return alertsPartial(v) ? { text: "Cloud Monitoring's alerts were only partly read", tone: "muted" } : undefined;
}

/**
 * The Verdict's sub-line under "All clear" (D188), so it never stands alone above Google's open alerts or a failed read;
 * nor before the first answer for a context named as gcloud names a GKE cluster (`reading`, review of part 3, M1).
 */
export function verdictAlerts(v: GcpClusterView | undefined, reading = false): string | undefined {
  if (!v) return reading ? "Reading Cloud Monitoring's alerts…" : undefined;
  if (!v.gke) return viewUnread(v) ? "Cloud Monitoring's open alerts for this cluster couldn't be read." : undefined;
  if ("error" in v.alerts) return "Cloud Monitoring's open alerts for this cluster couldn't be read.";
  const k = v.alerts.items.length;
  if (k) return `Cloud Monitoring has ${alertCount(k, v)} open alert${k === 1 && !alertsPartial(v) ? "" : "s"} for this cluster.`;
  return alertsPartial(v) ? "Cloud Monitoring's alerts were only partly read; this cluster may have open alerts." : undefined;
}

/** The question Ask Claude sends with an alert (D189), Landlens's own words. */
export const ALERT_QUESTION = "Why is this Cloud Monitoring alert open, and is it a real problem in the cluster right now? Say what you checked.";
/** The question Ask Claude sends with a suggestion (D189). */
export const ADVICE_QUESTION = "What does this GKE recommendation mean for this cluster, and what is the smallest change that settles it? Say what you checked.";

/**
 * An alert as the dock's context (D189): main's brief as quoted text under the alert's fixed head, and a Pod subject as a
 * reference read with the session's token. `namespaces` is the subject's, or "" (cluster-scoped) for a node, the cluster
 * or no subject: a session limited to namespaces isn't sent a brief from outside them (wave 8's L11).
 */
export function alertContext(a: GcpAlert, brief: string): AskContext {
  const s = a.subject;
  const ns = s?.namespace;
  return {
    kind: "gcp-alert", label: `Alert: ${policyName(a).slice(0, 60)}`, text: brief,
    namespaces: [ns ?? ""],
    ...(s?.kind === "Pod" && ns ? { ref: { group: "", version: "v1", resource: "pods", name: s.name, namespace: ns } } : {}),
  };
}

/** A suggestion as the dock's context: main's brief under its fixed head. It is about the cluster, as D195's tools treat it. */
export function adviceContext(a: GkeAdvice, brief: string): AskContext {
  return { kind: "gcp-advice", label: `GKE: ${subtypeWords(a.subtype).slice(0, 60)}`, text: brief };
}

// ---- What the page holds when a read fails, and the alert drawer (review of part 3, M1, L4, L5, T2–T4) --------------

/** gcloud's name for a GKE cluster's context, `gke_<project>_<location>_<cluster>`: Google's view may be about it. */
export const gkeShaped = (context: string) => /^gke_[a-z][a-z0-9-]{4,28}[a-z0-9]_[a-z]+-[a-z]+\d+(-[a-z])?_[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/.test(context);

/**
 * What the page holds when gcp:cluster-view itself fails (review of part 3, M1): never the last answer, which would
 * stand with no time and no note. A cluster that was GKE, or whose view couldn't be read, or that has no answer yet and
 * is named as GKE clusters are, says Google's view couldn't be read; one known not to be GKE stays as it was.
 */
export function viewOnError(prev: GcpClusterView | undefined, message: string, shaped: boolean): GcpClusterView {
  if (prev?.gke || viewUnread(prev) || (!prev && shaped)) return { gke: false, unread: message || "Landlens couldn't ask for it." };
  return prev ?? { gke: false };
}

/**
 * The alerts the drawer's alert is checked against as Google's view is read again: the list read; none when the view
 * holds no list of this cluster's now (the alerts read failed, the view couldn't be read, the cluster is no longer a
 * chosen project's GKE cluster), so the drawer says it isn't among those read; undefined before any answer.
 */
export function alertsForDrawer(v: GcpClusterView | undefined): GcpAlert[] | undefined {
  if (!v) return undefined;
  return v.gke && !("error" in v.alerts) ? v.alerts.items : [];
}

/**
 * What the drawer says of an alert no longer in the view (T2): "closed" ("No longer open at …") only when the whole
 * answer was read and it isn't in it; "unread" ("Not among the alerts read since …": it may still be open) when the
 * list was partly read, failed, or Google's view couldn't be read; nothing while it is in the view.
 */
export function goneNote(held: HeldAlert, v: GcpClusterView | undefined): "closed" | "unread" | undefined {
  if (held.goneAt === undefined) return undefined;
  return v?.gke && !("error" in v.alerts) && !alertsPartial(v) ? "closed" : "unread";
}

/**
 * The brief Ask Claude in the drawer hands on (review of part 3, L4): the one it read, only while the alert is still
 * in the view and the brief was read for the view shown now (`viewAt`, the alerts' read time). Otherwise none, so main
 * is asked: its 404 when the alert is gone, a fresh brief when it is still open.
 */
export function briefToSend(held: HeldAlert, item: { id: string; at?: string; r?: GcpClusterItem } | undefined, viewAt: string | undefined): string | undefined {
  if (held.goneAt !== undefined || !item?.r || item.id !== held.id || !viewAt || item.at !== viewAt) return undefined;
  return item.r.brief;
}

/** The alerts' read time in the view, when they were read. */
export const alertsAt = (v: GcpClusterView | undefined) => alertsOf(v)?.at;

/** Why the drawer reads no policy for an alert (L5): another project's, or Landlens couldn't tell whose. */
export function policyNote(a: GcpAlert, project: string): string | undefined {
  if (a.policyId) return undefined;
  if (a.policyUnknown) return `Landlens couldn't read ${project}'s number, so it can't tell whether this policy is its own.`;
  return `This alert's policy isn't one of ${project}'s (it may be another project's in the same metrics scope), so Landlens doesn't read it.`;
}

/** How often Google's view is read again while the Overview or Problems is shown (main keeps it 60 s). */
export const VIEW_EVERY = 60_000;

/**
 * The view's poll (T4): nothing while the page isn't shown (`active`); else one read now and one every VIEW_EVERY
 * while the window is visible, never `fresh` (a fresh read is Check again's, at most once in 10 s in main). Returns
 * what stops it.
 */
export function startViewPoll(active: boolean, load: (fresh: boolean) => void, visible: () => boolean, timers: { every: (f: () => void, ms: number) => unknown; stop: (t: unknown) => void } = {
  every: (f, ms) => setInterval(f, ms),
  stop: (t) => clearInterval(t as ReturnType<typeof setInterval>),
}): (() => void) | undefined {
  if (!active) return undefined;
  load(false);
  const t = timers.every(() => visible() && load(false), VIEW_EVERY);
  return () => timers.stop(t);
}
