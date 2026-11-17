// A view's chart (wave 10 part 3) with the app's own chart code: on a metrics.series source, TimeChart for CPU and
// memory over time (the Overview's chart, stacked by node or pod); a bar chart is the Overview's ranked Bars; a line
// or area chart over rows is a small SVG in the same chart ink (charts.css s1–s4), with a legend and a table view.
// Every label is text.
import type { SourceData } from "@landlens/contracts";
import { useMemo, useState } from "react";
import { Bars } from "../charts/Bars";
import { linear } from "../charts/scale";
import { TimeChart } from "../charts/TimeChart";
import { useWidth } from "../charts/useWidth";
import { barsOf, cellWords, linesOf, unitWords, type BlockDoc } from "../viewBlocks";

export function ChartBlock({ b, d }: { b: BlockDoc; d: SourceData | undefined }) {
  const ys = b.y ?? [];
  const series = d?.series;
  if (series) {
    if (series.source === "none") return null;
    const measures = ys.filter((y): y is "cpu" | "memory" => y === "cpu" || y === "memory");
    return (
      <div className="vb-charts">
        {(measures.length ? measures : (["cpu", "memory"] as const)).map((m) => (
          <TimeChart key={m} title={m === "cpu" ? "CPU" : "Memory"} unit={m} panel={series[m]} from={series.from} to={series.to} step={series.step} stacked={b.kind !== "line"} by={series.by} fit readout="inline" />
        ))}
      </div>
    );
  }
  const rows = d?.state === "ok" || d?.state === "loading" ? d.rows : [];
  const words = unitWords(b.unit);
  if (b.kind === "bar") {
    return (
      <div className="vb-charts">
        {ys.map((y) => {
          const bars = barsOf(rows, b.x, y);
          return (
            <div key={y} className="chart">
              {ys.length > 1 ? <div className="chart-head"><span className="chart-title">{y}</span></div> : null}
              {bars.length ? <Bars rows={bars} unit="cpu" fmt={words} label={`${b.title ?? y} by ${b.x ?? "row"}`} /> : <p className="chart-note">No numbers to draw.</p>}
            </div>
          );
        })}
      </div>
    );
  }
  return <RowLines b={b} rows={rows} words={words} />;
}

const M = { top: 8, bottom: 20, left: 46, right: 8 };

function RowLines({ b, rows, words }: { b: BlockDoc; rows: SourceData["rows"]; words: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [table, setTable] = useState(false);
  const l = useMemo(() => linesOf(rows, b.x, b.y ?? []), [rows, b.x, b.y]);
  const H = 160;
  const W = Math.max(160, width);
  const all = l.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = Math.max(0, ...all) || 1;
  const min = Math.min(0, ...all);
  const x = linear(l.xs[0] ?? 0, l.xs.at(-1) ?? 1, M.left, W - M.right);
  const y = linear(min, max, H - M.bottom, M.top);
  const xWord = (v: number) => (l.time ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : cellWords(v, "number"));
  const path = (vals: (number | null)[]) => {
    let out = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) return void (pen = false);
      out += `${pen ? "L" : "M"}${x(l.xs[i]!).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return out;
  };
  const last = (vals: (number | null)[]) => [...vals].reverse().find((v) => v !== null) ?? null;
  return (
    <div className="chart vb-lines" ref={ref}>
      <div className="chart-head">
        <span className="grow" />
        <button className="chart-toggle" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? "Chart" : "Table"}</button>
      </div>
      {!l.xs.length ? <p className="chart-note">No numbers to draw.</p> : table ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead><tr><th>{b.x ?? "#"}</th>{l.series.map((s) => <th key={s.key}>{s.key}</th>)}</tr></thead>
            <tbody>{l.xs.slice(0, 200).map((t, i) => <tr key={i}><td>{xWord(t)}</td>{l.series.map((s) => <td key={s.key}>{s.values[i] === null ? "" : words(s.values[i]!)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" role="img" aria-label={`${b.title ?? "Chart"}: ${l.series.map((s) => `${s.key} ${last(s.values) === null ? "no value" : words(last(s.values)!)}`).join(", ")}`}>
          <svg width={W} height={H}>
            {[min, (min + max) / 2, max].map((v, i) => (
              <g key={i}>
                <line className="gridline" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
                <text className="tick" x={M.left - 6} y={y(v) + 3} textAnchor="end">{words(v)}</text>
              </g>
            ))}
            <line className="axis" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
            <text className="tick" x={M.left} y={H - 4}>{xWord(l.xs[0]!)}</text>
            <text className="tick" x={W - M.right} y={H - 4} textAnchor="end">{xWord(l.xs.at(-1)!)}</text>
            {l.series.slice(0, 6).map((s, i) => (
              <g key={s.key} className={i < 4 ? `s${i + 1}` : "so"}>
                {b.kind === "area" ? <path className="band" d={`${path(s.values)}L${x(l.xs.at(-1)!)},${y(min)}L${x(l.xs[0]!)},${y(min)}Z`} /> : null}
                <path className="line" d={path(s.values)} />
              </g>
            ))}
          </svg>
        </div>
      )}
      <ul className="chart-legend">
        {l.series.slice(0, 6).map((s, i) => (
          <li key={s.key}><i className={`key ${b.kind === "area" ? "area" : "line"} ${i < 4 ? `s${i + 1}` : "so"}`} /><span className="lg-name">{s.key}</span><b>{last(s.values) === null ? "–" : words(last(s.values)!)}</b></li>
        ))}
      </ul>
    </div>
  );
}
