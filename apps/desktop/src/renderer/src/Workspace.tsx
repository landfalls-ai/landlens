// A connected cluster: the sidebar, the main pane (Overview or a list), the details drawer and the agent dock, with
// the width rules that keep the table readable (docs/design.md, "Layout").
import type { ClicklandSettings as ClicklandView, ClusterInfo, HealthProblem, KubeContext, KubeObject } from "@landlens/contracts";
import { CircleX, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentDock, type AskContext } from "./AgentDock";
import { api, useNow, useWatch, type ApiError } from "./api";
import { ClicklandSettings } from "./ClicklandSettings";
import { Details, type NavTarget } from "./Details";
import { badgeFor, useHealth } from "./health";
import { Ic, RESOURCE_OF_KIND } from "./icons";
import { JumpPalette } from "./JumpPalette";
import { buildNav, SECTIONS, type NavItem } from "./kinds";
import { Overview } from "./Overview";
import { splitByShape } from "./present";
import { ResourceTable, rowTone } from "./ResourceTable";
import { Sidebar, type Current } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Toolbar, type StatusFilter } from "./Toolbar";

const FIRST_QUESTION = "What's wrong in this cluster right now?";

export function Workspace({ cluster, contexts, onSwitch }: { cluster: ClusterInfo; contexts?: KubeContext[]; onSwitch: (context: string) => void }) {
  const now = useNow();
  const [nav, setNav] = useState<NavItem[]>([]);
  const [navError, setNavError] = useState<string>();
  const [current, setCurrent] = useState<Current>("overview");
  const [namespace, setNamespace] = useState("");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<KubeObject>();
  const [want, setWant] = useState<NavTarget>();
  const [dock, setDock] = useState(false);
  const [askContext, setAskContext] = useState<AskContext[]>([]);
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const [userRail, setUserRail] = useState<boolean>();
  const [jump, setJump] = useState(false);
  const [claude, setClaude] = useState<string>();
  const [width, setWidth] = useState({ app: window.innerWidth, main: window.innerWidth - 232 });
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
    const ro = new ResizeObserver(() => setWidth({ app: app.current?.clientWidth ?? 0, main: main.current?.clientWidth ?? 0 }));
    if (app.current) ro.observe(app.current);
    if (main.current) ro.observe(main.current);
    return () => ro.disconnect();
  }, []);

  const list = current !== "overview" ? current : undefined;
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
    if (o) setSelected(o);
    setWant(undefined);
  }, [want, watch.items, watch.loading, list]);

  const sections = useMemo(() => {
    const by = new Map<string, NavItem[]>();
    for (const n of nav) by.set(n.section, [...(by.get(n.section) ?? []), n]);
    const order = [...SECTIONS, ...[...by.keys()].filter((s) => !SECTIONS.includes(s)).sort()];
    return order.filter((s) => by.has(s)).map((s) => [s, by.get(s)!] as const);
  }, [nav]);

  const pick = (c: Current) => {
    setCurrent(c);
    setSelected(undefined);
    setStatus("all");
  };
  const navItem = (resource: string) => nav.find((n) => n.type.resource === resource && (n.type.group === "" || n.type.group === "apps"));
  const go = (t: NavTarget) => {
    const n = navItem(RESOURCE_OF_KIND[t.kind] ?? "");
    if (!n) return;
    pick(n);
    if (n.type.namespaced && t.namespace && namespace && namespace !== t.namespace) setNamespace(t.namespace);
    setWant(t);
  };
  const ask = (ctx: AskContext) => {
    setAskContext((cs) => (cs.some((c) => c.label === ctx.label) ? cs : [...cs, ctx]));
    setDock(true);
  };
  const askProblem = (p: HealthProblem) => {
    const n = navItem(RESOURCE_OF_KIND[p.kind] ?? "");
    if (!n) return setDock(true);
    ask({ ref: { group: n.type.group, version: n.type.version, resource: n.type.resource, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) }, label: `${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}` });
  };

  // Width rules: the table keeps at least ~600px. Drawer and dock together fold the sidebar to a rail; below 1280px
  // the dock alone does, and the drawer floats over the table.
  const drawer = !!(selected && list);
  const narrow = width.app < 1280;
  const autoRail = dock && (drawer || narrow);
  const rail = userRail ?? autoRail;
  useEffect(() => setUserRail(undefined), [dock, drawer, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable]");
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
      if (e.key === "/" && !typing && !mod && filterBox.current) return e.preventDefault(), filterBox.current.focus();
      if (e.key === "Escape" && !jump && !t?.closest(".dock") && selected) setSelected(undefined);
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
  const label = list?.label ?? "Overview";

  return (
    <div ref={app} className={"app" + (rail ? " sidebar-rail" : "") + (narrow ? " narrow" : "") + (dock ? " with-dock" : "") + (drawer ? " with-drawer" : "")}>
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
        onSwitch={onSwitch}
        onJump={() => setJump(true)}
      />
      <main className="main" ref={main}>
        <Toolbar
          title={label}
          {...(list ? { count: watch.loading ? undefined : shown.length } : h ? { updatedAt: h.at } : {})}
          {...(pods && !watch.loading ? { seg: { value: status, ...segCounts, onChange: setStatus } } : {})}
          {...(!list || list.type.namespaced ? { namespaces: { list: nsList, value: namespace, onChange: (ns: string) => { setNamespace(ns); setSelected(undefined); } } } : {})}
          {...(list ? { filter: { value: filter, onChange: setFilter, ref: filterBox, short: width.main < 860 } } : {})}
          {...(dock ? {} : { onAsk: () => setDock(true) })}
        />
        {!list ? (
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
            oneNamespace={!!scoped}
            empty={{
              title: `No ${list.label.toLowerCase()}${scoped ? ` in ${scoped}` : ""}${filter.trim() ? ` matching “${filter.trim()}”` : status !== "all" ? ` ${status === "bad" ? "failing" : "pending"}` : ""}`,
              ...(filter.trim() || status !== "all" ? { onClear: () => (setFilter(""), setStatus("all")) } : {}),
            }}
            onSelect={setSelected}
          />
        )}
        <StatusBar
          server={cluster.server}
          watching={list ? (watch.error ? "Not watching" : `Watching ${list.label.toLowerCase()} · live`) : "Checking health every 10s"}
          {...(claude ? { claude } : {})}
          bad={bad}
          warn={warn}
          onProblems={() => pick("overview")}
          clickland={!!clickland?.hasKey}
          onMetrics={() => setSettings(true)}
        />
      </main>
      {selected && list ? (
        <Details
          handle={cluster.handle}
          type={list.type}
          object={live ?? selected}
          tone={tones.get(selected.metadata.uid)}
          now={now}
          onClose={() => setSelected(undefined)}
          onAsk={ask}
          onNavigate={go}
          metricsVersion={metricsVersion}
          onSettings={() => setSettings(true)}
        />
      ) : null}
      {dock ? (
        <AgentDock
          cluster={cluster}
          context={askContext}
          onContextChange={setAskContext}
          onClose={() => setDock(false)}
          {...(prompt ? { pending: prompt } : {})}
          {...(suggestion ? { suggestion } : {})}
          onActivity={setClaude}
        />
      ) : null}
      {settings ? (
        <ClicklandSettings handle={cluster.handle} context={cluster.context} onClose={() => setSettings(false)} onSaved={(v) => (setClickland(v), setMetricsVersion((n) => n + 1))} />
      ) : null}
      {jump ? (
        <JumpPalette nav={nav} current={current} items={watch.items} onPick={pick} onSelect={setSelected} onClose={() => setJump(false)} />
      ) : null}
    </div>
  );
}
