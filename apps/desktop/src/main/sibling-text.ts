// Which text in a question came from a sibling, decided in main (security review of wave 7 part 3, M2). Main itself
// served Clickland's log lines to the window (clickland:logs, the doctor's fallback), so it remembers them, and when
// a question reaches AgentService.prompt it looks for them in it: a question that quotes any holds the session's
// GitHub and Linear autonomy, whatever head or flag the window gave the quote. The quote's head (CLICKLAND_QUOTE)
// still counts too; this is the rule that doesn't depend on the window. A Landflow flow's output (main/landflow.ts)
// is remembered the same way, whole and line by line, as Landflow's (security review of part 4, M4).
//
// What counts as found: a line's time as main sent it (`at`, an ISO time to the millisecond, which the History view
// writes before each picked line), or a body of at least 16 characters, both compared after the changes the window
// and withQuotes make on the way (escape sequences and control characters removed, bidi controls shown as marks, a
// run of more than 16 backticks cut to 16). A body that withQuotes cut to fit is found by its time. Main keeps the
// newest 20,000 of them, 4,000,000 characters at most.
import type { Sibling } from "@landlens/contracts";

/** The shortest body looked for on its own: shorter ones are found by their time. */
export const MIN_BODY = 16;
const MAX_ENTRIES = 20_000;
const MAX_CHARS = 4_000_000;

// The window's plain() (renderer/src/logRows.ts) and then some: every escape sequence, every control character (a
// body's own line breaks too), bidi controls and the marks plain() writes for them, long backtick runs as withQuotes.
// eslint-disable-next-line no-control-regex
const ESC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|\x1b/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|<U\+(?:061C|200E|200F|202[A-E]|206[6-9])>/g;
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;

export function normalized(s: string): string {
  return s.replace(ESC, "").replace(CONTROLS, "").replace(BIDI, "").replace(/`{17,}/g, "`".repeat(16));
}

/**
 * One store per kind of outside text: the siblings' (Sibling), and Google Cloud's ("gcp", review of wave 9 part 3, L3:
 * alert policies' text and Google's suggestions, which main served in Google's view).
 */
export class SiblingText<K extends string = Sibling> {
  /** Normalized body → its sibling, oldest first. */
  private readonly bodies = new Map<string, K>();
  /** Bodies by their first 16 characters, for one pass over a question. */
  private readonly byHead = new Map<string, Set<string>>();
  private readonly times = new Map<string, K>();
  private chars = 0;

  /** Text main is about to send the window: each row's time and body. */
  served(sibling: K, rows: { at?: string; body: string }[]) {
    for (const r of rows) {
      if (r.at) {
        this.times.delete(r.at);
        this.times.set(r.at, sibling);
      }
      const b = normalized(r.body).trim();
      if (b.length < MIN_BODY) continue;
      if (this.bodies.delete(b)) this.chars -= b.length;
      this.bodies.set(b, sibling);
      this.chars += b.length;
      const head = b.slice(0, MIN_BODY);
      let set = this.byHead.get(head);
      if (!set) this.byHead.set(head, (set = new Set()));
      set.add(b);
    }
    while (this.times.size > MAX_ENTRIES) this.times.delete(this.times.keys().next().value!);
    while (this.bodies.size > MAX_ENTRIES || this.chars > MAX_CHARS) {
      const [b] = this.bodies.keys();
      this.bodies.delete(b!);
      this.chars -= b!.length;
      const head = b!.slice(0, MIN_BODY);
      const set = this.byHead.get(head);
      set?.delete(b!);
      if (set && !set.size) this.byHead.delete(head);
    }
  }

  /** The siblings whose text the question quotes. */
  found(question: string): Set<K> {
    const out = new Set<K>();
    for (const m of question.matchAll(TIME)) {
      const s = this.times.get(m[0]);
      if (s) out.add(s);
    }
    const q = normalized(question);
    for (let i = 0; i + MIN_BODY <= q.length; i++) {
      const set = this.byHead.get(q.slice(i, i + MIN_BODY));
      if (!set) continue;
      for (const b of set) if (q.startsWith(b, i)) out.add(this.bodies.get(b)!);
    }
    return out;
  }
}
