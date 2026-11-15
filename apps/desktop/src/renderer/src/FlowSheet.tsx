// Run a Landflow flow on an object (wave 7 part 4, D125; docs/family.md#landflow-on-a-resource): the flows tagged
// `landlens` in the connected Landflow, the input main will send (names, the problem it came from, the object's YAML
// only when ticked), and the run followed to its last node's output, shown as data. The window holds only the sheet's
// id, the digest of the input it shows and the flow's id: main built the input and sends that input only (review of
// part 4, H1), to a flow Landflow still lists as this sheet showed it (M2: each row says whose flow it is). Enter never
// runs; Run is a click.
import { LANDFLOW_NOTES, type FlowPreview, type LandflowFlow, type LandflowRun, type ResourceRef } from "@landlens/contracts";
import { CircleX, Sparkles, SquareArrowOutUpRight, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AskContext } from "./AgentDock";
import { api, type ApiError } from "./api";
import { Ic, SiblingMark } from "./icons";
import { openInLandflow, useFollow } from "./landflow";
import { RunNote, sheetKeys } from "./TriageSheet";

export type FlowSubject = { ref: ResourceRef; kind: string; problem?: string };

export function FlowSheet({ handle, namespace, subject, onAsk, onClose }: {
  handle: string;
  namespace?: string;
  subject: FlowSubject;
  onAsk: (c: AskContext) => void;
  onClose: () => void;
}) {
  const [flows, setFlows] = useState<LandflowFlow[]>();
  const [flow, setFlow] = useState<string>();
  const [yaml, setYaml] = useState(false);
  const [preview, setPreview] = useState<FlowPreview>();
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<LandflowRun>();
  const sheet = useRef<string | undefined>(undefined);
  const follow = useFollow(started);
  const { ref } = subject;

  const list = () =>
    api.invoke("landflow:flows", {}).then(
      (r) => (setFlows(r.flows), setFlow((cur) => r.flows.find((f) => f.runnable && f.id === cur)?.id ?? r.flows.find((f) => f.runnable)?.id)),
      (e: ApiError) => (setFlows([]), setError(e.message)),
    );
  useEffect(() => void list(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The input, built again by main under the same sheet whenever the YAML box changes.
  useEffect(() => {
    let live = true;
    setReading(true);
    api.invoke("landflow:input", { handle, ref, ...(namespace ? { namespace } : {}), ...(subject.problem ? { problem: subject.problem } : {}), yaml, ...(sheet.current ? { sheet: sheet.current } : {}) }).then(
      (p) => {
        if (!live) return;
        sheet.current = p.sheet;
        setPreview(p);
        setReading(false);
      },
      (e: ApiError) => live && (setPreview(undefined), setError(e.message), setReading(false)),
    );
    return () => void (live = false);
  }, [handle, namespace, yaml]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = () => {
    if (!preview || !flow || starting || reading) return;
    setStarting(true);
    setError(undefined);
    api.invoke("landflow:run", { sheet: preview.sheet, flow, digest: preview.digest }).then(setStarted, (e: ApiError) => {
      setError(e.message);
      setStarting(false);
      // Changed in Landflow since it was listed: the list is read again, to be looked at before Run.
      if (e.message === LANDFLOW_NOTES.flowChanged) void list();
    });
  };
  const r = follow.run;
  const chosen = flows?.find((f) => f.id === flow);
  const name = `${subject.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog lf-sheet" role="dialog" aria-modal="true" aria-labelledby="lf-flow-title" onKeyDown={sheetKeys(onClose)}>
        <header className="dialog-head">
          <span className="lf-mark"><SiblingMark sibling="landflow" size={15} /></span>
          <h2 id="lf-flow-title" className="grow">Run a Landflow flow</h2>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body lf-body">
          <div className="lf-title"><Ic icon={Workflow} size={14} className="dim" /><strong className="mono">{name}</strong></div>
          {r ? null : (
            <>
              <div className="lf-field">
                <span className="lf-label" id="lf-flow">Flow</span>
                {!flows ? <p className="small dim">Reading the flows tagged landlens…</p>
                  : !flows.length ? <p className="small dim">{error ? "" : "No flow in Landflow has the tag landlens. Tag one to run it here."}</p>
                  : (
                    <div className="lf-flows" role="radiogroup" aria-labelledby="lf-flow">
                      {flows.map((f) => (
                        <button key={f.id} role="radio" aria-checked={flow === f.id} disabled={!f.runnable} className={"lf-flow" + (flow === f.id ? " on" : "")} onClick={() => f.runnable && setFlow(f.id)}>
                          <span className="lf-flow-name">{f.name}</span>
                          {f.description ? <span className="small dim">{f.description}</span> : null}
                          <span className={"small lf-owner" + (f.shared ? " tone-warn" : " dim")}>{f.shared ? `Shared from ${f.owner ? `the project ${f.owner}` : "another project"}` : `In ${f.owner ? `the project ${f.owner}` : "your project"}`}</span>
                          {f.runnable ? null : <span className="small dim">Its id can't be run from Landlens.</span>}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
              <div className="lf-field">
                <span className="lf-label">Input, as it will be sent</span>
                <pre className="lf-well" tabIndex={0} aria-label="Input as it will be sent">{preview ? JSON.stringify(preview.input, null, 2) : "…"}</pre>
                {preview?.yaml?.note ? <p className="small dim">{preview.yaml.note}</p> : null}
              </div>
              {ref.resource === "secrets" && ref.group === "" ? null : (
                <label className="check-box">
                  <input type="checkbox" checked={yaml} onChange={(e) => setYaml(e.target.checked)} />
                  Include the object's YAML
                </label>
              )}
              <p className="small lf-line">A manual run of the saved workflow, as the key's user.</p>
              {preview && flow ? <p className="small dim mono lf-room" title="Where it goes">{preview.to.replace("<flow>", flow)}</p> : null}
            </>
          )}
          {r ? <RunNote r={r} paused={follow.paused} onAgain={follow.checkAgain} /> : null}
          {r?.output ? (
            <div className="lf-field">
              <span className="lf-label">From Landflow: data</span>
              <pre className="lf-well" tabIndex={0} aria-label="The run's output">{r.output}</pre>
            </div>
          ) : null}
          {error ? <p className="lf-error" role="alert"><Ic icon={CircleX} size={13} className="tone-bad" />{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          {r ? (
            <>
              {r.output && chosen ? (
                <button className="ask-btn" onClick={() => (onAsk({ label: `Landflow: ${chosen.name}`, text: r.output!, source: chosen.id, kind: "landflow" }), onClose())}>
                  <Ic icon={Sparkles} size={14} />Ask Claude about this output
                </button>
              ) : null}
              {r.run && r.runLink ? <button className="secondary" onClick={() => void openInLandflow(r.run!, "run")}><Ic icon={SquareArrowOutUpRight} size={13} />Open the run in Landflow</button> : null}
              <span className="grow" />
              <button className="secondary" onClick={onClose}>Done</button>
            </>
          ) : (
            <>
              <span className="grow" />
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!preview || !flow || starting || reading} onClick={run}>{starting ? "Starting…" : "Run"}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
