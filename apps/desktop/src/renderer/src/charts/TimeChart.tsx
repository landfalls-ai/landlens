// A time chart for one measure (CPU or memory): usage as stacked bands (a pod's containers, a cluster's nodes) or as
// lines (a workload's pods), request/limit/allocatable as labelled reference lines, a crosshair that snaps to the
// nearest sample with one readout for every series, a legend, and a table view. Hand-rolled SVG; colours come from
// charts.css classes (s1…s4, so), never from TSX.
import type { MetricLine, MetricPanel } from "@landlens/contracts";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clock, fold, format, grid, last, linear, linePath, nearest, stack, ticks, times, timeTicks, type Unit } from "./scale";
import { useWidth } from "./useWidth";

const M = { top: 10, right: 10, bottom: 22, left: 44 };
export const slotClass = (key: string, i: number) => (key === "other" ? "so" : `s${i + 1}`);

export function TimeChart(props: {
  title: string;
  unit: Unit;
  panel: MetricPanel;
  from: number;
  to: number;
  step: number;
  stacked: boolean;
  /** What one series is, for the readout and the table ("container", "pod", "node"). */
  by: string;
  height?: number;
  /** Dim while a new range loads (the frame stays). */
  stale?: boolean;
}) {
  const { unit, panel, from, to, stacked } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number>();
  const [table, setTable] = useState(false);
  const height = props.height ?? 150;
  const series = useMemo(() => fold(panel.series), [panel.series]);
  const ts = useMemo(() => times(series), [series]);
  const values = useMemo(() => grid(series, ts), [series, ts]);
  const bands = useMemo(() => (stacked ? stack(values) : undefined), [stacked, values]);
  const totals = ts.map((_, i) => values.reduce((a, row) => a + (row[i] ?? 0), 0));

  const refs = [
    panel.allocatable !== undefined ? { name: "allocatable", v: panel.allocatable, cls: "ref-hard" } : undefined,
    panel.limit !== undefined ? { name: "limit", v: panel.limit, cls: "ref-hard" } : undefined,
    panel.request !== undefined ? { name: "request", v: panel.request, cls: "ref-soft" } : undefined,
  ].filter((r): r is { name: string; v: number; cls: string } => !!r);
  const top = Math.max(0, ...(stacked ? totals : values.flat().map((v) => v ?? 0)), ...refs.map((r) => r.v));
  const yt = ticks(top * 1.04, unit);
  const plotW = Math.max(0, width - M.left - M.right);
  const x = linear(from, to, M.left, M.left + plotW);
  const y = linear(0, yt[yt.length - 1]!, M.top + height, M.top);
  const xs = ts.map(x);
  const gap = Math.max(props.step * 2.5, 75) * 1000;
  const i = at === undefined ? undefined : Math.min(at, ts.length - 1);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!ts.length) return;
    const box = e.currentTarget.getBoundingClientRect();
    setAt(nearest(ts, linear(M.left, M.left + plotW, from, to)(e.clientX - box.left)));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ts.length) return;
    const cur = i ?? ts.length - 1;
    const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: ts.length - 1 }[e.key];
    if (next !== undefined) (e.preventDefault(), setAt(Math.max(0, Math.min(ts.length - 1, next))));
    if (e.key === "Escape") setAt(undefined);
  };
  const latestTotal = stacked ? totals.at(-1) : undefined;
  const summary = `${props.title} over ${clock(from)}–${clock(to)}: ${series.map((s) => `${s.key} ${format(last(s) ?? 0, unit)}`).join(", ")}${refs.map((r) => `; ${r.name} ${format(r.v, unit)}`).join("")}`;

  return (
    <figure className={"chart" + (props.stale ? " stale" : "")}>
      <figcaption className="chart-head">
        <span className="chart-title">{props.title}</span>
        {latestTotal !== undefined ? <span className="chart-now">{format(latestTotal, unit)}{refs[0] ? <span className="dim"> of {format(refs[0].v, unit)}{unit === "cpu" && refs[0].v >= 1 ? " cores" : ""} {refs[0].name}</span> : null}</span> : null}
        <span className="grow" />
        <button className="chart-toggle" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>
      </figcaption>
      {table ? (
        <ChartTable series={series} ts={ts} values={values} unit={unit} by={props.by} totals={stacked ? totals : undefined} />
      ) : (
        <div ref={ref} className="chart-plot" tabIndex={0} role="group" aria-roledescription="chart" aria-label={summary}
          onPointerMove={move} onPointerLeave={() => setAt(undefined)} onKeyDown={key} onFocus={() => ts.length && setAt(ts.length - 1)} onBlur={() => setAt(undefined)}>
          {width > 0 ? (
            <svg width={width} height={height + M.top + M.bottom} aria-hidden="true">
              {yt.map((t) => (
                <g key={t}>
                  <line className={t === 0 ? "axis" : "gridline"} x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} />
                  <text className="tick" x={M.left - 6} y={y(t) + 3.5} textAnchor="end">{format(t, unit, true)}</text>
                </g>
              ))}
              {timeTicks(from, to, Math.max(2, Math.floor(plotW / 70))).map((t) => (
                <text key={t} className="tick" x={x(t)} y={M.top + height + 15} textAnchor="middle">{clock(t)}</text>
              ))}
              {bands
                ? (() => {
                    // Bands bottom-up, then their edges top-down, so a lower series' line stays visible where an upper
                    // one adds next to nothing.
                    const geo = series.map((s, k) => {
                      const hi = bands[k]!.map((b) => y(b[1]));
                      const lo = bands[k]!.map((b) => y(b[0]));
                      const pts = (ys: number[], order: number[]) => order.map((j) => `${xs[j]!.toFixed(1)},${ys[j]!.toFixed(1)}`).join("L");
                      const idx = xs.map((_, j) => j);
                      return { s, cls: slotClass(s.key, k), area: xs.length ? `M${pts(hi, idx)}L${pts(lo, [...idx].reverse())}Z` : "", edge: linePath(xs, hi, ts, gap) };
                    });
                    return (
                      <>
                        {geo.map((g) => <path key={`b-${g.s.key}`} className={`${g.cls} band`} d={g.area} />)}
                        {[...geo].reverse().map((g) => <path key={`e-${g.s.key}`} className={`${g.cls} edge`} d={g.edge} />)}
                      </>
                    );
                  })()
                : series.map((s, k) => <path key={s.key} className={`${slotClass(s.key, k)} line`} d={linePath(xs, values[k]!.map((v) => (v == null ? null : y(v))), ts, gap)} />)}
              {refs.map((r) => (
                <g key={r.name} className={r.cls}>
                  <line x1={M.left} x2={M.left + plotW} y1={y(r.v)} y2={y(r.v)} />
                  <text x={M.left + plotW - 2} y={y(r.v) - 4} textAnchor="end">{r.name} {format(r.v, unit)}</text>
                </g>
              ))}
              {i !== undefined ? (
                <g className="crosshair">
                  <line x1={xs[i]} x2={xs[i]} y1={M.top} y2={M.top + height} />
                  {series.map((s, k) => {
                    const v = bands ? bands[k]![i]![1] : values[k]![i];
                    return v == null || (bands && values[k]![i] == null) ? null : <circle key={s.key} className={slotClass(s.key, k)} cx={xs[i]} cy={y(v)} r={4} />;
                  })}
                </g>
              ) : null}
            </svg>
          ) : null}
          {i !== undefined ? (
            <div className={"chart-tip" + (xs[i]! > width / 2 ? " left" : "")} style={{ left: xs[i] }} aria-live="polite">
              <div className="tip-time">{clock(ts[i]!)}</div>
              {series.map((s, k) =>
                values[k]![i] == null ? null : (
                  <div key={s.key} className="tip-row">
                    <i className={`key ${slotClass(s.key, k)}`} />
                    <b>{format(values[k]![i]!, unit)}</b>
                    <span>{s.key}</span>
                    {panel.byKey?.[s.key]?.limit !== undefined ? <span className="dim">/ {format(panel.byKey[s.key]!.limit!, unit)} limit</span> : null}
                  </div>
                ),
              )}
              {stacked && series.length > 1 ? <div className="tip-row total"><i className="key none" /><b>{format(totals[i]!, unit)}</b><span>total</span></div> : null}
              {refs.map((r) => <div key={r.name} className="tip-row ref"><i className={`key ${r.cls}`} /><b>{format(r.v, unit)}</b><span>{r.name}</span></div>)}
            </div>
          ) : null}
        </div>
      )}
      {series.length > 1 ? (
        <ul className="chart-legend" aria-label={`${props.title} legend`}>
          {series.map((s, k) => (
            <li key={s.key}><i className={`key ${stacked ? "area" : "line"} ${slotClass(s.key, k)}`} /><span className="lg-name">{s.key}</span><b>{format(last(s) ?? 0, unit)}</b></li>
          ))}
        </ul>
      ) : null}
      {!stacked && series.at(-1)?.key === "other" ? (
        <p className="chart-note">The {panel.series.filter((s) => s.key !== "other").length - series.length + 1} smaller {props.by}s are summed as “other”.</p>
      ) : null}
    </figure>
  );
}

function ChartTable(props: { series: MetricLine[]; ts: number[]; values: (number | null)[][]; unit: Unit; by: string; totals?: number[] }) {
  const n = props.ts.length;
  const pick = Array.from(new Set(Array.from({ length: Math.min(12, n) }, (_, k) => n - 1 - Math.round((k * (n - 1)) / Math.max(1, Math.min(12, n) - 1)))));
  return (
    <div className="chart-table-wrap">
      <table className="chart-table">
        <thead>
          <tr><th>Time</th>{props.series.map((s) => <th key={s.key}>{s.key}</th>)}{props.totals && props.series.length > 1 ? <th>total</th> : null}</tr>
        </thead>
        <tbody>
          {pick.map((j) => (
            <tr key={j}>
              <td>{clock(props.ts[j]!)}</td>
              {props.values.map((row, k) => <td key={k}>{row[j] == null ? "–" : format(row[j]!, props.unit)}</td>)}
              {props.totals && props.series.length > 1 ? <td>{format(props.totals[j]!, props.unit)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
