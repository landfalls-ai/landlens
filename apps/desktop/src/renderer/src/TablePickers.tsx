// The toolbar's table controls (wave 8 part 3): the namespace popover (D158), the column picker (D157) and the
// selection bar (D156). Popovers sit under their button, fixed and kept inside the window; Esc closes one and gives
// focus back to its button; a click outside closes it.
import { Check, ChevronDown, Columns3, Folder, Minus, RotateCcw, Search, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Ic } from "./icons";
import { MAX_BULK, MAX_NAMESPACES, namespacesLabel } from "./tableState";

function Popover({ anchor, width, label, role, onClose, children }: {
  anchor: RefObject<HTMLButtonElement | null>; width: number; label: string; role: "menu" | "dialog"; onClose: () => void; children: ReactNode;
}) {
  const self = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 6 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!self.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={self} className={`menu table-pop${at ? "" : " measuring"}`} role={role} aria-label={label}
      style={{ width, left: at?.left ?? 0, top: at?.top ?? 0, maxHeight: at ? Math.max(160, window.innerHeight - at.top - 16) : undefined }}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose(), anchor.current?.focus());
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          // Up and down move between the popover's rows (its field and buttons are reached with Tab).
          const rows = [...(self.current?.querySelectorAll<HTMLElement>("[data-row]:not([aria-disabled='true'])") ?? [])];
          if (!rows.length) return;
          e.preventDefault();
          const i = rows.indexOf(document.activeElement as HTMLElement);
          rows[i < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) : (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]!.focus();
        }
        if (e.key === "Home" || e.key === "End") {
          const rows = [...(self.current?.querySelectorAll<HTMLElement>("[data-row]:not([aria-disabled='true'])") ?? [])];
          if (rows.length && (e.target as HTMLElement).tagName !== "INPUT") (e.preventDefault(), (e.key === "Home" ? rows[0] : rows.at(-1))!.focus());
        }
      }}>
      {children}
    </div>
  );
}

/** A row you tick: Space or Enter, never repeated (a held key doesn't run through a list). */
function tickKeys(on: () => void) {
  return (e: React.KeyboardEvent) => {
    if ((e.key === " " || e.key === "Enter") && e.target === e.currentTarget) {
      e.preventDefault();
      if (!e.repeat) on();
    }
  };
}

/**
 * The namespace button and its popover (D158): a filter, All namespaces, a checkbox per namespace with Only on hover,
 * arrow keys and Space. At most 50 chosen. Only and All namespaces choose and close.
 */
export function NamespacePicker({ list, value, onChange }: { list: string[]; value: string[]; onChange: (ns: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const label = namespacesLabel(value);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    // Chosen first, then the rest, each by name; a chosen name the list doesn't have (yet) is kept.
    const all = [...new Set([...value, ...list])];
    return all.filter((n) => !f || n.includes(f)).sort((a, b) => Number(value.includes(b)) - Number(value.includes(a)) || a.localeCompare(b));
  }, [q, list, value]);
  useEffect(() => {
    if (open) (setQ(""), setTimeout(() => field.current?.focus(), 0));
  }, [open]);
  const full = value.length >= MAX_NAMESPACES;
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : full ? value : [...value, n]);
  const close = () => setOpen(false);
  return (
    <>
      <button ref={btn} className="field select ns-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={`Namespaces: ${label}`} title={value.length > 1 ? value.join(", ") : label}
        onClick={() => setOpen((o) => !o)}>
        <Ic icon={Folder} size={13} />
        <span className="ns-label">{label}</span>
        <Ic icon={ChevronDown} size={13} className="chev" />
      </button>
      {open ? (
        <Popover anchor={btn} width={260} label="Namespaces" role="dialog" onClose={close}>
          <label className="field search pop-filter">
            <Ic icon={Search} size={13} />
            <input ref={field} type="search" aria-label="Filter namespaces" placeholder="Filter namespaces" value={q} spellCheck={false}
              onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="pop-list">
            <div className="pop-row" data-row="" role="checkbox" tabIndex={0} aria-checked={!value.length} onClick={() => (onChange([]), close())} onKeyDown={tickKeys(() => (onChange([]), close()))}>
              <span className={`tick${!value.length ? " on" : ""}`} aria-hidden="true">{!value.length ? <Ic icon={Check} size={11} /> : null}</span>
              <span className="grow">All namespaces</span>
            </div>
            <hr />
            {shown.map((n) => {
              const on = value.includes(n);
              const off = !on && full;
              return (
                <div key={n} className="pop-row ns-row" data-row="" role="checkbox" tabIndex={-1} aria-checked={on} aria-label={n} {...(off ? { "aria-disabled": true, title: `At most ${MAX_NAMESPACES} namespaces` } : {})}
                  onClick={(e) => !(e.target as HTMLElement).closest(".only") && toggle(n)} onKeyDown={tickKeys(() => toggle(n))}>
                  <span className={`tick${on ? " on" : ""}`} aria-hidden="true">{on ? <Ic icon={Check} size={11} /> : null}</span>
                  <span className="grow mono">{n}</span>
                  <button className="only link-btn small" tabIndex={-1} aria-label={`Only ${n}`} onClick={() => (onChange([n]), close())}>Only</button>
                </div>
              );
            })}
            {!shown.length ? <div className="pop-empty small dim">No namespace matches “{q.trim()}”</div> : null}
          </div>
          {value.length > 1 ? <div className="pop-foot small dim">{value.length} chosen · lists show their objects together</div> : null}
        </Popover>
      ) : null}
    </>
  );
}

/** The Columns button and its menu (D157): a checkbox per column (Name is fixed), and Reset. */
export function ColumnPicker({ all, hidden, onChange }: { all: { id: string; label: string }[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => document.querySelector<HTMLElement>(".table-pop [data-row]:not([aria-disabled='true'])")?.focus(), 0);
  }, [open]);
  const toggle = (id: string) => onChange(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  return (
    <>
      <button ref={btn} className={`icon-btn${hidden.length ? " on" : ""}`} aria-label={hidden.length ? `Columns (${hidden.length} hidden)` : "Columns"} aria-haspopup="menu" aria-expanded={open}
        title={hidden.length ? `Columns: ${hidden.length} hidden` : "Columns"} onClick={() => setOpen((o) => !o)}>
        <Ic icon={Columns3} size={15} />
      </button>
      {open ? (
        <Popover anchor={btn} width={220} label="Columns" role="menu" onClose={() => setOpen(false)}>
          <div ref={pop} className="menu-label">Columns</div>
          {all.map((c) => {
            const fixed = c.id === "name";
            const on = fixed || !hidden.includes(c.id);
            return (
              <div key={c.id} className="pop-row" data-row="" role="menuitemcheckbox" tabIndex={-1} aria-checked={on} {...(fixed ? { "aria-disabled": true, title: "Name is always shown" } : {})}
                onClick={() => !fixed && toggle(c.id)} onKeyDown={tickKeys(() => !fixed && toggle(c.id))}>
                <span className={`tick${on ? " on" : ""}${fixed ? " fixed" : ""}`} aria-hidden="true">{on ? <Ic icon={Check} size={11} /> : null}</span>
                <span className="grow">{c.label || c.id}</span>
              </div>
            );
          })}
          <hr />
          <div className="pop-row" data-row="" role="menuitem" tabIndex={-1} aria-disabled={!hidden.length} onClick={() => hidden.length && onChange([])} onKeyDown={tickKeys(() => hidden.length && onChange([]))}>
            <Ic icon={RotateCcw} size={13} /><span className="grow">Reset</span>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/**
 * The selection bar (D156): in place of the toolbar's right side while rows are selected. "3 selected", the kind's bulk
 * actions, Ask Claude (never on Secrets), Clear. Past 50, the actions are off: "At most 50 at once".
 */
export function SelectionBar({ count, actions, onAction, onAsk, onClear }: {
  count: number; actions: ("restart" | "delete")[]; onAction: (k: "restart" | "delete") => void; onAsk?: () => void; onClear: () => void;
}) {
  const over = count > MAX_BULK;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection">
      <span className="sel-count" aria-live="polite"><Ic icon={count ? Check : Minus} size={13} />{count} selected</span>
      {over ? <span className="sel-over small" role="note">At most {MAX_BULK} at once</span> : null}
      {actions.includes("restart") ? (
        <button className="secondary sm" aria-label="Restart" disabled={over} title={over ? `At most ${MAX_BULK} at once` : `Restart ${count}`} onClick={() => onAction("restart")}><Ic icon={RotateCcw} size={13} /><span className="sel-word">Restart</span></button>
      ) : null}
      {actions.includes("delete") ? (
        <button className="secondary sm sel-delete" aria-label="Delete…" disabled={over} title={over ? `At most ${MAX_BULK} at once` : `Delete ${count}`} onClick={() => onAction("delete")}><Ic icon={Trash2} size={13} /><span className="sel-word">Delete…</span></button>
      ) : null}
      {onAsk ? <button className="ask-btn sm" aria-label="Ask Claude" title={`Ask Claude about these ${count}`} onClick={onAsk}><Ic icon={Sparkles} size={13} /><span className="sel-word">Ask Claude</span></button> : null}
      <button className="icon-btn sm" aria-label="Clear the selection" title="Clear (Esc)" onClick={onClear}><Ic icon={X} size={14} /></button>
    </div>
  );
}
