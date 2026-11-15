import { describe, expect, it } from "vitest";
import { ansi, matcher, mergeRows, plain, tsKey, type Row } from "../src/renderer/src/logRows";

const row = (key: number, ts: string, pod = "a"): Row => ({ key, k: tsKey(ts), ts, text: `line ${key}`, pod });

describe("log rows", () => {
  it("sort RFC 3339 times with trimmed fractions in time order", () => {
    expect(tsKey("2026-11-15T10:00:00.12Z") < tsKey("2026-11-15T10:00:00.123Z")).toBe(true);
    expect(tsKey("2026-11-15T10:00:00Z") < tsKey("2026-11-15T10:00:00.000000001Z")).toBe(true);
    expect(tsKey("2026-11-15T10:00:00.5Z")).toBe("2026-11-15T10:00:00.500000000Z");
  });

  it("merge one pod's batch into another's lines by time", () => {
    const a = [row(1, "2026-11-15T10:00:01Z"), row(2, "2026-11-15T10:00:03Z"), row(3, "2026-11-15T10:00:05Z")];
    const b = [row(4, "2026-11-15T10:00:02Z", "b"), row(5, "2026-11-15T10:00:04Z", "b"), row(6, "2026-11-15T10:00:06Z", "b")];
    expect(mergeRows(a, b).map((r) => r.key)).toEqual([1, 4, 2, 5, 3, 6]);
    expect(mergeRows(a, [row(7, "2026-11-15T10:00:09Z")]).map((r) => r.key)).toEqual([1, 2, 3, 7]);
    expect(mergeRows([], b)).toEqual(b);
  });

  it("keep ANSI colours, bold and dim, and drop the rest", () => {
    expect(ansi("plain")).toEqual([{ text: "plain" }]);
    expect(ansi("\x1b[31mred\x1b[0m ok \x1b[1;92mbold green\x1b[0m\x1b[2K")).toEqual([
      { text: "red", cls: "a-red" }, { text: " ok " }, { text: "bold green", cls: "a-green a-b" },
    ]);
    expect(plain("\x1b[33mwarn\x1b[0m")).toBe("warn");
  });

  it("search plain text without regex syntax, and /…/ as a regex", () => {
    expect(matcher("a.b")!.test("axb")).toBe(false);
    expect(matcher("/a.b/")!.test("axb")).toBe(true);
    expect(matcher("/(/")).toBeUndefined();
    expect(matcher("")).toBeUndefined();
  });
});
