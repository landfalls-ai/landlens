// A review card's Apply and a bulk's left-out note (D27, D145, D156), with the security review of wave 8 part 3 (M4,
// L3, L4): folded operations count as capped, so the first press of Apply only unfolds; "2 of 3 can be deleted" with
// every refusal accounted for; the sheet's heading is main's title once there is a review. Each fails with its rule
// taken out.
import type { KubeObject } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { sheetHeading } from "../src/renderer/src/actionAsks";
import { applyStep, cardCapped, leftOutNote, OPEN_OPS, SHORT, type ApplyPress } from "../src/renderer/src/applyRules";

const press = (o: Partial<ApplyPress> = {}): ApplyPress => ({
  previewOnly: false, keyboard: false, repeating: false, shownFor: 5_000, capped: false, danger: false, confirmed: false, native: false, ...o,
});

describe("a review card's Apply", () => {
  it("M4: a bulk past three operations is folded, and folded counts as capped until unfolded", () => {
    const four = Array.from({ length: OPEN_OPS + 1 }, () => ({ lines: 3 }));
    expect(cardCapped(four, false, new Set())).toBe(true);
    expect(cardCapped(four, true, new Set())).toBe(false);
    expect(cardCapped(four.slice(0, OPEN_OPS), false, new Set())).toBe(false);
    // A long diff is capped until it is shown whole.
    expect(cardCapped([{ lines: SHORT + 1 }], false, new Set())).toBe(true);
    expect(cardCapped([{ lines: SHORT + 1 }], false, new Set([0]))).toBe(false);
  });

  it("M4: the first press on a folded card only unfolds; the next applies (or main's dialog asks)", () => {
    const four = Array.from({ length: 4 }, () => ({ lines: 3 }));
    expect(applyStep(press({ capped: cardCapped(four, false, new Set()), native: true }))).toBe("unfold");
    expect(applyStep(press({ capped: cardCapped(four, true, new Set([0, 1, 2, 3])), native: true }))).toBe("apply");
  });

  it("a keyboard press in the first half second or a held key does nothing; a danger asks twice unless main's dialog does", () => {
    expect(applyStep(press({ keyboard: true, shownFor: 100 }))).toBe("ignore");
    expect(applyStep(press({ keyboard: true, repeating: true }))).toBe("ignore");
    expect(applyStep(press({ shownFor: 100 }))).toBe("apply");
    expect(applyStep(press({ danger: true }))).toBe("confirm");
    expect(applyStep(press({ danger: true, confirmed: true }))).toBe("apply");
    expect(applyStep(press({ danger: true, native: true }))).toBe("apply");
    expect(applyStep(press({ previewOnly: true }))).toBe("ignore");
  });
});

describe("a bulk's left-out note", () => {
  it("M4: \"2 of 3 can be deleted.\" with the refusal on its own line", () => {
    expect(leftOutNote({ kept: 2, of: 3, verb: "deleted", messages: ["configmap a/b: refused 403"] })).toEqual({ head: "2 of 3 can be deleted.", lines: ["configmap a/b: refused 403"] });
  });

  it("L3: past twenty refusals, the rest are counted", () => {
    const messages = Array.from({ length: 30 }, (_, i) => `configmap a/c${i}: refused 403`);
    const n = leftOutNote({ kept: 20, of: 50, verb: "deleted", messages });
    expect(n.lines).toHaveLength(20);
    expect(n.more).toBe("And 10 more refused.");
    expect(n.lines.length + Number(/\d+/.exec(n.more!)![0])).toBe(30);
  });
});

describe("the action sheet's heading", () => {
  const cm = (n: number) => ({ metadata: { name: `c${n}`, namespace: "a", uid: `u${n}` } }) as KubeObject;
  const draft = { kind: "delete" as const, type: { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true, verbs: ["delete"] }, objects: [1, 2, 3, 4, 5, 6].map(cm) };

  it("L4: main's title once there is a review, so a bulk that left one out says five above a card of five", () => {
    expect(sheetHeading(draft)).toBe("Delete 6 configmaps");
    expect(sheetHeading(draft, { title: "Delete 5 configmaps in a" })).toBe("Delete 5 configmaps in a");
    expect(sheetHeading(draft, {})).toBe("Delete 6 configmaps");
  });
});
