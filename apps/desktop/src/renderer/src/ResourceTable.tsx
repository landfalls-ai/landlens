import type { KubeObject } from "@landlens/contracts";
import type { Tone } from "@landlens/kube/status";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Ic, kindIcon, TONE_ICON } from "./icons";
import type { Cell, Column } from "./kinds";
import { restartTone, splitName, statusTone } from "./present";

const ROW = 32;
const NUMERIC = new Set(["restarts", "age", "count", "last", "keys"]);
const SPLIT = new Set(["pods", "replicasets"]);

/** A row's tone: its status, or for workloads its Ready count. Drives the left edge and the Ready colour. */
export function rowTone(columns: Column[], o: KubeObject, now: number): Tone | undefined {
  const status = columns.find((c) => c.id === "status")?.cell(o, now);
  if (status?.tone) return statusTone(status.text, status.tone);
  return columns.find((c) => c.id === "ready")?.cell(o, now).tone;
}

/**
 * A sortable table that only renders the rows in view, so 10k pods scroll smoothly. Rows are 32px inset pills; a
 * failing or waiting row gets a coloured edge at the far left, so trouble shows even when Status is out of view.
 */
export function ResourceTable(props: {
  resource: string;
  columns: Column[];
  items: KubeObject[];
  now: number;
  loading: boolean;
  selected?: string;
  /** Width of the main pane: narrow panes drop Node, then Ready. */
  width: number;
  /** Pixels on the right that a floating drawer covers (a narrow window with the dock and a drawer open). */
  covered?: number;
  /** One namespace is selected, so the Namespace column would repeat it. */
  oneNamespace: boolean;
  empty: { title: string; onClear?: () => void };
  onSelect: (o: KubeObject) => void;
  /** A row's menu (right-click, Shift+F10), at a point. */
  onMenu?: (o: KubeObject, x: number, y: number) => void;
  /** Single-key actions on the focused row (D6): L logs, S shell. */
  onAction?: (o: KubeObject, action: "logs" | "shell" | "edit") => void;
}) {
  const { items, now } = props;
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>({ id: "name", dir: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [focus, setFocus] = useState(-1);
  const box = useRef<HTMLDivElement | null>(null);
  const lastStatus = useRef(new Map<string, string>());
  const changedAt = useRef(new Map<string, number>());

  // Column priority as the pane narrows: Node, then Ready (when there is a Status), then Age, Namespace, Restarts.
  // Name never goes under 180px; a row's trouble still shows in its left edge.
  // Under a floating drawer only a strip of the table shows: Status becomes a 16px icon column at the left, so which
  // rows are in trouble stays visible next to their names.
  const covered = props.covered ?? 0;
  const columns = useMemo(() => {
    const w = props.width - covered;
    const hasStatus = props.columns.some((x) => x.id === "status");
    const drop = (id: string) =>
      (id === "node" && w < 860) || (id === "ready" && hasStatus && w < 700) || (id === "age" && w < 600) ||
      (id === "namespace" && (props.oneNamespace || w < 540)) || (id === "restarts" && w < 470);
    const kept = props.columns.filter((c) => !drop(c.id));
    const status = kept.find((c) => c.id === "status");
    if (!covered || !status || w >= 420) return kept;
    return [{ ...status, id: "status-icon", label: "", width: "32px" }, ...kept.filter((c) => c !== status)];
  }, [props.columns, props.width, props.oneNamespace, covered]);

  const rows = useMemo(() => {
    const col = props.columns.find((c) => c.id === sort.id) ?? props.columns[0]!;
    const keyed = items.map((o) => {
      const cell = col.cell(o, now);
      return { o, k: cell.sort ?? cell.text };
    });
    keyed.sort((a, b) => {
      const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k), undefined, { numeric: true });
      return (c || a.o.metadata.name.localeCompare(b.o.metadata.name)) * sort.dir;
    });
    return keyed.map((x) => x.o);
  }, [items, props.columns, sort, now]);

  // A status change flashes its row once, so a pod going bad is noticed.
  useMemo(() => {
    const status = props.columns.find((c) => c.id === "status");
    if (!status) return;
    const t = Date.now();
    for (const o of items) {
      const text = status.cell(o, now).text;
      const prev = lastStatus.current.get(o.metadata.uid);
      if (prev !== undefined && prev !== text) changedAt.current.set(o.metadata.uid, t);
      lastStatus.current.set(o.metadata.uid, text);
    }
  }, [items, props.columns, now]);

  const widths = columns.map((c) => c.width ?? "minmax(100px, 1fr)");
  const template: CSSProperties = { gridTemplateColumns: widths.join(" ") };
  // The narrowest the columns can go; below that the table scrolls sideways instead of clipping columns.
  const minWidth = widths.reduce((sum, w) => sum + Number(/(\d+)px/.exec(w)?.[1] ?? 100), 0) + 28;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 10);
  const split = SPLIT.has(props.resource);

  const moveFocus = (to: number) => {
    const el = box.current;
    if (!el || !rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, to));
    setFocus(i);
    const inner = el.clientHeight - 12;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + inner) el.scrollTop = (i + 1) * ROW - inner;
    requestAnimationFrame(() => (el.querySelector(`[data-idx="${i}"]`) as HTMLElement | null)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "j") (e.preventDefault(), moveFocus(focus + 1));
    else if (e.key === "ArrowUp" || e.key === "k") (e.preventDefault(), moveFocus(focus - 1));
  };

  return (
    <div className="table" role="grid" aria-rowcount={rows.length}>
      <div className="table-inner" style={{ minWidth }}>
        <div className="thead" style={template} role="row">
          {columns.map((c) => {
            const id = c.id === "status-icon" ? "status" : c.id;
            const on = sort.id === id;
            return (
              <button
                key={c.id}
                className={"th" + (NUMERIC.has(c.id) ? " num" : "") + (on ? " sorted" : "")}
                role="columnheader"
                aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                onClick={() => setSort((s) => ({ id, dir: s.id === id ? (s.dir === 1 ? -1 : 1) : 1 }))}
              >
                {c.label || <span className="sr-only">{c.id === "status-icon" ? "Status" : c.id}</span>}
                {on ? <Ic icon={sort.dir === 1 ? ArrowUp : ArrowDown} size={11} /> : null}
              </button>
            );
          })}
        </div>
        <div
          className="tbody"
          ref={(el) => {
            box.current = el;
            if (el && el.clientHeight !== height) setHeight(el.clientHeight);
          }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKey}
        >
          {props.loading ? (
            <Skeleton />
          ) : !rows.length ? (
            <div className="empty">
              <span className="kind-tile lg"><Ic icon={kindIcon(props.resource)} size={20} /></span>
              <strong>{props.empty.title}</strong>
              {props.empty.onClear ? <button className="secondary" onClick={props.empty.onClear}>Clear filter</button> : null}
            </div>
          ) : (
            <div style={{ height: rows.length * ROW, position: "relative" }}>
              {rows.slice(first, last).map((o, i) => {
                const idx = first + i;
                const tone = rowTone(props.columns, o, now);
                const flash = Date.now() - (changedAt.current.get(o.metadata.uid) ?? 0) < 600;
                return (
                  <div
                    key={o.metadata.uid}
                    role="row"
                    data-idx={idx}
                    tabIndex={idx === focus || (focus < 0 && idx === 0) ? 0 : -1}
                    className={"tr" + (props.selected === o.metadata.uid ? " selected" : "") + (tone === "bad" || tone === "warn" ? ` row-${tone}` : "") + (flash ? " flash" : "")}
                    style={{ ...template, position: "absolute", top: idx * ROW, left: 0, right: 0, height: ROW }}
                    onClick={() => {
                      setFocus(idx);
                      props.onSelect(o);
                    }}
                    onContextMenu={(e) => {
                      if (!props.onMenu) return;
                      e.preventDefault();
                      setFocus(idx);
                      props.onMenu(o, e.clientX, e.clientY);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") return props.onSelect(o);
                      if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        return props.onMenu?.(o, r.left + 24, r.bottom);
                      }
                      if (e.metaKey || e.ctrlKey || e.altKey) return;
                      if (e.key === "l" || e.key === "L") return props.onAction?.(o, "logs");
                      if (e.key === "s" || e.key === "S") return props.onAction?.(o, "shell");
                      if (e.key === "e" || e.key === "E") return props.onAction?.(o, "edit");
                    }}
                  >
                    {columns.map((c) => <Td key={c.id} col={c} cell={c.cell(o, now)} o={o} rowTone={tone} split={split} />)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Td({ col, cell, o, rowTone, split }: { col: Column; cell: Cell; o: KubeObject; rowTone?: Tone; split: boolean }) {
  const title = cell.title ?? cell.text;
  switch (col.id) {
    case "name": {
      const { base, hash } = split ? splitName(o) : { base: cell.text, hash: "" };
      return <span role="gridcell" className="td name" title={title}>{base}{hash ? <span className="hash">{hash}</span> : null}</span>;
    }
    case "namespace":
      return <span role="gridcell" className="td ns" title={title}>{cell.text}</span>;
    case "ready": {
      const short = cell.tone && cell.tone !== "ok";
      const t = short ? (rowTone === "bad" || rowTone === "warn" ? rowTone : cell.tone === "bad" ? "bad" : "muted") : "muted";
      return <span role="gridcell" className={`td ready tone-${t}`} title={title}>{cell.text}</span>;
    }
    case "status":
      return <span role="gridcell" className="td" title={title}>{cell.tone ? <Status text={cell.text} tone={cell.tone} /> : cell.text}</span>;
    case "status-icon": {
      const t = cell.tone ? statusTone(cell.text, cell.tone) : "muted";
      return (
        <span role="gridcell" className={`td st-icon tone-${t}`} title={cell.text}>
          {t === "ok" ? <i className="dot" /> : <Ic icon={TONE_ICON[t]} size={16} />}
          <span className="sr-only">{cell.text}</span>
        </span>
      );
    }
    case "restarts": {
      const n = typeof cell.sort === "number" ? cell.sort : Number(cell.text) || 0;
      return <span role="gridcell" className={`td num ${restartTone(n).cls}`} title={title}>{cell.text}</span>;
    }
    case "age":
    case "last":
      return <span role="gridcell" className="td age" title={title}>{cell.text}</span>;
    default:
      return <span role="gridcell" className={"td plain" + (NUMERIC.has(col.id) ? " num" : "") + (cell.tone ? ` tone-${cell.tone}` : "")} title={title}>{cell.text}</span>;
  }
}

/** Healthy is quiet (a dot and the word), trouble is loud (a pill with its own icon). */
export function Status({ text, tone }: { text: string; tone: Tone }) {
  const t = statusTone(text, tone);
  if (t === "ok") return <span className="st tone-ok"><i className="dot" />{text}</span>;
  if (t === "muted") return <span className="st tone-muted"><Ic icon={TONE_ICON.muted} size={13} />{text}</span>;
  return <span className={`badge ${t}`}><Ic icon={TONE_ICON[t]} size={13} />{text}</span>;
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="skel-row">
          <span className="skel" style={{ width: "40%" }} />
          <span className="skel" style={{ width: 70 }} />
          <span className="skel" style={{ width: 44 }} />
        </div>
      ))}
    </div>
  );
}
