// A view's blocks on the Views page (wave 10, D206, D213), on the 12-column grid (one column below 720 px). Part 3
// draws the native blocks with Landlens's own components (blocks/): the table on ResourceTable, the stat, the chart on
// the Overview's chart code, the list, the log on the log view's rules, the doctor's rows, Claude's text through the
// dock's Markdown. Every cell is a React text node: nothing a source delivers is ever markup. An app block is a
// sandboxed frame (AppFrame, D204) in the quieter ring captioned "Built by Claude"; its intents come up to the page.
import type { SourceData, ViewIntent } from "@landlens/contracts";
import { CircleX, MessageSquarePlus } from "lucide-react";
import type { ObjectTarget } from "./app-host";
import { AppFrame } from "./AppFrame";
import { ChartBlock } from "./blocks/ChartBlock";
import type { RowHands } from "./blocks/hands";
import { ListBlock } from "./blocks/ListBlock";
import { LogsBlock } from "./blocks/LogsBlock";
import { ProblemsBlock } from "./blocks/ProblemsBlock";
import { StatBlock } from "./blocks/StatBlock";
import { TableBlock } from "./blocks/TableBlock";
import { TextBlock } from "./blocks/TextBlock";
import { Ic } from "./icons";
import type { BlockDoc } from "./viewBlocks";
import { blockKey } from "./viewStore";

export type { BlockDoc };

/** A source that isn't ok says its fixed sentence in the block's place (D222); loading is a quiet line. */
function Failed({ d, rows }: { d: SourceData | undefined; rows: boolean }) {
  if (!d || d.state === "loading") return rows ? null : <div className="vb-note dim">Reading…</div>;
  if (d.state === "ok") return d.truncated && d.message ? <div className="vb-note dim">{d.message}</div> : null;
  return <div className="vb-note" role="note"><Ic icon={CircleX} size={13} className="tone-warn" />{d.message ?? "This source can't be read."}</div>;
}

/** One block in its grid cell: its title, an "Ask about this" for blocks with rows, then what it draws. */
export function ViewBlock(props: {
  view: string; version: number; b: BlockDoc; i: number; data: (source: string) => SourceData | undefined;
  hands: RowHands; onOpenObject: (t: ObjectTarget) => void; onIntent: (i: ViewIntent, block: string) => boolean;
  onAsk: (block: string, title: string) => void; single: boolean; height: number; now: number;
}) {
  const { b } = props;
  const key = blockKey(b, props.i);
  // A block's own title, or an app block's id; a stat without one shows its label under the number only.
  const title = b.title ?? (b.type === "app" ? b.id : undefined);
  const name = title ?? b.label ?? b.source ?? b.type;
  const span = props.single ? 12 : b.span ?? (b.type === "stat" ? 3 : 12);
  const d = b.source ? props.data(b.source) : undefined;
  const body = () => {
    switch (b.type) {
      case "table": return <TableBlock view={props.view} block={key} b={b} d={d} hands={props.hands} now={props.now} />;
      case "stat": return <StatBlock b={b} d={d} now={props.now} />;
      case "chart": return <ChartBlock b={b} d={d} />;
      case "list": return <ListBlock b={b} d={d} hands={props.hands} now={props.now} />;
      case "logs": return <LogsBlock b={b} d={d} />;
      case "problems": return <ProblemsBlock b={b} d={d} hands={props.hands} />;
      case "text": return <TextBlock view={props.view} block={key} b={b} />;
      default: return null;
    }
  };
  return (
    <section className={`vb vb-${b.type}`} style={{ "--span": span } as React.CSSProperties} aria-label={name}>
      {title || (b.type !== "text" && b.type !== "stat") ? (
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
          onIntent={(i) => props.onIntent(i, name)}
        />
      ) : (
        <>
          {b.type !== "text" ? <Failed d={d} rows={!!d?.rows.length || !!d?.lines?.length} /> : null}
          {body()}
        </>
      )}
    </section>
  );
}
