// Send to triage (wave 7 part 4, D120, D122; docs/family.md#landflow-on-a-resource): the alert exactly as main will
// send it to the connected Landflow's triage webhook, the severity and the log lines the person chooses, and then what
// Landflow's triage did with it. The window holds only the sheet's id and the digest of the body it shows: main built
// the alert from the doctor's report and sends that body only, with the webhook's secret it keeps (review of part 4,
// H1). Every field is shown from the alert itself, the rest folded under "Everything that is sent" (L3). Enter never
// sends; Send is a click.
import type { AlertPreview, LandflowRun, Problem, TriageSeverity } from "@landlens/contracts";
import { CircleCheck, CircleX, Info, Siren, SquareArrowOutUpRight, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ApiError } from "./api";
import { Ic, SiblingMark } from "./icons";
import { openInLandflow, refreshSent, useFollow } from "./landflow";
import { hasLogs } from "./problemRules";

export const SEVERITY: Record<TriageSeverity, string> = {
  sev1: "Critical. Landflow never holds sev1: a war room opens.",
  sev2: "Major: something people use is failing.",
  sev3: "Minor: degraded, or failing where few notice.",
  sev4: "Low: worth a look, no one is blocked.",
};
const defaultSeverity = (p: Problem): TriageSeverity => (p.tone === "bad" ? "sev2" : "sev3");

/** Enter never sends and Escape closes: the sheet's keys (D122), as the autonomy sheet's. */
export function sheetKeys(onClose: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target as HTMLElement).closest("textarea")) (e.preventDefault(), e.stopPropagation());
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose());
  };
}

export function RunNote({ r, paused, onAgain }: { r: LandflowRun; paused: boolean; onAgain: () => void }) {
  const icon = r.outcome === "opened" || r.outcome === "attached" ? Siren : r.tone === "bad" ? CircleX : r.tone === "warn" ? TriangleAlert : r.tone === "ok" ? CircleCheck : Info;
  return (
    <div className={`lf-result tone-${r.tone}`} role="status">
      <Ic icon={icon} size={15} className={r.tone === "info" ? "dim" : `tone-${r.tone}`} />
      <div className="notice-body">
        <strong>{paused ? `${r.note.replace(/ Following the run…$/, "")} Still going.` : r.note}</strong>
        {paused ? <button className="link-btn" onClick={onAgain}>Check again</button> : null}
      </div>
    </div>
  );
}

export function TriageSheet({ handle, namespace, problem: p, onClose }: { handle: string; namespace?: string; problem: Problem; onClose: () => void }) {
  const [severity, setSeverity] = useState<TriageSeverity>(defaultSeverity(p));
  const [logs, setLogs] = useState(false);
  const [preview, setPreview] = useState<AlertPreview>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // While main is building the alert again, Send waits: it must send what the sheet shows.
  const [reading, setReading] = useState(true);
  const [sent, setSent] = useState<LandflowRun>();
  const sheet = useRef<string | undefined>(undefined);
  const follow = useFollow(sent, () => refreshSent(handle));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => body.current?.querySelector<HTMLButtonElement>(".seg button.on")?.focus(), []);

  // Every choice asks main for the alert again, under the same sheet: what Send sends is what is on screen.
  useEffect(() => {
    let live = true;
    setError(undefined);
    setReading(true);
    api.invoke("landflow:alert", { handle, ...(namespace ? { namespace } : {}), problem: p.id, severity, logs, ...(sheet.current ? { sheet: sheet.current } : {}) }).then(
      (a) => {
        if (!live) return;
        sheet.current = a.sheet;
        setPreview(a);
        setReading(false);
      },
      (e: ApiError) => live && (setPreview(undefined), setError(e.message), setReading(false)),
    );
    return () => void (live = false);
  }, [handle, namespace, p.id, severity, logs]);

  const send = () => {
    if (!preview || sending || reading) return;
    setSending(true);
    setError(undefined);
    api.invoke("landflow:triage", { sheet: preview.sheet, digest: preview.digest }).then(
      (r) => (setSent(r), refreshSent(handle)),
      (e: ApiError) => (setError(e.message), setSending(false)),
    );
  };
  const r = follow.run;
  const a = preview?.alert;
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog lf-sheet" role="dialog" aria-modal="true" aria-labelledby="lf-triage-title" onKeyDown={sheetKeys(onClose)}>
        <header className="dialog-head">
          <span className="lf-mark"><SiblingMark sibling="landflow" size={15} /></span>
          <h2 id="lf-triage-title" className="grow">Send to triage</h2>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body lf-body" ref={body}>
          <div className="lf-title"><Ic icon={Siren} size={14} className={`tone-${p.tone}`} /><strong>{a?.title ?? p.title}</strong></div>
          {r ? null : (
            <>
              <div className="lf-field">
                <span className="lf-label" id="lf-sev">Severity</span>
                <div className="seg lf-sev" role="radiogroup" aria-labelledby="lf-sev">
                  {(Object.keys(SEVERITY) as TriageSeverity[]).map((s) => (
                    <button key={s} role="radio" aria-checked={severity === s} className={severity === s ? "on" : ""} onClick={() => setSeverity(s)}>{s}</button>
                  ))}
                </div>
                <p className="small dim lf-sev-line">{SEVERITY[severity]}</p>
              </div>
              <dl className="facts lf-facts">
                <Fact k="Service" v={a?.service ?? p.name} />
                <Fact k="Cluster" v={a?.environment ?? "…"} />
                {a?.labels.namespace ? <Fact k="Namespace" v={a.labels.namespace} /> : null}
                <Fact k="To" v={preview?.to ?? "…"} />
                <Fact k="Secret" v={<span className="dim">Your webhook secret, in the <b className="mono">{preview?.header ?? "…"}</b> header</span>} />
              </dl>
              <div className="lf-field">
                <span className="lf-label">Description, as it will be sent</span>
                <pre className="lf-well" tabIndex={0} aria-label="Description as it will be sent">{a ? a.description : "…"}</pre>
                {preview?.logs?.note ? <p className="small dim">{preview.logs.note}</p> : null}
              </div>
              {a ? (
                <details className="lf-more">
                  <summary className="small">Everything that is sent</summary>
                  <dl className="facts lf-facts">
                    <Fact k="source" v={a.source} />
                    <Fact k="status" v={a.status} />
                    <Fact k="severity" v={a.severity} />
                    <Fact k="id" v={a.id} />
                    <Fact k="fingerprint" v={a.fingerprint} />
                    {Object.entries(a.labels).map(([k, v]) => <Fact key={k} k={`labels.${k}`} v={String(v)} />)}
                    <Fact k="entity.kind" v={a.entity.kind} />
                    <Fact k="entity.id" v={a.entity.id} />
                  </dl>
                </details>
              ) : null}
              {hasLogs(p) ? (
                <label className="check-box">
                  <input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} />
                  Include the last 40 log lines
                </label>
              ) : null}
              <p className="small lf-line">Landflow's triage decides whether a war room opens in Landfall. Landlens doesn't open one.</p>
            </>
          )}
          {r ? <RunNote r={r} paused={follow.paused} onAgain={follow.checkAgain} /> : null}
          {r?.room ? <p className="small dim mono lf-room" title={r.room}>{r.room}</p> : null}
          {error ? <p className="lf-error" role="alert"><Ic icon={CircleX} size={13} className="tone-bad" />{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          {r ? (
            <>
              {r.run && r.room ? <button className="primary" onClick={() => void openInLandflow(r.run!, "room")}><Ic icon={SquareArrowOutUpRight} size={13} />Open the room</button> : null}
              {r.run && r.runLink ? <button className="secondary" onClick={() => void openInLandflow(r.run!, "run")}>Open the run in Landflow</button> : null}
              <span className="grow" />
              <button className="secondary" onClick={onClose}>Done</button>
            </>
          ) : (
            <>
              <span className="grow" />
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!preview || sending || reading} onClick={send}>{sending ? "Sending…" : "Send"}</button>
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
