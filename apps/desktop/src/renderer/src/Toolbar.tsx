// The main pane's toolbar: title and count, the status filter (pods), the namespace, the filter, and Ask Claude.
import { ChevronDown, Folder, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { age } from "@landlens/kube/status";
import { Ic, MOD } from "./icons";

export type StatusFilter = "all" | "bad" | "warn";

export function Toolbar(props: {
  title: string;
  count?: number;
  /** A page with no count (MCP). */
  hideCount?: boolean;
  updatedAt?: string;
  seg?: { value: StatusFilter; all: number; bad: number; warn: number; onChange: (v: StatusFilter) => void };
  namespaces?: { list: string[]; value: string; onChange: (ns: string) => void };
  filter?: { value: string; onChange: (v: string) => void; ref: RefObject<HTMLInputElement | null>; short: boolean };
  onAsk?: () => void;
  /** Create from YAML (D32). */
  onCreate?: () => void;
}) {
  return (
    <header className="toolbar">
      <h1 className="view-title">{props.title}</h1>
      {!props.hideCount && (props.count !== undefined || !props.updatedAt) ? <span className="count-badge" aria-live="polite">{props.count ?? "…"}</span> : null}
      {props.updatedAt ? <Updated at={props.updatedAt} /> : null}
      {props.seg ? (
        <div className="seg" role="group" aria-label="Status">
          {([["all", "All", props.seg.all], ["bad", "Failing", props.seg.bad], ["warn", "Pending", props.seg.warn]] as const).map(([v, word, n]) => (
            <button key={v} className={props.seg!.value === v ? "on" : ""} aria-pressed={props.seg!.value === v} onClick={() => props.seg!.onChange(v)} title={`${word}: ${n}`}>
              {v !== "all" ? <i className={`dot tone-${v}`} aria-hidden="true" /> : null}
              <span className={v !== "all" ? "seg-word" : undefined}>{word}</span> <b>{n}</b>
            </button>
          ))}
        </div>
      ) : null}
      <div className="grow" />
      {props.namespaces ? (
        <label className="field select">
          <Ic icon={Folder} size={13} />
          <span className="sr-only">Namespace</span>
          <select value={props.namespaces.value} onChange={(e) => props.namespaces!.onChange(e.target.value)}>
            <option value="">All namespaces</option>
            {props.namespaces.list.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <Ic icon={ChevronDown} size={13} className="chev" />
        </label>
      ) : null}
      {props.filter ? (
        <label className={"field search" + (props.filter.short ? " short" : "")}>
          <Ic icon={Search} size={13} />
          <span className="sr-only">Filter by name</span>
          <input
            ref={props.filter.ref}
            type="search"
            placeholder={props.filter.short ? "Filter" : "Filter by name or namespace"}
            value={props.filter.value}
            onChange={(e) => props.filter!.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                props.filter!.onChange("");
                e.currentTarget.blur();
              }
            }}
          />
          {props.filter.value ? null : <kbd aria-hidden="true">/</kbd>}
        </label>
      ) : null}
      {props.onCreate ? <button className="icon-btn create-btn" aria-label="Create from YAML" title="Create from YAML" onClick={props.onCreate}><Ic icon={Plus} size={15} /></button> : null}
      {props.onAsk ? <button className="ask-btn" aria-label="Ask Claude" title={`Ask Claude (${MOD}J)`} onClick={props.onAsk}><Ic icon={Sparkles} size={14} /><span className="ask-word">Ask Claude</span><kbd aria-hidden="true">{MOD}J</kbd></button> : null}
    </header>
  );
}

/** "updated 4s ago", ticking. */
function Updated({ at }: { at: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="updated"><Ic icon={RefreshCw} size={12} />updated {age(Date.parse(at), now)} ago</span>;
}
