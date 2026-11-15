// The drain sheet (wave 8 part 2, D154): the plan main built from reads and the API server's dry runs, then the run.
// Head: the node and three counts, each with its icon. Two ticks above the list re-review on change (300 ms). The list
// is one column of cards-as-rows: Blocked first (a bad edge), Will be evicted, Stay (folded); each row the pod in mono,
// its namespace, its owner as a link, and chips. Apply reads "Drain…" and asks in main's own dialog; it is off while
// anything waits on a tick, the plan is partial, or the build may not write to this cluster's nodes (D153). During the
// run the same list shows each pod's state, Stop and the elapsed time; at the end, the summary and Uncordon. "Ask
// Claude" sends the plan as names, classes and counts only, quoted as data, with a fixed question.
import type { ActionReview, DrainPlan, DrainPod, DrainProgress } from "@landlens/contracts";
import { ChevronRight, CircleCheck, CircleSlash, CircleX, Clock, Info, LoaderCircle, LogOut, Pause, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACTION_ASKS, PREVIEW_ONLY } from "./actionAsks";
import type { SheetProps } from "./ActionSheet";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";
import type { AskContext } from "./quotes";

type Stage =
  | { s: "checking"; last?: ActionReview }
  | { s: "plan"; review: ActionReview }
  | { s: "asking"; review: ActionReview }
  | { s: "problems"; messages: string[] }
  | { s: "running"; review: ActionReview; run: string; progress?: DrainProgress };

const NAME = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const safe = (s: string) => (s.length <= 253 && NAME.test(s) ? s : "(a name Landlens doesn't quote)");

/** What unblocks a row, in Landlens's words (D154). */
export function unblock(p: DrainPod): string | undefined {
  switch (p.blocked) {
    case "needs-bare": return "Nothing recreates it. Tick “Delete pods that nothing will recreate”.";
    case "needs-emptydir": return "Its emptyDir data goes with it. Tick “Lose emptyDir data”.";
    case "many-budgets": return "More than one disruption budget selects it: the eviction API refuses such a pod.";
    case "budget": {
      const b = p.budget && "name" in p.budget ? p.budget.name : "its disruption budget";
      // A ReplicaSet's pods: its Deployment is what to scale, and Landlens doesn't name what it didn't read.
      const more = p.owner?.kind === "ReplicaSet" ? ", or scale its Deployment up" : p.owner ? `, or scale ${p.owner.kind} ${p.owner.name} up` : "";
      return `Wait for ${b} to allow a disruption${more}. The drain tries again every 5 seconds.`;
    }
  }
  return undefined;
}

/** "Ask Claude" (D154): the plan as names, classes and counts only, never a dry run's text, quoted as data. */
export function planText(plan: DrainPlan): string {
  const line = (p: DrainPod) => {
    const why = p.blocked === "budget" ? `blocked: budget ${p.budget && "name" in p.budget ? safe(p.budget.name) : "?"}, ${p.budget && "name" in p.budget ? p.budget.allowed : 0} allowed`
      : p.blocked === "many-budgets" ? "blocked: several budgets"
      : p.blocked === "needs-bare" ? "blocked: bare, nothing recreates it"
      : p.blocked === "needs-emptydir" ? `blocked: emptyDir ${p.emptyDir.map(safe).join(", ")}`
      : p.class;
    return `- ${safe(p.namespace)}/${safe(p.name)}${p.owner ? ` (${/^[A-Z][A-Za-z0-9]{0,62}$/.test(p.owner.kind) ? p.owner.kind : "owner"} ${safe(p.owner.name)})` : " (no owner)"}: ${why}`;
  };
  const c = plan.counts;
  return [`Drain node ${safe(plan.node)}: ${c.evict} to evict, ${c.blocked} blocked, ${c.skipped} stay.${plan.cordoned ? " It is already cordoned." : ""}`, ...plan.pods.slice(0, 200).map(line)].join("\n");
}

const STATE: Record<string, { icon: typeof CircleCheck; words: string; tone: string; spin?: boolean }> = {
  waiting: { icon: Clock, words: "Waiting", tone: "dim" },
  evicting: { icon: LoaderCircle, words: "Evicting", tone: "dim", spin: true },
  evicted: { icon: LoaderCircle, words: "Evicted, terminating", tone: "dim", spin: true },
  gone: { icon: CircleCheck, words: "Gone", tone: "ok" },
  blocked: { icon: CircleSlash, words: "Blocked", tone: "bad" },
  failed: { icon: CircleX, words: "Failed", tone: "bad" },
};

function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Row({ p, run, onOwner }: { p: DrainPod; run?: { state: string; note?: string }; onOwner?: (p: DrainPod) => void }) {
  const st = run ? STATE[run.state] : undefined;
  const why = !run ? unblock(p) : run.note;
  return (
    <li className={`drain-row${p.blocked && !run ? " blocked" : ""}`} data-pod={`${p.namespace}/${p.name}`}>
      <div className="drain-row-head">
        <span className="mono drain-pod">{p.name}</span>
        <span className="small dim">{p.namespace}</span>
        {st ? <span className={`drain-state tone-${st.tone}`}><Ic icon={st.icon} size={13} className={st.spin ? "spin" : ""} />{st.words}</span> : null}
      </div>
      <div className="drain-chips">
        {p.owner ? (
          onOwner ? <button className="link-btn small" onClick={() => onOwner(p)}>{p.owner.kind} {p.owner.name}</button> : <span className="small dim">{p.owner.kind} {p.owner.name}</span>
        ) : <span className="chip">bare</span>}
        {p.class === "daemonset" ? <span className="chip">DaemonSet</span> : null}
        {p.class === "mirror" ? <span className="chip">static pod</span> : null}
        {p.class === "finished" ? <span className="chip">finished</span> : null}
        {p.class === "terminating" ? <span className="chip">terminating</span> : null}
        {p.emptyDir.map((v) => <span key={v} className="chip">emptyDir {v}</span>)}
        {p.budget ? ("name" in p.budget ? <span className="chip">budget {p.budget.name} · {p.budget.allowed} allowed</span> : <span className="chip">budgets {p.budget.many.join(", ")}</span>) : null}
        {p.dry?.reason === "forbidden" ? <span className="chip">your role can't evict here</span> : null}
      </div>
      {why ? <p className="small drain-why">{why}</p> : null}
    </li>
  );
}

export function DrainPlanView({ plan, progress, onOwner }: { plan: DrainPlan; progress?: DrainProgress; onOwner?: (p: DrainPod) => void }) {
  const [stayOpen, setStayOpen] = useState(false);
  const runOf = (p: DrainPod) => progress?.pods.find((x) => x.namespace === p.namespace && x.name === p.name);
  const blocked = plan.pods.filter((p) => p.blocked);
  const evict = plan.pods.filter((p) => !p.blocked && (p.class === "evict" || p.class === "finished"));
  const stay = plan.pods.filter((p) => p.class !== "evict" && p.class !== "finished");
  const group = (title: string, pods: DrainPod[], cls: string) => pods.length ? (
    <section className={`drain-group ${cls}`} aria-label={title}>
      <h4 className="drain-group-head">{title} <span className="dim">{pods.length}</span></h4>
      <ul>{pods.map((p) => <Row key={p.uid} p={p} {...(progress ? { run: runOf(p) ?? { state: "waiting" } } : {})} {...(onOwner ? { onOwner } : {})} />)}</ul>
    </section>
  ) : null;
  return (
    <div className="drain-plan">
      {group("Blocked", blocked, "is-blocked")}
      {group("Will be evicted", evict, "is-evict")}
      {stay.length ? (
        <section className="drain-group is-stay" aria-label="Stay">
          <button className="drain-group-head fold" aria-expanded={stayOpen} onClick={() => setStayOpen((v) => !v)}>
            <Ic icon={ChevronRight} size={13} className={stayOpen ? "open" : ""} />Stay <span className="dim">{stay.length}</span>
          </button>
          {stayOpen ? <ul>{stay.map((p) => <Row key={p.uid} p={p} {...(onOwner ? { onOwner } : {})} />)}</ul> : null}
        </section>
      ) : null}
      {!plan.pods.length ? <p className="small dim">No pods run on this node.</p> : null}
    </div>
  );
}

/** Owner kinds a row can open in their list. */
const OWNER_KINDS = new Set(["ReplicaSet", "StatefulSet", "DaemonSet", "Job", "Deployment", "CronJob"]);

export function DrainSheet(props: SheetProps) {
  const node = props.draft.objects[0]!.metadata.name;
  const [ticks, setTicks] = useState({ bare: false, emptyDir: false });
  const [stage, setStage] = useState<Stage>({ s: "checking" });
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const shownAt = useRef(Date.now());
  const reviewId = useRef<string>(undefined);
  reviewId.current = stage.s === "plan" ? stage.review.id : undefined;
  const runId = useRef<string>(undefined);
  runId.current = stage.s === "running" ? stage.run : undefined;

  // A review left open when the sheet goes is dropped in main too. (A run goes on: main owns it; Stop ends it.)
  useEffect(() => () => {
    if (reviewId.current) void api.invoke("action:discard", { id: reviewId.current }).catch(() => {});
  }, []);

  const review = async (t: typeof ticks) => {
    if (reviewId.current) void api.invoke("action:discard", { id: reviewId.current }).catch(() => {});
    setStage((s) => ({ s: "checking", ...(s.s === "plan" ? { last: s.review } : {}) }));
    try {
      const r = await api.invoke("action:review", { handle: props.cluster.handle, action: { kind: "drain", node, bare: t.bare, emptyDir: t.emptyDir } });
      if (r.plan) {
        shownAt.current = Date.now();
        setStage({ s: "plan", review: r });
      } else setStage({ s: "problems", messages: (r.problems ?? []).map((p) => p.message) });
    } catch (e) {
      setStage({ s: "problems", messages: [(e as ApiError).message] });
    }
  };
  // Opens on the review; a tick re-reviews after 300 ms of quiet.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      box.current?.focus();
      void review(ticks);
      return;
    }
    const t = setTimeout(() => void review(ticks), 300);
    return () => clearTimeout(t);
  }, [ticks.bare, ticks.emptyDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // The run's progress, pushed by main to this window only.
  useEffect(() => {
    if (stage.s !== "running") return;
    const off = api.on("action:progress", (p: DrainProgress) => {
      if (p.run !== runId.current) return;
      setStage((s) => (s.s === "running" ? { ...s, progress: p } : s));
      if (p.state !== "cordoning" && p.state !== "evicting") props.onApplied();
    });
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => (off(), clearInterval(clock));
  }, [stage.s]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = stage.s === "plan" || stage.s === "asking" || stage.s === "running" ? stage.review.plan : stage.s === "checking" ? stage.last?.plan : undefined;
  const rv = stage.s === "plan" || stage.s === "asking" || stage.s === "running" ? stage.review : undefined;
  const progress = stage.s === "running" ? stage.progress : undefined;
  const ended = !!progress && progress.state !== "cordoning" && progress.state !== "evicting";
  const needsTick = !!plan?.pods.some((p) => p.blocked === "needs-bare" || p.blocked === "needs-emptydir");
  const canApply = stage.s === "plan" && !!rv?.id && !!rv.digest && !rv.previewOnly && !plan?.partial && !needsTick;
  const running = stage.s === "running" && !ended;
  const busy = stage.s === "asking" || running;
  const close = () => !busy && props.onClose();

  const apply = async (e: React.MouseEvent) => {
    // A press of the button itself; a key press in its first half second is a key meant for something else.
    if (e.detail === 0 && Date.now() - shownAt.current < 500) return;
    if (stage.s !== "plan" || !canApply) return;
    const r = stage.review;
    setStage({ s: "asking", review: r });
    try {
      const out = await api.invoke("action:apply", { handle: props.cluster.handle, id: r.id!, digest: r.digest! });
      if ("run" in out) setStage({ s: "running", review: r, run: out.run });
      else setStage({ s: "problems", messages: ["Landlens didn't start the drain."] });
    } catch (e) {
      const err = e as ApiError;
      // Cancel in main's dialog keeps the review: back to the plan.
      if (err.status === 409 && err.message === "Cancelled.") return (setStage({ s: "plan", review: r }), props.onApplied());
      setStage({ s: "problems", messages: [err.message] });
    }
  };
  const stop = () => {
    if (stage.s === "running") void api.invoke("action:stop", { run: stage.run }).catch(() => {});
  };
  const ask = () => {
    if (!plan) return;
    const context: AskContext = { label: `My action · drain ${node}`, text: planText(plan), source: `Drain node ${node}`, kind: "action" };
    props.onAsk([context], ACTION_ASKS.drain.question);
  };
  const onOwner = props.onOpen ? (p: DrainPod) => {
    if (busy || !p.owner || !OWNER_KINDS.has(p.owner.kind)) return;
    props.onClose();
    props.onOpen!({ kind: p.owner.kind, name: p.owner.name, namespace: p.namespace });
  } : undefined;

  const c = plan?.counts;
  const tally = progress ? {
    gone: progress.pods.filter((p) => p.state === "gone").length,
    blocked: progress.pods.filter((p) => p.state === "blocked").length,
    failed: progress.pods.filter((p) => p.state === "failed").length,
    left: progress.pods.filter((p) => p.state === "waiting" || p.state === "evicting" || p.state === "evicted").length,
  } : undefined;

  return (
    <div className="palette-back action-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} className="dialog action-sheet drain-sheet" role="dialog" aria-modal="true" aria-labelledby="action-title" tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), close());
          if (e.key === "Tab") {
            const els = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [])];
            if (!els.length) return;
            const i = els.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && i <= 0) (e.preventDefault(), els.at(-1)!.focus());
            else if (!e.shiftKey && i === els.length - 1) (e.preventDefault(), els[0]!.focus());
          }
        }}>
        <header className="dialog-head">
          <Ic icon={LogOut} size={15} className="dim" />
          <h2 id="action-title" className="grow">Drain {node}</h2>
          {running && progress ? <span className="small dim mono" aria-label="Elapsed">{elapsed(now - progress.startedAt)}</span> : null}
          <button className="icon-btn sm" aria-label="Close" disabled={busy} onClick={close}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body action-body">
          {c ? (
            <div className="drain-counts" aria-label="Counts">
              <span className="badge muted"><Ic icon={LogOut} size={13} />{c.evict} to evict</span>
              <span className={`badge ${c.blocked ? "bad" : "muted"}`}><Ic icon={CircleSlash} size={13} />{c.blocked} blocked</span>
              <span className="badge muted"><Ic icon={Pause} size={13} />{c.skipped} stay</span>
              {plan?.cordoned ? <span className="small dim">Already cordoned</span> : null}
            </div>
          ) : null}
          {stage.s !== "running" ? (
            <fieldset className="drain-ticks" disabled={stage.s === "asking"}>
              <label><input type="checkbox" checked={ticks.bare} onChange={(e) => setTicks((t) => ({ ...t, bare: e.target.checked }))} />Delete pods that nothing will recreate</label>
              <label><input type="checkbox" checked={ticks.emptyDir} onChange={(e) => setTicks((t) => ({ ...t, emptyDir: e.target.checked }))} />Lose emptyDir data</label>
            </fieldset>
          ) : null}
          {rv?.previewOnly || (stage.s === "checking" && stage.last?.previewOnly) ? <div className="change-fact preview-only" role="note"><Ic icon={Info} size={12} />{PREVIEW_ONLY}</div> : null}
          {plan?.partial ? <div className="change-fact bad" role="note"><Ic icon={TriangleAlert} size={12} />{plan.partial} Apply stays off.</div> : null}
          {rv?.disagree ? <div className="change-fact warn" role="note"><Ic icon={TriangleAlert} size={12} />The cluster disagrees with Landlens's reading on {rv.disagree} pod{rv.disagree === 1 ? "" : "s"}; the rows show the cluster's answer.</div> : null}
          {rv?.problems?.length ? <div className="change-fact bad" role="alert"><Ic icon={CircleX} size={12} />{rv.problems.map((p) => p.message).join(" ")}</div> : null}
          {progress?.note ? <div className="change-fact bad" role="alert"><Ic icon={CircleX} size={12} />{progress.note}</div> : null}
          {stage.s === "checking" && !plan ? (
            <div className="action-checking" role="status" aria-live="polite">
              <div className="skel" /><div className="skel short" /><div className="skel" />
              <span className="small dim"><span className="spinner" />Reading the node, its pods and their budgets…</span>
            </div>
          ) : stage.s === "problems" ? (
            <div className="action-problems" role="alert">
              <div className="change-fact bad"><Ic icon={CircleX} size={13} />Landlens couldn't plan this drain. Nothing was changed.</div>
              <ul>{stage.messages.slice(0, 20).map((m, i) => <li key={i} className="small">{m}</li>)}</ul>
            </div>
          ) : plan ? (
            <div className={stage.s === "checking" ? "drain-stale" : ""} aria-busy={stage.s === "checking"}>
              <DrainPlanView plan={plan} {...(progress ? { progress } : {})} {...(onOwner ? { onOwner } : {})} />
            </div>
          ) : null}
        </div>
        <footer className="dialog-foot">
          {ended && tally ? (
            <>
              <span className="grow small" role="status">
                {progress!.state === "stopped" ? "Stopped. " : progress!.state === "timed-out" ? "Time's up. " : progress!.state === "failed" ? "" : "Done. "}
                {tally.gone} gone, {tally.blocked} blocked{tally.failed ? `, ${tally.failed} failed` : ""}{tally.left ? `, ${tally.left} still going` : ""}. The node stays cordoned.
              </span>
              {props.onUncordon ? <button className="secondary" onClick={() => (props.onClose(), props.onUncordon!())}>Uncordon…</button> : null}
              <button className="primary" autoFocus onClick={props.onClose}>Done</button>
            </>
          ) : running ? (
            <>
              <span className="grow small dim" role="status"><span className="spinner" />{progress?.state === "cordoning" ? "Cordoning…" : `Evicting… ${tally ? `${tally.gone} gone, ${tally.left} to go` : ""}`}</span>
              <button className="secondary" onClick={stop}><Ic icon={CircleSlash} size={13} />Stop</button>
            </>
          ) : (
            <>
              {plan ? <button className="link-btn small" onClick={ask} disabled={stage.s === "asking"}><Ic icon={Sparkles} size={12} />Ask Claude</button> : null}
              <span className="grow" />
              <button className="secondary" disabled={stage.s === "asking"} onClick={close}>Cancel<kbd aria-hidden="true">esc</kbd></button>
              <button className="danger" disabled={!canApply} onClick={(e) => void apply(e)}
                title={rv?.previewOnly ? PREVIEW_ONLY : needsTick ? "Tick what the blocked rows ask for first" : plan?.partial ? "The plan is incomplete" : undefined}>
                {stage.s === "asking" ? <><span className="spinner" />Asking…</> : <><Ic icon={TriangleAlert} size={13} />Drain…</>}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
