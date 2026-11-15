// The status bar: connection, what is being watched, what Claude is doing, and the problem counts (to Overview).
import { Activity, ArrowLeftRight, CircleX, Database, History, LoaderCircle, PlugZap, Sparkles, SquareTerminal, TriangleAlert } from "lucide-react";
import { Ic } from "./icons";

export function StatusBar(props: { server: string; watching: string; claude?: string; bad: number; warn: number; onProblems: (tone: "bad" | "warn") => void; clickland?: boolean; onMetrics: () => void; sessions?: number; panelOpen?: boolean; onSessions?: () => void; forwards?: number; onForwards?: () => void; actions?: number; actionsOpen?: boolean; onActions?: () => void; drains?: { run: string; node: string }[]; onDrain?: (run: string) => void }) {
  return (
    <footer className="statusbar">
      <span className="sb-item"><i className="dot tone-ok" aria-hidden="true" />Connected</span>
      <span className="sb-item mono sb-url">{props.server}</span>
      <span className="sb-item"><Ic icon={Activity} size={11} />{props.watching}</span>
      <span className="grow" />
      {props.sessions ? (
        <button className="sb-item sessions" onClick={props.onSessions} title={props.panelOpen ? "Go to the panel (⌘`)" : "Show the panel (⌘`)"}><Ic icon={SquareTerminal} size={11} />{props.sessions} session{props.sessions === 1 ? "" : "s"}</button>
      ) : null}
      {props.forwards ? (
        <button className="sb-item forwards" onClick={props.onForwards} title="Port forwards"><Ic icon={ArrowLeftRight} size={11} />{props.forwards} forward{props.forwards === 1 ? "" : "s"}</button>
      ) : null}
      {/* A drain running in main (security review of part 2, M4): its sheet, with Stop, is one click away. */}
      {(props.drains ?? []).map((d) => (
        <button key={d.run} className="sb-item drain-run" onClick={() => props.onDrain?.(d.run)} title={`Drain of ${d.node} running: open it (Stop is there)`} aria-label={`Draining ${d.node}: open the drain`}>
          <Ic icon={LoaderCircle} size={11} className="spin" />Draining {d.node}
        </button>
      ))}
      {props.onActions ? (
        <button className="sb-item actions" onClick={props.onActions} aria-expanded={!!props.actionsOpen} title="Recent actions" aria-label={`Recent actions${props.actions ? `, ${props.actions} since Landlens started` : ""}`}>
          <Ic icon={History} size={11} />{props.actions ? props.actions : null}
        </button>
      ) : null}
      <button className="sb-item metrics" onClick={props.onMetrics} title={props.clickland ? "Metrics from Clickland: settings" : "Connect Clickland for metrics history"}>
        <Ic icon={props.clickland ? Database : PlugZap} size={11} />{props.clickland ? "Clickland" : "Connect Clickland"}
      </button>
      {props.claude ? <span className="sb-item claude" aria-live="polite" title={props.claude}><Ic icon={Sparkles} size={11} /><span className="sb-text">{props.claude}</span></span> : null}
      {props.bad ? (
        <button className="sb-item bad" onClick={() => props.onProblems("bad")} title={`${props.bad} failing: open Problems`} aria-label={`${props.bad} failing, open Problems`}>
          <Ic icon={CircleX} size={11} />{props.bad}
        </button>
      ) : null}
      {props.warn ? (
        <button className="sb-item warn" onClick={() => props.onProblems("warn")} title={`${props.warn} to watch: open Problems`} aria-label={`${props.warn} to watch, open Problems`}>
          <Ic icon={TriangleAlert} size={11} />{props.warn}
        </button>
      ) : null}
    </footer>
  );
}
