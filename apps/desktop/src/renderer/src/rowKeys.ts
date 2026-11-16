// What a key on a focused table row does (D146), pure so a test can reach it. The single keys (L, S, E, ⌫) act only
// when the row itself has focus and the key isn't a repeat (security review of part 1, L5): a Backspace typed in a
// field inside a row (part 3's checkboxes, any inline field) or held down never opens a delete review.
// Part 3 (D156): `x` or Space toggles the row's checkbox, ⌘A (Ctrl+A) selects the rows the filter shows; both only
// where the table has a selection, and only with the row itself focused.
export type RowKey = "select" | "menu" | "logs" | "shell" | "edit" | "delete" | "toggle" | "all";

export function rowKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; onRow: boolean }): RowKey | undefined {
  if (e.key === "Enter") return e.onRow ? "select" : undefined;
  if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") return "menu";
  // ⌘A only on the row itself: a field inside a row keeps select-all-text (security review of part 3, L7).
  if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) return e.onRow ? "all" : undefined;
  if (!e.onRow || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return undefined;
  if (e.key === "l" || e.key === "L") return "logs";
  if (e.key === "s" || e.key === "S") return "shell";
  if (e.key === "e" || e.key === "E") return "edit";
  if (e.key === "x" || e.key === "X" || e.key === " ") return "toggle";
  // ⌫ or Delete opens the delete sheet: a review first, never a delete on a key.
  if (e.key === "Backspace" || e.key === "Delete") return "delete";
  return undefined;
}
