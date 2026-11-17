// Save a view (wave 10 part 4, D216): a name and This cluster (the default) or Any cluster. Any cluster is refused, with
// its reason, while a source names a literal namespace or object; "Make the namespace a choice" asks Claude to change
// that (one prompt), never an edit by Landlens. The name is the person's and never goes to Claude. Main checks it all
// again: this sheet only says why before it asks.
import type { ViewState } from "@landlens/contracts";
import { literalWords } from "@landlens/views/literal";
import { Bookmark, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiError } from "./api";
import { api } from "./api";
import { Ic } from "./icons";
import { sheetKeys } from "./TriageSheet";

/** The ask "Make the namespace a choice" sends (D216). */
export const NAMESPACE_CHOICE =
  "Replace the literal namespaces and object names in this view's sources with a `namespace` param (a choice on the page), so it can be saved for any cluster.";

export function SaveViewSheet(props: { state: ViewState; onClose: () => void; onSaved: () => void; onChoice: () => void }) {
  const st = props.state;
  const [name, setName] = useState(st.saved?.name ?? st.title.slice(0, 60));
  const [scope, setScope] = useState<"cluster" | "any">("cluster");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.select(), []);
  // Main's own rule, from the one place it is written (security review of wave 10 part 4, L1).
  const literal = literalWords(st.document as never);
  const anyRefused = scope === "any" && literal.length > 0;
  const ok = name.trim().length > 0 && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name) && !anyRefused;
  const save = () => {
    if (!ok || saving) return;
    setSaving(true);
    setError(undefined);
    api.invoke("views:save", { view: st.id, name: name.trim(), scope }).then(
      () => (props.onSaved(), props.onClose()),
      (e: ApiError) => (setError(e.message), setSaving(false)),
    );
  };
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog save-view" role="dialog" aria-modal="true" aria-labelledby="save-view-title"
        onKeyDown={(e) => (e.key === "Enter" && !(e.target as HTMLElement).closest("button") ? (e.preventDefault(), save()) : sheetKeys(props.onClose)(e))}>
        <header className="dialog-head">
          <Ic icon={Bookmark} size={15} />
          <h2 id="save-view-title" className="grow">Save this view</h2>
          <button className="icon-btn sm" aria-label="Close" onClick={props.onClose}><Ic icon={X} size={14} /></button>
        </header>
        <div className="dialog-body save-view-body">
          <label className="lf-field">
            <span className="lf-label">Name</span>
            <input ref={field} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-describedby="save-view-name-note" />
            <span id="save-view-name-note" className="small dim">Yours: it stays on this machine and never goes to Claude.</span>
          </label>
          <div className="lf-field">
            <span className="lf-label" id="save-view-scope">Opens on</span>
            <div className="seg" role="radiogroup" aria-labelledby="save-view-scope">
              <button role="radio" aria-checked={scope === "cluster"} className={scope === "cluster" ? "on" : ""} onClick={() => setScope("cluster")}>This cluster</button>
              <button role="radio" aria-checked={scope === "any"} className={scope === "any" ? "on" : ""} onClick={() => setScope("any")}>Any cluster</button>
            </div>
            <p className="small dim">
              {scope === "cluster"
                ? `Only on ${st.context}, at the same API server${st.namespaces ? `, reading ${st.namespaces.join(", ")}` : ""}.`
                : "On every cluster you connect, reading what you may read there."}
            </p>
            {anyRefused ? (
              <div className="notice warn small" role="note">
                <span>This view names {literal.slice(0, 3).join(", ")}{literal.length > 3 ? ` and ${literal.length - 3} more` : ""}, which another cluster may not have.</span>
                <button className="link-btn" onClick={() => (props.onChoice(), props.onClose())}>Make the namespace a choice</button>
              </div>
            ) : null}
          </div>
          {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          <button className="secondary" onClick={props.onClose}>Cancel</button>
          <button className="primary" disabled={!ok || saving} onClick={save}>{st.saved ? "Save again" : "Save"}</button>
        </footer>
      </div>
    </div>
  );
}
