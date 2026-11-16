// A view's problems (wave 10 part 3): the doctor's rows (D211's closed shape) drawn as the Problems page draws its
// rows: the kind's tile in the problem's tone, the rule's title, kind and namespace, the cleaned fact text. A row whose
// subject Landlens knows opens its drawer, and its object menu on right-click (the person's own actions).
import type { SourceData } from "@landlens/contracts";
import { Ic, iconOfKind } from "../icons";
import { cellWords, refKey, toneOf, type BlockDoc } from "../viewBlocks";
import type { RowHands } from "./hands";

export function ProblemsBlock({ d, hands }: { b: BlockDoc; d: SourceData | undefined; hands: RowHands }) {
  const rows = (d?.state === "ok" || d?.state === "loading" ? d.rows : []).slice(0, 200);
  if (!rows.length) return d?.state === "ok" ? <p className="vb-empty small"><span className="dot tone-ok" /> No problems found here.</p> : null;
  return (
    <ul className="vb-probs">
      {rows.map((r, i) => {
        const ref = r._ref;
        const tone = toneOf(r.tone) ?? r._tone ?? "warn";
        const title = cellWords(r.title);
        const kind = cellWords(r.kind);
        const on = !!ref && hands.selected === refKey(ref);
        return (
          <li key={i} className={"ov-row pb-row" + (on ? " on" : "")} {...(ref ? {
            tabIndex: 0, role: "button", "aria-label": `${tone === "bad" ? "Failing" : "To watch"}: ${title}. ${kind} ${cellWords(r.name)}`,
            onClick: () => hands.open(ref),
            onContextMenu: (e: React.MouseEvent) => (e.preventDefault(), hands.menu(ref, { x: e.clientX, y: e.clientY }, tone)),
            onKeyDown: (e: React.KeyboardEvent) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), hands.open(ref)),
          } : {})}>
            <span className={`kind-tile sm ${tone}`}><Ic icon={iconOfKind(kind)} size={14} /></span>
            <div className="ov-main">
              <div className="ov-name">
                <span className="pb-title">{title}</span>
                <span className="ov-kind">{kind}</span>
                <span className="dim">{[cellWords(r.namespace), cellWords(r.name)].filter(Boolean).join("/")}</span>
              </div>
              {r.detail ? <div className="ov-detail mono" title={cellWords(r.detail)}>{cellWords(r.detail)}</div> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
