// Create from YAML (D32): the wide sheet with an empty editor, a template, and the toolbar's namespace filled in.
// Several documents are allowed. Review dry-runs each one; Apply sends exactly what the review checked, as you; then
// the first object opens in the drawer.
import type { ClusterInfo, EditProblem, EditReview } from "@landlens/contracts";
import { CircleX, FilePlus2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AskContext } from "./AgentDock";
import { api, type ApiError } from "./api";
import { CodeEditor, type CodeEditorHandle, type LineMark } from "./CodeEditor";
import { Ic, MOD } from "./icons";
import { ReviewCard } from "./YamlEdit";

const TEMPLATES: Record<string, (ns: string) => string> = {
  Blank: () => "",
  Deployment: (ns) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
  Service: (ns) => `apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: ${ns}
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`,
  ConfigMap: (ns) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: ${ns}
data:
  key: value
`,
  Job: (ns) => `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: ${ns}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo hello"]
`,
};

type Stage =
  | { s: "edit"; problems?: EditProblem[] }
  | { s: "reviewing" }
  | { s: "review"; review: EditReview }
  | { s: "applying"; review: EditReview };

export function CreateSheet(props: {
  cluster: ClusterInfo;
  /** The toolbar's namespace ("" for all), filled into templates and used where a document names none. */
  namespace: string;
  onAsk: (c: AskContext) => void;
  onClose: () => void;
  /** Created: open the first object. */
  onCreated: (first: { kind: string; name: string; namespace?: string }, summary: string) => void;
}) {
  const ns = props.namespace || "default";
  const [template, setTemplate] = useState("Blank");
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>({ s: "edit" });
  const [asking, setAsking] = useState(false);
  const editor = useRef<CodeEditorHandle>(null);
  const applyBtn = useRef<HTMLButtonElement>(null);
  const touched = text.trim() !== "" && text !== TEMPLATES[template]!(ns);

  useEffect(() => {
    setTimeout(() => editor.current?.focus(), 0);
  }, []);

  const pickTemplate = (t: string) => {
    setTemplate(t);
    setText(TEMPLATES[t]!(ns));
    setStage({ s: "edit" });
    setTimeout(() => editor.current?.focus(), 0);
  };

  const review = async () => {
    if (!text.trim() || stage.s !== "edit") return;
    setStage({ s: "reviewing" });
    try {
      const r = await api.invoke("edit:create", { handle: props.cluster.handle, ...(props.namespace ? { namespace: props.namespace } : {}), yaml: text });
      if (r.id && r.operations) {
        setStage({ s: "review", review: r });
        // The sheet is modal, but the focus still moves only if it was in the sheet.
        if (document.activeElement?.closest(".create-sheet")) setTimeout(() => applyBtn.current?.focus(), 0);
      } else setStage({ s: "edit", problems: r.problems ?? [] });
    } catch (e) {
      setStage({ s: "edit", problems: [{ message: (e as ApiError).message }] });
    }
  };

  const apply = async () => {
    if (stage.s !== "review" || !stage.review.id) return;
    const r = stage.review;
    setStage({ s: "applying", review: r });
    try {
      await api.invoke("edit:apply", { handle: props.cluster.handle, id: r.id! });
      const ops = r.operations ?? [];
      const first = ops[0]!;
      const what = (o: typeof first) => `${o.kind.toLowerCase()} ${o.namespace ? `${o.namespace}/` : ""}${o.name}`;
      props.onCreated(
        { kind: first.kind, name: first.name, ...(first.namespace ? { namespace: first.namespace } : {}) },
        ops.length === 1 ? `Created · ${what(first)}` : `Created ${ops.length} objects · ${ops.map(what).join(", ")}`,
      );
    } catch (e) {
      // Apply runs the documents in order; one that fails leaves the ones before it created, and says so.
      setStage({ s: "edit", problems: [{ message: (e as ApiError).message }] });
    }
  };

  const back = () => {
    if (stage.s === "review" && stage.review.id) void api.invoke("edit:discard", { id: stage.review.id }).catch(() => {});
    setStage({ s: "edit" });
    setTimeout(() => editor.current?.focus(), 0);
  };

  const close = () => {
    if (stage.s === "review" && stage.review.id) void api.invoke("edit:discard", { id: stage.review.id }).catch(() => {});
    props.onClose();
  };
  const leave = () => (touched && (stage.s === "edit" || stage.s === "reviewing") ? setAsking(true) : close());

  const problems = stage.s === "edit" ? stage.problems ?? [] : [];
  const marks: LineMark[] = useMemo(() => problems.filter((p) => p.line).map((p) => ({ line: p.line!, kind: "bad" as const, message: p.message })), [problems]);
  const pathless = problems.filter((p) => !p.line);
  const count = stage.s === "review" || stage.s === "applying" ? stage.review.operations?.length ?? 0 : 0;

  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && leave()}>
      <div className="create-sheet" role="dialog" aria-modal="true" aria-label="Create from YAML"
        onKeyDown={(e) => {
          // Esc from the editor too (it leaves Esc to us): ask, or stop asking.
          if (e.key === "Escape" && stage.s !== "review" && stage.s !== "applying") (e.preventDefault(), e.stopPropagation(), asking ? setAsking(false) : leave());
        }}>
        <header className="row">
          <Ic icon={FilePlus2} size={15} />
          <h2>Create from YAML</h2>
          <span className="grow" />
          {stage.s === "edit" || stage.s === "reviewing" ? (
            <label className="field select small">
              <span className="sr-only">Template</span>
              <select value={template} onChange={(e) => pickTemplate(e.target.value)} aria-label="Template">
                {Object.keys(TEMPLATES).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          ) : null}
          <button className="icon-btn" aria-label="Close" onClick={leave}><Ic icon={X} size={14} /></button>
        </header>
        {stage.s === "review" || stage.s === "applying" ? (
          <div>
            <ReviewCard
              title={count === 1 ? `Create ${stage.review.operations![0]!.kind.toLowerCase()} ${stage.review.operations![0]!.name}` : `Create ${count} objects`}
              review={stage.review}
              applying={stage.s === "applying"}
              applyRef={applyBtn}
              onApply={apply}
              onBack={back}
              {...(stage.review.agent ? {
                onAsk: () => props.onAsk({ label: `New objects · ${count}`, text: `What I am about to create on ${props.cluster.context}, as the cluster's dry run returned it:\n${stage.review.agent}`, source: "the cluster's dry run of my new objects, scrubbed as your reads are", kind: "edit" }),
              } : {})}
            />
          </div>
        ) : (
          <>
            <div className="yaml-edit">
              <div className="yaml-bar">
                <span>Namespace where a document names none: <b className="mono">{props.namespace || "the document's own"}</b>. Up to 10 documents, split with <code>---</code>.</span>
              </div>
              <div className="cm">
                <CodeEditor ref={editor} label="YAML to create" value={text} onChange={setText} marks={marks} onSubmit={review} />
              </div>
            </div>
            <div className="edit-foot">
              {problems.length ? (
                <div className="change-fact bad" role="alert">
                  <Ic icon={CircleX} size={12} />
                  {problems.some((p) => p.line)
                    ? `Not created: ${problems.length} problem${problems.length === 1 ? "" : "s"}, on line ${problems.filter((p) => p.line).map((p) => p.line).join(", ")}. Nothing has changed.`
                    : `Not created: ${pathless.map((p) => p.message).join("; ")}`}
                </div>
              ) : null}
              {problems.some((p) => p.line) && pathless.length ? <div className="change-fact bad">{pathless.map((p) => p.message).join("; ")}</div> : null}
              {asking ? (
                <div className="change-actions">
                  <span className="change-fact warn"><Ic icon={TriangleAlert} size={12} />Discard this YAML?</span>
                  <button className="danger" autoFocus onClick={close}>Discard</button>
                  <button className="secondary" onClick={() => (setAsking(false), editor.current?.focus())}>Keep editing</button>
                </div>
              ) : (
                <div className="change-actions">
                  <span className="change-fact">Nothing is sent until you review.</span>
                  <button className="primary" disabled={!text.trim() || stage.s === "reviewing"} onClick={review}>
                    {stage.s === "reviewing" ? <><span className="spinner" />Checking…</> : <>Review<kbd aria-hidden="true">{MOD}⏎</kbd></>}
                  </button>
                  <button className="secondary" onClick={leave}>Cancel</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
