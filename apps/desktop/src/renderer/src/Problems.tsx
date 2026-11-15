// The Problems page and its drawer (wave 5, D57–D60; docs/doctor.md). Everything here is the doctor's report from
// cluster:health, which main works out as you; the drawer's Logs tab asks main for the one problem's evidence
// (doctor:evidence), by its id only. Text written by workloads (event and termination messages, log lines) is shown
// as text, never as markup.
import type { ClusterHealth, DoctorEvidence, Problem } from "@landlens/contracts";
import { age } from "@landlens/kube/status";
import { missingChecks } from "@landlens/kube/checks";
import {
  CircleCheck, CircleX, Clock, Info, Lock, ScrollText, Sparkles, SquareArrowOutUpRight, Stethoscope, TriangleAlert, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type ApiError } from "./api";
import type { NavTarget } from "./Details";
import { Ic, iconOfKind } from "./icons";
import { plural } from "./health";
import { classCounts, filterProblems, hasLogs, sections, subjectOf, type HeldProblem, type Severity } from "./problemRules";
import type { ProblemClass } from "@landlens/contracts";

const when = (iso: string | undefined, now: number) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? `${age(t, now)} ago` : undefined;
};
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One sentence per check the doctor couldn't make (D56), so "no problems" never reads as "all clear". */
export function ChecksStrip({ h }: { h: ClusterHealth }) {
  const missing = missingChecks(h.checks);
  if (!missing.length) return null;
  return (
    <div className="notice pb-checks" role="status">
      <Ic icon={Info} size={15} className="tone-warn" />
      <div className="notice-body">
        <strong>Some checks were skipped</strong>
        {missing.map((m) => <p key={m}>{m}</p>)}
      </div>
    </div>
  );
}

export function ProblemsPage(props: {
  health?: ClusterHealth;
  error?: ApiError;
  now: number;
  /** The toolbar's filter text. */
  text: string;
  severity: Severity;
  onSeverity: (s: Severity) => void;
  selected?: string;
  onSelect: (p: Problem) => void;
  onAsk: (p: Problem) => void;
  onOpen: (p: Problem) => void;
  onClearText: () => void;
  /** The last refresh failed (L2). */
  stale?: string;
}) {
  const { health: h, now } = props;
  const [cls, setCls] = useState<ProblemClass>();
  const list = useRef<HTMLDivElement>(null);
  const all = h?.problems ?? [];
  const shown = useMemo(() => filterProblems(all, { severity: props.severity, ...(cls ? { cls } : {}), text: props.text }), [all, props.severity, cls, props.text]);
  const chips = useMemo(() => classCounts(all, props.severity), [all, props.severity]);
  // A chip whose class has gone (or that the severity hides) stops filtering.
  useEffect(() => {
    if (cls && !chips.some((c) => c.cls === cls)) setCls(undefined);
  }, [chips, cls]);

  if (!h && props.error) {
    return (
      <div className="pb">
        <div className="notice" role="alert">
          <Ic icon={props.error.status === 403 ? Lock : CircleX} size={15} className={props.error.status === 403 ? "dim" : "tone-bad"} />
          <div className="notice-body">
            <strong>{props.error.status === 403 ? "You don't have access to this cluster's pods, so Landlens can't check it." : "Couldn't check this cluster."}</strong>
            <p>{props.error.message}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!h) return <div className="pb" aria-busy="true" aria-label="Loading problems">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 52, borderRadius: 10, margin: "12px 16px" }} />)}</div>;

  const bad = all.filter((p) => p.tone === "bad").length;
  const counts: Record<Severity, number> = { all: all.length, bad, warn: all.length - bad };
  const filtered = !!(cls || props.text.trim() || props.severity !== "all");

  /** ↑/↓ move between rows, Enter opens the drawer, `a` asks Claude. */
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".pb-row");
    if (!row || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...(list.current?.querySelectorAll<HTMLElement>(".pb-row") ?? [])];
      rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      return;
    }
    const p = shown.find((x) => x.id === row.dataset.id);
    if (!p || e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") (e.preventDefault(), props.onSelect(p));
    else if (e.key === "a") (e.preventDefault(), props.onAsk(p));
  };

  return (
    <div className="pb">
      <div className="pb-filters">
        <div className="seg" role="group" aria-label="Severity">
          {([["all", "All"], ["bad", "Failing"], ["warn", "To watch"]] as const).map(([v, word]) => (
            <button key={v} className={props.severity === v ? "on" : ""} aria-pressed={props.severity === v} onClick={() => props.onSeverity(v)}>
              {v !== "all" ? <i className={`dot tone-${v}`} aria-hidden="true" /> : null}
              <span>{word}</span> <b>{counts[v]}</b>
            </button>
          ))}
        </div>
        {chips.length > 1 || cls ? (
          <div className="chips pb-chips" role="group" aria-label="Kind of problem">
            {chips.map((c) => (
              <button key={c.cls} className={"chip pb-chip" + (cls === c.cls ? " on" : "")} aria-pressed={cls === c.cls} onClick={() => setCls(cls === c.cls ? undefined : c.cls)}>
                {c.label}<b>{c.n}</b>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {props.stale ? (
        <div className="notice pb-checks" role="status">
          <Ic icon={CircleX} size={15} className="tone-warn" />
          <div className="notice-body"><strong>Couldn't check again; this is what was read {when(h.at, now) ?? "earlier"}.</strong><p>{props.stale}</p></div>
        </div>
      ) : null}
      <ChecksStrip h={h} />
      {!all.length ? (
        <div className="ov-empty pb-empty"><Ic icon={CircleCheck} size={22} /><span>No problems found</span><span className="dim small">Checked {when(h.at, now) ?? "just now"}.</span></div>
      ) : !shown.length ? (
        <div className="ov-empty pb-empty">
          <span>No problems match</span>
          {filtered ? <button className="secondary" onClick={() => (setCls(undefined), props.onSeverity("all"), props.onClearText())}>Clear filters</button> : null}
        </div>
      ) : (
        <div className="pb-list" ref={list} onKeyDown={onKey}>
          {sections(shown).map((s) => (
            <section key={s.tone} className="pb-sec" aria-label={s.label}>
              <h3 className="pb-sec-head"><Ic icon={s.tone === "bad" ? CircleX : TriangleAlert} size={13} className={`tone-${s.tone}`} />{s.label}<span className="count-badge">{s.items.length}</span></h3>
              <ul className="ov-list">
                {s.items.map((p) => <ProblemRow key={p.id} p={p} now={now} on={p.id === props.selected} onSelect={props.onSelect} onAsk={props.onAsk} onOpen={props.onOpen} />)}
              </ul>
            </section>
          ))}
          {h.cut ? <p className="small dim pb-cut">Showing the first 500.</p> : null}
        </div>
      )}
    </div>
  );
}

function ProblemRow({ p, now, on, onSelect, onAsk, onOpen }: { p: Problem; now: number; on: boolean; onSelect: (p: Problem) => void; onAsk: (p: Problem) => void; onOpen: (p: Problem) => void }) {
  const since = when(p.since, now);
  return (
    <li className={"ov-row pb-row" + (on ? " on" : "")} tabIndex={0} role="button" data-id={p.id} aria-current={on ? "true" : undefined}
      aria-label={`${p.tone === "bad" ? "Failing" : "To watch"}: ${p.title}. ${subjectOf(p)}`}
      onClick={() => onSelect(p)}>
      <span className={`kind-tile sm ${p.tone}`}><Ic icon={iconOfKind(p.kind)} size={14} /></span>
      <div className="ov-main">
        <div className="ov-name">
          <span className="pb-title">{p.title}</span>
          <span className="ov-kind">{p.kind}</span>
          {p.namespace ? <span className="dim">{p.namespace}</span> : null}
        </div>
        <div className="ov-detail mono" title={p.detail}>{p.detail}</div>
      </div>
      {since ? <span className="ev-meta pb-since" title={p.since}>{since}</span> : null}
      <button className="ghost-btn" tabIndex={-1} onClick={(e) => (e.stopPropagation(), onAsk(p))} aria-label={`Ask Claude about ${p.name}`} title="Ask Claude (a)"><Ic icon={Sparkles} size={13} />Ask</button>
      <button className="ghost-btn" tabIndex={-1} onClick={(e) => (e.stopPropagation(), onOpen(p))} aria-label={`Open ${subjectOf(p)}`} title={`Open the ${p.kind}`}><Ic icon={SquareArrowOutUpRight} size={13} />Open</button>
    </li>
  );
}

type Tab = "summary" | "events" | "logs";

export function ProblemDrawer(props: {
  handle: string;
  namespace: string;
  held: HeldProblem;
  /** The report was cut at 500: a problem that left it may still be there (part 3 review, L1). */
  cut?: boolean;
  /** The last refresh failed: what is shown is older than it looks (L2). */
  stale?: string;
  now: number;
  onClose: () => void;
  /** With the log lines this drawer has read, if any, for the brief. */
  onAsk: (p: Problem, evidence?: DoctorEvidence) => void;
  onOpen: (p: Problem) => void;
  onNavigate: (t: NavTarget) => void;
  /** The pod's Details → Logs. */
  onFullLogs: (pod: string, namespace: string | undefined, container: string) => void;
}) {
  const p = props.held.last;
  const logs = hasLogs(p);
  const tabs: Tab[] = logs ? ["summary", "events", "logs"] : ["summary", "events"];
  const [tab, setTab] = useState<Tab>("summary");
  // The evidence for one problem: read when the Logs tab is first opened, kept when you switch tabs (its answer is
  // never dropped), and read again on "Read again" or after an error (part 3 review, L3).
  const [ev, setEv] = useState<{ id: string; e?: DoctorEvidence; error?: ApiError; at?: number }>();
  const [again, setAgain] = useState(0);
  const current = useRef(p.id);
  current.current = p.id;
  useEffect(() => setTab("summary"), [p.id]);
  useEffect(() => {
    if (tab === "logs" && !logs) setTab("summary");
  }, [tab, logs]);
  // [ and ] step through the tabs, as in the object drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "[" && e.key !== "]")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable]") || t.closest(".dock"))) return;
      setTab((cur) => tabs[(tabs.indexOf(cur) + (e.key === "]" ? 1 : tabs.length - 1)) % tabs.length]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab !== "logs" || props.held.goneAt) return;
    const id = p.id;
    if (ev?.id === id && (ev.e || !ev.error) && !again) return; // read, or being read
    setAgain(0);
    setEv({ id });
    api.invoke("doctor:evidence", { handle: props.handle, ...(props.namespace ? { namespace: props.namespace } : {}), id }).then(
      (e) => current.current === id && setEv({ id, e, at: Date.now() }),
      (error: ApiError) => current.current === id && setEv({ id, error, at: Date.now() }),
    );
  }, [tab, p.id, again, props.handle, props.namespace]); // eslint-disable-line react-hooks/exhaustive-deps

  const since = when(p.since, props.now);
  return (
    <aside className="drawer pb-drawer" aria-label={`Problem: ${p.title}`}>
      <header className="drawer-head">
        <div className="drawer-top">
          <span className={`kind-tile sm ${p.tone}`}><Ic icon={Stethoscope} size={15} /></span>
          <div className="eyebrow">Problem<span className="sep"> / </span>{p.kind}{p.namespace ? <><span className="sep"> / </span>{p.namespace}</> : null}</div>
          <span className="grow" />
          <button className="ask-btn" onClick={() => props.onAsk(p, ev?.id === p.id ? ev.e : undefined)}><Ic icon={Sparkles} size={14} />Ask Claude</button>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close problem" title="Close (Esc)"><Ic icon={X} size={15} /></button>
        </div>
        <h2 className="drawer-title">{p.title}</h2>
        <div className="drawer-meta">
          <span className={`badge ${p.tone}`}><Ic icon={p.tone === "bad" ? CircleX : Clock} size={13} />{p.reason}</span>
          <span className="meta mono">{p.name}</span>
          {p.podCount ? <span className="meta"><b className="mono">{p.podCount}</b> {p.podCount === 1 ? "pod" : "pods"}</span> : null}
          {since ? <span className="meta">since <b className="mono">{since.replace(/ ago$/, "")}</b> ago</span> : null}
          <span className="grow" />
          <button className="secondary pb-open" onClick={() => props.onOpen(p)}><Ic icon={iconOfKind(p.kind)} size={13} />Open {p.kind}</button>
        </div>
      </header>
      {props.held.goneAt ? (
        props.cut ? (
          <div className="notice pb-gone" role="status">
            <Ic icon={Info} size={15} className="dim" />
            <div className="notice-body"><strong>Not in the first 500 problems since {clock(props.held.goneAt)}.</strong><p>It may still be failing. This is the last evidence Landlens saw.</p></div>
          </div>
        ) : (
          <div className="notice pb-gone" role="status">
            <Ic icon={CircleCheck} size={15} className="tone-ok" />
            <div className="notice-body"><strong>No longer found at {clock(props.held.goneAt)}.</strong><p>This is the last evidence Landlens saw.</p></div>
          </div>
        )
      ) : props.stale ? (
        <div className="notice pb-gone" role="status">
          <Ic icon={CircleX} size={15} className="tone-warn" />
          <div className="notice-body"><strong>Couldn't check again.</strong><p>This is what Landlens saw last.</p></div>
        </div>
      ) : null}
      <nav className="tabs" role="tablist" aria-label="Problem">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "events" ? <>Events{p.facts.events.length ? <span className="count">{p.facts.events.length}</span> : null}</> : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      <div className={"drawer-body" + (tab === "logs" ? " flush" : "")}>
        {tab === "summary" ? <Summary p={p} now={props.now} onNavigate={props.onNavigate} />
          : tab === "events" ? <ProblemEvents p={p} now={props.now} />
          : <Evidence p={p} state={ev?.id === p.id ? ev : undefined} gone={!!props.held.goneAt} now={props.now} onAgain={() => setAgain((n) => n + 1)} onFull={props.onFullLogs} />}
      </div>
    </aside>
  );
}

function Summary({ p, now, onNavigate }: { p: Problem; now: number; onNavigate: (t: NavTarget) => void }) {
  const f = p.facts;
  const ls = f.lastState;
  const cert = f.cert;
  const rows: [string, React.ReactNode][] = [];
  if (p.container) rows.push(["Container", <span className="mono">{p.container}</span>]);
  if (ls) {
    const parts = [ls.reason, ls.exitCode !== undefined ? `exit ${ls.exitCode}` : "", ls.signal !== undefined ? `signal ${ls.signal}` : ""].filter(Boolean).join(" · ");
    rows.push(["Last run", <><span className="mono">{parts || "—"}</span>{ls.finishedAt ? <span className="dim"> · ended {when(ls.finishedAt, now)}</span> : null}</>]);
    if (ls.message) rows.push(["Message", <span className="pb-msg">{ls.message}</span>]);
  }
  if (p.restarts !== undefined) rows.push(["Restarts", <span className="mono">{p.restarts}</span>]);
  if (f.image) rows.push(["Image", <span className="mono">{f.image}</span>]);
  if (f.limit) rows.push(["Memory limit", <span className="mono">{f.limit}</span>]);
  if (f.scheduling) rows.push(["Scheduling", <span className="pb-msg">{f.scheduling}</span>]);
  if (f.nodeSelector?.length) rows.push(["Node selector", <span className="mono">{f.nodeSelector.join(", ")}</span>]);
  if (f.probe) {
    const pr = f.probe;
    const timing = [pr.period !== undefined ? `every ${pr.period}s` : "", pr.timeout !== undefined ? `timeout ${pr.timeout}s` : "", pr.failureThreshold !== undefined ? `fails after ${pr.failureThreshold}` : ""].filter(Boolean).join(" · ");
    rows.push(["Probe", <><span className="mono">{pr.type} · {pr.how}</span>{timing ? <span className="dim"> · {timing}</span> : null}</>]);
    if (pr.lastMessage) rows.push(["Last failure", <span className="pb-msg">{pr.lastMessage}</span>]);
  }
  if (f.available) rows.push(["Available", <span className="mono">{f.available}</span>]);
  if (cert) {
    if (cert.unreadable) rows.push(["Certificate", "Couldn't be read"]);
    else {
      rows.push(["Subject", <span className="mono">{cert.subject || "—"}</span>]);
      rows.push(["Issuer", <span className="mono">{cert.issuer || "—"}{cert.selfSigned ? <span className="dim"> (self-signed)</span> : null}</span>]);
      if (cert.sans.length) rows.push(["Names", <span className="mono">{cert.sans.join(", ")}</span>]);
      rows.push(["Not before", <span className="mono">{cert.notBefore.replace("T", " ").replace(/\.\d+/, "")}</span>]);
      rows.push(["Not after", <><span className="mono">{cert.notAfter.replace("T", " ").replace(/\.\d+/, "")}</span><span className="dim"> · {cert.which === "leaf" ? "the certificate itself" : "a certificate in its chain"}</span></>]);
    }
  }
  if (f.usedBy?.length) rows.push(["Used by", <span className="mono">{f.usedBy.join(", ")}</span>]);
  return (
    <div className="overview pb-summary">
      <section className="pb-hint" aria-label="Likely cause">
        <h3>Likely cause</h3>
        <p>{p.hint.cause}</p>
        {p.hint.next.length ? <ul>{p.hint.next.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        <p className="small dim">From Landlens's rules, not from Claude.</p>
      </section>
      <p className="ov-detail mono pb-detail" title={p.detail}>{p.detail}</p>
      {rows.length ? <dl className="facts pb-facts">{rows.map(([k, v]) => [<dt key={`t${k}`}>{k}</dt>, <dd key={`d${k}`}>{v}</dd>])}</dl> : null}
      {p.pods.length ? (
        <section>
          <h3>Pods <span className="count">{p.podCount}</span></h3>
          <div className="helm-objects">
            {p.pods.map((name) => (
              <button key={name} className="ref" onClick={() => onNavigate({ kind: "Pod", name, ...(p.namespace ? { namespace: p.namespace } : {}) })}>
                <Ic icon={iconOfKind("Pod")} size={12} />{name}
              </button>
            ))}
          </div>
          {p.podCount > p.pods.length ? <p className="small dim">and {plural(p.podCount - p.pods.length, "more pod")}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

function ProblemEvents({ p, now }: { p: Problem; now: number }) {
  if (!p.facts.events.length) return <p className="muted-line">No events about this. Kubernetes keeps events for about an hour.</p>;
  return (
    <ul className="ev-list" aria-label="Events">
      {p.facts.events.map((e, i) => (
        <li key={i} className="ev-row">
          <i className="diamond" aria-hidden="true" />
          <div className="ev-main"><strong>{e.reason}</strong><div className="ev-msg">{e.message}</div></div>
          <span className="ev-meta">{e.count > 1 ? `×${e.count} · ` : ""}{when(e.at, now) ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

function Evidence({ p, state, gone, now, onAgain, onFull }: {
  p: Problem; state?: { e?: DoctorEvidence; error?: ApiError; at?: number }; gone: boolean; now: number; onAgain: () => void;
  onFull: (pod: string, namespace: string | undefined, container: string) => void;
}) {
  const again = gone ? null : <button className="link-btn" onClick={onAgain}>Read again</button>;
  if (!state) return <p className="muted-line pb-pad">{gone ? "This problem is gone, so its logs aren't read." : "Reading the logs…"}</p>;
  if (state.error) return <p className="muted-line pb-pad">{state.error.status === 404 ? "This problem is no longer in the report." : state.error.status === 429 ? "Too many log reads at once." : `Couldn't read the logs: ${state.error.message}`} {again}</p>;
  if (!state.e) return <p className="muted-line pb-pad">Reading the logs…</p>;
  const log = state.e.log;
  if (!log) return <p className="muted-line pb-pad">No logs for this problem.</p>;
  if ("error" in log) return <p className="muted-line pb-pad">{log.error} {again}</p>;
  return (
    <div className="logs-pane">
      <div className="logs-note">
        <Ic icon={ScrollText} size={13} />
        <span>{log.previous ? "The previous run" : "The current run"} of <b className="mono">{log.container}</b> in <b className="mono">{log.pod}</b>, last {plural(log.lines.length, "line")}{log.cut ? " (cut)" : ""}{state.at ? `, read ${when(new Date(state.at).toISOString(), now)}` : ""}</span>
        <span className="grow" />
        {again}
        <button className="link-btn" onClick={() => onFull(log.pod, p.namespace, log.container)}>Open full logs</button>
      </div>
      <pre className="logs" tabIndex={0} aria-label="Log lines">{log.lines.length ? log.lines.map((l, i) => <div key={i} className="ll"><span className="tx">{l}</span></div>) : <div className="logs-end">The run wrote nothing.</div>}</pre>
    </div>
  );
}
