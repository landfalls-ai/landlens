// What a press of a review card's Apply does, and the note on a bulk that left objects out (D27, D145, D156). Pure, so
// a test reaches each rule without a DOM (apps/desktop/test/apply-rules.test.ts); ReviewCard holds the state.

/** A diff longer than this is capped: shown whole before Apply can send it. */
export const SHORT = 40;
/** Several operations (a bulk action, D145, D156): the first three open, the rest folded to their head lines. */
export const OPEN_OPS = 3;

/**
 * Whether anything of the change is off screen: operations folded past the first three, or a long diff not shown
 * whole. Folded operations count as capped (security review of part 3, M4), so the whole change is on screen first.
 */
export function cardCapped(ops: readonly { lines: number }[], unfolded: boolean, uncapped: ReadonlySet<number>): boolean {
  const folded = ops.length > OPEN_OPS && !unfolded;
  return folded || ops.some((op, i) => op.lines > SHORT && !uncapped.has(i));
}

export type ApplyPress = {
  /** A development build's preview (D153): Apply is off. */
  previewOnly: boolean;
  /** A keyboard press (the click's `detail` is 0), not a pointer's. */
  keyboard: boolean;
  /** The key's keydown was a repeat (held down from the item that opened the card). */
  repeating: boolean;
  /** Milliseconds since the card was shown. */
  shownFor: number;
  capped: boolean;
  danger: boolean;
  /** The danger's first press was already made. */
  confirmed: boolean;
  /** Main asks in its own dialog (D143): that is the second step, not the card's. */
  native: boolean;
};

/**
 * One press of Apply: ignored (a keyboard press in the first half second or a held key), the change unfolded and
 * uncapped first, a danger's second press asked for, or applied.
 */
export function applyStep(p: ApplyPress): "ignore" | "unfold" | "confirm" | "apply" {
  if (p.previewOnly) return "ignore";
  if (p.keyboard && (p.repeating || p.shownFor < 500)) return "ignore";
  if (p.capped) return "unfold";
  if (p.danger && !p.confirmed && !p.native) return "confirm";
  return "apply";
}

/** The most refusals a left-out note lists one by one. */
export const LEFT_OUT_LINES = 20;

/**
 * A bulk review that left objects out (D156): "2 of 3 can be deleted.", each refusal on its own line (at most 20), and
 * the rest counted, so every object left out is accounted for (security review of part 3, L3).
 */
export function leftOutNote(l: { kept: number; of: number; verb: string; messages: readonly string[] }): { head: string; lines: string[]; more?: string } {
  const rest = l.messages.length - LEFT_OUT_LINES;
  return {
    head: `${l.kept} of ${l.of} can be ${l.verb}.`,
    lines: l.messages.slice(0, LEFT_OUT_LINES),
    ...(rest > 0 ? { more: `And ${rest} more refused.` } : {}),
  };
}
