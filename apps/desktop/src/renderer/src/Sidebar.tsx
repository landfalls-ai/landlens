// One sidebar: the cluster switcher, the jump row, and the resource nav. Folds to a 52px rail of icons when the
// drawer and the dock both want room (or on ⌘B). Every labelled block of the nav folds (D139, navState.ts).
import type { ClusterInfo, KubeContext, Problem, SavedViewSummary } from "@landlens/contracts";
import { Bookmark, Check, ChevronDown, ChevronsUpDown, Cloud, List, PanelLeft, Search, Shapes, Star, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { Badge } from "./health";
import { Ic, kindIcon, MOD } from "./icons";
import { CUSTOM, SECTIONS, type NavItem } from "./kinds";
import {
  allSections, badgeWords, CLOUD, isOpen, VIEWS_FOLD, loadNavFolds, NAV_KEY, navGroupsKey, PINNED, rollUp, setAll, shownRows, storeNavFolds, WORKSPACE, WORKSPACE_PAGES,
  type NavFolds,
} from "./navState";
import { clusterTile } from "./present";

export type Current = NavItem | "overview" | "problems" | "views" | "connections" | "mcp" | "agent" | "helm" | "gcp";

/** A kind's key for pins: `group/resource`. */
export const navKey = (n: NavItem) => `${n.type.group}/${n.type.resource}`;
/** Past this many custom kinds the section gets a filter (D38). */
const FILTER_PAST = 12;
const ALT = MOD === "⌘" ? "⌥" : "Alt";

export type NavFoldState = {
  /** Top-level sections (global). */
  folds: NavFolds;
  /** Custom resources' API groups (this context; open by default). */
  groups: NavFolds;
  setSections: (ids: readonly string[], open: boolean) => void;
  setGroups: (ids: readonly string[], open: boolean) => void;
};

/**
 * The sidebar's folds, kept in localStorage (D139): sections for every cluster, API groups per context. The updaters
 * are pure; the write happens in an effect after the fold changed, and a storage that throws (full, disabled) only
 * means the fold isn't remembered: it can't take the sidebar down (security review of part 5, L10).
 */
export function useNavFolds(context: string): NavFoldState {
  const [folds, setFolds] = useState<{ folds: NavFolds; dirty: boolean }>(() => ({ folds: loadNavFolds(localStorage, NAV_KEY), dirty: false }));
  const [groups, setGroupFolds] = useState<{ context: string; folds: NavFolds; dirty: boolean }>(() => ({ context, folds: loadNavFolds(localStorage, navGroupsKey(context)), dirty: false }));
  useEffect(() => setGroupFolds({ context, folds: loadNavFolds(localStorage, navGroupsKey(context)), dirty: false }), [context]);
  useEffect(() => void (folds.dirty && storeNavFolds(localStorage, NAV_KEY, folds.folds)), [folds]);
  useEffect(() => void (groups.dirty && storeNavFolds(localStorage, navGroupsKey(groups.context), groups.folds)), [groups]);
  return {
    folds: folds.folds,
    groups: groups.folds,
    setSections: (ids, open) => setFolds((f) => ({ folds: setAll(f.folds, ids, open), dirty: true })),
    setGroups: (ids, open) => setGroupFolds((g) => ({ ...g, folds: setAll(g.folds, ids, open), dirty: true })),
  };
}

/** A row: its key, whether it is the page you are on, and how it draws in the list and in a rail flyout. */
type Row = { key: string; active: boolean; resource?: string; draw: () => ReactNode; fly: () => ReactNode };

export function Sidebar(props: {
  cluster: ClusterInfo;
  contexts?: KubeContext[];
  nodes?: number;
  sections: (readonly [string, NavItem[]])[];
  current?: Current;
  navError?: string;
  rail: boolean;
  /** `all` is every problem, for a folded header's roll-up. */
  badges: { problems?: Badge; byResource: Record<string, Badge | undefined>; all?: Problem[] };
  nav: NavFoldState;
  onPick: (c: Current) => void;
  onToggle: () => void;
  onSwitch: (context: string) => void;
  /** The cluster menu opened: the catalog is read again (a GKE cluster may have come or gone). */
  onMenu?: () => void;
  onJump: () => void;
  /** Kinds pinned under Agent (D39), by navKey. */
  pins: string[];
  onPin: (key: string) => void;
  /** Saved views this cluster may open (D216), newest first: names only. */
  savedViews?: SavedViewSummary[];
  /** The saved view on the Views page now. */
  openView?: string;
  onOpenView?: (id: string) => void;
  onAllViews?: () => void;
}) {
  const { cluster, rail, nav } = props;
  const uid = useId();
  const [menu, setMenu] = useState(false);
  const [customFilter, setCustomFilter] = useState("");
  const [flyout, setFlyout] = useState<{ id: string; top: number }>();
  const flyWrap = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const navEl = useRef<HTMLElement>(null);
  // A GKE cluster (D91) goes by its short name, with the cloud tile; its full context is in the title.
  const gkeNow = (props.contexts ?? []).some((c) => c.name === cluster.context && c.source === "gke");
  const shortName = gkeNow ? (cluster.context.split("_").at(-1) ?? cluster.context) : cluster.context;
  const tile = clusterTile(shortName);
  const problems = props.badges.all ?? [];
  const sectionIds = useMemo(() => allSections(props.sections.map(([s]) => s)), [props.sections]);
  const open = (id: string) => isOpen(nav.folds, id);
  const groupOpen = (g: string) => isOpen(nav.groups, g, () => true);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setMenu(false);
    const esc = (e: globalThis.KeyboardEvent) => {
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
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setFlyout(undefined));
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
          <span className={`nav-badge ${badge.tone}`} aria-hidden="true" title={badgeWords(badge)}>{badge.n}</span>
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
  const flyRow = (key: string, label: string, icon: LucideIcon, on: boolean, pick: () => void) => (
    <button key={key} role="menuitem" className={"cluster-option" + (on ? " on" : "")} onClick={() => (setFlyout(undefined), pick())}>
      <Ic icon={icon} size={14} />
      <span className="name">{label}</span>
    </button>
  );
  const pageRow = (page: Exclude<Current, NavItem>, label: string, badge?: Badge): Row => ({
    key: page, active: props.current === page,
    draw: () => item(page, label, page, props.current === page, badge, () => props.onPick(page)),
    fly: () => flyRow(page, label, kindIcon(page), props.current === page, () => props.onPick(page)),
  });
  const kindRow = (n: NavItem, prefix = ""): Row => ({
    key: prefix + navKey(n), active: props.current === n, resource: n.type.resource,
    draw: () => item(prefix + navKey(n), n.label, n.type.resource, props.current === n, props.badges.byResource[n.type.resource], () => props.onPick(n), n),
    fly: () => flyRow(navKey(n), n.label, n.group ? Shapes : kindIcon(n.type.resource), props.current === n, () => props.onPick(n)),
  });

  /** Option-click (or ⌥→/⌥←) on any header folds or unfolds every section. */
  const toggleSection = (id: string, e?: { altKey: boolean }) => {
    const now = open(id);
    nav.setSections(e?.altKey ? sectionIds : [id], !now);
  };

  /** A foldable block: a header button (aria-expanded, aria-controls) and its rows; folded, only the active row stays. */
  const section = (id: string, label: string, rows: Row[], opts: { count?: number; body?: (isOpen: boolean) => ReactNode } = {}) => {
    const isOpenNow = open(id);
    const rowsId = `${uid}-rows-${id}`;
    const badge = isOpenNow ? undefined : rollUp(problems, rows.map((r) => r.resource ?? ""));
    return (
      <div key={id} role="group" aria-label={id} style={{ display: "contents" }}>
        <button
          className={"nav-sec" + (isOpenNow ? "" : " closed")}
          aria-expanded={isOpenNow}
          aria-controls={rowsId}
          data-sec={id}
          title={`${isOpenNow ? "Fold" : "Unfold"} ${label}${badge ? ` · ${badgeWords(badge)}` : ""} · ${ALT}-click for all`}
          onClick={(e) => toggleSection(id, e)}
        >
          <span className="nav-sec-label">{label}{opts.count !== undefined ? <span className="count">{opts.count}</span> : null}</span>
          {badge ? <span className={`nav-badge ${badge.tone}`} aria-hidden="true">{badge.n}</span> : null}
          {badge ? <span className="sr-only">, {badgeWords(badge)}</span> : null}
          <Ic icon={ChevronDown} size={12} />
        </button>
        <div id={rowsId} data-rows="" className="nav-rows" style={{ display: "contents" }}>
          {opts.body ? opts.body(isOpenNow) : shownRows(rows, isOpenNow, (r) => r.active).map((r) => r.draw())}
        </div>
      </div>
    );
  };

  /** A section as one icon in the rail, opening the flyout Custom resources has had since D38; its dot is the roll-up. */
  const railSection = (id: string, label: string, icon: LucideIcon, rows: Row[], body?: () => ReactNode) => {
    const on = rows.some((r) => r.active);
    const badge = rollUp(problems, rows.map((r) => r.resource ?? ""));
    const isFly = flyout?.id === id;
    return (
      <div key={id} className="nav-fly-wrap" ref={isFly ? flyWrap : undefined}>
        <button className={"nav-item" + (on ? " on" : "")} aria-label={label} aria-haspopup="menu" aria-expanded={isFly} title={label + (badge ? ` · ${badgeWords(badge)}` : "")}
          onClick={(e) => {
            const top = e.currentTarget.getBoundingClientRect().top;
            setFlyout((v) => (v?.id === id ? undefined : { id, top }));
          }}>
          <Ic icon={icon} size={15} />
          {badge ? <span className={`nav-badge ${badge.tone}`} aria-hidden="true">{badge.n}</span> : null}
        </button>
        {isFly ? (
          <div className="nav-flyout" role="menu" aria-label={label} style={{ top: Math.max(8, Math.min(flyout.top, window.innerHeight - 428)) }}>
            <div className="menu-label">{label}</div>
            {body ? body() : rows.map((r) => r.fly())}
          </div>
        ) : null}
      </div>
    );
  };

  /** Custom resources (D38): Definitions, then each API group folding, with a filter past 12 kinds. */
  const customBody = (items: NavItem[], inFlyout: boolean, sectionOpen = true) => {
    const defs = items.filter((n) => !n.group);
    const kinds = items.filter((n) => n.group);
    if (!sectionOpen) return shownRows(items.map((n) => kindRow(n)), false, (r) => r.active).map((r) => r.draw());
    const f = customFilter.trim().toLowerCase();
    const groups = new Map<string, NavItem[]>();
    for (const n of kinds) {
      if (f && !n.label.toLowerCase().includes(f) && !n.group!.toLowerCase().includes(f) && !n.type.resource.includes(f)) continue;
      groups.set(n.group!, [...(groups.get(n.group!) ?? []), n]);
    }
    const names = [...groups.keys()];
    return (
      <>
        {kinds.length > FILTER_PAST && !inFlyout ? (
          <input className="nav-filter" type="search" placeholder={`Filter ${kinds.length} kinds`} aria-label="Filter custom resources" value={customFilter} onChange={(e) => setCustomFilter(e.target.value)} />
        ) : null}
        {defs.map((n) => (inFlyout ? kindRow(n).fly() : kindRow(n).draw()))}
        {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, ns]) => {
          const gOpen = inFlyout || !!f || groupOpen(g);
          const rowsId = `${uid}-group-${g}`;
          const rows = ns.sort((a, b) => a.label.localeCompare(b.label)).map((n) => kindRow(n));
          return (
            <div key={g} role="group" aria-label={g} style={{ display: "contents" }}>
              {inFlyout ? <div className="menu-label mono">{g}</div> : (
                <button className={"nav-group" + (gOpen ? "" : " closed")} aria-expanded={gOpen} aria-controls={rowsId} data-group={g}
                  onClick={(e: ReactMouseEvent) => nav.setGroups(e.altKey ? names : [g], !gOpen)}>
                  <Ic icon={ChevronDown} size={11} />
                  <span className="mono">{g}</span>
                  <span className="count">{ns.length}</span>
                </button>
              )}
              <div id={rowsId} data-rows="" style={{ display: "contents" }}>
                {inFlyout ? rows.map((r) => r.fly()) : shownRows(rows, gOpen, (r) => r.active).map((r) => r.draw())}
              </div>
            </div>
          );
        })}
        {f && !groups.size ? <p className="small dim nav-none">No kinds match “{customFilter.trim()}”.</p> : null}
      </>
    );
  };

  /** ↑/↓ move over the visible rows and headers, Home/End to the ends, → opens a header (or steps in), ← folds it or
   *  goes from a row to its header; ⌥→/⌥← unfold or fold every section. Tab still walks them in order. */
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (rail || !navEl.current) return;
    const t = e.target as HTMLElement;
    if (!t.matches(".nav-item, .nav-sec, .nav-group")) return;
    const list = [...navEl.current.querySelectorAll<HTMLElement>(".nav-item, .nav-sec, .nav-group")];
    const i = list.indexOf(t);
    const go = (j: number) => list[Math.max(0, Math.min(list.length - 1, j))]?.focus();
    const header = t.matches(".nav-sec, .nav-group");
    const expanded = t.getAttribute("aria-expanded") === "true";
    const all = (to: boolean) => {
      if (t.dataset.group !== undefined) nav.setGroups([...navEl.current!.querySelectorAll<HTMLElement>("[data-group]")].map((b) => b.dataset.group!), to);
      else nav.setSections(sectionIds, to);
    };
    const owner = () => {
      const box = t.parentElement?.closest<HTMLElement>("[data-rows]");
      return box ? navEl.current!.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(box.id)}"]`) : null;
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "ArrowRight" && header) {
      if (e.altKey) all(true);
      else if (!expanded) t.click();
      else go(i + 1);
    } else if (e.key === "ArrowLeft") {
      if (header && e.altKey) all(false);
      else if (header && expanded) t.click();
      else owner()?.focus();
    } else return;
    e.preventDefault();
  };

  // The blocks, in order. Overview and Problems stay above them, so folding everything never hides the total.
  const workspaceRows = WORKSPACE_PAGES.map(([page, label]) => pageRow(page, label));
  // Saved views under Views (D216): at most 12, newest first, then All views…; the sub-list folds as `Views`.
  const saved = props.savedViews ?? [];
  const viewsOpen = isOpen(nav.folds, VIEWS_FOLD);
  const savedRow = (v: SavedViewSummary): Row => {
    const on = props.current === "views" && props.openView === v.id;
    return {
      key: `view:${v.id}`, active: on,
      draw: () => (
        <div key={`view:${v.id}`} className="nav-row nav-sub">
          <button className={"nav-item" + (on ? " on" : "")} aria-current={on ? "page" : undefined} title={`${v.name}${v.scope === "any" ? " · any cluster" : ""}`} onClick={() => props.onOpenView?.(v.id)}>
            <Ic icon={Bookmark} size={13} />
            <span className="nav-label">{v.name}</span>
          </button>
        </div>
      ),
      fly: () => flyRow(`view:${v.id}`, v.name, Bookmark, on, () => props.onOpenView?.(v.id)),
    };
  };
  const savedRows: Row[] = saved.length
    ? [
        {
          key: "views-fold", active: false,
          draw: () => (
            <button key="views-fold" className={"nav-subsec" + (viewsOpen ? "" : " closed")} aria-expanded={viewsOpen} data-sec={VIEWS_FOLD}
              title={`${viewsOpen ? "Fold" : "Unfold"} saved views`} onClick={() => nav.setSections([VIEWS_FOLD], !viewsOpen)}>
              <span className="nav-sec-label">Saved views<span className="count">{saved.length}</span></span>
              <Ic icon={ChevronDown} size={12} />
            </button>
          ),
          fly: () => null,
        },
        ...(viewsOpen ? saved.slice(0, 12).map(savedRow) : saved.slice(0, 12).map(savedRow).filter((r) => r.active)),
        ...(viewsOpen ? [{
          key: "views-all", active: false,
          draw: () => (
            <div key="views-all" className="nav-row nav-sub">
              <button className="nav-item" onClick={props.onAllViews}><Ic icon={List} size={13} /><span className="nav-label">All views…</span></button>
            </div>
          ),
          fly: () => null,
        }] : []),
      ]
    : [];
  const pinnedRows = pinned.map((n) => kindRow(n, "pin:"));
  const cloudRows = [pageRow("gcp", "Google Cloud")];
  const rowsOf = (s: string, items: NavItem[]) => [...items.map((n) => kindRow(n)), ...(s === "Workloads" ? [pageRow("helm", "Helm releases")] : [])];
  const label = (s: string) => (s === "core" ? "Core (other)" : s);

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
      <nav className="nav" ref={navEl} onKeyDown={onNavKey}>
        {pageRow("overview", "Overview").draw()}
        {pageRow("problems", "Problems", props.badges.problems).draw()}
        {rail ? (
          // The rail ignores the folds (and leaves them alone): pages and pins keep their icons, each kind section is
          // one icon with a flyout.
          <>
            {workspaceRows.map((r) => r.draw())}
            {pinnedRows.length ? <><div className="nav-rule" aria-hidden="true" />{pinnedRows.map((r) => r.draw())}</> : null}
            <div className="nav-rule" aria-hidden="true" />
            {cloudRows.map((r) => r.draw())}
            <div className="nav-rule" aria-hidden="true" />
            {props.sections.map(([s, items]) =>
              s === CUSTOM
                ? railSection(s, CUSTOM, Shapes, items.map((n) => kindRow(n)), () => customBody(items, true))
                : railSection(s, label(s), SECTIONS.includes(s) && items[0] ? kindIcon(items[0].type.resource) : Shapes, rowsOf(s, items)))}
          </>
        ) : (
          <>
            {section(WORKSPACE, WORKSPACE, [...workspaceRows.slice(0, 1), ...savedRows, ...workspaceRows.slice(1)])}
            {pinnedRows.length ? section(PINNED, PINNED, pinnedRows) : null}
            {section(CLOUD, CLOUD, cloudRows)}
            {props.navError ? <p className="small tone-bad">{props.navError}</p> : null}
            {props.sections.map(([s, items]) =>
              s === CUSTOM
                ? section(s, CUSTOM, items.map((n) => kindRow(n)), { count: items.filter((n) => n.group).length, body: (o) => customBody(items, false, o) })
                : section(s, label(s), rowsOf(s, items)))}
          </>
        )}
      </nav>
    </aside>
  );
}
