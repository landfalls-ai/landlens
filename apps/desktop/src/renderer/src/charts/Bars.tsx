// Ranked horizontal bars (one hue, largest first, the value at the tip): the namespaces using the most.
import { format, type Unit } from "./scale";

export function Bars({ rows, unit, label }: { rows: { key: string; value: number }[]; unit: Unit; label: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return (
    <ul className="bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className={r.key === "other" ? "other" : ""} title={`${r.key}: ${format(r.value, unit)}`}>
          <span className="bar-name">{r.key}</span>
          <span className="bar-track"><i style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} /></span>
          <b className="bar-value">{format(r.value, unit)}</b>
        </li>
      ))}
    </ul>
  );
}
