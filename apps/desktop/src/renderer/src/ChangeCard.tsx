// A change the agent proposed, in the dock: dry-run, waiting for you, then folded to what happened. The designer's
// spec (wave 3, D4–D47) is the source of every choice here; the comments cite it.
//
// Landlens's voice is the head, the tags, the operation heads, the diff, the foot and the buttons. The agent's only
// words are its reason, shown as quoted plain text (D13, D20).
import type { AgentChange, ChangeOperation, ChangeRisk, DiffLine } from "@landlens/contracts";
import {
  ArrowUpRight, Ban, Check, ChevronRight, CircleDashed, Clock, Eye, FolderTree, Globe, HardDrive, KeyRound, LogOut, Maximize2,
  Package, Play, Power, RotateCw, ShieldAlert, ShieldCheck, Sparkles, Trash2, TriangleAlert, UserCog, X, type LucideIcon,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ObjectTarget } from "./app-host";
import { Ic, iconOfKind } from "./icons";
import { yamlTokens } from "./Yaml";

export const RISK: Record<ChangeRisk, { icon: LucideIcon; words: string; level: "danger" | "caution"; title: string }> = {
  deletes: { icon: Trash2, words: "Deletes", level: "danger", title: "Applying this removes the object. Landlens can't bring it back." },
  "evicts-pods": { icon: LogOut, words: "Evicts pods", level: "danger", title: "Applying this evicts pods from a node; their controllers start them elsewhere." },
  "loses-data": { icon: HardDrive, words: "Loses data", level: "danger", title: "Data on a pod's emptyDir or a volume goes with it." },
  rbac: { icon: ShieldAlert, words: "Changes access", level: "danger", title: "This changes who can do what in the cluster (RBAC)." },
  "cluster-scoped": { icon: Globe, words: "Cluster-wide", level: "danger", title: "This object isn't in a namespace: the change reaches the whole cluster." },
  "reads-secret": { icon: KeyRound, words: "Uses a Secret", level: "danger", title: "Its pods get a Secret's values (env or volume). What they print or send can carry them, and the agent can read pod logs." },
  privileged: { icon: ShieldAlert, words: "Privileged", level: "danger", title: "A container runs privileged, may escalate, or gets added Linux capabilities." },
  "host-access": { icon: HardDrive, words: "Host access", level: "danger", title: "Its pods reach the node: a host path, the host's network, PIDs or IPC, or a host port." },
  "service-account": { icon: UserCog, words: "Service account", level: "caution", title: "Its pods run as a different service account, with that account's permissions." },
  "new-workload": { icon: Play, words: "Runs new pods", level: "caution", title: "This creates something that runs pods." },
  namespace: { icon: FolderTree, words: "Whole namespace", level: "caution", title: "This changes a namespace, and with it everything in it." },
  "scales-to-zero": { icon: Power, words: "Scales to zero", level: "caution", title: "Applying this stops every pod of the workload." },
  "restarts-pods": { icon: RotateCw, words: "Restarts pods", level: "caution", title: "Applying this replaces the workload's pods." },
  "changes-image": { icon: Package, words: "Changes image", level: "caution", title: "Applying this runs a different container image." },
};
export const ORDER: ChangeRisk[] = [
  "deletes", "evicts-pods", "loses-data", "rbac", "cluster-scoped", "reads-secret", "privileged", "host-access", "namespace", "service-account",
  "new-workload", "scales-to-zero", "restarts-pods", "changes-image",
];
/** A diff this short is never capped (D25). */
const SHORT_DIFF = 17;
/** Keys are ignored this long after a card appears or reveals more (D37). */
export const ARM_MS = 600;

export const risksOf = (c: AgentChange): ChangeRisk[] => ORDER.filter((r) => c.operations.some((o) => o.risk.includes(r)));
export const isDanger = (c: AgentChange) => risksOf(c).some((r) => RISK[r].level === "danger");
export const isWaiting = (c: AgentChange) => c.state === "waiting" || c.state === "applying";
export const riskWords = (c: AgentChange) => risksOf(c).map((r) => RISK[r].words);

const objLabel = (o: Pick<ChangeOperation, "namespace" | "name">) => (o.namespace ? `${o.namespace}/${o.name}` : o.name);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** What the dock's keys can do to a waiting card (D34–D37). */
export type CardKeys = {
  /** Reveal the next hidden part; false when everything is shown. */
  reveal(): boolean;
  /** Everything is shown and the change isn't dangerous: Enter may approve. */
  enterApproves(): boolean;
  /** The card has been still for ARM_MS. */
  armed(): boolean;
};

type Props = {
  change: AgentChange;
  agent: string;
  onDecide: (decision: "approve" | "reject", note?: string) => void;
  onOpenObject: (t: ObjectTarget) => void;
  /** "Reject with a note": the dock focuses its composer (D38). */
  onNote: () => void;
  /** Keys reach this card (exactly one waiting, composer empty): show the ↵ and esc hints. */
  keysLive: boolean;
};

export const ChangeCard = forwardRef<CardKeys, Props>(function ChangeCard({ change, agent, onDecide, onOpenObject, onNote, keysLive }, ref) {
  const danger = isDanger(change);
  const ops = change.operations;
  const [open, setOpen] = useState<Set<number>>(() => new Set(ops[0]?.verb === "delete" ? [] : [0]));
  const [uncapped, setUncapped] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [wide, setWide] = useState(false);
  const shownAt = useRef(Date.now());
  const safe = useRef<HTMLButtonElement>(null);
  const dangerBtn = useRef<HTMLButtonElement>(null);
  const titleId = `change-title-${change.id}`;

  /** The parts still hidden, in the order Enter reveals them: a closed operation, then a capped diff. */
  const hidden = (): { op: number; what: "open" | "uncap" } | undefined => {
    for (let i = 0; i < ops.length; i++) {
      if (ops[i]!.verb === "delete") continue; // a delete is danger: never Enter-approved
      if (!open.has(i)) return { op: i, what: "open" };
      if (ops[i]!.diff.lines.length > SHORT_DIFF && !uncapped.has(i)) return { op: i, what: "uncap" };
    }
    return undefined;
  };
  const next = hidden();
  /** Open every operation and lift every cap: what a click on Approve does first while anything is hidden. */
  const revealAll = () => {
    setOpen(new Set(ops.map((o, i) => (o.verb === "delete" ? -1 : i)).filter((i) => i >= 0)));
    setUncapped(new Set(ops.map((_, i) => i)));
    shownAt.current = Date.now();
  };
  const nothing = ops.every((o) => o.verb !== "delete" && o.diff.added === 0 && o.diff.removed === 0);

  useImperativeHandle(ref, () => ({
    reveal() {
      const h = hidden();
      if (!h) return false;
      if (h.what === "open") setOpen((s) => new Set(s).add(h.op));
      else setUncapped((s) => new Set(s).add(h.op));
      shownAt.current = Date.now();
      return true;
    },
    enterApproves: () => !danger && !hidden(),
    armed: () => Date.now() - shownAt.current >= ARM_MS,
  }));

  useEffect(() => {
    if (confirm) safe.current?.focus();
  }, [confirm]);

  const applying = change.state === "applying";
  const eyebrow = danger
    ? ops.some((o) => o.verb === "delete") ? `${agent} proposes a delete` : `${agent} proposes a risky change`
    : `${agent} proposes a change`;
  const risks = risksOf(change);
  const enterHint = keysLive && !danger && !confirm;

  return (
    <section className={`change ${applying ? "applying" : "waiting"}${danger ? " danger" : ""}`} aria-labelledby={titleId}>
      <div className="change-head">
        <div className="change-eyebrow">
          <Ic icon={danger ? TriangleAlert : Sparkles} size={13} />
          <span>{eyebrow}</span>
          {!applying ? <Expiry at={change.expiresAt} /> : null}
        </div>
        <h3 className="change-title" id={titleId}>{change.title}</h3>
      </div>
      {risks.length ? (
        <div className="change-risks" aria-label="Risks">
          {risks.map((r) => (
            <span key={r} className={`badge ${RISK[r].level === "danger" ? "bad" : "warn"}`} title={RISK[r].title}>
              <Ic icon={RISK[r].icon} size={13} />{RISK[r].words}
            </span>
          ))}
        </div>
      ) : null}
      <Reason agent={agent} text={change.reason} />
      <Operations
        change={change}
        open={open}
        uncapped={uncapped}
        onToggle={(i) => setOpen((s) => {
          const n = new Set(s);
          if (n.has(i)) n.delete(i);
          else n.add(i);
          return n;
        })}
        onUncap={(i) => {
          setUncapped((s) => new Set(s).add(i));
          shownAt.current = Date.now();
        }}
        onOpenObject={onOpenObject}
        onWide={() => setWide(true)}
        enterOn={enterHint && next ? next : undefined}
        linkObjects={false}
      />
      <Warnings ops={ops} />
      <div className="change-foot">
        <div className="change-fact"><Ic icon={ShieldCheck} size={12} />{nothing
          ? "Dry run passed: this would change nothing. Rejecting it is safe."
          : "Dry run passed. Nothing has changed yet."}</div>
        {applying ? (
          <div className="change-applying" role="status"><span className="spinner" />Applying…</div>
        ) : confirm ? (
          <Confirm change={change} safeRef={safe} onBack={() => {
            setConfirm(false);
            requestAnimationFrame(() => dangerBtn.current?.focus());
          }} onGo={() => onDecide("approve")} />
        ) : (
          <div className="change-actions">
            {next ? (
              // Nothing is approved unseen: while an operation is closed or a diff capped, the first click shows it all.
              <button className="primary" onClick={revealAll}>
                <Ic icon={Eye} size={13} />Show all of it to approve
              </button>
            ) : danger ? null : (
              <button className="primary" onClick={() => onDecide("approve")}>
                <Ic icon={Check} size={13} />Approve{enterHint ? <kbd aria-hidden="true">↵</kbd> : null}
              </button>
            )}
            <button className="secondary" onClick={() => onDecide("reject")}>Reject{keysLive && !confirm ? <kbd aria-hidden="true">esc</kbd> : null}</button>
            <button className="link-btn small" onClick={onNote}>Reject with a note</button>
            {danger && !next ? (
              <button ref={dangerBtn} className="danger push" onClick={() => setConfirm(true)}>
                <Ic icon={ops.some((o) => o.verb === "delete") ? Trash2 : TriangleAlert} size={13} />
                {ops.some((o) => o.verb === "delete") ? "Delete…" : "Approve…"}
              </button>
            ) : null}
          </div>
        )}
      </div>
      {wide ? <WideSheet change={change} agent={agent} eyebrow={eyebrow} onClose={() => setWide(false)} onOpenObject={onOpenObject} /> : null}
    </section>
  );
});

/** "{m} min left", then "1:42 left" from two minutes (D33). */
function Expiry({ at }: { at: string }) {
  const end = Date.parse(at);
  const [now, setNow] = useState(Date.now());
  const left = Math.max(0, end - now);
  const soon = left <= 120_000;
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), soon ? 1000 : Math.min(60_000, Math.max(1000, left - 120_000)));
    return () => clearTimeout(t);
  }, [now, soon, left]);
  const s = Math.ceil(left / 1000);
  const text = soon ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : `${Math.ceil(left / 60_000)} min left`;
  return (
    <span className={"change-expiry" + (soon ? " soon" : "")} title={`Expires at ${time(at)}`}>
      <Ic icon={Clock} size={11} />{text}
    </span>
  );
}

/** The agent's words, quoted, plain text, three lines until More (D19–D21). */
function Reason({ agent, text }: { agent: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const shown = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  useEffect(() => {
    const el = body.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [shown]);
  if (!text.trim()) return null;
  return (
    <blockquote className={"change-reason" + (open ? " open" : "")}>
      <span className="change-reason-by">{agent}'s reason</span>
      <div className="change-reason-text" ref={body}>{shown}</div>
      {long || open ? <button className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Less" : "More"}</button> : null}
    </blockquote>
  );
}

function Operations({ change, open, uncapped, onToggle, onUncap, onOpenObject, onWide, enterOn, linkObjects, all = false }: {
  change: AgentChange;
  open: Set<number>;
  uncapped: Set<number>;
  onToggle: (i: number) => void;
  onUncap: (i: number) => void;
  onOpenObject: (t: ObjectTarget) => void;
  onWide?: () => void;
  /** The part Enter reveals next, which carries the ↵ (D35). */
  enterOn?: { op: number; what: "open" | "uncap" };
  /** After it was applied, a created object has a link and a deleted one doesn't (D32). */
  linkObjects: boolean;
  /** The wide sheet: everything open and uncapped. */
  all?: boolean;
}) {
  const ops = change.operations;
  const [wholeShown, setWholeShown] = useState<Set<number>>(new Set());
  return (
    <div className="change-ops">
      {ops.map((o, i) => {
        const isOpen = all || (o.verb !== "delete" && open.has(i));
        const many = ops.length > 1 && !all;
        const exists = linkObjects ? o.verb !== "delete" : o.verb !== "create";
        const kbd = enterOn?.op === i && enterOn.what === "open";
        const head = (
          <>
            {many ? <Ic icon={ChevronRight} size={12} className="chev" /> : null}
            <span className={`ov-kind change-verb ${o.verb}`}>{o.verb}</span>
            <span title={o.kind}><Ic icon={iconOfKind(o.kind)} size={13} /></span>
          </>
        );
        const obj = exists ? (
          <button className="change-obj" onClick={(e) => {
            e.stopPropagation();
            onOpenObject({ kind: o.kind, ...(o.namespace ? { namespace: o.namespace } : {}), name: o.name });
          }} title={`Open ${o.kind} ${o.name} in the cluster view`} aria-label={`Open ${o.kind} ${o.name} in the cluster view`}>
            <span>{objLabel(o)}</span><Ic icon={ArrowUpRight} size={12} />
          </button>
        ) : <span className="change-obj"><span>{objLabel(o)}</span></span>;
        const counts = (
          <span className="change-counts" aria-label={`${o.diff.added} lines added, ${o.diff.removed} removed`}>
            {o.diff.added ? <span className="add">+{o.diff.added}</span> : null}
            {o.diff.removed ? <span className="del">−{o.diff.removed}</span> : null}
            {kbd ? <kbd aria-hidden="true">↵</kbd> : null}
          </span>
        );
        return (
          <div key={i} className={"change-op" + (isOpen ? " open" : "")}>
            {many ? (
              <div className="change-op-head" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => o.verb !== "delete" && onToggle(i)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && o.verb !== "delete") {
                    e.preventDefault();
                    onToggle(i);
                  }
                }}>
                {head}{obj}{counts}
              </div>
            ) : <div className="change-op-head">{head}{obj}{counts}</div>}
            {o.verb === "delete" ? (
              <>
                <div className="change-whole">
                  <Ic icon={Trash2} size={13} className="tone-bad" />
                  <span>The whole object is removed ({o.diff.removed} lines).</span>
                  <button className="link-btn" onClick={() => setWholeShown((s) => {
                    const n = new Set(s);
                    if (n.has(i)) n.delete(i);
                    else n.add(i);
                    return n;
                  })}>{wholeShown.has(i) ? "Hide it" : "Show it"}</button>
                </div>
                {wholeShown.has(i) ? <Diff op={o} capped={false} create={false} /> : null}
              </>
            ) : isOpen ? (
              <Diff op={o} capped={!all && o.diff.lines.length > SHORT_DIFF && !uncapped.has(i)} create={o.verb === "create"}
                onUncap={() => onUncap(i)} uncapKbd={enterOn?.op === i && enterOn.what === "uncap"}
                {...(onWide && !all ? { onWide } : {})} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function Diff({ op, capped, create, onUncap, uncapKbd = false, onWide }: {
  op: ChangeOperation; capped: boolean; create: boolean; onUncap?: () => void; uncapKbd?: boolean; onWide?: () => void;
}) {
  const total = op.diff.lines.filter((l) => l.t !== "…").length;
  return (
    <div className="diff-wrap">
      {onWide ? <button className="icon-btn diff-wide" aria-label="Open the diff wide" title="Open the diff wide" onClick={onWide}><Ic icon={Maximize2} size={13} /></button> : null}
      <pre className={"diff" + (capped ? " capped" : "") + (create ? " create" : "")} tabIndex={0} role="region" aria-label={`Diff of ${op.kind} ${op.name}`}>
        <code className="diff-in">{op.diff.lines.map((l, i) => <Line key={i} line={l} />)}</code>
      </pre>
      {capped ? (
        <div className="diff-more">
          <button className="secondary" onClick={onUncap}>Show all {total} lines{uncapKbd ? <kbd aria-hidden="true">↵</kbd> : null}</button>
        </div>
      ) : null}
    </div>
  );
}

export function Line({ line }: { line: DiffLine }) {
  if (line.t === "…") return <span className="fold">{line.text}</span>;
  const cls = line.t === "+" ? "dl add" : line.t === "-" ? "dl del" : "dl";
  const n = line.t === "-" ? line.oldNo : line.newNo ?? line.oldNo;
  return (
    <span className={cls} data-n={n ?? ""} data-t={line.t === "+" ? "+" : line.t === "-" ? "−" : ""}>
      {line.t === "+" ? <span className="sr-only">added: </span> : line.t === "-" ? <span className="sr-only">removed: </span> : null}
      {yamlTokens(line.text)}
      {"\n"}
    </span>
  );
}

function Warnings({ ops }: { ops: ChangeOperation[] }) {
  const all = ops.flatMap((o) => o.warnings.map((w) => (ops.length > 1 ? `${o.kind} ${o.name}: ${w}` : w)));
  if (!all.length) return null;
  return (
    <div className="change-warn" role="note">
      <Ic icon={TriangleAlert} size={13} />
      <div><b>The API server warns</b>{all.map((w, i) => <span key={i} style={{ display: "block" }}>{w}</span>)}</div>
    </div>
  );
}

/** The danger card's second step (D31): focus on the safe button; Esc goes back, never rejects. */
function Confirm({ change, safeRef, onBack, onGo }: { change: AgentChange; safeRef: React.RefObject<HTMLButtonElement | null>; onBack: () => void; onGo: () => void }) {
  const ops = change.operations;
  const deletes = ops.filter((o) => o.verb === "delete");
  const risks = risksOf(change);
  let sentence: React.ReactNode;
  let keep = "Go back";
  let go = "Apply it";
  if (deletes.length) {
    keep = deletes.length === 1 ? "Keep it" : "Keep them";
    go = deletes.length === 1 ? "Delete it" : "Delete them";
    sentence = deletes.length === 1
      ? <><b>Delete {deletes[0]!.kind} {objLabel(deletes[0]!)}?</b> Landlens can't bring it back.</>
      : <><b>Delete {deletes.length} objects?</b> Landlens can't bring them back.</>;
  } else if (risks.includes("rbac")) {
    sentence = <><b>Apply this access change?</b> It changes who can do what in the cluster.</>;
  } else {
    sentence = <><b>Apply this cluster-wide change?</b> It is not limited to one namespace.</>;
  }
  return (
    <div className="change-confirm" role="alertdialog" aria-label="Confirm" onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }
    }}>
      <p>{sentence}</p>
      <div className="change-actions">
        <button ref={safeRef} className="secondary" onClick={onBack}>{keep}</button>
        <button className="danger solid push" onClick={onGo}>{deletes.length ? <Ic icon={Trash2} size={13} /> : null}{go}</button>
      </div>
    </div>
  );
}

/** The same change, every operation open and uncapped, over the main pane (D26). Esc closes; it never rejects. */
function WideSheet({ change, agent, eyebrow, onClose, onOpenObject }: { change: AgentChange; agent: string; eyebrow: string; onClose: () => void; onOpenObject: (t: ObjectTarget) => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  const all = useMemo(() => new Set(change.operations.map((_, i) => i)), [change.operations]);
  return (
    <div className="palette-back" onClick={onClose} onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }}>
      <div className="dialog change-sheet" role="dialog" aria-label={change.title} onClick={(e) => e.stopPropagation()}
        style={{ width: "min(880px, calc(100vw - 48px))", maxHeight: "calc(100vh - 96px)", display: "grid", gridTemplateRows: "auto minmax(0,1fr)" }}>
        <div className="change-head" style={{ paddingBottom: 10 }}>
          <div className="change-eyebrow"><Ic icon={isDanger(change) ? TriangleAlert : Sparkles} size={13} /><span>{eyebrow}</span>
            <button ref={close} className="icon-btn" style={{ marginLeft: "auto" }} aria-label="Close the wide diff" onClick={onClose}><Ic icon={X} size={14} /></button>
          </div>
          <h3 className="change-title">{change.title}</h3>
        </div>
        <div style={{ overflowY: "auto" }}>
          <Reason agent={agent} text={change.reason} />
          <Operations change={change} open={all} uncapped={all} onToggle={() => {}} onUncap={() => {}} onOpenObject={onOpenObject} linkObjects={false} all />
          <Warnings ops={change.operations} />
        </div>
      </div>
    </div>
  );
}

const DONE: Record<string, { icon: LucideIcon; word: string }> = {
  applied: { icon: Check, word: "Applied" },
  rejected: { icon: Ban, word: "Rejected" },
  expired: { icon: Clock, word: "Expired" },
  withdrawn: { icon: CircleDashed, word: "Withdrawn" },
  failed: { icon: X, word: "Failed" },
};

/** A decided change: one tool row and a verdict line; Show change opens what was shown (D42–D45). */
export function ChangeDone({ change, agent, onOpenObject }: { change: AgentChange; agent: string; onOpenObject: (t: ObjectTarget) => void }) {
  const [shown, setShown] = useState(false);
  const d = DONE[change.state] ?? DONE.failed!;
  const op = change.operations[0];
  const detail = change.operations.length > 1 ? `${change.operations.length} objects` : op ? `${op.kind} ${objLabel(op)}` : "";
  const failed = change.state === "failed";
  const conflict = failed && /\b409\b/.test(change.result ?? "");
  const note = change.state === "rejected" && change.result?.startsWith("Rejected: ") ? change.result.slice(10) : undefined;
  const verdict =
    change.state === "applied" ? <><b className="tone-ok">Applied</b> · {change.result} · {time(new Date().toISOString())}</>
      : change.state === "rejected" ? note ? <><b>Rejected with a note</b> · <span className="change-quote">{note.length > 80 ? `${note.slice(0, 80)}…` : note}</span></> : <b>Rejected</b>
        : change.state === "expired" ? <><b>Expired</b> after 15 minutes · nothing was applied</>
          : <><b>Withdrawn</b> when you stopped {agent} · nothing was applied</>;
  const last = change.state === "applied" ? "Applied exactly as shown." : failed ? "Nothing of the failed operation was applied." : "Nothing was applied.";
  const toggle = (
    <button className="tool-verdict" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
      <span className="tool-verdict-text">{failed ? "The change as it was shown" : verdict}</span>
      <span className="tool-verdict-act">{shown ? "Hide change" : "Show change"}</span>
    </button>
  );
  return (
    <div className={`tool-group change-done ${change.state}`}>
      <div className={`tool${failed ? " tool-failed" : ""}`}>
        <div className="tool-summary-static">
          <span className="tool-icon"><Ic icon={op ? iconOfKind(op.kind) : Sparkles} size={13} /></span>
          <span className="tool-label">{change.tool.replace(/_/g, " ")}</span>
          <span className="tool-detail mono">{detail}</span>
          <span className={`tool-status ${failed ? "failed" : change.state === "applied" ? "completed" : ""}`} role="img" aria-label={d.word} title={d.word}><Ic icon={d.icon} size={13} /></span>
        </div>
      </div>
      {failed ? (
        <div className="change-error">
          <b className="tone-bad">Not applied.</b>
          <span>{conflict ? `The object changed after you saw this, so nothing was sent. ${agent} has been told and can propose it again.` : "The API server refused it. Nothing was changed."}</span>
          {change.result ? <pre className="tool-io">{change.result}</pre> : null}
        </div>
      ) : null}
      {toggle}
      {shown ? (
        <div className="change-shown">
          <Reason agent={agent} text={change.reason} />
          <Operations change={change} open={new Set(change.operations.map((_, i) => i))} uncapped={new Set()} onToggle={() => {}} onUncap={() => {}} onOpenObject={onOpenObject} linkObjects={change.state === "applied"} />
          <Warnings ops={change.operations} />
          <p className="dim change-last">{last}</p>
        </div>
      ) : null}
    </div>
  );
}
