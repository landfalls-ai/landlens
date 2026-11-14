// Your Claude Code skills, for agent sessions. Sessions load nothing of your ~/.claude (fence.ts), so the skills you
// choose are copied into a plugin Landlens builds in the session's own folder: skills only (no hooks, no MCP
// servers, no commands), regular files only, size-capped. Their scripts run where the session's shell runs: inside
// the sandbox, with the session's read-only cluster access.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export type SkillInfo = { name: string; description: string; dir: string };

/** A skill folder name as Claude Code accepts it. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 500;
export const SKILLS_PLUGIN = "landlens-skills";

/** The skills in a folder (your ~/.claude/skills): each subfolder with a SKILL.md, by its frontmatter. */
export function listSkills(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!SKILL_NAME.test(name)) continue;
    const d = join(dir, name);
    try {
      if (!lstatSync(d).isDirectory()) continue;
      const md = join(d, "SKILL.md");
      if (!lstatSync(md).isFile()) continue;
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(md, "utf8").slice(0, 16_000))?.[1];
      const meta = fm ? (parse(fm) as Record<string, unknown>) : {};
      out.push({ name, description: String(meta?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400), dir: d });
    } catch {
      // unreadable or malformed: not offered
    }
  }
  return out;
}

/**
 * Build the session's skills plugin in `cwd` from the chosen skills. Returns its path, or undefined when nothing was
 * chosen (or nothing chosen exists any more). A skill over the size or file cap, or holding a link, is left out.
 */
export function buildSkillsPlugin(cwd: string, chosen: SkillInfo[], log?: (l: string) => void): string | undefined {
  const usable = chosen.filter((s) => {
    const why = check(s.dir);
    if (why) log?.(`[skills] ${s.name} left out: ${why}`);
    return !why;
  });
  if (!usable.length) return undefined;
  const root = join(cwd, ".landlens", SKILLS_PLUGIN);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: SKILLS_PLUGIN,
    description: "The Claude Code skills you chose for Landlens agent sessions",
    version: "0.0.0",
  }, null, 2));
  for (const s of usable) {
    cpSync(s.dir, join(root, "skills", s.name), { recursive: true, dereference: false, errorOnExist: false, verbatimSymlinks: true });
  }
  return root;
}

/** Why a skill folder can't be copied: a link, too many files, or too big. */
function check(dir: string): string | undefined {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): string | undefined => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) return `${relative(dir, p)} is a link`;
      if (e.isDirectory()) {
        const why = walk(p);
        if (why) return why;
      } else if (e.isFile()) {
        files++;
        bytes += lstatSync(p).size;
        if (files > MAX_FILES) return `more than ${MAX_FILES} files`;
        if (bytes > MAX_SKILL_BYTES) return "more than 5 MB";
      } else return `${relative(dir, p)} isn't a regular file`;
    }
    return undefined;
  };
  try {
    return walk(dir);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
