// A view's list (wave 10 part 3): a primary line, a secondary in the quiet ink, a tone edge from `toneField` or the
// row's own `_tone`. A row of a kube source opens its drawer on click or Enter, and its object menu on right-click,
// ⋯ or Shift+F10 (wave 8's menu, the person's actions). Every value is text.
import type { SourceData } from "@landlens/contracts";
import { Ellipsis } from "lucide-react";
import { Ic } from "../icons";
import { cellWords, refKey, toneOf, type BlockDoc } from "../viewBlocks";
import type { RowHands } from "./hands";

export function ListBlock({ b, d, hands, now }: { b: BlockDoc; d: SourceData | undefined; hands: RowHands; now: number }) {
  const rows = (d?.state === "ok" || d?.state === "loading" ? d.rows : []).slice(0, b.max ?? 50);
  const acts = b.rowActions !== false;
  if (!rows.length) return d?.state === "ok" ? <p className="vb-empty dim small">No rows.</p> : null;
  return (
    <ul className="vb-items">
      {rows.map((r, i) => {
        const ref = r._ref;
        const tone = b.toneField ? toneOf(r[b.toneField]) : r._tone;
        const on = !!ref && hands.selected === refKey(ref);
        const primary = cellWords(r[b.primary ?? ""], "text", now);
        return (
          <li key={ref ? `${refKey(ref)}#${i}` : i} className={`vb-li${tone === "bad" || tone === "warn" ? ` row-${tone}` : ""}${ref && acts ? " actionable" : ""}${on ? " on" : ""}`}
            {...(ref && acts ? {
              tabIndex: 0, role: "button", "aria-label": `${primary}${b.secondary ? `, ${cellWords(r[b.secondary], "text", now)}` : ""}`,
              onClick: () => hands.open(ref),
              onContextMenu: (e: React.MouseEvent) => (e.preventDefault(), hands.menu(ref, { x: e.clientX, y: e.clientY }, tone)),
              onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") (e.preventDefault(), hands.open(ref));
                else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  hands.menu(ref, { x: box.left + 24, y: box.bottom }, tone);
                }
              },
            } : {})}>
            <span className="vb-primary">{primary}</span>
            {b.secondary ? <span className="vb-secondary">{cellWords(r[b.secondary], "text", now)}</span> : null}
            {ref && acts ? (
              <button className="icon-btn sm vb-more" tabIndex={-1} aria-label={`Actions for ${primary}`}
                onClick={(e) => (e.stopPropagation(), hands.menu(ref, { x: e.clientX, y: e.clientY }, tone))}><Ic icon={Ellipsis} size={14} /></button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
