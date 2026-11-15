// Editing an object's YAML (D24–D31), and creating objects from YAML (D32). Nothing is sent until you review: Review
// dry-runs exactly what Apply will send (only the fields you changed, with the version you started from) and shows
// the live object against the dry run's result. If someone changes the object while you edit, your lines are moved
// onto theirs; where you both changed a field, yours is kept and the banner says which.
import type { ChangeOperation, ChangeRisk, ClusterInfo, EditOwner, EditProblem, EditReview, KubeObject, ResourceType } from "@landlens/contracts";
import { diffLines } from "@landlens/kube/diff";
import { applyMergePatch, editable, mergePatch, overlaps, patchPaths } from "@landlens/kube/edit-yaml";
import { Check, CircleX, Maximize2, Minimize2, Pencil, ShieldCheck, Sparkles, TriangleAlert, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parse, stringify } from "yaml";
import type { AskContext } from "./AgentDock";
import { api, type ApiError } from "./api";
import { Diff, ORDER, RISK } from "./ChangeCard";
import { CodeEditor, type CodeEditorHandle, type LineMark } from "./CodeEditor";
import { setEditGuard } from "./editGuard";
import { Ic, MOD } from "./icons";

const toYaml = (o: unknown) => stringify(o, { lineWidth: 0 });
const SHORT = 40;

type Stage =
  | { s: "edit"; problems?: EditProblem[]; note?: string }
  | { s: "reviewing" }
  | { s: "review"; review: EditReview }
  | { s: "applying"; review: EditReview }
  | { s: "done"; results: string[]; ops: ChangeOperation[] };

const inside = (el: Element | null, box: HTMLElement | null) => !!el && !!box && (box.contains(el) || el === document.body);

/** The changed lines of `text` against `base` (the green edge), and the summary "+2 −1". */
function changes(base: string, text: string) {
  const d = diffLines(base, text, 0);
  const lines = d.lines.filter((l) => l.t === "+" && l.newNo).map((l) => l.newNo!);
  return { lines, added: d.added, removed: d.removed };
}

/** The editor for one object: in the drawer's YAML tab, or wide. */
export function YamlEdit(props: {
  cluster: ClusterInfo;
  type: ResourceType;
  object: KubeObject;
  onAsk: (c: AskContext) => void;
  onClose: () => void;
  /** Applied: what to say above the read-only view the tab returns to (D31). */
  onApplied: (summary: string) => void;
}) {
  const { type, object: live } = props;
  const [base, setBase] = useState(() => ({ rv: live.metadata.resourceVersion ?? "", yaml: toYaml(editable(live)) }));
  const [text, setText] = useState(base.yaml);
  const [stage, setStage] = useState<Stage>({ s: "edit" });
  const [wide, setWide] = useState(false);
  const [rebased, setRebased] = useState<{ theirs: string[]; both: string[] }>();
  const [asking, setAsking] = useState<() => void>();
  const editor = useRef<CodeEditorHandle>(null);
  const applyBtn = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null);
  // A review left open when the editor goes (a tab switch, the drawer closing) is dropped in main too.
  const reviewId = useRef<string>(undefined);
  reviewId.current = stage.s === "review" ? stage.review.id : undefined;
  useEffect(() => () => {
    if (reviewId.current) void api.invoke("edit:discard", { id: reviewId.current }).catch(() => {});
  }, []);
  const ch = useMemo(() => changes(base.yaml, text), [base.yaml, text]);
  const what = `${type.kind.toLowerCase()} ${live.metadata.namespace ? `${live.metadata.namespace}/` : ""}${live.metadata.name}`;
  const dirty = ch.added + ch.removed > 0 && stage.s !== "done";

  // Leaving with changes asks first, in the foot (D31).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    setEditGuard((go) => {
      if (!dirtyRef.current) return true;
      setAsking(() => go);
      return false;
    });
    return () => setEditGuard(undefined);
  }, []);

  // Someone changed it while you edit (D29): move your lines onto theirs.
  useEffect(() => {
    const rv = live.metadata.resourceVersion ?? "";
    if (!rv || rv === base.rv || stage.s === "applying" || stage.s === "done") return;
    let mine: unknown;
    try {
      mine = mergePatch(parse(base.yaml), parse(text));
    } catch {
      return; // your text doesn't parse yet: the banner waits for Review, which will say so
    }
    const theirsObj = editable(live);
    const theirs = mergePatch(parse(base.yaml), theirsObj);
    const both = overlaps(patchPaths(mine), patchPaths(theirs));
    const nextBase = toYaml(theirsObj);
    const nextText = ch.added + ch.removed ? toYaml(applyMergePatch(theirsObj, mine)) : nextBase;
    setBase({ rv, yaml: nextBase });
    setText(nextText);
    if (ch.added + ch.removed) setRebased({ theirs: patchPaths(theirs).map((p) => p.join(".")), both });
    if (stage.s === "review") {
      if (stage.review.id) void api.invoke("edit:discard", { id: stage.review.id }).catch(() => {});
      setStage({ s: "edit", note: "The object changed after your review; review again." });
    }
  }, [live.metadata.resourceVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const review = async () => {
    if (!dirty || stage.s !== "edit") return;
    setStage({ s: "reviewing" });
    try {
      const r = await api.invoke("edit:review", {
        handle: props.cluster.handle,
        type: { group: type.group, version: type.version, resource: type.resource, kind: type.kind, namespaced: type.namespaced },
        ...(live.metadata.namespace ? { namespace: live.metadata.namespace } : {}),
        name: live.metadata.name, base: base.rv, original: base.yaml, edited: text,
      });
      if (r.id && r.operations) {
        setStage({ s: "review", review: r });
        // Focus moves to Apply only if it was still in the editor: never pulled from the dock or a terminal.
        if (inside(document.activeElement, host.current)) setTimeout(() => applyBtn.current?.focus(), 0);
      } else setStage({ s: "edit", problems: r.problems ?? [], ...(r.conflict ? { note: "Someone changed it since you started; your lines will move onto theirs." } : {}) });
    } catch (e) {
      setStage({ s: "edit", problems: [{ message: (e as ApiError).message }] });
    }
  };

  const apply = async () => {
    if (stage.s !== "review" || !stage.review.id) return;
    const r = stage.review;
    setStage({ s: "applying", review: r });
    try {
      await api.invoke("edit:apply", { handle: props.cluster.handle, id: r.id! });
      const d = r.operations?.[0]?.diff;
      setEditGuard(undefined);
      setStage({ s: "done", results: [], ops: r.operations ?? [] });
      props.onApplied(`Applied · ${what}${d ? ` · +${d.added} −${d.removed}` : ""}`);
      props.onClose();
    } catch (e) {
      const err = e as ApiError;
      setStage({ s: "edit", problems: [{ message: err.message }], ...(err.status === 409 ? { note: "Someone changed it after your review. Your lines are kept; review again." } : {}) });
    }
  };

  const back = () => {
    if (stage.s === "review" && stage.review.id) void api.invoke("edit:discard", { id: stage.review.id }).catch(() => {});
    setStage({ s: "edit" });
    setTimeout(() => editor.current?.focus(), 0);
  };

  const discard = () => {
    setText(base.yaml);
    setAsking(undefined);
    setEditGuard(undefined);
    props.onClose();
  };

  const problems = stage.s === "edit" ? stage.problems ?? [] : [];
  const owners: EditOwner[] = stage.s === "review" || stage.s === "applying" ? stage.review.owners ?? [] : [];
  const marks: LineMark[] = useMemo(() => [
    ...ch.lines.map((line) => ({ line, kind: "chg" as const })),
    ...problems.filter((p) => p.line).map((p) => ({ line: p.line!, kind: "bad" as const, message: p.message })),
  ], [ch.lines, problems]);
  const pathless = problems.filter((p) => !p.line);
  // A replaced line is one changed line: count the larger side.
  const n = Math.max(ch.added, ch.removed);
  const counted = `${n} line${n === 1 ? "" : "s"} changed`;

  if (stage.s === "done") return null;

  const body = (
    <div ref={host} className={"yaml-edit" + (wide ? " wide" : "")} role={wide ? "dialog" : undefined} aria-label={wide ? `Edit ${what}` : undefined}>
      <div className="yaml-bar">
        <Ic icon={Pencil} size={12} />
        <span>Editing {what}. Status and bookkeeping aren't shown.</span>
        <span className="grow" />
        <button className="icon-btn" aria-label={wide ? "Back to the drawer" : "Edit wide"} title={wide ? "Back to the drawer" : "Edit wide"} onClick={() => setWide((w) => !w)}>
          <Ic icon={wide ? Minimize2 : Maximize2} size={13} />
        </button>
      </div>
      {rebased ? (
        <div className={"change-warn" + (rebased.both.length ? " warn" : "")} role="status">
          <Ic icon={TriangleAlert} size={13} />
          <span>
            Someone changed this object while you were editing{rebased.theirs.length ? ` (${rebased.theirs.slice(0, 3).join(", ")}${rebased.theirs.length > 3 ? "…" : ""})` : ""}.{" "}
            {rebased.both.length ? <>You both changed <b className="mono">{rebased.both.join(", ")}</b>; yours is kept.</> : <>Your {counted} still apply on top of it.</>}
          </span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setRebased(undefined)}><Ic icon={X} size={12} /></button>
        </div>
      ) : null}
      {stage.s === "review" || stage.s === "applying" ? (
        <ReviewCard
          title={`Edit ${what}`}
          review={stage.review}
          owners={owners}
          applying={stage.s === "applying"}
          applyRef={applyBtn}
          onApply={apply}
          onBack={back}
          {...(stage.review.agent ? {
            onAsk: () => props.onAsk({ label: `My edit · ${live.metadata.name}`, text: `Dry-run diff of my edit to ${what} (live → after):\n${stage.review.agent}`, source: `the cluster's dry run of my edit to ${what}, scrubbed as your reads are`, kind: "edit" }),
          } : {})}
        />
      ) : (
        <>
          <div className="cm">
            <CodeEditor ref={editor} label={`YAML of ${what}`} value={text} onChange={setText} marks={marks} onSubmit={review}
              onEscape={() => (asking ? setAsking(undefined) : dirty ? setAsking(() => props.onClose) : props.onClose())} />
          </div>
          <div className="edit-foot">
            {stage.s === "edit" && stage.note ? <div className="change-fact warn"><Ic icon={TriangleAlert} size={12} />{stage.note}</div> : null}
            {problems.length ? (
              <div className="change-fact bad" role="alert">
                <Ic icon={CircleX} size={12} />
                {problems.some((p) => p.line)
                  ? `The cluster refused this: ${problems.length} problem${problems.length === 1 ? "" : "s"}${problems.find((p) => p.line) ? `, on line ${problems.filter((p) => p.line).map((p) => p.line).join(", ")}` : ""}. Nothing has changed.`
                  : pathless[0]?.message === "Nothing changed" ? "Nothing changed." : `Not sent: ${pathless.map((p) => p.message).join("; ")}`}
              </div>
            ) : null}
            {problems.some((p) => p.line) && pathless.length ? <div className="change-fact bad">{pathless.map((p) => p.message).join("; ")}</div> : null}
            {asking ? (
              <div className="change-actions">
                <span className="change-fact warn"><Ic icon={TriangleAlert} size={12} />Discard {n} changed line{n === 1 ? "" : "s"}?</span>
                <button className="danger" autoFocus onClick={() => {
                  const go = asking;
                  setText(base.yaml);
                  setAsking(undefined);
                  setEditGuard(undefined);
                  go();
                }}>Discard</button>
                <button className="secondary" onClick={() => (setAsking(undefined), editor.current?.focus())}>Keep editing</button>
              </div>
            ) : (
              <div className="change-actions">
                <span className="change-fact">{dirty ? <>{counted}. Nothing is sent until you review.</> : "Change the YAML, then review it."}</span>
                <button className="primary" disabled={!dirty || stage.s === "reviewing"} onClick={review}>
                  {stage.s === "reviewing" ? <><span className="spinner" />Checking…</> : <>Review<kbd aria-hidden="true">{MOD}⏎</kbd></>}
                </button>
                <button className="secondary" onClick={dirty ? () => setAsking(() => discard) : props.onClose}>{dirty ? "Discard" : "Cancel"}</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
  return wide ? <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && setWide(false)}>{body}</div> : body;
}

/** The dry run, as a card of your own (D27): no iris ring, "Your edit", the diff, Apply or Back to editing. */
export function ReviewCard(props: {
  title: string;
  review: EditReview;
  owners?: EditOwner[];
  applying: boolean;
  applyRef: React.RefObject<HTMLButtonElement | null>;
  onApply: () => void;
  onBack: () => void;
  onAsk?: () => void;
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
    // A keyboard press (detail 0) in the first half second is a key meant for something else; a click is deliberate.
    if (e.detail === 0 && Date.now() - shownAt.current < 500) return;
    // The whole change is on screen before it can be sent.
    if (capped) return setUncapped(new Set(ops.map((_, i) => i)));
    if (danger && !confirm) return setConfirm(true);
    props.onApply();
  };
  return (
    <section className="change mine" aria-label="Review your edit"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !props.applying) (e.preventDefault(), e.stopPropagation(), props.onBack());
      }}>
      <div className="change-head">
        <div className="change-eyebrow"><Ic icon={User} size={13} /><span>Your edit</span></div>
        <h3 className="change-title">{props.title}</h3>
      </div>
      {risks.length ? (
        <div className="change-risks" aria-label="Risks">
          {risks.map((r) => <span key={r} className={`badge ${RISK[r].level === "danger" ? "bad" : "warn"}`} title={RISK[r].title}><Ic icon={RISK[r].icon} size={13} />{RISK[r].words}</span>)}
        </div>
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
        <div className="change-fact"><Ic icon={ShieldCheck} size={12} />Dry run passed. Nothing has changed yet.</div>
        {props.applying ? (
          <div className="change-applying" role="status"><span className="spinner" />Applying…</div>
        ) : confirm ? (
          <div className="change-actions">
            <span className="change-fact bad"><Ic icon={TriangleAlert} size={12} />{risks.filter((r) => RISK[r].level === "danger").map((r) => RISK[r].words).join(", ")}. Apply anyway?</span>
            {/* Not focused, and Enter doesn't press it: the danger needs a deliberate click. */}
            <button className="danger" onClick={props.onApply} onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}>Apply</button>
            <button className="secondary" autoFocus onClick={() => setConfirm(false)}>Back</button>
          </div>
        ) : (
          <div className="change-actions">
            {capped ? (
              <button ref={props.applyRef} className="primary" onClick={apply}>Show the whole change</button>
            ) : danger ? (
              <button ref={props.applyRef} className="danger" onClick={apply}><Ic icon={TriangleAlert} size={13} />Apply…</button>
            ) : (
              <button ref={props.applyRef} className="primary" onClick={apply}><Ic icon={Check} size={13} />Apply<kbd aria-hidden="true">↵</kbd></button>
            )}
            <button className="secondary" onClick={props.onBack}>Back to editing<kbd aria-hidden="true">esc</kbd></button>
            {props.onAsk ? <button className="link-btn small" onClick={props.onAsk}><Ic icon={Sparkles} size={12} />Ask Claude to check it</button> : null}
          </div>
        )}
      </div>
    </section>
  );
}
