// "Connect Clickland": the address, a read-only API key and the cluster's name in Clickland's data; Test calls
// /api/health and one query, Save stores them. Opened from the Connections page's Land family card with no cluster,
// it has no cluster name (that is per context) and Test checks the address and key only. The key goes to main once and never comes back: the field starts
// empty, and a stored key shows only as "stored".
import type { ClicklandSettings as View, ClicklandTest } from "@landlens/contracts";
import { CircleCheck, CircleX, PlugZap, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";

export function ClicklandSettings(props: { handle?: string; context?: string; onClose: () => void; onSaved: (v: View) => void }) {
  const [view, setView] = useState<View>();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [cluster, setCluster] = useState(props.context ?? "");
  const [test, setTest] = useState<ClicklandTest | "running">();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.invoke("metrics:settings", props.context ? { context: props.context } : {}).then((v) => {
      setView(v);
      setUrl(v.url);
      setCluster(v.cluster ?? props.context ?? "");
      setTimeout(() => (v.hasKey ? first.current : first.current?.form?.elements.namedItem("key") as HTMLInputElement | null)?.focus(), 0);
    }, (e: ApiError) => setError(e.message));
  }, [props.context]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), props.onClose());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);

  const typed = key.trim();
  const runTest = () => {
    setError(undefined);
    setTest("running");
    api.invoke("metrics:test", { ...(props.handle ? { handle: props.handle } : {}), url: url.trim(), ...(typed ? { key: typed } : {}), ...(props.context && cluster.trim() ? { cluster: cluster.trim() } : {}) }).then(setTest, (e: ApiError) => (setTest(undefined), setError(e.message)));
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    api.invoke("metrics:configure", { url: url.trim(), ...(typed ? { key: typed } : {}), ...(props.context ? { cluster: { context: props.context, name: cluster.trim() || props.context } } : {}) }).then(
      (v) => (setKey(""), props.onSaved(v), props.onClose()),
      (e: ApiError) => (setBusy(false), setError(e.message)),
    );
  };
  const forget = () => api.invoke("metrics:disconnect", {}).then((v) => (setView(v), setTest(undefined), props.onSaved(v)), (e: ApiError) => setError(e.message));

  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="ck-title" onSubmit={save}>
        <header className="dialog-head">
          <span className="kind-tile sm"><Ic icon={PlugZap} size={15} /></span>
          <h2 id="ck-title">Connect Clickland</h2>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}><Ic icon={X} size={15} /></button>
        </header>
        <div className="dialog-body">
          <p className="dim">Clickland keeps the cluster's CPU and memory history (kubelet stats every 30s). Landlens asks it from the main process only; the key is encrypted on this Mac and never shown again.</p>
          <label className="form-row">
            <span>Address</span>
            <span className="field"><input ref={first} name="url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Clickland address" /></span>
          </label>
          <label className="form-row">
            <span>API key</span>
            <span className="field"><input name="key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={view?.hasKey ? "Stored; leave empty to keep it" : "ck_… with the read scope"} autoComplete="off" spellCheck={false} aria-label="Clickland API key" /></span>
          </label>
          {props.context ? <label className="form-row">
            <span>Cluster name</span>
            <span className="field"><input name="cluster" value={cluster} onChange={(e) => setCluster(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Cluster name in Clickland" /></span>
            <small className="dim">Its <span className="mono">k8s.cluster.name</span> in Clickland; for context <span className="mono">{props.context}</span>.</small>
          </label> : null}
          {view && !view.canStore ? <p className="tone-bad small">This machine can't encrypt the key (safeStorage is unavailable), so it can't be stored.</p> : null}
          {test === "running" ? <p className="test-line dim"><span className="spinner" />Testing…</p> : test ? (
            <ul className="test-steps" aria-label="Test result">
              {test.steps.map((s) => (
                <li key={s.name}><Ic icon={s.ok ? CircleCheck : CircleX} size={13} className={s.ok ? "tone-ok" : "tone-bad"} /><b>{s.name}</b><span>{s.detail}</span></li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          {view?.hasKey ? <button type="button" className="link-btn danger" onClick={forget}>Forget the key</button> : null}
          <span className="grow" />
          <button type="button" className="secondary" onClick={runTest} disabled={test === "running" || (!typed && !view?.hasKey)}>Test</button>
          <button type="submit" className="primary" disabled={busy || (!typed && !view?.hasKey) || !view?.canStore}>Save</button>
        </footer>
      </form>
    </div>
  );
}
