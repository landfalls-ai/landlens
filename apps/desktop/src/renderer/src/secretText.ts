// How a revealed Secret value is drawn (wave 8 part 4, D166): control and format characters (bidi overrides,
// zero-width, line and paragraph separators, escapes) are drawn as their escapes, so the eye isn't fooled; line breaks
// and tabs stay. Copy gives the exact bytes (from main), never this text.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function visibleValue(text: string): string {
  return text.replace(HIDDEN, (ch) => (ch === "\n" || ch === "\t" ? ch : `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`));
}

/** A key's size as main wrote it in the window's copy of the Secret (`<N bytes>`), else undefined. */
export function sizeOf(v: unknown): number | undefined {
  const m = typeof v === "string" ? /^<(\d{1,9}) bytes>$/.exec(v) : null;
  return m ? Number(m[1]) : undefined;
}

export const bytesText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);

/** "4:12": minutes and seconds left. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Days until a certificate's notAfter, and its tone by the doctor's thresholds (warn under 30, bad under 7 or past). */
export function expiry(notAfter: string, now: number): { days: number; tone: "ok" | "warn" | "bad"; text: string } {
  const ms = Date.parse(notAfter) - now;
  const days = Math.floor(ms / 86_400_000);
  const tone = ms <= 7 * 86_400_000 ? "bad" : ms <= 30 * 86_400_000 ? "warn" : "ok";
  const text = ms <= 0 ? `expired ${-days === 0 ? "today" : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`}` : days === 0 ? "expires today" : `expires in ${days} day${days === 1 ? "" : "s"}`;
  return { days, tone, text };
}
