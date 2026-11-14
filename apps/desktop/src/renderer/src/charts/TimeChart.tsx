// A time chart for one measure (CPU or memory): usage as stacked bands (a pod's containers, a cluster's nodes) or as
// lines (a workload's pods), request/limit/allocatable as reference lines labelled in a right gutter, a crosshair that snaps to the
// nearest sample with one readout for every series, a legend, and a table view. Hand-rolled SVG; colours come from
// charts.css classes (s1…s4, so), never from TSX.
import type { MetricLine, MetricPanel } from "@landlens/contracts";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { chartUnit, clock, fold, formatIn, grid, last, linear, linePath, nearest, spread, stack, ticks, times, timeTicks, unitWord, type Unit } from "./scale";
import { useWidth } from "./useWidth";

const M = { top: 10, bottom: 22, left: 44 };
export const slotClass = (key: string, i: number) => (key === "other" ? "so" : `s${i + 1}`);
/**
 * Reference labels sit in a right gutter, never on the plot; a label this close to another is pushed apart. The
 * gutter is one fixed width whenever a chart has references, so CPU and memory above each other share their x axis.
 */
const LABEL_GAP = 12;
const GUTTER = 96;

type Ref = { name: string; v: number; cls: string };

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
  /**
   * Fit the y axis to the data (×1.25) when it stays under half the largest reference, so a quiet cluster's usage
   * isn't a flat line under its allocatable; a reference above the axis is named at the gutter's top with "↑".
   */
  fit?: boolean;
  /**
   * "inline" (the drawer): no floating readout. The head shows the crosshair's time and value and the legend values
   * follow the crosshair, so nothing covers the plot in a narrow column.
   */
  readout?: "tip" | "inline";
}) {
  const { unit, panel, to, stacked } = props;
  const inline = props.readout === "inline";
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number>();
  const [table, setTable] = useState(false);
  const height = props.height ?? 150;
  const series = useMemo(() => fold(panel.series), [panel.series]);
  const ts = useMemo(() => times(series), [series]);
  const values = useMemo(() => grid(series, ts), [series, ts]);
  const bands = useMemo(() => (stacked ? stack(values) : undefined), [stacked, values]);
  const totals = ts.map((_, i) => values.reduce((a, row) => a + (row[i] ?? 0), 0));
  // Samples covering less than half the range: start the axis at the first sample rather than draw an empty half.
  const from = ts.length && to - ts[0]! < (to - props.from) / 2 ? ts[0]! : props.from;

  const refs = [
    panel.allocatable !== undefined ? { name: "allocatable", v: panel.allocatable, cls: "ref-hard" } : undefined,
    panel.limit !== undefined ? { name: "limit", v: panel.limit, cls: "ref-hard" } : undefined,
    panel.request !== undefined ? { name: "request", v: panel.request, cls: "ref-soft" } : undefined,
  ].filter((r): r is Ref => !!r);
  const dataTop = Math.max(0, ...(stacked ? totals : values.flat().map((v) => v ?? 0)));
  const refTop = Math.max(0, ...refs.map((r) => r.v));
  const fitted = !!props.fit && dataTop > 0 && refTop > dataTop * 2;
  const yt = ticks(fitted ? dataTop * 1.25 : Math.max(dataTop, refTop) * 1.04, unit);
  const yMax = yt[yt.length - 1]!;
  const u = chartUnit(yMax, unit);
  const f = (v: number, axis = false) => formatIn(v, u, axis);
  const labelOf = (r: Ref) => `${r.name} ${f(r.v)}${r.v > yMax ? " ↑" : ""}`;
  const right = refs.length ? GUTTER : 10;
  const plotW = Math.max(0, width - M.left - right);
  const x = linear(from, to, M.left, M.left + plotW);
  const y = linear(0, yMax, M.top + height, M.top);
  const xs = ts.map(x);
  const gap = Math.max(props.step * 2.5, 75) * 1000;
  const i = at === undefined ? undefined : Math.min(at, ts.length - 1);
  const labelY = spread(refs.map((r) => Math.max(M.top, y(Math.min(r.v, yMax)))), LABEL_GAP, M.top, M.top + height);

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
  // The head's number: the stack's total (or the one line), at the crosshair when inline, else the latest.
  const pick = inline && i !== undefined ? i : ts.length - 1;
  const headValue = stacked ? totals[pick] : series.length === 1 ? (values[0]![pick] ?? undefined) : undefined;
  const legendValue = (k: number) => (inline && i !== undefined ? values[k]![i] : last(series[k])) ?? null;
  const summary = `${props.title} over ${clock(from)}–${clock(to)}: ${series.map((s) => `${s.key} ${f(last(s) ?? 0)}`).join(", ")}${refs.map((r) => `; ${r.name} ${f(r.v)}`).join("")}`;

  return (
    <figure className={"chart" + (props.stale ? " stale" : "")}>
      <figcaption className="chart-head">
        <span className="chart-title">{props.title}</span>
        {headValue !== undefined && headValue !== null ? (
          <span className="chart-now">
            {inline && i !== undefined ? <span className="dim">{clock(ts[i]!)} · </span> : null}
            {f(headValue)}
            {refs[0] ? <span className="dim"> of {f(refs[0].v)}{unitWord(u)} {refs[0].name}</span> : unitWord(u) ? <span className="dim">{unitWord(u)}</span> : null}
          </span>
        ) : inline && i !== undefined ? <span className="chart-now dim">{clock(ts[i]!)}</span> : null}
        <span className="grow" />
        <button className="chart-toggle" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>
      </figcaption>
      {table ? (
        <ChartTable series={series} ts={ts} values={values} f={f} by={props.by} totals={stacked ? totals : undefined} />
      ) : (
        <div ref={ref} className="chart-plot" tabIndex={0} role="group" aria-roledescription="chart" aria-label={summary}
          onPointerMove={move} onPointerLeave={() => setAt(undefined)} onKeyDown={key} onFocus={() => ts.length && setAt(ts.length - 1)} onBlur={() => setAt(undefined)}>
          {width > 0 ? (
            <svg width={width} height={height + M.top + M.bottom} aria-hidden="true">
              {yt.map((t) => (
                <g key={t}>
                  <line className={t === 0 ? "axis" : "gridline"} x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} />
                  <text className="tick" x={M.left - 6} y={y(t) + 3.5} textAnchor="end">{f(t, true)}</text>
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
              {refs.map((r, k) => (
                <g key={r.name} className={r.cls}>
                  {r.v <= yMax ? <line x1={M.left} x2={M.left + plotW} y1={y(r.v)} y2={y(r.v)} /> : null}
                  <text x={M.left + plotW + 6} y={labelY[k]! + 3.5} textAnchor="start">{labelOf(r)}</text>
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
          {i !== undefined && !inline ? (
            <div className={"chart-tip" + (xs[i]! > width / 2 ? " left" : "")} style={{ left: xs[i] }} aria-live="polite">
              <div className="tip-time">{clock(ts[i]!)}</div>
              {series.map((s, k) =>
                values[k]![i] == null ? null : (
                  <div key={s.key} className="tip-row">
                    <i className={`key ${slotClass(s.key, k)}`} />
                    <b>{f(values[k]![i]!)}</b>
                    <span>{s.key}</span>
                    {panel.byKey?.[s.key]?.limit !== undefined ? <span className="dim">/ {f(panel.byKey[s.key]!.limit!)} limit</span> : null}
                  </div>
                ),
              )}
              {stacked && series.length > 1 ? <div className="tip-row total"><i className="key none" /><b>{f(totals[i]!)}</b><span>total</span></div> : null}
            </div>
          ) : null}
        </div>
      )}
      {series.length > 1 ? (
        <ul className="chart-legend" aria-label={`${props.title} legend`} {...(inline ? { "aria-live": "polite" as const } : {})}>
          {series.map((s, k) => {
            const v = legendValue(k);
            return <li key={s.key}><i className={`key ${stacked ? "area" : "line"} ${slotClass(s.key, k)}`} /><span className="lg-name">{s.key}</span><b>{v == null ? "–" : f(v)}</b></li>;
          })}
        </ul>
      ) : null}
      {!stacked && series.at(-1)?.key === "other" ? (
        <p className="chart-note">The {panel.series.filter((s) => s.key !== "other").length - series.length + 1} smaller {props.by}s are summed as “other”.</p>
      ) : null}
    </figure>
  );
}

function ChartTable(props: { series: MetricLine[]; ts: number[]; values: (number | null)[][]; f: (v: number) => string; by: string; totals?: number[] }) {
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
              {props.values.map((row, k) => <td key={k}>{row[j] == null ? "–" : props.f(row[j]!)}</td>)}
              {props.totals && props.series.length > 1 ? <td>{props.f(props.totals[j]!)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
