// The agent dock: a Claude Code session on this cluster, beside the cluster view (which stays in sight). It shows
// ACP's updates as they come: the answer as it streams, thinking (folded), each tool call as a row with what it
// ran and what came back, the plan, any question the agent asks before a tool call, and (wave 3) each change it
// proposes, which waits for your decision in the dock. History lists and resumes past sessions; "/" opens commands.
import type { AgentChange, AgentHistoryEntry, AgentPermissionRequest, AgentSessionInfo, AgentStatus, AgentUpdate, AutonomyState, ClusterInfo, ConnProvider, ResourceRef } from "@landlens/contracts";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ban, ChevronDown, CircleX, History, ShieldCheck, Sparkles, SquarePen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { ChangeCard, ChangeDone, isWaiting, riskWords, type CardKeys } from "./ChangeCard";
import { answerKeys, AskCard, AutonomyChips, AutonomySheet, AutonomyStrip, Plan, PROVIDER_NAME, Transcript, type Item, type PlanEntry, type Tool } from "./DockParts";
import { HistoryPanel, whenText } from "./HistoryPanel";
import { BrainSheet, SessionMenu, SummaryStrip, useReportable } from "./BrainSheet";
import type { ObjectTarget } from "./app-host";
import { contextIcon, Ic, kindIcon } from "./icons";
import { hasView, useMcpCalls } from "./mcpStore";
import { slashOptions, slashQuery, SlashMenu, type AgentCommand, type SlashOption } from "./SlashMenu";

export type { AskContext } from "./quotes";

import { inSession, quoteHead, withQuotes, type AskContext } from "./quotes";
export { withQuotes };

const SUGGESTIONS = ["What's wrong in this cluster right now?", "Which pods restarted in the last hour, and why?"];

/** How the dock opens its session: a new one, or one from history (replayed). */
type Opening = { n: number; resume?: AgentHistoryEntry };

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
  /** A view's "Open in Landlens": move the main view to the object. */
  onOpenObject: (t: ObjectTarget) => void;
  /** "/settings": open the Agent page. */
  onOpenSettings?: () => void;
  /** The left edge's resize grip (wave 6). */
  grip?: React.ReactNode;
}) {
  const [info, setInfo] = useState<AgentSessionInfo>();
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<Opening>({ n: 0 });
  const [items, setItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [asks, setAsks] = useState<AgentPermissionRequest[]>([]);
  const [changes, setChanges] = useState<AgentChange[]>([]);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<string>();
  const [fence, setFence] = useState(false);
  const [panel, setPanel] = useState<"history">();
  const [histCount, setHistCount] = useState<number>();
  const [switchTo, setSwitchTo] = useState<Opening | "settings">();
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [cardHidden, setCardHidden] = useState<"up" | "down">();
  const [alert, setAlert] = useState("");
  const [status, setStatus] = useState("");
  // GitHub's and Linear's autonomous mode in this session (D82–D84): main's word, never stored.
  const [autonomy, setAutonomy] = useState<AutonomyState[]>([]);
  const [sheet, setSheet] = useState<ConnProvider>();
  const [sheetError, setSheetError] = useState<string>();
  // The brain and Clickland for this session (wave 7 part 5): a sheet the person opens; nothing goes by itself.
  const reportable = useReportable();
  const [brainSheet, setBrainSheet] = useState(false);
  const session = useRef<string | undefined>(undefined);
  const replaying = useRef(false);
  const early = useRef<AgentUpdate[]>([]);
  const earlyChanges = useRef<AgentChange[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const sent = useRef<number | undefined>(undefined);
  const cards = useRef(new Map<string, CardKeys>());
  const agent = info?.agent ?? "Claude Code";
  // MCP App views: a tool card whose gateway call returned a view shows it inline (paired by toolCallId in main).
  const mcpCalls = useMcpCalls();
  const views = new Map(mcpCalls.filter((c) => hasView(c) && c.toolCallId && c.session === info?.session).map((c) => [c.toolCallId!, c.id]));
  const autonomous = new Set(mcpCalls.filter((c) => c.gate === "autonomous" && c.toolCallId && c.session === info?.session).map((c) => c.toolCallId!));

  const waiting = changes.filter((c) => c.state === "waiting");
  const applying = changes.some((c) => c.state === "applying");
  // A change sits where its tool call is: the gateway call it came from names the dock's card (D4).
  const byTool = useMemo(() => {
    const m = new Map<string, AgentChange>();
    for (const c of changes) {
      const card = c.call ? mcpCalls.find((x) => x.id === c.call)?.toolCallId : undefined;
      if (card) m.set(card, c);
    }
    return m;
  }, [changes, mcpCalls]);
  const loose = changes.filter((c) => ![...byTool.values()].includes(c));

  // Updates can arrive before agent:start returns the session id; keep them until it does.
  useEffect(() => {
    const offUpdate = api.on("agent:update", (u: AgentUpdate) => {
      if (!session.current) early.current.push(u);
      else if (u.session === session.current) apply(u.update);
    });
    const offAsk = api.on("agent:permission", (p: AgentPermissionRequest) => {
      if (p.session === session.current) setAsks((a) => [...a, p]);
    });
    const offChange = api.on("agent:change", (c: AgentChange) => {
      if (!session.current) earlyChanges.current.push(c);
      else if (c.session === session.current) change(c);
    });
    const offAutonomy = api.on("agent:autonomy", (a: AutonomyState) => {
      if (a.session !== session.current) return;
      setAutonomy((xs) => (xs.some((x) => x.provider === a.provider) ? xs.map((x) => (x.provider === a.provider ? a : x)) : [...xs, a]));
      if (!a.on && a.offBecause && a.offBecause !== "you" && a.offBecause !== "session") {
        const words = { budget: `used its ${a.budget} writes`, drift: "its tools changed", refused: "three writes in a row weren't routine" }[a.offBecause];
        setItems((xs) => [...xs, { type: "note", text: `${PROVIDER_NAME[a.provider]} autonomous stopped: ${words}. Every write asks again.`, tone: "warn" }]);
      }
    });
    const offStatus = api.on("agent:status", (s: AgentStatus) => {
      if (s.state === "answered") setAsks((a) => a.filter((x) => x.request !== s.request));
      else if (s.state === "stopped") {
        setFailed(s.message);
        setBusy(false);
      }
    });
    let closed = false;
    const resume = opening.resume;
    if (resume) {
      // Replayed updates come before agent:resume answers: take them for this session at once.
      session.current = resume.session;
      replaying.current = true;
    }
    const start = resume
      ? api.invoke("agent:resume", { handle: props.cluster.handle, session: resume.session })
      : api.invoke("agent:start", { handle: props.cluster.handle });
    start.then(
      (i) => {
        replaying.current = false;
        if (closed) return void api.invoke("agent:close", { session: i.session });
        session.current = i.session;
        setInfo(i);
        setAutonomy(i.autonomy ?? []);
        setMode(i.mode?.current);
        for (const u of early.current.splice(0)) if (u.session === i.session) apply(u.update);
        for (const c of earlyChanges.current.splice(0)) if (c.session === i.session) change(c);
        if (resume) {
          setItems((xs) => [...xs, { type: "note", text: `Resumed · last active ${whenText(resume.updatedAt)}` }]);
          requestAnimationFrame(() => box.current?.focus());
        }
      },
      (e: ApiError) => {
        replaying.current = false;
        session.current = undefined;
        setFailed(e.message);
      },
    );
    return () => {
      closed = true;
      offUpdate();
      offAsk();
      offChange();
      offStatus();
      offAutonomy();
      if (session.current) void api.invoke("agent:close", { session: session.current }).catch(() => {});
      session.current = undefined;
    };
  }, [props.cluster.handle, attempt, opening.n]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A change arrived or moved on: keep the newest copy; announce arrivals and verdicts (D8, D46). */
  function change(c: AgentChange) {
    setChanges((cs) => {
      const at = cs.findIndex((x) => x.id === c.id);
      return at >= 0 ? cs.map((x, i) => (i === at ? c : x)) : [...cs, c];
    });
    if (c.state === "waiting") {
      const risks = riskWords(c);
      setAlert(`${agent} proposes a change and is waiting for you: ${c.title}.${risks.length ? ` ${risks.join(", ")}.` : ""}`);
      setPanel(undefined);
      requestAnimationFrame(() => document.getElementById(`change-${c.id}`)?.scrollIntoView({ block: "start" }));
    } else if (c.state !== "applying") {
      setStatus(c.state === "applied" ? `Applied: ${c.result ?? c.title}` : `${c.state[0]!.toUpperCase()}${c.state.slice(1)}: ${c.title}`);
    }
  }

  // Braces matter: Chromium's scrollIntoView now returns a Promise, which React would take for a cleanup function.
  // While a change waits, the card's top stays where D7 put it: no following the bottom.
  useEffect(() => {
    if (!waiting.length) void bottom.current?.scrollIntoView({ block: "end" });
  }, [items, asks, plan, waiting.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // The 2-minute warning, once per change (D8).
  useEffect(() => {
    const timers = waiting.map((c) => {
      const t = Date.parse(c.expiresAt) - 120_000 - Date.now();
      return t > 0 ? setTimeout(() => setAlert("This change expires in 2 minutes."), t) : undefined;
    });
    return () => timers.forEach((t) => t && clearTimeout(t));
  }, [waiting.map((c) => c.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // "1 change is waiting" above the composer when the card is scrolled away (D10).
  useEffect(() => {
    const first = waiting[0];
    const el = first ? document.getElementById(`change-${first.id}`) : null;
    if (!el || !body.current) return setCardHidden(undefined);
    const io = new IntersectionObserver(([e]) => {
      if (!e || e.isIntersecting) return setCardHidden(undefined);
      setCardHidden(e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? "up" : "down");
    }, { root: body.current });
    io.observe(el);
    return () => io.disconnect();
  }, [waiting.map((c) => c.id).join(), items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (info && props.pending && sent.current !== props.pending.id) {
      sent.current = props.pending.id;
      // Busy with a turn: the question waits in the box with its chips, and sending is left to you (D64).
      if (busy) setDraft(props.pending.text);
      else void send(props.pending.text);
    }
  }, [info, props.pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const running = [...items].reverse().find((x) => x.type === "tool" && x.tool.status === "in_progress") as { tool: Tool } | undefined;
    props.onActivity(
      waiting.length ? `${agent} is waiting for you: ${waiting.length} change${waiting.length === 1 ? "" : "s"} to review`
        : asks.length ? `${agent} is waiting for you`
          : busy ? (running ? `${agent} is running ${running.tool.title.replace(/^mcp__landlens-kube__/, "").replace(/_/g, " ")}` : `${agent} is working`) : undefined,
    );
  }, [busy, asks.length, items, waiting.length]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || (kind === "user_message_chunk" && replaying.current)) {
      const text = (u.content as { type?: string; text?: string })?.type === "text" ? String((u.content as { text: string }).text) : "";
      if (!text) return;
      const t = Date.now();
      setItems((xs) => {
        const last = xs.at(-1);
        if (kind === "user_message_chunk") {
          if (last?.type === "user") return [...xs.slice(0, -1), { ...last, text: last.text + text }];
          return [...xs, { type: "user", text, context: [] }];
        }
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
    } else if (kind === "available_commands_update") {
      const list = Array.isArray(u.availableCommands) ? u.availableCommands : [];
      setCommands(list.flatMap((c: any) => typeof c?.name === "string" ? [{
        name: c.name, description: String(c.description ?? ""),
        ...(typeof c.input?.hint === "string" ? { hint: c.input.hint } : {}),
      }] : []));
    }
  }

  async function send(text: string) {
    const s = session.current;
    if (!s || !text.trim() || busy) return;
    // Quoted text from outside a namespace-limited session's namespaces stays here (L11).
    const context = props.context.filter((c) => inSession(c, info?.namespaces));
    setItems((xs) => [...xs, { type: "user", text, context }]);
    setDraft("");
    props.onContextChange([]);
    setBusy(true);
    try {
      const refs = context.flatMap((c) => (c.ref ? [c.ref] : []));
      const r = await api.invoke("agent:prompt", { session: s, text: withQuotes(text, context), ...(refs.length ? { context: refs } : {}) });
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

  const decide = (c: AgentChange, decision: "approve" | "reject", note?: string) => {
    setChanges((cs) => cs.map((x) => (x.id === c.id && decision === "approve" ? { ...x, state: "applying" } : x)));
    void api.invoke("agent:decide", { change: c.id, decision, ...(note ? { note } : {}) }).catch((e: ApiError) => {
      setItems((xs) => [...xs, { type: "note", text: e.message, tone: "bad" }]);
    });
  };

  /** Turn a connection's autonomous mode on or off in this session; main checks it and answers with the new state. */
  const setAuto = (provider: ConnProvider, on: boolean, scope?: { repos?: string[]; branch?: string; team?: string }) => {
    if (!info) return;
    setSheetError(undefined);
    void api.invoke("agent:autonomy", { session: info.session, provider, on, ...(scope ? { scope } : {}) }).then(
      (st: AutonomyState) => {
        setAutonomy((xs) => xs.map((x) => (x.provider === st.provider ? st : x)));
        if (on) setSheet(undefined);
        setStatus(on ? `${PROVIDER_NAME[provider]} autonomous is on` : `${PROVIDER_NAME[provider]} autonomous stopped`);
      },
      (e: ApiError) => setSheetError(e.message),
    );
  };

  /** Enter allows and Esc rejects the newest question, when the composer is empty. */
  const answerByKey = (e: React.KeyboardEvent) => {
    const newest = asks.at(-1);
    if (!newest || waiting.length || draft.trim() || (e.key !== "Enter" && e.key !== "Escape") || e.shiftKey) return false;
    const { allow, reject } = answerKeys(newest);
    const option = e.key === "Enter" ? allow : reject;
    if (!option) return false;
    e.preventDefault();
    e.stopPropagation();
    answer(newest, option);
    return true;
  };

  /**
   * Keys for a waiting change (D34–D38): only with exactly one waiting, no question from the agent, and an empty
   * composer. Esc rejects; Enter reveals what is still hidden, then approves a change that isn't dangerous. A note in
   * the composer rejects the oldest waiting change with it.
   */
  const keysLive = waiting.length === 1 && !asks.length && !draft.trim();
  const changeByKey = (e: React.KeyboardEvent) => {
    if (!waiting.length || (e.key !== "Enter" && e.key !== "Escape") || e.shiftKey) return false;
    if (draft.trim()) {
      if (e.key !== "Enter") return false;
      e.preventDefault();
      decide(waiting[0]!, "reject", draft.trim());
      setDraft("");
      return true;
    }
    if (!keysLive) return e.key === "Enter" ? (e.preventDefault(), true) : false;
    const c = waiting[0]!;
    const card = cards.current.get(c.id);
    e.preventDefault();
    e.stopPropagation();
    if (!card?.armed()) return true;
    if (e.key === "Escape") decide(c, "reject");
    else if (!card.reveal() && card.enterApproves()) decide(c, "approve");
    return true;
  };

  // The slash menu (D62–D71).
  const query = waiting.length || busy || slashClosed ? undefined : slashQuery(draft);
  const options = query !== undefined ? slashOptions(query, commands) : [];
  useEffect(() => setSlashActive(0), [query]);
  useEffect(() => setSlashClosed(false), [draft === ""]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (o: SlashOption) => {
    if (o.own) {
      setDraft("");
      if (o.name === "new") requestSwitch({ n: opening.n + 1 });
      else if (o.name === "history" || o.name === "resume") setPanel("history");
      else if (o.name === "settings") props.onOpenSettings?.();
      return;
    }
    if (o.hint) {
      setDraft(`/${o.name} `);
      setSlashClosed(true);
    } else void send(`/${o.name}`);
  };

  const slashByKey = (e: React.KeyboardEvent) => {
    if (query === undefined) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setSlashClosed(true);
      return true;
    }
    if (!options.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSlashActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      setDraft(`/${options[slashActive]!.name} `);
      setSlashClosed(true);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run(options[slashActive]!);
      return true;
    }
    return false;
  };

  /** New session or resume: asks first if this one is working or has a change waiting (D58). */
  function requestSwitch(to: Opening) {
    if (busy || waiting.length) setSwitchTo(to);
    else doSwitch(to);
  }
  function doSwitch(to: Opening | "settings") {
    setSwitchTo(undefined);
    if (to === "settings") return;
    setPanel(undefined);
    setInfo(undefined);
    setAutonomy([]);
    setSheet(undefined);
    setSheetError(undefined);
    setFailed(undefined);
    setItems([]);
    setPlan([]);
    setAsks([]);
    setChanges([]);
    setCommands([]);
    setBusy(false);
    setOpening(to);
  }

  const suggestions = props.suggestion ? [...SUGGESTIONS, props.suggestion] : SUGGESTIONS;
  const tag = info?.label.split(" · ")[0];
  const closeTitle = waiting.length ? `Close ${agent} (withdraws ${waiting.length} change${waiting.length === 1 ? "" : "s"})` : `Close ${agent}`;
  const renderChange = (c: AgentChange) => (
    <div id={`change-${c.id}`} key={c.id}>
      {isWaiting(c) ? (
        <ChangeCard
          ref={(k) => {
            if (k) cards.current.set(c.id, k);
            else cards.current.delete(c.id);
          }}
          change={c}
          agent={agent}
          keysLive={keysLive && waiting[0]?.id === c.id}
          onDecide={(d, note) => decide(c, d, note)}
          onOpenObject={props.onOpenObject}
          onNote={() => box.current?.focus()}
        />
      ) : <ChangeDone change={c} agent={agent} onOpenObject={props.onOpenObject} />}
    </div>
  );
  const placeholder = waiting.length ? `Or tell ${agent} what to change instead…`
    : asks.length ? `Reply to ${agent}…`
      : props.context.length ? "What do you want to know about it?"
        : commands.length ? "Ask about this cluster, or / for commands" : "Ask about this cluster";
  const noting = waiting.length > 0 && draft.trim().length > 0;

  return (
    <aside className="dock" aria-label="Claude Code">
      {props.grip}
      <div className="sr-only" role="alert">{alert}</div>
      <div className="sr-only" role="status">{status}</div>
      <header className="dock-head">
        {panel ? (
          <button className="icon-btn" aria-label="Back to the session" title="Back to the session" onClick={() => setPanel(undefined)}><Ic icon={ArrowLeft} size={15} /></button>
        ) : (
          <span className={"claude-tile" + (!info && !failed ? " starting" : "")}><Ic icon={Sparkles} size={16} /></span>
        )}
        <div className="dock-id">
          <div className="dock-title">{panel ? "History" : info || failed ? agent : opening.resume ? "Opening…" : `Starting ${agent}…`}</div>
          <div className="dock-sub">
            {panel ? (
              <><span>{props.cluster.context}</span>{histCount !== undefined ? <span className="dim">{histCount} session{histCount === 1 ? "" : "s"}</span> : null}</>
            ) : (
              <>
                <span className="scope"><Ic icon={ShieldCheck} size={11} />asks before changes</span>
                <span>{props.cluster.context}</span>
                {tag ? <span className="dim">{tag}</span> : null}
              </>
            )}
          </div>
        </div>
        <button className="icon-btn" aria-label="New session" title="New session" onClick={() => requestSwitch({ n: opening.n + 1 })}><Ic icon={SquarePen} size={15} /></button>
        {!panel ? <button className="icon-btn" aria-label="History" title="History" onClick={() => setPanel("history")}><Ic icon={History} size={15} /></button> : null}
        {!panel && info ? (
          <SessionMenu session={info.session} can={reportable} onSummary={() => setBrainSheet(true)}
            onNote={(n) => setItems((xs) => [...xs, { type: "note", text: n.text, ...(n.tone === "ok" ? {} : { tone: n.tone }) }])} />
        ) : null}
        <button className="icon-btn" onClick={props.onClose} aria-label={`Close ${agent}`} title={closeTitle}><Ic icon={X} size={15} /></button>
      </header>
      {/* The strip can't be dismissed, only stopped: it stays while History is open too (L3 of the part 3 review). */}
      <AutonomyStrip states={autonomy} onStop={(st) => setAuto(st.provider, false)} />
      {panel === "history" ? (
        <HistoryPanel
          context={props.cluster.context}
          {...(info ? { current: info.session } : {})}
          onBack={() => setPanel(undefined)}
          onCount={setHistCount}
          onResume={(e) => requestSwitch({ n: opening.n + 1, resume: e })}
        />
      ) : null}
      <div className="dock-body" ref={body}>
        {switchTo && switchTo !== "settings" ? (
          <div className="notice" role="alert">
            <div className="notice-body">
              <strong>{agent} is still working here.</strong>
              <p>Opening another session stops it{waiting.length ? ` and withdraws ${waiting.length} change${waiting.length === 1 ? "" : "s"}` : ""}.</p>
              <div className="ask-actions">
                <button className="secondary" autoFocus onClick={() => setSwitchTo(undefined)}>Stay</button>
                <button className="secondary" onClick={() => {
                  if (info) void api.invoke("agent:cancel", { session: info.session }).catch(() => {});
                  doSwitch(switchTo);
                }}>Stop and open</button>
              </div>
            </div>
          </div>
        ) : null}
        {failed ? (
          <div className="notice" role="alert">
            <Ic icon={CircleX} size={15} className="tone-bad" />
            <div className="notice-body">
              <strong>{opening.resume ? "That session can't be opened." : `${agent} is not available.`}</strong>
              <p>{failed}</p>
              <button className="secondary" onClick={() => {
                if (opening.resume) return doSwitch({ n: opening.n + 1 });
                setFailed(undefined);
                setInfo(undefined);
                setAttempt((a) => a + 1);
              }}>{opening.resume ? "Start a new session" : "Try again"}</button>
            </div>
          </div>
        ) : null}
        {!info && !failed && opening.resume ? (
          <div className="thinking-row" role="status"><span className="skel" style={{ width: "70%" }} /><span className="skel" style={{ width: "52%" }} /><span className="skel" style={{ width: "38%" }} /></div>
        ) : null}
        {info && !items.length && !opening.resume ? (
          <div className="dock-empty">
            <span className="claude-tile lg"><Ic icon={Sparkles} size={20} /></span>
            <h3>Ask about this cluster</h3>
            <p>Reads freely. Changes wait for your approval. No Secrets, no exec. <button className="link-btn" aria-expanded={fence} onClick={() => setFence((f) => !f)}>How it's fenced</button></p>
            {fence ? (
              <p className="fence-full">
                {agent} runs with your login but none of your settings, plugins or MCP servers. It reads this cluster only
                through Landlens: no Secrets, no exec, no internet. It can propose a change; Landlens checks it with a dry
                run and shows it to you first. Pick an object and use "Ask Claude", or ask here.
              </p>
            ) : null}
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} className="suggestion" onClick={() => void send(s)}><span>{s}</span><Ic icon={ArrowRight} size={14} /></button>
              ))}
            </div>
          </div>
        ) : null}
        <Transcript items={items} busy={busy} views={views} autonomous={autonomous} onOpenObject={props.onOpenObject}
          change={(id) => {
            const c = byTool.get(id);
            return c ? renderChange(c) : undefined;
          }} />
        {loose.map(renderChange)}
        {plan.length ? <Plan plan={plan} /> : null}
        {asks.map((p) => <AskCard key={p.request} ask={p} onAnswer={(o) => answer(p, o)} />)}
        {info && reportable.brain && !busy && !waiting.length && items.some((i) => i.type === "agent") ? <SummaryStrip onSummary={() => setBrainSheet(true)} /> : null}
        <div ref={bottom} />
      </div>
      <form className="dock-input" onSubmit={(e) => {
        e.preventDefault();
        if (noting) {
          decide(waiting[0]!, "reject", draft.trim());
          setDraft("");
        } else void send(draft);
      }}>
        {cardHidden && waiting.length ? (
          <button type="button" className="change-jump" onClick={() => document.getElementById(`change-${waiting[0]!.id}`)?.scrollIntoView({ block: "start" })}>
            <Ic icon={cardHidden === "up" ? ArrowUp : ArrowDown} size={12} />{waiting.length === 1 ? "1 change is waiting" : `${waiting.length} changes are waiting`}
          </button>
        ) : null}
        {query !== undefined && !panel ? (
          <SlashMenu query={query} options={options} active={slashActive} agent={agent} onHover={setSlashActive} onPick={run}
            short={(body.current?.clientHeight ?? 400) < 300} />
        ) : null}
        {sheet && !panel && autonomy.find((a) => a.provider === sheet) ? (
          <AutonomySheet key={sheet} state={autonomy.find((a) => a.provider === sheet)!} {...(sheetError ? { error: sheetError } : {})}
            onTurnOn={(scope) => setAuto(sheet, true, scope)}
            onStop={() => setAuto(sheet, false)}
            onClose={() => {
              setSheet(undefined);
              setSheetError(undefined);
              box.current?.focus();
            }} />
        ) : null}
        <div className="composer">
          {props.context.length ? (
            <div className="chips">
              {props.context.map((c) => (
                <span key={c.label} className={`chip ctx-chip${inSession(c, info?.namespaces) ? "" : " dim"}`} {...(c.text ? { title: inSession(c, info?.namespaces) ? quoteHead(c) : "Outside this session's namespaces: not sent" } : {})}>
                  <Ic icon={contextIcon(c)} size={11} />
                  {c.label}
                  <button type="button" aria-label={`Remove ${c.label}`} onClick={() => props.onContextChange(props.context.filter((x) => x !== c))}><Ic icon={X} size={11} /></button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={box}
            aria-label="Message Claude Code"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={query !== undefined}
            {...(query !== undefined ? { "aria-controls": "slash-menu", "aria-activedescendant": options.length ? `slash-${slashActive}` : undefined } : {})}
            placeholder={placeholder}
            value={draft}
            rows={2}
            disabled={!info}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setSlashClosed(true)}
            onFocus={() => setSlashClosed(false)}
            onKeyDown={(e) => {
              if (slashByKey(e)) return;
              if (changeByKey(e)) return;
              if (answerByKey(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          {noting ? (
            <div className="composer-hint"><Ic icon={Ban} size={12} />{waiting.length > 1 ? `Sending this rejects “${waiting[0]!.title}”.` : "Sending this rejects the change."}</div>
          ) : null}
          {!noting && info && autonomy.length ? (
            <div className="auto-row" role="group" aria-label="GitHub and Linear in this session">
              <AutonomyChips states={autonomy} {...(sheet ? { open: sheet } : {})} onOpen={(p) => {
                setSheetError(undefined);
                setSheet(p);
              }} />
            </div>
          ) : null}
          <div className="composer-foot">
            {info?.mode && !noting ? (
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
            {!noting ? info?.options.filter((o) => o.id === "model").map((o) => (
              <label className="pill-select" key={o.id}>
                <span className="sr-only">{o.name}</span>
                <select defaultValue={o.current} onChange={(e) => void api.invoke("agent:config", { session: info.session, config: o.id, value: e.target.value })}>
                  {o.choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <Ic icon={ChevronDown} size={11} />
              </label>
            )) : null}
            <span className="grow" />
            {busy && (asks.length || waiting.length) && !noting ? <span className="dock-state waiting" aria-live="polite" title="Waiting for you"><i className="pulse" /><span className="state-word">Waiting for you</span></span>
              : busy && !noting ? <span className="dock-state" aria-live="polite" title="Working"><span className="spinner" /><span className="state-word">Working…</span></span> : null}
            {busy ? (
              <button type="button" className="stop" disabled={applying}
                title={applying ? "The change is being applied" : waiting.length ? `Stop ${agent} and withdraw the change` : `Stop ${agent}`}
                onClick={() => info && void api.invoke("agent:cancel", { session: info.session })}><Ic icon={X} size={12} />Stop</button>
            ) : null}
            {noting ? (
              <button type="submit" className="primary"><Ic icon={Ban} size={13} />Reject with note<kbd aria-hidden="true">↵</kbd></button>
            ) : !busy ? (
              <button type="submit" className="primary" disabled={!info || !draft.trim()}><Ic icon={ArrowUp} size={13} />Send<kbd aria-hidden="true">↵</kbd></button>
            ) : null}
          </div>
        </div>
      </form>
      {brainSheet && info ? (
        <BrainSheet session={info.session} onClose={() => setBrainSheet(false)}
          onAsk={() => setItems((xs) => [...xs, { type: "note", text: "Landlens asked for a summary for your brain (its own fixed question)." }])} />
      ) : null}
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
