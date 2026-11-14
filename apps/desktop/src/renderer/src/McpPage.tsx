// The MCP page (docs/mcp.md): the servers an agent session gets through Landlens's gateway, and every call made
// through it. Servers: landlens-kube (built in, always on) with its tools, and the remote servers you added, each
// turned on per cluster, tested, edited or removed; Clickland in one step when it answers. Calls: the live log, with
// filters; a row opens the call in the drawer.
import type { McpCall, McpServerInfo, McpServers, McpTest, McpToolInfo } from "@landlens/contracts";
import {
  Ban, CircleAlert, CircleCheck, CircleDashed, CircleX, Eye, LayoutPanelTop, Pencil, Play, Plug, PlugZap, Plus, Server, Trash2, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { age } from "@landlens/kube/status";
import { api, useNow, type ApiError } from "./api";
import { AppFrame } from "./AppFrame";
import type { ObjectTarget } from "./app-host";
import { inputText, Well } from "./DockParts";
import { Ic } from "./icons";
import { hasView, useMcpCalls } from "./mcpStore";

export type McpTab = "servers" | "calls";

export function McpPage(props: {
  handle: string;
  context: string;
  tab: McpTab;
  onTab: (t: McpTab) => void;
  selected?: string;
  onSelect: (call: string) => void;
  onOpenObject: (t: ObjectTarget) => void;
  onConnectClickland: () => void;
  /** Bumped when Clickland's settings change, so the preset re-checks. */
  version: number;
}) {
  const [servers, setServers] = useState<McpServers>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<McpServerInfo | "new">();
  const calls = useMcpCalls();
  const reload = () => api.invoke("mcp:servers", { context: props.context }).then(setServers, (e: ApiError) => setError(e.message));
  useEffect(() => void reload(), [props.context, props.version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ov mcp">
      <div className="tabs mcp-tabs" role="tablist" aria-label="MCP">
        {(["servers", "calls"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={props.tab === t} className={props.tab === t ? "on" : ""} onClick={() => props.onTab(t)}>
            {t === "servers" ? "Servers" : "Calls"}
            <span className="count" aria-hidden="true">{t === "servers" ? servers?.servers.length ?? "…" : calls.length}</span>
          </button>
        ))}
      </div>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {props.tab === "servers" ? (
        <Servers
          {...props}
          servers={servers}
          onAdd={() => setEditing("new")}
          onEdit={setEditing}
          onChanged={reload}
          onError={setError}
        />
      ) : (
        <Calls calls={calls} selected={props.selected} onSelect={props.onSelect} />
      )}
      {editing ? (
        <ServerDialog
          server={editing === "new" ? undefined : editing}
          context={props.context}
          canStore={servers?.canStore ?? true}
          onClose={() => setEditing(undefined)}
          onSaved={() => (setEditing(undefined), void reload())}
        />
      ) : null}
    </div>
  );
}

// ---- servers --------------------------------------------------------------------------------------------------------

function Servers(props: {
  handle: string;
  context: string;
  servers?: McpServers;
  onAdd: () => void;
  onEdit: (s: McpServerInfo) => void;
  onChanged: () => void;
  onError: (m?: string) => void;
  onOpenObject: (t: ObjectTarget) => void;
  onConnectClickland: () => void;
}) {
  const s = props.servers;
  const preset = s?.presets.find((p) => p.id === "clickland");
  const [adding, setAdding] = useState(false);
  if (!s) return <div className="skel" style={{ height: 220 }} />;
  const addClickland = () => {
    setAdding(true);
    props.onError(undefined);
    api.invoke("mcp:preset", { preset: "clickland" }).then(
      (srv) => api.invoke("mcp:enable", { id: srv.id, context: props.context, enabled: true }).then(props.onChanged),
      (e: ApiError) => props.onError(e.message),
    ).finally(() => setAdding(false));
  };
  return (
    <>
      <div className="mcp-intro">
        <p className="dim">
          Every MCP call an agent session makes goes through Landlens's gateway on <span className="mono">{new URL(s.gateway).host}</span> and is logged
          under Calls. landlens-kube's tools run without asking; a remote server's tools ask you in the dock unless you let its read-only tools run.
          Remote servers' keys stay encrypted in the main process.
        </p>
        <button className="secondary" onClick={props.onAdd}><Ic icon={Plus} size={14} />Add server</button>
      </div>
      {preset && !preset.added && preset.reachable ? (
        <section className="panel mcp-preset" aria-label="Clickland preset">
          <div className="mcp-preset-row">
            <span className="kind-tile sm"><Ic icon={PlugZap} size={15} /></span>
            <div className="ov-main">
              <div className="ov-name"><span>Clickland answers at</span><span className="mono">{preset.url}</span></div>
              <div className="ov-detail">{preset.hasKey ? "Add it with the read key Connect Clickland stored, on for this cluster." : "Connect Clickland first; its read key is what the MCP endpoint takes."}</div>
            </div>
            {preset.hasKey ? (
              <button className="primary" onClick={addClickland} disabled={adding}>{adding ? <span className="spinner" /> : <Ic icon={Plus} size={14} />}Add Clickland</button>
            ) : (
              <button className="secondary" onClick={props.onConnectClickland}>Connect Clickland</button>
            )}
          </div>
        </section>
      ) : null}
      {s.servers.map((srv) => (
        <ServerPanel key={srv.id} server={srv} {...props} />
      ))}
    </>
  );
}

const STATUS: Record<McpServerInfo["status"], { tone: "ok" | "muted" | "bad"; word: string; icon: typeof CircleCheck }> = {
  ready: { tone: "ok", word: "Ready", icon: CircleCheck },
  unknown: { tone: "muted", word: "Not tested", icon: CircleDashed },
  failed: { tone: "bad", word: "Failed", icon: CircleX },
};

function ServerPanel(props: {
  server: McpServerInfo;
  handle: string;
  context: string;
  onEdit: (s: McpServerInfo) => void;
  onChanged: () => void;
  onError: (m?: string) => void;
  onOpenObject: (t: ObjectTarget) => void;
}) {
  const srv = props.server;
  const st = STATUS[srv.status];
  const [test, setTest] = useState<McpTest | "running">();
  const [busy, setBusy] = useState(false);
  const runTest = () => {
    setTest("running");
    api.invoke("mcp:test", { id: srv.id }).then((t) => (setTest(t), props.onChanged()), (e: ApiError) => (setTest(undefined), props.onError(e.message)));
  };
  const toggle = () => {
    setBusy(true);
    api.invoke("mcp:enable", { id: srv.id, context: props.context, enabled: !srv.enabled }).then(props.onChanged, (e: ApiError) => props.onError(e.message)).finally(() => setBusy(false));
  };
  const toggleAuto = () => {
    setBusy(true);
    api.invoke("mcp:auto-run", { id: srv.id, enabled: !srv.autoRun, context: props.context }).then(props.onChanged, (e: ApiError) => props.onError(e.message)).finally(() => setBusy(false));
  };
  const remove = () => {
    if (!window.confirm(`Remove ${srv.name}? Agent sessions you start from now on won't have it.`)) return;
    api.invoke("mcp:remove", { id: srv.id }).then(props.onChanged, (e: ApiError) => props.onError(e.message));
  };
  const tools = srv.tools ?? [];
  const ro = tools.filter((t) => t.readOnly).length;
  return (
    <section className="panel mcp-server" aria-label={`MCP server ${srv.name}`}>
      <header className="panel-head">
        <span className="kind-tile sm"><Ic icon={srv.builtin ? Server : Plug} size={15} /></span>
        <h3 className="mono">{srv.name}</h3>
        {srv.builtin ? <span className="badge muted">Built in</span> : null}
        <span className={`badge ${st.tone}`}><Ic icon={st.icon} size={13} />{st.word}</span>
        <span className="grow" />
        {srv.builtin ? (
          <span className="dim small">On for every cluster</span>
        ) : (
          <>
            <label className="switch">
              <input type="checkbox" role="switch" checked={srv.enabled} disabled={busy} onChange={toggle} aria-label={`Use ${srv.name} on ${props.context}`} />
              <span>On for {props.context}</span>
            </label>
            <button className="secondary" onClick={runTest} disabled={test === "running"}>Test</button>
            <button className="icon-btn" aria-label={`Edit ${srv.name}`} title="Edit" onClick={() => props.onEdit(srv)}><Ic icon={Pencil} size={14} /></button>
            <button className="icon-btn" aria-label={`Remove ${srv.name}`} title="Remove" onClick={remove}><Ic icon={Trash2} size={14} /></button>
          </>
        )}
      </header>
      <div className="mcp-server-meta">
        <span className="mono dim">{srv.url}</span>
        {srv.header ? <span className="dim small"><span className="mono">{srv.header.name}</span> header {srv.header.stored ? "stored, encrypted" : "not set"}</span> : null}
        {srv.appOrigins.length ? <span className="dim small">Views may reach <span className="mono">{srv.appOrigins.join(", ")}</span></span> : null}
        {tools.length ? <span className="dim small">{tools.length} tools, {ro} read-only</span> : null}
        {srv.detail ? <span className="tone-bad small">{srv.detail}</span> : null}
      </div>
      {!srv.builtin ? (
        <div className="mcp-auto">
          <label className="switch">
            <input type="checkbox" role="switch" checked={srv.autoRun} disabled={busy || (!srv.autoRun && !tools.length)} onChange={toggleAuto} aria-label={`Run ${srv.name}'s read-only tools without asking`} />
            <span>Run read-only tools without asking</span>
          </label>
          <span className="dim small">
            {srv.autoRun
              ? `The ${ro} tools that say they only read, as listed below; if ${srv.name} changes its tools, they ask again.`
              : tools.length ? "Off: every tool asks you in the dock. That a tool only reads is the server's own claim." : "Test it first, to see the tools you'd allow."}
          </span>
          {srv.autoRunNote ? <span className="tone-warn small" role="status"><Ic icon={CircleAlert} size={13} /> {srv.autoRunNote}</span> : null}
        </div>
      ) : null}
      {test === "running" ? <p className="test-line dim mcp-test"><span className="spinner" />Testing…</p> : test ? <TestSteps test={test} inPanel /> : null}
      {tools.length ? (
        <ul className="ov-list mcp-tools" aria-label={`${srv.name} tools`}>
          {tools.map((t) => <ToolRow key={t.name} {...props} tool={t} server={srv} />)}
        </ul>
      ) : !srv.builtin ? <p className="dim small mcp-none">Test it to list its tools.</p> : null}
    </section>
  );
}

function TestSteps({ test, inPanel }: { test: McpTest; inPanel?: boolean }) {
  return (
    <ul className={"test-steps" + (inPanel ? " mcp-test" : "")} aria-label="Test result">
      {test.steps.map((s) => (
        <li key={s.name}><Ic icon={s.ok ? CircleCheck : CircleX} size={13} className={s.ok ? "tone-ok" : "tone-bad"} /><b>{s.name}</b><span>{s.detail}</span></li>
      ))}
    </ul>
  );
}

function ToolRow(props: { tool: McpToolInfo; server: McpServerInfo; handle: string; onOpenObject: (t: ObjectTarget) => void; onError: (m?: string) => void }) {
  const t = props.tool;
  const [tried, setTried] = useState<McpCall | "running">();
  const calls = useMcpCalls();
  const live = typeof tried === "object" ? calls.find((c) => c.id === tried.id) ?? tried : tried;
  const canTry = t.readOnly && t.required.length === 0 && (props.server.builtin || props.server.enabled);
  // Only landlens-kube's tools, and a remote's read-only ones you let run, skip the ask.
  const runsFree = t.readOnly && props.server.autoRun;
  const appOnly = !t.visibility.includes("model");
  const run = () => {
    setTried("running");
    api.invoke("mcp:try", { handle: props.handle, server: props.server.name, tool: t.name }).then(setTried, (e: ApiError) => (setTried(undefined), props.onError(e.message)));
  };
  return (
    <li className="mcp-tool">
      <div className="mcp-tool-row">
        <div className="ov-main">
          <div className="ov-name"><span className="mono">{t.name}</span>{t.title && t.title !== t.name ? <span className="dim">{t.title}</span> : null}</div>
          {t.description ? <div className="ov-detail" title={t.description}>{t.description}</div> : null}
        </div>
        {t.app ? <span className="chip" title={t.app}><Ic icon={LayoutPanelTop} size={11} />{appOnly ? "view only" : "view"}</span> : null}
        {runsFree ? (
          <span className="badge muted" title="Runs without asking"><Ic icon={Eye} size={13} />Read-only</span>
        ) : (
          <span className="badge warn" title={t.readOnly ? "Says it only reads; Claude Code still asks you first" : "Claude Code asks you first"}><Ic icon={CircleAlert} size={13} />Asks first</span>
        )}
        {canTry ? (
          <button className="secondary mcp-try" onClick={run} disabled={live === "running"} aria-label={`Preview ${t.name}`}>
            {live === "running" ? <span className="spinner" /> : <Ic icon={Play} size={13} />}Preview
          </button>
        ) : null}
      </div>
      {live && live !== "running" ? (
        <div className="mcp-tried">
          {hasView(live) ? <AppFrame call={live.id} onOpenObject={props.onOpenObject} /> : live.preview || live.error ? <Well text={live.error ?? live.preview ?? ""} className={live.status === "ok" ? "" : "tool-out"} /> : null}
          <button className="link-btn small" onClick={() => setTried(undefined)}>Close preview</button>
        </div>
      ) : null}
    </li>
  );
}

// ---- add or edit a server -----------------------------------------------------------------------------------------

function ServerDialog(props: { server?: McpServerInfo; context: string; canStore: boolean; onClose: () => void; onSaved: () => void }) {
  const srv = props.server;
  const [name, setName] = useState(srv?.name ?? "");
  const [url, setUrl] = useState(srv?.url ?? "https://");
  const [headerName, setHeaderName] = useState(srv?.header?.name ?? "Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [origins, setOrigins] = useState((srv?.appOrigins ?? []).join(" "));
  const [on, setOn] = useState(srv ? srv.enabled : true);
  const [test, setTest] = useState<McpTest | "running">();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => void setTimeout(() => first.current?.focus(), 0), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), props.onClose());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);

  const value = headerValue.trim();
  const header = headerName.trim() ? { name: headerName.trim(), ...(value ? { value } : {}) } : undefined;
  const runTest = () => {
    setError(undefined);
    setTest("running");
    api.invoke("mcp:test", { ...(srv ? { id: srv.id } : {}), url: url.trim(), ...(header ? { header } : {}) }).then(setTest, (e: ApiError) => (setTest(undefined), setError(e.message)));
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const appOrigins = origins.split(/[\s,]+/).filter(Boolean);
    api.invoke("mcp:save", { ...(srv ? { id: srv.id } : {}), name: name.trim(), url: url.trim(), ...(header && (value || srv?.header) ? { header } : {}), appOrigins })
      .then((s) => (on !== s.enabled ? api.invoke("mcp:enable", { id: s.id, context: props.context, enabled: on }) : s))
      .then(() => props.onSaved(), (e: ApiError) => (setBusy(false), setError(e.message)));
  };

  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-title" onSubmit={save}>
        <header className="dialog-head">
          <span className="kind-tile sm"><Ic icon={Plug} size={15} /></span>
          <h2 id="mcp-title">{srv ? `Edit ${srv.name}` : "Add an MCP server"}</h2>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}><Ic icon={X} size={15} /></button>
        </header>
        <div className="dialog-body">
          <p className="dim">A remote server over streamable HTTP. Landlens connects to it from the main process, adds the header there, and serves its tools to agent sessions under its name; Claude Code never sees the header.</p>
          <label className="form-row">
            <span>Name</span>
            <span className="field"><input ref={first} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Server name" placeholder="clickland" /></span>
            <small className="dim">Lowercase letters, digits and dashes; tools appear as <span className="mono">mcp__{name || "name"}__tool</span>.</small>
          </label>
          <label className="form-row">
            <span>Address</span>
            <span className="field"><input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Server address" /></span>
            <small className="dim">https, or http on this machine only.</small>
          </label>
          <div className="form-pair">
            <label className="form-row">
              <span>Header</span>
              <span className="field"><input value={headerName} onChange={(e) => setHeaderName(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Header name" /></span>
            </label>
            <label className="form-row">
              <span>Value</span>
              <span className="field"><input type="password" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Header value" placeholder={srv?.header?.stored ? "Stored; leave empty to keep it" : "Bearer …"} /></span>
            </label>
          </div>
          <label className="form-row">
            <span>Origins its views may reach</span>
            <span className="field"><input value={origins} onChange={(e) => setOrigins(e.target.value)} spellCheck={false} autoComplete="off" aria-label="View origins" placeholder="none" /></span>
            <small className="dim">https origins, space-separated. A view gets the network only for origins its server declares and you list here.</small>
          </label>
          <label className="switch">
            <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label={`Use on ${props.context}`} />
            <span>On for <span className="mono">{props.context}</span></span>
          </label>
          {!props.canStore ? <p className="tone-bad small">This machine can't encrypt the header (safeStorage is unavailable), so it can't be stored.</p> : null}
          {test === "running" ? <p className="test-line dim"><span className="spinner" />Testing…</p> : test ? <TestSteps test={test} /> : null}
          {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          <span className="grow" />
          <button type="button" className="secondary" onClick={runTest} disabled={test === "running" || !url.trim()}>Test</button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !url.trim()}>Save</button>
        </footer>
      </form>
    </div>
  );
}

// ---- calls ------------------------------------------------------------------------------------------------------------

const CALL_STATUS: Record<McpCall["status"], { word: string; icon: typeof CircleCheck; cls: string }> = {
  running: { word: "Running", icon: CircleDashed, cls: "dim" },
  ok: { word: "OK", icon: CircleCheck, cls: "tone-ok" },
  error: { word: "Failed", icon: CircleX, cls: "tone-bad" },
  refused: { word: "Refused", icon: Ban, cls: "tone-warn" },
};
const ORIGIN_WORD: Record<McpCall["origin"], string> = { agent: "agent", app: "view", you: "you" };

/** "kind name" or the arguments in one line. */
export function argsLine(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const target = [a.kind ?? a.scope, [a.namespace, a.name].filter(Boolean).join("/")].filter(Boolean).join(" ");
  if (target) return target;
  const s = JSON.stringify(a);
  return s === "{}" ? "" : s.slice(0, 120);
}

function Calls(props: { calls: McpCall[]; selected?: string; onSelect: (id: string) => void }) {
  const now = useNow();
  const [session, setSession] = useState("");
  const [server, setServer] = useState("");
  const [status, setStatus] = useState<"all" | "ok" | "error" | "refused">("all");
  const labels = useMemo(() => [...new Set(props.calls.map((c) => c.label))].sort(), [props.calls]);
  const names = useMemo(() => [...new Set(props.calls.map((c) => c.server))].sort(), [props.calls]);
  const shown = props.calls
    .filter((c) => (!session || c.label === session) && (!server || c.server === server) && (status === "all" || c.status === status))
    .slice()
    .reverse();
  const n = (s: McpCall["status"]) => props.calls.filter((c) => c.status === s).length;
  return (
    <>
      <div className="mcp-filters">
        <label className="field select">
          <span className="sr-only">Session</span>
          <select value={session} onChange={(e) => setSession(e.target.value)} aria-label="Session">
            <option value="">All sessions</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="field select">
          <span className="sr-only">Server</span>
          <select value={server} onChange={(e) => setServer(e.target.value)} aria-label="Server">
            <option value="">All servers</option>
            {names.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Status">
          {([["all", "All", props.calls.length], ["ok", "OK", n("ok")], ["error", "Failed", n("error")], ["refused", "Refused", n("refused")]] as const).map(([v, word, count]) => (
            <button key={v} className={status === v ? "on" : ""} aria-pressed={status === v} onClick={() => setStatus(v)}>{word} <b>{count}</b></button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <section className="panel">
          <ul className="ov-list mcp-calls" aria-label="MCP calls">
            {shown.map((c) => {
              const st = CALL_STATUS[c.status];
              return (
                <li key={c.id}>
                  <button className={"ov-row mcp-call" + (props.selected === c.id ? " on" : "")} aria-current={props.selected === c.id ? "true" : undefined} onClick={() => props.onSelect(c.id)}>
                    {c.status === "running" ? <span className="spinner" aria-label="Running" /> : <span role="img" aria-label={st.word} title={st.word}><Ic icon={st.icon} size={14} className={st.cls} /></span>}
                    <div className="ov-main">
                      <div className="ov-name"><span className="mono">{c.server} · {c.tool}</span><span className="dim">{argsLine(c.args)}</span></div>
                      <div className="ov-detail">{c.label}{c.error ? ` · ${c.error}` : ""}</div>
                    </div>
                    {c.app && c.status === "ok" ? <span className="chip"><Ic icon={LayoutPanelTop} size={11} />view</span> : null}
                    <span className="chip">{ORIGIN_WORD[c.origin]}</span>
                    <span className="mono dim mcp-ms">{c.ms !== undefined ? `${c.ms} ms` : "…"}</span>
                    <span className="dim small mcp-age">{age(c.startedAt, now)} ago</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <div className="empty">
          <Ic icon={Plug} size={18} />
          <strong>{props.calls.length ? "No calls match these filters" : "No MCP calls yet"}</strong>
          <span>Calls appear here as agent sessions, views and Preview make them.</span>
        </div>
      )}
    </>
  );
}

// ---- one call, in the drawer --------------------------------------------------------------------------------------

export function McpCallDrawer(props: { id: string; onClose: () => void; onOpenObject: (t: ObjectTarget) => void }) {
  const calls = useMcpCalls();
  const c = calls.find((x) => x.id === props.id);
  if (!c) return null;
  const st = CALL_STATUS[c.status];
  const tone = c.status === "error" ? "bad" : c.status === "refused" ? "warn" : c.status === "ok" ? "ok" : "muted";
  return (
    <aside className="drawer mcp-drawer" aria-label="MCP call">
      <div className="drawer-head">
        <div className="drawer-top">
          <span className={`kind-tile sm ${tone === "bad" || tone === "warn" ? tone : ""}`}><Ic icon={Plug} size={15} /></span>
          <span className="dim small grow">{c.server} · called by {ORIGIN_WORD[c.origin]}</span>
          <button className="icon-btn" aria-label="Close" onClick={props.onClose}><Ic icon={X} size={15} /></button>
        </div>
        <div className="drawer-title mono">{c.tool}</div>
        <div className="drawer-meta">
          <span className={`badge ${tone}`}><Ic icon={st.icon} size={13} />{st.word}</span>
          <span className="dim small">{c.label}</span>
          {c.ms !== undefined ? <span className="mono small">{c.ms} ms</span> : null}
        </div>
      </div>
      <div className="drawer-body">
        <dl className="facts">
          <dt>Started</dt><dd className="mono">{new Date(c.startedAt).toLocaleTimeString()}</dd>
          {c.endedAt ? (<><dt>Ended</dt><dd className="mono">{new Date(c.endedAt).toLocaleTimeString()}</dd></>) : null}
          <dt>Session</dt><dd className="mono">{c.session}</dd>
          {c.toolCallId ? (<><dt>Dock card</dt><dd className="mono">{c.toolCallId}</dd></>) : null}
          {c.app ? (<><dt>View</dt><dd className="mono">{c.app}</dd></>) : null}
        </dl>
        <h3>Arguments</h3>
        <Well text={inputText(c.args)} />
        {c.error ? (<><h3>Why</h3><Well text={c.error} className="tool-out" /></>) : null}
        {c.preview ? (<><h3>Result</h3><Well text={c.preview} className="tool-out" /></>) : null}
        {hasView(c) ? (<><h3>View</h3><AppFrame call={c.id} onOpenObject={props.onOpenObject} /></>) : null}
        {c.server === "landlens-kube" ? (
          <>
            <h3>Front-door requests</h3>
            {c.requests.length ? (
              <ul className="mcp-requests" aria-label="Front-door requests">
                {c.requests.map((r, i) => (
                  <li key={i}>
                    <Ic icon={r.allowed ? CircleCheck : Ban} size={13} className={r.allowed ? "dim" : "tone-bad"} />
                    <span className="mono">{r.method}</span>
                    <span className="mono path" title={r.path}>{r.path}</span>
                    <span className="mono dim">{r.status ?? (r.allowed ? "" : "refused")}</span>
                    {r.reason ? <span className="tone-bad small">{r.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="dim small">None recorded.</p>}
          </>
        ) : null}
      </div>
    </aside>
  );
}
