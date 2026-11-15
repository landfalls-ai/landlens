// A session's summary to Landflow's brain (docs/family.md#a-sessions-summary-to-the-brain, wave 7 D134): one
// `work.session` event, drafted by main's rules from the session's own record, shown here as it will be sent, each text
// field editable, private by default, sent only on the person's click. The window holds the sheet's id and the digest
// of the fields main filled; main sends those as shown, and the text as typed or not at all (a scrub that would change
// it is shown back). Also the dock's session menu: the sheet, Remove from the brain, and Open this session in
// Clickland (when telemetry is on and the console is set).
import { BRAIN_NOTES, type BrainDraft, type BrainSend, type FamilyList, type WorkVisibility } from "@landlens/contracts";
import { Brain, CircleCheck, CircleX, Ellipsis, Info, SquareArrowOutUpRight, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ApiError } from "./api";
import { Ic, SiblingMark } from "./icons";
import { sheetKeys } from "./TriageSheet";

const VISIBILITY: Record<WorkVisibility, string> = {
  private: "Only you see it in your brain.",
  team: "Your team sees it.",
  org: "Everyone in your organisation sees it.",
};

/** What the family offers a session now: the brain (Landflow's key has brain:write) and Clickland's session search. */
export function useReportable(): { brain: boolean; clickland: boolean } {
  const [list, setList] = useState<FamilyList>();
  useEffect(() => {
    void api.invoke("family:list", {}).then(setList, () => undefined);
    return api.on("family:update", (i: FamilyList["clickland"]) => setList((l) => (l ? { ...l, [i.sibling]: i } : l)));
  }, []);
  const lf = list?.landflow;
  const ck = list?.clickland;
  return { brain: lf?.state === "ready" && !!lf.can?.brain, clickland: !!ck?.telemetry?.on && !!ck.console };
}

/** The dock's session menu (D132, D134). */
export function SessionMenu(props: { session: string; can: { brain: boolean; clickland: boolean }; onSummary: () => void; onNote: (n: { text: string; tone: "ok" | "warn" | "bad" }) => void }) {
  const [open, setOpen] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !self.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  if (!props.can.brain && !props.can.clickland) return null;
  const pick = (f: () => void) => () => (setOpen(false), f());
  const remove = () => {
    if (!window.confirm("Remove this session's summary from your brain?")) return;
    api.invoke("brain:remove", { session: props.session }).then(
      (r) => props.onNote({ text: r.note, tone: r.ok ? "ok" : "warn" }),
      (e: ApiError) => props.onNote({ text: e.message, tone: "bad" }),
    );
  };
  const clickland = () =>
    void api.invoke("telemetry:open", { session: props.session }).catch((e: ApiError) => props.onNote({ text: e.message, tone: "bad" }));
  return (
    <div className="session-menu" ref={self} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button className="icon-btn" aria-label="Session actions" title="Session actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Ic icon={Ellipsis} size={15} /></button>
      {open ? (
        <div className="menu session-menu-list" role="menu" aria-label="Session">
          {props.can.brain ? (
            <>
              <button role="menuitem" className="cluster-option" onClick={pick(props.onSummary)}><Ic icon={Brain} size={14} />Send a summary to the brain…</button>
              <button role="menuitem" className="cluster-option" onClick={pick(remove)}><Ic icon={Trash2} size={14} />Remove from the brain</button>
            </>
          ) : null}
          {props.can.clickland ? <button role="menuitem" className="cluster-option" onClick={pick(clickland)}><Ic icon={SquareArrowOutUpRight} size={14} />Open this session in Clickland</button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A quiet line under a session that has answered: the brain, offered, never sent by itself. */
export function SummaryStrip(props: { onSummary: () => void }) {
  return (
    <div className="brain-strip">
      <Ic icon={Brain} size={13} className="dim" />
      <span className="small dim grow">Done here? Keep a note of this session in your brain.</span>
      <button className="link-btn small" onClick={props.onSummary}>Send a summary…</button>
    </div>
  );
}

/** `onAsk`: the dock marks the draft's turn, so its answer shows as its own (Landlens's fixed question, not yours). */
export function BrainSheet({ session, onClose, onAsk }: { session: string; onClose: () => void; onAsk?: () => void }) {
  const [d, setD] = useState<BrainDraft>();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [team, setTeam] = useState("");
  const [initiative, setInitiative] = useState("");
  const [visibility, setVisibility] = useState<WorkVisibility>("private");
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BrainSend>();
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api.invoke("brain:draft", { session }).then((x) => {
      if (!live) return;
      setD(x);
      setTitle(x.event.title);
      setSummary(x.event.summary);
      setTimeout(() => first.current?.focus(), 0);
    }, (e: ApiError) => live && setError(e.message));
    return () => void (live = false);
  }, [session]);

  const ask = () => {
    if (!d || asking) return;
    setAsking(true);
    setError(undefined);
    onAsk?.();
    api.invoke("brain:ask", { sheet: d.sheet }).then((r) => setSummary(r.summary), (e: ApiError) => setError(e.message)).finally(() => setAsking(false));
  };
  const send = () => {
    if (!d || sending) return;
    setSending(true);
    setError(undefined);
    setResult(undefined);
    api.invoke("brain:send", {
      sheet: d.sheet, digest: d.digest, title, summary, visibility,
      ...(team.trim() ? { team: team.trim() } : {}), ...(initiative.trim() ? { initiative: initiative.trim() } : {}),
    }).then((r) => {
      setResult(r);
      // A scrub would change the text: the scrubbed text goes in the boxes, to read before sending again.
      if (r.scrubbed) {
        setTitle(r.scrubbed.title);
        setSummary(r.scrubbed.summary);
        setTeam(r.scrubbed.team ?? "");
        setInitiative(r.scrubbed.initiative ?? "");
      }
    }, (e: ApiError) => setError(e.message)).finally(() => setSending(false));
  };
  const e = d?.event;
  const done = result?.saved;
  return (
    <div className="palette-back" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog lf-sheet brain-sheet" role="dialog" aria-modal="true" aria-labelledby="brain-title" onKeyDown={sheetKeys(onClose)}>
        <header className="dialog-head">
          <span className="lf-mark"><SiblingMark sibling="landflow" size={15} /></span>
          <h2 id="brain-title" className="grow">Send a summary to the brain</h2>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body lf-body">
          {!d && !error ? <div className="skel" style={{ height: 160 }} /> : null}
          {d && !done ? (
            <>
              <p className="small lf-line">One <span className="mono">work.session</span> event in your Landflow's brain, as below. Sending again updates the same one.</p>
              <label className="lf-field">
                <span className="lf-label">Title</span>
                <span className="field"><input ref={first} value={title} maxLength={200} onChange={(x) => setTitle(x.target.value)} aria-label="Title" /></span>
              </label>
              <label className="lf-field">
                <span className="lf-label">Summary</span>
                <textarea value={summary} maxLength={500} rows={4} onChange={(x) => setSummary(x.target.value)} aria-label="Summary" />
                <span className="brain-count small dim">
                  {summary.length}/500
                  {d.open ? <button className="link-btn small" onClick={ask} disabled={asking}>{asking ? "Claude is writing…" : "Ask Claude to draft"}</button> : <span>{BRAIN_NOTES.closed}</span>}
                </span>
              </label>
              <div className="lf-field">
                <span className="lf-label" id="brain-vis">Who sees it</span>
                <div className="seg" role="radiogroup" aria-labelledby="brain-vis">
                  {(Object.keys(VISIBILITY) as WorkVisibility[]).map((v) => (
                    <button key={v} role="radio" aria-checked={visibility === v} className={visibility === v ? "on" : ""} onClick={() => setVisibility(v)}>{v}</button>
                  ))}
                </div>
                <p className="small dim lf-sev-line">{VISIBILITY[visibility]}</p>
              </div>
              <div className="brain-hints">
                <label className="lf-field">
                  <span className="lf-label">Team (optional)</span>
                  <span className="field"><input value={team} maxLength={120} onChange={(x) => setTeam(x.target.value)} aria-label="Team" /></span>
                </label>
                <label className="lf-field">
                  <span className="lf-label">Initiative (optional)</span>
                  <span className="field"><input value={initiative} maxLength={120} onChange={(x) => setInitiative(x.target.value)} aria-label="Initiative" /></span>
                </label>
              </div>
              <details className="lf-more">
                <summary className="small">Everything that is sent</summary>
                <dl className="facts lf-facts">
                  <Fact k="kind" v={e!.kind} />
                  <Fact k="source" v={e!.source} />
                  <Fact k="sourceId" v={e!.sourceId} />
                  <Fact k="occurredAt" v={e!.occurredAt} />
                  {e!.endedAt ? <Fact k="endedAt" v={e!.endedAt} /> : null}
                  <Fact k="turns" v={String(e!.turns)} />
                  <Fact k="visibility" v={visibility} />
                  <Fact k="To" v={d.to} />
                </dl>
                <p className="small dim">Drafted from: {d.facts.join(" · ")}. No repo, areas, link or PRs.</p>
              </details>
            </>
          ) : null}
          {result ? (
            <div className={`lf-result tone-${result.saved ? "ok" : "warn"}`} role="status">
              <Ic icon={result.saved ? CircleCheck : Info} size={15} className={result.saved ? "tone-ok" : "tone-warn"} />
              <div className="notice-body"><strong>{result.note}</strong></div>
            </div>
          ) : null}
          {error ? <p className="lf-error" role="alert"><Ic icon={CircleX} size={13} className="tone-bad" />{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          <span className="grow" />
          {done ? <button className="secondary" onClick={onClose}>Done</button> : (
            <>
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!d || sending || asking || !title.trim()} onClick={send}>{sending ? "Sending…" : "Send"}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return <><dt>{k}</dt><dd className={typeof v === "string" ? "mono" : undefined}>{v}</dd></>;
}
