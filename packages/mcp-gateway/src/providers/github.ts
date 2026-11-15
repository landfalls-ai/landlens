// GitHub's routine writes (D83): the tools an autonomous session may run without asking, by name, in code, each
// with what its arguments must say. Everything else asks, autonomous or not: merges, deletes, repositories (create,
// fork), workflows, secrets, releases, gists, notifications, members, teams, a tool that says it may destroy
// something, and any tool not named here, so a tool GitHub adds asks until a release of Landlens names it.
import type { AutonomyScope } from "@landlens/contracts";

type Args = Record<string, unknown>;
/** Why these arguments aren't a routine write in this scope, or undefined when they are. */
export type RoutineRule = (args: Args, scope: AutonomyScope) => string | undefined;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** `owner` and `repo` both present and, together, one of the scope's repositories (case-insensitive). */
export function inRepos(args: Args, scope: AutonomyScope): string | undefined {
  const owner = str(args.owner);
  const repo = str(args.repo);
  if (!owner || !repo) return "it doesn't name a repository (owner and repo)";
  const name = `${owner}/${repo}`.toLowerCase();
  if (!(scope.repos ?? []).some((r) => r.toLowerCase() === name)) return `${owner}/${repo} isn't in the scope`;
  return undefined;
}

/** The branches a file write never goes to on its own: main, master and the default branch typed in the scope. */
export function protectedBranches(scope: AutonomyScope): Set<string> {
  return new Set(["main", "master", ...(scope.branch ? [scope.branch.toLowerCase()] : [])]);
}

/** A file write names a branch, and it isn't main, master or the repository's default branch. */
export function offMain(args: Args, scope: AutonomyScope): string | undefined {
  const branch = str(args.branch)?.trim();
  if (!branch) return "a file write must name its branch";
  const name = branch.replace(/^refs\/heads\//i, "").toLowerCase();
  if (protectedBranches(scope).has(name)) return `it writes files to ${branch}`;
  return undefined;
}

/** `method` is one of the given values (GitHub's combined tools take create, update, … as an argument). */
const method = (allowed: string[]): RoutineRule => (args) => {
  const m = str(args.method);
  return m && allowed.includes(m) ? undefined : `${m ? `method ${m}` : "a missing method"} isn't routine`;
};

const all = (...rules: RoutineRule[]): RoutineRule => (args, scope) => {
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
  if (m !== "create" && m !== "submit_pending") return `${m ? `method ${m}` : "a missing method"} isn't routine`;
  const event = str(args.event);
  if (event !== undefined && event !== "COMMENT") return `a review that does ${event} isn't routine`;
  if (m === "submit_pending" && event === undefined) return "a review submitted without saying it is a comment isn't routine";
  return undefined;
};

/** GitHub's routine writes: issues, issue comments, branches, files on a branch, pull requests and their review comments. */
export const GITHUB_ROUTINE: Readonly<Record<string, RoutineRule>> = {
  issue_write: all(inRepos, method(["create", "update"])),
  add_issue_comment: inRepos,
  update_issue_comment: inRepos,
  create_branch: inRepos,
  create_or_update_file: all(inRepos, offMain),
  push_files: all(inRepos, offMain),
  create_pull_request: inRepos,
  update_pull_request: inRepos,
  pull_request_review_write: all(inRepos, commentReview),
  add_comment_to_pending_review: inRepos,
  add_reply_to_pull_request_comment: inRepos,
};
