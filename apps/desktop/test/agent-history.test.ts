import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHistory, AgentSettings } from "../src/main/agent-history";

describe("the agent session history", () => {
  it("names a session by its first prompt, counts changes, keeps the folder in main, and survives a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "landlens-h-")), "agent-history.json");
    let t = Date.parse("2026-11-15T00:00:00Z");
    const h = new AgentHistory(file, () => t);
    h.started({ session: "s1", agent: "Claude Code", context: "orbstack", cwd: "/x/1-aaaaaaaa" });
    t += 1000;
    h.started({ session: "s2", agent: "Claude Code", context: "other", cwd: "/x/2-bbbbbbbb" });
    t += 1000;
    h.prompted("s1", "Why is   this pod\ncrashlooping?");
    h.prompted("s1", "and now?");
    h.changed("s1", "applied");
    h.changed("s1", "rejected");
    const again = new AgentHistory(file);
    expect(again.list("orbstack")).toEqual([expect.objectContaining({ session: "s1", title: "Why is this pod crashlooping?", prompts: 2, applied: 1, rejected: 1 })]);
    expect(again.list()[0]!.session).toBe("s1"); // newest activity first
    expect(JSON.stringify(again.list())).not.toContain("/x/");
    expect(again.get("s2")!.cwd).toBe("/x/2-bbbbbbbb");
    again.forget("s2");
    expect(new AgentHistory(file).list().map((e) => e.session)).toEqual(["s1"]);
  });

  it("keeps the chosen skills, sorted and unique", () => {
    const file = join(mkdtempSync(join(tmpdir(), "landlens-s-")), "agent-settings.json");
    new AgentSettings(file).setSkills(["b", "a", "b"]);
    expect(new AgentSettings(file).skills()).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ skills: ["a", "b"] });
  });
});
