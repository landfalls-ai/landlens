// Linear's routine writes (D83): creating and updating an issue, and commenting, all in the scope's team. A create
// must name the team (by its key); an update or a comment names an issue, which must be one of the team's by its
// identifier, `<KEY>-<number>` (M3 of the part 3 review): an issue named by its UUID can't be placed in a team
// without a read, so it asks. Each tool takes only the arguments named here on its own (M4); a state, assignee,
// label or project asks.
import type { AutonomyScope } from "@landlens/contracts";
import { all, only, quote, type RoutineRule } from "./github.js";

type Args = Record<string, unknown>;

const TEAM_ARGS = ["team", "teamId", "teamKey"] as const;

/** Every team the arguments name; a create must name one, and each must be the scope's team key. */
const teamIs = (required: boolean): RoutineRule => (args: Args, scope: AutonomyScope) => {
  const named = TEAM_ARGS.filter((k) => args[k] !== undefined);
  if (!named.length) return required ? "it doesn't name the team" : undefined;
  const team = scope.team?.toLowerCase();
  for (const k of named) {
    const v = args[k];
    if (typeof v !== "string" || v.toLowerCase() !== team) return `team ${typeof v === "string" ? quote(v) : "?"} isn't the scope's team`;
  }
  return undefined;
};

/** `key` names one of the scope team's issues by its identifier, such as ENG-123. */
const issueOfTeam = (key: string): RoutineRule => (args: Args, scope: AutonomyScope) => {
  const v = args[key];
  const team = scope.team ?? "";
  if (typeof v !== "string" || !v) return "it doesn't name the issue";
  const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/.exec(v.trim());
  if (!m) return `issue ${quote(v)} isn't named as ${team}-<number>, so Landlens can't tell its team`;
  if (m[1]!.toLowerCase() !== team.toLowerCase()) return `issue ${quote(v)} isn't in team ${team}`;
  return undefined;
};

/** The arguments each routine tool may take on its own (M4). */
export const LINEAR_ARGS: Readonly<Record<string, readonly string[]>> = {
  create_issue: ["team", "title", "description"],
  update_issue: ["id", "title", "description"],
  create_comment: ["issueId", "body", "parentId"],
};

export const LINEAR_ROUTINE: Readonly<Record<string, RoutineRule>> = {
  create_issue: all(only(LINEAR_ARGS.create_issue!), teamIs(true)),
  update_issue: all(only(LINEAR_ARGS.update_issue!), issueOfTeam("id")),
  create_comment: all(only(LINEAR_ARGS.create_comment!), issueOfTeam("issueId")),
};
