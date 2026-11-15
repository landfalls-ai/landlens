// A connected cluster: the sidebar, the main pane (Overview or a list), the details drawer and the agent dock, with
// the width rules that keep the table readable (docs/design.md, "Layout").
import type { ClicklandSettings as ClicklandView, ClusterInfo, HealthProblem, KubeContext, KubeObject } from "@landlens/contracts";
import { Copy, CircleX, Lock, Pencil, ScrollText, Sparkles, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentDock, type AskContext } from "./AgentDock";
import { api, useNow, useWatch, type ApiError } from "./api";
import { ClicklandSettings } from "./ClicklandSettings";
import { Details, type NavTarget } from "./Details";
import { badgeFor, useHealth } from "./health";
import { Ic, RESOURCE_OF_KIND } from "./icons";
import { JumpPalette } from "./JumpPalette";
import { McpCallDrawer, McpPage, type McpTab } from "./McpPage";
import { AgentPage, type AgentTab } from "./AgentPage";
import { buildNav, SECTIONS, type NavItem } from "./kinds";
import { Overview } from "./Overview";
import { splitByShape } from "./present";
import { ResourceTable, rowTone } from "./ResourceTable";
import { Sidebar, type Current } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Bench } from "./Bench";
import { useBench } from "./benchState";
import { useForwards } from "./Forwards";
import { logSourceOf } from "./LogsView";
import { direct } from "./ShellMenu";
import { copyText } from "./present";
import { Toolbar, type StatusFilter } from "./Toolbar";
import { CreateSheet } from "./CreateSheet";
import { leaveEdit } from "./editGuard";

const FIRST_QUESTION = "What's wrong in this cluster right now?";

export function Workspace({ cluster, contexts, onSwitch }: { cluster: ClusterInfo; contexts?: KubeContext[]; onSwitch: (context: string) => void }) {
  const now = useNow();
  const [nav, setNav] = useState<NavItem[]>([]);
  const [navError, setNavError] = useState<string>();
  const [current, setCurrent] = useState<Current>("overview");
  const [namespace, setNamespace] = useState("");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selected, setSelectedNow] = useState<KubeObject>();
  // Anything that takes the drawer's object away asks first while an edit has changes (D31).
  const setSelected = (o: KubeObject | undefined) => {
    if (o?.metadata.uid === selected?.metadata.uid && o) return setSelectedNow(o);
    leaveEdit(() => setSelectedNow(o));
  };
  const [creating, setCreating] = useState(false);
  const [want, setWant] = useState<NavTarget>();
  const [dock, setDock] = useState(false);
  const [askContext, setAskContext] = useState<AskContext[]>([]);
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const [userRail, setUserRail] = useState<boolean>();
  const [jump, setJump] = useState(false);
  const [mcpTab, setMcpTab] = useState<McpTab>("servers");
  const [agentTab, setAgentTab] = useState<AgentTab>("skills");
  const [mcpCall, setMcpCall] = useState<string>();
  const [claude, setClaude] = useState<string>();
  const [width, setWidth] = useState({ app: window.innerWidth, main: window.innerWidth - 232, height: window.innerHeight });
  const bench = useBench();
  const forwardsRunning = useForwards(cluster.context).filter((f) => f.state === "running" || f.state === "reconnecting" || f.state === "starting").length;
  const [rowMenu, setRowMenu] = useState<{ o: KubeObject; x: number; y: number }>();
  const [show, setShow] = useState<{ tab: "logs" | "shell" | "edit"; container?: string; n: number }>();
  const [leaving, setLeaving] = useState<string>();
  const beforeBench = useRef<HTMLElement | null>(null);
  const app = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const health = useHealth(cluster.handle, namespace);
  // Graphs: the Clickland dialog, and a version every chart refetches on when its settings change.
  const [clickland, setClickland] = useState<ClicklandView>();
  const [settings, setSettings] = useState(false);
  const [metricsVersion, setMetricsVersion] = useState(0);
  useEffect(() => void api.invoke("metrics:settings", { context: cluster.context }).then(setClickland, () => undefined), [cluster.context]);

  useEffect(() => {
    api.invoke("cluster:discovery", { handle: cluster.handle }).then(({ types }) => setNav(buildNav(types)), (e: ApiError) => setNavError(e.message));
  }, [cluster.handle]);

  useEffect(() => {
    const ro = new ResizeObserver(() => setWidth({ app: app.current?.clientWidth ?? 0, main: main.current?.clientWidth ?? 0, height: app.current?.clientHeight ?? 0 }));
    if (app.current) ro.observe(app.current);
    if (main.current) ro.observe(main.current);
    return () => ro.disconnect();
  }, []);

  const list = current !== "overview" && current !== "mcp" && current !== "agent" ? current : undefined;
  const mcp = current === "mcp";
  const agentPage = current === "agent";
  const namespaces = useWatch({ handle: cluster.handle, group: "", version: "v1", resource: "namespaces" });
  const scoped = list?.type.namespaced && namespace ? namespace : undefined;
  const watch = useWatch(list ? { handle: cluster.handle, group: list.type.group, version: list.type.version, resource: list.type.resource, ...(scoped ? { namespace: scoped } : {}) } : undefined);
  const pods = list?.type.resource === "pods" && list.type.group === "";

  const tones = useMemo(() => new Map(list ? watch.items.map((o) => [o.metadata.uid, rowTone(list.columns, o, now)]) : []), [watch.items, list, now]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return watch.items.filter((o) =>
      (!f || o.metadata.name.toLowerCase().includes(f) || (o.metadata.namespace ?? "").toLowerCase().includes(f)) &&
      (!pods || status === "all" || tones.get(o.metadata.uid) === status));
  }, [watch.items, filter, status, pods, tones]);
  const segCounts = useMemo(() => {
    let bad = 0, warn = 0;
    for (const t of tones.values()) t === "bad" ? bad++ : t === "warn" ? warn++ : 0;
    return { all: watch.items.length, bad, warn };
  }, [tones, watch.items.length]);

  // Keep the drawer showing the live object; open the one a link or an Overview row asked for once its list arrives.
  const live = selected && watch.items.find((o) => o.metadata.uid === selected.metadata.uid);
  useEffect(() => {
    if (!want || !list || watch.loading) return;
    const o = watch.items.find((x) => x.metadata.name === want.name && (!want.namespace || x.metadata.namespace === want.namespace));
    if (o) setSelectedNow(o);
    setWant(undefined);
  }, [want, watch.items, watch.loading, list]);

  const sections = useMemo(() => {
    const by = new Map<string, NavItem[]>();
    for (const n of nav) by.set(n.section, [...(by.get(n.section) ?? []), n]);
    const order = [...SECTIONS, ...[...by.keys()].filter((s) => !SECTIONS.includes(s)).sort()];
    return order.filter((s) => by.has(s)).map((s) => [s, by.get(s)!] as const);
  }, [nav]);

  const pick = (c: Current) => leaveEdit(() => {
    setCurrent(c);
    setSelectedNow(undefined);
    setMcpCall(undefined);
    setStatus("all");
  });
  const navItem = (resource: string) => nav.find((n) => n.type.resource === resource && (n.type.group === "" || n.type.group === "apps"));
  const go = (t: NavTarget) => {
    const n = navItem(RESOURCE_OF_KIND[t.kind] ?? "");
    if (!n) return;
    pick(n);
    if (n.type.namespaced && t.namespace && namespace && namespace !== t.namespace) setNamespace(t.namespace);
    setWant(t);
  };
  const ask = (ctx: AskContext) => {
    // Chosen lines replace a chip with the same label; an object is added once.
    setAskContext((cs) => (ctx.text ? [...cs.filter((c) => c.label !== ctx.label), ctx] : cs.some((c) => c.label === ctx.label) ? cs : [...cs, ctx]));
    setDock(true);
  };
  /** The drawer for this object, asked to show its logs or open a shell (from a row's menu or its keys). */
  const act = (o: KubeObject, action: "logs" | "shell" | "edit") => {
    if (!list) return;
    if (action === "edit") {
      if (list.type.group === "" && list.type.resource === "secrets") return;
      return leaveEdit(() => (setSelectedNow(o), setShow((s) => ({ tab: "edit", n: (s?.n ?? 0) + 1 }))));
    }
    if (action === "shell" && pods) {
      const d = direct(o);
      if (d) return bench.openShell(d);
    }
    if (action === "logs" && !logSourceOf(list.type.kind, o)) return;
    if (action === "shell" && !pods && !logSourceOf(list.type.kind, o)?.selector) return;
    setSelected(o);
    setShow((s) => ({ tab: action, n: (s?.n ?? 0) + 1 }));
  };
  // Switching cluster ends every session (D23): with live terminals, ask once.
  const switchTo = (context: string) => leaveEdit(() => (bench.terminals ? setLeaving(context) : onSwitch(context)));
  const askProblem = (p: HealthProblem) => {
    const n = navItem(RESOURCE_OF_KIND[p.kind] ?? "");
    if (!n) return setDock(true);
    ask({ ref: { group: n.type.group, version: n.type.version, resource: n.type.resource, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) }, label: `${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}` });
  };

  // Width rules: the table keeps at least ~600px. Drawer and dock together fold the sidebar to a rail; below 1280px
  // the dock alone does, and the drawer floats over the table.
  const drawer = !!(selected && list) || !!(mcp && mcpCall);
  const narrow = width.app < 1280;
  const autoRail = dock && (drawer || narrow);
  const rail = userRail ?? autoRail;
  useEffect(() => setUserRail(undefined), [dock, drawer, narrow]);

  const focusBench = () => setTimeout(() => {
    const pane = document.querySelector<HTMLElement>(".bench-pane:not([hidden])");
    (pane?.querySelector<HTMLElement>(".xterm-helper-textarea, .logs") ?? document.querySelector<HTMLElement>(".bench button"))?.focus();
  }, 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable]");
      const inBench = !!t?.closest(".bench");
      // The panel (D22): ⌘` shows and focuses it, or hides it from inside; ⌃⇧` opens a local terminal.
      if (e.code === "Backquote" && e.ctrlKey && e.shiftKey && !e.metaKey) return e.preventDefault(), bench.openLocal(), focusBench();
      if (e.code === "Backquote" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!bench.open) {
          beforeBench.current = document.activeElement as HTMLElement | null;
          bench.setOpen(true);
          return focusBench();
        }
        if (!inBench) {
          beforeBench.current = document.activeElement as HTMLElement | null;
          return focusBench();
        }
        bench.setOpen(false);
        return void beforeBench.current?.focus();
      }
      if (inBench && mod && !e.altKey && e.key.toLowerCase() === "w" && bench.active) return e.preventDefault(), bench.close(bench.active), focusBench();
      if (inBench && mod && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) return e.preventDefault(), bench.step(e.code === "BracketRight" ? 1 : -1), focusBench();
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "k") return e.preventDefault(), setJump((j) => !j);
        if (k === "j") return e.preventDefault(), setDock((d) => !d);
        if (k === "b") return e.preventDefault(), setUserRail(!rail);
        if (k === "1") return e.preventDefault(), pick("overview");
        if (k === "2") {
          const p = navItem("pods");
          if (p) (e.preventDefault(), pick(p));
          return;
        }
      }
      if (inBench) return; // single keys and Esc belong to the terminal or the log there
      if (e.key === "/" && !typing && !mod && filterBox.current) return e.preventDefault(), filterBox.current.focus();
      if (e.key === "Escape" && !jump && !creating && !t?.closest(".dock, .drawer .logs-pane, .yaml-edit, .change.mine") && selected) setSelected(undefined);
      if (e.key === "Escape" && !jump && !t?.closest(".dock") && mcpCall) setMcpCall(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const h = health.health;
  const bad = h?.problems.filter((p) => p.tone === "bad").length ?? 0;
  const warn = (h?.problems.length ?? 0) - bad;
  const worst = h?.problems.find((p) => p.tone === "bad");
  const suggestion = worst ? (worst.kind === "Pod" && worst.reason === "CrashLoopBackOff" ? `Why is ${splitByShape(worst.name).base} crash-looping?` : `What's wrong with ${worst.kind.toLowerCase()} ${worst.name}?`) : undefined;
  const nsList = useMemo(() => namespaces.items.map((n) => n.metadata.name).sort(), [namespaces.items]);
  const label = list?.label ?? (mcp ? "MCP" : agentPage ? "Agent" : "Overview");

  return (
    <div ref={app}
      className={"app" + (rail ? " sidebar-rail" : "") + (narrow ? " narrow" : "") + (dock ? " with-dock" : "") + (drawer ? " with-drawer" : "") + (bench.open ? " with-bench" : "") + (bench.open && bench.max ? " bench-max" : "") + (width.height < 760 ? " short" : "")}
      style={bench.height ? ({ "--bench-h": `${Math.min(bench.height, Math.max(160, width.height - 48 - 4 * 32 - 26))}px` } as React.CSSProperties) : undefined}>
      <Sidebar
        cluster={cluster}
        contexts={contexts}
        nodes={h?.nodes?.total}
        sections={sections}
        current={current}
        navError={navError}
        rail={rail}
        badges={{ overview: h ? badgeFor(h.problems) : undefined, byResource: h ? { pods: badgeFor(h.problems, "Pod"), deployments: badgeFor(h.problems, "Deployment"), nodes: badgeFor(h.problems, "Node") } : {} }}
        onPick={pick}
        onToggle={() => setUserRail(!rail)}
        onSwitch={switchTo}
        onJump={() => setJump(true)}
      />
      <main className="main" ref={main}>
        <Toolbar
          title={label}
          {...(list ? { count: watch.loading ? undefined : shown.length } : mcp || agentPage ? { hideCount: true } : h ? { updatedAt: h.at } : {})}
          {...(pods && !watch.loading ? { seg: { value: status, ...segCounts, onChange: setStatus } } : {})}
          {...(!mcp && !agentPage && (!list || list.type.namespaced) ? { namespaces: { list: nsList, value: namespace, onChange: (ns: string) => leaveEdit(() => { setNamespace(ns); setSelectedNow(undefined); }) } } : {})}
          {...(list ? { filter: { value: filter, onChange: setFilter, ref: filterBox, short: width.main < 860 } } : {})}
          {...(dock ? {} : { onAsk: () => setDock(true) })}
          {...(!mcp && !agentPage ? { onCreate: () => setCreating(true) } : {})}
        />
        {mcp ? (
          <McpPage
            handle={cluster.handle}
            context={cluster.context}
            tab={mcpTab}
            onTab={(t) => (setMcpTab(t), setMcpCall(undefined))}
            {...(mcpCall ? { selected: mcpCall } : {})}
            onSelect={setMcpCall}
            onOpenObject={go}
            onConnectClickland={() => setSettings(true)}
            version={metricsVersion}
          />
        ) : agentPage ? (
          <AgentPage tab={agentTab} onTab={setAgentTab} />
        ) : !list ? (
          <Overview
            handle={cluster.handle}
            metricsVersion={metricsVersion}
            onSettings={() => setSettings(true)}
            health={h}
            error={health.error}
            now={now}
            onOpenList={(r, failing) => {
              const n = navItem(r);
              if (!n) return;
              pick(n);
              if (failing) setStatus("bad");
            }}
            onOpenProblem={(p) => go({ kind: p.kind, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) })}
            onAskProblem={askProblem}
            onAskAll={() => {
              setDock(true);
              setPrompt({ id: Date.now(), text: FIRST_QUESTION });
            }}
          />
        ) : watch.error ? (
          <div className="notice" role="alert">
            <Ic icon={watch.error.status === 403 ? Lock : CircleX} size={15} className={watch.error.status === 403 ? "dim" : "tone-bad"} />
            <div className="notice-body">
              <strong>{watch.error.status === 403 ? "You don't have access to this list." : "Couldn't load this list."}</strong>
              <p>{watch.error.message}</p>
            </div>
          </div>
        ) : (
          <ResourceTable
            resource={list.type.resource}
            columns={list.columns}
            items={shown}
            now={now}
            loading={watch.loading}
            selected={selected?.metadata.uid}
            width={width.main}
            {...(narrow && dock && drawer ? { covered: 372 } : {})}
            oneNamespace={!!scoped}
            empty={{
              title: `No ${list.label.toLowerCase()}${scoped ? ` in ${scoped}` : ""}${filter.trim() ? ` matching “${filter.trim()}”` : status !== "all" ? ` ${status === "bad" ? "failing" : "pending"}` : ""}`,
              ...(filter.trim() || status !== "all" ? { onClear: () => (setFilter(""), setStatus("all")) } : {}),
            }}
            onSelect={setSelected}
            onMenu={(o, x, y) => setRowMenu({ o, x, y })}
            onAction={act}
          />
        )}
      </main>
      <StatusBar
          server={cluster.server}
          watching={list ? (watch.error ? "Not watching" : `Watching ${list.label.toLowerCase()} · live`) : mcp ? "MCP calls · live" : agentPage ? "Agent settings" : "Checking health every 10s"}
          {...(claude ? { claude } : {})}
          bad={bad}
          warn={warn}
          onProblems={() => pick("overview")}
          clickland={!!clickland?.hasKey}
          onMetrics={() => setSettings(true)}
          sessions={bench.sessions}
          panelOpen={bench.open}
          onSessions={() => (bench.setOpen(true), focusBench())}
          forwards={forwardsRunning}
          onForwards={() => bench.openForwards()}
        />
      {selected && list ? (
        <Details
          handle={cluster.handle}
          cluster={cluster}
          type={list.type}
          object={live ?? selected}
          tone={tones.get(selected.metadata.uid)}
          now={now}
          onClose={() => setSelected(undefined)}
          onAsk={ask}
          onNavigate={go}
          metricsVersion={metricsVersion}
          onSettings={() => setSettings(true)}
          onShell={(t) => (bench.openShell(t), focusBench())}
          onLogsInPanel={(s) => (bench.openLogs(s), focusBench())}
          {...(show ? { show } : {})}
        />
      ) : null}
      {mcp && mcpCall ? <McpCallDrawer id={mcpCall} onClose={() => setMcpCall(undefined)} onOpenObject={go} /> : null}
      <Bench bench={bench} cluster={cluster} onAsk={ask} appHeight={width.height} />
      {dock ? (
        <AgentDock
          cluster={cluster}
          context={askContext}
          onContextChange={setAskContext}
          onClose={() => setDock(false)}
          {...(prompt ? { pending: prompt } : {})}
          {...(suggestion ? { suggestion } : {})}
          onActivity={setClaude}
          onOpenObject={go}
          onOpenSettings={() => pick("agent")}
        />
      ) : null}
      {settings ? (
        <ClicklandSettings handle={cluster.handle} context={cluster.context} onClose={() => setSettings(false)} onSaved={(v) => (setClickland(v), setMetricsVersion((n) => n + 1))} />
      ) : null}
      {rowMenu && list ? (
        <RowMenu at={rowMenu} kind={list.type.kind} pods={!!pods} onClose={() => setRowMenu(undefined)}
          onAct={(a) => act(rowMenu.o, a)}
          onAsk={() => ask({ ref: { group: list.type.group, version: list.type.version, resource: list.type.resource, name: rowMenu.o.metadata.name, ...(rowMenu.o.metadata.namespace ? { namespace: rowMenu.o.metadata.namespace } : {}) }, label: `${list.type.kind} ${rowMenu.o.metadata.namespace ? `${rowMenu.o.metadata.namespace}/` : ""}${rowMenu.o.metadata.name}` })} />
      ) : null}
      {leaving ? (
        <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && setLeaving(undefined)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="leave-title" style={{ width: 380 }}
            onKeyDown={(e) => e.key === "Escape" && setLeaving(undefined)}>
            <header className="dialog-head"><h2 id="leave-title">{bench.terminals} session{bench.terminals === 1 ? "" : "s"} will end</h2></header>
            <div className="dialog-body"><p>Switching to {leaving} closes every shell and terminal open on {cluster.context}. Their output goes with them.</p></div>
            <footer className="dialog-foot">
              <button className="secondary" onClick={() => setLeaving(undefined)}>Stay</button>
              <button className="primary" autoFocus onClick={() => (setLeaving(undefined), onSwitch(leaving))}>Switch and end them</button>
            </footer>
          </div>
        </div>
      ) : null}
      {creating ? (
        <CreateSheet cluster={cluster} namespace={namespace} onAsk={ask} onClose={() => setCreating(false)}
          onCreated={(first) => (setCreating(false), go(first))} />
      ) : null}
      {jump ? (
        <JumpPalette nav={nav} current={current} items={watch.items} onPick={pick} onSelect={setSelected} onClose={() => setJump(false)} />
      ) : null}
    </div>
  );
}

/** A row's menu (D6): Logs, Open shell, Edit YAML, Copy name, Ask Claude. Port-forward joins it in part 3. */
function RowMenu({ at, kind, pods, onAct, onAsk, onClose }: {
  at: { o: KubeObject; x: number; y: number }; kind: string; pods: boolean;
  onAct: (a: "logs" | "shell" | "edit") => void; onAsk: () => void; onClose: () => void;
}) {
  const self = useRef<HTMLDivElement>(null);
  const logs = !!logSourceOf(kind, at.o);
  const shell = pods || !!logSourceOf(kind, at.o)?.selector;
  useEffect(() => {
    const close = (e: MouseEvent) => !self.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return e.stopPropagation(), onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(self.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    self.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const left = Math.min(at.x, window.innerWidth - 240);
  const top = Math.min(at.y, window.innerHeight - 200);
  const run = (f: () => void) => () => (onClose(), f());
  return (
    <div ref={self} className="menu row-menu" role="menu" aria-label={`${kind} ${at.o.metadata.name}`} style={{ left, top }}>
      <button className="cluster-option" role="menuitem" disabled={!logs} onClick={run(() => onAct("logs"))}><Ic icon={ScrollText} size={14} /><span className="name">Logs</span><kbd>L</kbd></button>
      <button className="cluster-option" role="menuitem" disabled={!shell} onClick={run(() => onAct("shell"))}><Ic icon={SquareTerminal} size={14} /><span className="name">Open shell</span><kbd>S</kbd></button>
      <button className="cluster-option" role="menuitem" disabled={kind === "Secret"} title={kind === "Secret" ? "Secrets stay locked" : undefined} onClick={run(() => onAct("edit"))}><Ic icon={Pencil} size={14} /><span className="name">Edit YAML</span><kbd>E</kbd></button>
      <hr />
      <button className="cluster-option" role="menuitem" onClick={run(() => void copyText(at.o.metadata.name))}><Ic icon={Copy} size={14} /><span className="name">Copy name</span></button>
      {kind === "Secret" ? null : <button className="cluster-option" role="menuitem" onClick={run(onAsk)}><Ic icon={Sparkles} size={14} /><span className="name">Ask Claude</span></button>}
    </div>
  );
}
