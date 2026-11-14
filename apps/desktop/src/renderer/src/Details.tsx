import type { KubeObject, ResourceType } from "@landlens/contracts";
import { useEffect, useState } from "react";
import { stringify } from "yaml";
import { api, type ApiError } from "./api";
import { age, podStatus } from "@landlens/kube/status";

type Tab = "overview" | "yaml" | "events";

/** The details drawer: what this object is, its live state, its events, and its YAML. */
export function Details(props: { handle: string; type: ResourceType; object: KubeObject; now: number; onClose: () => void }) {
  const { object: o, type, now } = props;
  const [tab, setTab] = useState<Tab>("overview");
  const [events, setEvents] = useState<KubeObject[] | { error: string }>();

  useEffect(() => {
    setEvents(undefined);
    api
      .invoke("resource:events", { handle: props.handle, uid: o.metadata.uid, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}) })
      .then((r) => setEvents(r.items), (e: ApiError) => setEvents({ error: e.message }));
  }, [props.handle, o.metadata.uid, o.metadata.resourceVersion]);

  const view = isSecret(type) ? redactSecret(o) : o;

  return (
    <aside className="drawer" aria-label={`${type.kind} ${o.metadata.name}`}>
      <header className="drawer-head">
        <div>
          <div className="eyebrow">{type.kind}{o.metadata.namespace ? ` · ${o.metadata.namespace}` : ""}</div>
          <h2 className="drawer-title">{o.metadata.name}</h2>
        </div>
        <button className="icon" onClick={props.onClose} aria-label="Close details">✕</button>
      </header>
      <nav className="tabs" role="tablist">
        {(["overview", "events", "yaml"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "yaml" ? "YAML" : t[0]!.toUpperCase() + t.slice(1)}
            {t === "events" && Array.isArray(events) && events.length ? <span className="count">{events.length}</span> : null}
          </button>
        ))}
      </nav>
      <div className="drawer-body">
        {tab === "overview" && <Overview o={view} type={type} now={now} />}
        {tab === "events" && <Events events={events} now={now} />}
        {tab === "yaml" && <pre className="yaml">{stringify(view, { lineWidth: 0 })}</pre>}
      </div>
    </aside>
  );
}

function Overview({ o, type, now }: { o: KubeObject; type: ResourceType; now: number }) {
  const created = Date.parse(o.metadata.creationTimestamp ?? "");
  const conditions: any[] = o.status?.conditions ?? [];
  return (
    <div className="overview">
      <dl className="facts">
        <dt>Created</dt><dd title={o.metadata.creationTimestamp}>{age(created, now)} ago</dd>
        {o.metadata.ownerReferences?.length ? (<><dt>Owner</dt><dd>{o.metadata.ownerReferences.map((r) => `${r.kind}/${r.name}`).join(", ")}</dd></>) : null}
        {type.resource === "pods" ? (<>
          <dt>Status</dt><dd className={`tone-${podStatus(o).tone}`}>{podStatus(o).text}</dd>
          <dt>Node</dt><dd>{o.spec?.nodeName ?? "—"}</dd>
          <dt>Pod IP</dt><dd className="mono">{o.status?.podIP ?? "—"}</dd>
        </>) : null}
      </dl>
      <Labels title="Labels" map={o.metadata.labels} />
      {type.resource === "pods" && <Containers pod={o} />}
      {conditions.length ? (
        <section>
          <h3>Conditions</h3>
          <ul className="conditions">
            {conditions.map((c) => (
              <li key={c.type} className={c.status === "True" ? "tone-ok" : "tone-warn"}>
                <strong>{c.type}</strong> {c.status}
                {c.reason ? <span className="muted"> · {c.reason}</span> : null}
                {c.message ? <div className="muted small">{c.message}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Containers({ pod }: { pod: KubeObject }) {
  const statuses = new Map<string, any>((pod.status?.containerStatuses ?? []).map((c: any) => [c.name, c]));
  return (
    <section>
      <h3>Containers</h3>
      <ul className="containers">
        {(pod.spec?.containers ?? []).map((c: any) => {
          const s = statuses.get(c.name);
          const state = s?.state ? Object.keys(s.state)[0] : "unknown";
          const reason = s?.state?.waiting?.reason ?? s?.state?.terminated?.reason;
          return (
            <li key={c.name}>
              <div className="row-between">
                <strong>{c.name}</strong>
                <span className={s?.ready ? "tone-ok" : "tone-warn"}>{reason ?? state}{s?.restartCount ? ` · ${s.restartCount} restarts` : ""}</span>
              </div>
              <div className="mono small muted">{c.image}</div>
              {s?.lastState?.terminated ? (
                <div className="small tone-bad">Last exit: {s.lastState.terminated.reason ?? ""} (code {s.lastState.terminated.exitCode})</div>
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
      <div className="chips">{entries.map(([k, v]) => <span key={k} className="chip mono">{k}={v}</span>)}</div>
    </section>
  );
}

function Events({ events, now }: { events: KubeObject[] | { error: string } | undefined; now: number }) {
  if (!events) return <p className="muted">Loading events…</p>;
  if (!Array.isArray(events)) return <p className="tone-bad">Could not load events: {events.error}</p>;
  if (!events.length) return <p className="muted">No recent events. Kubernetes keeps events for about an hour.</p>;
  const sorted = [...events].sort((a: any, b: any) => Date.parse(b.lastTimestamp ?? b.eventTime) - Date.parse(a.lastTimestamp ?? a.eventTime));
  return (
    <ul className="events">
      {sorted.map((e: any) => (
        <li key={e.metadata.uid} className={e.type === "Warning" ? "warning" : ""}>
          <div className="row-between">
            <strong>{e.reason}</strong>
            <span className="muted small">{age(Date.parse(e.lastTimestamp ?? e.eventTime), now)} ago{e.count > 1 ? ` · ×${e.count}` : ""}</span>
          </div>
          <div className="small">{e.message}</div>
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
