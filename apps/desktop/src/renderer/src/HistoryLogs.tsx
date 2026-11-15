// The Logs tab's History source (wave 7 part 3, D118): a pod's or a workload's lines from Clickland, for a pod that is
// gone and for runs older than the kubelet keeps. Main asks Clickland (clickland:logs) with a search it builds from
// this object's names; the lines arrive scrubbed and are shown as text. Newest last, Load older pages back, the
// failure-line rule marks errors, and the lines you pick go to Claude quoted as data from Clickland.
import { FAILURE_LINE, type ClicklandLogs, type ClicklandRange, type ClicklandScope, type ClRow } from "@landlens/contracts";
import { ChevronDown, Clock, Copy, Database, ExternalLink, Search, Sparkles, TriangleAlert, WrapText } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AskContext } from "./AgentDock";
import { api, type ApiError } from "./api";
import { elide } from "./benchState";
import { useClickland, useOpenInClickland } from "./clickland";
import { Ic, MOD } from "./icons";
import { ansi, plain } from "./logRows";
import { copyText } from "./present";
import { historyAsk } from "./quotes";

export const CL_RANGES: ClicklandRange[] = ["1h", "6h", "24h", "7d"];
const KEEP = 2000;
/** Chart slots, as the live view colours a workload's pods. */
const SLOTS = ["s1", "s2", "s3", "s4"];

const stamp = (at: string, day: boolean) => {
  const d = new Date(at);
  const t = `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return day ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}` : t;
};

type Row = ClRow & { key: number };

export function HistoryLogs(props: {
  handle: string;
  scope: ClicklandScope;
  /** The containers to pick from (the pod's spec, when the window has it). */
  containers: string[];
  /** The Live | History switch, first in the tool row. */
  switcher: ReactNode;
  label: string;
  onAsk: (c: AskContext) => void;
}) {
  const ck = useClickland();
  const [range, setRange] = useState<ClicklandRange>("6h");
  const [container, setContainer] = useState(props.scope.container ?? "");
  const [errors, setErrors] = useState(false);
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const [wrap, setWrap] = useState(true);
  const [stamps, setStamps] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string>();
  const [cut, setCut] = useState(false);
  const [cluster, setCluster] = useState<string>();
  const [state, setState] = useState<{ loading: boolean; error?: string; unavailable?: string }>({ loading: true });
  const [picked, setPicked] = useState<{ from: number; to: number }>();
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const ask = useRef(0);
  const keepBottom = useRef(true);
  const many = props.scope.kind !== "pod";
  const scope: ClicklandScope = { ...props.scope, ...(container ? { container } : {}) };
  if (!container) delete scope.container;
  const key = JSON.stringify([scope, range, errors, filter]);

  const read = (before?: string) => {
    const n = ++ask.current;
    setState((s) => ({ ...s, loading: true }));
    api.invoke("clickland:logs", { handle: props.handle, scope, range, ...(errors ? { errors: true } : {}), ...(filter ? { filter } : {}), ...(before ? { before } : {}) }).then(
      (r: ClicklandLogs) => {
        if (n !== ask.current) return;
        if ("unavailable" in r) return setState({ loading: false, unavailable: r.unavailable.message });
        // Clickland answers newest first; the view reads oldest first, newest last.
        const page = r.rows.slice().reverse().map((x) => ({ ...x, key: ++seq.current }));
        keepBottom.current = !before;
        setRows((old) => (before ? [...page, ...old] : page).slice(-KEEP));
        setNext(r.next);
        setCut((c) => (before ? c : false) || r.cut);
        setCluster(r.cluster);
        setState({ loading: false });
      },
      (e: ApiError) => n === ask.current && setState({ loading: false, error: e.message }),
    );
  };
  useEffect(() => {
    setRows([]);
    setNext(undefined);
    setPicked(undefined);
    read();
  }, [key, props.handle]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = box.current;
    if (el && keepBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows, wrap, stamps]);

  const pods = [...new Set(rows.map((r) => r.pod).filter((p): p is string => !!p))];
  const slot = new Map(pods.map((p, i) => [p, SLOTS[i % SLOTS.length]!]));
  const days = rows.length > 1 && new Date(rows[0]!.at).toDateString() !== new Date(rows.at(-1)!.at).toDateString();
  const chosen = () => (picked ? rows.filter((r) => r.key >= picked.from && r.key <= picked.to).map((r) => `${r.at} ${many && r.pod ? `[${r.pod}${r.container ? `/${r.container}` : ""}] ` : ""}${plain(r.body)}`) : []);
  const count = picked ? rows.filter((r) => r.key >= picked.from && r.key <= picked.to).length : 0;
  const pick = (k: number, range: boolean) => setPicked((p) => (range && p ? { from: Math.min(p.from, k), to: Math.max(p.from, k) } : p && p.from === k && p.to === k ? undefined : { from: k, to: k }));
  const askClaude = () => {
    const lines = chosen();
    if (!lines.length) return;
    props.onAsk(historyAsk(lines, { scope: props.scope, label: props.label, ...(container ? { container } : {}), range }));
    setPicked(undefined);
  };
  const [openError, openClickland] = useOpenInClickland();
  const open = () => openClickland({ handle: props.handle, scope, signal: "logs", range, ...(errors ? { errors: true } : {}) });

  return (
    <div className="logs-pane hist" aria-label="Logs from Clickland"
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && picked) (e.preventDefault(), askClaude());
        if (e.key === "Escape" && picked) (e.stopPropagation(), setPicked(undefined));
      }}>
      <div className="logs-tools" role="toolbar" aria-label="Log tools">
        {props.switcher}
        {props.containers.length > 1 || container ? (
          <label className="pill-select" title="Container">
            <span className="sr-only">Container</span>
            <select value={container} onChange={(e) => setContainer(e.target.value)}>
              <option value="">All containers</option>
              {props.containers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <Ic icon={ChevronDown} size={11} />
          </label>
        ) : null}
        <div className="seg range" role="radiogroup" aria-label="History range">
          {CL_RANGES.map((r) => <button key={r} role="radio" aria-checked={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
        </div>
        <button className={"tog" + (errors ? " on" : "")} aria-pressed={errors} title="Only lines Clickland marked as errors (level:error)" onClick={() => setErrors((x) => !x)}><Ic icon={TriangleAlert} size={12} />Errors</button>
        <span className="grow" />
        <button className={"icon-btn" + (wrap ? " on" : "")} aria-pressed={wrap} aria-label="Wrap lines" title="Wrap lines" onClick={() => setWrap((w) => !w)}><Ic icon={WrapText} size={14} /></button>
        <button className={"icon-btn" + (stamps ? " on" : "")} aria-pressed={stamps} aria-label="Timestamps" title="Timestamps (local time)" onClick={() => setStamps((s) => !s)}><Ic icon={Clock} size={14} /></button>
        {ck.console ? <button className="icon-btn" aria-label="Open in Clickland" title={`Open this search in Clickland (${new URL(ck.console).host})`} onClick={open}><Ic icon={ExternalLink} size={14} /></button> : null}
      </div>
      <form className="logs-find" role="search" onSubmit={(e) => (e.preventDefault(), setFilter(typed.trim()))}>
        <label className="field"><Ic icon={Search} size={13} />
          <input aria-label="Find in Clickland's lines" placeholder="Find in Clickland (Enter)" value={typed} maxLength={200}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && typed && (e.stopPropagation(), setTyped(""), setFilter(""))} />
        </label>
        {filter ? <span className="find-count">Lines with “{elide(filter, 24)}”</span> : null}
      </form>
      <div className="logs-wrap">
        <div ref={box} className={"logs" + (wrap ? "" : " nowrap")} role="log" aria-label="Clickland log lines" aria-live="off" tabIndex={0}
          onScroll={(e) => (keepBottom.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 8)}>
          {next && rows.length < KEEP ? <button className="link-btn more" disabled={state.loading} onClick={() => read(next)}>Load older</button> : null}
          {next && rows.length >= KEEP ? <div className="logs-end">The newest {KEEP.toLocaleString()} lines are shown; Open in Clickland for the rest.</div> : null}
          {rows.map((r) => <HLine key={r.key} row={r} stamps={stamps} days={days} many={many} colour={r.pod ? slot.get(r.pod) : undefined} picked={!!picked && r.key >= picked.from && r.key <= picked.to} onPick={pick} />)}
          {openError ? <div className="logs-end" role="alert">{openError}</div> : null}
          {state.unavailable ? <div className="logs-end" role="status">{state.unavailable}</div>
            : state.error ? <div className="logs-end" role="alert">Couldn't read Clickland's history: {state.error}</div>
            : !rows.length && state.loading ? <div className="logs-end">Asking Clickland…</div>
            : !rows.length ? <div className="logs-end" role="status">No lines from Clickland for {props.label} in the last {range}{errors ? " marked as errors" : ""}{filter ? ` with “${elide(filter, 40)}”` : ""}.</div> : null}
        </div>
        {count ? (
          <div className="sel-bar" role="toolbar" aria-label="Selection" style={{ bottom: 10 }}>
            <span>{count} line{count === 1 ? "" : "s"}{count > 200 ? " · the first 200 are cut" : ""}</span>
            <button className="secondary" onClick={() => void copyText(chosen().join("\n"))}><Ic icon={Copy} size={12} />Copy</button>
            <button className="ask-btn" onClick={askClaude} title={`Ask Claude (${MOD}⏎)`}><Ic icon={Sparkles} size={13} />Ask Claude</button>
          </div>
        ) : null}
      </div>
      <div className="logs-foot">
        <span className="live"><Ic icon={Database} size={11} />From Clickland{cluster ? <span className="mono dim">{cluster}</span> : null}</span>
        <span>{rows.length.toLocaleString()} lines · newest last{cut ? " · long lines cut" : ""}</span>
        {many && pods.length ? <span className="legend-pods">{pods.slice(0, 4).map((p) => <span key={p} className={slot.get(p)}><i />{p.slice(-5)}</span>)}</span> : null}
      </div>
    </div>
  );
}

const HLine = memo(function HLine({ row, stamps, days, many, colour, picked, onPick }: {
  row: Row; stamps: boolean; days: boolean; many: boolean; colour?: string | undefined; picked: boolean; onPick: (key: number, range: boolean) => void;
}) {
  const loud = /^(error|fatal|critical)$/i.test(row.severity ?? "") || FAILURE_LINE.test(plain(row.body));
  return (
    <div className={"ll" + (colour ? ` ${colour}` : "") + (loud ? " err" : "") + (picked ? " sel" : "")} data-key={row.key}>
      <span className="ts" title={row.at} onClick={(e) => onPick(row.key, e.shiftKey)} aria-hidden={stamps ? undefined : true}>{stamps ? stamp(row.at, days) : "·"}</span>
      {many ? <span className="pod" title={`${row.pod ?? "?"}${row.container ? ` · ${row.container}` : ""}`}>{(row.pod ?? "").slice(-5)}</span> : null}
      <span className="tx">{ansi(row.body).map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}{row.cut ? <span className="dim"> … (cut)</span> : null}</span>
    </div>
  );
});
