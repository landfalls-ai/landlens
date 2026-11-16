// A view's blocks on the Views page (wave 10, D206), on the 12-column grid. Every cell is a React text node: nothing a
// source delivers is ever markup here. Part 2 draws the native blocks plainly (a table, a number, a list, lines, a small
// table for a chart's points); part 3 gives them the app's own table, chart and log components. An app block is a
// sandboxed frame (AppFrame, D204) in the quieter ring captioned "Built by Claude".
import type { RowRef, SourceData, ViewRow } from "@landlens/contracts";
import { age } from "@landlens/kube/status";
import { CircleX, MessageSquarePlus } from "lucide-react";
import type { ObjectTarget } from "./app-host";
import { AppFrame } from "./AppFrame";
import { Ic } from "./icons";
import { blockKey } from "./viewStore";

type Format = "text" | "number" | "age" | "bytes" | "cpu" | "percent" | "status" | "ref" | "mono";
type Column = { field: string; header?: string; format?: Format; width?: number };
/** A block as the validated document has it (packages/views' Block; the page reads only these fields). */
export type BlockDoc = {
  type: "table" | "stat" | "chart" | "list" | "logs" | "problems" | "text" | "app";
  source?: string; span?: number; title?: string;
  columns?: Column[]; field?: string; label?: string; format?: Format; x?: string; y?: string[];
  primary?: string; secondary?: string; max?: number; markdown?: string;
  id?: string; uses?: string[]; fill?: boolean; minHeight?: number;
};

const units = ["B", "KiB", "MiB", "GiB", "TiB"];
/** A cell as text, by its column's format. Never markup. */
export function cellWords(v: unknown, format: Format = "text", now = Date.now()): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  if (typeof v !== "number") return String(v);
  switch (format) {
    case "age": return age(v, now);
    case "bytes": {
      let n = v;
      let i = 0;
      while (Math.abs(n) >= 1024 && i < units.length - 1) (n /= 1024, i++);
      return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
    }
    case "cpu": return v < 1 ? `${Math.round(v * 1000)}m` : `${Math.round(v * 100) / 100}`;
    case "percent": return `${Math.round(v * 10) / 10}%`;
    default: return v.toLocaleString("en-US");
  }
}

const refTarget = (r: RowRef): ObjectTarget => ({ kind: r.kind, name: r.name, ...(r.namespace ? { namespace: r.namespace } : {}) });

function Failed({ d }: { d: SourceData | undefined }) {
  if (!d) return <div className="vb-note dim">Reading…</div>;
  if (d.state === "loading") return <div className="vb-note dim">Reading…</div>;
  if (d.state === "ok") return null;
  return <div className="vb-note" role="note"><Ic icon={CircleX} size={13} className="tone-warn" />{d.message ?? "This source can't be read."}</div>;
}

function rowsOf(d: SourceData | undefined): ViewRow[] {
  return d && (d.state === "ok" || d.state === "loading") ? d.rows : [];
}

function Body(props: { b: BlockDoc; d: SourceData | undefined; onOpenObject: (t: ObjectTarget) => void }) {
  const { b, d } = props;
  const rows = rowsOf(d);
  switch (b.type) {
    case "table": {
      const cols = b.columns ?? [];
      return (
        <div className="vb-table-wrap">
          <table className="vb-table">
            <thead><tr>{cols.map((c) => <th key={c.field} style={c.width ? { width: c.width } : undefined}>{c.header ?? c.field}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, 500).map((r, i) => (
                <tr key={i} className={r._tone ? `tone-row-${r._tone}` : undefined}>
                  {cols.map((c, j) => {
                    const text = cellWords(r[c.field], c.format);
                    return (
                      <td key={c.field} className={c.format === "mono" || c.format === "ref" ? "mono" : c.format && c.format !== "text" && c.format !== "status" ? "num" : undefined}>
                        {j === 0 && r._ref ? <button className="link-btn" onClick={() => props.onOpenObject(refTarget(r._ref!))}>{text}</button> : text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 ? <div className="vb-note dim">The first 500 of {rows.length.toLocaleString("en-US")} rows are drawn here.</div> : null}
        </div>
      );
    }
    case "stat": {
      const v = rows[0]?.[b.field ?? ""];
      return (
        <div className="vb-stat">
          <div className="vb-stat-value num">{v === undefined || v === null ? "—" : cellWords(v, b.format ?? "number")}</div>
          <div className="vb-stat-label dim">{b.label}</div>
        </div>
      );
    }
    case "chart": {
      // Part 2 shows a chart's points as a small table (part 3 draws the chart).
      const series = d?.series;
      if (series) return <div className="vb-note dim">Usage over time from {series.source}: drawn as a chart in a later version.</div>;
      const x = b.x ?? "";
      const ys = b.y ?? [];
      return (
        <div className="vb-table-wrap">
          <table className="vb-table">
            <thead><tr><th>{x}</th>{ys.map((y) => <th key={y}>{y}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 50).map((r, i) => <tr key={i}><td>{cellWords(r[x])}</td>{ys.map((y) => <td key={y} className="num">{cellWords(r[y], "number")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    case "list":
      return (
        <ul className="vb-list">
          {rows.slice(0, b.max ?? 50).map((r, i) => (
            <li key={i}>
              <span className="vb-primary">{cellWords(r[b.primary ?? ""])}</span>
              {b.secondary ? <span className="dim small"> {cellWords(r[b.secondary])}</span> : null}
            </li>
          ))}
        </ul>
      );
    case "logs":
      return <pre className="vb-logs">{(d?.lines ?? []).map((l) => `${l.text}\n`).join("")}</pre>;
    case "problems":
      return (
        <ul className="vb-list">
          {rows.slice(0, 100).map((r, i) => (
            <li key={i} className={r._tone ? `tone-row-${r._tone}` : undefined}>
              <span className="vb-primary">{cellWords(r.title)}</span>
              <span className="dim small"> {cellWords(r.kind)} {cellWords(r.namespace)}/{cellWords(r.name)}</span>
            </li>
          ))}
        </ul>
      );
    case "text":
      return <div className="vb-text">{(b.markdown ?? "").split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>;
    default:
      return null;
  }
}

/** One block in its grid cell: its title, an "Ask about this" for blocks with rows, then what it draws. */
export function ViewBlock(props: {
  view: string; version: number; b: BlockDoc; i: number; data: (source: string) => SourceData | undefined;
  onOpenObject: (t: ObjectTarget) => void; onAsk: (block: string, title: string) => void; single: boolean; height: number;
}) {
  const { b } = props;
  const key = blockKey(b, props.i);
  // A block's own title, or an app block's id; a stat without one shows its label under the number only.
  const title = b.title ?? (b.type === "app" ? b.id : undefined);
  const name = title ?? b.label ?? b.source ?? b.type;
  const span = props.single ? 12 : b.span ?? (b.type === "stat" ? 3 : 12);
  const d = b.source ? props.data(b.source) : undefined;
  return (
    <section className={`vb vb-${b.type}`} style={{ "--span": span } as React.CSSProperties} aria-label={name}>
      {title || b.type !== "text" ? (
        <header className="vb-head">
          <span className="vb-title">{title}</span>
          {b.type !== "text" ? (
            <button className="icon-btn vb-ask" aria-label={`Ask Claude about ${name}`} title="Ask Claude about this block (its rows go with your question, as data)" onClick={() => props.onAsk(key, name)}>
              <Ic icon={MessageSquarePlus} size={14} />
            </button>
          ) : null}
        </header>
      ) : null}
      {b.type === "app" ? (
        <AppFrame
          block={{ view: props.view, block: b.id!, uses: b.uses ?? [], version: props.version, ...(b.fill && props.single ? { fill: props.height } : {}) }}
          onOpenObject={props.onOpenObject}
        />
      ) : (
        <>
          <Failed d={d} />
          <Body b={b} d={d} onOpenObject={props.onOpenObject} />
        </>
      )}
    </section>
  );
}
