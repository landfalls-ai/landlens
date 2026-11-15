// The drawer's Traces tab (wave 7 part 3, D118), for a pod or a workload while Clickland is ready: the last 50 traces
// of its service (as Clickland's collector names it), errors only when asked, and one trace's spans as a plain list:
// name, service and a duration bar on one scale, failures in the bad tone. No waterfall library; text nodes only.
import type { ClicklandRange, ClicklandScope, ClicklandTrace, ClicklandTraces, ClSpan, ClTrace } from "@landlens/contracts";
import { ArrowLeft, CircleX, ExternalLink, TriangleAlert, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useNow, type ApiError } from "./api";
import { useClickland } from "./clickland";
import { CL_RANGES } from "./HistoryLogs";
import { Ic } from "./icons";
import { duration } from "./present";

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`);

export function TracesTab(props: { handle: string; scope: ClicklandScope }) {
  const ck = useClickland();
  const now = useNow();
  const [range, setRange] = useState<ClicklandRange>("1h");
  const [errors, setErrors] = useState(false);
  const [list, setList] = useState<{ traces?: ClTrace[]; service?: string; error?: string; unavailable?: string }>();
  const [open, setOpen] = useState<ClTrace>();
  const [spans, setSpans] = useState<{ id: string; spans?: ClSpan[]; ms?: number; cut?: boolean; error?: string }>();
  const key = JSON.stringify([props.scope, range, errors]);

  useEffect(() => {
    let live = true;
    setList(undefined);
    api.invoke("clickland:traces", { handle: props.handle, scope: props.scope, range, ...(errors ? { errors: true } : {}) }).then(
      (r: ClicklandTraces) => live && setList("unavailable" in r ? { unavailable: r.unavailable.message } : r),
      (e: ApiError) => live && setList({ error: e.message }),
    );
    return () => void (live = false);
  }, [key, props.handle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return setSpans(undefined);
    let live = true;
    setSpans({ id: open.id });
    api.invoke("clickland:trace", { handle: props.handle, id: open.id }).then(
      (r: ClicklandTrace) => live && setSpans("unavailable" in r ? { id: open.id, error: r.unavailable.message } : { id: open.id, ...r }),
      (e: ApiError) => live && setSpans({ id: open.id, error: e.message }),
    );
    return () => void (live = false);
  }, [open?.id, props.handle]); // eslint-disable-line react-hooks/exhaustive-deps

  const openIn = (trace?: string) => void api.invoke("clickland:open", { handle: props.handle, scope: props.scope, signal: "traces", range, ...(errors ? { errors: true } : {}), ...(trace ? { trace } : {}) }).catch(() => {});

  let body;
  if (open) {
    const total = Math.max(spans?.ms ?? open.ms, 0.001);
    body = (
      <div className="tr-detail">
        <div className="tr-head">
          <button className="link-btn" onClick={() => setOpen(undefined)}><Ic icon={ArrowLeft} size={12} />All traces</button>
          <span className="grow" />
          {ck.console ? <button className="link-btn" onClick={() => openIn(open.id)}><Ic icon={ExternalLink} size={12} />Open in Clickland</button> : null}
        </div>
        <h3 className="tr-title"><span className="mono">{open.name}</span><span className="dim mono">{ms(spans?.ms ?? open.ms)}</span></h3>
        {spans?.error ? <p className="muted-line" role="alert">{spans.error}</p>
          : !spans?.spans ? <p className="muted-line">Reading the trace…</p>
          : (
            <ul className="tr-spans" aria-label="Spans">
              {spans.spans.map((s) => (
                <li key={`${s.id}:${s.offsetMs}`} className={"tr-span" + (s.error ? " bad" : "")}>
                  <span className="tr-name" style={{ paddingLeft: Math.min(s.depth, 8) * 12 }} title={s.name}>{s.error ? <Ic icon={CircleX} size={11} className="tone-bad" /> : null}{s.name}</span>
                  <span className="tr-svc dim" title={s.service}>{s.service}</span>
                  <span className="tr-bar" aria-hidden="true"><i style={{ left: `${Math.min(100, (s.offsetMs / total) * 100)}%`, width: `max(2px, ${Math.min(100, (s.ms / total) * 100)}%)` }} /></span>
                  <span className="tr-ms mono">{ms(s.ms)}</span>
                </li>
              ))}
            </ul>
          )}
        {spans?.cut ? <p className="small dim">The first 500 spans; Open in Clickland for the rest.</p> : null}
      </div>
    );
  } else if (!list) body = <p className="muted-line">Asking Clickland…</p>;
  else if (list.unavailable) body = <p className="muted-line" role="status">{list.unavailable}</p>;
  else if (list.error) body = <p className="muted-line" role="alert">Couldn't read Clickland's traces: {list.error}</p>;
  else if (!list.traces?.length)
    body = <p className="muted-line" role="status">No {errors ? "failed " : ""}traces from <span className="mono">{list.service}</span> in this range. Clickland sees traces only from workloads that send them.</p>;
  else
    body = (
      <ul className="tr-list" aria-label="Traces">
        {list.traces.map((t) => (
          <li key={t.id}>
            <button className={"tr-row" + (t.error ? " bad" : "")} onClick={() => setOpen(t)}>
              <i className={"dot " + (t.error ? "tone-bad" : "tone-ok")} aria-hidden="true" />
              <span className="tr-name mono" title={t.name}>{t.name}</span>
              <span className="tr-when dim">{duration(now - Date.parse(t.at))} ago</span>
              <span className="tr-ms mono">{ms(t.ms)}</span>
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="mtab traces-tab" aria-label="Traces">
      <div className="mtab-head">
        <span className="metrics-src"><Ic icon={Waypoints} size={12} />Clickland{list?.service ? <span className="dim mono" title={`Service ${list.service}`}>{list.service}</span> : null}</span>
        <span className="grow" />
        <button className={"tog" + (errors ? " on" : "")} aria-pressed={errors} onClick={() => setErrors((x) => !x)}><Ic icon={TriangleAlert} size={12} />Errors</button>
        <div className="seg range" role="radiogroup" aria-label="Traces range">
          {CL_RANGES.map((r) => <button key={r} role="radio" aria-checked={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
        </div>
        {ck.console && !open ? <button className="icon-btn" aria-label="Open in Clickland" title="Open these traces in Clickland" onClick={() => openIn()}><Ic icon={ExternalLink} size={14} /></button> : null}
      </div>
      {body}
    </div>
  );
}
