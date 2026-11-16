// "Google suggests" on the Overview (wave 9, D178): GKE's diagnosis recommender for this cluster, as main read it.
// Google's sentences are React text: no Markdown, and nothing in them becomes a link. A row opens in place (no drawer)
// with what Google recommends and, for an API deprecation, who still calls the API. Landlens never marks a suggestion
// done or dismissed. Ask Claude on a suggestion comes with wave 9 part 3 (D189).
import type { GkeAdvice } from "@landlens/contracts";
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, Cloud, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Ic, type LucideIcon } from "./icons";
import { copyText } from "./present";
import { adviceMeta, copyableCommand, sentenceParts, SEVERITY_BADGE } from "./googleRules";
import type { GoogleView } from "./googleView";

const TONE_ICON: Record<"bad" | "warn" | "muted", LucideIcon> = { bad: CircleX, warn: Clock, muted: CircleDashed };

/** The panel, for a GKE cluster of a chosen project; nothing otherwise. */
export function GoogleSuggests({ g, now }: { g: GoogleView; now: number }) {
  const [open, setOpen] = useState<string>();
  const v = g.view;
  if (!v || !v.gke) return null;
  const advice = v.advice;
  const items = "error" in advice ? [] : advice.items;
  return (
    <section className="panel gs" aria-label="Google suggests">
      <header className="panel-head">
        <Ic icon={Cloud} size={15} className="gs-cloud" />
        <h3>Google suggests</h3>
        {"error" in advice ? null : <span className="count-badge">{items.length}</span>}
        <span className="gs-where">GKE · {v.cluster.project} · {v.cluster.location}</span>
        <span className="grow" />
        <button className="icon-btn" onClick={g.refresh} disabled={g.loading} aria-label="Check Google's suggestions again" title="Check again">
          {g.loading ? <span className="spinner" /> : <Ic icon={RefreshCw} size={14} />}
        </button>
      </header>
      {"error" in advice ? (
        <GoogleError sentence={advice.error} what={`Couldn't read Google's suggestions for ${v.cluster.name}.`} />
      ) : items.length ? (
        <ul className="ov-list gs-list">
          {items.map((a) => <Suggestion key={a.id} a={a} now={now} open={open === a.id} onToggle={() => setOpen((o) => (o === a.id ? undefined : a.id))} />)}
        </ul>
      ) : (
        <div className="ov-empty"><Ic icon={CircleCheck} size={20} /><span>Google has no suggestions for this cluster.</span></div>
      )}
    </section>
  );
}

/** One quiet line under Nodes for a GKE-looking cluster whose project isn't chosen. */
export function GoogleHint({ g, onOpenGcp }: { g: GoogleView; onOpenGcp: () => void }) {
  const v = g.view;
  if (!v || v.gke || !v.hint) return null;
  return (
    <p className="gs-hint" role="note">
      <Ic icon={Cloud} size={13} />
      <span>{v.hint}</span>
      <button className="link-btn small" onClick={onOpenGcp}>Open Google Cloud</button>
    </p>
  );
}

function Suggestion({ a, now, open, onToggle }: { a: GkeAdvice; now: number; open: boolean; onToggle: () => void }) {
  const b = SEVERITY_BADGE[a.severity];
  return (
    <li className={`gs-item${open ? " open" : ""}`}>
      <div className="ov-row gs-row" role="button" tabIndex={0} aria-expanded={open} aria-label={`${b.word}: ${a.description}`}
        onClick={onToggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), onToggle())}>
        <span className={`badge ${b.tone}`}><Ic icon={TONE_ICON[b.tone]} size={13} />{b.word}</span>
        <div className="ov-main">
          <div className="gs-desc">{a.description || a.subtype}</div>
          <div className="gs-meta">{adviceMeta(a, now)}</div>
        </div>
        <Ic icon={open ? ChevronDown : ChevronRight} size={14} className="chev" />
      </div>
      {open ? (
        <div className="gs-detail">
          <h4>What Google recommends</h4>
          <p>{a.action ?? "Google gave no recommendation with this suggestion."}{a.priority ? <span className="gs-priority"> · priority {a.priority}</span> : null}</p>
          {a.apis?.length ? <Apis apis={a.apis} /> : null}
          <p className="gs-source">From Google's GKE recommender. Landlens doesn't mark it done or dismissed.</p>
        </div>
      ) : null}
    </li>
  );
}

function Apis({ apis }: { apis: NonNullable<GkeAdvice["apis"]> }) {
  return (
    <table className="gs-apis">
      <thead><tr><th>API</th><th>Stops being served in</th><th>Callers in the last 30 days</th></tr></thead>
      <tbody>
        {apis.map((x, i) => (
          <tr key={i}>
            <td className="mono gs-api">{x.api}</td>
            <td>{x.stops ?? "—"}</td>
            <td>
              {x.clients.length ? (
                <ul className="gs-callers">
                  {x.clients.map((c, j) => (
                    <li key={j}>
                      <span className="mono gs-agent">{c.agent}</span>
                      <span className="dim">{c.requests !== undefined ? ` · ${c.requests.toLocaleString()} requests` : ""}{c.last ? ` · last ${c.last.slice(0, 10)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : <span className="dim">none named</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A fixed sentence from main, with its command as code and Copy when it is one to run. */
function GoogleError({ sentence, what }: { sentence: string; what: string }) {
  const cmd = copyableCommand(sentence);
  const [done, setDone] = useState(false);
  return (
    <div className="notice gs-notice" role="alert">
      <Ic icon={CircleX} size={15} className="tone-bad" />
      <div className="notice-body">
        <strong>{what}</strong>
        <p>{sentenceParts(sentence).map((p, i) => (p.code ? <code key={i} className="mono">{p.text}</code> : <span key={i}>{p.text}</span>))}</p>
        {cmd ? (
          <button className="secondary" onClick={() => void copyText(cmd).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}>
            <Ic icon={Copy} size={13} />{done ? "Copied" : "Copy command"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
