// GitHub's routine writes (D83): the tools an autonomous session may run without asking, by name, in code, each
// with what its arguments must say. Everything else asks, autonomous or not: merges, deletes, repositories (create,
// fork), workflows, secrets, releases, gists, notifications, members, teams, a tool that says it may destroy
// something, and any tool not named here, so a tool GitHub adds asks until a release of Landlens names it.
//
// Each routine tool also names the arguments it may take on its own (M4 of the part 3 review): an argument it
// doesn't name asks, so a state, base, label, reviewer or an argument GitHub adds later never runs unexamined.
// Branches and files are allowlisted, not denylisted (M2): a branch or file write runs on its own only on a branch
// under `landlens/`, and never to `.github/` (workflows, CODEOWNERS, actions).
import type { AutonomyScope } from "@landlens/contracts";

type Args = Record<string, unknown>;
/** Why these arguments aren't a routine write in this scope, or undefined when they are. */
export type RoutineRule = (args: Args, scope: AutonomyScope) => string | undefined;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The longest piece of the model's text quoted in a reason (L1). */
export const QUOTE_MAX = 80;

/**
 * The model's text as the dock shows it after "Asked because:" (L1): quoted, control and format characters removed,
 * cut to 80 characters, so an argument can't pose as Landlens's own words.
 */
export function quote(v: unknown): string {
  const s = (typeof v === "string" ? v : String(v)).replace(/[\p{Cc}\p{Cf}]/gu, "");
  return JSON.stringify(s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX)}…` : s);
}

/** The arguments a routine tool may take on its own: any other one asks (M4). */
export const only = (keys: readonly string[]): RoutineRule => (args) => {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !keys.includes(k));
  return extra.length ? `argument ${quote(extra[0])} isn't one it takes on its own` : undefined;
};

/** `owner` and `repo` both present and, together, one of the scope's repositories (case-insensitive). */
export function inRepos(args: Args, scope: AutonomyScope): string | undefined {
  const owner = str(args.owner);
  const repo = str(args.repo);
  if (!owner || !repo) return "it doesn't name a repository (owner and repo)";
  const name = `${owner}/${repo}`.toLowerCase();
  if (!(scope.repos ?? []).some((r) => r.toLowerCase() === name)) return `${quote(`${owner}/${repo}`)} isn't in the scope`;
  return undefined;
}

/** A branch name as GitHub stores it: trimmed, without `refs/heads/`, lower case for comparing (L2). */
export const branchName = (b: string) => b.trim().replace(/^refs\/heads\//i, "").toLowerCase();

/** The branches a write never goes to on its own: main, master and the default branch typed in the scope. */
export function protectedBranches(scope: AutonomyScope): Set<string> {
  return new Set(["main", "master", ...(scope.branch ? [branchName(scope.branch)] : [])]);
}

/** The only branches an autonomous session writes to or creates: Landlens's own (M2). */
export const BRANCH_PREFIX = "landlens/";
const BRANCH_SHAPE = /^landlens\/[a-z0-9._/-]{1,200}$/;

/** `key` names a branch under `landlens/`, well formed, and not one the scope protects. */
export const onOwnBranch = (key: string): RoutineRule => (args, scope) => {
  const raw = str(args[key]);
  if (!raw?.trim()) return "a branch write must name its branch";
  const b = branchName(raw);
  if (protectedBranches(scope).has(b)) return `it writes to ${quote(raw)}`;
  if (!BRANCH_SHAPE.test(b) || b.includes("..") || b.includes("//") || b.endsWith("/") || b.endsWith(".lock")) {
    return `it writes to ${quote(raw)}, not a branch under ${BRANCH_PREFIX}`;
  }
  return undefined;
};

/** A file path an autonomous write may touch: relative, no `..`, and not under `.github/` (M2). */
function pathProblem(p: unknown): string | undefined {
  if (typeof p !== "string" || !p.trim()) return "a file write must name its path";
  const parts = p.trim().replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.includes("..")) return `path ${quote(p)} isn't a plain path in the repository`;
  if (parts[0]!.toLowerCase() === ".github") return `it writes to ${quote(p)}, under .github/ (workflows run from there)`;
  return undefined;
}

const filePath: RoutineRule = (args) => pathProblem(args.path);

/** push_files: each file is `{ path, content }`, each path allowed. */
const files: RoutineRule = (args) => {
  const list = args.files;
  if (!Array.isArray(list) || !list.length) return "it names no files";
  for (const f of list) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return "a file isn't a path and its content";
    const extra = Object.keys(f).find((k) => k !== "path" && k !== "content");
    if (extra) return `a file's ${quote(extra)} isn't one it takes on its own`;
    const why = pathProblem((f as { path?: unknown }).path);
    if (why) return why;
  }
  return undefined;
};

/** `method` is one of the given values (GitHub's combined tools take create, update, … as an argument). */
const method = (allowed: string[]): RoutineRule => (args) => {
  const m = str(args.method);
  return m && allowed.includes(m) ? undefined : `${m ? `method ${quote(m)}` : "a missing method"} isn't routine`;
};

export const all = (...rules: RoutineRule[]): RoutineRule => (args, scope) => {
  for (const r of rules) {
    const why = r(args, scope);
    if (why) return why;
  }
  return undefined;
};

/**
 * A review on a pull request may be a comment, never an approval or a request for changes: an approval can satisfy
 * branch protection, so it asks. A pending review is created or submitted as a comment; deleting one asks.
 */
const commentReview: RoutineRule = (args) => {
  const m = str(args.method);
  if (m !== "create" && m !== "submit_pending") return `${m ? `method ${quote(m)}` : "a missing method"} isn't routine`;
  const event = str(args.event);
  if (event !== undefined && event !== "COMMENT") return `a review that does ${quote(event)} isn't routine`;
  if (m === "submit_pending" && event === undefined) return "a review submitted without saying it is a comment isn't routine";
  return undefined;
};

/**
 * A pull request runs on its own only into the repository's default branch: the one typed in the scope, or main or
 * master when none was typed (Fable's check of part 3). Any other base (a release branch, gh-pages, another Landlens
 * branch) asks, so a pull request can't be aimed where a merge would deploy or publish.
 */
const intoDefault: RoutineRule = (args, scope) => {
  const raw = str(args.base);
  if (!raw?.trim()) return "a pull request must name its base";
  const want = scope.branch ? [branchName(scope.branch)] : ["main", "master"];
  return want.includes(branchName(raw)) ? undefined : `its base ${quote(raw)} isn't the default branch (${want.join(" or ")})`;
};

const REPO = ["owner", "repo"] as const;

/**
 * The arguments each routine tool may take on its own (M4). Labels, assignees, state, reviewers, … ask; a new pull
 * request names its base, which must be the default branch (`intoDefault`), and an update can't change it.
 */
export const GITHUB_ARGS: Readonly<Record<string, readonly string[]>> = {
  issue_write: [...REPO, "method", "issue_number", "title", "body"],
  add_issue_comment: [...REPO, "issue_number", "body"],
  update_issue_comment: [...REPO, "comment_id", "body"],
  create_branch: [...REPO, "branch", "from_branch"],
  create_or_update_file: [...REPO, "path", "content", "message", "branch", "sha"],
  push_files: [...REPO, "branch", "files", "message"],
  create_pull_request: [...REPO, "title", "head", "base", "body", "draft"],
  update_pull_request: [...REPO, "pullNumber", "title", "body"],
  pull_request_review_write: [...REPO, "pullNumber", "method", "body", "event", "commitID"],
  add_comment_to_pending_review: [...REPO, "pullNumber", "path", "body", "subjectType", "line", "side", "startLine", "startSide"],
  add_reply_to_pull_request_comment: [...REPO, "pullNumber", "commentId", "body"],
};

const tool = (name: string, ...rules: RoutineRule[]) => all(only(GITHUB_ARGS[name]!), inRepos, ...rules);

/** GitHub's routine writes: issues, issue comments, branches, files on a Landlens branch, pull requests and their review comments. */
export const GITHUB_ROUTINE: Readonly<Record<string, RoutineRule>> = {
  issue_write: tool("issue_write", method(["create", "update"])),
  add_issue_comment: tool("add_issue_comment"),
  update_issue_comment: tool("update_issue_comment"),
  create_branch: tool("create_branch", onOwnBranch("branch")),
  create_or_update_file: tool("create_or_update_file", onOwnBranch("branch"), filePath),
  push_files: tool("push_files", onOwnBranch("branch"), files),
  create_pull_request: tool("create_pull_request", intoDefault),
  update_pull_request: tool("update_pull_request"),
  pull_request_review_write: tool("pull_request_review_write", commentReview),
  add_comment_to_pending_review: tool("add_comment_to_pending_review"),
  add_reply_to_pull_request_comment: tool("add_reply_to_pull_request_comment"),
};
