// A sparkline for a node row: the line in the quiet de-emphasis ink, the latest point in the accent; hover or focus
// reads any point, and the figure beside it always shows a value (the latest, or the one under the pointer).
import type { MetricLine } from "@landlens/contracts";
import { useState, type PointerEvent } from "react";
import { clock, format, linear, linePath, nearest, type Unit } from "./scale";

const W = 96;
const H = 24;

export function Sparkline({ line, unit, label, of, from, to, step }: { line?: MetricLine; unit: Unit; label: string; of?: number; from: number; to: number; step: number }) {
  const [at, setAt] = useState<number>();
  const pts = line?.points ?? [];
  const ts = pts.map((p) => p[0]);
  const max = Math.max(of ?? 0, ...pts.map((p) => p[1])) || 1;
  const x = linear(from, to, 2, W - 4);
  const y = linear(0, max, H - 3, 3);
  const xs = ts.map(x);
  const shown = at ?? pts.length - 1;
  const p = pts[shown];
  const move = (e: PointerEvent<HTMLSpanElement>) => {
    if (!ts.length) return;
    const box = e.currentTarget.getBoundingClientRect();
    setAt(nearest(ts, linear(2, W - 4, from, to)(e.clientX - box.left)));
  };
  const value = p ? `${format(p[1], unit)}${of ? ` of ${format(of, unit)}` : ""}` : "no data";
  return (
    <span className="spark" tabIndex={0} aria-label={`${label}: ${value}${p ? ` at ${clock(p[0])}` : ""}`}
      onPointerMove={move} onPointerLeave={() => setAt(undefined)} onBlur={() => setAt(undefined)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") (e.preventDefault(), setAt(Math.max(0, Math.min(pts.length - 1, (at ?? pts.length - 1) + (e.key === "ArrowLeft" ? -1 : 1)))));
      }}>
      <span className="spark-label">{label}</span>
      <svg width={W} height={H} aria-hidden="true">
        {of ? <line className="spark-cap" x1={2} x2={W - 4} y1={y(of)} y2={y(of)} /> : null}
        <path className="spark-line" d={linePath(xs, pts.map((q) => y(q[1])), ts, Math.max(step * 2.5, 75) * 1000)} />
        {p ? <circle className={at === undefined ? "spark-now" : "spark-at"} cx={x(p[0])} cy={y(p[1])} r={at === undefined ? 2.5 : 3.5} /> : null}
      </svg>
      <span className="spark-value">{p ? format(p[1], unit) : "–"}{at !== undefined && p ? <span className="dim"> {clock(p[0])}</span> : null}</span>
    </span>
  );
}
