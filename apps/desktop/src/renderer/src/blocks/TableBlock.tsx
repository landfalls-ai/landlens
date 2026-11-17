// A view's table (wave 10 part 3, D206, D218), drawn by Landlens's own ResourceTable: virtual scroll for 2,000 rows,
// the narrow-pane column rules, tones, sortable headers (the person's tweak, Claude's order until one is pressed), and
// for a row of a kube source wave 8's hands: a click opens its drawer, right-click or ⋯ its object menu, the row keys,
// and with `select` the checkboxes that feed the selection bar. Every cell is text.
import type { RowRef, SourceData } from "@landlens/contracts";
import { useMemo } from "react";
import { useWidth } from "../charts/useWidth";
import { ResourceTable } from "../ResourceTable";
import type { Sort } from "../tableState";
import { rowObjects, rowOf, tableColumns, tweakSort, type BlockDoc } from "../viewBlocks";
import { useTweak } from "../viewStore";
import type { RowHands } from "./hands";

const ROW = 32;

export function TableBlock(props: { view: string; block: string; b: BlockDoc; d: SourceData | undefined; hands: RowHands; now: number }) {
  const { b, d, hands } = props;
  const rows = d?.rows ?? [];
  const objects = useMemo(() => rowObjects(rows, b.columns?.[0]?.field), [rows, b.columns]);
  const [tweak, setTweak] = useTweak(props.view, props.block);
  // The person's column widths (D214), kept with the saved view; Claude's width otherwise.
  const columns = useMemo(() => tableColumns(b.columns ?? []).map((c) => (tweak.widths?.[c.id] ? { ...c, width: `${tweak.widths[c.id]}px` } : c)), [b.columns, tweak.widths]);
  const [box, width] = useWidth<HTMLDivElement>();
  // A sort on a column the shown version no longer has is Claude's order again.
  const sort: Sort = tweakSort(tweak.sort, columns);
  const acts = b.rowActions !== false;
  const refOf = (uid: string): RowRef | undefined => rowOf(objects.find((o) => o.metadata.uid === uid) ?? ({} as never))._ref;
  const withRefs = objects.some((o) => rowOf(o)._ref);
  const uids = useMemo(() => new Set(objects.filter((o) => hands.picked.has(o.metadata.uid)).map((o) => o.metadata.uid)), [objects, hands.picked]);
  const height = Math.min(480, 40 + 14 + Math.max(objects.length, 3) * ROW);
  return (
    <div className="vb-rt" ref={box} style={{ height }}>
      <ResourceTable
        resource="view"
        columns={columns}
        items={objects}
        now={props.now}
        loading={!!d && d.state === "loading" && !rows.length}
        {...(hands.selected ? { selected: hands.selected } : {})}
        width={width || 600}
        oneNamespace={false}
        empty={{ title: d && d.state !== "ok" && d.state !== "loading" ? "Nothing to show" : "No rows" }}
        sort={sort}
        onSort={(s) => setTweak({ ...tweak, sort: s })}
        onResize={(id, px) => setTweak({ ...tweak, widths: { ...(tweak.widths ?? {}), [id]: px } })}
        toneOf={(o) => rowOf(o)._tone}
        onSelect={(o) => {
          const r = rowOf(o)._ref;
          if (r && acts) hands.open(r);
        }}
        {...(acts ? {
          onMenu: (o, x, y) => {
            const r = rowOf(o)._ref;
            if (r) hands.menu(r, { x, y }, rowOf(o)._tone);
          },
          onAction: (o, a) => {
            const r = rowOf(o)._ref;
            if (r) hands.key(r, a);
          },
        } : {})}
        {...(b.select && acts && withRefs ? {
          selection: {
            uids,
            onChange: (next) => hands.pick([...next].map(refOf).filter((r): r is RowRef => !!r)),
          },
        } : {})}
      />
    </div>
  );
}
