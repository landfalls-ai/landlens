// One sidebar: the cluster switcher, the jump row, and the resource nav. Folds to a 52px rail of icons when the
// drawer and the dock both want room (or on ⌘B).
import type { ClusterInfo, KubeContext } from "@landlens/contracts";
import { Check, ChevronDown, ChevronsUpDown, Cloud, PanelLeft, Search, Shapes, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Badge } from "./health";
import { Ic, kindIcon, MOD } from "./icons";
import { CUSTOM, SECTIONS, type NavItem } from "./kinds";
import { clusterTile } from "./present";

export type Current = NavItem | "overview" | "problems" | "connections" | "mcp" | "agent" | "helm" | "gcp";

/** A kind's key for pins: `group/resource`. */
export const navKey = (n: NavItem) => `${n.type.group}/${n.type.resource}`;
/** Past this many custom kinds the section gets a filter (D38). */
const FILTER_PAST = 12;

export function Sidebar(props: {
  cluster: ClusterInfo;
  contexts?: KubeContext[];
  nodes?: number;
  sections: (readonly [string, NavItem[]])[];
  current?: Current;
  navError?: string;
  rail: boolean;
  badges: { problems?: Badge; byResource: Record<string, Badge | undefined> };
  onPick: (c: Current) => void;
  onToggle: () => void;
  onSwitch: (context: string) => void;
  /** The cluster menu opened: the catalog is read again (a GKE cluster may have come or gone). */
  onMenu?: () => void;
  onJump: () => void;
  /** Kinds pinned under Agent (D39), by navKey. */
  pins: string[];
  onPin: (key: string) => void;
}) {
  const { cluster, rail } = props;
  const [menu, setMenu] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set(props.sections.map(([s]) => s).filter((s) => !SECTIONS.includes(s))));
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [customFilter, setCustomFilter] = useState("");
  const [flyout, setFlyout] = useState<number>();
  const flyWrap = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  // A GKE cluster (D91) goes by its short name, with the cloud tile; its full context is in the title.
  const gkeNow = (props.contexts ?? []).some((c) => c.name === cluster.context && c.source === "gke");
  const shortName = gkeNow ? (cluster.context.split("_").at(-1) ?? cluster.context) : cluster.context;
  const tile = clusterTile(shortName);

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

  useEffect(() => {
    if (flyout === undefined) return;
    const away = (e: MouseEvent) => flyWrap.current && !flyWrap.current.contains(e.target as Node) && setFlyout(undefined);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setFlyout(undefined));
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [flyout]);
  useEffect(() => setFlyout(undefined), [rail]);

  const pinned = useMemo(() => {
    const all = props.sections.flatMap(([, items]) => items);
    return props.pins.map((k) => all.find((n) => navKey(n) === k)).filter((n): n is NavItem => !!n);
  }, [props.sections, props.pins]);
  const isPinned = (n: NavItem) => props.pins.includes(navKey(n));

  const item = (key: string, label: string, resource: string, on: boolean, badge: Badge | undefined, pick: () => void, pin?: NavItem) => (
    <div key={key} className="nav-row">
      <button
        className={"nav-item" + (on ? " on" : "")}
        aria-label={label}
        aria-current={on ? "page" : undefined}
        title={rail ? label + (badge ? ` · ${badge.n} ${badge.tone === "bad" ? "failing" : "to watch"}` : "") : undefined}
        onClick={pick}
      >
        <Ic icon={pin?.type.custom ? Shapes : kindIcon(resource)} size={15} />
        <span className="nav-label">{label}</span>
        {badge ? (
          <span className={`nav-badge ${badge.tone}`} aria-hidden="true" title={`${badge.n} ${badge.tone === "bad" ? (badge.n === 1 ? "problem" : "problems") : badge.n === 1 ? "thing to watch" : "things to watch"}`}>{badge.n}</span>
        ) : null}
      </button>
      {pin && !rail ? (
        <button
          className={"nav-pin" + (isPinned(pin) ? " on" : "")}
          aria-label={isPinned(pin) ? `Unpin ${label}` : `Pin ${label}`}
          aria-pressed={isPinned(pin)}
          title={isPinned(pin) ? "Unpin" : "Pin under Agent"}
          onClick={() => props.onPin(navKey(pin))}
        >
          <Ic icon={Star} size={12} />
        </button>
      ) : null}
    </div>
  );
  const kindItem = (n: NavItem) => item(navKey(n), n.label, n.type.resource, props.current === n, props.badges.byResource[n.type.resource], () => props.onPick(n), n);

  /** Custom resources (D38): Definitions, then each API group folding, with a filter past 12 kinds; one icon in the rail. */
  const custom = (items: NavItem[]) => {
    const defs = items.filter((n) => !n.group);
    const kinds = items.filter((n) => n.group);
    const f = customFilter.trim().toLowerCase();
    const groups = new Map<string, NavItem[]>();
    for (const n of kinds) {
      if (f && !n.label.toLowerCase().includes(f) && !n.group!.toLowerCase().includes(f) && !n.type.resource.includes(f)) continue;
      groups.set(n.group!, [...(groups.get(n.group!) ?? []), n]);
    }
    const list = (inFlyout: boolean) => (
      <>
        {kinds.length > FILTER_PAST && !inFlyout ? (
          <input className="nav-filter" type="search" placeholder={`Filter ${kinds.length} kinds`} aria-label="Filter custom resources" value={customFilter} onChange={(e) => setCustomFilter(e.target.value)} />
        ) : null}
        {defs.map((n) => inFlyout ? flyItem(n) : kindItem(n))}
        {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, ns]) => {
          const open = inFlyout || !!f || !closedGroups.has(g);
          return (
            <div key={g} role="group" aria-label={g} style={{ display: "contents" }}>
              {inFlyout ? <div className="menu-label mono">{g}</div> : (
                <button className={"nav-group" + (open ? "" : " closed")} aria-expanded={open} onClick={() => setClosedGroups((c) => {
                  const next = new Set(c);
                  if (next.has(g)) next.delete(g);
                  else next.add(g);
                  return next;
                })}>
                  <Ic icon={ChevronDown} size={11} />
                  <span className="mono">{g}</span>
                  <span className="count">{ns.length}</span>
                </button>
              )}
              {open ? ns.sort((a, b) => a.label.localeCompare(b.label)).map((n) => inFlyout ? flyItem(n) : kindItem(n)) : null}
            </div>
          );
        })}
        {f && !groups.size ? <p className="small dim nav-none">No kinds match “{customFilter.trim()}”.</p> : null}
      </>
    );
    if (rail) {
      const on = items.some((n) => props.current === n);
      return (
        <div className="nav-fly-wrap" ref={flyWrap}>
          <button className={"nav-item" + (on ? " on" : "")} aria-label={CUSTOM} aria-haspopup="menu" aria-expanded={flyout !== undefined} title={CUSTOM}
            onClick={(e) => {
              const top = e.currentTarget.getBoundingClientRect().top;
              setFlyout((v) => (v === undefined ? top : undefined));
            }}>
            <Ic icon={Shapes} size={15} />
          </button>
          {flyout !== undefined ? <div className="nav-flyout" role="menu" aria-label={CUSTOM} style={{ top: Math.max(8, Math.min(flyout, window.innerHeight - 428)) }}><div className="menu-label">{CUSTOM}</div>{list(true)}</div> : null}
        </div>
      );
    }
    return list(false);
  };
  const flyItem = (n: NavItem) => (
    <button key={navKey(n)} role="menuitem" className={"cluster-option" + (props.current === n ? " on" : "")} onClick={() => (setFlyout(undefined), props.onPick(n))}>
      <Ic icon={n.group ? Shapes : kindIcon(n.type.resource)} size={14} />
      <span className="name">{n.label}</span>
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
        <button className="cluster-switch" aria-label={`${cluster.context}, switch cluster`} aria-haspopup="menu" aria-expanded={menu} title={rail || gkeNow ? cluster.context : undefined} onClick={() => setMenu((m) => (!m && props.onMenu?.(), !m))}>
          <span className={`cl-tile ${tile.g}${gkeNow ? " gke" : ""}`}>{gkeNow ? <Ic icon={Cloud} size={13} /> : tile.initials}<i className="live" aria-hidden="true" /></span>
          <span className="cl-text">
            <span className="cl-name">{shortName}</span>
            <span className="cl-ver mono">{cluster.version}{props.nodes !== undefined ? ` · ${props.nodes} node${props.nodes === 1 ? "" : "s"}` : ""}</span>
          </span>
          <Ic icon={ChevronsUpDown} size={14} className="cl-chev" />
        </button>
        {menu ? (
          <div className="cluster-menu" role="menu" aria-label="Clusters">
            {([["kubeconfig", "Clusters in your kubeconfig"], ["gke", "Google Cloud"]] as const).map(([source, label]) => {
              const list = (props.contexts ?? []).filter((c) => (c.source ?? "kubeconfig") === source);
              if (!list.length) return null;
              return (
                <div key={source} role="group" aria-label={label} style={{ display: "contents" }}>
                  <div className="menu-label">{label}</div>
                  {list.map((c) => {
                    const t = clusterTile(source === "gke" ? (c.name.split("_").at(-1) ?? c.name) : c.name);
                    return (
                      <button key={c.name} role="menuitem" className="cluster-option" title={c.name} onClick={() => {
                        setMenu(false);
                        if (c.name !== cluster.context) props.onSwitch(c.name);
                      }}>
                        <span className={`cl-tile ${t.g}${source === "gke" ? " gke" : ""}`}>{source === "gke" ? <Ic icon={Cloud} size={12} /> : t.initials}</span>
                        <span className="name">{source === "gke" ? <>{c.name.split("_").at(-1)}<span className="dim small"> · {c.project}</span></> : c.name}</span>
                        {c.name === cluster.context ? <Ic icon={Check} size={14} className="check" /> : null}
                      </button>
                    );
                  })}
                </div>
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
        {item("overview", "Overview", "overview", props.current === "overview", undefined, () => props.onPick("overview"))}
        {item("problems", "Problems", "problems", props.current === "problems", props.badges.problems, () => props.onPick("problems"))}
        {item("connections", "Connections", "connections", props.current === "connections", undefined, () => props.onPick("connections"))}
        {item("mcp", "MCP", "mcp", props.current === "mcp", undefined, () => props.onPick("mcp"))}
        {item("agent", "Agent", "agent", props.current === "agent", undefined, () => props.onPick("agent"))}
        {pinned.length ? (
          <div role="group" aria-label="Pinned" style={{ display: "contents" }}>
            <div className="nav-sec static"><span>Pinned</span></div>
            {pinned.map((n) => item(`pin:${navKey(n)}`, n.label, n.type.resource, props.current === n, props.badges.byResource[n.type.resource], () => props.onPick(n), n))}
          </div>
        ) : null}
        <div role="group" aria-label="Cloud" style={{ display: "contents" }}>
          <div className="nav-sec static"><span>Cloud</span></div>
          {item("gcp", "Google Cloud", "gcp", props.current === "gcp", undefined, () => props.onPick("gcp"))}
        </div>
        {props.navError ? <p className="small tone-bad">{props.navError}</p> : null}
        {props.sections.map(([section, items]) => {
          if (section === CUSTOM && rail) return <div key={section} role="group" aria-label={section} style={{ display: "contents" }}>{custom(items)}</div>;
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
                <span>{section === "core" ? "Core (other)" : section}{section === CUSTOM ? <span className="count">{items.filter((n) => n.group).length}</span> : null}</span>
                <Ic icon={ChevronDown} size={12} />
              </button>
              {open ? (section === CUSTOM ? custom(items) : items.map(kindItem)) : null}
              {open && section === "Workloads" ? item("helm", "Helm releases", "helm", props.current === "helm", undefined, () => props.onPick("helm")) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
