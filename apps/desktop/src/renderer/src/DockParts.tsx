// What the dock draws: messages, thinking, tool calls grouped into one list, the plan, and the agent's questions.
import { BUILTIN_MCP_SERVER, FAILURE_LINE, type AgentPermissionRequest } from "@landlens/contracts";
import { Activity, AlignLeft, ArrowDown, Check, ChevronRight, CircleX, Ellipsis, Eye, FileText, Plug, Search, Terminal, Wrench, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AskContext } from "./AgentDock";
import { AppFrame } from "./AppFrame";
import type { ObjectTarget } from "./app-host";
import { Ic, kindIcon } from "./icons";
import { Markdown } from "./Markdown";

export type Tool = { id: string; title: string; kind?: string; status: string; input?: unknown; output: string; mcp?: string };
export type Item =
  | { type: "user"; text: string; context: AskContext[] }
  | { type: "agent"; text: string }
  | { type: "thought"; text: string; start: number; last: number }
  | { type: "tool"; tool: Tool }
  | { type: "note"; text: string; tone?: "bad" };
export type PlanEntry = { content: string; status: string; priority?: string };

/** What a tool card needs to show its call's MCP App view: toolCallId → gateway call id. */
export type Views = { views?: Map<string, string>; onOpenObject?: (t: ObjectTarget) => void };

/** The dock caps a view at this height until "Show all", so the answer under it stays in reach. */
export const VIEW_CAP = 320;

/**
 * Consecutive tool calls render as one bordered list. Only the newest view stays open: earlier ones fold to their tool
 * row and a one-line verdict, so a few tool calls don't push Claude's answer out of the dock.
 */
export function Transcript({ items, busy, views, onOpenObject }: { items: Item[]; busy: boolean } & Views) {
  const out: ReactNode[] = [];
  let newest: string | undefined;
  for (const it of items) if (it.type === "tool" && it.tool.status === "completed" && views?.get(it.tool.id)) newest = it.tool.id;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.type === "tool") {
      const group: Tool[] = [];
      while (i < items.length && items[i]!.type === "tool") group.push((items[i++] as { tool: Tool }).tool);
      i--;
      out.push(<div key={`g${i}`} className="tool-group">{group.map((t) => <ToolRow key={t.id} tool={t} newest={t.id === newest} {...(views ? { views } : {})} {...(onOpenObject ? { onOpenObject } : {})} />)}</div>);
    } else out.push(<Entry key={i} item={it} streaming={busy && i === items.length - 1} />);
  }
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
            <div className="chips">{item.context.map((c) => <span key={c.label} className="chip"><Ic icon={kindIcon(c.ref.resource)} size={11} />{c.label}</span>)}</div>
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
      return <div className={"note" + (item.tone === "bad" ? " bad" : "")}>{item.tone === "bad" ? <Ic icon={CircleX} size={13} /> : null}{item.text}</div>;
    case "tool":
      return <ToolRow tool={item.tool} />;
  }
}

const KIND_ICON: Record<string, LucideIcon> = { read: Eye, search: Search, execute: Terminal, fetch: ArrowDown, think: Ellipsis };
const MCP_ICON: Record<string, LucideIcon> = { get_logs: AlignLeft, get_resource: FileText, describe: Eye, list_resources: Search, cluster_overview: Eye, get_events: AlignLeft, metrics: Activity };
const STATUS_WORD: Record<string, string> = { pending: "queued", in_progress: "running", completed: "done", failed: "failed" };

function ToolRow({ tool, views, onOpenObject, newest = false }: { tool: Tool; newest?: boolean } & Views) {
  const { label, detail, icon, logs } = toolLabel(tool);
  const word = STATUS_WORD[tool.status] ?? tool.status;
  const call = tool.status === "completed" ? views?.get(tool.id) : undefined;
  const [open, setOpen] = useState<boolean>();
  const row = (
    <details className={`tool tool-${tool.status}`}>
      <summary>
        <span className="tool-icon"><Ic icon={icon} size={13} /></span>
        <span className="tool-label">{label}</span>
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

/** The first line of a tool's text answer, which the cluster tools write as their verdict. */
function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
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
