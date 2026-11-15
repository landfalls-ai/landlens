// The autonomous mode (docs/connections.md, D82–D84): in one agent session, a connection's routine writes in the
// scope you set run without asking, up to a budget. It covers GitHub and Linear only: landlens-kube's writes always
// go through the approval broker, and servers you added keep asking.
//
// Prompt injection is the risk (an issue body can carry instructions), so the limits live here, in the gateway, and
// are checked twice: when main decides whether to answer Claude Code's question itself, and again in run() on the
// arguments that actually arrive, which is the check that counts. Never stored: a session starts with it off.
import { AUTONOMY_BUDGET, AUTONOMY_PER_MINUTE, type AutonomyOff, type AutonomyScope, type AutonomyState, type ConnMode, type ConnProvider } from "@landlens/contracts";
import { redactText } from "@landlens/kube-mcp";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { routine } from "./providers/index.js";

/** D83 rule 5: any string argument over 20,000 characters, or arguments over 200 KB, ask. */
export const MAX_ARG_STRING = 20_000;
export const MAX_ARGS_BYTES = 200_000;
/** After this many autonomous calls in a row refused by the rules, it turns off. */
export const REFUSED_IN_ROW = 3;
const MINUTE = 60_000;

/** Sentences the dock shows after "Asked because:". */
export const WHY = {
  credential: "it contains something shaped like a credential",
  size: "its arguments are too large to run without asking",
  budget: `it has used its ${AUTONOMY_BUDGET} writes for this session`,
  rate: `${AUTONOMY_PER_MINUTE} writes ran in the last minute`,
  off: "autonomous is off",
} as const;

/** Every string in the arguments, keys and values, depth-first. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), strings(x, out));
  return out;
}

/**
 * D83 rules 4 and 5: arguments that would change under the credential scrubber (redactText, the patterns the
 * front door and the call log use) or that are too large don't run on their own. The 4,096-character cap of
 * redactObject is not applied: it is a display limit, and rule 5 sets this one.
 */
export function argsProblem(args: Record<string, unknown>): string | undefined {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return WHY.size;
  }
  if (Buffer.byteLength(json, "utf8") > MAX_ARGS_BYTES) return WHY.size;
  const all = strings(args);
  if (all.some((s) => s.length > MAX_ARG_STRING)) return WHY.size;
  if (all.some((s) => redactText(s) !== s)) return WHY.credential;
  return undefined;
}

/** Check a scope against its provider: GitHub 1–5 repositories, Linear one team. */
export function scopeProblem(p: ConnProvider, scope: AutonomyScope | undefined): string | undefined {
  if (!scope) return "Give the scope first.";
  if (p === "github") {
    if (!scope.repos?.length) return "Name at least one repository (owner/repo).";
    if (scope.repos.length > 5) return "At most 5 repositories.";
    if (scope.team) return "A GitHub scope names repositories, not a team.";
  } else {
    if (!scope.team) return "Name the team (its key, such as ENG).";
    if (scope.repos?.length || scope.branch) return "A Linear scope names one team.";
  }
  return undefined;
}

/** One connection's autonomy in one session. */
export class Autonomy {
  on = false;
  scope: AutonomyScope | undefined;
  used = 0;
  offBecause: AutonomyOff | undefined;
  private recent: number[] = [];
  private refusedInRow = 0;

  constructor(
    readonly provider: ConnProvider,
    private readonly o: {
      session: () => string;
      mode: ConnMode;
      /** Why it can't be turned on in this session, decided when the session opened. */
      blocked?: string;
      now?: () => number;
      changed?: (s: AutonomyState) => void;
    },
  ) {}

  private get now() {
    return (this.o.now ?? Date.now)();
  }

  get blocked(): string | undefined {
    if (this.o.mode === "read") return "This connection is read only: no write exists in the session.";
    return this.o.blocked;
  }

  state(): AutonomyState {
    return {
      session: this.o.session(), provider: this.provider, on: this.on, used: this.used, budget: AUTONOMY_BUDGET, mode: this.o.mode,
      ...(this.scope ? { scope: this.scope } : {}),
      ...(this.offBecause ? { offBecause: this.offBecause } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
    };
  }

  private emit() {
    this.o.changed?.(this.state());
  }

  /** Turn it on with a scope. The budget carries on from what this session already used. */
  turnOn(scope: AutonomyScope) {
    const blocked = this.blocked;
    if (blocked) throw Object.assign(new Error(blocked), { status: 409 });
    const bad = scopeProblem(this.provider, scope);
    if (bad) throw Object.assign(new Error(bad), { status: 400 });
    if (this.used >= AUTONOMY_BUDGET) throw Object.assign(new Error(`This session has used its ${AUTONOMY_BUDGET} autonomous writes.`), { status: 409 });
    this.on = true;
    this.scope = scope;
    this.offBecause = undefined;
    this.refusedInRow = 0;
    this.emit();
  }

  stop(because: AutonomyOff) {
    if (!this.on) return;
    this.on = false;
    this.offBecause = because;
    this.emit();
  }

  /**
   * Why this call can't run on its own now, or undefined when it can: on, a routine write in scope (D83 rules 1–2),
   * no credential-shaped or oversized arguments (4–5), and budget left (3). Nothing is counted here.
   */
  check(tool: Pick<Tool, "name" | "annotations">, args: Record<string, unknown>): { why: string; rules: boolean } | undefined {
    if (!this.on || !this.scope) return { why: WHY.off, rules: false };
    const r = routine(this.provider, tool, args, this.scope) ?? argsProblem(args);
    if (r) return { why: r, rules: true };
    if (this.used >= AUTONOMY_BUDGET) return { why: WHY.budget, rules: false };
    const since = this.now - MINUTE;
    this.recent = this.recent.filter((t) => t > since);
    if (this.recent.length >= AUTONOMY_PER_MINUTE) return { why: WHY.rate, rules: false };
    return undefined;
  }

  /** A check failed on the rules: three in a row turn it off. */
  refused() {
    if (!this.on) return;
    if (++this.refusedInRow >= REFUSED_IN_ROW) this.stop("refused");
  }

  /** A call ran on its own: count it; the last of the budget turns it off. */
  count() {
    this.used++;
    this.recent.push(this.now);
    this.refusedInRow = 0;
    if (this.used >= AUTONOMY_BUDGET) this.stop("budget");
    else this.emit();
  }
}
