// The dock's width (wave 6): the default per window, the limits, and what a stored value may be.
import { describe, expect, it } from "vitest";
import { DOCK, dockMax, dockWidth, readDockWidth } from "../src/renderer/src/dockWidth";

describe("the dock's width", () => {
  it("defaults to 392px, or 360px in a narrow window", () => {
    expect(dockWidth(undefined, 1600, false, false)).toBe(DOCK.wide);
    expect(dockWidth(undefined, 1100, false, true)).toBe(DOCK.narrow);
  });

  it("keeps the rail and 600px of table, and the drawer beside it in a wide window", () => {
    expect(dockMax(1600, false, false)).toBe(1600 - 52 - 600);
    expect(dockMax(1600, true, false)).toBe(1600 - 52 - 600 - 372);
    // A narrow window's drawer floats over the table, so it takes no room.
    expect(dockMax(1200, true, true)).toBe(1200 - 52 - 600);
    expect(dockMax(4000, false, false)).toBe(DOCK.max);
    expect(dockMax(800, true, false)).toBe(DOCK.min);
  });

  it("holds what you chose between the minimum and the room there is", () => {
    expect(dockWidth(700, 1600, false, false)).toBe(700);
    expect(dockWidth(700, 1600, true, false)).toBe(1600 - 52 - 600 - 372);
    expect(dockWidth(100, 1600, false, false)).toBe(DOCK.min);
    expect(dockWidth(500.6, 1600, false, false)).toBe(501);
  });

  it("reads only a sane stored width", () => {
    expect(readDockWidth("480")).toBe(480);
    expect(readDockWidth(null)).toBeUndefined();
    for (const bad of ["", "abc", "12", "99999", "NaN", "Infinity"]) expect(readDockWidth(bad)).toBeUndefined();
  });
});
