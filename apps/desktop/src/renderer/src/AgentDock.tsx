// The agent dock: a Claude Code session on this cluster, beside the cluster view (which stays in sight). It shows
// ACP's updates as they come: the answer as it streams, thinking (folded), each tool call as a row with what it
// ran and what came back, the plan, and any question the agent asks before a tool call.
import type { AgentPermissionRequest, AgentSessionInfo, AgentStatus, AgentUpdate, ClusterInfo, ResourceRef } from "@landlens/contracts";
import { ArrowRight, ArrowUp, ChevronDown, CircleX, Lock, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { answerKeys, AskCard, Plan, Transcript, type Item, type PlanEntry, type Tool } from "./DockParts";
import { Ic, kindIcon } from "./icons";

export type AskContext = { ref: ResourceRef; label: string };

const SUGGESTIONS = ["What's wrong in this cluster right now?", "Which pods restarted in the last hour, and why?"];

export function AgentDock(props: {
  cluster: ClusterInfo;
  context: AskContext[];
  onContextChange: (c: AskContext[]) => void;
  onClose: () => void;
  /** A question to send as soon as the session is ready (Overview's "Ask Claude what's wrong"). */
  pending?: { id: number; text: string };
  /** A third suggestion, built from the cluster's worst problem. */
  suggestion?: string;
  /** What Claude is doing, for the status bar. */
  onActivity: (text?: string) => void;
}) {
  const [info, setInfo] = useState<AgentSessionInfo>();
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [asks, setAsks] = useState<AgentPermissionRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<string>();
  const [fence, setFence] = useState(false);
  const session = useRef<string | undefined>(undefined);
  const early = useRef<AgentUpdate[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const sent = useRef<number | undefined>(undefined);

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
      }
    });
    let closed = false;
    api.invoke("agent:start", { handle: props.cluster.handle }).then(
      (i) => {
        if (closed) return void api.invoke("agent:close", { session: i.session });
        session.current = i.session;
        setInfo(i);
        setMode(i.mode?.current);
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
      session.current = undefined;
    };
  }, [props.cluster.handle, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Braces matter: Chromium's scrollIntoView now returns a Promise, which React would take for a cleanup function.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [items, asks, plan]);

  useEffect(() => {
    if (info && props.pending && sent.current !== props.pending.id) {
      sent.current = props.pending.id;
      void send(props.pending.text);
    }
  }, [info, props.pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const running = [...items].reverse().find((x) => x.type === "tool" && x.tool.status === "in_progress") as { tool: Tool } | undefined;
    props.onActivity(asks.length ? "Claude Code is waiting for you" : busy ? (running ? `Claude Code is running ${running.tool.title.replace(/^mcp__landlens-kube__/, "").replace(/_/g, " ")}` : "Claude Code is working") : undefined);
  }, [busy, asks.length, items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => props.onActivity(undefined), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The composer grows with its text, up to eight lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  }, [draft]);

  function apply(u: AgentUpdate["update"]) {
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = (u.content as { type?: string; text?: string })?.type === "text" ? String((u.content as { text: string }).text) : "";
      if (!text) return;
      const t = Date.now();
      setItems((xs) => {
        const last = xs.at(-1);
        if (kind === "agent_message_chunk") {
          if (last?.type === "agent") return [...xs.slice(0, -1), { ...last, text: last.text + text }];
          return [...xs, { type: "agent", text }];
        }
        if (last?.type === "thought") return [...xs.slice(0, -1), { ...last, text: last.text + text, last: t }];
        return [...xs, { type: "thought", text, start: t, last: t }];
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

  /** Enter allows and Esc rejects the newest question, when the composer is empty. */
  const answerByKey = (e: React.KeyboardEvent) => {
    const newest = asks.at(-1);
    if (!newest || draft.trim() || (e.key !== "Enter" && e.key !== "Escape") || e.shiftKey) return false;
    const { allow, reject } = answerKeys(newest);
    const option = e.key === "Enter" ? allow : reject;
    if (!option) return false;
    e.preventDefault();
    e.stopPropagation();
    answer(newest, option);
    return true;
  };

  const suggestions = props.suggestion ? [...SUGGESTIONS, props.suggestion] : SUGGESTIONS;
  const tag = info?.label.split(" · ")[0];

  return (
    <aside className="dock" aria-label="Claude Code">
      <header className="dock-head">
        <span className={"claude-tile" + (!info && !failed ? " starting" : "")}><Ic icon={Sparkles} size={16} /></span>
        <div className="dock-id">
          <div className="dock-title">{info || failed ? "Claude Code" : "Starting Claude Code…"}</div>
          <div className="dock-sub">
            <span className="scope"><Ic icon={Lock} size={11} />read-only</span>
            <span>{props.cluster.context}</span>
            {tag ? <span className="dim">{tag}</span> : null}
          </div>
        </div>
        <button className="icon-btn" onClick={props.onClose} aria-label="Close Claude Code" title="Close Claude Code"><Ic icon={X} size={15} /></button>
      </header>
      <div className="dock-body">
        {failed ? (
          <div className="notice" role="alert">
            <Ic icon={CircleX} size={15} className="tone-bad" />
            <div className="notice-body">
              <strong>Claude Code is not available.</strong>
              <p>{failed}</p>
              <button className="secondary" onClick={() => {
                setFailed(undefined);
                setInfo(undefined);
                setAttempt((a) => a + 1);
              }}>Try again</button>
            </div>
          </div>
        ) : null}
        {info && !items.length ? (
          <div className="dock-empty">
            <span className="claude-tile lg"><Ic icon={Sparkles} size={20} /></span>
            <h3>Ask about this cluster</h3>
            <p>Read-only: no Secrets, no changes, no exec. <button className="link-btn" aria-expanded={fence} onClick={() => setFence((f) => !f)}>How it's fenced</button></p>
            {fence ? (
              <p className="fence-full">
                Claude Code runs with your login but none of your settings, plugins or MCP servers. It can only read this
                cluster, and only through Landlens: no Secrets, no changes, no exec, no internet. Pick an object and use
                "Ask Claude", or ask here.
              </p>
            ) : null}
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} className="suggestion" onClick={() => void send(s)}><span>{s}</span><Ic icon={ArrowRight} size={14} /></button>
              ))}
            </div>
          </div>
        ) : null}
        <Transcript items={items} busy={busy} />
        {plan.length ? <Plan plan={plan} /> : null}
        {asks.map((p) => <AskCard key={p.request} ask={p} onAnswer={(o) => answer(p, o)} />)}
        <div ref={bottom} />
      </div>
      <form className="dock-input" onSubmit={(e) => {
        e.preventDefault();
        void send(draft);
      }}>
        <div className="composer">
          {props.context.length ? (
            <div className="chips">
              {props.context.map((c) => (
                <span key={c.label} className="chip ctx-chip">
                  <Ic icon={kindIcon(c.ref.resource)} size={11} />
                  {c.label}
                  <button type="button" aria-label={`Remove ${c.label}`} onClick={() => props.onContextChange(props.context.filter((x) => x !== c))}><Ic icon={X} size={11} /></button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={box}
            aria-label="Message Claude Code"
            placeholder={asks.length ? "Reply to Claude Code…" : props.context.length ? "What do you want to know about it?" : "Ask about this cluster"}
            value={draft}
            rows={2}
            disabled={!info}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (answerByKey(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          <div className="composer-foot">
            {info?.mode ? (
              <label className="pill-select">
                <span className="sr-only">Mode</span>
                <select value={mode} onChange={(e) => {
                  setMode(e.target.value);
                  void api.invoke("agent:mode", { session: info.session, mode: e.target.value });
                }}>
                  {info.mode.available.filter((m) => m.id === "default" || m.id === "plan").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <Ic icon={ChevronDown} size={11} />
              </label>
            ) : null}
            {info?.options.filter((o) => o.id === "model").map((o) => (
              <label className="pill-select" key={o.id}>
                <span className="sr-only">{o.name}</span>
                <select defaultValue={o.current} onChange={(e) => void api.invoke("agent:config", { session: info.session, config: o.id, value: e.target.value })}>
                  {o.choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <Ic icon={ChevronDown} size={11} />
              </label>
            ))}
            <span className="grow" />
            {busy && asks.length ? <span className="dock-state waiting" aria-live="polite" title="Waiting for you"><i className="pulse" /><span className="state-word">Waiting for you</span></span>
              : busy ? <span className="dock-state" aria-live="polite" title="Working"><span className="spinner" /><span className="state-word">Working…</span></span> : null}
            {busy ? (
              <button type="button" className="stop" onClick={() => info && void api.invoke("agent:cancel", { session: info.session })}><Ic icon={X} size={12} />Stop</button>
            ) : (
              <button type="submit" className="primary" disabled={!info || !draft.trim()}><Ic icon={ArrowUp} size={13} />Send<kbd aria-hidden="true">↵</kbd></button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
}

function contentText(content: unknown[]): string {
  return content
    .map((c: any) => (c?.type === "content" && c.content?.type === "text" ? String(c.content.text) : c?.type === "diff" ? `diff ${c.path}` : ""))
    .filter(Boolean)
    .join("\n")
    .replace(/^```[a-z]*\n?|\n?```$/g, "");
}
