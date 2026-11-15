import type { KubeObject, ResourceType } from "@landlens/contracts";
import { age, podReady, podRestarts, podStatus, type Tone } from "@landlens/kube/status";
import { Box, Check, ChevronRight, CircleX, Clock, Copy, ScrollText, Server, Sparkles, SquareTerminal, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { stringify } from "yaml";
import type { AskContext } from "./AgentDock";
import { api, type ApiError } from "./api";
import { Ic, iconOfKind, kindIcon } from "./icons";
import { copyText, duration, splitName, statusTone } from "./present";
import { Status } from "./ResourceTable";
import { Yaml } from "./Yaml";
import { MetricsTab, metricsScope } from "./MetricsTab";
import type { LogSource, ShellTarget } from "./benchState";
import { logSourceOf, LogsView } from "./LogsView";
import { direct, shellable, ShellMenu, targetOf, useCanExec } from "./ShellMenu";

type Tab = "overview" | "events" | "yaml" | "metrics" | "logs";
export type NavTarget = { kind: string; name: string; namespace?: string };

/** Waiting reasons that mean a container can't run (kept in step with packages/kube/src/health.ts). */
const BAD_WAITING = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName", "RunContainerError"]);

/** The details drawer: what this object is, what is wrong with it, its events, and its YAML. */
export function Details(props: {
  handle: string;
  type: ResourceType;
  object: KubeObject;
  /** The object's tone from its list row (Ready for workloads), when it has one. */
  tone?: Tone;
  now: number;
  onClose: () => void;
  onAsk: (c: AskContext) => void;
  onNavigate: (t: NavTarget) => void;
  /** Changes when the Clickland settings do. */
  metricsVersion: number;
  onSettings: () => void;
  /** Open a pod shell, or logs, in the panel. */
  onShell: (t: ShellTarget) => void;
  onLogsInPanel: (s: LogSource) => void;
  /** Asked from outside (a row's menu): show this tab, on this container. Changes `n` to ask again. */
  show?: { tab: "logs" | "shell"; container?: string; n: number };
}) {
  const { object: o, type, now } = props;
  const logs = logSourceOf(type.kind, o);
  const TABS: Tab[] = [...(metricsScope(type) ? ["overview", "events", "yaml", "metrics"] as Tab[] : ["overview", "events", "yaml"] as Tab[]), ...(logs ? ["logs" as Tab] : [])];
  const [tab, setTab] = useState<Tab>("overview");
  const [logContainer, setLogContainer] = useState<string>();
  const [shellMenu, setShellMenu] = useState(false);
  const canExec = useCanExec(props.handle, o.metadata.namespace);
  const pod = type.resource === "pods" && type.group === "";
  const workloadSel = logs?.selector ? { namespace: logs.namespace, selector: logs.selector } : undefined;
  const openShell = () => {
    const d = pod ? direct(o) : undefined;
    if (d) return props.onShell(d);
    setShellMenu((m) => !m);
  };
  const showLogs = (container?: string) => {
    setLogContainer(container);
    setTab("logs");
  };
  useEffect(() => {
    if (!props.show) return;
    if (props.show.tab === "logs") showLogs(props.show.container);
    else openShell();
  }, [props.show?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [events, setEvents] = useState<KubeObject[] | { error: string }>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setEvents(undefined);
    api
      .invoke("resource:events", { handle: props.handle, uid: o.metadata.uid, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}) })
      .then((r) => setEvents(r.items), (e: ApiError) => setEvents({ error: e.message }));
  }, [props.handle, o.metadata.uid, o.metadata.resourceVersion]);

  // [ and ] step through the tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "[" && e.key !== "]")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable]") || t.closest(".dock"))) return;
      setTab((cur) => TABS[(TABS.indexOf(cur) + (e.key === "]" ? 1 : TABS.length - 1)) % TABS.length]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [TABS.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((tab === "metrics" && !metricsScope(type)) || (tab === "logs" && !logs)) setTab("overview");
  }, [tab, type, logs]);
  const view = isSecret(type) ? redactSecret(o) : o;
  const status = pod ? podStatus(o) : undefined;
  const tone = status ? statusTone(status.text, status.tone) : props.tone;
  const { base, hash } = splitName(o);
  const created = Date.parse(o.metadata.creationTimestamp ?? "");
  const warnings = Array.isArray(events) && events.some((e: any) => e.type === "Warning");

  return (
    <aside className="drawer" aria-label={`${type.kind} ${o.metadata.name}`}>
      <header className="drawer-head">
        <div className="drawer-top">
          <span className={`kind-tile sm${tone === "bad" || tone === "warn" ? ` ${tone}` : ""}`}><Ic icon={kindIcon(type.resource)} size={15} /></span>
          <div className="eyebrow">{type.kind}{o.metadata.namespace ? <><span className="sep"> / </span>{o.metadata.namespace}</> : null}</div>
          <span className="grow" />
          {pod || workloadSel ? (
            <button className="icon-btn" aria-label="Open shell" aria-haspopup={pod && direct(o) ? undefined : "menu"} disabled={canExec === false}
              title={canExec === false ? `Your role can't exec in ${o.metadata.namespace}` : pod && !shellable(o).some((c) => c.running) ? "No container is running" : "Open a shell (runs as you)"}
              onClick={openShell}><Ic icon={SquareTerminal} size={15} /></button>
          ) : null}
          {shellMenu ? (
            <ShellMenu handle={props.handle} {...(pod ? { pod: o } : workloadSel ? { workload: workloadSel } : {})}
              onPick={(t) => (setShellMenu(false), props.onShell(t))} onClose={() => setShellMenu(false)} />
          ) : null}
          {isSecret(type) ? null : (
            <button
              className="ask-btn"
              onClick={() => props.onAsk({
                ref: { group: type.group, version: type.version, resource: type.resource, name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}) },
                label: `${type.kind} ${o.metadata.namespace ? `${o.metadata.namespace}/` : ""}${o.metadata.name}`,
              })}
            ><Ic icon={Sparkles} size={14} />Ask Claude</button>
          )}
          <button
            className="icon-btn"
            aria-label={copied ? "Name copied" : "Copy name"}
            title={copied ? "Copied" : "Copy name"}
            onClick={() => void copyText(o.metadata.name).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })}
          ><Ic icon={copied ? Check : Copy} size={15} /></button>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close details" title="Close (Esc)"><Ic icon={X} size={15} /></button>
        </div>
        <h2 className="drawer-title">{base}{hash ? <span className="hash">{hash}</span> : null}</h2>
        <div className="drawer-meta">
          {status ? <Status text={status.text} tone={status.tone} /> : null}
          {pod ? (
            <>
              <span className="meta"><b className="mono">{podReady(o).text}</b> ready</span>
              <span className="meta"><b className="mono">{podRestarts(o).text}</b> restarts</span>
            </>
          ) : readyOf(o) ? <span className="meta"><b className="mono">{readyOf(o)}</b> ready</span> : null}
          <span className="meta"><b className="mono">{age(created, now)}</b> old</span>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Details">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "yaml" ? "YAML" : t[0]!.toUpperCase() + t.slice(1)}
            {t === "events" && Array.isArray(events) && events.length ? <span className={"count" + (warnings ? " warn" : "")} aria-hidden="true">{events.length}</span> : null}
          </button>
        ))}
      </nav>
      <div className={"drawer-body" + (tab === "logs" ? " flush" : "")}>
        {tab === "logs" && logs ? (
          <LogsView key={`${o.metadata.uid}`} handle={props.handle} source={{ ...logs, ...(logContainer ? { container: logContainer } : {}) }} place="drawer" onAsk={props.onAsk} onOpenInPanel={props.onLogsInPanel} />
        ) : null}
        {tab === "overview" && <Overview o={view} type={type} now={now} onNavigate={props.onNavigate}
          onLogs={showLogs} onShell={(c) => props.onShell(targetOf(o, c, "auto"))} canExec={canExec} />}
        {tab === "events" && <Events events={events} now={now} />}
        {tab === "yaml" && <Yaml text={stringify(view, { lineWidth: 0 })} />}
        {tab === "metrics" && metricsScope(type) && <MetricsTab handle={props.handle} type={type} object={o} version={props.metricsVersion} onSettings={props.onSettings} />}
      </div>
    </aside>
  );
}

const LIFECYCLE = ["PodScheduled", "PodReadyToStartContainers", "Initialized", "ContainersReady", "Ready"];
const lifecycle = (t: string) => (LIFECYCLE.indexOf(t) + 1 || 99);

function readyOf(o: KubeObject): string | undefined {
  const s = o.status ?? {};
  if (typeof o.spec?.replicas === "number") return `${s.readyReplicas ?? 0}/${o.spec.replicas}`;
  if (typeof s.desiredNumberScheduled === "number") return `${s.numberReady ?? 0}/${s.desiredNumberScheduled}`;
  return undefined;
}

function Overview({ o, type, now, onNavigate, onLogs, onShell, canExec }: {
  o: KubeObject; type: ResourceType; now: number; onNavigate: (t: NavTarget) => void;
  onLogs: (container: string) => void; onShell: (container: string) => void; canExec: boolean | undefined;
}) {
  const pod = type.resource === "pods" && type.group === "";
  const created = Date.parse(o.metadata.creationTimestamp ?? "");
  // In the order they happened; ties (most of them share the pod's first seconds) in lifecycle order.
  const conditions: any[] = [...(o.status?.conditions ?? [])].sort(
    (a, b) => (Date.parse(a.lastTransitionTime ?? "") || 0) - (Date.parse(b.lastTransitionTime ?? "") || 0) || lifecycle(a.type) - lifecycle(b.type),
  );
  const owners = o.metadata.ownerReferences ?? [];
  const annotations = Object.entries(o.metadata.annotations ?? {}).filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration");
  return (
    <div className="overview">
      {pod ? <Diagnosis pod={o} now={now} /> : null}
      <dl className="facts">
        {owners.length ? (
          <>
            <dt>Owner</dt>
            <dd>
              {owners.map((r) => (
                <button key={r.uid ?? r.name} className="ref" onClick={() => onNavigate({ kind: r.kind, name: r.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}) })}>
                  <Ic icon={iconOfKind(r.kind)} size={12} />{r.kind}/{r.name}
                </button>
              ))}
            </dd>
          </>
        ) : null}
        {pod ? (
          <>
            <dt>Node</dt>
            <dd>{o.spec?.nodeName ? <button className="ref" onClick={() => onNavigate({ kind: "Node", name: o.spec!.nodeName })}><Ic icon={Server} size={12} />{o.spec.nodeName}</button> : "—"}</dd>
            <dt>Pod IP</dt><dd className="mono">{o.status?.podIP ?? "—"}</dd>
          </>
        ) : null}
        <dt>Created</dt>
        <dd>{age(created, now)} ago <span className="dim mono">· {o.metadata.creationTimestamp?.replace("T", " ")}</span></dd>
      </dl>
      {pod ? <Containers pod={o} now={now} onLogs={onLogs} onShell={onShell} canExec={canExec} /> : null}
      {conditions.length ? (
        <section>
          <h3>Conditions</h3>
          <ul className="conditions">
            {conditions.map((c) => {
              const on = c.status === "True";
              const why = [c.reason, c.message].filter(Boolean).join(" · ");
              return (
                <li key={c.type} className={on ? "" : "off"} title={why || undefined}>
                  <Ic icon={on ? Check : X} size={13} className={on ? "tone-ok" : "tone-bad"} />
                  <span>{c.type}</span>
                  <span className="sr-only">{on ? "true" : "false"}</span>
                  {why ? <em>{why}</em> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <Labels title="Labels" map={o.metadata.labels} />
      {annotations.length ? (
        <details className="fold">
          <summary><Ic icon={ChevronRight} size={12} />Annotations <span className="count">{annotations.length}</span></summary>
          <div className="chips">{annotations.map(([k, v]) => <span key={k} className="chip mono" title={`${k}=${v}`}><i>{k}</i>{v}</span>)}</div>
        </details>
      ) : null}
    </div>
  );
}

/** For a pod that isn't fine: what is wrong, in one card, from the pod object alone. */
function Diagnosis({ pod, now }: { pod: KubeObject; now: number }) {
  const status = podStatus(pod);
  const tone = statusTone(status.text, status.tone);
  if (tone !== "bad" && tone !== "warn") return null;
  const all: any[] = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const c = all.find((x) => BAD_WAITING.has(x.state?.waiting?.reason) || (x.state?.terminated && x.state.terminated.exitCode !== 0))
    ?? all.find((x) => x.lastState?.terminated && !x.ready)
    ?? all.find((x) => x.state?.waiting);
  const waiting = c?.state?.waiting;
  const term = c?.state?.terminated ?? c?.lastState?.terminated;
  const name = c ? <span className="mono">{c.name}</span> : null;

  let title: ReactNode;
  let message: string | undefined;
  if (waiting?.reason === "CrashLoopBackOff") title = <>Container {name} keeps exiting</>;
  else if (waiting?.reason === "ImagePullBackOff" || waiting?.reason === "ErrImagePull" || waiting?.reason === "InvalidImageName") {
    title = <>Container {name} can't pull its image</>;
    message = waiting.message;
  } else if (waiting && BAD_WAITING.has(waiting.reason)) {
    title = <>Container {name} can't start</>;
    message = waiting.message;
  } else if (term?.reason === "OOMKilled") title = <>Container {name} ran out of memory</>;
  else if (c && term && tone === "bad") title = <>Container {name} exited</>;
  else {
    const unsched = (pod.status?.conditions ?? []).find((x: any) => x.type === "PodScheduled" && x.status === "False");
    title = <>Pod is waiting: {status.text}</>;
    message = unsched?.message ?? waiting?.message;
  }

  // "back-off 5m0s restarting failed container=…": when the next try is.
  let next: string | undefined;
  const backoff = /back-off (\d+m)?(\d+s)?/.exec(waiting?.message ?? "");
  if (backoff && c?.lastState?.terminated?.finishedAt) {
    const ms = (parseInt(backoff[1] ?? "0") * 60 + parseInt(backoff[2] ?? "0")) * 1000;
    const at = Date.parse(c.lastState.terminated.finishedAt) + ms;
    if (at > now) next = `retry in ${duration(at - now)}`;
  }
  const ran = term?.startedAt && term?.finishedAt ? Date.parse(term.finishedAt) - Date.parse(term.startedAt) : NaN;

  return (
    <section className={`diag ${tone}`} aria-label="Diagnosis">
      <div className="diag-head">
        <Ic icon={tone === "bad" ? CircleX : Clock} size={15} />
        <strong>{title}</strong>
        {next ? <span className="diag-next mono">{next}</span> : null}
      </div>
      {term ? (
        <div className="diag-facts">
          <span>Exit code <b className="mono">{term.exitCode}</b></span>
          {term.reason ? <span>Reason <b>{term.reason}</b></span> : null}
          {Number.isFinite(ran) ? <span>Ran for <b className="mono">{duration(ran)}</b></span> : null}
        </div>
      ) : null}
      {message ? <div className="diag-msg">{message}</div> : null}
      {term?.message ? <pre className="diag-log"><span className="ln">last line</span>{String(term.message).trim().split("\n").at(-1)}</pre> : null}
    </section>
  );
}

function Containers({ pod, now, onLogs, onShell, canExec }: { pod: KubeObject; now: number; onLogs: (c: string) => void; onShell: (c: string) => void; canExec: boolean | undefined }) {
  const statuses = new Map<string, any>((pod.status?.containerStatuses ?? []).map((c: any) => [c.name, c]));
  const specs: any[] = pod.spec?.containers ?? [];
  if (!specs.length) return null;
  return (
    <section>
      <h3>Containers</h3>
      <ul className="containers">
        {specs.map((c) => {
          const s = statuses.get(c.name);
          const state = s?.state?.waiting?.reason ?? s?.state?.terminated?.reason ?? (s?.state?.running ? "Running" : s?.state ? Object.keys(s.state)[0] : "Unknown");
          const tone: Tone = s?.state?.running && s?.ready ? "ok" : s?.state?.waiting && !BAD_WAITING.has(s.state.waiting.reason) ? "warn" : s?.state?.running ? "warn" : state === "Completed" ? "muted" : "bad";
          const last = s?.lastState?.terminated;
          return (
            <li key={c.name}>
              <div className="c-head">
                <strong className="c-name"><Ic icon={Box} size={13} />{c.name}</strong>
                <Status text={state} tone={tone} />
                <span className="c-acts">
                  <button className="secondary" aria-label={`Logs of ${c.name}`} onClick={() => onLogs(c.name)}><Ic icon={ScrollText} size={12} />Logs</button>
                  <button className="secondary" aria-label={`Open shell in ${c.name}`} disabled={!s?.state?.running || canExec === false}
                    title={canExec === false ? `Your role can't exec in ${pod.metadata.namespace}` : s?.state?.running ? "Open a shell (runs as you)" : "The container isn't running"}
                    onClick={() => onShell(c.name)}><Ic icon={SquareTerminal} size={12} />Shell</button>
                </span>
              </div>
              <div className="mono c-image">{c.image}</div>
              {s?.restartCount || last ? (
                <div className="c-foot">
                  <span>{s?.restartCount ?? 0} restarts</span>
                  {last ? <span>last exit <b>{last.reason ?? "?"}</b>, code <b className="mono">{last.exitCode}</b></span> : null}
                  {last?.finishedAt ? <span>{age(Date.parse(last.finishedAt), now)} ago</span> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Labels({ title, map }: { title: string; map?: Record<string, string> }) {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return null;
  return (
    <section>
      <h3>{title}</h3>
      <div className="chips">{entries.map(([k, v]) => <span key={k} className="chip mono" title={`${k}=${v}`}><i>{k}</i>{v}</span>)}</div>
    </section>
  );
}

function Events({ events, now }: { events: KubeObject[] | { error: string } | undefined; now: number }) {
  if (!events) return <p className="muted-line">Loading events…</p>;
  if (!Array.isArray(events)) return <p className="tone-bad">Could not load events: {events.error}</p>;
  if (!events.length) return <p className="muted-line">No recent events. Kubernetes keeps events for about an hour.</p>;
  const when = (e: any) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp);
  const sorted = [...events].sort((a, b) => when(b) - when(a));
  return (
    <ul className="ev-list" aria-label="Events">
      {sorted.map((e: any) => (
        <li key={e.metadata.uid} className="ev-row">
          <i className={"diamond" + (e.type === "Warning" ? "" : " normal")} aria-hidden="true" />
          <div className="ev-main">
            <strong>{e.reason}</strong>
            <span className="sr-only">{e.type}</span>
            <div className="ev-msg">{e.message}</div>
          </div>
          <span className="ev-meta">{(e.count ?? 1) > 1 ? `×${e.count} · ` : ""}{age(when(e), now)}</span>
        </li>
      ))}
    </ul>
  );
}

const isSecret = (t: ResourceType) => t.group === "" && t.resource === "secrets";

/** The UI never shows Secret values; keys only. */
export function redactSecret(o: KubeObject): KubeObject {
  const hide = (m: unknown) => (m && typeof m === "object" ? Object.fromEntries(Object.keys(m).map((k) => [k, "••••••"])) : m);
  const { data, stringData, ...rest } = o as KubeObject & { data?: unknown; stringData?: unknown };
  const ann = { ...(o.metadata.annotations ?? {}) };
  delete ann["kubectl.kubernetes.io/last-applied-configuration"]; // holds the values in clear
  return { ...rest, metadata: { ...o.metadata, annotations: ann }, ...(data ? { data: hide(data) } : {}), ...(stringData ? { stringData: hide(stringData) } : {}) } as KubeObject;
}
