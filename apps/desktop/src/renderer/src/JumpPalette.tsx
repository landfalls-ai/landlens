// ⌘K is search (wave 4, part 4; D44–D45): actions, problems, objects across kinds, kinds and clusters, six of each.
// Empty, it shows recent items and the open object's actions. A first word of logs, shell, forward, edit or ask turns
// object matches into that action; `problems` searches only problems (D61); `>` lists the app's commands. Tab on an object lists its actions; Tab on a shell or logs
// row of a pod with several containers lists them. Enter goes, Esc steps back or closes.
import type { GcpResource, KubeContext, KubeObject, Problem, SearchEntry } from "@landlens/contracts";
import { resourceLabel, serviceIcon, shortType } from "./GcpPage";
import {
  ArrowRightLeft, Box, ChevronRight, CornerDownLeft, FilePlus2, FoldVertical, History, Layers, PanelBottom, PanelLeft, Plug, RefreshCw,
  CircleX, ExternalLink, Search, Siren, Sparkles, SquareArrowOutUpRight, SquareTerminal, Stethoscope, TriangleAlert, UnfoldVertical, Workflow, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { Ic, kindIcon, MOD } from "./icons";
import type { NavItem } from "./kinds";
import { shellable } from "./ShellMenu";
import type { Current } from "./Sidebar";
import { parseQuery, score, VERBS, verbsFor, type Target, type Verb } from "./paletteRules";
import { matchProblems } from "./problemRules";
import { clicklandScope } from "./clickland";

export type { Target, Verb };

export type Commands = {
  togglePanel: () => void;
  newTerminal: () => void;
  createYaml: () => void;
  toggleSidebar: () => void;
  foldSections: () => void;
  unfoldSections: () => void;
  openDock: () => void;
  showForwards: () => void;
  showProblems: () => void;
};

type Group = "Recent" | "Actions" | "Problems" | "Objects" | "Google Cloud" | "Kinds" | "Clusters" | "Commands" | "Containers";
type Row = { key: string; group: Group; label: string; hint?: string; icon: LucideIcon; mono?: boolean; run: () => void; tab?: () => void };
const PER_GROUP = 6;

const keyOf = (t: Pick<Target, "group" | "resource" | "name"> & { namespace?: string }) => `${t.group}/${t.resource}/${t.namespace ?? ""}/${t.name}`;
/** A problem's subject (the owner, as the doctor names it), as an object of the palette. */
const subjectTarget = (p: Problem): Target | undefined =>
  p.resource ? { group: p.group, version: p.version, resource: p.resource, kind: p.kind, name: p.name, ...(p.namespace ? { namespace: p.namespace } : {}) } : undefined;
const label = (t: Target) => `${t.namespace ? `${t.namespace}/` : ""}${t.name}`;

type Recent = { k: "object"; t: Target } | { k: "kind"; key: string };
const recentKey = (context: string) => `landlens.recent.${context}`;
const MAX_RECENT = 8;
function readRecent(context: string): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(context)) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is Recent =>
      (r?.k === "kind" && typeof r.key === "string") ||
      (r?.k === "object" && ["group", "version", "resource", "kind", "name"].every((f) => typeof r.t?.[f] === "string") && (r.t.namespace === undefined || typeof r.t.namespace === "string")),
    ).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}
function remember(context: string, r: Recent) {
  const id = (x: Recent) => (x.k === "kind" ? `k:${x.key}` : `o:${keyOf(x.t)}`);
  const next = [r, ...readRecent(context).filter((x) => id(x) !== id(r))].slice(0, MAX_RECENT);
  localStorage.setItem(recentKey(context), JSON.stringify(next));
}

/** The names across kinds, read by main on the first ⌘K and shared for 15 s (D45). */
function useSearchIndex(handle: string) {
  const [state, setState] = useState<{ entries: SearchEntry[]; unreadable: string[]; cut: string[]; loading: boolean; error?: string }>({ entries: [], unreadable: [], cut: [], loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api.invoke("search:index", { handle, ...(n ? { fresh: true } : {}) }).then(
      (r) => live && setState({ entries: r.entries, unreadable: r.unreadable, cut: r.cut, loading: false }),
      (e: ApiError) => live && setState((s) => ({ ...s, loading: false, error: e.message })),
    );
    return () => {
      live = false;
    };
  }, [handle, n]);
  return { ...state, refresh: () => setN((x) => x + 1) };
}

export function JumpPalette(props: {
  handle: string;
  context: string;
  contexts?: KubeContext[];
  nav: NavItem[];
  current?: Current;
  /** The list on screen, searched too (it may hold kinds the index doesn't). */
  items: KubeObject[];
  /** The object in the drawer: its actions show when the query is empty. */
  open?: Target;
  /** The doctor's report the workspace already holds (D61): no new read. */
  problems: Problem[];
  /** What to say when there are no problems to list: not checked yet, couldn't check, or checks skipped (M2). */
  problemsEmpty: string;
  onProblem: (p: Problem) => void;
  onAskProblem: (p: Problem) => void;
  onOpenSubject: (p: Problem) => void;
  onPick: (c: Current) => void;
  onOpen: (t: Target) => void;
  onAct: (t: Target, verb: Verb, container?: string) => void;
  onSwitch: (context: string) => void;
  /** Open in Clickland (D118), for a pod or a workload, while a console address is set: a Tab action. */
  onOpenClickland?: (t: Target) => void;
  /** Send to triage… (wave 7 D122), while Landflow's triage webhook is set up: a problem's Tab action. */
  onTriage?: (p: Problem) => void;
  /** Run a Landflow flow… (D125), while the key can list and run flows: a Tab action of a problem and of an object. */
  onFlow?: (t: Target, problem?: Problem) => void;
  commands: Commands;
  /** The Google Cloud rows the page last read (one project), found by name; no new read. */
  gcp?: { project: string; items: GcpResource[]; onOpen: (project: string, r: GcpResource) => void };
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  // Tab on an object: its actions; Tab on a pod's shell or logs row: its containers.
  const [switching, setSwitching] = useState(false);
  const [focus, setFocus] = useState<{ t: Target; from: string; containers?: { verb: Verb; list: { name: string; running: boolean; why?: string }[] } }>();
  // Tab on a problem: Open, Ask Claude, Open <Kind>.
  const [pfocus, setPfocus] = useState<{ p: Problem; from: string }>();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => input.current?.focus(), []);
  const index = useSearchIndex(props.handle);
  const recent = useMemo(() => readRecent(props.context), [props.context]);

  const cur = typeof props.current === "object" ? props.current : undefined;
  const objects = useMemo(() => {
    const seen = new Map<string, Target>();
    for (const e of index.entries) seen.set(keyOf(e), e);
    if (cur) {
      for (const o of props.items) {
        const t: Target = { group: cur.type.group, version: cur.type.version, resource: cur.type.resource, kind: cur.type.kind, name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}) };
        if (!seen.has(keyOf(t))) seen.set(keyOf(t), t);
      }
    }
    return [...seen.values()];
  }, [index.entries, props.items, cur]);

  const done = (f: () => void) => {
    props.onClose();
    f();
  };
  const openObject = (t: Target) => done(() => (remember(props.context, { k: "object", t }), props.onOpen(t)));
  const act = (t: Target, verb: Verb, container?: string) => done(() => (remember(props.context, { k: "object", t }), props.onAct(t, verb, container)));
  const pickKind = (n: NavItem) => done(() => (remember(props.context, { k: "kind", key: `${n.type.group}/${n.type.resource}` }), props.onPick(n)));

  /** A pod's containers, for Tab on its shell or logs row. */
  const containers = (t: Target, verb: Verb) => {
    api.invoke("resource:get", { handle: props.handle, ref: { group: t.group, version: t.version, resource: t.resource, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) } }).then(
      ({ object }) => {
        const cs = verb === "shell" ? shellable(object) : (object.spec?.containers as { name: string }[] | undefined ?? []).map((c) => ({ name: c.name, running: true }));
        setFocus((f) => ({ t, from: f?.from ?? q, containers: { verb, list: cs } }));
        setQ("");
        setAt(0);
      },
      () => undefined,
    );
  };
  const actionRow = (t: Target, verb: Verb, group: Group = "Actions"): Row => ({
    key: `a:${verb}:${keyOf(t)}`,
    group,
    label: VERBS[verb].label(t.name),
    hint: `${t.kind}${t.namespace ? ` · ${t.namespace}` : ""}`,
    icon: VERBS[verb].icon,
    run: () => act(t, verb),
    ...(t.kind === "Pod" && (verb === "shell" || verb === "logs") ? { tab: () => containers(t, verb) } : {}),
  });
  /** Open in Clickland, for a pod or a workload, when a console address is set (D118). */
  const clicklandRow = (t: Target): Row[] => {
    const open = props.onOpenClickland;
    return open && clicklandScope(t.kind, t.namespace, t.name)
      ? [{ key: `ck:${keyOf(t)}`, group: "Actions", label: "Open in Clickland", hint: `${t.kind}${t.namespace ? ` · ${t.namespace}` : ""}`, icon: ExternalLink, run: () => done(() => open(t)) }]
      : [];
  };
  /** Run a Landflow flow… on an object, or on a problem's subject (D125). */
  const flowRow = (t: Target, problem?: Problem): Row[] => {
    const flow = props.onFlow;
    return flow ? [{ key: `lf:${keyOf(t)}`, group: "Actions", label: "Run a Landflow flow…", hint: `${t.kind}${t.namespace ? ` · ${t.namespace}` : ""}`, icon: Workflow, run: () => done(() => flow(t, problem)) }] : [];
  };
  const objectRow = (t: Target, group: Group = "Objects"): Row => ({
    key: `o:${keyOf(t)}`, group, label: t.name, hint: `${t.kind}${t.namespace ? ` · ${t.namespace}` : ""}`, icon: kindIcon(t.resource), mono: true,
    run: () => openObject(t),
    tab: () => (setFocus({ t, from: q }), setQ(""), setAt(0)),
  });

  const problemRow = (p: Problem): Row => ({
    key: `pr:${p.id}`, group: "Problems", label: p.title, hint: `${p.kind}${p.namespace ? ` · ${p.namespace}` : ""}`, icon: p.tone === "bad" ? CircleX : TriangleAlert,
    run: () => done(() => props.onProblem(p)),
    tab: () => (setPfocus({ p, from: q }), setQ(""), setAt(0)),
  });
  const pages: { key: string; label: string; resource: string; go: () => void }[] = [
    { key: "overview", label: "Overview", resource: "overview", go: () => done(() => props.onPick("overview")) },
    { key: "problems", label: "Problems", resource: "problems", go: () => done(() => props.onPick("problems")) },
    { key: "helm", label: "Helm releases", resource: "helm", go: () => done(() => props.onPick("helm")) },
    { key: "connections", label: "Connections", resource: "connections", go: () => done(() => props.onPick("connections")) },
    { key: "mcp", label: "MCP", resource: "mcp", go: () => done(() => props.onPick("mcp")) },
    { key: "agent", label: "Agent", resource: "agent", go: () => done(() => props.onPick("agent")) },
    { key: "gcp", label: "Google Cloud", resource: "gcp", go: () => done(() => props.onPick("gcp")) },
  ];
  const commands: Row[] = [
    { key: "c:panel", group: "Commands", label: "Toggle panel", hint: `${MOD}\``, icon: PanelBottom, run: () => done(props.commands.togglePanel) },
    { key: "c:term", group: "Commands", label: "New local terminal", hint: "⌃⇧`", icon: SquareTerminal, run: () => done(props.commands.newTerminal) },
    { key: "c:create", group: "Commands", label: "Create from YAML", icon: FilePlus2, run: () => done(props.commands.createYaml) },
    { key: "c:forwards", group: "Commands", label: "Show port forwards", icon: ArrowRightLeft, run: () => done(props.commands.showForwards) },
    { key: "c:problems", group: "Commands", label: "Show problems", icon: Stethoscope, run: () => done(props.commands.showProblems) },
    { key: "c:dock", group: "Commands", label: "Ask Claude", hint: `${MOD}J`, icon: Sparkles, run: () => done(props.commands.openDock) },
    { key: "c:sidebar", group: "Commands", label: "Toggle sidebar", hint: `${MOD}B`, icon: PanelLeft, run: () => done(props.commands.toggleSidebar) },
    { key: "c:fold", group: "Commands", label: "Fold all sections", hint: "sidebar", icon: FoldVertical, run: () => done(props.commands.foldSections) },
    { key: "c:unfold", group: "Commands", label: "Unfold all sections", hint: "sidebar", icon: UnfoldVertical, run: () => done(props.commands.unfoldSections) },
    { key: "c:switch", group: "Commands", label: "Switch cluster…", icon: Layers, run: () => (setQ(""), setAt(0), setFocus(undefined), setSwitching(true)) },
    { key: "c:names", group: "Commands", label: "Read names again", hint: "search", icon: RefreshCw, run: () => (index.refresh(), setQ("")) },
    ...pages.map((p): Row => ({ key: `c:${p.key}`, group: "Commands", label: `Go to ${p.label}`, icon: kindIcon(p.resource), run: p.go })),
  ];
  const clusterRow = (c: KubeContext): Row => ({
    key: `x:${c.name}`, group: "Clusters", label: c.name, hint: c.name === props.context ? "current" : "Switch", icon: Plug,
    run: () => done(() => c.name !== props.context && props.onSwitch(c.name)),
  });

  const rows = useMemo((): Row[] => {
    const { verb, text, commands: cmd, problems: onlyProblems } = parseQuery(q);
    const rank = <T,>(xs: T[], name: (x: T) => string, alt?: (x: T) => string) =>
      xs.map((x) => ({ x, s: Math.min(score(name(x), text) ?? 9, alt ? (score(alt(x), text) ?? 9) : 9) })).filter((r) => r.s < 9)
        .sort((a, b) => a.s - b.s || name(a.x).length - name(b.x).length || name(a.x).localeCompare(name(b.x))).map((r) => r.x);

    if (focus?.containers) {
      const { verb: v, list: cs } = focus.containers;
      return cs.filter((c) => !text || c.name.toLowerCase().includes(text)).map((c): Row => ({
        key: `c:${c.name}`, group: "Containers", label: `${v === "shell" ? "Open shell in" : "Logs of"} ${c.name}`, hint: c.why ?? (c.running ? focus.t.name : "not running"), icon: VERBS[v].icon, mono: true,
        run: () => (c.running ? act(focus.t, v, c.name) : undefined),
      }));
    }
    if (pfocus) {
      const p = pfocus.p;
      const acts: Row[] = [
        { key: "pa:open", group: "Actions", label: "Open", hint: "Problem", icon: Stethoscope, run: () => done(() => props.onProblem(p)) },
        { key: "pa:ask", group: "Actions", label: "Ask Claude", hint: p.name, icon: Sparkles, run: () => done(() => props.onAskProblem(p)) },
        { key: "pa:subject", group: "Actions", label: `Open ${p.kind}`, hint: p.name, icon: SquareArrowOutUpRight, run: () => done(() => props.onOpenSubject(p)) },
        ...(props.onTriage ? [{ key: "pa:triage", group: "Actions" as Group, label: "Send to triage…", hint: p.name, icon: Siren, run: () => done(() => props.onTriage!(p)) }] : []),
        ...(subjectTarget(p) ? flowRow(subjectTarget(p)!, p) : []),
      ];
      return acts.filter((r) => !text || r.label.toLowerCase().includes(text));
    }
    if (onlyProblems) return matchProblems(props.problems, text, text ? 50 : PER_GROUP).map(problemRow);
    if (focus) return [...verbsFor(focus.t).map((v) => actionRow(focus.t, v)), ...clicklandRow(focus.t), ...flowRow(focus.t)].filter((r) => !text || r.label.toLowerCase().includes(text));
    if (switching) return rank(props.contexts ?? [], (c) => c.name).map(clusterRow);
    if (cmd) return rank(commands, (r) => r.label);
    if (verb) {
      const fits = objects.filter((t) => verbsFor(t).includes(verb));
      return (text ? rank(fits, (t) => t.name, label) : fits.slice().sort((a, b) => a.name.localeCompare(b.name))).slice(0, 12).map((t) => actionRow(t, verb));
    }
    if (!text) {
      const rec = recent.flatMap((r): Row[] => {
        if (r.k === "object") return [objectRow(r.t, "Recent")];
        const n = props.nav.find((x) => `${x.type.group}/${x.type.resource}` === r.key);
        return n ? [{ key: `rk:${r.key}`, group: "Recent", label: n.label, hint: "Kind", icon: kindIcon(n.type.resource), run: () => pickKind(n) }] : [];
      }).slice(0, PER_GROUP);
      const acts = props.open ? verbsFor(props.open).map((v) => actionRow(props.open!, v)) : [];
      const kinds = [...pages.map((p): Row => ({ key: `p:${p.key}`, group: "Kinds", label: p.label, hint: "Page", icon: kindIcon(p.resource), run: p.go }))];
      return [...acts, ...rec, ...kinds];
    }
    const actions = rank(commands, (r) => r.label).slice(0, PER_GROUP).map((r) => ({ ...r, group: "Actions" as Group }));
    const probs = matchProblems(props.problems, text, PER_GROUP).map(problemRow);
    const objs = rank(objects, (t) => t.name, label).slice(0, PER_GROUP).map((t) => objectRow(t));
    const g = props.gcp;
    const clouds = g ? rank(g.items, (r) => resourceLabel(r), (r) => r.name).slice(0, PER_GROUP).map((r): Row => ({
      key: `g:${r.name}`, group: "Google Cloud", label: resourceLabel(r), hint: `${shortType(r.assetType)} · ${g.project}`, icon: serviceIcon(r.assetType), mono: true,
      run: () => done(() => g.onOpen(g.project, r)),
    })) : [];
    const kinds: { name: string; alt?: string; row: Row }[] = [
      ...pages.map((p) => ({ name: p.label, row: { key: `p:${p.key}`, group: "Kinds" as Group, label: p.label, hint: "Page", icon: kindIcon(p.resource), run: p.go } })),
      ...props.nav.map((n) => ({ name: n.label, alt: n.type.resource, row: { key: `k:${n.type.group}/${n.type.resource}`, group: "Kinds" as Group, label: n.label, hint: n.section === "core" ? "Kind" : n.section, icon: kindIcon(n.type.resource), run: () => pickKind(n) } })),
    ];
    const ks = rank(kinds, (k) => k.name, (k) => k.alt ?? "").slice(0, PER_GROUP).map((k) => k.row);
    const cls = rank(props.contexts ?? [], (c) => c.name).slice(0, PER_GROUP).map(clusterRow);
    return [...actions, ...probs, ...objs, ...clouds, ...ks, ...cls];
  }, [q, focus, pfocus, switching, objects, recent, props.nav, props.contexts, props.open, props.problems, props.gcp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setAt(0), [q, focus, pfocus, switching]);
  useEffect(() => {
    list.current?.querySelector(`#jump-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const back = () => {
    if (pfocus) return setPfocus(undefined), setQ(pfocus.from);
    if (focus?.containers) return setFocus({ t: focus.t, from: focus.from }), setQ("");
    if (focus) return setFocus(undefined), setQ(focus.from);
    if (switching) return setSwitching(false);
    props.onClose();
  };

  const parsed = parseQuery(q);
  const placeholder = pfocus ? `Actions for ${pfocus.p.name}…` : focus?.containers ? `Container in ${focus.t.name}…` : focus ? `Actions for ${focus.t.name}…` : switching ? "Switch to a cluster…" : "Search objects, kinds, problems and actions…";
  const empty = parsed.problems && !pfocus && !props.problems.length ? props.problemsEmpty : index.loading && !rows.length ? "Reading names…" : pfocus || focus || switching || parsed.commands || parsed.verb || q.trim() ? `Nothing matches “${q.trim()}”` : "Type to search";

  let last: Group | undefined;
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette wide" role="dialog" aria-label="Search">
        <label className="palette-input">
          {pfocus || focus || switching ? (
            <button className="palette-crumb" aria-label="Back" onClick={back}>
              <Ic icon={pfocus ? Stethoscope : focus ? kindIcon(focus.t.resource) : Layers} size={13} />
              <span className="mono">{pfocus ? pfocus.p.name : focus ? focus.t.name : "Clusters"}</span>
              <Ic icon={ChevronRight} size={12} />
            </button>
          ) : <Ic icon={Search} size={15} />}
          <input
            ref={input}
            value={q}
            placeholder={placeholder}
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="jump-list"
            aria-activedescendant={rows[at] ? `jump-${at}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setAt((i) => Math.min(rows.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter") (e.preventDefault(), rows[at]?.run());
              else if (e.key === "Tab" && !e.shiftKey && rows[at]?.tab) (e.preventDefault(), rows[at]!.tab!());
              else if (e.key === "Tab") e.preventDefault();
              else if (e.key === "Backspace" && !q && (pfocus || focus || switching)) (e.preventDefault(), back());
              else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), back());
            }}
          />
          {parsed.verb && !focus ? <span className="badge muted palette-verb">{parsed.verb}</span> : parsed.problems && !pfocus ? <span className="badge muted palette-verb">problems</span> : null}
          <kbd aria-hidden="true">esc</kbd>
        </label>
        <ul id="jump-list" role="listbox" aria-label="Results" ref={list}>
          {rows.length ? rows.map((r, i) => {
            const head = r.group !== last ? (last = r.group) : undefined;
            return [
              head ? <li key={`h:${head}`} role="presentation" className="menu-label">{head === "Recent" ? <><Ic icon={History} size={11} />Recent</> : head === "Actions" && props.open && !q.trim() && !focus && !pfocus ? `Actions for ${props.open.name}` : head}</li> : null,
              <li key={r.key} id={`jump-${i}`} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onMouseEnter={() => setAt(i)} onClick={() => r.run()}>
                <Ic icon={r.icon} size={14} />
                <span className={"p-name" + (r.mono ? " mono" : "")}>{r.label}</span>
                {r.hint ? <span className="p-kind">{r.hint}</span> : null}
                {i === at ? <Ic icon={CornerDownLeft} size={12} /> : null}
              </li>,
            ];
          }) : <li className="p-empty">{empty}</li>}
        </ul>
        <div className="slash-foot palette-foot">
          <span><kbd>↑↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>tab</kbd> actions</span>
          <span><kbd>&gt;</kbd> commands</span>
          <span className="grow" />
          {index.error ? <span className="tone-bad" title={index.error}>Couldn't read names</span>
            : index.loading ? <span>Reading names…</span>
            : <span title={[index.unreadable.length ? `Not readable: ${index.unreadable.join(", ")}` : "", index.cut.length ? `First 2000 only: ${index.cut.join(", ")}` : ""].filter(Boolean).join(" · ") || undefined}>
                <Ic icon={Box} size={11} />{objects.length} objects{index.unreadable.length || index.cut.length ? " · some kinds left out" : ""}
              </span>}
        </div>
      </div>
    </div>
  );
}

