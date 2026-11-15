// ⌘K: jump to a kind, or to an object in the list on screen. Type to filter, ↑/↓ to move, Enter to go, Esc to close.
import type { KubeObject } from "@landlens/contracts";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Ic, kindIcon } from "./icons";
import type { NavItem } from "./kinds";
import type { Current } from "./Sidebar";

type Entry = { key: string; label: string; hint: string; resource: string; go: () => void };

export function JumpPalette(props: {
  nav: NavItem[];
  current?: Current;
  items: KubeObject[];
  onPick: (c: Current) => void;
  onSelect: (o: KubeObject) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const entries = useMemo(() => {
    const f = q.trim().toLowerCase();
    const kinds: Entry[] = [
      { key: "overview", label: "Overview", hint: "Page", resource: "overview", go: () => props.onPick("overview") },
      { key: "helm", label: "Helm releases", hint: "Page", resource: "helm", go: () => props.onPick("helm") },
      ...props.nav.map((n) => ({ key: `k:${n.type.group}/${n.type.resource}`, label: n.label, hint: n.section === "core" ? "Kind" : n.section, resource: n.type.resource, go: () => props.onPick(n) })),
    ].filter((e) => !f || e.label.toLowerCase().includes(f));
    const cur = typeof props.current === "object" ? props.current : undefined;
    const objects: Entry[] = !f || !cur ? [] : props.items
      .filter((o) => o.metadata.name.toLowerCase().includes(f))
      .slice(0, 40)
      .map((o) => ({ key: `o:${o.metadata.uid}`, label: o.metadata.name, hint: `${cur.type.kind}${o.metadata.namespace ? ` · ${o.metadata.namespace}` : ""}`, resource: cur.type.resource, go: () => props.onSelect(o) }));
    return [...kinds.slice(0, f ? 12 : 40), ...objects];
  }, [q, props.nav, props.items, props.current]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setAt(0), [q]);
  const go = (e?: Entry) => {
    if (!e) return;
    props.onClose();
    e.go();
  };

  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-label="Jump to">
        <label className="palette-input">
          <Ic icon={Search} size={15} />
          <input
            ref={input}
            value={q}
            placeholder="Jump to a kind or an object…"
            aria-label="Jump to"
            role="combobox"
            aria-expanded="true"
            aria-controls="jump-list"
            aria-activedescendant={entries[at] ? `jump-${at}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setAt((i) => Math.min(entries.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter") (e.preventDefault(), go(entries[at]));
              else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), props.onClose());
            }}
          />
          <kbd aria-hidden="true">esc</kbd>
        </label>
        <ul id="jump-list" role="listbox">
          {entries.length ? entries.map((e, i) => (
            <li key={e.key} id={`jump-${i}`} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onMouseEnter={() => setAt(i)} onClick={() => go(e)}>
              <Ic icon={kindIcon(e.resource)} size={14} />
              <span className="p-name">{e.label}</span>
              <span className="p-kind">{e.hint}</span>
              {i === at ? <Ic icon={CornerDownLeft} size={12} /> : null}
            </li>
          )) : <li className="p-empty">Nothing matches “{q}”</li>}
        </ul>
      </div>
    </div>
  );
}
