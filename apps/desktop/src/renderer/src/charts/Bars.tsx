// Ranked horizontal bars (one hue, largest first, the value at the tip): the namespaces using the most.
import { format, type Unit } from "./scale";

export function Bars({ rows, unit, label, fmt }: { rows: { key: string; value: number }[]; unit: Unit; label: string; fmt?: (v: number) => string }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  // A view's chart names its own unit (wave 10 part 3: counts, percents); otherwise CPU or memory.
  const words = (v: number) => (fmt ? fmt(v) : format(v, unit));
  return (
    <ul className="bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className={r.key === "other" ? "other" : ""} title={`${r.key}: ${words(r.value)}`}>
          <span className="bar-name">{r.key}</span>
          <span className="bar-track"><i style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} /></span>
          <b className="bar-value">{words(r.value)}</b>
        </li>
      ))}
    </ul>
  );
}
