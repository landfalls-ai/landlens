// A view's stat (wave 10 part 3): the first row's value in its format, large; its label; a tone from `toneField`
// (the closed set only) and, with `sparkField`, the rows' values as a quiet sparkline in the chart ink.
import type { SourceData } from "@landlens/contracts";
import { statOf, type BlockDoc } from "../viewBlocks";

export function StatBlock({ b, d, now }: { b: BlockDoc; d: SourceData | undefined; now: number }) {
  const s = statOf(d?.state === "ok" || d?.state === "loading" ? d.rows : [], b, now);
  const W = 120;
  const H = 28;
  const max = Math.max(...s.spark, 0) || 1;
  const min = Math.min(...s.spark, 0);
  const pts = s.spark.map((v, i) => `${s.spark.length > 1 ? (i / (s.spark.length - 1)) * (W - 4) + 2 : W / 2},${H - 3 - ((v - min) / (max - min || 1)) * (H - 6)}`);
  return (
    <div className={`vb-statbox${s.tone ? ` tone-${s.tone}` : ""}`}>
      <div className="vb-stat-value num" aria-label={`${b.label}: ${s.text}`}>{s.text}</div>
      <div className="vb-stat-foot">
        <span className="vb-stat-label">{b.label}</span>
        {pts.length > 1 ? (
          <svg className="vb-spark" width={W} height={H} aria-hidden="true"><polyline className="spark-line" points={pts.join(" ")} /></svg>
        ) : null}
      </div>
    </div>
  );
}
