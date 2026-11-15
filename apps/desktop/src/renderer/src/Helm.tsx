// Helm releases, read-only (wave 4, part 4; D42–D43): the list (last in Workloads) and a release's drawer. Main reads
// and decodes the releases as you; values that look secret and every Secret value in the manifest arrive hidden.
// No upgrade, rollback or uninstall: only Ask Claude.
import type { HelmRelease, HelmReleaseDetail, KubeObject } from "@landlens/contracts";
import { age, type Tone } from "@landlens/kube/status";
import { diffLines } from "@landlens/kube/diff";
import { ChevronRight, CircleX, EyeOff, Lock, Package, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AskContext } from "./AgentDock";
import { api, type ApiError } from "./api";
import { Line } from "./ChangeCard";
import type { NavTarget } from "./Details";
import { Ic, iconOfKind } from "./icons";
import type { Column } from "./kinds";
import { ResourceTable, Status } from "./ResourceTable";
import { Yaml } from "./Yaml";

/** How often the list is read again while it is open (D42). */
const EVERY_MS = 30_000;

export function statusTone(status: string): Tone {
  if (status === "deployed") return "ok";
  if (status === "failed") return "bad";
  if (status.startsWith("pending") || status === "uninstalling") return "warn";
  return "muted";
}

/** The releases in a namespace (or all), read on open, every 30 seconds and on refresh. */
export function useHelmList(handle: string, namespace: string, on: boolean) {
  const [state, setState] = useState<{ releases?: HelmRelease[]; unreadable?: number; error?: ApiError; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let busy = false;
    // One read at a time: a tick while the last read runs is skipped (security review, part 4, finding 10).
    const read = () => {
      if (busy) return;
      busy = true;
      void api.invoke("helm:list", { handle, ...(namespace ? { namespace } : {}) }).then(
        (r) => live && setState({ releases: r.releases, unreadable: r.unreadable, loading: false }),
        (e: ApiError) => live && setState({ error: e, loading: false }),
      ).finally(() => (busy = false));
    };
    setState((s) => ({ ...s, loading: !s.releases }));
    void read();
    const t = setInterval(read, EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [handle, namespace, on, n]);
  return { ...state, refresh: () => setN((x) => x + 1) };
}

/** A release as a table row: the table reads metadata, the rest rides along. */
type Row = KubeObject & { release: HelmRelease };
const rowOf = (r: HelmRelease): Row => ({
  apiVersion: "landlens/helm", kind: "HelmRelease",
  metadata: { name: r.name, namespace: r.namespace, uid: `${r.namespace}/${r.name}`, ...(r.updated ? { creationTimestamp: r.updated } : {}) },
  release: r,
}) as Row;
const rel = (o: KubeObject) => (o as Row).release;

export const HELM_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: "minmax(160px, 2fr)", cell: (o) => ({ text: o.metadata.name }) },
  { id: "namespace", label: "Namespace", width: "minmax(110px, 1fr)", cell: (o) => ({ text: o.metadata.namespace ?? "" }) },
  { id: "chart", label: "Chart", width: "minmax(140px, 1.5fr)", cell: (o) => ({ text: rel(o).chart ? `${rel(o).chart}-${rel(o).chartVersion}` : "—" }) },
  { id: "app", label: "App version", width: "minmax(90px, 120px)", cell: (o) => ({ text: rel(o).appVersion || "—" }) },
  { id: "revision", label: "Revision", width: "80px", num: true, cell: (o) => ({ text: String(rel(o).revision), sort: rel(o).revision }) },
  { id: "status", label: "Status", width: "minmax(110px, 150px)", cell: (o) => ({ text: rel(o).status, tone: statusTone(rel(o).status) }) },
  { id: "updated", label: "Updated", width: "80px", kind: "age", cell: (o, now) => {
    const t = Date.parse(rel(o).updated ?? "");
    return Number.isFinite(t) ? { text: age(t, now), sort: -t, title: rel(o).updated! } : { text: "" };
  } },
];

export function HelmPage(props: {
  list: ReturnType<typeof useHelmList>;
  filter: string;
  namespace: string;
  now: number;
  width: number;
  selected?: string;
  onSelect: (r: HelmRelease | undefined) => void;
}) {
  const { list } = props;
  const rows = useMemo(() => {
    const f = props.filter.trim().toLowerCase();
    return (list.releases ?? []).filter((r) => !f || r.name.includes(f) || r.namespace.includes(f) || r.chart.toLowerCase().includes(f)).map(rowOf);
  }, [list.releases, props.filter]);
  if (list.error) {
    const denied = list.error.status === 403;
    return (
      <div className="notice" role="alert">
        <Ic icon={denied ? Lock : CircleX} size={15} className={denied ? "dim" : "tone-bad"} />
        <div className="notice-body">
          <strong>{denied ? "You don't have access to Helm's releases." : "Couldn't read Helm's releases."}</strong>
          <p>{list.error.message}</p>
        </div>
      </div>
    );
  }
  return (
    <>
      {list.unreadable ? <p className="small dim helm-unreadable">{list.unreadable} release{list.unreadable === 1 ? "" : "s"} couldn't be decoded; {list.unreadable === 1 ? "it shows" : "they show"} without a chart.</p> : null}
      <ResourceTable
        resource="helm"
        columns={HELM_COLUMNS}
        items={rows}
        now={props.now}
        loading={list.loading}
        {...(props.selected ? { selected: props.selected } : {})}
        width={props.width}
        oneNamespace={!!props.namespace}
        empty={{ title: `No Helm releases${props.namespace ? ` in ${props.namespace}` : ""}${props.filter.trim() ? ` matching “${props.filter.trim()}”` : ""}` }}
        onSelect={(o) => props.onSelect(o ? rel(o) : undefined)}
        onMenu={() => undefined}
        onAction={() => undefined}
      />
    </>
  );
}

type Tab = "overview" | "values" | "manifest" | "history";

/** A release's drawer (D43): Overview, Values (yours or all), Manifest, History with a values diff. Read-only. */
export function HelmDrawer(props: {
  handle: string;
  release: HelmRelease;
  now: number;
  onClose: () => void;
  onAsk: (c: AskContext) => void;
  onNavigate: (t: NavTarget) => void;
}) {
  const { release: r, now } = props;
  const [tab, setTab] = useState<Tab>("overview");
  const [d, setD] = useState<HelmReleaseDetail | { error: string }>();
  const [which, setWhich] = useState<"user" | "all">("user");
  const [diff, setDiff] = useState<{ revision: number; text?: string; error?: string }>();
  useEffect(() => {
    let live = true;
    setD(undefined);
    setDiff(undefined);
    api.invoke("helm:get", { handle: props.handle, namespace: r.namespace, name: r.name }).then((x) => live && setD(x), (e: ApiError) => live && setD({ error: e.message }));
    return () => {
      live = false;
    };
    // A new revision (the list re-reads every 30 s) reads the release again.
  }, [props.handle, r.namespace, r.name, r.revision]);
  const detail = d && !("error" in d) ? d : undefined;
  const tone = statusTone(r.status);
  const updated = Date.parse(r.updated ?? "");

  const showDiff = (revision: number) => {
    if (!detail) return;
    setDiff({ revision });
    api.invoke("helm:get", { handle: props.handle, namespace: r.namespace, name: r.name, revision }).then(
      (old) => setDiff({ revision, text: old.values.user }),
      (e: ApiError) => setDiff({ revision, error: e.message }),
    );
  };

  const ask = () => props.onAsk({
    label: `Helm release ${r.namespace}/${r.name}`,
    source: `helm /`, kind: "helm",
    text: [
      `Helm release ${r.name} in ${r.namespace}: chart ${r.chart}-${r.chartVersion}, app version ${r.appVersion || "unknown"}, revision ${r.revision}, status ${r.status}.`,
      detail?.description ? `Last action: ${detail.description}` : "",
      detail?.values.user ? `Values set by the user (secrets hidden):\n${detail.values.user}` : "",
      detail?.objects.length ? `Objects: ${detail.objects.slice(0, 40).map((o) => `${o.kind}/${o.name}`).join(", ")}` : "",
    ].filter(Boolean).join("\n"),
  });

  return (
    <aside className="drawer" aria-label={`Helm release ${r.name}`}>
      <header className="drawer-head">
        <div className="drawer-top">
          <span className={`kind-tile sm${tone === "bad" || tone === "warn" ? ` ${tone}` : ""}`}><Ic icon={Package} size={15} /></span>
          <div className="eyebrow">Helm release<span className="sep"> / </span>{r.namespace}</div>
          <span className="grow" />
          <button className="ask-btn" onClick={ask}><Ic icon={Sparkles} size={14} />Ask Claude</button>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close details" title="Close (Esc)"><Ic icon={X} size={15} /></button>
        </div>
        <h2 className="drawer-title">{r.name}</h2>
        <div className="drawer-meta">
          <Status text={r.status} tone={tone} />
          <span className="meta">revision <b className="mono">{r.revision}</b></span>
          {Number.isFinite(updated) ? <span className="meta">updated <b className="mono">{age(updated, now)}</b> ago</span> : null}
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Details">
        {(["overview", "values", "manifest", "history"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      <div className="drawer-body">
        {!d ? <p className="small dim">Reading the release…</p> : "error" in d ? (
          <div className="notice" role="alert"><Ic icon={CircleX} size={15} className="tone-bad" /><div className="notice-body"><strong>Couldn't read this release.</strong><p>{d.error}</p></div></div>
        ) : tab === "overview" ? (
          <div className="overview">
            <dl className="facts">
              <dt>Chart</dt><dd className="mono">{r.chart ? `${r.chart}-${r.chartVersion}` : "—"}</dd>
              <dt>App version</dt><dd className="mono">{r.appVersion || "—"}</dd>
              <dt>Revision</dt><dd className="mono">{r.revision}{d.latest !== r.revision ? ` (latest ${d.latest})` : ""}</dd>
              <dt>Last action</dt><dd>{d.description || "—"}</dd>
              {Number.isFinite(updated) ? <><dt>Updated</dt><dd>{age(updated, now)} ago <span className="dim mono">· {r.updated!.replace("T", " ").replace(/\.\d+/, "")}</span></dd></> : null}
              {d.firstDeployed ? <><dt>Installed</dt><dd className="mono dim">{d.firstDeployed.replace("T", " ").replace(/\.\d+/, "")}</dd></> : null}
            </dl>
            {d.chartDescription ? <p className="small dim">{d.chartDescription}</p> : null}
            {d.objects.length ? (
              <section>
                <h3>Objects <span className="count">{d.objects.length}</span></h3>
                <div className="helm-objects">
                  {d.objects.map((o) => (
                    <button key={`${o.kind}/${o.namespace ?? ""}/${o.name}`} className="ref" onClick={() => props.onNavigate({ kind: o.kind, name: o.name, ...(o.namespace ? { namespace: o.namespace } : {}) })}>
                      <Ic icon={iconOfKind(o.kind)} size={12} />{o.kind}/{o.name}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {d.notes ? (
              <details className="fold">
                <summary><Ic icon={ChevronRight} size={12} />Notes</summary>
                <pre className="helm-notes">{d.notes}</pre>
              </details>
            ) : null}
          </div>
        ) : tab === "values" ? (
          <div className="helm-values">
            <div className="seg" role="group" aria-label="Values">
              <button className={which === "user" ? "on" : ""} aria-pressed={which === "user"} onClick={() => setWhich("user")}>Yours</button>
              <button className={which === "all" ? "on" : ""} aria-pressed={which === "all"} onClick={() => setWhich("all")}>All</button>
            </div>
            {d.hidden[which] ? <p className="small dim helm-hidden"><Ic icon={EyeOff} size={12} />{d.hidden[which]} value{d.hidden[which] === 1 ? "" : "s"} that look secret {d.hidden[which] === 1 ? "is" : "are"} hidden.</p> : null}
            {(which === "user" ? d.values.user : d.values.all) ? <Yaml text={which === "user" ? d.values.user : d.values.all} /> : <p className="small dim">{which === "user" ? "You set no values: the chart's defaults apply." : "No values."}</p>}
          </div>
        ) : tab === "manifest" ? (
          <div>
            {d.manifestHidden ? <p className="small dim helm-hidden"><Ic icon={EyeOff} size={12} />{d.manifestHidden} Secret value{d.manifestHidden === 1 ? "" : "s"} hidden; the keys show.</p> : null}
            {d.manifestCut ? <p className="small tone-warn">The manifest is over 2 MB; the first 2 MB show.</p> : null}
            {d.manifest ? <Yaml text={d.manifest} /> : <p className="small dim">No manifest.</p>}
          </div>
        ) : (
          <div>
            <ul className="helm-history" aria-label="History">
              {d.history.map((h) => {
                const t = Date.parse(h.updated ?? "");
                return (
                  <li key={h.revision} className={h.revision === r.revision ? "current" : ""}>
                    <span className="mono rev">{h.revision}</span>
                    <Status text={h.status} tone={statusTone(h.status)} />
                    <span className="mono chart">{h.chart ? `${h.chart}-${h.chartVersion}` : "—"}</span>
                    <span className="dim when">{Number.isFinite(t) ? `${age(t, now)} ago` : ""}</span>
                    <span className="desc">{h.description}</span>
                    {h.revision !== d.release.revision ? (
                      <button className="link-btn" onClick={() => showDiff(h.revision)}>Diff values with current</button>
                    ) : <span className="dim small">current</span>}
                  </li>
                );
              })}
            </ul>
            {diff ? (
              <section className="helm-diff">
                <h3>Your values: revision {diff.revision} → {d.release.revision}</h3>
                {diff.error ? <p className="small tone-bad">{diff.error}</p> : diff.text === undefined ? <p className="small dim">Reading revision {diff.revision}…</p> : (
                  <DiffView before={diff.text} after={d.values.user} label={`Values, revision ${diff.revision} to ${d.release.revision}`} />
                )}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const d = useMemo(() => diffLines(before, after), [before, after]);
  if (!d.added && !d.removed) return <p className="small dim">The same values.</p>;
  return (
    <div className="diff-wrap">
      <pre className="diff" tabIndex={0} role="region" aria-label={label}>
        <code className="diff-in">{d.lines.map((l, i) => <Line key={i} line={l} />)}</code>
      </pre>
    </div>
  );
}
