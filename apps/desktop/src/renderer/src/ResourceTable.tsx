import type { KubeObject } from "@landlens/contracts";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { Column } from "./kinds";

const ROW = 30;

/** A sortable table that only renders the rows in view, so 10k pods scroll smoothly. */
export function ResourceTable(props: {
  columns: Column[];
  items: KubeObject[];
  now: number;
  selected?: string;
  onSelect: (o: KubeObject) => void;
}) {
  const { columns, items, now } = props;
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>({ id: "name", dir: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const col = columns.find((c) => c.id === sort.id) ?? columns[0]!;
    const keyed = items.map((o) => {
      const cell = col.cell(o, now);
      return { o, k: cell.sort ?? cell.text };
    });
    keyed.sort((a, b) => {
      const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k), undefined, { numeric: true });
      return (c || a.o.metadata.name.localeCompare(b.o.metadata.name)) * sort.dir;
    });
    return keyed.map((x) => x.o);
  }, [items, columns, sort, now]);

  const widths = columns.map((c) => c.width ?? "minmax(100px, 1fr)");
  const template: CSSProperties = { gridTemplateColumns: widths.join(" ") };
  // The narrowest the columns can go; below that the table scrolls sideways instead of clipping columns.
  const minWidth = widths.reduce((sum, w) => sum + Number(/(\d+)px/.exec(w)?.[1] ?? 100), 0);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 10);

  return (
    <div className="table" role="grid" aria-rowcount={rows.length}>
      <div className="table-inner" style={{ minWidth }}>
      <div className="thead" style={template} role="row">
        {columns.map((c) => (
          <button
            key={c.id}
            className="th"
            role="columnheader"
            aria-sort={sort.id === c.id ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
            onClick={() => setSort((s) => ({ id: c.id, dir: s.id === c.id ? (s.dir === 1 ? -1 : 1) : 1 }))}
          >
            {c.label}
            {sort.id === c.id ? <span className="sort">{sort.dir === 1 ? "▲" : "▼"}</span> : null}
          </button>
        ))}
      </div>
      <div
        className="tbody"
        ref={(el) => {
          (box as { current: HTMLDivElement | null }).current = el;
          if (el && el.clientHeight !== height) setHeight(el.clientHeight);
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * ROW, position: "relative" }}>
          {rows.slice(first, last).map((o, i) => (
            <div
              key={o.metadata.uid}
              role="row"
              tabIndex={0}
              className={"tr" + (props.selected === o.metadata.uid ? " selected" : "")}
              style={{ ...template, position: "absolute", top: (first + i) * ROW, left: 0, right: 0, height: ROW }}
              onClick={() => props.onSelect(o)}
              onKeyDown={(e) => e.key === "Enter" && props.onSelect(o)}
            >
              {columns.map((c) => {
                const cell = c.cell(o, now);
                return (
                  <span key={c.id} role="gridcell" className={"td" + (cell.tone ? ` tone-${cell.tone}` : "")} title={cell.title ?? cell.text}>
                    {cell.tone && c.id === "status" ? <i className={`dot tone-${cell.tone}`} /> : null}
                    {cell.text}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}
