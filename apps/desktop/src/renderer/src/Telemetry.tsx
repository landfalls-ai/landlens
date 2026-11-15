// Landlens's own telemetry on the Clickland card (docs/family.md#what-landlens-reports, wave 7 D127–D133): off until
// turned on, and turning it on asks in main's own dialog, which names the collector. "Counts only" keeps every name out.
// "See what is sent" shows the last 100 records exactly as main queued them: names, numbers and fixed words, nothing
// else, because main's record constructors take nothing else.
import { DEFAULT_COLLECTOR, TelemetryTeam, type FamilyInfo, type TelemetryInfo, type TelemetryRecord } from "@landlens/contracts";
import { X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";
import { sheetKeys } from "./TriageSheet";

const OFF: TelemetryInfo = { on: false, collector: DEFAULT_COLLECTOR, names: true, waiting: 0, dropped: 0 };
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const clock = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function useTelemetry(c: FamilyInfo, onInfo: (i: FamilyInfo) => void) {
  const t = c.telemetry ?? OFF;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [form, setForm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const set = (p: { on?: boolean; collector?: string; names?: boolean; team?: string | null }, then?: () => void) => {
    setBusy(true);
    setError(undefined);
    api.invoke("telemetry:set", p).then((i) => (onInfo({ ...c, telemetry: i }), then?.()), (e: ApiError) => setError(e.message)).finally(() => setBusy(false));
  };
  const last = t.last ? (t.last.ok ? `Sent ${clock(t.last.at)}` : "Not answering") : t.on ? "Waiting" : "Off";
  const rows = (
    <>
      <TRow label="Landlens's telemetry"
        say={t.on ? <>Spans, counts and events to the collector at <span className="mono">{hostOf(t.collector)}</span>. No prompt or answer text, YAML, logs or secrets.</> : "Off: Landlens sends nothing about itself."}
        state={t.on ? last : "Off"} tone={t.on ? (t.last && !t.last.ok ? "warn" : "ok") : "muted"}>
        <label className="switch fam-switch">
          <input type="checkbox" role="switch" checked={t.on} disabled={busy} onChange={() => set({ on: !t.on })} aria-label="Landlens's telemetry" />
        </label>
      </TRow>
      {t.on ? (
        <TRow label="Names"
          say={t.names ? "The cluster, namespace and the object a question was about go with the records." : "Counts only: no cluster, namespace or object names."}
          state={t.names ? "Names" : "Counts only"} tone={t.names ? "ok" : "muted"}>
          <label className="switch fam-switch">
            <input type="checkbox" role="switch" checked={t.names} disabled={busy} onChange={() => set({ names: !t.names })} aria-label="Send names with telemetry" />
          </label>
        </TRow>
      ) : null}
    </>
  );
  const panel = (
    <>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {form ? <TelemetryForm t={t} busy={busy} onCancel={() => setForm(false)} onSave={(p) => set(p, () => setForm(false))} /> : null}
      <div className="fam-acts">
        <button className="secondary sm" onClick={() => setDrawer(true)}>See what is sent</button>
        {form ? null : <button className="link-btn small" onClick={() => setForm(true)}>Collector and team…</button>}
        {t.dropped ? <span className="dim small">{t.dropped} dropped</span> : t.waiting ? <span className="dim small">{t.waiting} waiting</span> : null}
      </div>
      {drawer ? <SentDrawer onClose={() => setDrawer(false)} /> : null}
    </>
  );
  return { rows, panel };
}

function TRow(props: { label: string; say: React.ReactNode; state: string; tone: "ok" | "muted" | "warn"; children?: React.ReactNode }) {
  return (
    <li className="fam-row">
      <span className="fam-label">{props.label}</span>
      <span className="fam-say small dim">{props.say}</span>
      <span className="fam-state">
        <span className={`fam-dot ${props.tone}`} aria-hidden="true" />
        <span className="small">{props.state}</span>
        {props.children}
      </span>
    </li>
  );
}

function TelemetryForm(props: { t: TelemetryInfo; busy: boolean; onCancel: () => void; onSave: (p: { collector: string; team: string | null }) => void }) {
  const [collector, setCollector] = useState(props.t.collector);
  const [team, setTeam] = useState(props.t.team ?? "");
  const teamOk = !team.trim() || TelemetryTeam.safeParse(team.trim()).success;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!teamOk) return;
    props.onSave({ collector: collector.trim(), team: team.trim() || null });
  };
  return (
    <form className="tl-form" onSubmit={submit} aria-label="Telemetry collector and team">
      <label className="lf-field">
        <span className="lf-label">Collector (OTLP/HTTP)</span>
        <span className="field"><input className="mono" value={collector} onChange={(e) => setCollector(e.target.value)} spellCheck={false} placeholder={DEFAULT_COLLECTOR} aria-label="Collector address" /></span>
        <span className="small dim">Your Clickland's OpenTelemetry collector. https, or http only to this machine. A new address asks you first.</span>
      </label>
      <label className="lf-field">
        <span className="lf-label">Team (optional)</span>
        <span className="field"><input className="mono" value={team} onChange={(e) => setTeam(e.target.value)} spellCheck={false} placeholder="platform" aria-label="Team" aria-invalid={!teamOk} /></span>
        <span className={`small ${teamOk ? "dim" : "tone-bad"}`}>{teamOk ? "Sent as team.id, so Clickland's Agents pages group your sessions." : "Lowercase letters, digits, - . _ (at most 60)."}</span>
      </label>
      <div className="tl-form-acts">
        <button type="button" className="secondary sm" onClick={props.onCancel}>Cancel</button>
        <button type="submit" className="primary sm" disabled={props.busy || !teamOk || !collector.trim()}>Save</button>
      </div>
    </form>
  );
}

/** The last 100 records, newest first, each as its name and its attributes: what main queued, nothing added. */
function SentDrawer({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ records: TelemetryRecord[]; info: TelemetryInfo }>();
  const [error, setError] = useState<string>();
  const load = () => void api.invoke("telemetry:recent", {}).then(setData, (e: ApiError) => setError(e.message));
  useEffect(load, []);
  const records = data ? [...data.records].reverse() : [];
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog lf-sheet tl-drawer" role="dialog" aria-modal="true" aria-labelledby="tl-title" onKeyDown={sheetKeys(onClose)}>
        <header className="dialog-head">
          <h2 id="tl-title" className="grow">What Landlens sends</h2>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body">
          <p className="small dim lf-line">
            {data?.info.on ? <>To <span className="mono">{data.info.collector}</span>. </> : "Telemetry is off: nothing is sent, and nothing is kept. "}
            The last 100 records, exactly as queued. Never prompt or answer text, tool arguments, YAML, log lines, paths or secrets.
          </p>
          {error ? <p className="lf-error" role="alert">{error}</p> : null}
          {data && !records.length ? <p className="small dim">Nothing yet.</p> : null}
          <ol className="tl-records" aria-label="Records">
            {records.map((r, i) => (
              <li key={`${r.at}-${i}`} className="tl-record">
                <div className="tl-head">
                  <span className={`badge ${r.signal === "span" ? "muted" : r.signal === "metric" ? "ok" : "warn"}`}>{r.signal === "span" ? "span" : r.signal === "metric" ? r.kind : r.severity}</span>
                  <b className="mono">{r.name}</b>
                  <span className="grow" />
                  <span className="dim small">{clock(r.at)}</span>
                </div>
                <dl className="tl-attrs mono">
                  {r.signal === "metric" ? <div><dt>value</dt><dd>{r.value}</dd></div> : null}
                  {r.signal === "span" ? <div><dt>duration</dt><dd>{Math.max(0, r.end - r.at)} ms</dd></div> : null}
                  {Object.entries(r.attrs).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
                </dl>
              </li>
            ))}
          </ol>
        </div>
        <footer className="dialog-foot">
          <button className="secondary" onClick={load}>Refresh</button>
          <span className="grow" />
          <button className="secondary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}
