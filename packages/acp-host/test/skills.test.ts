import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionOptions } from "../src/fence.js";
import { buildSkillsPlugin, listSkills, plainSkill } from "../src/skills.js";

function skillsDir() {
  const dir = mkdtempSync(join(tmpdir(), "landlens-skills-"));
  const skill = (name: string, description: string) => {
    mkdirSync(join(dir, name, "scripts"), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`);
    writeFileSync(join(dir, name, "scripts", "run.sh"), "echo hi\n");
  };
  skill("k8s-triage", "Triage a failing workload");
  skill("linked", "Has a link");
  symlinkSync("/etc/hosts", join(dir, "linked", "hosts"));
  mkdirSync(join(dir, "no-skill-md"));
  mkdirSync(join(dir, "Bad Name"));
  return dir;
}

describe("your skills in agent sessions", () => {
  it("keep only a name and description in SKILL.md's frontmatter: no hooks, tools or model of their own", () => {
    const md = "---\nname: x\ndescription: d\nallowed-tools: Bash(curl:*)\nhooks:\n  PreToolUse: [{command: evil}]\nmodel: opus\n---\nDo it.\n";
    const out = plainSkill(md, { name: "k8s-triage", description: "Triage: a workload" });
    expect(out).toBe('---\nname: k8s-triage\ndescription: "Triage: a workload"\n---\nDo it.\n');
    expect(plainSkill("No frontmatter.\n", { name: "a", description: "" })).toBe('---\nname: a\ndescription: ""\n---\nNo frontmatter.\n');
  });

  it("rebuilds the plugin from scratch: nothing left in its folder is kept", () => {
    const cwd = mkdtempSync(join(tmpdir(), "landlens-session-"));
    mkdirSync(join(cwd, ".landlens", "landlens-skills", "hooks"), { recursive: true });
    writeFileSync(join(cwd, ".landlens", "landlens-skills", "hooks", "hooks.json"), "{}");
    const root = buildSkillsPlugin(cwd, listSkills(skillsDir()).filter((s) => s.name === "k8s-triage"))!;
    expect(existsSync(join(root, "hooks"))).toBe(false);
    expect(readFileSync(join(root, "skills", "k8s-triage", "SKILL.md"), "utf8")).toMatch(/^---\nname: k8s-triage\ndescription: Triage a failing workload\n---\n/);
  });

  it("lists folders with a SKILL.md, by its frontmatter", () => {
    const skills = listSkills(skillsDir());
    expect(skills.map((s) => [s.name, s.description])).toEqual([["k8s-triage", "Triage a failing workload"], ["linked", "Has a link"]]);
  });

  it("copies only the chosen skills into a plugin in the session folder, leaving out any with links", () => {
    const skills = listSkills(skillsDir());
    const cwd = mkdtempSync(join(tmpdir(), "landlens-session-"));
    const logs: string[] = [];
    const root = buildSkillsPlugin(cwd, skills, (l) => logs.push(l))!;
    expect(root).toBe(join(cwd, ".landlens", "landlens-skills"));
    expect(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("landlens-skills");
    expect(readFileSync(join(root, "skills", "k8s-triage", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    expect(existsSync(join(root, "skills", "linked"))).toBe(false);
    expect(logs).toEqual(["[skills] linked left out: hosts is a link"]);
    expect(buildSkillsPlugin(mkdtempSync(join(tmpdir(), "x-")), [])).toBeUndefined();
  });

  it("gives a session the plugin and the Skill tool only when the plugin is inside its folder", () => {
    const base = { home: "/Users/me", cwd: "/tmp/s1", kubeconfig: "/tmp/s1/kubeconfig", token: "t".repeat(64), frontDoorPort: 1, path: "/usr/bin" };
    const none = sessionOptions(base);
    expect(none.tools).not.toContain("Skill");
    expect("plugins" in none).toBe(false);
    const withSkills = sessionOptions({ ...base, skillsPlugin: "/tmp/s1/.landlens/landlens-skills" });
    expect(withSkills.tools).toContain("Skill");
    expect(withSkills.plugins).toEqual([{ type: "local", path: "/tmp/s1/.landlens/landlens-skills" }]);
    expect(withSkills.settingSources).toEqual([]);
    const outside = sessionOptions({ ...base, skillsPlugin: "/Users/me/.claude/plugins/x" });
    expect(outside.tools).not.toContain("Skill");
  });
});
