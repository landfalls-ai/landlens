// A focused table row's keys (D146), with the security review of wave 8 part 1's L5: the single keys act only on the
// row itself and never on a repeat, so a Backspace typed or held in a field inside a row opens no delete review.
import { describe, expect, it } from "vitest";
import { rowKey } from "../src/renderer/src/rowKeys";

const key = (k: string, o: Partial<Parameters<typeof rowKey>[0]> = {}) => rowKey({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, onRow: true, ...o });

describe("a row's keys", () => {
  it("on the row: Enter opens, L S E act, ⌫ and Delete open a delete review, Shift+F10 the menu", () => {
    expect(["Enter", "l", "S", "e", "Backspace", "Delete"].map((k) => key(k))).toEqual(["select", "logs", "shell", "edit", "delete", "delete"]);
    expect(key("F10", { shiftKey: true })).toBe("menu");
    expect(key("Backspace", { metaKey: true })).toBeUndefined();
  });

  it("L5: Backspace in a field inside a row, or held down, does nothing", () => {
    expect(key("Backspace", { onRow: false })).toBeUndefined();
    expect(key("Delete", { onRow: false })).toBeUndefined();
    expect(key("Backspace", { repeat: true })).toBeUndefined();
    expect(key("l", { onRow: false })).toBeUndefined();
    expect(key("Enter", { onRow: false })).toBeUndefined();
  });
});
