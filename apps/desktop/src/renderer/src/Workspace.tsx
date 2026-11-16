// A connected cluster: the sidebar, the main pane (Overview or a list), the details drawer and the agent dock, with
// the width rules that keep the table readable (docs/design.md, "Layout").
import type { ActionKind, ClicklandSettings as ClicklandView, ClusterInfo, DoctorEvidence, HealthProblem, KubeContext, KubeObject, ResourceType } from "@landlens/contracts";
import { CircleX, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentDock, type AskContext } from "./AgentDock";
import { api, useNow, useWatch, useWatchMany, type ApiError } from "./api";
import { ClicklandSettings } from "./ClicklandSettings";
import { Details, type NavTarget } from "./Details";
import { badgeFor, useHealth } from "./health";
import { Ic, RESOURCE_OF_KIND } from "./icons";
import { JumpPalette, type Target, type Verb } from "./JumpPalette";
import { PROMETHEUS_EVENT } from "./MetricsNotice";
import { ConnectionsPage } from "./ConnectionsPage";
import { McpCallDrawer, McpPage, type McpTab } from "./McpPage";
import { GcpDrawer, GcpPage, type GcpNav, type GcpPick, type GcpRows } from "./GcpPage";
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
import { Sidebar, useNavFolds, type Current } from "./Sidebar";
import { allSections, BADGED } from "./navState";
import { StatusBar } from "./StatusBar";
import { Bench } from "./Bench";
import { useBench } from "./benchState";
import { useForwards } from "./Forwards";
import { DockGrip } from "./DockGrip";
import { DOCK_KEY, dockMax, dockWidth, readDockWidth } from "./dockWidth";
import { logSourceOf } from "./LogsView";
import { direct, shellable, targetOf } from "./ShellMenu";
import { Toolbar, type StatusFilter } from "./Toolbar";
import { HelmDrawer, HelmPage, useHelmList } from "./Helm";
import { Boundary } from "./Boundary";
import { CreateSheet } from "./CreateSheet";
import { leaveEdit } from "./editGuard";
import { clicklandScope, useClickland } from "./clickland";
import { useLandflow, useSent } from "./landflow";
import { TriageSheet } from "./TriageSheet";
import { FlowSheet, type FlowSubject } from "./FlowSheet";
import { ActionSheet } from "./ActionSheet";
import { useDrainRuns } from "./DrainPlanView";
import type { ActionDraft } from "./actionAsks";
import { ObjectMenu } from "./ObjectMenu";
import { RecentActions, useActionLog } from "./RecentActions";
import { isActionVerb } from "./paletteRules";
import {
  bulkActions, chosenSort, hiddenOf, kindKey, listKey, loadTableState, namespacesOf, nsKey, own, pruned, selectionFor, unwatchedTitle, updateTableState,
  withHidden, withNamespaces, withSort, type Selection, type Sort, type TableState,
} from "./tableState";
import { objectContext, presetAsk, SELECTION_QUESTION, selectionContext, type PresetId } from "./askPresets";

const FIRST_QUESTION = "What's wrong in this cluster right now?";

export function Workspace({ cluster, contexts, onSwitch, onCatalog }: { cluster: ClusterInfo; contexts?: KubeContext[]; onSwitch: (context: string) => void; onCatalog?: () => void }) {
  const now = useNow();
  const [nav, setNav] = useState<NavItem[]>([]);
  const [navError, setNavError] = useState<string>();
  const [current, setCurrent] = useState<Current>("overview");
  // What the tables remember (wave 8 part 3, D155): columns hidden and sort per kind, namespaces per cluster. Each
  // choice is applied to the value as stored, read again first, so another window's choices stay (review of part 3,
  // L8); written back on each choice, never from inside a state updater.
  const [tables, setTables] = useState<TableState>(() => loadTableState(localStorage));
  const changeTables = (change: (s: TableState) => TableState) => setTables(updateTableState(localStorage, tables, change));
  // The namespaces chosen (D158): none is every namespace. `namespace` is the one chosen when exactly one is, for
  // everything that takes one scope (health, Helm, Create, triage, flows); with several those see the whole cluster.
  // Kept per cluster (its context and server), read as the map's own key only (L1, L8).
  const tablesKey = nsKey(cluster.context, cluster.server);
  const namespaces = useMemo(() => namespacesOf(tables, cluster.context, cluster.server), [tables, cluster.context, cluster.server]);
  const setNamespaces = (ns: string[]) => changeTables((s) => withNamespaces(s, tablesKey, ns));
  const namespace = namespaces.length === 1 ? namespaces[0]! : "";
  const several = namespaces.length > 1;
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
  const [prompt, setPrompt] = useState<{ id: number; text: string; draft?: true }>();
  const [userRail, setUserRail] = useState<boolean>();
  const [jump, setJump] = useState(false);
  const [mcpTab, setMcpTab] = useState<McpTab>("servers");
  const [agentTab, setAgentTab] = useState<AgentTab>("skills");
  const [mcpCall, setMcpCall] = useState<string>();
  const [helmPick, setHelmPick] = useState<{ namespace: string; name: string }>();
  // Google Cloud (docs/gcp.md): the project and type shown, the resource in the drawer, and the rows read (for ⌘K).
  const [gcpNav, setGcpNav] = useState<GcpNav>({});
  const [gcpPick, setGcpPick] = useState<GcpPick>();
  const [gcpRows, setGcpRows] = useState<GcpRows>();
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
  // The object menu (wave 8, D146): a row's right-click or Shift+F10, or the drawer's ⋯ (which leaves out its tabs).
  // It belongs to the list it was opened on (`lk`): a change of page, kind or namespaces closes it, so its actions
  // never take the next list's kind (security review of part 3, L2).
  const [rowMenu, setRowMenu] = useState<{ o: KubeObject; x: number; y: number; drawer?: true; lk: string }>();
  // Your actions (wave 8, D145, D147): the sheet, and Recent actions read again after each apply.
  const [actionOn, setActionOn] = useState<ActionDraft>();
  const [actionsVersion, setActionsVersion] = useState(0);
  const [recentOpen, setRecentOpen] = useState(false);
  const actionLog = useActionLog(cluster.handle, actionsVersion);
  // Drains running in main from this window (M4): the status bar's chip re-opens one, with Stop.
  const drains = useDrainRuns(cluster.handle);
  const [show, setShow] = useState<{ tab: "logs" | "shell" | "edit" | "forward"; container?: string; n: number }>();
  const [leaving, setLeaving] = useState<string>();
  const beforeBench = useRef<HTMLElement | null>(null);
  const app = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const health = useHealth(cluster.handle, namespace);
  // An account limited to some namespaces can't read the whole cluster (wave 6): open its context's namespace once,
  // as kubectl would, and keep that namespace in the picker even when the namespace list can't be read.
  const ctxNamespace = contexts?.find((c) => c.name === cluster.context)?.namespace;
  const triedCtxNamespace = useRef(false);
  useEffect(() => {
    if (namespaces.length || health.error?.status !== 403 || !ctxNamespace || triedCtxNamespace.current) return;
    triedCtxNamespace.current = true;
    setNamespaces([ctxNamespace]);
  }, [namespaces, health.error, ctxNamespace]); // eslint-disable-line react-hooks/exhaustive-deps
  // Graphs: the Clickland dialog, and a version every chart refetches on when its settings change.
  const [clickland, setClickland] = useState<ClicklandView>();
  const [settings, setSettings] = useState(false);
  const [metricsVersion, setMetricsVersion] = useState(0);
  const ck = useClickland();
  // Landflow on a resource (wave 7 part 4): Send to triage… on a problem, Run a Landflow flow… on an object.
  const lf = useLandflow();
  const sent = useSent(cluster.handle);
  const [triage, setTriage] = useState<HealthProblem>();
  const [flowOn, setFlowOn] = useState<FlowSubject>();
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
  const connPage = current === "connections";
  const helmPage = current === "helm";
  const gcpPage = current === "gcp";
  const helmAll = useHelmList(cluster.handle, namespace, helmPage);
  // Several namespaces: Helm reads the whole cluster, shown for the chosen ones.
  const helm = useMemo(() => (several && helmAll.releases ? { ...helmAll, releases: helmAll.releases.filter((r) => namespaces.includes(r.namespace)) } : helmAll), [helmAll, several, namespaces]);
  const helmSel = helmPage && helmPick ? helm.releases?.find((r) => r.namespace === helmPick.namespace && r.name === helmPick.name) : undefined;
  const agentPage = current === "agent";
  const nsWatch = useWatch({ handle: cluster.handle, group: "", version: "v1", resource: "namespaces" });
  const scoped = list?.type.namespaced && namespace ? namespace : undefined;
  // One namespace: its watch; two to eight: one each, merged; more: the cluster's, filtered (D158).
  const watch = useWatchMany(list ? { handle: cluster.handle, group: list.type.group, version: list.type.version, resource: list.type.resource } : undefined, list?.type.namespaced ? namespaces : []);
  // The kind's remembered columns and sort (D157).
  const kk = list ? kindKey(list.type) : "";
  const hidden = useMemo(() => hiddenOf(tables, kk), [tables, kk]);
  const sort: Sort = chosenSort(tables, kk);
  // The selection (D156): uids of this list only. It is read for the list it was made on (`lk`), so it is empty after a
  // change of kind or namespaces (the cluster's own Workspace is keyed by its handle); a row the table stops showing
  // leaves it (below, review of part 3, M2).
  const lk = listKey(kk, namespaces);
  const [sel, setSel] = useState<Selection>({ key: "", uids: new Set() });
  const picked = selectionFor(sel, lk);
  const setPicked = (next: ReadonlySet<string> | ((p: ReadonlySet<string>) => ReadonlySet<string>)) => setSel((s) => {
    const cur = selectionFor(s, lk);
    const uids = typeof next === "function" ? next(cur) : next;
    return uids === cur && s.key === lk ? s : { key: lk, uids };
  });
  useEffect(() => setRowMenu(undefined), [current, lk]);
  const pods = list?.type.resource === "pods" && list.type.group === "";
  // A custom kind's columns come from its definition's printer columns (D40).
  const crd = useCrd(cluster.handle, list);
  const { columns, printer } = useColumns(list, crd, watch.items);
  const [pins, togglePin] = usePins(cluster.context);
  const navFolds = useNavFolds(cluster.context);

  const tones = useMemo(() => new Map(list ? watch.items.map((o) => [o.metadata.uid, rowTone(columns, o, now)]) : []), [watch.items, list, columns, now]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return watch.items.filter((o) =>
      (!f || o.metadata.name.toLowerCase().includes(f) || (o.metadata.namespace ?? "").toLowerCase().includes(f)) &&
      (!pods || status === "all" || tones.get(o.metadata.uid) === status));
  }, [watch.items, filter, status, pods, tones]);
  // The selection is of rows shown (review of part 3, M2, amending D156): a row that leaves the filter, the status
  // segment or the watch leaves the selection, so the bar's count and a bulk are of rows you can see.
  useEffect(() => setPicked((p) => pruned(p, shown.map((o) => o.metadata.uid))), [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickedObjects = useMemo(() => shown.filter((o) => picked.has(o.metadata.uid)), [shown, picked]);
  const segCounts = useMemo(() => {
    let bad = 0, warn = 0;
    for (const t of tones.values()) t === "bad" ? bad++ : t === "warn" ? warn++ : 0;
    return { all: watch.items.length, bad, warn };
  }, [tones, watch.items.length]);

  // Keep the drawer showing the live object; open the one a link or an Overview row asked for once its list arrives.
  const live = selected && watch.items.find((o) => o.metadata.uid === selected.metadata.uid);
  useEffect(() => {
    // Wait for every namespace's watch (L6 shows rows before all have answered).
    if (!want || !list || watch.loading || watch.partial) return;
    const o = watch.items.find((x) => x.metadata.name === want.name && (!want.namespace || x.metadata.namespace === want.namespace));
    if (o) setSelectedNow(o);
    setWant(undefined);
  }, [want, watch.items, watch.loading, watch.partial, list]);

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
    setGcpPick(undefined);
    setStatus("all");
  });
  /** A Google Cloud resource from ⌘K: its project on the page, and its drawer. */
  const openGcp = (project: string, resource: GcpPick["resource"]) => leaveEdit(() => {
    setCurrent("gcp");
    setSelectedNow(undefined);
    setMcpCall(undefined);
    setHelmPick(undefined);
    setProblemSel(undefined);
    setGcpNav((n) => (n.project === project && !n.type ? n : { project }));
    setGcpPick({ project, resource });
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
    const n = navItem(own(RESOURCE_OF_KIND, t.kind) ?? "");
    if (!n) return;
    pick(n);
    if (n.type.namespaced && t.namespace && namespaces.length && !namespaces.includes(t.namespace)) setNamespaces(several ? [...namespaces, t.namespace] : [t.namespace]);
    setWant(t);
  };
  const ask = (ctx: AskContext) => {
    // Chosen lines replace a chip with the same label; an object is added once.
    setAskContext((cs) => (ctx.text ? [...cs.filter((c) => c.label !== ctx.label), ctx] : cs.some((c) => c.label === ctx.label) ? cs : [...cs, ctx]));
    setDock(true);
  };
  /** The drawer for this object, asked to show its logs or open a shell (from a row's menu or its keys). */
  const act = (o: KubeObject, action: "logs" | "shell" | "edit" | "delete") => {
    if (!list) return;
    if (action === "delete") return startAction(list.type, o, "delete");
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
  /** Your action on one object: the sheet over the main pane; nothing is sent until its review is applied (D145). */
  const startAction = (type: ResourceType, o: KubeObject, kind: ActionKind, flag?: boolean) =>
    setActionOn({
      kind, type, objects: [o],
      ...(kind === "suspend" ? { suspend: !!flag } : {}),
      // Cordon or uncordon (D149): as asked, else by the node's state.
      ...(kind === "cordon" ? { on: flag ?? o.spec?.unschedulable !== true } : {}),
    });
  /**
   * A preset ask (D159): the object attached exactly as Ask Claude attaches it, and the preset's fixed question, sent at
   * once (or left in the box while a turn runs). Never a Secret: the menus don't offer it, and this refuses it too.
   */
  const askPreset = (ctx: AskContext, id: PresetId) => {
    const p = presetAsk(ctx, id);
    if (!p) return;
    ask(p.context);
    setPrompt({ id: Date.now(), text: p.question });
  };
  /** Restart or Delete on the selected rows (D156): one sheet, one review with a target per object. */
  const startBulk = (kind: "restart" | "delete") => {
    if (!list || !pickedObjects.length) return;
    setActionOn({ kind, type: list.type, objects: pickedObjects });
  };
  /**
   * "Ask Claude about these N" (D160): names and the table's Status and Ready words as quoted data, no object attached;
   * the box opens with "What do these have in common?" selected, for you to overwrite. Never on Secrets.
   */
  const askSelection = () => {
    if (!list) return;
    const c = selectionContext(list.type, pickedObjects, columns, now);
    if (!c) return;
    setAskContext((cs) => [...cs.filter((x) => x.kind !== "selection"), c]);
    setDock(true);
    setPrompt({ id: Date.now(), text: SELECTION_QUESTION, draft: true });
  };
  /** "Ask Claude first" (D148): the review as quoted data, the object, and the action's question. */
  const askFirst = (contexts: AskContext[], question: string) => {
    setAskContext((cs) => [...cs.filter((c) => c.kind !== "action" && !contexts.some((x) => x.label === c.label)), ...contexts]);
    setDock(true);
    setPrompt({ id: Date.now(), text: question });
  };
  /**
   * The palette's object (D45): its kind's list, its drawer, and then the action asked for. The object is read first,
   * so a name that has gone says so instead of opening an empty drawer.
   */
  const reach = async (t: Target, verb?: Verb, container?: string, preset?: PresetId) => {
    const n = nav.find((x) => x.type.group === t.group && x.type.resource === t.resource);
    const ref = { group: t.group, version: t.version, resource: t.resource, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) };
    if (verb === "ask") return preset ? askPreset({ ref, label: `${t.kind} ${t.namespace ? `${t.namespace}/` : ""}${t.name}` }, preset) : ask({ ref, label: `${t.kind} ${t.namespace ? `${t.namespace}/` : ""}${t.name}` });
    if (!n) return;
    let o: KubeObject;
    try {
      o = (await api.invoke("resource:get", { handle: cluster.handle, ref })).object;
    } catch (e) {
      setReachError(`${t.kind} ${t.name}: ${(e as ApiError).message}`);
      return;
    }
    if (isActionVerb(verb)) return verb === "uncordon" ? startAction(n.type, o, "cordon", false) : startAction(n.type, o, verb, verb === "cordon" ? true : undefined);
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
      if (n.type.namespaced && t.namespace && namespaces.length && !namespaces.includes(t.namespace)) setNamespaces(several ? [...namespaces, t.namespace] : [t.namespace]);
      setSelectedNow(o);
      if (verb && !isActionVerb(verb)) setShow((s) => ({ tab: verb, ...(container ? { container } : {}), n: (s?.n ?? 0) + 1 }));
    });
  };
  // Switching cluster ends every session (D23): with live terminals, ask once.
  const switchTo = (context: string) => leaveEdit(() => (bench.terminals ? setLeaving(context) : onSwitch(context)));
  /**
   * Ask Claude about a problem (D62, D64): its brief as quoted data, the subject as a reference, and the question sent
   * at once (or left in the box when a turn is running). The drawer passes the log lines it has read.
   */
  const askProblem = (p: HealthProblem, evidence?: DoctorEvidence) => {
    const n = navItem(own(RESOURCE_OF_KIND, p.kind) ?? "");
    const ref = n ? { group: n.type.group, version: n.type.version, resource: n.type.resource, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) } : undefined;
    // One problem at a time: an earlier problem's chip gives way to this one.
    setAskContext((cs) => [...cs.filter((c) => c.kind !== "problem"), problemContext(p, ref, evidence)]);
    setDock(true);
    setPrompt({ id: Date.now(), text: PROBLEM_QUESTION });
  };

  /**
   * Ask Claude about a Google Cloud resource (D94): main's brief as quoted data, one resource at a time, and the
   * question sent at once (or left in the box when a turn is running).
   */
  const askGcp = (ctx: AskContext, question: string) => {
    setAskContext((cs) => [...cs.filter((c) => c.kind !== "gcp"), ctx]);
    setDock(true);
    setPrompt({ id: Date.now(), text: question });
  };
  const gkeContexts = useMemo(() => new Set((contexts ?? []).filter((c) => c.source === "gke").map((c) => c.name)), [contexts]);

  // Width rules: the table keeps at least ~600px. Drawer and dock together fold the sidebar to a rail; below 1280px
  // the dock alone does, and the drawer floats over the table.
  const drawer = !!(selected && list) || !!(mcp && mcpCall) || !!helmSel || !!(problemsPage && problemSel) || !!(gcpPage && gcpPick);
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
      // Esc clears a selection before it closes the drawer (D156).
      if (e.key === "Escape" && !jump && !creating && !actionOn && !typing && picked.size && !t?.closest(".dock, .drawer .logs-pane, .yaml-edit, .change.mine, .menu")) return setPicked(new Set());
      if (e.key === "Escape" && !jump && !creating && !t?.closest(".dock, .drawer .logs-pane, .yaml-edit, .change.mine") && selected) setSelected(undefined);
      if (e.key === "Escape" && !jump && !t?.closest(".dock") && mcpCall) setMcpCall(undefined);
      if (e.key === "Escape" && !jump && !t?.closest(".dock") && helmPick) setHelmPick(undefined);
      if (e.key === "Escape" && !jump && !typing && !t?.closest(".dock, .dialog, .cm-editor") && gcpPick) setGcpPick(undefined);
      if (e.key === "Escape" && !jump && !creating && !typing && !t?.closest(".dock, .drawer .logs") && problemSel) setProblemSel(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Several namespaces: health is the whole cluster's; its problems are shown for the chosen ones (and the cluster's own).
  const hAll = health.health;
  const h = useMemo(() => (hAll && several ? { ...hAll, problems: hAll.problems.filter((p) => !p.namespace || namespaces.includes(p.namespace)) } : hAll), [hAll, several, namespaces]);
  // Keep the drawer's problem current; when its id leaves the report, keep the last one with the time it went.
  useEffect(() => setProblemSel((held) => holdProblem(held, h?.problems, Date.now())), [h]);
  const bad = h?.problems.filter((p) => p.tone === "bad").length ?? 0;
  const warn = (h?.problems.length ?? 0) - bad;
  const worst = h?.problems.find((p) => p.tone === "bad");
  const suggestion = worst ? (worst.class === "crashloop" ? `Why is ${worst.kind === "Pod" ? splitByShape(worst.name).base : worst.name} crash-looping?` : `What's wrong with ${worst.kind.toLowerCase()} ${worst.name}?`) : undefined;
  const nsList = useMemo(() => [...new Set([...nsWatch.items.map((n) => n.metadata.name), ...(ctxNamespace ? [ctxNamespace] : []), ...namespaces])].sort(), [nsWatch.items, ctxNamespace, namespaces]);
  const label = list?.label ?? (mcp ? "MCP" : connPage ? "Connections" : gcpPage ? "Google Cloud" : agentPage ? "Agent" : helmPage ? "Helm releases" : problemsPage ? "Problems" : "Overview");

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
        {...(onCatalog ? { onMenu: onCatalog } : {})}
        nodes={h?.nodes?.total}
        sections={sections}
        current={current}
        navError={navError}
        rail={rail}
        badges={{
          problems: h ? badgeFor(h.problems) : undefined,
          byResource: h ? Object.fromEntries(Object.entries(BADGED).map(([resource, kind]) => [resource, badgeFor(h.problems, kind)])) : {},
          all: h?.problems ?? [],
        }}
        nav={navFolds}
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
          {...(list ? { count: watch.loading ? undefined : shown.length } : helmPage ? { count: helm.releases?.length, onRefresh: helm.refresh } : mcp || agentPage || connPage || gcpPage ? { hideCount: true } : problemsPage ? { ...(h ? { count: h.problems.length, updatedAt: h.at } : {}), onRefresh: health.refresh } : h ? { updatedAt: h.at } : {})}
          {...(pods && !watch.loading ? { seg: { value: status, ...segCounts, onChange: setStatus } } : {})}
          {...(!mcp && !agentPage && !connPage && !gcpPage && (!list || list.type.namespaced) ? { namespaces: {
            list: nsList, value: namespaces, onChange: (ns: string[]) => leaveEdit(() => { setNamespaces(ns); setSelectedNow(undefined); setProblemSel(undefined); }),
            ...(list ? { unwatched: [...(watch.left ?? []), ...(watch.refused ?? [])] } : {}),
          } } : {})}
          {...(list && !watch.error ? { columns: { all: columns.map((c) => ({ id: c.id, label: c.label })), hidden: [...hidden], onChange: (ids: string[]) => changeTables((s) => withHidden(s, kk, ids)) } } : {})}
          {...(list && picked.size ? { selection: {
            count: picked.size, actions: bulkActions(list.type), onAction: startBulk, onClear: () => setPicked(new Set()),
            ...(list.type.group === "" && list.type.resource === "secrets" ? {} : { onAsk: askSelection }),
          } } : {})}
          {...(list || helmPage || problemsPage ? { filter: { value: filter, onChange: setFilter, ref: filterBox, short: width.main < 860 } } : {})}
          {...(dock ? {} : { onAsk: () => setDock(true) })}
          {...(!mcp && !agentPage && !connPage && !gcpPage && !helmPage && !problemsPage ? { onCreate: () => setCreating(true) } : {})}
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
            onOpenConnections={() => pick("connections")}
            version={metricsVersion}
          />
        ) : connPage ? (
          <ConnectionsPage context={cluster.context} handle={cluster.handle} onOpenMcp={() => (setMcpTab("calls"), pick("mcp"))} onOpenGcp={() => pick("gcp")} />
        ) : gcpPage ? (
          <Boundary what="Google Cloud" resetKey="gcp">
            <GcpPage nav={gcpNav} onNav={setGcpNav} {...(gcpPick ? { selected: gcpPick.resource.name } : {})} onSelect={setGcpPick} onRows={setGcpRows} width={width.main} />
          </Boundary>
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
            sent={sent}
            {...(lf.triage ? { onTriage: setTriage } : {})}
          />
        ) : !list ? (
          <Overview
            handle={cluster.handle}
            metricsVersion={metricsVersion}
            onSettings={() => setSettings(true)}
            health={hAll}
            error={health.error}
            scoped={namespaces.length > 0}
            {...(several ? { several: namespaces.length } : {})}
            onNamespace={(ns) => (setNamespaces([ns]), setSelectedNow(undefined))}
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
            hidden={hidden}
            sort={sort}
            onSort={(s) => changeTables((t) => withSort(t, kk, s))}
            selection={{ uids: picked, onChange: setPicked }}
            empty={{
              title: `No ${list.label.toLowerCase()}${scoped ? ` in ${scoped}` : list.type.namespaced && several ? ` in ${namespaces.length} namespaces` : ""}${filter.trim() ? ` matching “${filter.trim()}”` : status !== "all" ? ` ${status === "bad" ? "failing" : "pending"}` : ""}`,
              ...(filter.trim() || status !== "all" ? { onClear: () => (setFilter(""), setStatus("all")) } : {}),
            }}
            onSelect={setSelected}
            onMenu={(o, x, y) => setRowMenu({ o, x, y, lk })}
            onAction={act}
          />
          </Boundary>
        )}
      </main>
      <StatusBar
          server={cluster.server}
          {...(list && unwatchedTitle(watch) ? { watchingTitle: unwatchedTitle(watch)! } : {})}
          watching={list ? (watch.error ? "Not watching" : watch.cut ? `Watching ${list.label.toLowerCase()} in the first 8 namespaces · ${watch.cut} left out: your role can't list across namespaces` : watch.failed ? `Watching ${list.label.toLowerCase()} · live · ${watch.failed} namespace${watch.failed === 1 ? "" : "s"} refused` : `Watching ${list.label.toLowerCase()} · live`) : mcp ? "MCP calls · live" : connPage ? "Connections" : gcpPage ? "Google Cloud · read-only" : helmPage ? (helm.error ? "Not reading" : "Reading Helm releases every 30s") : agentPage ? "Agent settings" : "Checking health every 10s"}
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
          actions={actionLog.since}
          actionsOpen={recentOpen}
          onActions={() => setRecentOpen((v) => !v)}
          drains={drains.map((d) => ({ run: d.progress.run, node: d.progress.node }))}
          onDrain={(run) => {
            const d = drains.find((x) => x.progress.run === run);
            if (!d) return;
            const t = nav.find((x) => x.type.group === "" && x.type.resource === "nodes")?.type ?? { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false, verbs: [] };
            setActionOn({ kind: "drain", type: t, objects: [{ metadata: { name: d.progress.node, uid: run } } as KubeObject], run });
          }}
        />
      {recentOpen ? (
        <RecentActions entries={actionLog.entries} onClose={() => setRecentOpen(false)}
          onOpen={(e) => {
            // The row's own group and resource, never its kind alone: kinds repeat across groups (L8).
            const n = nav.find((x) => x.type.group === (e.group ?? "") && x.type.resource === e.resource);
            if (n) void reach({ group: n.type.group, version: n.type.version, resource: n.type.resource, kind: n.type.kind, name: e.names[0]!, ...(e.namespace ? { namespace: e.namespace } : {}) });
          }} />
      ) : null}
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
          onMenu={(x, y) => setRowMenu({ o: live ?? selected, x, y, drawer: true, lk })}
          onPreset={(id) => askPreset(objectContext(list.type, live ?? selected), id)}
          {...(show ? { show } : {})}
          {...(lf.flows ? { onFlow: () => setFlowOn({ kind: list.type.kind, ref: { group: list.type.group, version: list.type.version, resource: list.type.resource, name: selected.metadata.name, ...(selected.metadata.namespace ? { namespace: selected.metadata.namespace } : {}) } }) } : {})}
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
            {...(sent.get(problemSel.id) ? { sent: sent.get(problemSel.id)! } : {})}
            {...(lf.triage ? { onTriage: setTriage } : {})}
          />
        </Boundary>
      ) : null}
      {gcpPage && gcpPick ? (
        <Boundary what="this resource" resetKey={gcpPick.resource.name}>
          <GcpDrawer key={gcpPick.resource.name} pick={gcpPick} onClose={() => setGcpPick(undefined)} onAsk={askGcp} gkeContexts={gkeContexts} onOpenCluster={switchTo} />
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
      {rowMenu && list && rowMenu.lk === lk ? (
        <ObjectMenu at={rowMenu} handle={cluster.handle} type={list.type} object={rowMenu.o} pods={!!pods} onClose={() => setRowMenu(undefined)}
          tone={tones.get(rowMenu.o.metadata.uid)}
          onPreset={(id) => askPreset(objectContext(list.type, rowMenu.o), id)}
          {...(rowMenu.drawer ? {} : { onOpen: (a: "logs" | "shell" | "edit") => act(rowMenu.o, a) })}
          onAction={(kind, flag) => startAction(list.type, rowMenu.o, kind, flag)}
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
          onAct={(t, verb, container, preset) => void reach(t, verb, container, preset)}
          onSwitch={switchTo}
          {...(ck.console ? { onOpenClickland: (t: Target) => {
            const scope = clicklandScope(t.kind, t.namespace, t.name);
            if (scope) void api.invoke("clickland:open", { handle: cluster.handle, scope, signal: "logs", range: "1h" }).catch((e: ApiError) => setReachError(`${t.kind} ${t.name}: ${e.message}`));
          } } : {})}
          {...(gcpRows ? { gcp: { ...gcpRows, onOpen: openGcp } } : {})}
          {...(lf.triage ? { onTriage: setTriage } : {})}
          {...(lf.flows ? { onFlow: (t: Target, p?: HealthProblem) => setFlowOn({ kind: t.kind, ref: { group: t.group, version: t.version, resource: t.resource, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) }, ...(p ? { problem: p.id } : {}) }) } : {})}
          commands={{
            togglePanel: () => (bench.open ? bench.setOpen(false) : (bench.setOpen(true), focusBench())),
            newTerminal: () => (bench.openLocal(), focusBench()),
            createYaml: () => setCreating(true),
            toggleSidebar: () => setUserRail(!rail),
            foldSections: () => navFolds.setSections(allSections(sections.map(([s]) => s)), false),
            unfoldSections: () => navFolds.setSections(allSections(sections.map(([s]) => s)), true),
            openDock: () => setDock(true),
            showForwards: () => (bench.openForwards(), focusBench()),
            showProblems: () => openProblems(),
            showActions: () => setRecentOpen(true),
          }}
          onClose={() => setJump(false)}
        />
      ) : null}
      {actionOn ? (
        <ActionSheet key={`${actionOn.kind}/${actionOn.on ?? ""}/${actionOn.run ?? ""}/${actionOn.objects.map((o) => o.metadata.uid).join(",")}`} cluster={cluster} draft={actionOn}
          onClose={() => setActionOn(undefined)} onAsk={askFirst} onApplied={() => setActionsVersion((n) => n + 1)}
          onUncordon={() => {
            // From a re-attached run the node's row may not be in the window: read it, then the cordon sheet.
            const name = actionOn.objects[0]!.metadata.name;
            void api.invoke("resource:get", { handle: cluster.handle, ref: { group: "", version: "v1", resource: "nodes", name } })
              .then(({ object }) => setActionOn({ kind: "cordon", type: actionOn.type, objects: [object], on: false }), () => {});
          }} onOpen={go} />
      ) : null}
      {triage ? <TriageSheet handle={cluster.handle} {...(namespace ? { namespace } : {})} problem={triage} onClose={() => setTriage(undefined)} /> : null}
      {flowOn ? <FlowSheet handle={cluster.handle} {...(namespace ? { namespace } : {})} subject={flowOn} onAsk={ask} onClose={() => setFlowOn(undefined)} /> : null}
      {reachError ? (
        <div className="notice reach-error" role="alert">
          <Ic icon={CircleX} size={15} className="tone-bad" />
          <div className="notice-body"><strong>{reachError.startsWith("Prometheus:") ? "Couldn't change the Prometheus." : "Couldn't open it."}</strong><p>{reachError}</p></div>
        </div>
      ) : null}
    </div>
  );
}
