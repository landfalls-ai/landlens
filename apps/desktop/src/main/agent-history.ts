// What Landlens remembers about agent sessions, in two small files in its app data: the sessions you had (to list
// and resume them; Claude Code keeps the transcripts) and the skills you chose for new sessions. Neither holds a
// token: a resumed session gets new ones.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentHistoryEntry } from "@landlens/contracts";

const MAX_ENTRIES = 200;

/**
 * Kept in main only: the session's folder, the API server it ran against (a context name alone can repeat), and why
 * its autonomous writes were held, if they were (a resume holds them again; wave 7 part 2 review, M1).
 */
type Stored = AgentHistoryEntry & { cwd: string; server?: string; held?: string };

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export class AgentHistory {
  private entries: Stored[];

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    const loaded = readJson<{ sessions?: Stored[] }>(file, {}).sessions;
    this.entries = Array.isArray(loaded) ? loaded.filter((e) => e && typeof e.session === "string" && typeof e.cwd === "string") : [];
  }

  /** Newest first; for one cluster context when given. The folder path stays in main. */
  list(context?: string): AgentHistoryEntry[] {
    return this.entries
      .filter((e) => !context || e.context === context)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ cwd: _cwd, server: _server, held: _held, ...e }) => e);
  }

  get(session: string): Stored | undefined {
    return this.entries.find((e) => e.session === session);
  }

  /** A session started or resumed. */
  started(e: { session: string; agent: string; context: string; server?: string; namespaces?: string[]; cwd: string }) {
    const at = new Date(this.now()).toISOString();
    const prev = this.get(e.session);
    if (prev) {
      prev.updatedAt = at;
      prev.cwd = e.cwd;
    } else {
      this.entries.push({ ...e, title: "", createdAt: at, updatedAt: at, prompts: 0, applied: 0, rejected: 0 });
      this.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    }
    this.save();
  }

  /** You sent a prompt: the first one names the session. */
  prompted(session: string, text: string) {
    const e = this.get(session);
    if (!e) return;
    e.prompts++;
    e.updatedAt = new Date(this.now()).toISOString();
    if (!e.title) e.title = text.replace(/\s+/g, " ").trim().slice(0, 120);
    this.save();
  }

  /** A change you decided on was applied or rejected. */
  changed(session: string, state: "applied" | "rejected") {
    const e = this.get(session);
    if (!e) return;
    e[state]++;
    this.save();
  }

  /** The session's autonomous writes were held, and why: the first reason is kept (one line, at most 200 characters). */
  held(session: string, why: string) {
    const e = this.get(session);
    if (!e || e.held) return;
    e.held = why.replace(/\s+/g, " ").trim().slice(0, 200);
    this.save();
  }

  forget(session: string): Stored | undefined {
    const e = this.get(session);
    this.entries = this.entries.filter((x) => x.session !== session);
    this.save();
    return e;
  }

  private save() {
    writeJson(this.file, { sessions: this.entries });
  }
}

/** The skills you chose for agent sessions, by folder name in ~/.claude/skills. */
export class AgentSettings {
  private chosen: string[];

  constructor(private readonly file: string) {
    const loaded = readJson<{ skills?: unknown }>(file, {}).skills;
    this.chosen = Array.isArray(loaded) ? loaded.filter((s): s is string => typeof s === "string") : [];
  }

  skills(): string[] {
    return [...this.chosen];
  }

  setSkills(names: string[]) {
    this.chosen = [...new Set(names)].sort();
    writeJson(this.file, { skills: this.chosen });
  }
}
