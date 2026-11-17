// What a native block's rows can do (wave 10 part 3, D218): exactly the person's own hands from wave 8, handed down by
// the Views page from the Workspace. Nothing here acts: each opens Landlens's own drawer, menu or sheet, where the
// person reviews and applies as always, with their own access. The view's token is never used for any of it.
import type { RowRef, ViewTone } from "@landlens/contracts";

export type RowHands = {
  /** The row's object, in its drawer over the view (the IDE's own read, as you). */
  open(ref: RowRef): void;
  /** Wave 8's object menu for the row's object, at a point (right-click, ⋯, Shift+F10). */
  menu(ref: RowRef, at: { x: number; y: number }, tone?: ViewTone): void;
  /** A focused row's keys (rowKeys): L logs, S shell, E edit, ⌫ delete (a review first, never a delete on a key). */
  key(ref: RowRef, action: "logs" | "shell" | "edit" | "delete"): void;
  /** The object in the drawer (its refKey), shown selected. */
  selected?: string;
  /** Rows chosen by the person (refKeys), and a new choice from one block's checkboxes. */
  picked: ReadonlySet<string>;
  pick(refs: RowRef[]): void;
};
