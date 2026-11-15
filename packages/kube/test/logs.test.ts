// The doctor's log evidence (wave 5, D60): the last lines of a run, read with a cap that keeps the end.
import { describe, expect, it } from "vitest";
import { logsGone, readLogTail } from "../src/logs.js";

const stream = (parts: string[], status = 200) => ({
  request: async () => new Response(new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  }), { status }),
});
const req = { namespace: "shop", pod: "api-1", container: "api", previous: true, tailLines: 200 };

describe("readLogTail", () => {
  // Security review of wave 7 part 3, M1: a line past 16 KiB is scrubbed before it is cut.
  it("scrubs a long line before cutting it at 16 KiB", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const r = await readLogTail(stream([`2026-11-15T11:59:00Z ${"x".repeat(16 * 1024 - 10)} ${token} and more\n`]), req, { maxBytes: 64 * 1024, timeoutMs: 1000 });
    expect(r.lines[0]).not.toContain("ghp_");
    expect(r.lines[0]).toContain("more characters)");
  });

  it("returns the lines without timestamps when they fit", async () => {
    const r = await readLogTail(stream(["2026-11-15T11:59:00Z one\n2026-11-15T11:59:01Z two\n"]), req, { maxBytes: 1024, timeoutMs: 1000 });
    expect(r).toEqual({ lines: ["one", "two"], cut: false });
  });

  it("keeps the last bytes, from a whole line, so a long trace keeps the crash (part 2 review, finding 5)", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `2026-11-15T11:59:00Z frame ${i}`);
    const text = lines.join("\n") + "\n2026-11-15T11:59:01Z FATAL: the crash itself\n";
    const parts = text.match(/[\s\S]{1,700}/g)!;
    const r = await readLogTail(stream(parts), req, { maxBytes: 2048, timeoutMs: 1000 });
    expect(r.cut).toBe(true);
    expect(r.lines.at(-1)).toBe("FATAL: the crash itself");
    expect(r.lines[0]).toMatch(/^frame \d+$/);
    expect(r.lines.join("\n").length).toBeLessThanOrEqual(2048);
  });

  it("stops at readBytes and drops the cut last line; keeps a single huge line in part", async () => {
    const r = await readLogTail(stream(["a\n".repeat(3000)]), req, { maxBytes: 1024, readBytes: 4096, timeoutMs: 1000 });
    expect(r.cut).toBe(true);
    expect(r.lines.every((l) => l === "a")).toBe(true);
    const huge = await readLogTail(stream(["x".repeat(10_000)]), req, { maxBytes: 1024, timeoutMs: 1000 });
    expect(huge.lines).toHaveLength(1);
    expect(huge.lines[0]!.startsWith("x")).toBe(true);
  });

  it("throws the API's status on a failed read", async () => {
    await expect(readLogTail(stream(['{"message":"previous terminated container not found"}'], 400), req, { maxBytes: 1024, timeoutMs: 1000 })).rejects.toMatchObject({ status: 400 });
  });

  it("knows the kubelet's sentence for a log that is gone, and only that", () => {
    expect(logsGone(["unable to retrieve container logs for docker://e17e841b0006ff836d32288a6b39ae30862e5e4f6f6391098ea8d8304a73c4df"])).toBe(true);
    expect(logsGone(["unable to retrieve container logs for containerd://abc123"])).toBe(true);
    expect(logsGone(["unable to retrieve container logs for docker://abc", "FATAL"])).toBe(false);
    expect(logsGone(["echo unable to retrieve container logs for docker://abc"])).toBe(false);
    expect(logsGone([])).toBe(false);
  });
});
