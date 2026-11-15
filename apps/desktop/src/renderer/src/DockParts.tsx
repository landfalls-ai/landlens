// What the dock draws: messages, thinking, tool calls grouped into one list, the plan, the agent's questions, and
// (wave 6) GitHub's and Linear's autonomous mode: the chips above the composer's foot, the scope sheet, the warn strip.
import { AUTONOMY_BUDGET, BUILTIN_MCP_SERVER, FAILURE_LINE, type AgentPermissionRequest, type AutonomyState, type ConnProvider } from "@landlens/contracts";
import { Activity, AlignLeft, ArrowDown, Check, ChevronRight, CircleAlert, CircleX, Ellipsis, Eye, FileText, Plug, Search, Terminal, Wrench, X, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AskContext } from "./AgentDock";
import { AppFrame } from "./AppFrame";
import type { ObjectTarget } from "./app-host";
import { ProviderMark } from "./ConnectionsPage";
import { contextIcon, Ic, kindIcon } from "./icons";
import { Markdown } from "./Markdown";
import { providerArgRows, providerArgsJson } from "./provider-args";

export type Tool = { id: string; title: string; kind?: string; status: string; input?: unknown; output: string; mcp?: string };
export type Item =
  | { type: "user"; text: string; context: AskContext[] }
  | { type: "agent"; text: string }
  | { type: "thought"; text: string; start: number; last: number }
  | { type: "tool"; tool: Tool }
  | { type: "note"; text: string; tone?: "bad" | "warn" };
export type PlanEntry = { content: string; status: string; priority?: string };

/**
 * What a tool card needs to show its call's MCP App view (toolCallId → gateway call id), and which of its calls ran on
 * their own in an autonomous session (toolCallIds).
 */
export type Views = { views?: Map<string, string>; onOpenObject?: (t: ObjectTarget) => void; autonomous?: Set<string> };

/** The dock caps a view at this height until "Show all", so the answer under it stays in reach. */
export const VIEW_CAP = 320;

/**
 * Consecutive tool calls render as one bordered list. Only the newest view stays open: earlier ones fold to their tool
 * row and a one-line verdict, so a few tool calls don't push Claude's answer out of the dock.
 */
export function Transcript({ items, busy, views, onOpenObject, change, autonomous }: {
  items: Item[];
  busy: boolean;
  /** A write tool's change, drawn in place of its tool row and ending the group around it (wave 3, D4). */
  change?: (toolCallId: string) => ReactNode | undefined;
} & Views) {
  const out: ReactNode[] = [];
  let newest: string | undefined;
  for (const it of items) if (it.type === "tool" && it.tool.status === "completed" && views?.get(it.tool.id)) newest = it.tool.id;
  let group: Tool[] = [];
  const flush = (key: string) => {
    if (group.length) out.push(<div key={key} className="tool-group">{group.map((t) => <ToolRow key={t.id} tool={t} newest={t.id === newest} {...(views ? { views } : {})} {...(onOpenObject ? { onOpenObject } : {})} {...(autonomous ? { autonomous } : {})} />)}</div>);
    group = [];
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.type === "tool") {
      const node = change?.(it.tool.id);
      if (node) {
        flush(`g${i}`);
        out.push(<div key={`c${it.tool.id}`}>{node}</div>);
      } else group.push(it.tool);
      continue;
    }
    flush(`g${i}`);
    out.push(<Entry key={i} item={it} streaming={busy && i === items.length - 1} />);
  }
  flush("g-end");
  // Sent, and nothing back yet: say it's working rather than leave a gap under the question.
  const last = items[items.length - 1];
  if (busy && (!last || last.type === "user")) {
    out.push(
      <div key="thinking" className="thinking-row" role="status">
        <span className="shimmer-text">Thinking…</span>
        <span className="skel" style={{ width: "62%" }} /><span className="skel" style={{ width: "38%" }} />
      </div>,
    );
  }
  return <>{out}</>;
}

function Entry({ item, streaming }: { item: Item; streaming: boolean }) {
  switch (item.type) {
    case "user":
      return (
        <div className="msg msg-user">
          {item.context.length ? (
            <div className="chips">{item.context.map((c) => <span key={c.label} className="chip"><Ic icon={contextIcon(c)} size={11} />{c.label}</span>)}</div>
          ) : null}
          <div>{item.text}</div>
        </div>
      );
    case "agent":
      return <div className="msg msg-agent"><Markdown text={item.text} /></div>;
    case "thought": {
      const secs = Math.max(1, Math.round((item.last - item.start) / 1000));
      return (
        <details className="thought">
          <summary><Ic icon={ChevronRight} size={12} />{streaming ? <span className="shimmer-text">Thinking…</span> : `Thought for ${secs}s`}</summary>
          <div className="thought-text">{item.text}</div>
        </details>
      );
    }
    case "note":
      return <div className={"note" + (item.tone ? ` ${item.tone}` : "")}>{item.tone === "bad" ? <Ic icon={CircleX} size={13} /> : item.tone === "warn" ? <Ic icon={Zap} size={13} /> : null}{item.text}</div>;
    case "tool":
      return <ToolRow tool={item.tool} />;
  }
}

const KIND_ICON: Record<string, LucideIcon> = { read: Eye, search: Search, execute: Terminal, fetch: ArrowDown, think: Ellipsis };
const MCP_ICON: Record<string, LucideIcon> = { get_logs: AlignLeft, get_resource: FileText, describe: Eye, list_resources: Search, cluster_overview: Eye, get_events: AlignLeft, metrics: Activity };
const STATUS_WORD: Record<string, string> = { pending: "queued", in_progress: "running", completed: "done", failed: "failed" };

function ToolRow({ tool, views, onOpenObject, autonomous, newest = false }: { tool: Tool; newest?: boolean } & Views) {
  const { label, detail, icon, logs } = toolLabel(tool);
  const word = STATUS_WORD[tool.status] ?? tool.status;
  const call = tool.status === "completed" ? views?.get(tool.id) : undefined;
  const [open, setOpen] = useState<boolean>();
  const row = (
    <details className={`tool tool-${tool.status}`}>
      <summary>
        <span className="tool-icon"><Ic icon={icon} size={13} /></span>
        <span className="tool-label">{label}</span>
        {autonomous?.has(tool.id) ? <span className="chip auto-chip" title="A routine write in the autonomous scope: Landlens ran it without asking you"><Ic icon={Zap} size={11} />ran on its own</span> : null}
        {detail ? <span className="tool-detail mono">{detail}</span> : <span className="grow" />}
        <span className={`tool-status ${tool.status}`} role="img" aria-label={word} title={word}>
          {tool.status === "completed" ? <Ic icon={Check} size={13} /> : tool.status === "failed" ? <Ic icon={X} size={13} /> : <span className="spinner" />}
        </span>
      </summary>
      {tool.input ? <Well text={inputText(tool.input)} /> : null}
      {tool.output ? <Well text={tool.output} className="tool-out" failures={logs} /> : null}
    </details>
  );
  if (!call) return row;
  // The newest view sits under its card, open; an earlier one folds to a verdict line and opens on a click.
  const shown = open ?? newest;
  const verdict = firstLine(tool.output);
  return (
    <div className={"tool-with-app" + (shown ? "" : " folded")}>
      {row}
      {shown ? (
        <div className="tool-app">
          <AppFrame call={call} cap={VIEW_CAP} onOpenObject={onOpenObject ?? (() => {})} />
          {!newest ? <button className="link-btn small tool-app-fold" onClick={() => setOpen(false)}>Hide view</button> : null}
        </div>
      ) : (
        <button className="tool-verdict" onClick={() => setOpen(true)} aria-label={`Show the view: ${verdict || label}`}>
          <span className="tool-verdict-text">{verdict || "View"}</span>
          <span className="tool-verdict-act">Show view</span>
        </button>
      )}
    </div>
  );
}

/**
 * The first line of a tool's text answer, which the cluster tools write as their verdict; a heading that ends in ":"
 * ("Problems (4):") takes its first item with it.
 */
export function firstLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  return (first.endsWith(":") && lines[1] ? `${first} ${lines[1].replace(/^[-*•]\s*/, "")}` : first).slice(0, 200);
}

/**
 * A mono well with line numbers. `failures` marks the lines that look like the failure; it's for log output only (a
 * describe or a command line that says "ERROR" isn't a failing line).
 */
export function Well({ text, className = "", failures = false }: { text: string; className?: string; failures?: boolean }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className={`tool-io ${className}`}>
      {lines.map((l, i) => {
        const hit = failures && FAILURE_LINE.test(l);
        return <span key={i} className={"ln" + (hit ? " hit" : "")} data-n={i + 1}>{hit ? <mark>{l}</mark> : l}{"\n"}</span>;
      })}
    </pre>
  );
}

/**
 * "describe pod landlens-dev/orders-api-…" for the cluster tools, "clickland · list services" for a proxied server's;
 * the command for Bash; the agent's title otherwise.
 */
function toolLabel(t: Tool): { label: string; detail?: string; icon: LucideIcon; logs: boolean } {
  const name = t.mcp ?? t.title;
  const m = /^mcp__([a-z0-9-]+)__([\w.-]+)/.exec(name);
  const a = (t.input ?? {}) as Record<string, unknown>;
  const own = m?.[1] === BUILTIN_MCP_SERVER;
  const icon = (own && MCP_ICON[m![2]!]) || KIND_ICON[t.kind ?? ""] || (m ? Plug : Wrench);
  if (m) {
    const target = [a.kind ?? a.what ?? a.scope, [a.namespace, a.name].filter(Boolean).join("/")].filter(Boolean).join(" ") + (a.previous ? " · previous" : "");
    const tool = m[2]!.replace(/_/g, " ");
    return { label: own ? tool : `${m[1]} · ${tool}`, icon, logs: own && m[2] === "get_logs", ...(target.trim() ? { detail: target.trim() } : {}) };
  }
  if (typeof a.command === "string") return { label: "shell", detail: a.command, icon: Terminal, logs: KUBECTL_LOGS.test(a.command) };
  return { label: t.title, icon, logs: false };
}

const KUBECTL_LOGS = /^\s*kubectl\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*logs\b/;

export function inputText(v: unknown): string {
  if (v && typeof v === "object" && typeof (v as { command?: unknown }).command === "string") return `$ ${(v as { command: string }).command}`;
  return JSON.stringify(v, null, 2);
}

export function Plan({ plan }: { plan: PlanEntry[] }) {
  return (
    <section className="plan" aria-label="Plan">
      <div className="plan-head">Plan</div>
      <ul>
        {plan.map((p, i) => (
          <li key={i} className={`plan-${p.status}`}>
            {p.status === "completed" ? <Ic icon={Check} size={13} /> : p.status === "in_progress" ? <span className="spinner" aria-hidden="true" /> : <span className="hollow" aria-hidden="true" />}
            <span>{p.content}</span>
            <span className="sr-only">{p.status.replace("_", " ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const READ_KUBECTL = /^\s*kubectl\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(get|describe|logs|top|explain|api-resources|api-versions|version|cluster-info|events)\b/;

/** The one thing in the dock that wants you: allow options first, in Claude Code's own words. */
export function AskCard({ ask, onAnswer }: { ask: AgentPermissionRequest; onAnswer: (option: string) => void }) {
  const raw = ask.toolCall.rawInput as { command?: unknown } | undefined;
  const command = typeof raw?.command === "string" ? raw.command : undefined;
  if (ask.provider) return <ProviderAsk ask={ask} provider={ask.provider} onAnswer={onAnswer} />;
  const options = [...ask.options].sort((a, b) => Number(!a.kind.startsWith("allow")) - Number(!b.kind.startsWith("allow")));
  const firstAllow = options.find((o) => o.kind.startsWith("allow"));
  const firstReject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject"));
  return (
    <section className="ask" aria-label="Claude asks">
      <div className="ask-head">
        <Ic icon={command ? Terminal : Wrench} size={14} />
        <span className="ask-title">{command ? "Run a shell command?" : `${ask.toolCall.title ?? ask.toolCall.kind ?? "Use a tool"}?`}</span>
        {command && READ_KUBECTL.test(command) ? <span className="ask-kind read">read-only kubectl</span> : null}
      </div>
      {command ? (
        <pre className="tool-io"><span className="prompt">$</span>{command}</pre>
      ) : raw ? <Well text={inputText(raw)} /> : null}
      <div className="ask-actions">
        {options.map((o) => (
          <button key={o.optionId} className={o === firstAllow ? "primary" : "secondary"} onClick={() => onAnswer(o.optionId)}>
            {o.name}
            {o === firstAllow ? <kbd aria-hidden="true">↵</kbd> : o === firstReject ? <kbd aria-hidden="true">esc</kbd> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

export function answerKeys(ask: AgentPermissionRequest) {
  const allow = ask.options.find((o) => o.kind.startsWith("allow"));
  const reject = ask.options.find((o) => o.kind === "reject_once") ?? ask.options.find((o) => o.kind.startsWith("reject"));
  return { allow: allow?.optionId, reject: reject?.optionId };
}

// ---- GitHub and Linear writes (wave 6, D84) ----------------------------------------------------------------------

export const PROVIDER_NAME: Record<ConnProvider, string> = { github: "GitHub", linear: "Linear" };

/** "issue write" from mcp__github__issue_write, or the title Claude Code gave. */
function providerToolWords(ask: AgentPermissionRequest): string {
  const t = ask.toolCall.title ?? "";
  const m = /^mcp__[a-z0-9-]+__([\w.-]+)$/.exec(t);
  return (m ? m[1]! : t || "a tool").replace(/_/g, " ");
}

/** A write to GitHub or Linear that asks: the provider's mark, the tool, why it asked, and its arguments as a table. */
function ProviderAsk({ ask, provider, onAnswer }: { ask: AgentPermissionRequest; provider: ConnProvider; onAnswer: (option: string) => void }) {
  const options = [...ask.options].sort((a, b) => Number(!a.kind.startsWith("allow")) - Number(!b.kind.startsWith("allow")));
  const firstAllow = options.find((o) => o.kind.startsWith("allow"));
  const firstReject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject"));
  return (
    <section className="ask ask-provider" aria-label="Claude asks">
      <div className="ask-head">
        <span className="ask-mark"><ProviderMark provider={provider} size={14} /></span>
        <span className="ask-title">{PROVIDER_NAME[provider]} · {providerToolWords(ask)}?</span>
      </div>
      {ask.reason ? <div className="ask-why"><Ic icon={CircleAlert} size={12} />Asked because: {ask.reason}</div> : null}
      <ProviderArgs args={ask.toolCall.rawInput} />
      <div className="ask-actions">
        {options.map((o) => (
          <button key={o.optionId} className={o === firstAllow ? "primary" : "secondary"} onClick={() => onAnswer(o.optionId)}>
            {o.name}
            {o === firstAllow ? <kbd aria-hidden="true">↵</kbd> : o === firstReject ? <kbd aria-hidden="true">esc</kbd> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * A write's arguments as a short table, not raw JSON (D84): the repository or team, the issue or pull request, the
 * branches, the title, the files, the first 600 characters of the body, then the other arguments; what is cut says
 * how much. **Show all arguments** opens every argument, whole (M5 of the part 3 review), so nothing approved is hidden.
 */
export function ProviderArgs({ args }: { args: unknown }) {
  const rows = providerArgRows(args);
  if (!rows.length) return null;
  return (
    <>
      <dl className="args-table" aria-label="Arguments">
        {rows.map((r, i) => (
          <div key={i} className={r.body ? "args-body" : undefined}><dt>{r.label}</dt><dd className={r.body ? undefined : "mono"}>{r.value}</dd></div>
        ))}
      </dl>
      <details className="args-all">
        <summary>Show all arguments</summary>
        <pre className="mono" aria-label="All arguments">{providerArgsJson(args)}</pre>
      </details>
    </>
  );
}

/** Where autonomous writes may go, in words: "landfalls-ai/landlens", "team ENG". */
export function scopeWords(s: AutonomyState): string {
  if (s.provider === "github") {
    const r = s.scope?.repos ?? [];
    return r.length <= 2 ? r.join(" and ") : `${r.slice(0, -1).join(", ")} and ${r.at(-1)}`;
  }
  return `team ${s.scope?.team ?? "?"}`;
}

/** The sentence the scope sheet says before Turn on (D83). */
export function autonomySentence(provider: ConnProvider, where: string): string {
  return `Claude may write to ${where} without asking, up to ${AUTONOMY_BUDGET} times. Anything it can read may end up there.`;
}

const OFF_WORDS: Record<NonNullable<AutonomyState["offBecause"]>, string> = {
  you: "You stopped it.",
  budget: `It used its ${AUTONOMY_BUDGET} writes for this session.`,
  drift: "The tools changed, so it stopped.",
  session: "The session ended.",
  refused: "Three writes in a row weren't routine, so it stopped.",
};

/** The warn strip under the dock's head while any connection is autonomous: it can't be dismissed, only stopped. */
export function AutonomyStrip({ states, onStop }: { states: AutonomyState[]; onStop: (s: AutonomyState) => void }) {
  const on = states.filter((s) => s.on);
  if (!on.length) return null;
  return (
    <div className="auto-strip" role="status" aria-label="Autonomous">
      {on.map((s) => (
        <div key={s.provider} className="auto-strip-row">
          <Ic icon={Zap} size={13} />
          <span className="auto-strip-text"><b>Autonomous:</b> {PROVIDER_NAME[s.provider]} writes to {scopeWords(s)} run without asking. <span className="dim">{s.used}/{s.budget}</span></span>
          <button type="button" className="secondary sm auto-stop" onClick={() => onStop(s)} aria-label={`Stop ${PROVIDER_NAME[s.provider]} autonomous`}>Stop</button>
        </div>
      ))}
    </div>
  );
}

/** One chip per connection, above the composer's foot; a click opens its sheet (not for Read only). */
export function AutonomyChips({ states, open, onOpen }: { states: AutonomyState[]; open?: ConnProvider; onOpen: (p: ConnProvider | undefined) => void }) {
  return (
    <>
      {states.map((s) => {
        const name = PROVIDER_NAME[s.provider];
        if (s.mode === "read") return <span key={s.provider} className="auto-pill quiet" title={`${name} is read only in this session`}>{name} · read only</span>;
        return (
          <button key={s.provider} type="button" className={"auto-pill" + (s.on ? " on" : "")} aria-expanded={open === s.provider} aria-haspopup="dialog"
            title={s.on ? `${name} writes in scope run without asking` : `Every ${name} write asks you`}
            onClick={() => onOpen(open === s.provider ? undefined : s.provider)}>
            {s.on ? <Ic icon={Zap} size={11} /> : null}
            {name} · {s.on ? `autonomous ${s.used}/${s.budget}` : "asks"}
          </button>
        );
      })}
    </>
  );
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const TEAM = /^[A-Z][A-Z0-9]{0,9}$/;
const BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;

/**
 * The scope sheet: the level, the scope fields, the sentence, Turn on or Stop. Enter never turns it on (D84): the
 * sheet swallows Enter, so Turn on takes a click, or Space on the focused button.
 */
export function AutonomySheet({ state, error, onTurnOn, onStop, onClose }: {
  state: AutonomyState;
  error?: string;
  onTurnOn: (scope: { repos?: string[]; branch?: string; team?: string }) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const name = PROVIDER_NAME[state.provider];
  const github = state.provider === "github";
  const [repos, setRepos] = useState((state.scope?.repos ?? []).join(", "));
  const [branch, setBranch] = useState(state.scope?.branch ?? "main");
  const [team, setTeam] = useState(state.scope?.team ?? "");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => void (state.on ? undefined : first.current?.focus()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = repos.split(/[\s,]+/).filter(Boolean);
  const problem = github
    ? !list.length ? "Name at least one repository." : list.length > 5 ? "At most 5 repositories." : list.find((r) => !REPO.test(r)) ? `${list.find((r) => !REPO.test(r))} isn't owner/repo.` : !BRANCH.test(branch.trim()) ? "That isn't a branch name." : undefined
    : !TEAM.test(team.trim()) ? "A team key is capitals and digits, such as ENG." : undefined;
  const where = github ? (list.length ? list.join(", ") : "these repositories") : `team ${team.trim() || "…"}`;
  const scope = github ? { repos: list, ...(branch.trim() && branch.trim() !== "main" ? { branch: branch.trim() } : {}) } : { team: team.trim() };
  return (
    <div className="auto-sheet" role="dialog" aria-label={`${name} autonomous`}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}>
      <div className="auto-sheet-head">
        <span className="ask-mark"><ProviderMark provider={state.provider} size={14} /></span>
        <strong className="grow">{name} writes in this session</strong>
        <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}><Ic icon={X} size={13} /></button>
      </div>
      {state.on ? (
        <>
          <p className="auto-level"><Ic icon={Zap} size={12} />Autonomous: routine writes to <b>{scopeWords(state)}</b> run without asking. {state.used} of {state.budget} used.</p>
          <p className="dim small">Merges, deletes, anything outside the scope and anything not routine still ask. Cluster changes always wait for you on their change card.</p>
          <div className="auto-acts"><button type="button" className="secondary" onClick={onStop}>Stop</button></div>
        </>
      ) : (
        <>
          <p className="auto-level">Asks for each write. {state.offBecause ? <span className="dim">{OFF_WORDS[state.offBecause]}</span> : null}</p>
          {state.blocked ? (
            <p className="auto-blocked"><Ic icon={CircleAlert} size={12} />{state.blocked}</p>
          ) : (
            <>
              {github ? (
                <>
                  <label className="auto-field"><span>Repositories</span>
                    <span className="field"><input ref={first} value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="owner/repo, up to 5" spellCheck={false} autoComplete="off" aria-label="Repositories" /></span>
                  </label>
                  <label className="auto-field"><span>Default branch</span>
                    <span className="field"><input value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Default branch" /></span>
                  </label>
                  <p className="dim small">File writes never go to main, master or this branch. No merges.</p>
                </>
              ) : (
                <label className="auto-field"><span>Team key</span>
                  <span className="field"><input ref={first} value={team} onChange={(e) => setTeam(e.target.value.toUpperCase())} placeholder="ENG" spellCheck={false} autoComplete="off" aria-label="Team key" /></span>
                </label>
              )}
              <p className="auto-sentence">{autonomySentence(state.provider, where)}</p>
              {problem && (github ? repos : team) ? <p className="tone-warn small">{problem}</p> : null}
              {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
              <div className="auto-acts">
                <button type="button" className="auto-on" disabled={!!problem} onClick={() => onTurnOn(scope)}><Ic icon={Zap} size={12} />Turn on</button>
                <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
