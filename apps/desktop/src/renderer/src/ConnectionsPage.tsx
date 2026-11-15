// The Connections page (docs/connections.md, wave 6): Landlens's own sign-in to GitHub and Linear, and what their tools
// may do in Claude sessions. One card per provider: who you are, the level (Read only · Ask for writes), whether reads
// run without asking, whether sessions get it at all, and its tools as the vendor's read-only listing sorts them.
// Tokens come in here (a pasted one) and never come back: the page knows ConnInfo only.
import { CONN_NOTES, GITHUB_TOKEN_SHAPE, LINEAR_KEY_SHAPE, type ConnInfo, type ConnList, type ConnMode, type ConnProvider, type McpServerInfo, type McpTest, type McpToolInfo } from "@landlens/contracts";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, ExternalLink, Eye, KeyRound, ShieldCheck, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";
import { copyText } from "./present";

const NAME: Record<ConnProvider, string> = { github: "GitHub", linear: "Linear" };
const DEVICE_PAGE = "https://github.com/login/device";
const GRANTS_PAGE = "https://github.com/settings/applications";
const TOKEN_PAGE: Record<ConnProvider, string> = {
  github: "https://github.com/settings/personal-access-tokens/new",
  linear: "https://linear.app/settings/account/security",
};

/** The providers' own marks, drawn in the ink colour. */
export function ProviderMark({ provider, size = 16 }: { provider: ConnProvider; size?: number }) {
  return (
    <svg className="conn-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {provider === "github" ? (
        <path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3" />
      ) : (
        <path fill="currentColor" d="M2.89 4.18A11.98 11.98 0 0 1 11.99 0C18.62 0 24 5.38 24 12.01c0 3.64-1.62 6.9-4.18 9.1L2.89 4.18ZM1.82 5.63l16.55 16.55c-.52.33-1.07.62-1.65.87L.95 7.28c.25-.58.54-1.13.87-1.65ZM.32 9.16l14.52 14.52c-.71.17-1.44.28-2.2.32L0 11.36c.04-.76.15-1.49.32-2.2Zm-.17 4.86 9.83 9.83a12.02 12.02 0 0 1-9.83-9.83Z" />
      )}
    </svg>
  );
}

const STATE: Record<ConnInfo["state"], { tone: "ok" | "muted" | "warn" | "bad"; word: string; icon: typeof CircleCheck }> = {
  ready: { tone: "ok", word: "Connected", icon: CircleCheck },
  off: { tone: "muted", word: "Not connected", icon: CircleDashed },
  connecting: { tone: "muted", word: "Connecting…", icon: CircleDashed },
  expired: { tone: "warn", word: "Sign-in ran out", icon: CircleAlert },
  failed: { tone: "bad", word: "Failed", icon: CircleX },
};

/** The connections, loaded once and kept live from main's conn:update pushes. */
function useConnections(): [ConnList | undefined, (i: ConnInfo) => void, string | undefined] {
  const [list, setList] = useState<ConnList>();
  const [error, setError] = useState<string>();
  const put = (i: ConnInfo) => setList((l) => (l ? { ...l, [i.provider]: i } : l));
  useEffect(() => {
    void api.invoke("conn:list", {}).then(setList, (e: ApiError) => setError(e.message));
    return api.on("conn:update", (i: ConnInfo) => put(i));
  }, []);
  return [list, put, error];
}

export function ConnectionsPage(props: { context?: string; onOpenMcp?: () => void }) {
  const [list, put, error] = useConnections();
  const [tools, setTools] = useState<Partial<Record<ConnProvider, McpToolInfo[]>>>({});
  // The tool lists come with the MCP page's servers: the connections' last listings, read from main's store.
  const loadTools = () => api.invoke("mcp:servers", props.context ? { context: props.context } : {}).then((s) => {
    const by: Partial<Record<ConnProvider, McpToolInfo[]>> = {};
    for (const srv of s.servers as McpServerInfo[]) if (srv.connection && srv.tools) by[srv.connection] = srv.tools;
    setTools(by);
  }, () => {});
  const ghState = list?.github.state;
  const lnState = list?.linear.state;
  const ghTools = list?.github.tools ? `${list.github.tools.read}/${list.github.tools.write}` : "";
  const lnTools = list?.linear.tools ? `${list.linear.tools.read}/${list.linear.tools.write}` : "";
  useEffect(() => void loadTools(), [ghState, lnState, ghTools, lnTools]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ov conn">
      <div className="mcp-intro">
        <p className="dim">
          Landlens signs in to these services itself and gives their tools to Claude sessions through its MCP gateway, where
          every call is logged{props.onOpenMcp ? <> (<button className="link-btn" onClick={props.onOpenMcp}>MCP → Calls</button>)</> : null}. Tokens stay
          encrypted in the main process; Claude Code never sees them, and nothing is taken from your own Claude Code.
        </p>
      </div>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {list && !list.canStore ? (
        <div className="notice" role="alert">
          <Ic icon={CircleX} size={15} className="tone-bad" />
          <div className="notice-body"><strong>This machine can't encrypt the token, so Landlens won't store it.</strong><p>Connecting is off until the system keychain is available.</p></div>
        </div>
      ) : null}
      {list ? (
        (["github", "linear"] as const).map((p) => <ConnCard key={p} info={list[p]} canStore={list.canStore} tools={tools[p]} onInfo={put} onTools={loadTools} />)
      ) : (
        <>
          <div className="skel" style={{ height: 180 }} />
          <div className="skel" style={{ height: 180 }} />
        </>
      )}
    </div>
  );
}

type Device = { flow: string; userCode: string; expiresIn: number };

function ConnCard(props: { info: ConnInfo; canStore: boolean; tools?: McpToolInfo[]; onInfo: (i: ConnInfo) => void; onTools: () => void }) {
  const c = props.info;
  const p = c.provider;
  const name = NAME[p];
  const st = STATE[c.state];
  const [device, setDevice] = useState<Device>();
  const [flow, setFlow] = useState<string>();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showTools, setShowTools] = useState(false);
  const [review, setReview] = useState<McpTest | "running">();
  const connected = c.state === "ready" || c.state === "expired";
  const offerDevice = p === "linear" || !!c.canDevice;

  // A flow ends in a push: forget it once the provider isn't connecting.
  useEffect(() => {
    if (c.state !== "connecting") {
      setDevice(undefined);
      setFlow(undefined);
    }
    if (c.state === "ready") setTokenOpen(false);
  }, [c.state]);

  const act = <T,>(f: () => Promise<T>, then?: (r: T) => void) => {
    setBusy(true);
    setError(undefined);
    return f().then((r) => then?.(r), (e: ApiError) => setError(e.message)).finally(() => setBusy(false));
  };
  const connect = () => {
    if (p === "github") act(() => api.invoke("conn:github-device", {}), (d) => (setDevice(d), setFlow(d.flow)));
    else act(() => api.invoke("conn:linear-signin", { mode: c.mode }), (r) => setFlow(r.flow));
  };
  const cancel = () => flow && act(() => api.invoke("conn:cancel", { flow }), () => (setDevice(undefined), setFlow(undefined)));
  const disconnect = () => {
    if (!window.confirm(`Disconnect ${name}? Landlens forgets the sign-in; Claude sessions you start from now on won't have ${name}'s tools.`)) return;
    act(() => api.invoke("conn:disconnect", { provider: p }), props.onInfo);
  };
  const set = (prefs: { mode?: ConnMode; readsAuto?: boolean; give?: boolean }) => act(() => api.invoke("conn:set", { provider: p, ...prefs }), props.onInfo);
  const runReview = () => {
    setReview("running");
    setShowTools(true);
    api.invoke("conn:test", { provider: p }).then(setReview, (e: ApiError) => (setReview(undefined), setError(e.message)));
  };
  const accept = () => act(() => api.invoke("conn:repin", { provider: p }), (i) => (props.onInfo(i), setReview(undefined), props.onTools()));

  const drift = c.note === CONN_NOTES.drift;
  const unaccepted = c.note === CONN_NOTES.unaccepted;
  const noteTone = c.state === "failed" || c.state === "off" ? "tone-bad" : "tone-warn";
  const shownTools = review && review !== "running" ? review.tools : props.tools;
  const counts = c.tools;

  return (
    <section className={"panel conn-card" + (drift ? " drift" : "")} aria-label={`${name} connection`}>
      <header className="panel-head">
        <span className="kind-tile sm conn-tile"><ProviderMark provider={p} size={15} /></span>
        <h3>{name}</h3>
        <span className={`badge ${st.tone}`}>{c.state === "connecting" ? <span className="spinner" aria-hidden="true" /> : <Ic icon={st.icon} size={13} />}{st.word}</span>
        <span className="grow" />
        {connected ? (
          <button className="secondary" onClick={disconnect} disabled={busy}>Disconnect</button>
        ) : c.state === "connecting" && flow ? (
          <button className="secondary" onClick={cancel} disabled={busy}>Cancel</button>
        ) : offerDevice && !tokenOpen ? (
          <button className="primary" onClick={connect} disabled={busy || !props.canStore || c.state === "connecting"}>{busy && !tokenOpen ? <span className="spinner" /> : null}Connect</button>
        ) : null}
      </header>

      <div className="conn-body">
        {connected ? (
          <div className="conn-who">
            <span>
              {c.account ? <>Signed in as <b>{c.account.login}</b>{c.account.name ? <span className="dim"> ({c.account.name})</span> : null}{c.account.org ? <span className="dim"> · {c.account.org}</span> : null}</> : "Connected"}
              <span className="dim"> · {c.method === "device" ? "device sign-in" : c.method === "oauth" ? "browser sign-in" : p === "github" ? "pasted token" : "pasted key"}</span>
            </span>
            {c.scopes?.length ? <span className="chips" aria-label={`${name} scopes`}>{c.scopes.map((s) => <span key={s} className="chip mono">{s}</span>)}</span> : null}
          </div>
        ) : null}

        {c.note ? (
          <p className={`conn-note small ${noteTone}`} role="status">
            <Ic icon={CircleAlert} size={13} />
            <span>{drift ? `${name}'s tools changed. Look at them, then accept.` : c.note}</span>
            {(drift || unaccepted) && connected ? <button className="secondary sm" onClick={runReview} disabled={review === "running"}>Review tools</button> : null}
          </p>
        ) : null}
        {error ? <p className="tone-bad small" role="alert">{error}</p> : null}

        {device && c.state === "connecting" ? (
          <div className="conn-device" role="group" aria-label="GitHub device code">
            <span className="dim small">Enter this code at GitHub</span>
            <span className="conn-code mono" aria-label="Device code">{device.userCode}</span>
            <div className="conn-device-acts">
              <button className="secondary" onClick={() => void copyText(device.userCode)}><Ic icon={Copy} size={13} />Copy</button>
              <button className="primary" onClick={() => void api.invoke("link:open", { url: DEVICE_PAGE })}><Ic icon={ExternalLink} size={13} />Open github.com/login/device</button>
            </div>
            <span className="dim small"><span className="spinner" aria-hidden="true" /> Waiting for you to enter it; the code works for {Math.round(device.expiresIn / 60)} minutes.</span>
          </div>
        ) : null}
        {flow && !device && c.state === "connecting" ? (
          <p className="dim small conn-wait"><span className="spinner" aria-hidden="true" /> Finish signing in to Linear in your browser. Landlens is waiting on this machine for its answer.</p>
        ) : null}

        {!connected && c.state !== "connecting" ? (
          tokenOpen || !offerDevice ? (
            <TokenForm provider={p} canStore={props.canStore} busy={busy} onCancel={offerDevice ? () => setTokenOpen(false) : undefined}
              onSubmit={(token) => act(() => api.invoke("conn:token", { provider: p, token }), props.onInfo)} />
          ) : (
            <p className="small dim conn-alt">
              {p === "github" ? "Signs in with a code you enter at github.com. " : "Signs in in your browser, at linear.app. "}
              <button className="link-btn" onClick={() => setTokenOpen(true)}>{p === "github" ? "Use a token instead" : "Use an API key instead"}</button>
            </p>
          )
        ) : null}

        {connected ? (
          <>
            <div className="conn-row">
              <span className="conn-label" id={`${p}-level`}>Level</span>
              <div className="seg conn-seg" role="group" aria-labelledby={`${p}-level`}>
                {([["read", "Read only"], ["ask", "Ask for writes"]] as const).map(([m, word]) => (
                  <button key={m} className={c.mode === m ? "on" : ""} aria-pressed={c.mode === m} disabled={busy} onClick={() => c.mode !== m && set({ mode: m })}>{word}</button>
                ))}
              </div>
              <span className="dim small">
                {c.mode === "read" ? `Sessions get ${name}'s read-only endpoint: no tool that writes exists there.` : "Every write asks you in Claude's panel first."} Autonomous is turned on per session, in Claude's panel.
              </span>
            </div>
            <div className="conn-row">
              <label className="switch">
                <input type="checkbox" role="switch" checked={c.readsAuto} disabled={busy} onChange={() => set({ readsAuto: !c.readsAuto })} aria-label={`${name}: reads run without asking`} />
                <span>Reads run without asking</span>
              </label>
              <span className="dim small">{c.readsAuto ? `The tools ${name}'s read-only endpoint lists, while they are the ones you accepted. A read's arguments go to ${name}.` : "Off: every tool asks."}</span>
            </div>
            <div className="conn-row">
              <label className="switch">
                <input type="checkbox" role="switch" checked={c.give} disabled={busy} onChange={() => set({ give: !c.give })} aria-label={`Give ${name} to Claude sessions`} />
                <span>Give to Claude sessions</span>
              </label>
              <span className="dim small">{c.give ? `Sessions you start get ${name}'s tools, on every cluster.` : "Off: sessions don't get its tools."}</span>
            </div>
            <div className="conn-tools-head">
              <button className="link-btn conn-count" aria-expanded={showTools} onClick={() => setShowTools((s) => !s)} disabled={!counts && !shownTools}>
                {counts ? `${counts.read + counts.write} tools: ${counts.read} read, ${counts.write} write` : "Tools not listed yet"}
              </button>
              <span className="grow" />
              {!drift && !unaccepted ? <button className="secondary sm" onClick={runReview} disabled={review === "running"}>Check tools</button> : null}
            </div>
            {review === "running" ? <p className="test-line dim conn-test"><span className="spinner" />Listing both endpoints…</p> : review ? (
              <>
                <ul className="test-steps conn-test" aria-label="Test result">
                  {review.steps.map((s) => (
                    <li key={s.name}><Ic icon={s.ok ? CircleCheck : CircleX} size={13} className={s.ok ? "tone-ok" : "tone-bad"} /><b>{s.name}</b><span>{s.detail}</span></li>
                  ))}
                </ul>
                <div className="conn-accept">
                  {review.ok && (drift || unaccepted) ? <button className="primary" onClick={accept} disabled={busy}>Accept these tools</button> : null}
                  <button className="link-btn small" onClick={() => setReview(undefined)}>Close</button>
                </div>
              </>
            ) : null}
            {showTools && shownTools?.length ? (
              <ul className="ov-list conn-tools" aria-label={`${name} tools`}>
                {[...shownTools].sort((a, b) => Number(b.readOnly) - Number(a.readOnly) || a.name.localeCompare(b.name)).map((t) => (
                  <ToolRow key={t.name} tool={t} free={t.readOnly && c.readsAuto && !drift && !unaccepted } />
                ))}
              </ul>
            ) : null}
            {p === "github" && c.method === "device" ? (
              <p className="small dim conn-revoke">Disconnecting deletes the token here. To revoke it at GitHub: Settings → Applications → Authorized OAuth Apps <button className="link-btn" onClick={() => void api.invoke("link:open", { url: GRANTS_PAGE })}>Open</button></p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function ToolRow({ tool: t, free }: { tool: McpToolInfo; free: boolean }) {
  const [more, setMore] = useState(false);
  return (
    <li className="mcp-tool">
      <div className="conn-tool-row">
        <div className="ov-main">
          <div className="ov-name"><span className="mono">{t.name}</span>{t.title && t.title !== t.name ? <span className="dim">{t.title}</span> : null}</div>
          {t.description ? (
            <button className={"ov-detail mcp-desc" + (more ? " open" : "")} aria-expanded={more} onClick={() => setMore((m) => !m)} title={more ? undefined : t.description}>{t.description}</button>
          ) : null}
        </div>
        {t.readOnly ? (
          <span className="badge muted" title={free ? "A read: runs without asking" : "A read, but reads ask for now"}><Ic icon={Eye} size={13} />{free ? "Read-only" : "Read, asks"}</span>
        ) : (
          <span className="tool-badges">
            {t.routine ? <span className="badge muted" title="A routine write: in a session where you turn autonomous on, it can run without asking inside the scope you set"><Ic icon={Zap} size={13} />Routine</span> : null}
            <span className="badge warn" title="A write: Claude Code asks you first"><Ic icon={CircleAlert} size={13} />Asks first</span>
          </span>
        )}
      </div>
    </li>
  );
}

function TokenForm(props: { provider: ConnProvider; canStore: boolean; busy: boolean; onCancel: (() => void) | undefined; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  const p = props.provider;
  const shape = p === "github" ? GITHUB_TOKEN_SHAPE : LINEAR_KEY_SHAPE;
  const v = value.trim();
  const bad = v.length > 0 && !shape.test(v);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!v || bad) return;
    props.onSubmit(v);
    setValue("");
  };
  return (
    <form className="conn-token" onSubmit={submit}>
      <label className="form-row">
        <span>{p === "github" ? "Personal access token" : "API key"}</span>
        <span className="field">
          <Ic icon={KeyRound} size={14} />
          <input ref={box} type="password" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off"
            aria-label={`${NAME[p]} ${p === "github" ? "token" : "API key"}`} placeholder={p === "github" ? "github_pat_… or ghp_…" : "lin_api_…"} aria-invalid={bad} />
          {props.onCancel ? <button type="button" className="icon-btn sm" aria-label="Close" onClick={props.onCancel}><Ic icon={X} size={13} /></button> : null}
        </span>
        <small className={bad ? "tone-bad" : "dim"}>
          {bad ? `That isn't shaped like a ${p === "github" ? "GitHub token" : "Linear key"}.`
            : p === "github"
              ? <>A fine-grained token is the one to choose: Metadata read, Contents, Issues and Pull requests read and write, on the repositories you pick. <button type="button" className="link-btn" onClick={() => void api.invoke("link:open", { url: TOKEN_PAGE.github })}>Make one</button></>
              : <>A key made with only <b>Read</b> is the read-only choice. <button type="button" className="link-btn" onClick={() => void api.invoke("link:open", { url: TOKEN_PAGE.linear })}>Make one</button></>}
        </small>
      </label>
      <div className="conn-token-acts">
        <span className="dim small"><Ic icon={ShieldCheck} size={13} /> Checked once with {NAME[p]}, then kept encrypted; it never comes back to this page.</span>
        <span className="grow" />
        <button type="submit" className="primary" disabled={props.busy || !props.canStore || !v || bad}>{props.busy ? <span className="spinner" /> : null}Connect</button>
      </div>
    </form>
  );
}
