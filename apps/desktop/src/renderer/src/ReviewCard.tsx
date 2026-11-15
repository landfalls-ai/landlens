// The dry run as a card of your own (D27): your YAML edits, your new objects, and your actions (wave 8, D145). No iris
// ring (that belongs to the agent's asks), "Your edit" or "Your action", risk tags, main's facts, the diff, warnings,
// then Apply or Back. Apply is a press of the button itself, never Enter elsewhere, never in the first half second; a
// danger asks twice with Back focused; a capped diff must be shown whole first.
import type { ActionFact, ChangeRisk, EditOwner, EditReview } from "@landlens/contracts";
import { Check, CircleX, Info, ShieldCheck, Sparkles, TriangleAlert, User } from "lucide-react";
import { useRef, useState } from "react";
import { Diff, ORDER, RISK } from "./ChangeCard";
import { Ic } from "./icons";

const SHORT = 40;

/** The dry run, as a card of your own (D27): no iris ring, "Your edit", the diff, Apply or Back to editing. */
export function ReviewCard(props: {
  title: string;
  review: EditReview;
  /** "Your edit" (the default) or "Your action" (D145). */
  eyebrow?: string;
  /** Main's facts beside the diff (D142): one quiet list under the risk tags. */
  facts?: ActionFact[];
  /** Apply asks in main's own dialog (D143): the button says what it will ask about, with an ellipsis. */
  nativeLabel?: string;
  /** The foot's link: "Ask Claude to check it" for an edit, the action's own words for an action (D148). */
  askLabel?: string;
  owners?: EditOwner[];
  applying: boolean;
  applyRef: React.RefObject<HTMLButtonElement | null>;
  onApply: () => void;
  onBack: () => void;
  onAsk?: () => void;
  backLabel?: string;
  /**
   * A development build's cordon on a cluster it may not write nodes to (D153): Landlens's own reading of the patch,
   * not the cluster's dry run. This sentence stands in place of "Dry run passed", and Apply is off.
   */
  previewOnly?: string;
}) {
  const ops = props.review.operations ?? [];
  const risks: ChangeRisk[] = ORDER.filter((r) => ops.some((o) => o.risk.includes(r)));
  const danger = risks.some((r) => RISK[r].level === "danger");
  const [confirm, setConfirm] = useState(false);
  const [uncapped, setUncapped] = useState<Set<number>>(new Set());
  const warnings = ops.flatMap((o) => o.warnings);
  // Apply is a press of the Apply button itself (Enter on it, or a click), not Enter anywhere in the card, and not in
  // the first half second, so a key meant for something else can't send it (security review, part 2, finding 2).
  const shownAt = useRef(Date.now());
  const capped = ops.some((op, i) => op.diff.lines.length > SHORT && !uncapped.has(i));
  const apply = (e: React.MouseEvent) => {
    if (props.previewOnly) return;
    // A keyboard press (detail 0) in the first half second is a key meant for something else; a click is deliberate.
    if (e.detail === 0 && Date.now() - shownAt.current < 500) return;
    // The whole change is on screen before it can be sent.
    if (capped) return setUncapped(new Set(ops.map((_, i) => i)));
    // A review main asks about in its own dialog (D143) has that as its second step, not the card's.
    if (danger && !confirm && !props.nativeLabel) return setConfirm(true);
    props.onApply();
  };
  return (
    <section className="change mine" aria-label={`Review ${(props.eyebrow ?? "Your edit").toLowerCase()}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !props.applying) (e.preventDefault(), e.stopPropagation(), props.onBack());
      }}>
      <div className="change-head">
        <div className="change-eyebrow"><Ic icon={User} size={13} /><span>{props.eyebrow ?? "Your edit"}</span></div>
        <h3 className="change-title">{props.title}</h3>
      </div>
      {risks.length ? (
        <div className="change-risks" aria-label="Risks">
          {risks.map((r) => <span key={r} className={`badge ${RISK[r].level === "danger" ? "bad" : "warn"}`} title={RISK[r].title}><Ic icon={RISK[r].icon} size={13} />{RISK[r].words}</span>)}
        </div>
      ) : null}
      {props.facts?.length ? (
        <ul className="change-facts" aria-label="What else this does">
          {props.facts.map((f, i) => {
            const [first, ...rest] = f.text.split(" ");
            return (
              <li key={i} className={`fact-${f.tone}`}>
                <Ic icon={f.tone === "bad" ? CircleX : f.tone === "warn" ? TriangleAlert : Info} size={13} />
                <span><b className="first">{first}</b> {rest.join(" ")}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {props.owners?.length ? (
        <div className="change-warn warn">
          <Ic icon={TriangleAlert} size={13} />
          <span>{props.owners.map((o) => <span key={o.path + o.manager} className="owner"><b className="mono">{o.path}</b> is managed by <b>{o.manager}</b>{o.line ? ` (line ${o.line})` : ""}. It may set it back. </span>)}</span>
        </div>
      ) : null}
      {ops.map((op, i) => (
        <div key={i} className="change-op">
          {ops.length > 1 ? <div className="change-op-head mono"><span className="change-verb">{op.verb}</span> {op.kind} {op.namespace ? `${op.namespace}/` : ""}{op.name}</div> : null}
          <Diff op={op} capped={op.diff.lines.length > SHORT && !uncapped.has(i)} create={op.verb === "create"} onUncap={() => setUncapped((s) => new Set(s).add(i))} />
        </div>
      ))}
      {warnings.length ? (
        <div className="change-warnings">
          <span className="change-fact">The cluster's warnings, in its words:</span>
          <ul>{warnings.slice(0, 5).map((w, i) => <li key={i}><Ic icon={TriangleAlert} size={12} />{w}</li>)}</ul>
        </div>
      ) : null}
      <div className="change-foot">
        {props.previewOnly
          ? <div className="change-fact preview-only"><Ic icon={Info} size={12} />{props.previewOnly}</div>
          : <div className="change-fact"><Ic icon={ShieldCheck} size={12} />Dry run passed. Nothing has changed yet.</div>}
        {props.applying ? (
          <div className="change-applying" role="status"><span className="spinner" />Applying…</div>
        ) : confirm ? (
          <div className="change-actions">
            <span className="change-fact bad"><Ic icon={TriangleAlert} size={12} />{risks.filter((r) => RISK[r].level === "danger").map((r) => RISK[r].words).join(", ")}. Apply anyway?</span>
            {/* Not focused, and Enter doesn't press it: the danger needs a deliberate click. */}
            <button className="danger" onClick={props.onApply} onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}>{props.nativeLabel ?? "Apply"}</button>
            <button className="secondary" autoFocus onClick={() => setConfirm(false)}>Back</button>
          </div>
        ) : (
          <div className="change-actions">
            {capped ? (
              <button ref={props.applyRef} className="primary" onClick={apply}>Show the whole change</button>
            ) : danger || props.nativeLabel ? (
              <button ref={props.applyRef} className="danger" disabled={!!props.previewOnly} onClick={apply}><Ic icon={TriangleAlert} size={13} />{props.nativeLabel ?? "Apply…"}</button>
            ) : (
              <button ref={props.applyRef} className="primary" disabled={!!props.previewOnly} onClick={apply}><Ic icon={Check} size={13} />Apply<kbd aria-hidden="true">↵</kbd></button>
            )}
            <button className="secondary" onClick={props.onBack}>{props.backLabel ?? "Back to editing"}<kbd aria-hidden="true">esc</kbd></button>
            {props.onAsk ? <button className="link-btn small" onClick={props.onAsk}><Ic icon={Sparkles} size={12} />{props.askLabel ?? "Ask Claude to check it"}</button> : null}
          </div>
        )}
      </div>
    </section>
  );
}
