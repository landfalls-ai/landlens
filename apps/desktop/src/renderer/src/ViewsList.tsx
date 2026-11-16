// The saved views (wave 10 part 4, D216, D217): this cluster's own and every "Any cluster" view, newest first, with
// Open, Rename, Duplicate, Export and Delete, and Import. Names only come here: main keeps the documents. Export and
// Import go through main's own dialogs (the window never names a path); an imported view is saved for Any cluster,
// reading the namespaces chosen here (none: every namespace the person may read).
import type { ApiError } from "./api";
import type { SavedViewSummary } from "@landlens/contracts";
import { Copy, Download, FileUp, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import { Ic } from "./icons";
import { refreshSaved, useSavedViews, viewStore } from "./viewStore";

export function ViewsList(props: { handle: string; context: string; namespaces: string[]; onClose?: () => void; compact?: boolean }) {
  const views = useSavedViews(props.handle);
  const [menu, setMenu] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [deleting, setDeleting] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [pick, setPick] = useState<string[]>([]);
  const [note, setNote] = useState<{ tone: "bad" | "ok"; text: string; issues?: string[] }>();
  const done = () => void refreshSaved(props.handle);
  const fail = (e: ApiError) => setNote({ tone: "bad", text: e.message });
  const open = (id: string) => (props.onClose?.(), viewStore.showList(false), void viewStore.open(props.handle, id));
  const doImport = () => {
    setNote(undefined);
    api.invoke("views:import", { handle: props.handle, ...(pick.length ? { namespaces: pick } : {}) }).then((r) => {
      if (r.issues) return setNote({ tone: "bad", text: "That file can't be imported:", issues: r.issues });
      if (!r.saved) return;
      setImporting(false);
      done();
      open(r.saved.id);
    }, fail);
  };
  return (
    <section className={"views-list" + (props.compact ? " compact" : "")} aria-label="Saved views">
      <header className="views-list-head">
        <h3 className="grow">Saved views</h3>
        <button className="secondary small" aria-expanded={importing} onClick={() => setImporting((i) => !i)}><Ic icon={FileUp} size={13} />Import…</button>
        {props.onClose ? <button className="icon-btn sm" aria-label="Close the list" onClick={props.onClose}><Ic icon={X} size={14} /></button> : null}
      </header>
      {importing ? (
        <div className="views-import" role="group" aria-label="Import a view">
          <p className="small">A view file is someone's document: its tables and charts draw at once, reading only what you may read here; its custom blocks wait until you say they may run.</p>
          <label className="small dim" htmlFor="views-import-ns">Reads (none chosen: every namespace you may read)</label>
          <select id="views-import-ns" multiple size={Math.min(6, Math.max(2, props.namespaces.length))} value={pick}
            onChange={(e) => setPick([...e.target.selectedOptions].map((o) => o.value).slice(0, 20))}>
            {props.namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div className="views-import-go">
            <button className="primary small" onClick={doImport}>Choose a file…</button>
            <button className="link-btn small" onClick={() => setImporting(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {note ? (
        <div className={`small tone-${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>
          {note.text}
          {note.issues ? <ul className="mono small">{note.issues.map((i, k) => <li key={k}>{i}</li>)}</ul> : null}
        </div>
      ) : null}
      {!views.length ? <p className="small dim">None yet. Save a view (⌘S) to keep it here and in the sidebar.</p> : null}
      <ul className="views-saved">
        {views.map((v) => (
          <li key={v.id} className="views-saved-row">
            {renaming?.id === v.id ? (
              <form className="grow views-rename" onSubmit={(e) => {
                e.preventDefault();
                api.invoke("views:rename", { saved: v.id, name: renaming.name.trim() }).then(() => (setRenaming(undefined), done()), fail);
              }}>
                <input aria-label={`New name for ${v.name}`} autoFocus value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(undefined))} />
                <button className="secondary small" type="submit" disabled={!renaming.name.trim()}>Rename</button>
              </form>
            ) : (
              <button className="views-saved-open grow" onClick={() => open(v.id)}>
                <span className="name">{v.name}</span>
                <span className="dim small">{v.scope === "any" ? "Any cluster" : "This cluster"}{v.origin === "imported" ? " · from a file" : ""}{v.apps && !v.appsTrusted ? ` · ${v.apps} custom ${v.apps === 1 ? "block" : "blocks"} waiting` : ""}</span>
              </button>
            )}
            {deleting === v.id ? (
              <span className="views-confirm small">
                Delete “{v.name}”?
                <button className="danger small" onClick={() => api.invoke("views:remove", { saved: v.id }).then(() => (setDeleting(undefined), done()), fail)}>Delete</button>
                <button className="link-btn small" onClick={() => setDeleting(undefined)}>Keep</button>
              </span>
            ) : (
              <div className="menu-wrap">
                <button className="icon-btn sm" aria-label={`More for ${v.name}`} aria-haspopup="menu" aria-expanded={menu === v.id} onClick={() => setMenu((m) => (m === v.id ? undefined : v.id))}><Ic icon={MoreHorizontal} size={14} /></button>
                {menu === v.id ? (
                  <div className="menu" role="menu" onMouseLeave={() => setMenu(undefined)}>
                    <button role="menuitem" onClick={() => (setMenu(undefined), setRenaming({ id: v.id, name: v.name }))}><Ic icon={Pencil} size={13} />Rename</button>
                    <button role="menuitem" onClick={() => (setMenu(undefined), void api.invoke("views:duplicate", { saved: v.id }).then(done, fail))}><Ic icon={Copy} size={13} />Duplicate</button>
                    <button role="menuitem" onClick={() => (setMenu(undefined), void api.invoke("views:export", { saved: v.id }).then((r) => r.written && setNote({ tone: "ok", text: `Exported “${v.name}”.` }), fail))}><Ic icon={Download} size={13} />Export…</button>
                    <button role="menuitem" className="danger" onClick={() => (setMenu(undefined), setDeleting(v.id))}><Ic icon={Trash2} size={13} />Delete</button>
                  </div>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
