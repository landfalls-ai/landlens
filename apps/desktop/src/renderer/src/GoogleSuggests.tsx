// "Google suggests" on the Overview (wave 9, D178): GKE's diagnosis recommender for this cluster, as main read it.
// Google's sentences are React text: no Markdown, and nothing in them becomes a link. A row opens in place (no drawer)
// with what Google recommends and, for an API deprecation, who still calls the API. Landlens never marks a suggestion
// done or dismissed. Ask (on the row) and Ask Claude (in the opened row) quote main's brief of it as data (D189).
import type { GkeAdvice } from "@landlens/contracts";
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, Cloud, Copy, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { Ic, type LucideIcon } from "./icons";
import { copyText } from "./present";
import { adviceCount, adviceLine, adviceMeta, copyableCommand, sentenceParts, SEVERITY_BADGE } from "./googleRules";
import type { GoogleView } from "./googleView";

const TONE_ICON: Record<"bad" | "warn" | "muted", LucideIcon> = { bad: CircleX, warn: Clock, muted: CircleDashed };

/** The panel, for a GKE cluster of a chosen project; nothing otherwise. */
export function GoogleSuggests({ g, now, onAsk }: { g: GoogleView; now: number; onAsk?: (a: GkeAdvice) => void }) {
  const [open, setOpen] = useState<string>();
  const v = g.view;
  if (!v || !v.gke) return null;
  const advice = v.advice;
  const items = "error" in advice ? [] : advice.items;
  const cut = "error" in advice ? false : advice.cut;
  // Never the all-clear when Google's list was cut (review of part 1, M2).
  const line = "error" in advice ? undefined : adviceLine(items.length, cut, v.cluster);
  const count = "error" in advice ? undefined : adviceCount(items.length, cut);
  return (
    <section className="panel gs" aria-label="Google suggests">
      <header className="panel-head">
        <Ic icon={Cloud} size={15} className="gs-cloud" />
        <h3>Google suggests</h3>
        {count === undefined ? null : <span className="count-badge">{count}</span>}
        <span className="gs-where">GKE · {v.cluster.project} · {v.cluster.location}</span>
        <span className="grow" />
        <button className="icon-btn" onClick={g.refresh} disabled={g.loading} aria-label="Check Google's suggestions again" title="Check again">
          {g.loading ? <span className="spinner" /> : <Ic icon={RefreshCw} size={14} />}
        </button>
      </header>
      {"error" in advice ? (
        <GoogleError sentence={advice.error} what={`Couldn't read Google's suggestions for ${v.cluster.name}.`} />
      ) : (
        <>
          {items.length ? (
            <ul className="ov-list gs-list">
              {items.map((a) => <Suggestion key={a.id} a={a} now={now} open={open === a.id} onToggle={() => setOpen((o) => (o === a.id ? undefined : a.id))} {...(onAsk ? { onAsk } : {})} />)}
            </ul>
          ) : null}
          {line?.allClear ? <div className="ov-empty"><Ic icon={CircleCheck} size={20} /><span>{line.text}</span></div> : null}
          {line && !line.allClear ? <p className="gs-cut" role="note"><Ic icon={CircleAlert} size={14} className="tone-warn" /><span>{line.text}</span></p> : null}
        </>
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

function Suggestion({ a, now, open, onToggle, onAsk }: { a: GkeAdvice; now: number; open: boolean; onToggle: () => void; onAsk?: (a: GkeAdvice) => void }) {
  const b = SEVERITY_BADGE[a.severity];
  return (
    <li className={`gs-item${open ? " open" : ""}`}>
      <div className="ov-row gs-row" role="button" tabIndex={0} aria-expanded={open} aria-label={`${b.word}: ${a.description}`}
        onClick={onToggle} onKeyDown={(e) => {
          if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "Enter" || e.key === " ") (e.preventDefault(), onToggle());
          else if (e.key === "a" && onAsk) (e.preventDefault(), onAsk(a));
        }}>
        <span className={`badge ${b.tone}`}><Ic icon={TONE_ICON[b.tone]} size={13} />{b.word}</span>
        <div className="ov-main">
          <div className="gs-desc">{a.description || a.subtype}</div>
          <div className="gs-meta">{adviceMeta(a, now)}</div>
        </div>
        {onAsk ? <button className="ghost-btn" tabIndex={-1} onClick={(e) => (e.stopPropagation(), onAsk(a))} aria-label={`Ask Claude about ${a.subtype}`} title="Ask Claude (a)"><Ic icon={Sparkles} size={13} />Ask</button> : null}
        <Ic icon={open ? ChevronDown : ChevronRight} size={14} className="chev" />
      </div>
      {open ? (
        <div className="gs-detail">
          <h4>What Google recommends</h4>
          <p>{a.action ?? "Google gave no recommendation with this suggestion."}{a.priority ? <span className="gs-priority"> · priority {a.priority}</span> : null}</p>
          {a.apis?.length ? <Apis apis={a.apis} /> : null}
          <p className="gs-source">From Google's GKE recommender. Landlens doesn't mark it done or dismissed.</p>
          {onAsk ? <button className="ask-btn gs-ask" onClick={() => onAsk(a)}><Ic icon={Sparkles} size={14} />Ask Claude</button> : null}
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
