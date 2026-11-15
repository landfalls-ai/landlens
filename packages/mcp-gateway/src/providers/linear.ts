// Linear's routine writes (D83): creating and updating an issue, and commenting. A create must name the scope's
// team (by its key); an update or a comment names only an issue, which the gateway can't place in a team, so it is
// allowed without a team check (docs/limitations.md), unless it names a team, which must be the scope's.
import type { AutonomyScope } from "@landlens/contracts";
import type { RoutineRule } from "./github.js";

type Args = Record<string, unknown>;

const TEAM_ARGS = ["team", "teamId", "teamKey"] as const;

/** Every team the arguments name; a create must name one, and each must be the scope's team key. */
const teamIs = (required: boolean): RoutineRule => (args: Args, scope: AutonomyScope) => {
  const named = TEAM_ARGS.filter((k) => args[k] !== undefined);
  if (!named.length) return required ? "it doesn't name the team" : undefined;
  const team = scope.team?.toLowerCase();
  for (const k of named) {
    const v = args[k];
    if (typeof v !== "string" || v.toLowerCase() !== team) return `team ${typeof v === "string" ? v : "?"} isn't the scope's team`;
  }
  return undefined;
};

export const LINEAR_ROUTINE: Readonly<Record<string, RoutineRule>> = {
  create_issue: teamIs(true),
  update_issue: teamIs(false),
  create_comment: teamIs(false),
};
