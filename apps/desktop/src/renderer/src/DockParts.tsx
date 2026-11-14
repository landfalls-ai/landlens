// What the dock draws: messages, thinking, tool calls grouped into one list, the plan, and the agent's questions.
import type { AgentPermissionRequest } from "@landlens/contracts";
import { AlignLeft, ArrowDown, Check, ChevronRight, CircleX, Ellipsis, Eye, FileText, Search, Terminal, Wrench, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AskContext } from "./AgentDock";
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

/** Consecutive tool calls render as one bordered list. */
export function Transcript({ items, busy }: { items: Item[]; busy: boolean }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.type === "tool") {
      const group: Tool[] = [];
      while (i < items.length && items[i]!.type === "tool") group.push((items[i++] as { tool: Tool }).tool);
      i--;
      out.push(<div key={`g${i}`} className="tool-group">{group.map((t) => <ToolRow key={t.id} tool={t} />)}</div>);
    } else out.push(<Entry key={i} item={it} streaming={busy && i === items.length - 1} />);
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
const MCP_ICON: Record<string, LucideIcon> = { get_logs: AlignLeft, get_resource: FileText, describe: Eye, list_resources: Search, cluster_overview: Eye, get_events: AlignLeft };
const STATUS_WORD: Record<string, string> = { pending: "queued", in_progress: "running", completed: "done", failed: "failed" };

function ToolRow({ tool }: { tool: Tool }) {
  const { label, detail, icon } = toolLabel(tool);
  const word = STATUS_WORD[tool.status] ?? tool.status;
  return (
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
      {tool.output ? <Well text={tool.output} className="tool-out" /> : null}
    </details>
  );
}

const HIT = /\b(FATAL|ERROR|panic|Error:)/;

/** A mono well with line numbers; lines that look like the failure are marked. */
export function Well({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className={`tool-io ${className}`}>
      {lines.map((l, i) => {
        const hit = HIT.test(l);
        return <span key={i} className={"ln" + (hit ? " hit" : "")} data-n={i + 1}>{hit ? <mark>{l}</mark> : l}{"\n"}</span>;
      })}
    </pre>
  );
}

/** "describe pod landlens-dev/orders-api-…" for the cluster tools; the command for Bash; the agent's title otherwise. */
function toolLabel(t: Tool): { label: string; detail?: string; icon: LucideIcon } {
  const name = t.mcp ?? t.title;
  const m = /^mcp__landlens-kube__(\w+)/.exec(name);
  const a = (t.input ?? {}) as Record<string, unknown>;
  const icon = (m && MCP_ICON[m[1]!]) || KIND_ICON[t.kind ?? ""] || Wrench;
  if (m) {
    const target = [a.kind ?? a.what, [a.namespace, a.name].filter(Boolean).join("/")].filter(Boolean).join(" ") + (a.previous ? " · previous" : "");
    return { label: m[1]!.replace(/_/g, " "), icon, ...(target.trim() ? { detail: target.trim() } : {}) };
  }
  if (typeof a.command === "string") return { label: "shell", detail: a.command, icon: Terminal };
  return { label: t.title, icon };
}

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
