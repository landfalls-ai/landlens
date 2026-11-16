// How a revealed value is drawn (wave 8 part 4, D166): control and format characters as escapes, sizes, the clock and
// a certificate's expiry by the doctor's thresholds.
import { describe, expect, it } from "vitest";
import { bytesText, clock, expiry, sizeOf, visibleValue } from "../src/renderer/src/secretText";

describe("visibleValue", () => {
  it("draws bidi overrides, zero-width and control characters as escapes; keeps line breaks and tabs", () => {
    expect(visibleValue("abc\u202Edef")).toBe("abc\\u{202E}def");
    expect(visibleValue("a\u200Bb\u0000c\u001Bd")).toBe("a\\u{200B}b\\u{0000}c\\u{001B}d");
    expect(visibleValue("line 1\nline 2\tx\r")).toBe("line 1\nline 2\tx\\u{000D}");
    expect(visibleValue("a\u2028b\uFEFF")).toBe("a\\u{2028}b\\u{FEFF}");
    expect(visibleValue("plain é ✓")).toBe("plain é ✓");
  });

  it("draws every space but the plain one, and trailing spaces, tabs and line breaks, as escapes (L3)", () => {
    // No-break, en, em, thin, narrow no-break and ideographic spaces look like a plain one or like nothing.
    expect(visibleValue("a\u00A0b\u2002c\u2003d\u2009e\u202Ff\u3000g h")).toBe("a\\u{00A0}b\\u{2002}c\\u{2003}d\\u{2009}e\\u{202F}f\\u{3000}g h");
    // Two values that differ only at the end don't look the same.
    expect(visibleValue("hunter22\n")).toBe("hunter22\\u{000A}");
    expect(visibleValue("hunter22 ")).toBe("hunter22\\u{0020}");
    expect(visibleValue("hunter22")).toBe("hunter22");
    expect(visibleValue("a\nb \t\n")).toBe("a\nb\\u{0020}\\u{0009}\\u{000A}");
  });
});

describe("sizes, the clock and expiry", () => {
  it("reads main's <N bytes> only", () => {
    expect(sizeOf("<40 bytes>")).toBe(40);
    expect(sizeOf("••••••")).toBeUndefined();
    expect(sizeOf("aGVsbG8=")).toBeUndefined();
    expect(bytesText(40)).toBe("40 B");
    expect(bytesText(2048)).toBe("2.0 KiB");
    expect(clock(252_000)).toBe("4:12");
    expect(clock(-5)).toBe("0:00");
  });
  it("ok past 30 days, warn under 30, bad under 7 and once expired", () => {
    const now = Date.parse("2026-11-16T00:00:00Z");
    expect(expiry("2027-01-30T00:00:00Z", now)).toMatchObject({ tone: "ok", text: "expires in 75 days" });
    expect(expiry("2026-11-28T00:00:00Z", now)).toMatchObject({ tone: "warn", text: "expires in 12 days" });
    expect(expiry("2026-11-20T00:00:00Z", now)).toMatchObject({ tone: "bad", text: "expires in 4 days" });
    expect(expiry("2026-11-10T00:00:00Z", now).tone).toBe("bad");
    expect(expiry("2026-11-10T00:00:00Z", now).text).toMatch(/^expired 6 days ago$/);
  });
});
