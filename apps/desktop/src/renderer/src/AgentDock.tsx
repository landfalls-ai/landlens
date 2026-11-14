// The agent dock: a Claude Code session on this cluster, beside the cluster view (which stays in sight). It shows
// ACP's updates as they come: the answer as it streams, thinking (folded), each tool call as a card with what it
// ran and what came back, the plan, and any question the agent asks before a tool call.
import type { AgentPermissionRequest, AgentSessionInfo, AgentStatus, AgentUpdate, ClusterInfo, ResourceRef } from "@landlens/contracts";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { Markdown } from "./Markdown";

export type AskContext = { ref: ResourceRef; label: string };

type Tool = { id: string; title: string; kind?: string; status: string; input?: unknown; output: string; mcp?: string };
type Item =
  | { type: "user"; text: string; context: AskContext[] }
  | { type: "agent"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; tool: Tool }
  | { type: "note"; text: string; tone?: "bad" };

type PlanEntry = { content: string; status: string; priority?: string };

const SUGGESTIONS = ["What's wrong in this cluster right now?", "Which pods restarted in the last hour, and why?"];

export function AgentDock(props: { cluster: ClusterInfo; context: AskContext[]; onContextChange: (c: AskContext[]) => void; onClose: () => void }) {
  const [info, setInfo] = useState<AgentSessionInfo>();
  const [status, setStatus] = useState<string>("Starting Claude Code…");
  const [failed, setFailed] = useState<string>();
  const [items, setItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [asks, setAsks] = useState<AgentPermissionRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<string>();
  const session = useRef<string | undefined>(undefined);
  const early = useRef<AgentUpdate[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  // Updates can arrive before agent:start returns the session id; keep them until it does.
  useEffect(() => {
    const offUpdate = api.on("agent:update", (u: AgentUpdate) => {
      if (!session.current) early.current.push(u);
      else if (u.session === session.current) apply(u.update);
    });
    const offAsk = api.on("agent:permission", (p: AgentPermissionRequest) => {
      if (p.session === session.current) setAsks((a) => [...a, p]);
    });
    const offStatus = api.on("agent:status", (s: AgentStatus) => {
      if (s.state === "answered") setAsks((a) => a.filter((x) => x.request !== s.request));
      else if (s.state === "stopped") {
        setFailed(s.message);
        setBusy(false);
      } else if (s.state === "starting") setStatus("Starting Claude Code…");
    });
    let closed = false;
    api.invoke("agent:start", { handle: props.cluster.handle }).then(
      (i) => {
        if (closed) return void api.invoke("agent:close", { session: i.session });
        session.current = i.session;
        setInfo(i);
        setMode(i.mode?.current);
        setStatus("");
        for (const u of early.current.splice(0)) if (u.session === i.session) apply(u.update);
      },
      (e: ApiError) => setFailed(e.message),
    );
    return () => {
      closed = true;
      offUpdate();
      offAsk();
      offStatus();
      if (session.current) void api.invoke("agent:close", { session: session.current }).catch(() => {});
    };
  }, [props.cluster.handle]);

  // Braces matter: Chromium's scrollIntoView now returns a Promise, which React would take for a cleanup function.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [items, asks, plan]);

  function apply(u: AgentUpdate["update"]) {
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = (u.content as { type?: string; text?: string })?.type === "text" ? String((u.content as { text: string }).text) : "";
      if (!text) return;
      const type = kind === "agent_message_chunk" ? "agent" : "thought";
      setItems((xs) => {
        const last = xs.at(-1);
        if (last && last.type === type) return [...xs.slice(0, -1), { ...last, text: last.text + text }];
        return [...xs, { type, text }];
      });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = String(u.toolCallId);
      setItems((xs) => {
        const at = xs.findIndex((x) => x.type === "tool" && x.tool.id === id);
        const prev: Tool = at >= 0 ? (xs[at] as { tool: Tool }).tool : { id, title: "Tool", status: "pending", output: "" };
        const next: Tool = {
          ...prev,
          ...(typeof u.title === "string" && u.title ? { title: u.title } : {}),
          ...(typeof u.kind === "string" ? { kind: u.kind } : {}),
          ...(typeof u.status === "string" ? { status: u.status } : {}),
          ...(u.rawInput && Object.keys(u.rawInput as object).length ? { input: u.rawInput } : {}),
          ...(Array.isArray(u.content) ? { output: contentText(u.content) } : {}),
        };
        const meta = (u._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName;
        if (meta) next.mcp = meta;
        if (at >= 0) return xs.map((x, i) => (i === at ? { type: "tool", tool: next } : x));
        return [...xs, { type: "tool", tool: next }];
      });
    } else if (kind === "plan") {
      setPlan((u.entries as PlanEntry[]) ?? []);
    } else if (kind === "current_mode_update") {
      setMode(String(u.currentModeId));
    }
  }

  async function send(text: string) {
    const s = session.current;
    if (!s || !text.trim() || busy) return;
    const context = props.context;
    setItems((xs) => [...xs, { type: "user", text, context }]);
    setDraft("");
    props.onContextChange([]);
    setBusy(true);
    try {
      const r = await api.invoke("agent:prompt", { session: s, text, ...(context.length ? { context: context.map((c) => c.ref) } : {}) });
      if (r.stopReason === "cancelled") setItems((xs) => [...xs, { type: "note", text: "Stopped." }]);
      else if (r.stopReason !== "end_turn") setItems((xs) => [...xs, { type: "note", text: `Ended: ${r.stopReason}` }]);
    } catch (e) {
      setItems((xs) => [...xs, { type: "note", text: (e as ApiError).message, tone: "bad" }]);
    } finally {
      setBusy(false);
    }
  }

  const answer = (p: AgentPermissionRequest, option: string | null) => {
    setAsks((a) => a.filter((x) => x.request !== p.request));
    void api.invoke("agent:answer", { request: p.request, option }).catch(() => {});
  };

  return (
    <aside className="dock" aria-label="Claude Code">
      <header className="dock-head">
        <div>
          <div className="eyebrow">Claude Code · {props.cluster.context} · read-only</div>
          <div className="dock-title">{info ? "Ask about this cluster" : status || "…"}</div>
        </div>
        <button className="icon" onClick={props.onClose} aria-label="Close Claude Code">✕</button>
      </header>
      {info ? (
        <div className="dock-pickers">
          {info.mode ? (
            <label className="field">
              <span className="sr-only">Mode</span>
              <select value={mode} onChange={(e) => {
                setMode(e.target.value);
                void api.invoke("agent:mode", { session: info.session, mode: e.target.value });
              }}>
                {info.mode.available.filter((m) => m.id === "default" || m.id === "plan").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          ) : null}
          {info.options.filter((o) => o.id === "model").map((o) => (
            <label className="field" key={o.id}>
              <span className="sr-only">{o.name}</span>
              <select defaultValue={o.current} onChange={(e) => void api.invoke("agent:config", { session: info.session, config: o.id, value: e.target.value })}>
                {o.choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : null}
      <div className="dock-body">
        {failed ? <div className="notice"><strong>Claude Code is not available.</strong><p className="small">{failed}</p></div> : null}
        {info && !items.length ? (
          <div className="dock-empty">
            <p className="muted small">
              Claude Code runs with your login but none of your settings, plugins or MCP servers. It can only read this
              cluster, and only through Landlens: no Secrets, no changes, no exec, no internet. Pick an object and use
              "Ask Claude", or ask here.
            </p>
            {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => void send(s)}>{s}</button>)}
          </div>
        ) : null}
        {items.map((it, i) => <Entry key={i} item={it} />)}
        {plan.length ? (
          <section className="plan" aria-label="Plan">
            <div className="eyebrow">Plan</div>
            <ul>{plan.map((p, i) => <li key={i} className={`plan-${p.status}`}>{p.status === "completed" ? "✓" : p.status === "in_progress" ? "▸" : "○"} {p.content}</li>)}</ul>
          </section>
        ) : null}
        {asks.map((p) => (
          <section key={p.request} className="ask" aria-label="Claude asks">
            <div className="eyebrow">Claude Code asks to run</div>
            <div className="ask-title">{p.toolCall.title ?? p.toolCall.kind ?? "a tool"}</div>
            {p.toolCall.rawInput ? <pre className="tool-io">{inputText(p.toolCall.rawInput)}</pre> : null}
            <div className="ask-actions">
              {p.options.map((o) => (
                <button key={o.optionId} className={o.kind.startsWith("allow") ? "primary" : ""} onClick={() => answer(p, o.optionId)}>{o.name}</button>
              ))}
            </div>
          </section>
        ))}
        {busy && !asks.length ? <div className="working muted small" aria-live="polite">Working…</div> : null}
        <div ref={bottom} />
      </div>
      <form className="dock-input" onSubmit={(e) => {
        e.preventDefault();
        void send(draft);
      }}>
        {props.context.length ? (
          <div className="chips">
            {props.context.map((c) => (
              <span key={c.label} className="chip ctx-chip">
                {c.label}
                <button type="button" aria-label={`Remove ${c.label}`} onClick={() => props.onContextChange(props.context.filter((x) => x !== c))}>×</button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label="Message Claude Code"
          placeholder={props.context.length ? "What do you want to know about it?" : "Ask about this cluster"}
          value={draft}
          rows={3}
          disabled={!info}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <div className="row-between">
          <span className="muted small">{info?.label ?? ""}</span>
          {busy ? (
            <button type="button" onClick={() => info && void api.invoke("agent:cancel", { session: info.session })}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={!info || !draft.trim()}>Send</button>
          )}
        </div>
      </form>
    </aside>
  );
}

function Entry({ item }: { item: Item }) {
  switch (item.type) {
    case "user":
      return (
        <div className="msg msg-user">
          {item.context.length ? <div className="chips">{item.context.map((c) => <span key={c.label} className="chip">{c.label}</span>)}</div> : null}
          <div>{item.text}</div>
        </div>
      );
    case "agent":
      return <div className="msg msg-agent"><Markdown text={item.text} /></div>;
    case "thought":
      return <details className="thought"><summary className="muted small">Thinking</summary><div className="small muted pre">{item.text}</div></details>;
    case "note":
      return <div className={`note small ${item.tone === "bad" ? "tone-bad" : "muted"}`}>{item.text}</div>;
    case "tool":
      return <ToolCard tool={item.tool} />;
  }
}

function ToolCard({ tool }: { tool: Tool }) {
  const { label, detail } = toolLabel(tool);
  return (
    <details className={`tool tool-${tool.status}`}>
      <summary>
        <span className="tool-icon" aria-hidden>{ICONS[tool.kind ?? ""] ?? "•"}</span>
        <span className="tool-label">{label}</span>
        {detail ? <span className="tool-detail mono">{detail}</span> : null}
        <span className={`tool-status ${tool.status}`}>{STATUS[tool.status] ?? tool.status}</span>
      </summary>
      {tool.input ? <pre className="tool-io">{inputText(tool.input)}</pre> : null}
      {tool.output ? <pre className="tool-io tool-out">{tool.output}</pre> : null}
    </details>
  );
}

const ICONS: Record<string, string> = { read: "◧", search: "⌕", execute: "▶", fetch: "↓", think: "…", edit: "✎", delete: "✕", other: "•" };
const STATUS: Record<string, string> = { pending: "queued", in_progress: "running", completed: "done", failed: "failed" };

/** "describe pod landlens-dev/orders-api-…" for the cluster tools; the command for Bash; the agent's title otherwise. */
function toolLabel(t: Tool): { label: string; detail?: string } {
  const name = t.mcp ?? t.title;
  const m = /^mcp__landlens-kube__(\w+)/.exec(name);
  const a = (t.input ?? {}) as Record<string, unknown>;
  if (m) {
    const target = [a.kind ?? a.what, [a.namespace, a.name].filter(Boolean).join("/")].filter(Boolean).join(" ");
    return { label: m[1]!.replace(/_/g, " "), ...(target ? { detail: String(target) } : {}) };
  }
  if (typeof a.command === "string") return { label: "shell", detail: a.command };
  return { label: t.title };
}

function inputText(v: unknown): string {
  if (v && typeof v === "object" && typeof (v as { command?: unknown }).command === "string") return `$ ${(v as { command: string }).command}`;
  return JSON.stringify(v, null, 2);
}

function contentText(content: unknown[]): string {
  return content
    .map((c: any) => (c?.type === "content" && c.content?.type === "text" ? String(c.content.text) : c?.type === "diff" ? `diff ${c.path}` : ""))
    .filter(Boolean)
    .join("\n")
    .replace(/^```[a-z]*\n?|\n?```$/g, "");
}
