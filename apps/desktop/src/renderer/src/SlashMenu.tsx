// The composer's "/" menu (wave 3, D62–D71): Landlens's own commands first, run at once and never sent; then the
// commands the agent announced (available_commands_update), sent as the message.
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Ic } from "./icons";
import { Mark } from "./Mark";

export type AgentCommand = { name: string; description: string; hint?: string };
export type SlashOption = AgentCommand & { own: boolean };

/** Landlens's commands; an agent command with one of these names isn't listed (D66). */
export const LANDLENS_COMMANDS: AgentCommand[] = [
  { name: "new", description: "Start a new session" },
  { name: "history", description: "Open history" },
  { name: "resume", description: "Open history and pick a past session" },
  { name: "settings", description: "Open Agent settings" },
];

/** The menu is open while the draft is a slash and one word, with no space yet (D63). */
export const slashQuery = (draft: string): string | undefined => (/^\/\S*$/.test(draft) ? draft.slice(1) : undefined);

/** Names that start with the query, then names that contain it, then descriptions that do; groups keep their order. */
export function slashOptions(query: string, agent: AgentCommand[]): SlashOption[] {
  const q = query.toLowerCase();
  const rank = (c: AgentCommand) => {
    const n = c.name.toLowerCase();
    return n.startsWith(q) ? 0 : n.includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : 3;
  };
  const pick = (list: AgentCommand[], own: boolean) =>
    list.map((c, i) => ({ c, i, r: rank(c) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => ({ ...x.c, own }));
  const reserved = new Set(LANDLENS_COMMANDS.map((c) => c.name));
  return [...pick(LANDLENS_COMMANDS, true), ...pick(agent.filter((c) => !reserved.has(c.name)), false)];
}

function highlight(name: string, q: string): ReactNode {
  const at = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return `/${name}`;
  return <>/{name.slice(0, at)}<b>{name.slice(at, at + q.length)}</b>{name.slice(at + q.length)}</>;
}

export function SlashMenu({ query, options, active, agent, onHover, onPick, short }: {
  query: string;
  options: SlashOption[];
  active: number;
  agent: string;
  onHover: (i: number) => void;
  onPick: (o: SlashOption) => void;
  /** A low dock: no key hints (D69). */
  short: boolean;
}) {
  const own = options.filter((o) => o.own);
  const theirs = options.filter((o) => !o.own);
  const row = (o: SlashOption) => {
    const i = options.indexOf(o);
    return (
      <div key={`${o.own}${o.name}`} id={`slash-${i}`} role="option" aria-selected={i === active} className={"slash-opt" + (i === active ? " on" : "")}
        onMouseEnter={() => onHover(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(o)} title={o.description}>
        {o.own ? <Mark className="mark slash-mark" /> : <Ic icon={Sparkles} size={14} />}
        <span className="slash-name">{highlight(o.name, query)}</span>
        {o.hint ? <span className="slash-hint">{o.hint}</span> : null}
        <span className="slash-desc">{o.description}</span>
      </div>
    );
  };
  return (
    <div className="slash-menu" role="listbox" id="slash-menu" aria-label="Commands">
      {own.length ? <div role="group" aria-label="Landlens"><div className="menu-label">Landlens</div>{own.map(row)}</div> : null}
      {theirs.length ? <div role="group" aria-label={agent}><div className="menu-label">{agent}</div>{theirs.map(row)}</div> : null}
      {!options.length ? <div className="slash-opt dim" role="option" aria-disabled="true" aria-selected="false">No command matches /{query}. Enter sends it as a message.</div> : null}
      {!short ? (
        <div className="slash-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> pick</span><span><kbd>esc</kbd> close</span>
        </div>
      ) : null}
    </div>
  );
}
