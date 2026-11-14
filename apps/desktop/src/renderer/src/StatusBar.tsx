// The status bar: connection, what is being watched, what Claude is doing, and the problem counts (to Overview).
import { Activity, CircleX, Sparkles, TriangleAlert } from "lucide-react";
import { Ic } from "./icons";

export function StatusBar(props: { server: string; watching: string; claude?: string; bad: number; warn: number; onProblems: () => void }) {
  return (
    <footer className="statusbar">
      <span className="sb-item"><i className="dot tone-ok" aria-hidden="true" />Connected</span>
      <span className="sb-item mono sb-url">{props.server}</span>
      <span className="sb-item"><Ic icon={Activity} size={11} />{props.watching}</span>
      <span className="grow" />
      {props.claude ? <span className="sb-item claude" aria-live="polite"><Ic icon={Sparkles} size={11} />{props.claude}</span> : null}
      {props.bad ? (
        <button className="sb-item bad" onClick={props.onProblems} title={`${props.bad} failing: open Overview`} aria-label={`${props.bad} failing, open Overview`}>
          <Ic icon={CircleX} size={11} />{props.bad}
        </button>
      ) : null}
      {props.warn ? (
        <button className="sb-item warn" onClick={props.onProblems} title={`${props.warn} to watch: open Overview`} aria-label={`${props.warn} to watch, open Overview`}>
          <Ic icon={TriangleAlert} size={11} />{props.warn}
        </button>
      ) : null}
    </footer>
  );
}
