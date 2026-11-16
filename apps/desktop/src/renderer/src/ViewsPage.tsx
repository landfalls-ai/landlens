// The Views page (wave 10 part 2, D213, docs/views.md): a blank page with one composer; the person says what they want
// to see, their Claude builds it with the landlens-views tools, and the view takes the page. While Claude builds, the
// page shows the ask and Claude's tool lines; once a version exists the chat folds to a strip at the bottom edge
// (Claude's last line and a composer), and the dock opens beside the view with ⌘J. Undo and Redo are the person's
// (D214); "How Claude built this" says what each source reads, with whose access, and the requests behind it (D223).
import type { AgentUpdate, ClusterInfo, ResourceType, RowRef, SourceData, ViewAuditEntry, ViewIntent, ViewState } from "@landlens/contracts";
import { ArrowUp, ChevronDown, CircleX, Code, MessageSquare, Plus, Redo2, ScrollText, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { ObjectTarget } from "./app-host";
import { Ic } from "./icons";
import { copyText } from "./present";
import type { RowHands } from "./blocks/hands";
import { SelectionBar } from "./TablePickers";
import { oneKind, refKey, refLabel, selectionActions } from "./viewBlocks";
import { ViewBlock, type BlockDoc } from "./ViewGrid";
import { chosenBy, resourceRef, useView, viewOn, viewStore } from "./viewStore";

type Doc = { title: string; params?: { name: string; type: string; label?: string; options?: string[]; default?: string }[]; sources: Record<string, Record<string, unknown>>; blocks: BlockDoc[] };

/** The text of a session's tool lines and last answer, from the agent updates (the dock's own reading of them). */
function useSessionLines(session: string | undefined) {
  const [tools, setTools] = useState<{ id: string; title: string; status: string }[]>([]);
  const [line, setLine] = useState("");
  useEffect(() => {
    if (!session) return;
    let said = "";
    const take = (u: AgentUpdate) => {
      if (u.session !== session) return;
      const x = u.update as { sessionUpdate?: string; toolCallId?: string; title?: string; status?: string; content?: { type?: string; text?: string } };
      if ((x.sessionUpdate === "tool_call" || x.sessionUpdate === "tool_call_update") && x.toolCallId) {
        const id = x.toolCallId;
        setTools((ts) => {
          const at = ts.findIndex((t) => t.id === id);
          const prev = at >= 0 ? ts[at]! : { id, title: "Tool", status: "pending" };
          const next = { ...prev, ...(x.title ? { title: x.title } : {}), ...(x.status ? { status: x.status } : {}) };
          return at >= 0 ? ts.map((t, i) => (i === at ? next : t)) : [...ts, next].slice(-12);
        });
      } else if (x.sessionUpdate === "agent_message_chunk" && x.content?.type === "text" && x.content.text) {
        said += x.content.text;
        const last = said.trim().split("\n").filter(Boolean).at(-1) ?? "";
        setLine(last.slice(0, 300));
      } else if (x.sessionUpdate === "user_message_chunk") said = "";
    };
    setTools([]);
    setLine("");
    for (const u of viewStore.recent(session)) take(u);
    const off = api.on("agent:update", take);
    const offAsk = viewStore.onAsk((s) => s === session && (said = ""));
    return () => (off(), offAsk());
  }, [session]);
  return { tools, line };
}

const toolWords = (t: string) => t.replace(/^mcp__landlens-(views|kube)__/, "").replace(/_/g, " ");

function Composer(props: { placeholder: string; onSend: (text: string) => void; busy?: boolean; big?: boolean; label: string; chip?: { title: string; clear: () => void }; objects?: { label: string; clear: () => void }[] }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.big) box.current?.focus();
  }, [props.big]);
  const send = () => {
    if (!text.trim() || props.busy) return;
    props.onSend(text.trim());
    setText("");
  };
  return (
    <div className={"composer" + (props.big ? " views-composer" : " strip-composer")}>
      {props.chip ? (
        <span className="ctx-chip">About {props.chip.title}<button className="icon-btn" aria-label="Remove" onClick={props.chip.clear}><Ic icon={X} size={11} /></button></span>
      ) : null}
      {(props.objects ?? []).map((o) => (
        <span key={o.label} className="ctx-chip obj-chip" title={o.label}>{o.label}<button className="icon-btn" aria-label={`Remove ${o.label}`} onClick={o.clear}><Ic icon={X} size={11} /></button></span>
      ))}
      <textarea
        ref={box}
        aria-label={props.label}
        placeholder={props.placeholder}
        rows={props.big ? 3 : 1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-foot">
        <span className="grow" />
        <button className="primary" aria-label="Send" disabled={!text.trim() || props.busy} onClick={send}><Ic icon={ArrowUp} size={14} /></button>
      </div>
    </div>
  );
}

/** "How Claude built this" (D223): each source in words and as Claude wrote it, its state, whose access, the requests. */
function Disclosure(props: { state: ViewState; data: (s: string) => SourceData | undefined; onClose: () => void }) {
  const doc = props.state.document as Doc;
  const [audit, setAudit] = useState<{ label: string; entries: ViewAuditEntry[] }>();
  const [source, setSource] = useState<string>();
  useEffect(() => {
    void api.invoke("views:audit", { view: props.state.id }).then(setAudit, () => {});
  }, [props.state.id, props.state.version]);
  const words = (id: string, s: Record<string, unknown>) => {
    const ns = s.namespace === undefined || s.namespace === "*" ? "every namespace this view may read" : typeof s.namespace === "string" ? `namespace ${s.namespace}` : "the namespace you pick";
    switch (s.kind) {
      case "kube.list": return `${String(s.resource)}${s.group ? `.${String(s.group)}` : ""} in ${ns}${s.labelSelector ? `, label ${String(s.labelSelector)}` : ""}${s.fieldSelector ? `, field ${String(s.fieldSelector)}` : ""}`;
      case "kube.events": return `${s.warningsOnly ? "Warning events" : "Events"} in ${ns}, the last ${Number(s.sinceMinutes ?? 60)} minutes`;
      case "kube.logs": return `The log of ${s.pod ? `pod ${String(s.pod)}` : "a workload's pods"} in ${ns}`;
      case "kube.top": return `CPU and memory now of ${String(s.of)}${s.of === "pods" ? ` in ${ns}` : ""}`;
      case "metrics.series": return `Usage over time (${String(s.scope)}, ${String(s.range)})`;
      case "doctor.problems": return `Landlens's own check, problems in ${ns}`;
      case "helm.releases": return `Helm releases in ${ns}`;
      default: return id;
    }
  };
  const whose = (kind: unknown) => (kind === "doctor.problems" || kind === "helm.releases" ? "Landlens's own check, as you" : "the view's read-only access, as you");
  const steps = (s: Record<string, unknown>) => (Array.isArray(s.pipe) ? s.pipe.map((p) => Object.keys(p as object)[0]).join(", then ") : "");
  const app = doc.blocks.filter((b) => b.type === "app") as (BlockDoc & { html: string; css?: string; js?: string })[];
  return (
    <aside className="drawer views-drawer" aria-label="How Claude built this">
      <div className="drawer-head">
        <div className="drawer-top">
          <span className="dim small grow">{doc.title} · v{props.state.version}</span>
          <button className="icon-btn" aria-label="Close" onClick={props.onClose}><Ic icon={X} size={15} /></button>
        </div>
        <div className="drawer-title">How Claude built this</div>
      </div>
      <div className="drawer-body">
        <h3>Sources</h3>
        {Object.entries(doc.sources).map(([id, s]) => {
          const st = props.state.sources[id];
          return (
            <div key={id} className="vd-source">
              <div className="vd-source-head"><span className="mono">{id}</span><span className="dim small">{st ? `${st.state} · ${st.rows} ${st.rows === 1 ? "row" : "rows"}${st.total > st.rows ? ` of ${st.total}` : ""}` : "not read yet"}</span></div>
              <p>{words(id, s)}</p>
              {steps(s) ? <p className="dim small">Then: {steps(s)}</p> : null}
              <p className="dim small">Read with {whose(s.kind)}.{st?.at ? ` Changed ${new Date(st.at).toLocaleTimeString()}.` : ""}</p>
              {st?.message ? <p className="small">{st.message}</p> : null}
              <details><summary className="small">As Claude wrote it</summary><pre className="vd-json">{JSON.stringify(s, null, 2)}</pre></details>
            </div>
          );
        })}
        <h3>Requests</h3>
        <p className="dim small">What the view's token ({audit?.label ?? "…"}) asked the cluster, through Landlens's front door.</p>
        <ul className="vd-audit">
          {(audit?.entries ?? []).slice(-40).map((e, i) => (
            <li key={i} className="mono small"><span className={e.allowed ? "tone-ok" : "tone-bad"}>{e.allowed ? e.status ?? "ok" : "refused"}</span> {e.method} {e.path}</li>
          ))}
          {audit && !audit.entries.length ? <li className="dim small">None yet.</li> : null}
        </ul>
        {app.length ? <h3>Custom blocks</h3> : null}
        {app.map((b) => {
          const size = b.html.length + (b.css?.length ?? 0) + (b.js?.length ?? 0);
          return (
            <div key={b.id} className="vd-source">
              <div className="vd-source-head"><span className="mono">{b.id}</span><span className="dim small">{size.toLocaleString("en-US")} characters · reads {(b.uses ?? []).join(", ") || "nothing"}</span></div>
              <button className="secondary small" onClick={() => setSource(source === b.id ? undefined : b.id)}><Ic icon={Code} size={13} />{source === b.id ? "Hide source" : "View source"}</button>
              {source === b.id ? <pre className="vd-json" aria-label={`Source of ${b.id}`}>{[b.html, b.css ? `<style>\n${b.css}\n</style>` : "", b.js ? `<script>\n${b.js}\n</script>` : ""].filter(Boolean).join("\n\n")}</pre> : null}
            </div>
          );
        })}
        <h3>Versions</h3>
        <ol className="vd-versions">
          {[...props.state.versions].reverse().map((v) => (
            <li key={v.version} className={v.version === props.state.version ? "on" : undefined}>
              <span className="mono">v{v.version}</span> <span className="dim small">{new Date(v.at).toLocaleTimeString()}</span>{v.note ? <span className="small"> · {v.note}</span> : null}
            </li>
          ))}
        </ol>
        <button className="secondary small" onClick={() => void copyText(JSON.stringify(props.state.document, null, 2))}>Copy document</button>
      </div>
    </aside>
  );
}

export function ViewsPage(props: {
  cluster: ClusterInfo;
  /** The dock is open beside the view (⌘J); folded, the strip at the bottom carries the chat. */
  dockOpen: boolean;
  onOpenDock: () => void;
  /** "Ask about this block" needs the strip's composer: the dock folds. */
  onFoldDock: () => void;
  onOpenObject: (t: ObjectTarget) => void;
  height: number;
  /**
   * The person's own hands on a native block's rows (wave 10 part 3, D218): the drawer, wave 8's object menu and row
   * keys, each through the Workspace's existing paths, with the person's own access.
   */
  hands: Omit<RowHands, "picked" | "pick">;
  /** The kind a row's object is (discovery), for what the selection bar offers. */
  typeOf: (r: Pick<RowRef, "group" | "resource">) => ResourceType | undefined;
  /**
   * Restart or Delete on the chosen rows: wave 8's one sheet and one review. A selection holding any row a block chose
   * never gets Delete; `block` names that block on the sheet.
   */
  onBulk: (kind: "restart" | "delete", refs: RowRef[], by: "you" | "block", block?: string) => void;
  /**
   * A block's object, logs or action intent, as main accepted it (D219): the Workspace opens Landlens's own card,
   * naming the block (`block`, its title) that asked.
   */
  onIntent: (i: ViewIntent, block: string) => boolean;
  now: number;
}) {
  // Only a view of the cluster connected now (security review of part 3, H1): the Workspace closes any other.
  const snap = viewOn(useView(), props.cluster.handle);
  const v = snap.view;
  const st = v?.state;
  const doc = st?.document as Doc | undefined;
  const session = st?.session ?? v?.session.session;
  const { tools, line } = useSessionLines(session);
  const [disclose, setDisclose] = useState(false);
  const [refusedOpen, setRefusedOpen] = useState(false);
  const [about, setAbout] = useState<{ block: string; title: string; version: number }>();
  // "About <block>" names a block of the version shown when it was chosen: another version drops the chip (L6).
  useEffect(() => setAbout((a) => (a && a.version !== st?.version ? undefined : a)), [st?.version]);
  const [menu, setMenu] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const data = (s: string) => viewStore.data(s);
  const sel = v?.selection;
  const picked = useMemo(() => new Set((sel?.refs ?? []).map(refKey)), [sel]);
  // The selection is of rows the view shows (wave 8's review of part 3, M2): a row that leaves its source leaves it.
  const shownKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const d of Object.values(v?.data ?? {})) if (d.version === st?.version) for (const r of d.data.rows) if (r._ref) keys.add(refKey(r._ref));
    return keys;
  }, [v?.data, st?.version]);
  useEffect(() => {
    if (sel && sel.refs.some((r) => !shownKeys.has(refKey(r)))) viewStore.select(sel.refs.filter((r) => shownKeys.has(refKey(r))));
  }, [shownKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  const hands: RowHands = { ...props.hands, picked, pick: (refs) => viewStore.select(refs, "you") };
  /**
   * A block's intent (D219): ask and select are the page's own; object, logs and actions go to the Workspace. An ask
   * only adds its chip: it never folds the dock, where a question of the view's session may be waiting (M1).
   */
  const intent = (i: ViewIntent, block: string) => {
    if (i.kind === "ask") return (i.refs.forEach((r) => viewStore.chip(r)), true);
    if (i.kind === "select") return (viewStore.select(i.refs, "block", block), true);
    return props.onIntent(i, block);
  };
  const by = sel ? chosenBy(sel) : "you";
  const selKind = sel ? oneKind(sel.refs) : undefined;
  const selType = selKind ? props.typeOf(selKind) : undefined;

  // The view's sources run only while the page is on screen (D210: they stop 30 s after it leaves).
  useEffect(() => {
    if (!v?.id || !st?.version) return;
    void api.invoke("views:visible", { view: v.id, visible: true }).catch(() => {});
    return () => void api.invoke("views:visible", { view: v.id, visible: false }).catch(() => {});
  }, [v?.id, !!st?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘Z and ⇧⌘Z move the shown version, with focus on the page and not in a field (D214).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Esc clears the selection before anything else (D156), outside a field, the dock, a menu or a dialog.
      if (e.key === "Escape" && viewStore.get().view?.selection && !t?.closest("input, textarea, select, .dock, .menu, .dialog, .drawer")) return viewStore.select([]);
      if (!st || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.altKey) return;
      if (t?.closest("input, textarea, select, [contenteditable], .dock")) return;
      const to = e.shiftKey ? redoTo(st) : undoTo(st);
      if (to === undefined) return;
      e.preventDefault();
      void viewStore.version(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st]);

  const newest = useMemo(() => Math.max(0, ...Object.values(st?.sources ?? {}).map((s) => s.at)), [st?.sources]);

  // ---- blank ----
  if (!v && !snap.starting) {
    return (
      <div className="views-page blank" ref={page}>
        <div className="views-blank">
          <h2>Describe what you want to see on {props.cluster.context}.</h2>
          <p className="dim">Claude builds a live view from what this cluster has. It reads with a view's own read-only access: never Secrets, and it can't change anything.</p>
          <Composer big label="What do you want to see?" placeholder="Pods that restarted today, worst first" onSend={(t) => void viewStore.start(props.cluster.handle, t)} />
          {snap.error ? <p className="tone-bad small" role="alert">{snap.error}</p> : null}
        </div>
      </div>
    );
  }

  // ---- building ----
  if (!st || !doc || !st.version) {
    return (
      <div className="views-page building" ref={page}>
        <div className="views-blank">
          <h2 className="views-ask">{st?.ask ?? snap.starting}</h2>
          <div className="views-building" role="status">
            {st?.failed ? <><Ic icon={CircleX} size={14} className="tone-bad" /><span>{st.failed}</span></>
              : st && !st.busy && st.version === 0 && v ? <span>Claude answered without building a view{line ? `: ${line}` : "."}</span>
                : <><span className="spinner" /><span>Claude is building…</span></>}
          </div>
          {tools.length ? (
            <ul className="views-tools">
              {tools.map((t) => <li key={t.id} className={`tool-${t.status}`}><span className="mono small">{toolWords(t.title)}</span><span className="dim small">{t.status === "completed" ? "done" : t.status === "failed" ? "failed" : "running"}</span></li>)}
            </ul>
          ) : null}
          {st?.refused ? <RefusedRow refused={st.refused} open={refusedOpen} onToggle={() => setRefusedOpen((o) => !o)} /> : null}
          {v && st && !st.busy ? <Composer label="Ask Claude" placeholder="Tell Claude more" onSend={(t) => void viewStore.send(t)} /> : null}
          {v ? (
            <div className="views-building-links">
              {!props.dockOpen ? <button className="link-btn small" onClick={props.onOpenDock}>Show the chat (⌘J)</button> : null}
              <button className="link-btn small" onClick={() => void viewStore.close()}>Start over</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ---- the view ----
  const blocks = doc.blocks;
  const single = blocks.length === 1;
  const fillHeight = Math.max(240, props.height - 48 - 56 - (props.dockOpen ? 0 : 64) - 24);
  return (
    <div className={"views-page has-view" + (props.dockOpen ? "" : " with-strip")} ref={page} tabIndex={-1}>
      <header className="view-head">
        <div className="view-title">
          <h2>{doc.title}</h2>
          {/* The cluster the view reads, always named (H1): its rows' actions go to this cluster only. */}
          <span className="view-cluster small" title="The cluster this view reads; its rows act here only">{st.context}</span>
          <span className="view-live" title={newest ? `Updated ${new Date(newest).toLocaleTimeString()}` : "Reading"}><i className={"dot" + (newest ? " on" : "")} />{newest ? `Live · ${new Date(newest).toLocaleTimeString()}` : "Reading"}</span>
          <span className="dim small">v{st.version}{st.shownBy === "you" ? " · chosen by you" : ""}</span>
        </div>
        {(doc.params ?? []).map((p) => (
          <label key={p.name} className="view-param small">
            <span className="dim">{p.label ?? p.name}</span>
            {p.type === "choice" ? (
              <select value={st.params[p.name] ?? p.default ?? ""} onChange={(e) => void viewStore.param(p.name, e.target.value)}>
                {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input defaultValue={st.params[p.name] ?? p.default ?? ""} onKeyDown={(e) => e.key === "Enter" && void viewStore.param(p.name, (e.target as HTMLInputElement).value)} />
            )}
          </label>
        ))}
        <span className="grow" />
        <button className="icon-btn" aria-label="Undo" title="Undo (⌘Z)" disabled={!st.canUndo} onClick={() => { const to = undoTo(st); if (to !== undefined) void viewStore.version(to); }}><Ic icon={Undo2} size={15} /></button>
        <button className="icon-btn" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!st.canRedo} onClick={() => { const to = redoTo(st); if (to !== undefined) void viewStore.version(to); }}><Ic icon={Redo2} size={15} /></button>
        <button className="secondary small" onClick={() => setDisclose((d) => !d)} aria-expanded={disclose}><Ic icon={ScrollText} size={13} />How Claude built this</button>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><Ic icon={ChevronDown} size={15} /></button>
          {menu ? (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={() => (setMenu(false), void viewStore.close())}><Ic icon={Plus} size={13} />New view</button>
            </div>
          ) : null}
        </div>
      </header>
      {st.refused ? <RefusedRow refused={st.refused} open={refusedOpen} onToggle={() => setRefusedOpen((o) => !o)} /> : null}
      {sel ? (
        <div className={"view-selection" + (by === "block" ? " by-block" : "")} role="region" aria-label="Chosen rows">
          {by === "block" ? (
            <span className="small view-sel-who">
              {sel.fromBlock.length === sel.refs.length ? "Chosen" : `${sel.fromBlock.length} of these chosen`} by a block Claude built{sel.block ? ` (${sel.block})` : ""}.
              {sel.fromBlock.length === sel.refs.length ? " Nothing happens until you act." : " No Delete while any of them is chosen."}
            </span>
          ) : null}
          {!selKind ? <span className="small dim">Rows of several kinds: no action covers them all.</span> : null}
          <SelectionBar count={sel.refs.length} actions={selectionActions(selType, by)}
            onAction={(k) => props.onBulk(k, sel.refs, by, sel.block)}
            onAsk={() => (sel.refs.slice(0, 10).forEach((r) => viewStore.chip(r)), props.onFoldDock())}
            onClear={() => viewStore.select([])} />
        </div>
      ) : null}
      <div className={"view-grid" + (single ? " single" : "")}>
        {blocks.map((b, i) => (
          <ViewBlock key={`${st.version}-${i}`} view={v!.id} version={st.version} b={b} i={i} data={data} single={single} height={fillHeight}
            hands={hands} onIntent={intent} now={props.now}
            onOpenObject={props.onOpenObject} onAsk={(block, title) => (setAbout({ block, title, version: st.version }), props.onFoldDock())} />
        ))}
      </div>
      {!props.dockOpen ? (
        <div className="view-strip" role="region" aria-label="Chat with Claude">
          <button className="icon-btn" aria-label="Open the chat" title="Open the chat (⌘J)" onClick={props.onOpenDock}><Ic icon={MessageSquare} size={15} /></button>
          <span className="view-strip-line small" title={line}>{st.busy ? <><span className="spinner" /> Claude is working…</> : line || "Ask for a change to this view."}</span>
          <Composer label="Ask Claude" placeholder="Ask for a change, or about what you see" busy={st.busy}
            {...(about ? { chip: { title: about.title, clear: () => setAbout(undefined) } } : {})}
            objects={(v!.chips ?? []).map((r) => ({ label: refLabel(r), clear: () => viewStore.unchip(r) }))}
            onSend={(t) => {
              void viewStore.send(t, (v!.chips ?? []).map(resourceRef), about ? { block: about.block, version: about.version } : undefined).catch(() => {});
              setAbout(undefined);
              viewStore.unchip();
            }} />
        </div>
      ) : null}
      {disclose ? <Disclosure state={st} data={data} onClose={() => setDisclose(false)} /> : null}
    </div>
  );
}

function RefusedRow(props: { refused: { issues: string[] }; open: boolean; onToggle: () => void }) {
  const n = props.refused.issues.length;
  return (
    <div className="view-refused" role="note">
      <button className="link-btn small" aria-expanded={props.open} onClick={props.onToggle}>Claude's last change didn't fit: {n} {n === 1 ? "problem" : "problems"}</button>
      {props.open ? <ul className="small">{props.refused.issues.map((i, k) => <li key={k} className="mono">{i}</li>)}</ul> : null}
    </div>
  );
}

const undoTo = (s: ViewState) => (s.canUndo ? s.versions.find((v) => v.version === s.version)?.parent : undefined);
const redoTo = (s: ViewState) => (s.canRedo ? s.versions.filter((v) => v.parent === s.version).at(-1)?.version : undefined);
