// The action log (wave 8, D147): rows only from logEntry's checked fields; the file 0600, the newest 500; a row with a
// field it doesn't know or a name that isn't one is dropped on read; a damaged file is moved aside.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_LOG_MAX, ActionLog, logEntry, serverHash } from "../src/main/action-log";

const base = { context: "orbstack", server: "https://127.0.0.1:26443", action: "scale" as const, kind: "Deployment", namespace: "landlens-dev", names: ["hands-web"], detail: "2 → 3 replicas", outcome: "applied" as const };

describe("the action log", () => {
  it("keeps checked rows in a 0600 file, newest first per context, at most 500", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-"));
    const path = join(dir, "actions.json");
    const log = new ActionLog(path);
    const e = log.add(logEntry(base));
    expect(e).toMatchObject({ who: "you", action: "scale", names: ["hands-web"], server: serverHash(base.server) });
    expect(e.server).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(e)).not.toContain("127.0.0.1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    log.add(logEntry({ ...base, context: "other" }));
    for (let i = 0; i < ACTION_LOG_MAX; i++) log.add(logEntry({ ...base, names: [`n${i}`] }));
    const again = new ActionLog(path);
    expect(again.list("orbstack", 200)).toHaveLength(200);
    expect(again.list("orbstack", 1)[0]!.names).toEqual([`n${ACTION_LOG_MAX - 1}`]);
    expect(again.list("other")).toEqual([]); // pushed out by the 500 newer rows
  });

  it("makes no row from a name that isn't one, a detail that isn't a closed form, or a word not on its list", () => {
    expect(() => logEntry({ ...base, names: ["has space"] })).toThrow();
    expect(() => logEntry({ ...base, names: ["a/b"] })).toThrow();
    expect(() => logEntry({ ...base, detail: "replicas set to 3 by LLMARK" })).toThrow();
    expect(() => logEntry({ ...base, kind: "deployment; rm -rf" })).toThrow();
    expect(() => logEntry({ ...base, action: "patch" as any })).toThrow();
    expect(() => logEntry({ ...base, outcome: "ok" as any })).toThrow();
    expect(() => logEntry({ ...base, names: [] })).toThrow();
    expect(() => logEntry({ ...base, context: "two\nlines" })).toThrow();
    expect(() => logEntry({ ...base, key: "pass word" })).toThrow();
    expect(logEntry({ ...base, detail: "5 of 6" }).detail).toBe("5 of 6");
  });

  it("drops a tampered row or one with an extra field, and moves a damaged file aside", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-"));
    const path = join(dir, "actions.json");
    const good = logEntry(base);
    writeFileSync(path, JSON.stringify({ version: 1, entries: [good, { ...good, id: "acAAAAAAAAAAAAAAAA", value: "LLMARK-secret" }, { ...good, id: "acBBBBBBBBBBBBBBBB", detail: "LLMARK" }] }));
    const log = new ActionLog(path);
    expect(log.list("orbstack")).toEqual([good]);
    writeFileSync(path, "{ not json");
    expect(new ActionLog(path).list("orbstack")).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("actions.json.damaged-"))).toBe(true);
    // A file with something else at its top is damaged too.
    writeFileSync(path, JSON.stringify({ version: 1, entries: [], extra: 1 }));
    expect(new ActionLog(path).list("orbstack")).toEqual([]);
    expect(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("actions.json.damaged-"))!), "utf8")).toBeTruthy();
  });
});
