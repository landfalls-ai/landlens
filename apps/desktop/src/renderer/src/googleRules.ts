// What the "Google suggests" panel says (wave 9, D178), kept apart from the bridge so tests can read it: each
// severity's badge and word, a suggestion's meta line, and the one command a sentence may offer to copy.
import type { GkeAdvice } from "@landlens/contracts";

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
