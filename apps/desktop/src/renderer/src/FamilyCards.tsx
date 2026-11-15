// The Land family on the Connections page (docs/family.md, wave 7 D106): one card per sibling the person runs, each
// with its mark, a state chip, the address, who the key or sign-in is, and one line per thing it is used for. Keys and
// tokens come in here (a pasted Landflow key, the triage webhook's secret) and never come back: the page knows
// FamilyInfo only. Clickland's key is set in the Clickland settings dialog, as from the graphs.
//
// From part 2 each ready card has two more rows (D108, D110): Tools for Claude (its MCP server in every session, off
// until turned on) and Reads run without asking; a listing that changed since it was accepted says so, with Review
// (the diff by tool name) and Accept (D111).
import { FAMILY_NOTES, LANDFLOW_KEY_SHAPE, TriageHeader, TriagePath, TriageSecret, type FamilyInfo, type FamilyList, type McpTest, type Sibling } from "@landlens/contracts";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type ApiError } from "./api";
import { ClicklandSettings } from "./ClicklandSettings";
import { ToolRow } from "./ConnectionsPage";
import { Ic, SiblingMark } from "./icons";

const NAME: Record<Sibling, string> = { clickland: "Clickland", landflow: "Landflow", landfall: "Landfall" };

const STATE: Record<FamilyInfo["state"], { tone: "ok" | "muted" | "warn" | "bad"; word: string; icon: typeof CircleCheck }> = {
  ready: { tone: "ok", word: "Ready", icon: CircleCheck },
  off: { tone: "muted", word: "Off", icon: CircleDashed },
  connecting: { tone: "muted", word: "Signing in…", icon: CircleDashed },
  expired: { tone: "warn", word: "Sign-in ran out", icon: CircleAlert },
  failed: { tone: "bad", word: "Failed", icon: CircleX },
};

/** The family, loaded once and kept live from main's family:update pushes. */
function useFamily(): [FamilyList | undefined, (i: FamilyInfo) => void, string | undefined] {
  const [list, setList] = useState<FamilyList>();
  const [error, setError] = useState<string>();
  const put = (i: FamilyInfo) => setList((l) => (l ? { ...l, [i.sibling]: i } : l));
  useEffect(() => {
    void api.invoke("family:list", {}).then(setList, (e: ApiError) => setError(e.message));
    return api.on("family:update", (i: FamilyInfo) => put(i));
  }, []);
  return [list, put, error];
}

export function FamilySection(props: { context?: string; handle?: string }) {
  const [list, put, error] = useFamily();
  return (
    <section className="fam" aria-label="Land family">
      <div className="fam-head">
        <h2>Land family</h2>
        <p className="dim small">
          Your own Clickland, Landflow and Landfall. Landlens signs in to each itself, from the main process; keys and tokens
          stay encrypted on this Mac and never come back to this page.
        </p>
      </div>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {list ? (
        <>
          <ClicklandCard info={list.clickland} onInfo={put} {...(props.context ? { context: props.context } : {})} {...(props.handle ? { handle: props.handle } : {})} />
          <LandflowCard info={list.landflow} canStore={list.canStore} onInfo={put} />
          <LandfallCard info={list.landfall} canStore={list.canStore} onInfo={put} />
        </>
      ) : (
        <div className="skel" style={{ height: 140 }} />
      )}
    </section>
  );
}

/** A card's busy state, its one error line, and an action that sets both. */
function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = <T,>(f: () => Promise<T>, then?: (r: T) => void) => {
    setBusy(true);
    setError(undefined);
    return f().then((r) => then?.(r), (e: ApiError) => setError(e.message)).finally(() => setBusy(false));
  };
  return { busy, error, setError, act };
}

function Card(props: { sibling: Sibling; info: FamilyInfo; actions?: ReactNode; children: ReactNode }) {
  const st = STATE[props.info.state];
  const name = NAME[props.sibling];
  return (
    <section className={`panel conn-card fam-card fam-${props.sibling}`} aria-label={`${name} connection`}>
      <header className="panel-head">
        <span className="kind-tile sm conn-tile"><SiblingMark sibling={props.sibling} size={15} /></span>
        <h3>{name}</h3>
        <span className={`badge ${st.tone}`}>{props.info.state === "connecting" ? <span className="spinner" aria-hidden="true" /> : <Ic icon={st.icon} size={13} />}{st.word}</span>
        <span className="grow" />
        {props.actions}
      </header>
      <div className="conn-body">{props.children}</div>
    </section>
  );
}

/** Who a key or sign-in is: name, email, role, how; then its scopes as chips. */
function Who(props: { info: FamilyInfo; how: string; label: string }) {
  const a = props.info.account;
  const name = a?.name ?? a?.email;
  return (
    <div className="conn-who">
      <span>
        {name ? <>Signed in as <b>{name}</b></> : "Signed in"}
        {a?.email && a.email !== name ? <span className="dim"> ({a.email})</span> : null}
        {a?.role ? <span className="dim"> · role {a.role}</span> : null}
        <span className="dim"> · {props.how}</span>
      </span>
      {props.info.scopes?.length ? <span className="chips" aria-label={`${props.label} scopes`}>{props.info.scopes.map((s) => <span key={s} className="chip mono">{s}</span>)}</span> : null}
    </div>
  );
}

function Note(props: { info: FamilyInfo }) {
  const n = props.info.note;
  if (!n) return null;
  const tone = props.info.state === "failed" || props.info.state === "off" ? "tone-bad" : "tone-warn";
  return <p className={`conn-note small ${tone}`} role="status"><Ic icon={CircleAlert} size={13} /><span>{n}</span></p>;
}

/** One line of what a sibling is used for: the use, a sentence, and its state at the right. */
function Row(props: { label: string; say: ReactNode; state: string; tone: "ok" | "muted" | "warn"; children?: ReactNode }) {
  return (
    <li className="fam-row">
      <span className="fam-label">{props.label}</span>
      <span className="fam-say small dim">{props.say}</span>
      <span className="fam-state">
        <span className={`fam-dot ${props.tone}`} aria-hidden="true" />
        <span className="small">{props.state}</span>
        {props.children}
      </span>
    </li>
  );
}

/**
 * Tools for Claude and Reads run without asking (D108, D110), as two rows, and below the list the review of its tools:
 * Check's steps, what changed since they were accepted (D111), the tools as Landlens counts them, and Accept.
 */
function useTools(info: FamilyInfo, onInfo: (i: FamilyInfo) => void) {
  const s = info.sibling;
  const name = NAME[s];
  const { busy, error, setError, act } = useAct();
  const [review, setReview] = useState<McpTest | "running">();
  const set = (p: { toSessions?: boolean; readsAuto?: boolean }) => act(() => api.invoke("family:set", { sibling: s, ...p }), onInfo);
  const runReview = () => {
    setReview("running");
    setError(undefined);
    api.invoke("family:test", { sibling: s }).then(setReview, (e: ApiError) => (setReview(undefined), setError(e.message)));
  };
  const accept = () => act(() => api.invoke("family:repin", { sibling: s }), (i) => (onInfo(i), setReview(undefined)));
  const n = info.tools;
  const counts = n ? `${n.read} read · ${n.write} ask` : undefined;
  const asks = info.drift || info.note === FAMILY_NOTES.unaccepted;
  const rows = (
    <>
      <Row label="Tools for Claude"
        say={info.toSessions ? <>Every Claude session, on every cluster, gets the <span className="mono">{s}</span> MCP tools. A write always asks you.</> : "Off: Claude sessions don't get its tools."}
        state={info.toSessions ? (counts ?? "On") : "Off"} tone={info.toSessions ? (asks ? "warn" : "ok") : "muted"}>
        <label className="switch fam-switch">
          <input type="checkbox" role="switch" checked={info.toSessions} disabled={busy} onChange={() => set({ toSessions: !info.toSessions })} aria-label={`${name}: tools for Claude`} />
        </label>
      </Row>
      <Row label="Reads run without asking"
        say={info.readsAuto ? <>Reads are the tools Landlens's list and {name} both call reads. Their arguments go to {name} without a prompt.</> : "Off: every tool asks."}
        state={info.readsAuto ? (info.drift ? "Paused" : "On") : "Off"} tone={info.readsAuto && info.toSessions && !info.drift ? "ok" : "muted"}>
        <label className="switch fam-switch">
          <input type="checkbox" role="switch" checked={info.readsAuto} disabled={busy} onChange={() => set({ readsAuto: !info.readsAuto })} aria-label={`${name}: reads run without asking`} />
        </label>
      </Row>
    </>
  );
  const done = review && review !== "running" ? review : undefined;
  const diff = done?.diff;
  const changed = diff && (diff.added.length || diff.removed.length || diff.changed.length);
  const panel = (
    <>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {info.toSessions && info.state === "ready" ? (
        <div className="fam-acts">
          <button className={asks ? "primary sm" : "secondary sm"} onClick={runReview} disabled={review === "running"}>{asks ? "Review tools" : "Check tools"}</button>
          <span className="dim small">{asks ? (info.drift ? "Its tools changed since you accepted them." : "Its tools aren't accepted yet.") : "List its tools again and compare them with the ones you accepted."}</span>
        </div>
      ) : null}
      {review === "running" ? <p className="test-line dim conn-test"><span className="spinner" />Listing its tools…</p> : done ? (
        <div className="fam-check" aria-label={`${name} tools review`} role="group">
          <ul className="test-steps conn-test" aria-label="Test result">
            {done.steps.map((x, i) => (
              <li key={`${x.name}-${i}`}><Ic icon={x.ok ? CircleCheck : CircleX} size={13} className={x.ok ? "tone-ok" : "tone-bad"} /><b>{x.name}</b><span>{x.detail}</span></li>
            ))}
          </ul>
          {changed ? (
            <dl className="fam-diff small" aria-label="What changed">
              {diff.added.length ? <div><dt>New</dt><dd className="mono">{diff.added.join(", ")}</dd></div> : null}
              {diff.changed.length ? <div><dt>Changed</dt><dd className="mono">{diff.changed.join(", ")}</dd></div> : null}
              {diff.removed.length ? <div><dt>Gone</dt><dd className="mono">{diff.removed.join(", ")}</dd></div> : null}
            </dl>
          ) : null}
          {done.tools?.length ? (
            <ul className="ov-list conn-tools" aria-label={`${name} tools`}>
              {[...done.tools].sort((a, b) => Number(b.readOnly) - Number(a.readOnly) || a.name.localeCompare(b.name)).map((t) => (
                <ToolRow key={t.name} tool={t} free={t.readOnly && info.readsAuto && !info.drift} />
              ))}
            </ul>
          ) : null}
          <div className="conn-accept">
            {done.ok === false && info.drift ? <button className="primary" onClick={accept} disabled={busy}>Accept these tools</button> : null}
            <button className="link-btn small" onClick={() => setReview(undefined)}>Close</button>
          </div>
        </div>
      ) : null}
    </>
  );
  return { rows, panel };
}

function Address(props: { url: string }) {
  return props.url ? <p className="fam-addr small"><span className="dim">Address</span> <span className="mono">{props.url}</span></p> : null;
}

/** Check: health and who-am-I again, as a list of steps. */
function useCheck(sibling: Sibling, setError: (e: string | undefined) => void) {
  const [result, setResult] = useState<McpTest | "running">();
  const run = () => {
    setResult("running");
    setError(undefined);
    api.invoke("family:test", { sibling }).then(setResult, (e: ApiError) => (setResult(undefined), setError(e.message)));
  };
  const view = result === "running" ? (
    <p className="test-line dim conn-test"><span className="spinner" />Checking…</p>
  ) : result ? (
    <div className="fam-check">
      <ul className="test-steps conn-test" aria-label={`${NAME[sibling]} check`}>
        {result.steps.map((s) => (
          <li key={s.name}><Ic icon={s.ok ? CircleCheck : CircleX} size={13} className={s.ok ? "tone-ok" : "tone-bad"} /><b>{s.name}</b><span>{s.detail}</span></li>
        ))}
      </ul>
      <button className="link-btn small" onClick={() => setResult(undefined)}>Close</button>
    </div>
  ) : null;
  return { run, running: result === "running", view };
}

// ---- Clickland ------------------------------------------------------------------------------------------------------

function ClicklandCard(props: { info: FamilyInfo; context?: string; handle?: string; onInfo: (i: FamilyInfo) => void }) {
  const c = props.info;
  const { busy, error, setError, act } = useAct();
  const [settings, setSettings] = useState(false);
  const check = useCheck("clickland", setError);
  const tools = useTools(c, props.onInfo);
  const on = c.state !== "off";
  const disconnect = () => {
    if (!window.confirm("Forget Clickland's key? Graphs fall back to the cluster's Prometheus or metrics-server until a key is saved again.")) return;
    act(() => api.invoke("family:disconnect", { sibling: "clickland" }), props.onInfo);
  };
  return (
    <Card sibling="clickland" info={c} actions={on ? (
      <>
        <button className="secondary" onClick={() => setSettings(true)}>Settings…</button>
        <button className="secondary" onClick={disconnect} disabled={busy}>Disconnect</button>
      </>
    ) : <button className="primary" onClick={() => setSettings(true)}>Connect…</button>}>
      {on ? <Address url={c.url} /> : null}
      {on ? <Who info={c} how="read key" label="Clickland" /> : (
        <p className="small dim">Clickland keeps the cluster's metrics, logs and traces. Landlens reads it with a key that has the <span className="mono">read</span> scope, made in Clickland under Settings → API keys.</p>
      )}
      <Note info={c} />
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      <ul className="fam-rows" aria-label="What Clickland is used for">
        <Row label="Graphs" say="CPU and memory history on the Metrics tab and the Overview, through this key." state={c.state === "ready" ? "In use" : "Not in use"} tone={c.state === "ready" ? "ok" : "muted"} />
        {c.state === "ready" ? tools.rows : null}
      </ul>
      {c.state === "ready" ? tools.panel : null}
      {on ? (
        <div className="fam-acts">
          <button className="secondary sm" onClick={check.run} disabled={check.running}>Check</button>
          <span className="dim small">Its health, and who the key is.</span>
        </div>
      ) : null}
      {check.view}
      {settings ? (
        <ClicklandSettings {...(props.handle ? { handle: props.handle } : {})} {...(props.context ? { context: props.context } : {})} onClose={() => setSettings(false)} onSaved={() => undefined} />
      ) : null}
    </Card>
  );
}

// ---- Landflow -------------------------------------------------------------------------------------------------------

function LandflowCard(props: { info: FamilyInfo; canStore: boolean; onInfo: (i: FamilyInfo) => void }) {
  const c = props.info;
  const { busy, error, setError, act } = useAct();
  const check = useCheck("landflow", setError);
  const [editTriage, setEditTriage] = useState(false);
  const tools = useTools(c, props.onInfo);
  const connected = c.state === "ready";
  const disconnect = () => {
    if (!window.confirm("Disconnect Landflow? Landlens deletes the key and the webhook's secret here. To revoke the key, open Landflow → Settings → API keys.")) return;
    act(() => api.invoke("family:disconnect", { sibling: "landflow" }), props.onInfo);
  };
  const can = c.can;
  const flowsMissing = can ? [!can.flows && "workflows:read", !can.run && "run"].filter(Boolean) as string[] : [];
  return (
    <Card sibling="landflow" info={c} actions={connected ? <button className="secondary" onClick={disconnect} disabled={busy}>Disconnect</button> : null}>
      {connected ? (
        <>
          <Address url={c.url} />
          <Who info={c} how="API key" label="Landflow" />
          <Note info={c} />
          {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
          <ul className="fam-rows" aria-label="What Landflow is used for">
            <Row label="Brain" say={can?.brain ? "Can record your work: a session's summary, when you send one." : <>The key has no <span className="mono">brain:write</span>.</>}
              state={can?.brain ? "Can record" : "No scope"} tone={can?.brain ? "ok" : "muted"} />
            <Row label="Flows" say={flowsMissing.length ? <>The key has no <span className="mono">{flowsMissing.join(" or ")}</span>.</> : can?.runs ? "Can list and run the flows tagged landlens, and follow a run." : <>Can list and run the flows tagged landlens. Without <span className="mono">executions:read</span> a run is a link to Landflow.</>}
              state={flowsMissing.length ? "No scope" : "Can list and run"} tone={flowsMissing.length ? "muted" : "ok"} />
            <Row label="Triage webhook" say={c.triage ? <><span className="mono">/api/webhook/{c.triage.path}</span> · header <span className="mono">{c.triage.header}</span></> : "Where a problem goes to Landflow's triage flow. Not set up."}
              state={c.triage ? (c.triage.hasSecret ? "Secret stored" : "No secret") : "Not set up"} tone={c.triage?.hasSecret ? "ok" : c.triage ? "warn" : "muted"}>
              {!editTriage ? <button className="secondary sm" onClick={() => setEditTriage(true)}>{c.triage ? "Edit" : "Set up"}</button> : null}
            </Row>
            {tools.rows}
          </ul>
          {tools.panel}
          {editTriage ? <TriageForm info={c} onDone={(i) => (i && props.onInfo(i), setEditTriage(false))} /> : null}
          <div className="fam-acts">
            <button className="secondary sm" onClick={check.run} disabled={check.running}>Check</button>
            <span className="dim small">Its health, and who the key is.</span>
          </div>
          {check.view}
        </>
      ) : (
        <>
          <Note info={c} />
          <LandflowForm url={c.url} canStore={props.canStore} busy={busy} error={error}
            onSubmit={(url, key) => act(() => api.invoke("family:connect", { sibling: "landflow", url, key }), props.onInfo)} />
        </>
      )}
    </Card>
  );
}

function LandflowForm(props: { url: string; canStore: boolean; busy: boolean; error: string | undefined; onSubmit: (url: string, key: string) => void }) {
  const [url, setUrl] = useState(props.url);
  const [key, setKey] = useState("");
  const k = key.trim();
  const bad = k.length > 0 && !LANDFLOW_KEY_SHAPE.test(k);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !k || bad) return;
    props.onSubmit(url.trim(), k);
    setKey("");
  };
  return (
    <form className="conn-token fam-form" onSubmit={submit}>
      <label className="form-row">
        <span>Address</span>
        <span className="field"><input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Landflow address" placeholder="https://landflow.example or http://127.0.0.1:3000" /></span>
        <small className="dim">https, or plain http to this machine. Landflow in your cluster: forward <span className="mono">landflow-host:3000</span> under Forwards and use <span className="mono">http://127.0.0.1:&lt;port&gt;</span>.</small>
      </label>
      <label className="form-row">
        <span>API key</span>
        <span className="field">
          <Ic icon={KeyRound} size={14} />
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Landflow API key" placeholder="lf_…" aria-invalid={bad} />
        </span>
        <small className={bad ? "tone-bad" : "dim"}>
          {bad ? "That isn't shaped like a Landflow API key (lf_…, not lf_mcp_ or lf_key_)."
            : <>Make one in Landflow: your menu → Connect your harness → Any MCP client, with <b>Brain</b> ticked, and <b>Read workflows</b> and <b>Run</b> for flows on a resource. Add <span className="mono">executions:read</span> under Settings → API keys to follow a run.</>}
        </small>
      </label>
      {props.error ? <p className="tone-bad small" role="alert">{props.error}</p> : null}
      <div className="conn-token-acts">
        <span className="dim small"><Ic icon={ShieldCheck} size={13} /> Checked once with Landflow, then kept encrypted; it never comes back to this page.</span>
        <span className="grow" />
        <button type="submit" className="primary" disabled={props.busy || !props.canStore || !url.trim() || !k || bad}>{props.busy ? <span className="spinner" /> : null}Connect</button>
      </div>
    </form>
  );
}

/** The triage webhook's three settings (D121): path, header name, and its secret (kept if left empty). */
function TriageForm(props: { info: FamilyInfo; onDone: (i?: FamilyInfo) => void }) {
  const t = props.info.triage;
  const [path, setPath] = useState(t?.path ?? "alerts");
  const [header, setHeader] = useState(t?.header ?? "X-Webhook-Secret");
  const [secret, setSecret] = useState("");
  const { busy, error, act } = useAct();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const pathOk = TriagePath.safeParse(path.trim()).success;
  const headerOk = TriageHeader.safeParse(header.trim()).success;
  const s = secret.trim();
  const secretOk = !s || TriageSecret.safeParse(s).success;
  const needSecret = !t?.hasSecret && !s;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!pathOk || !headerOk || !secretOk || needSecret) return;
    act(() => api.invoke("family:set", { sibling: "landflow", triage: { path: path.trim(), header: header.trim(), ...(s ? { secret: s } : {}) } }), (i) => props.onDone(i));
  };
  const remove = () => act(() => api.invoke("family:set", { sibling: "landflow", triage: null }), (i) => props.onDone(i));
  return (
    <form className="conn-token fam-form" onSubmit={save} aria-label="Triage webhook">
      <p className="small dim fam-form-say">What the triage flow's <b>Webhook secret</b> credential holds in Landflow. Its header can't be <span className="mono">Authorization</span>.</p>
      <label className="form-row">
        <span>Path</span>
        <span className="field"><span className="dim mono small">/api/webhook/</span><input ref={first} value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Webhook path" aria-invalid={!pathOk} /></span>
      </label>
      <label className="form-row">
        <span>Header</span>
        <span className="field"><input value={header} onChange={(e) => setHeader(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Webhook header name" aria-invalid={!headerOk} /></span>
        {!headerOk ? <small className="tone-bad">Letters, digits and dashes; not Authorization, Cookie, Host or X-Landlens-….</small> : null}
      </label>
      <label className="form-row">
        <span>Secret</span>
        <span className="field"><Ic icon={KeyRound} size={14} /><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Webhook secret" aria-invalid={!secretOk} placeholder={t?.hasSecret ? "Stored; leave empty to keep it" : "The header's value"} /></span>
        {!secretOk ? <small className="tone-bad">One line of printable characters, at most 400.</small> : null}
      </label>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      <div className="conn-token-acts">
        {t ? <button type="button" className="link-btn danger small" onClick={remove} disabled={busy}>Remove</button> : null}
        <span className="grow" />
        <button type="button" className="secondary" onClick={() => props.onDone()}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !pathOk || !headerOk || !secretOk || needSecret}>Save</button>
      </div>
    </form>
  );
}

// ---- Landfall -------------------------------------------------------------------------------------------------------

function LandfallCard(props: { info: FamilyInfo; canStore: boolean; onInfo: (i: FamilyInfo) => void }) {
  const c = props.info;
  const { busy, error, setError, act } = useAct();
  const check = useCheck("landfall", setError);
  const tools = useTools(c, props.onInfo);
  const [url, setUrl] = useState(c.url);
  const [flow, setFlow] = useState<string>();
  useEffect(() => {
    if (c.state !== "connecting") setFlow(undefined);
  }, [c.state]);
  useEffect(() => {
    if (c.url) setUrl(c.url);
  }, [c.url]);
  const signedIn = c.state === "ready" || c.state === "expired";
  const signin = (e?: FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    act(() => api.invoke("family:signin", { sibling: "landfall", url: url.trim() }), (r) => setFlow(r.flow));
  };
  const cancel = () => flow && act(() => api.invoke("conn:cancel", { flow }), () => setFlow(undefined));
  const disconnect = () => {
    if (!window.confirm("Sign out of Landfall? Landlens asks Landfall to revoke the sign-in, then deletes it here.")) return;
    act(() => api.invoke("family:disconnect", { sibling: "landfall" }), props.onInfo);
  };
  return (
    <Card sibling="landfall" info={c} actions={signedIn ? (
      <>
        {c.state === "expired" ? <button className="primary" onClick={() => signin()} disabled={busy || !props.canStore}>Sign in again</button> : null}
        <button className="secondary" onClick={disconnect} disabled={busy}>Sign out</button>
      </>
    ) : c.state === "connecting" && flow ? <button className="secondary" onClick={cancel} disabled={busy}>Cancel</button> : null}>
      {signedIn ? (
        <>
          <Address url={c.url} />
          <Who info={c} how="browser sign-in" label="Landfall" />
        </>
      ) : null}
      <Note info={c} />
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {c.state === "connecting" ? (
        <p className="dim small conn-wait"><span className="spinner" aria-hidden="true" /> Finish signing in to Landfall in your browser. Landlens is waiting on this machine for its answer.</p>
      ) : !signedIn ? (
        <form className="conn-token fam-form" onSubmit={signin}>
          <label className="form-row">
            <span>Address</span>
            <span className="field"><input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Landfall address" placeholder="https://landfall.example or http://127.0.0.1:3001" /></span>
            <small className="dim">Signs in on Landfall's own page in your browser (through Landbright). Landlens asks for <span className="mono">mcp:read</span> only, and needs Landfall's MCP connector on.</small>
          </label>
          <div className="conn-token-acts">
            <span className="grow" />
            <button type="submit" className="primary" disabled={busy || !props.canStore || !url.trim()}>{busy ? <span className="spinner" /> : null}Sign in</button>
          </div>
        </form>
      ) : null}
      <ul className="fam-rows" aria-label="What Landfall is used for">
        <Row label="War rooms" say="War rooms open through Landflow's triage flow. Landlens never opens one itself." state="Through Landflow" tone="muted" />
        {c.state === "ready" ? tools.rows : null}
      </ul>
      {c.state === "ready" ? tools.panel : null}
      {signedIn ? (
        <div className="fam-acts">
          <button className="secondary sm" onClick={check.run} disabled={check.running}>Check</button>
          <span className="dim small">Its connector, and that the sign-in still works.</span>
        </div>
      ) : null}
      {check.view}
    </Card>
  );
}
