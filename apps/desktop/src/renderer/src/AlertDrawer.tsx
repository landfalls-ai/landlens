// One of Cloud Monitoring's open alerts on this cluster (wave 9 part 3, D187–D188). The drawer shows what main read of
// the alert, and reads its policy's conditions and documentation when it opens (gcp:cluster-item: the handle and the
// alert's id, nothing else). The documentation is written in Google Cloud by whoever made the policy: it is shown as
// text in a well that says so (no Markdown, no links), and its first 300 characters only. When the alert leaves the
// view the drawer stays, saying when, as a problem's does. Landlens doesn't snooze, acknowledge or close an alert.
// Ask Claude hands on the brief read here only while the alert is in the view it was read for (review of part 3, L4).
import type { GcpAlert, GcpClusterItem } from "@landlens/contracts";
import { BellRing, CircleCheck, CircleX, Clock, Info, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { Ic, iconOfKind } from "./icons";
import { ALERT_BADGE, alertSubjectLine, briefToSend, latestOnly, openFor, policyName, policyNote } from "./googleRules";
import type { HeldAlert } from "./problemRules";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function AlertDrawer(props: {
  handle: string;
  project: string;
  held: HeldAlert;
  /** What to say once the alert has left the view (goneNote): closed, or not among those read (it may still be open). */
  note?: "closed" | "unread";
  /** When the view's alerts were read: a brief read for an earlier view isn't handed on (L4). */
  viewAt?: string;
  now: number;
  onClose: () => void;
  /** With the brief this drawer has read, if any. */
  onAsk: (a: GcpAlert, brief?: string) => void;
  onOpen: (a: GcpAlert) => void;
}) {
  const a = props.held.last;
  const gone = props.held.goneAt;
  // The detail of one alert: read when the drawer opens on it, kept while it stays; `at` is the view it was read for.
  // Only the latest read's answer lands (latestOnly, T3): a slow one for the previous alert never replaces it.
  type Item = { id: string; at?: string; r?: GcpClusterItem; error?: ApiError };
  const [item, setItem] = useState<Item>();
  const read = useRef<(handle: string, id: string, at: string | undefined) => void>(undefined);
  read.current ??= latestOnly(
    (h: string, id: string, at: string | undefined): Promise<Item> => api.invoke("gcp:cluster-item", { handle: h, kind: "alert", id }).then(
      (r) => ({ id, ...(at ? { at } : {}), r }),
      (error: ApiError) => ({ id, error }),
    ),
    { value: setItem, error: () => undefined },
  );
  useEffect(() => {
    if (gone && item?.id === a.id) return;
    const id = a.id;
    setItem({ id });
    if (gone) return;
    read.current!(props.handle, id, props.viewAt);
  }, [a.id, props.handle]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = ALERT_BADGE[a.severity];
  const open = openFor(a.opened, props.now);
  const s = a.subject;
  const mine = item?.id === a.id ? item : undefined;
  return (
    <aside className="drawer pb-drawer al-drawer" aria-label={`Cloud Monitoring alert: ${policyName(a)}`}>
      <header className="drawer-head">
        <div className="drawer-top">
          <span className={`kind-tile sm ${b?.tone ?? ""}`}><Ic icon={BellRing} size={15} /></span>
          <div className="eyebrow">Alert<span className="sep"> / </span>Cloud Monitoring<span className="sep"> / </span>{props.project}</div>
          <span className="grow" />
          <button className="ask-btn" onClick={() => props.onAsk(a, briefToSend(props.held, mine, props.viewAt))}><Ic icon={Sparkles} size={14} />Ask Claude</button>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close alert" title="Close (Esc)"><Ic icon={X} size={15} /></button>
        </div>
        <h2 className="drawer-title">{policyName(a)}</h2>
        <div className="drawer-meta">
          <span className="badge muted"><Ic icon={BellRing} size={13} />Alert</span>
          {b ? <span className={`badge ${b.tone}`}><Ic icon={b.tone === "bad" ? CircleX : Clock} size={13} />{b.word}</span> : null}
          {open ? <span className="meta">open <b className="mono">{open}</b></span> : null}
          <span className="grow" />
          {s ? <button className="secondary pb-open" onClick={() => props.onOpen(a)}><Ic icon={iconOfKind(s.kind)} size={13} />Open {s.kind}</button> : null}
        </div>
      </header>
      {gone ? (
        props.note !== "closed" ? (
          <div className="notice pb-gone" role="status">
            <Ic icon={Info} size={15} className="dim" />
            <div className="notice-body"><strong>Not among the alerts read since {clock(gone)}.</strong><p>Cloud Monitoring's answer was only partly read, so it may still be open. This is what Landlens saw last.</p></div>
          </div>
        ) : (
          <div className="notice pb-gone" role="status">
            <Ic icon={CircleCheck} size={15} className="tone-ok" />
            <div className="notice-body"><strong>No longer open at {clock(gone)}.</strong><p>This is what Landlens saw last.</p></div>
          </div>
        )
      ) : null}
      <nav className="tabs" role="tablist" aria-label="Alert">
        <button role="tab" aria-selected="true" className="on">Summary</button>
      </nav>
      <div className="drawer-body">
        <div className="overview pb-summary">
          <dl className="facts pb-facts">
            <dt>Opened</dt><dd><span className="mono">{new Date(a.opened).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>{open ? <span className="dim"> · {open} ago</span> : null}</dd>
            <dt>Policy</dt><dd className="pb-msg">{policyName(a)}</dd>
            <dt>Severity</dt><dd>{b ? b.word : <span className="dim">None given</span>}</dd>
            <dt>Resource</dt><dd><span className="mono">{a.resourceType}</span><span className="dim"> · {alertSubjectLine(a).replace(/^Alert · /, "")}</span></dd>
            {a.metric ? <><dt>Metric</dt><dd className="mono pb-msg">{a.metric}</dd></> : null}
            <dt>Project</dt><dd className="mono">{props.project}</dd>
          </dl>
          <section className="al-policy" aria-label="From the policy">
            <h3>From the policy</h3>
            {!a.policyId ? (
              <p className="dim">{policyNote(a, props.project)}</p>
            ) : gone && !mine?.r ? (
              <p className="dim">This alert is no longer open, so its policy isn't read.</p>
            ) : !mine || (!mine.r && !mine.error) ? (
              <p className="dim">Reading the policy…</p>
            ) : mine.error ? (
              <p className="dim">{mine.error.status === 404 ? "This alert is no longer in the view." : `Couldn't read it: ${mine.error.message}`}</p>
            ) : !mine.r?.policy ? null : "error" in mine.r.policy ? (
              <p className="dim">Couldn't read the policy: {mine.r.policy.error}</p>
            ) : (
              <>
                {mine.r.policy.conditions.length ? (
                  <>
                    <h4>Conditions</h4>
                    <ul className="al-conditions">{mine.r.policy.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul>
                  </>
                ) : null}
                {mine.r.policy.documentation ? (
                  <div className="al-doc" role="note" aria-label="Policy documentation">
                    <div className="al-doc-head">
                      <Ic icon={Info} size={13} />
                      <span>Written in Google Cloud by whoever made the policy</span>
                      {mine.r.policy.cut ? <span className="al-cut">First 300 characters</span> : null}
                    </div>
                    <p className="al-doc-text">{mine.r.policy.documentation}</p>
                  </div>
                ) : <p className="dim">The policy has no documentation.</p>}
              </>
            )}
          </section>
          <p className="small dim">From Cloud Monitoring. Landlens doesn't snooze, acknowledge or close alerts.</p>
        </div>
      </div>
    </aside>
  );
}
