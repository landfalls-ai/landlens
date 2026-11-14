// Past agent sessions on this cluster, in a panel over the dock's body (wave 3, D49–D61). Claude Code keeps the
// transcripts; Landlens keeps the list. Resume replays a session into the dock.
import type { AgentHistoryEntry } from "@landlens/contracts";
import { History, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";

export function whenText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const mins = Math.round((now - t) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const d = new Date(t);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now - t < 6 * 86_400_000) return `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function group(iso: string, now = Date.now()): "Today" | "Yesterday" | "Earlier" {
  const d = new Date(iso).toDateString();
  if (d === new Date(now).toDateString()) return "Today";
  if (d === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return "Earlier";
}

export function HistoryPanel({ context, current, onResume, onBack, onCount }: {
  context: string;
  /** The open session, which is marked and can't be deleted (D54). */
  current?: string;
  onResume: (e: AgentHistoryEntry) => void;
  onBack: () => void;
  onCount: (n: number) => void;
}) {
  const [entries, setEntries] = useState<AgentHistoryEntry[]>();
  const [failed, setFailed] = useState<string>();
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<string>();
  const [all, setAll] = useState(false);
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const load = () => api.invoke("agent:history", { context }).then(({ sessions }) => {
    setEntries(sessions);
    onCount(sessions.length);
  }, (e: ApiError) => setFailed(e.message));
  useEffect(() => {
    void load();
  }, [context]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (entries ?? []).filter((e) => !query || (e.title || "Untitled session").toLowerCase().includes(query.toLowerCase())), [entries, query]);
  useEffect(() => {
    if (!entries) return;
    if (entries.length > 8) search.current?.focus();
    else (list.current?.querySelector(".hist-open") as HTMLButtonElement | null)?.focus();
  }, [entries === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const forget = async (sessions: string[]) => {
    for (const s of sessions) await api.invoke("agent:forget", { session: s }).catch(() => {});
    setConfirm(undefined);
    setAll(false);
    await load();
  };

  const focusRow = (i: number) => {
    const rows = list.current?.querySelectorAll<HTMLButtonElement>(".hist-open");
    if (!rows?.length) return;
    const n = (i + rows.length) % rows.length;
    setActive(n);
    rows[n]!.focus();
  };

  if (entries && !entries.length) {
    return (
      <div className="dock-panel" role="region" aria-label="Session history">
        <div className="hist-empty">
          <span className="kind-tile"><Ic icon={History} size={18} /></span>
          <strong>No past sessions on {context}</strong>
          <p>A session is saved here once you ask something. It holds what the agent read, so it stays on this Mac.</p>
          <button className="secondary" onClick={onBack} autoFocus>Back to the session</button>
        </div>
      </div>
    );
  }

  let lastGroup = "";
  return (
    <div className="dock-panel" role="region" aria-label="Session history" onKeyDown={(e) => {
      if (e.key === "Escape" && !confirm && !all) {
        e.preventDefault();
        onBack();
      }
    }}>
      {failed ? <div className="notice" role="alert"><p>{failed}</p></div> : null}
      {(entries?.length ?? 0) > 8 ? (
        <div className="hist-tools">
          <label className="field"><Ic icon={Search} size={14} /><input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions" aria-label="Search sessions"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                focusRow(0);
              }
            }} /></label>
        </div>
      ) : null}
      <ul className="hist-list" ref={list} aria-label={`Past sessions on ${context}`}>
        {query && !shown.length ? <li className="dim" style={{ textAlign: "center", padding: 16 }}>No session matches “{query}”.</li> : null}
        {shown.map((e, i) => {
          const g = group(e.updatedAt);
          const label = g !== lastGroup ? <div className="hist-label">{g}</div> : null;
          lastGroup = g;
          const title = e.title || "Untitled session";
          const on = e.session === current;
          if (confirm === e.session) {
            return (
              <li key={e.session}>
                {label}
                <div className="hist-confirm" onKeyDown={(k) => {
                  if (k.key === "Escape") {
                    k.preventDefault();
                    k.stopPropagation();
                    setConfirm(undefined);
                  }
                }}>
                  <span>Delete “{title}”?</span>
                  <button className="secondary" autoFocus onClick={() => setConfirm(undefined)}>Keep</button>
                  <button className="danger" onClick={() => void forget([e.session])}>Delete</button>
                </div>
              </li>
            );
          }
          return (
            <li key={e.session}>
              {label}
              <div className={"hist-row" + (on ? " on" : "")} aria-current={on ? "true" : undefined}>
                <button className="hist-open" tabIndex={i === active ? 0 : -1} onClick={() => !on && onResume(e)} aria-label={`${title}, ${whenText(e.updatedAt)}`}
                  onKeyDown={(k) => {
                    if (k.key === "ArrowDown" || k.key === "ArrowUp") {
                      k.preventDefault();
                      focusRow(i + (k.key === "ArrowDown" ? 1 : -1));
                    } else if ((k.key === "Delete" || k.key === "Backspace") && !on) {
                      k.preventDefault();
                      setConfirm(e.session);
                    }
                  }}>
                  <span className="hist-title"><span>{title}</span>{on ? <span className="pill">open</span> : null}</span>
                  <span className="hist-meta">
                    <span>{whenText(e.updatedAt)}</span>
                    <span className="sep">·</span><span>{e.prompts} message{e.prompts === 1 ? "" : "s"}</span>
                    {e.applied ? <><span className="sep">·</span><span className="chg">{e.applied} change{e.applied === 1 ? "" : "s"}</span></> : null}
                    {e.agent !== "Claude Code" ? <><span className="sep">·</span><span>{e.agent}</span></> : null}
                  </span>
                </button>
                {!on ? <button className="icon-btn hist-del" aria-label={`Delete “${title}”`} title="Delete" onClick={() => setConfirm(e.session)}><Ic icon={Trash2} size={14} /></button> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="hist-foot">
        {all ? (
          <>
            <span>Delete all {(entries ?? []).filter((e) => e.session !== current).length} sessions on {context}?</span>
            <button className="secondary" autoFocus onClick={() => setAll(false)}>Keep</button>
            <button className="danger" onClick={() => void forget((entries ?? []).filter((e) => e.session !== current).map((e) => e.session))}>Delete all</button>
          </>
        ) : (
          <>
            <span>Kept on this Mac, per cluster.</span>
            {(entries ?? []).some((e) => e.session !== current) ? <button className="link-btn" onClick={() => setAll(true)}>Delete all…</button> : null}
          </>
        )}
      </div>
    </div>
  );
}
