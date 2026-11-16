// The action sheet (wave 8, D145): one sheet over the main pane for Scale, Restart, Delete, Trigger, Suspend and
// Resume. A form only where there is a choice (Scale's count); then main's dry run as a card of your own ("Your
// action", main's title and facts, the diff); then one line per object that was sent. Nothing is optimistic: the
// table changes when the watch says so. Apply sends the review's id and digest and nothing else; a bulk or wide delete
// asks again in main's own dialog.
import type { ActionResult, ActionReview, ClusterInfo, KubeObject } from "@landlens/contracts";
import { CircleCheck, CircleX, Minus, Plus, TriangleAlert, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askFirst, eyebrowOf, PREVIEW_ONLY, sheetHeading, verbOf, type ActionDraft } from "./actionAsks";
import { api, type ApiError } from "./api";
import type { NavTarget } from "./Details";
import { DrainSheet } from "./DrainPlanView";
import { Ic } from "./icons";
import type { AskContext } from "./quotes";
import { ReviewCard } from "./ReviewCard";

type Stage =
  | { s: "form" }
  | { s: "checking" }
  | { s: "review"; review: ActionReview }
  | { s: "applying"; review: ActionReview }
  /** `head`: Landlens's own line when nothing reached the cluster (a Cancel, the log, a dialog already up), L13. */
  | { s: "problems"; messages: string[]; conflict?: boolean; head?: string }
  | { s: "done"; results: ActionResult[] };

const refOf = (d: ActionDraft, o: KubeObject) => ({
  group: d.type.group, version: d.type.version, resource: d.type.resource, name: o.metadata.name,
  ...(o.metadata.namespace && d.type.namespaced ? { namespace: o.metadata.namespace } : {}),
});

export type SheetProps = {
  cluster: ClusterInfo;
  draft: ActionDraft;
  onClose: () => void;
  /** "Ask Claude first": quoted context, the object, and the question; the sheet stays open under the dock. */
  onAsk: (contexts: AskContext[], question: string) => void;
  /** An apply ended (whatever its outcome): Recent actions reads the log again. */
  onApplied: () => void;
  /** A drain's end offers Uncordon (D152): the cordon sheet, the other way. */
  onUncordon?: () => void;
  /** A drain row's owner, opened in its list (the sheet closes first). */
  onOpen?: (t: NavTarget) => void;
};

/** The sheet for your action (D145); a drain has its own body, the plan and the run (D154). */
export function ActionSheet(props: SheetProps) {
  return props.draft.kind === "drain" ? <DrainSheet {...props} /> : <ChangeSheet {...props} />;
}

function ChangeSheet(props: SheetProps) {
  const d = props.draft;
  const o = d.objects[0]!;
  const listed = typeof o.spec?.replicas === "number" ? o.spec.replicas : 1;
  // The row can be a watch event behind (just after a scale): Scale reads the object again for "Now N".
  const [current, setCurrent] = useState(listed);
  const [replicas, setReplicas] = useState(listed);
  const touched = useRef(false);
  useEffect(() => {
    if (d.kind !== "scale") return;
    let live = true;
    void api.invoke("resource:get", { handle: props.cluster.handle, ref: refOf(d, o) }).then(({ object }) => {
      const n = object.spec?.replicas;
      if (!live || typeof n !== "number") return;
      setCurrent(n);
      if (!touched.current) setReplicas(n);
    }, () => {});
    return () => void (live = false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [stage, setStage] = useState<Stage>(d.kind === "scale" ? { s: "form" } : { s: "checking" });
  const applyBtn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const reviewId = useRef<string>(undefined);
  reviewId.current = stage.s === "review" ? stage.review.id : undefined;
  const verb = verbOf(d);

  // A review left open when the sheet goes is dropped in main too.
  useEffect(() => () => {
    if (reviewId.current) void api.invoke("action:discard", { id: reviewId.current }).catch(() => {});
  }, []);

  const review = async () => {
    setStage({ s: "checking" });
    const action = d.kind === "scale" ? { kind: "scale" as const, target: refOf(d, o), replicas }
      : d.kind === "trigger" ? { kind: "trigger" as const, target: refOf(d, o) }
      : d.kind === "suspend" ? { kind: "suspend" as const, target: refOf(d, o), suspend: !!d.suspend }
      : d.kind === "cordon" ? { kind: "cordon" as const, node: o.metadata.name, on: d.on !== false }
      : { kind: d.kind as "restart" | "delete", targets: d.objects.map((x) => refOf(d, x)) };
    try {
      const r = await api.invoke("action:review", { handle: props.cluster.handle, action });
      // A preview-only cordon (D153) is shown like a review, with Apply off.
      if ((r.id || r.previewOnly) && r.operations) {
        setStage({ s: "review", review: r });
        setTimeout(() => (box.current?.contains(document.activeElement) || document.activeElement === document.body) && applyBtn.current?.focus(), 0);
      } else setStage({ s: "problems", messages: (r.problems ?? []).map((p) => p.message), ...(r.conflict ? { conflict: true } : {}) });
    } catch (e) {
      setStage({ s: "problems", messages: [(e as ApiError).message] });
    }
  };
  // Actions without a choice open straight on the review. Focus moves into the sheet at once, so Esc and Tab are its
  // own even when it was opened from a row's key.
  useEffect(() => {
    box.current?.focus();
    if (d.kind !== "scale") void review();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The count's field has focus whenever the form shows (first, and after Back).
  useEffect(() => {
    if (stage.s === "form") field.current?.focus();
  }, [stage.s]);

  const apply = async () => {
    if (stage.s !== "review" || !stage.review.id || !stage.review.digest) return;
    const r = stage.review;
    setStage({ s: "applying", review: r });
    try {
      const out = await api.invoke("action:apply", { handle: props.cluster.handle, id: r.id!, digest: r.digest! });
      setStage({ s: "done", results: "results" in out ? out.results : [] });
      props.onApplied();
    } catch (e) {
      const err = e as ApiError;
      // Cancel in main's dialog keeps the review once: back to the card. A second Cancel drops it (L3).
      if (err.status === 409 && err.message === "Cancelled.") return (setStage({ s: "review", review: r }), props.onApplied());
      if (err.status === 410) return (setStage({ s: "problems", messages: [err.message], conflict: true, head: "Cancelled. Nothing was sent." }), props.onApplied());
      // Not a change in the cluster: main's dialog is already up, or the log couldn't take the row (L13, M3).
      if (err.status === 429 || err.status === 500) return setStage({ s: "problems", messages: [err.message], head: "Nothing was sent." });
      setStage({ s: "problems", messages: [err.message], ...(err.status === 409 ? { conflict: true } : {}) });
    }
  };

  const back = () => {
    if (stage.s === "review" && stage.review.id) void api.invoke("action:discard", { id: stage.review.id }).catch(() => {});
    if (d.kind === "scale") setStage({ s: "form" });
    else props.onClose();
  };
  const busy = stage.s === "applying" || stage.s === "checking";
  const close = () => !busy && props.onClose();
  const step = (n: number) => (touched.current = true, setReplicas((r: number) => Math.max(0, Math.min(1000, r + n))));
  const ask = stage.s === "review" ? askFirst(verb, d.type, stage.review, d.objects) : undefined;

  return (
    <div className="palette-back action-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} className="dialog action-sheet" role="dialog" aria-modal="true" aria-labelledby="action-title" tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), stage.s === "review" ? back() : close());
          if (e.key === "Tab") {
            // Focus stays in the sheet.
            const els = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, [tabindex='0']") ?? [])];
            if (!els.length) return;
            const i = els.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && i <= 0) (e.preventDefault(), els.at(-1)!.focus());
            else if (!e.shiftKey && i === els.length - 1) (e.preventDefault(), els[0]!.focus());
          }
        }}>
        <header className="dialog-head">
          <Ic icon={Zap} size={15} className="dim" />
          <h2 id="action-title" className="grow">{sheetHeading(d, stage.s === "review" || stage.s === "applying" ? stage.review : undefined)}</h2>
          <button className="icon-btn sm" aria-label="Close" disabled={busy} onClick={close}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body action-body">
          {d.asker === "view" && stage.s !== "review" && stage.s !== "applying" ? <p className="action-asker small" role="note">{eyebrowOf(d)}. Nothing is sent until you review it and apply.</p> : null}
          {stage.s === "form" ? (
            <form className="action-form" onSubmit={(e) => (e.preventDefault(), void review())}>
              <p className="small dim">Now <b className="mono">{current}</b> replica{current === 1 ? "" : "s"}. Landlens checks the change with the cluster before anything is sent.</p>
              <div className="stepper" role="group" aria-label="Replicas">
                <button type="button" className="icon-btn" aria-label="One fewer" disabled={replicas <= 0} onClick={() => step(-1)}><Ic icon={Minus} size={14} /></button>
                <input ref={field} className="mono" type="number" inputMode="numeric" min={0} max={1000} aria-label="Replicas" value={replicas}
                  onChange={(e) => (touched.current = true, setReplicas(Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0)))))}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") (e.preventDefault(), step((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1)));
                  }} />
                <button type="button" className="icon-btn" aria-label="One more" disabled={replicas >= 1000} onClick={() => step(1)}><Ic icon={Plus} size={14} /></button>
              </div>
            </form>
          ) : stage.s === "checking" ? (
            <div className="action-checking" role="status" aria-live="polite">
              <div className="skel" /><div className="skel short" /><div className="skel" />
              <span className="small dim"><span className="spinner" />Checking with the cluster…</span>
            </div>
          ) : stage.s === "review" || stage.s === "applying" ? (
            <ReviewCard
              eyebrow={eyebrowOf(d)}
              title={sheetHeading(d, stage.review)}
              review={stage.review}
              {...(stage.review.facts?.length ? { facts: stage.review.facts } : {})}
              {...(stage.review.native ? { nativeLabel: `${d.kind === "delete" ? "Delete" : d.kind === "restart" ? "Restart" : "Apply"}${(stage.review.operations?.length ?? 0) > 1 ? ` ${stage.review.operations!.length}` : ""}…` } : {})}
              applying={stage.s === "applying"}
              {...(stage.review.previewOnly ? { previewOnly: PREVIEW_ONLY } : {})}
              {...(d.objects.length > 1 && stage.review.problems?.length ? { leftOut: {
                kept: stage.review.operations?.length ?? 0, of: d.objects.length, verb: d.kind === "delete" ? "deleted" : "restarted",
                messages: stage.review.problems.map((p) => p.message),
              } } : {})}
              applyRef={applyBtn}
              onApply={() => void apply()}
              onBack={back}
              backLabel={d.kind === "scale" ? "Back" : "Cancel"}
              {...(ask ? {
                askLabel: "Ask Claude first",
                onAsk: () => props.onAsk([ask.context, ...(d.objects.length === 1 ? [{ ref: refOf(d, o), label: `${d.type.kind} ${o.metadata.namespace ? `${o.metadata.namespace}/` : ""}${o.metadata.name}` }] : [])], ask.question),
              } : {})}
            />
          ) : stage.s === "problems" ? (
            <div className="action-problems" role="alert">
              <div className="change-fact bad"><Ic icon={CircleX} size={13} />{stage.head ?? (stage.conflict ? "It changed since Landlens read it. Nothing was sent." : "The cluster refused this. Nothing was changed.")}</div>
              <ul>{stage.messages.slice(0, 20).map((m, i) => <li key={i} className="small">{m}</li>)}</ul>
            </div>
          ) : (
            <ul className="action-results" aria-label="What happened">
              {stage.results.map((r, i) => (
                <li key={i} className={`result-${r.outcome}`}>
                  <Ic icon={r.outcome === "applied" || r.outcome === "gone" ? CircleCheck : r.outcome === "conflict" ? TriangleAlert : CircleX} size={14} />
                  <span><span className="mono">{r.target}</span> {r.outcome === "applied" ? (d.kind === "delete" ? "deleted" : d.kind === "trigger" ? "created" : d.kind === "cordon" ? (d.on === false ? "uncordoned" : "cordoned") : "applied") : r.outcome === "gone" ? "was already gone" : r.outcome === "conflict" ? (d.kind === "trigger" ? `not created: ${r.message ?? "one of that name already exists"}` : "changed after your review: not sent") : `failed: ${r.message ?? "the cluster refused it"}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {stage.s === "form" || stage.s === "problems" || stage.s === "done" ? (
          <footer className="dialog-foot">
            <span className="grow" />
            {stage.s === "form" ? (
              <>
                <button className="secondary" onClick={close}>Cancel</button>
                <button className="primary" disabled={replicas === current} onClick={() => void review()}>Review</button>
              </>
            ) : stage.s === "problems" ? (
              <>
                {stage.conflict ? <button className="secondary" onClick={() => void review()}>Review again</button> : null}
                <button className={stage.conflict ? "primary" : "secondary"} onClick={d.kind === "scale" ? () => setStage({ s: "form" }) : close}>{d.kind === "scale" ? "Back" : "Close"}</button>
              </>
            ) : (
              <>
                {stage.results.some((r) => r.outcome === "conflict") ? <button className="secondary" onClick={() => void review()}>Review again</button> : null}
                <button className="primary" autoFocus onClick={close}>Done</button>
              </>
            )}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
