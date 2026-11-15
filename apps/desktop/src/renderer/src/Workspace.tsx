// A connected cluster: the sidebar, the main pane (Overview or a list), the details drawer and the agent dock, with
// the width rules that keep the table readable (docs/design.md, "Layout").
import type { ClicklandSettings as ClicklandView, ClusterInfo, DoctorEvidence, HealthProblem, KubeContext, KubeObject } from "@landlens/contracts";
import { Copy, CircleX, Lock, Pencil, ScrollText, Sparkles, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentDock, type AskContext } from "./AgentDock";
import { api, useNow, useWatch, type ApiError } from "./api";
import { ClicklandSettings } from "./ClicklandSettings";
import { Details, type NavTarget } from "./Details";
import { badgeFor, useHealth } from "./health";
import { Ic, RESOURCE_OF_KIND } from "./icons";
import { JumpPalette, type Target, type Verb } from "./JumpPalette";
import { PROMETHEUS_EVENT } from "./MetricsNotice";
import { McpCallDrawer, McpPage, type McpTab } from "./McpPage";
import { AgentPage, type AgentTab } from "./AgentPage";
import { buildNav, CUSTOM, SECTIONS, type NavItem } from "./kinds";
import { useColumns, useCrd, usePins } from "./custom";
import { Overview } from "./Overview";
import { problemContext, PROBLEM_QUESTION } from "./doctorBrief";
import { ProblemDrawer, ProblemsPage } from "./Problems";
import { holdProblem, type HeldProblem, type Severity } from "./problemRules";
import { missingChecks } from "@landlens/kube/checks";
import { splitByShape } from "./present";
import { ResourceTable, rowTone } from "./ResourceTable";
import { Sidebar, type Current } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Bench } from "./Bench";
import { useBench } from "./benchState";
import { useForwards } from "./Forwards";
import { DockGrip } from "./DockGrip";
import { DOCK_KEY, dockMax, dockWidth, readDockWidth } from "./dockWidth";
import { logSourceOf } from "./LogsView";
import { direct, shellable, targetOf } from "./ShellMenu";
import { copyText } from "./present";
import { Toolbar, type StatusFilter } from "./Toolbar";
import { HelmDrawer, HelmPage, useHelmList } from "./Helm";
import { Boundary } from "./Boundary";
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
  const [helmPick, setHelmPick] = useState<{ namespace: string; name: string }>();
  // The Problems page (D58): its severity filter (preset from the status bar) and the problem in its drawer, held when
  // it leaves the report (D59).
  const [severity, setSeverity] = useState<Severity>("all");
  const [problemSel, setProblemSel] = useState<HeldProblem>();
  const [reachError, setReachError] = useState<string>();
  // Choosing or dropping a found Prometheus (MetricsNotice): main checks it is still the one found, then every chart asks again.
  useEffect(() => {
    const on = (e: Event) => {
      const use = (e as CustomEvent<string | null>).detail;
      api.invoke("metrics:prometheus", { handle: cluster.handle, use }).then(
        () => setMetricsVersion((n) => n + 1),
        (err: ApiError) => setReachError(`Prometheus: ${err.message}`),
      );
    };
    window.addEventListener(PROMETHEUS_EVENT, on);
    return () => window.removeEventListener(PROMETHEUS_EVENT, on);
  }, [cluster.handle]);
  useEffect(() => {
    if (!reachError) return;
    const t = setTimeout(() => setReachError(undefined), 6000);
    return () => clearTimeout(t);
  }, [reachError]);
  const [claude, setClaude] = useState<string>();
  const [width, setWidth] = useState({ app: window.innerWidth, main: window.innerWidth - 232, height: window.innerHeight });
  const bench = useBench();
  // The dock's width you chose (wave 6), kept across launches; undefined is the default for the window.
  const [dockChosen, setDockChosen] = useState<number | undefined>(() => readDockWidth(localStorage.getItem(DOCK_KEY)));
  const chooseDock = (w: number | undefined) => {
    setDockChosen(w);
    if (w === undefined) localStorage.removeItem(DOCK_KEY);
    else localStorage.setItem(DOCK_KEY, String(w));
  };
  const forwardsRunning = useForwards(cluster.context).filter((f) => f.state === "running" || f.state === "reconnecting" || f.state === "starting").length;
  const [rowMenu, setRowMenu] = useState<{ o: KubeObject; x: number; y: number }>();
  const [show, setShow] = useState<{ tab: "logs" | "shell" | "edit" | "forward"; container?: string; n: number }>();
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

  const list = typeof current === "object" ? current : undefined;
  const problemsPage = current === "problems";
  const mcp = current === "mcp";
  const helmPage = current === "helm";
  const helm = useHelmList(cluster.handle, namespace, helmPage);
  const helmSel = helmPage && helmPick ? helm.releases?.find((r) => r.namespace === helmPick.namespace && r.name === helmPick.name) : undefined;
  const agentPage = current === "agent";
  const namespaces = useWatch({ handle: cluster.handle, group: "", version: "v1", resource: "namespaces" });
  const scoped = list?.type.namespaced && namespace ? namespace : undefined;
  const watch = useWatch(list ? { handle: cluster.handle, group: list.type.group, version: list.type.version, resource: list.type.resource, ...(scoped ? { namespace: scoped } : {}) } : undefined);
  const pods = list?.type.resource === "pods" && list.type.group === "";
  // A custom kind's columns come from its definition's printer columns (D40).
  const crd = useCrd(cluster.handle, list);
  const { columns, printer } = useColumns(list, crd, watch.items);
  const [pins, togglePin] = usePins(cluster.context);

  const tones = useMemo(() => new Map(list ? watch.items.map((o) => [o.metadata.uid, rowTone(columns, o, now)]) : []), [watch.items, list, columns, now]);
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
    // Known sections, then API groups that aren't custom, then Custom resources last (D38).
    const order = [...SECTIONS, ...[...by.keys()].filter((s) => !SECTIONS.includes(s) && s !== CUSTOM).sort(), CUSTOM];
    return order.filter((s) => by.has(s)).map((s) => [s, by.get(s)!] as const);
  }, [nav]);

  const pick = (c: Current) => leaveEdit(() => {
    setCurrent(c);
    setSelectedNow(undefined);
    setMcpCall(undefined);
    setHelmPick(undefined);
    setProblemSel(undefined);
    setStatus("all");
  });
  /** The Problems page, with a severity preset (the status bar) and a problem's drawer open (a row, ⌘K). */
  const openProblems = (opts: { severity?: Severity; problem?: HealthProblem } = {}) => leaveEdit(() => {
    setCurrent("problems");
    setSelectedNow(undefined);
    setMcpCall(undefined);
    setHelmPick(undefined);
    setStatus("all");
    if (opts.severity) setSeverity(opts.severity);
    if (opts.problem) setSeverity((s) => (s === "all" || s === opts.problem!.tone ? s : "all"));
    setProblemSel(opts.problem ? { id: opts.problem.id, last: opts.problem } : undefined);
  });
  const openSubject = (p: HealthProblem) => go({ kind: p.kind, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) });
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
  /**
   * The palette's object (D45): its kind's list, its drawer, and then the action asked for. The object is read first,
   * so a name that has gone says so instead of opening an empty drawer.
   */
  const reach = async (t: Target, verb?: Verb, container?: string) => {
    const n = nav.find((x) => x.type.group === t.group && x.type.resource === t.resource);
    const ref = { group: t.group, version: t.version, resource: t.resource, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) };
    if (verb === "ask") return ask({ ref, label: `${t.kind} ${t.namespace ? `${t.namespace}/` : ""}${t.name}` });
    if (!n) return;
    let o: KubeObject;
    try {
      o = (await api.invoke("resource:get", { handle: cluster.handle, ref })).object;
    } catch (e) {
      setReachError(`${t.kind} ${t.name}: ${(e as ApiError).message}`);
      return;
    }
    const pod = t.kind === "Pod" && t.group === "";
    if (verb === "shell" && pod) {
      const target = container ? targetOf(o, container, "auto") : direct(o) ?? (() => {
        const c = shellable(o).find((x) => x.running);
        return c ? targetOf(o, c.name, "auto") : undefined;
      })();
      if (target) return bench.openShell(target), focusBench();
    }
    leaveEdit(() => {
      setCurrent(n);
      setMcpCall(undefined);
      setHelmPick(undefined);
      setProblemSel(undefined);
      setStatus("all");
      if (n.type.namespaced && t.namespace && namespace && namespace !== t.namespace) setNamespace(t.namespace);
      setSelectedNow(o);
      if (verb) setShow((s) => ({ tab: verb, ...(container ? { container } : {}), n: (s?.n ?? 0) + 1 }));
    });
  };
  // Switching cluster ends every session (D23): with live terminals, ask once.
  const switchTo = (context: string) => leaveEdit(() => (bench.terminals ? setLeaving(context) : onSwitch(context)));
  /**
   * Ask Claude about a problem (D62, D64): its brief as quoted data, the subject as a reference, and the question sent
   * at once (or left in the box when a turn is running). The drawer passes the log lines it has read.
   */
  const askProblem = (p: HealthProblem, evidence?: DoctorEvidence) => {
    const n = navItem(RESOURCE_OF_KIND[p.kind] ?? "");
    const ref = n ? { group: n.type.group, version: n.type.version, resource: n.type.resource, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) } : undefined;
    // One problem at a time: an earlier problem's chip gives way to this one.
    setAskContext((cs) => [...cs.filter((c) => c.kind !== "problem"), problemContext(p, ref, evidence)]);
    setDock(true);
    setPrompt({ id: Date.now(), text: PROBLEM_QUESTION });
  };

  // Width rules: the table keeps at least ~600px. Drawer and dock together fold the sidebar to a rail; below 1280px
  // the dock alone does, and the drawer floats over the table.
  const drawer = !!(selected && list) || !!(mcp && mcpCall) || !!helmSel || !!(problemsPage && problemSel);
  const narrow = width.app < 1280;
  const autoRail = dock && (drawer || narrow);
  const rail = userRail ?? autoRail;
  useEffect(() => setUserRail(undefined), [dock, drawer, narrow]);
  const dockW = dockWidth(dockChosen, width.app, drawer, narrow);
  const dockLimit = dockMax(width.app, drawer, narrow);

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
        if (k === "3") return e.preventDefault(), pick("problems");
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
      if (e.key === "Escape" && !jump && !t?.closest(".dock") && helmPick) setHelmPick(undefined);
      if (e.key === "Escape" && !jump && !creating && !typing && !t?.closest(".dock, .drawer .logs") && problemSel) setProblemSel(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const h = health.health;
  // Keep the drawer's problem current; when its id leaves the report, keep the last one with the time it went.
  useEffect(() => setProblemSel((held) => holdProblem(held, h?.problems, Date.now())), [h]);
  const bad = h?.problems.filter((p) => p.tone === "bad").length ?? 0;
  const warn = (h?.problems.length ?? 0) - bad;
  const worst = h?.problems.find((p) => p.tone === "bad");
  const suggestion = worst ? (worst.class === "crashloop" ? `Why is ${worst.kind === "Pod" ? splitByShape(worst.name).base : worst.name} crash-looping?` : `What's wrong with ${worst.kind.toLowerCase()} ${worst.name}?`) : undefined;
  const nsList = useMemo(() => namespaces.items.map((n) => n.metadata.name).sort(), [namespaces.items]);
  const label = list?.label ?? (mcp ? "MCP" : agentPage ? "Agent" : helmPage ? "Helm releases" : problemsPage ? "Problems" : "Overview");

  return (
    <div ref={app}
      className={"app" + (rail ? " sidebar-rail" : "") + (narrow ? " narrow" : "") + (dock ? " with-dock" : "") + (drawer ? " with-drawer" : "") + (bench.open ? " with-bench" : "") + (bench.open && bench.max ? " bench-max" : "") + (width.height < 760 ? " short" : "")}
      style={{
        "--dock-w": `${dockW}px`,
        ...(bench.height ? { "--bench-h": `${Math.min(bench.height, Math.max(160, width.height - 48 - 4 * 32 - 26))}px` } : {}),
      } as React.CSSProperties}>
      <Sidebar
        cluster={cluster}
        contexts={contexts}
        nodes={h?.nodes?.total}
        sections={sections}
        current={current}
        navError={navError}
        rail={rail}
        badges={{
          problems: h ? badgeFor(h.problems) : undefined,
          byResource: h ? {
            pods: badgeFor(h.problems, "Pod"), deployments: badgeFor(h.problems, "Deployment"), statefulsets: badgeFor(h.problems, "StatefulSet"),
            daemonsets: badgeFor(h.problems, "DaemonSet"), jobs: badgeFor(h.problems, "Job"), nodes: badgeFor(h.problems, "Node"),
            secrets: badgeFor(h.problems, "Secret"), persistentvolumeclaims: badgeFor(h.problems, "PersistentVolumeClaim"),
          } : {},
        }}
        onPick={pick}
        onToggle={() => setUserRail(!rail)}
        onSwitch={switchTo}
        onJump={() => setJump(true)}
        pins={pins}
        onPin={togglePin}
      />
      <main className="main" ref={main}>
        <Toolbar
          title={label}
          {...(list ? { count: watch.loading ? undefined : shown.length } : helmPage ? { count: helm.releases?.length, onRefresh: helm.refresh } : mcp || agentPage ? { hideCount: true } : problemsPage ? { ...(h ? { count: h.problems.length, updatedAt: h.at } : {}), onRefresh: health.refresh } : h ? { updatedAt: h.at } : {})}
          {...(pods && !watch.loading ? { seg: { value: status, ...segCounts, onChange: setStatus } } : {})}
          {...(!mcp && !agentPage && (!list || list.type.namespaced) ? { namespaces: { list: nsList, value: namespace, onChange: (ns: string) => leaveEdit(() => { setNamespace(ns); setSelectedNow(undefined); setProblemSel(undefined); }) } } : {})}
          {...(list || helmPage || problemsPage ? { filter: { value: filter, onChange: setFilter, ref: filterBox, short: width.main < 860 } } : {})}
          {...(dock ? {} : { onAsk: () => setDock(true) })}
          {...(!mcp && !agentPage && !helmPage && !problemsPage ? { onCreate: () => setCreating(true) } : {})}
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
        ) : helmPage ? (
          <HelmPage
            list={helm}
            filter={filter}
            namespace={namespace}
            now={now}
            width={width.main}
            {...(helmSel ? { selected: `${helmSel.namespace}/${helmSel.name}` } : {})}
            onSelect={(r) => setHelmPick(r ? { namespace: r.namespace, name: r.name } : undefined)}
          />
        ) : problemsPage ? (
          <ProblemsPage
            health={h}
            error={health.error}
            now={now}
            text={filter}
            severity={severity}
            onSeverity={setSeverity}
            {...(problemSel ? { selected: problemSel.id } : {})}
            onSelect={(p) => setProblemSel({ id: p.id, last: p })}
            onAsk={askProblem}
            onOpen={openSubject}
            onClearText={() => setFilter("")}
            {...(health.error && h ? { stale: health.error.message } : {})}
          />
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
            onOpenProblem={(p) => openProblems({ problem: p })}
            onAskProblem={askProblem}
            onSeeAll={() => openProblems()}
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
          <Boundary what="this list" resetKey={list ? `${list.type.group}/${list.type.resource}` : ""}>
          <ResourceTable
            resource={list.type.resource}
            columns={columns}
            items={shown}
            now={now}
            loading={watch.loading}
            selected={selected?.metadata.uid}
            width={width.main}
            {...(narrow && dock && drawer ? { covered: dockW + 12 } : {})}
            oneNamespace={!!scoped}
            empty={{
              title: `No ${list.label.toLowerCase()}${scoped ? ` in ${scoped}` : ""}${filter.trim() ? ` matching “${filter.trim()}”` : status !== "all" ? ` ${status === "bad" ? "failing" : "pending"}` : ""}`,
              ...(filter.trim() || status !== "all" ? { onClear: () => (setFilter(""), setStatus("all")) } : {}),
            }}
            onSelect={setSelected}
            onMenu={(o, x, y) => setRowMenu({ o, x, y })}
            onAction={act}
          />
          </Boundary>
        )}
      </main>
      <StatusBar
          server={cluster.server}
          watching={list ? (watch.error ? "Not watching" : `Watching ${list.label.toLowerCase()} · live`) : mcp ? "MCP calls · live" : helmPage ? (helm.error ? "Not reading" : "Reading Helm releases every 30s") : agentPage ? "Agent settings" : "Checking health every 10s"}
          {...(claude ? { claude } : {})}
          bad={bad}
          warn={warn}
          onProblems={(tone) => openProblems({ severity: tone })}
          clickland={!!clickland?.hasKey}
          onMetrics={() => setSettings(true)}
          sessions={bench.sessions}
          panelOpen={bench.open}
          onSessions={() => (bench.setOpen(true), focusBench())}
          forwards={forwardsRunning}
          onForwards={() => bench.openForwards()}
        />
      {selected && list ? (
        <Boundary what="this object" resetKey={selected?.metadata.uid}>
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
          printer={printer}
          onOpenKind={(group, resource) => {
            const n = nav.find((x) => x.type.group === group && x.type.resource === resource);
            if (n) pick(n);
          }}
          onLogsInPanel={(s) => (bench.openLogs(s), focusBench())}
          {...(show ? { show } : {})}
        />
        </Boundary>
      ) : null}
      {helmSel ? (
        <Boundary what="this release" resetKey={`${helmSel.namespace}/${helmSel.name}`}>
          <HelmDrawer handle={cluster.handle} release={helmSel} now={now} onClose={() => setHelmPick(undefined)} onAsk={ask} onNavigate={go} />
        </Boundary>
      ) : null}
      {problemsPage && problemSel ? (
        <Boundary what="this problem" resetKey={problemSel.id}>
          <ProblemDrawer
            handle={cluster.handle}
            namespace={namespace}
            held={problemSel}
            cut={!!h?.cut}
            {...(health.error && h ? { stale: health.error.message } : {})}
            now={now}
            onClose={() => setProblemSel(undefined)}
            onAsk={askProblem}
            onOpen={openSubject}
            onNavigate={go}
            onFullLogs={(pod, ns, container) => void reach({ group: "", version: "v1", resource: "pods", kind: "Pod", name: pod, ...(ns ? { namespace: ns } : {}) }, "logs", container)}
          />
        </Boundary>
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
          grip={<DockGrip width={dockW} max={dockLimit} onWidth={chooseDock} />}
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
        <JumpPalette
          handle={cluster.handle}
          context={cluster.context}
          {...(contexts ? { contexts } : {})}
          nav={nav}
          current={current}
          items={watch.items}
          problems={h?.problems ?? []}
          problemsEmpty={!h ? (health.error ? "Couldn't check this cluster's problems" : "Still checking for problems…") : missingChecks(h.checks).length ? "No problems found, but some checks were skipped" : "No problems found"}
          onProblem={(p) => openProblems({ problem: p })}
          onAskProblem={askProblem}
          onOpenSubject={openSubject}
          {...(selected && list ? { open: { group: list.type.group, version: list.type.version, resource: list.type.resource, kind: list.type.kind, name: selected.metadata.name, ...(selected.metadata.namespace ? { namespace: selected.metadata.namespace } : {}) } } : {})}
          onPick={pick}
          onOpen={(t) => void reach(t)}
          onAct={(t, verb, container) => void reach(t, verb, container)}
          onSwitch={switchTo}
          commands={{
            togglePanel: () => (bench.open ? bench.setOpen(false) : (bench.setOpen(true), focusBench())),
            newTerminal: () => (bench.openLocal(), focusBench()),
            createYaml: () => setCreating(true),
            toggleSidebar: () => setUserRail(!rail),
            openDock: () => setDock(true),
            showForwards: () => (bench.openForwards(), focusBench()),
            showProblems: () => openProblems(),
          }}
          onClose={() => setJump(false)}
        />
      ) : null}
      {reachError ? (
        <div className="notice reach-error" role="alert">
          <Ic icon={CircleX} size={15} className="tone-bad" />
          <div className="notice-body"><strong>{reachError.startsWith("Prometheus:") ? "Couldn't change the Prometheus." : "Couldn't open it."}</strong><p>{reachError}</p></div>
        </div>
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
