// One sidebar: the cluster switcher, the jump row, and the resource nav. Folds to a 52px rail of icons when the
// drawer and the dock both want room (or on ⌘B).
import type { ClusterInfo, KubeContext } from "@landlens/contracts";
import { Check, ChevronDown, ChevronsUpDown, PanelLeft, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Badge } from "./health";
import { Ic, kindIcon, MOD } from "./icons";
import { SECTIONS, type NavItem } from "./kinds";
import { clusterTile } from "./present";

export type Current = NavItem | "overview" | "mcp";

export function Sidebar(props: {
  cluster: ClusterInfo;
  contexts?: KubeContext[];
  nodes?: number;
  sections: (readonly [string, NavItem[]])[];
  current?: Current;
  navError?: string;
  rail: boolean;
  badges: { overview?: Badge; byResource: Record<string, Badge | undefined> };
  onPick: (c: Current) => void;
  onToggle: () => void;
  onSwitch: (context: string) => void;
  onJump: () => void;
}) {
  const { cluster, rail } = props;
  const [menu, setMenu] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set(props.sections.map(([s]) => s).filter((s) => !SECTIONS.includes(s))));
  const wrap = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  const tile = clusterTile(cluster.context);

  // Sections that arrive after discovery start folded unless they are the known ones.
  useEffect(() => {
    setClosed((c) => {
      const next = new Set(c);
      for (const [s] of props.sections) if (!SECTIONS.includes(s) && !seen.current.has(s)) next.add(s);
      for (const [s] of props.sections) seen.current.add(s);
      return next;
    });
  }, [props.sections]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(false);
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [menu]);

  const item = (key: string, label: string, resource: string, on: boolean, badge: Badge | undefined, pick: () => void) => (
    <button
      key={key}
      className={"nav-item" + (on ? " on" : "")}
      aria-label={label}
      aria-current={on ? "page" : undefined}
      title={rail ? label + (badge ? ` · ${badge.n} ${badge.tone === "bad" ? "failing" : "to watch"}` : "") : undefined}
      onClick={pick}
    >
      <Ic icon={kindIcon(resource)} size={15} />
      <span className="nav-label">{label}</span>
      {badge ? (
        <span className={`nav-badge ${badge.tone}`} aria-hidden="true" title={`${badge.n} ${badge.tone === "bad" ? (badge.n === 1 ? "problem" : "problems") : badge.n === 1 ? "thing to watch" : "things to watch"}`}>{badge.n}</span>
      ) : null}
    </button>
  );

  return (
    <aside className={"sidebar" + (rail ? " rail" : "")} aria-label="Resources">
      <div className="titlebar-gap">
        <button className="icon-btn sb-toggle" aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} title={`${rail ? "Expand" : "Collapse"} sidebar (${MOD}B)`} onClick={props.onToggle}>
          <Ic icon={PanelLeft} size={15} />
        </button>
      </div>
      <div className="switch-wrap" ref={wrap}>
        <button className="cluster-switch" aria-label={`${cluster.context}, switch cluster`} aria-haspopup="menu" aria-expanded={menu} title={rail ? cluster.context : undefined} onClick={() => setMenu((m) => !m)}>
          <span className={`cl-tile ${tile.g}`}>{tile.initials}<i className="live" aria-hidden="true" /></span>
          <span className="cl-text">
            <span className="cl-name">{cluster.context}</span>
            <span className="cl-ver mono">{cluster.version}{props.nodes !== undefined ? ` · ${props.nodes} node${props.nodes === 1 ? "" : "s"}` : ""}</span>
          </span>
          <Ic icon={ChevronsUpDown} size={14} className="cl-chev" />
        </button>
        {menu ? (
          <div className="cluster-menu" role="menu" aria-label="Clusters">
            <div className="menu-label">Clusters in your kubeconfig</div>
            {(props.contexts ?? []).map((c) => {
              const t = clusterTile(c.name);
              return (
                <button key={c.name} role="menuitem" className="cluster-option" onClick={() => {
                  setMenu(false);
                  if (c.name !== cluster.context) props.onSwitch(c.name);
                }}>
                  <span className={`cl-tile ${t.g}`}>{t.initials}</span>
                  <span className="name">{c.name}</span>
                  {c.name === cluster.context ? <Ic icon={Check} size={14} className="check" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <button className="jump" aria-label="Jump to…" title={rail ? `Jump to… (${MOD}K)` : undefined} onClick={props.onJump}>
        <Ic icon={Search} size={14} />
        <span>Jump to…</span>
        <kbd aria-hidden="true">{MOD}K</kbd>
      </button>
      <nav className="nav">
        {item("overview", "Overview", "overview", props.current === "overview", props.badges.overview, () => props.onPick("overview"))}
        {item("mcp", "MCP", "mcp", props.current === "mcp", undefined, () => props.onPick("mcp"))}
        {props.navError ? <p className="small tone-bad">{props.navError}</p> : null}
        {props.sections.map(([section, items]) => {
          const open = rail || !closed.has(section);
          return (
            <div key={section} role="group" aria-label={section} style={{ display: "contents" }}>
              <button
                className={"nav-sec" + (open ? "" : " closed")}
                aria-expanded={open}
                tabIndex={rail ? -1 : 0}
                onClick={() => setClosed((c) => {
                  const next = new Set(c);
                  if (next.has(section)) next.delete(section);
                  else next.add(section);
                  return next;
                })}
              >
                <span>{section === "core" ? "Core (other)" : section}</span>
                <Ic icon={ChevronDown} size={12} />
              </button>
              {open ? items.map((n) => item(`${n.type.group}/${n.type.resource}`, n.label, n.type.resource, props.current === n, props.badges.byResource[n.type.resource], () => props.onPick(n))) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
