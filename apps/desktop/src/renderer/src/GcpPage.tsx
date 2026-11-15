// Google Cloud (docs/gcp.md, wave 6 part 4): every resource of the projects you chose, read-only, with gcloud's own
// sign-in. Three columns in the main pane (projects 240, types 260, resources), the drawer for one resource (Summary
// and its own JSON), the chooser for projects, the card on the Connections page, and the page on its own from Welcome.
// The page knows names and fields only: the token stays in main.
import type { GcpProject, GcpResource, GcpStatus, GcpTypeCount, KubeObject } from "@landlens/contracts";
import type { Tone } from "@landlens/kube/status";
import {
  Archive, ArrowLeft, Boxes, Braces, Cloud, CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, Cpu, Database, ExternalLink, FolderTree, Globe, KeyRound,
  Lock, MessagesSquare, Network, Package, RefreshCw, Rocket, Search, Server, Shapes, Table2, Users, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useNow, type ApiError } from "./api";
import { CodeEditor } from "./CodeEditor";
import { Ic } from "./icons";
import type { Column } from "./kinds";
import { copyText } from "./present";
import { ResourceTable, Status } from "./ResourceTable";
import { age } from "@landlens/kube/status";

/** The services Landlens names; any other is shown by its host. */
const SERVICES: Record<string, { label: string; icon: LucideIcon }> = {
  compute: { label: "Compute Engine", icon: Cpu },
  container: { label: "Kubernetes Engine", icon: Boxes },
  sqladmin: { label: "Cloud SQL", icon: Database },
  storage: { label: "Cloud Storage", icon: Archive },
  pubsub: { label: "Pub/Sub", icon: MessagesSquare },
  iam: { label: "IAM", icon: Users },
  run: { label: "Cloud Run", icon: Rocket },
  secretmanager: { label: "Secret Manager", icon: KeyRound },
  bigquery: { label: "BigQuery", icon: Table2 },
  artifactregistry: { label: "Artifact Registry", icon: Package },
  dns: { label: "Cloud DNS", icon: Globe },
  cloudkms: { label: "Cloud KMS", icon: Lock },
  cloudresourcemanager: { label: "Resource Manager", icon: FolderTree },
  servicenetworking: { label: "Service Networking", icon: Network },
};
/** compute.googleapis.com/Instance → compute. */
export const serviceOf = (assetType: string) => (assetType.split("/")[0] ?? "").replace(/\.googleapis\.com$/, "");
const serviceLabel = (s: string) => SERVICES[s]?.label ?? s;
export const serviceIcon = (assetType: string): LucideIcon => SERVICES[serviceOf(assetType)]?.icon ?? Server;
/** compute.googleapis.com/Instance → Instance. */
export const shortType = (assetType: string) => assetType.split("/")[1] ?? assetType;
/** The resource's own name: its display name, else the last part of its full name. */
export const resourceLabel = (r: GcpResource) => r.displayName || r.name.split("/").at(-1) || r.name;

const OK = /^(RUNNING|RUNNABLE|ACTIVE|READY|IN_USE|ENABLED|SERVING)$/;
const QUIET = /^(TERMINATED|STOPPED|SUSPENDED|DISABLED|DELETED|INACTIVE)$/;
const BAD = /^(ERROR|FAILED|DEGRADED|BROKEN|UNHEALTHY)$/;
/** A resource state's tone: running is quiet ok, stopped is muted, in-between is amber, failed is red. */
export function gcpTone(state?: string): Tone | undefined {
  if (!state) return undefined;
  const s = state.toUpperCase();
  return OK.test(s) ? "ok" : QUIET.test(s) ? "muted" : BAD.test(s) ? "bad" : "warn";
}
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export type GcpNav = { project?: string; type?: string };
export type GcpPick = { project: string; resource: GcpResource };
/** The rows the page has read, for ⌘K (no new read). */
export type GcpRows = { project: string; items: GcpResource[] };

/** gcp:status, read on mount; `check` reads it again (fresh: looks for gcloud and its account now). */
export function useGcpStatus(initial?: GcpStatus): [GcpStatus | undefined, (fresh?: boolean) => Promise<void>, (s: GcpStatus) => void, string | undefined] {
  const [status, setStatus] = useState<GcpStatus | undefined>(initial);
  const [error, setError] = useState<string>();
  const check = (fresh = false) => api.invoke("gcp:status", fresh ? { fresh: true } : {}).then((s) => (setStatus(s), setError(undefined)), (e: ApiError) => setError(e.message));
  useEffect(() => void check(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return [status, check, setStatus, error];
}

/** Your projects' names (the chosen ids are all the page needs; names come from projects:search when it answers). */
function useProjectNames(on: boolean) {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.invoke("gcp:projects", {}).then((r) => live && setNames(Object.fromEntries(r.projects.map((p) => [p.id, p.name]))), () => undefined);
    return () => void (live = false);
  }, [on]);
  return names;
}

const COPY_INSTALL = "gcloud auth login";

/** The one next step for a status that isn't ready, or for no project chosen. */
export function GcpNotice(props: { status: GcpStatus; onCheck: () => void; onChoose: () => void; checking?: boolean }) {
  const s = props.status;
  const check = <button className="secondary" onClick={props.onCheck} disabled={props.checking}>{props.checking ? <span className="spinner" /> : <Ic icon={RefreshCw} size={13} />}Check again</button>;
  if (s.state === "off-dev") {
    return (
      <div className="notice gcp-notice" role="status">
        <Ic icon={CircleDashed} size={15} className="dim" />
        <div className="notice-body"><strong>Off in development builds</strong><p>An unpackaged Landlens doesn't talk to Google Cloud unless it is pointed at a local fake (<span className="mono">LANDLENS_GCP_ENDPOINT</span>) or you set <span className="mono">LANDLENS_GCP_REAL=1</span> to try your own project.</p></div>
      </div>
    );
  }
  if (s.state === "missing") {
    return (
      <div className="notice gcp-notice" role="status">
        <Ic icon={CircleAlert} size={15} className="tone-warn" />
        <div className="notice-body">
          <strong>Install the Google Cloud CLI, then run <span className="mono">gcloud auth login</span>.</strong>
          <p>Landlens uses gcloud's own sign-in and stores no Google credential. It looks for gcloud on your login shell's PATH.</p>
          <div className="gcp-notice-acts">
            <button className="secondary" onClick={() => void api.invoke("link:open", { url: "https://cloud.google.com/sdk/docs/install" })}><Ic icon={ExternalLink} size={13} />Install guide</button>
            <button className="secondary" onClick={() => void copyText(COPY_INSTALL)}><Ic icon={Copy} size={13} />Copy <span className="mono">gcloud auth login</span></button>
            {check}
          </div>
        </div>
      </div>
    );
  }
  if (s.state === "signed-out") {
    return (
      <div className="notice gcp-notice" role="status">
        <Ic icon={CircleAlert} size={15} className="tone-warn" />
        <div className="notice-body">
          <strong>gcloud isn't signed in. Run <span className="mono">gcloud auth login</span>.</strong>
          <p>Landlens never signs in for you: run it in a terminal, then check again.</p>
          <div className="gcp-notice-acts">
            <button className="secondary" onClick={() => void copyText(COPY_INSTALL)}><Ic icon={Copy} size={13} />Copy command</button>
            {check}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="notice gcp-notice" role="status">
      <Ic icon={FolderTree} size={15} className="dim" />
      <div className="notice-body">
        <strong>Choose the projects to browse</strong>
        <p>Landlens reads only the projects you choose, at most 20, as {s.account}.</p>
        <div className="gcp-notice-acts"><button className="primary" onClick={props.onChoose}>Choose projects…</button></div>
      </div>
    </div>
  );
}

/** The checklist of every project you can see; at most 20 chosen. */
export function ProjectChooser(props: { chosen: string[]; onClose: () => void; onSaved: (s: GcpStatus) => void }) {
  const [all, setAll] = useState<{ projects: GcpProject[]; cut: boolean } | { error: string }>();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(props.chosen));
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLInputElement>(null);
  const load = (fresh = false) => {
    setAll(undefined);
    api.invoke("gcp:projects", fresh ? { fresh: true } : {}).then(setAll, (e: ApiError) => setAll({ error: e.message }));
  };
  useEffect(() => (load(), box.current?.focus()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = all && !("error" in all) ? all.projects : [];
  const f = q.trim().toLowerCase();
  const shown = list.filter((p) => !f || p.id.includes(f) || p.name.toLowerCase().includes(f));
  // A chosen project you can no longer see still shows, so it can be unchosen.
  const gone = props.chosen.filter((id) => all && !("error" in all) && !list.some((p) => p.id === id));
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else if (n.size < 20) n.add(id);
    return n;
  });
  const save = () => {
    setBusy(true);
    setError(undefined);
    api.invoke("gcp:choose", { projects: [...picked] }).then((s) => (props.onSaved(s), props.onClose()), (e: ApiError) => (setError(e.message), setBusy(false)));
  };
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog gcp-chooser" role="dialog" aria-modal="true" aria-labelledby="gcp-choose-title" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), props.onClose())}>
        <header className="dialog-head">
          <span className="kind-tile sm"><Ic icon={Cloud} size={15} /></span>
          <h2 id="gcp-choose-title">Choose projects</h2>
          <span className="grow" />
          <button className="icon-btn" aria-label="Close" onClick={props.onClose}><Ic icon={X} size={15} /></button>
        </header>
        <div className="dialog-body">
          <p className="dim">Landlens reads only the projects you choose, at most 20. It keeps their ids, nothing else.</p>
          <label className="field search gcp-choose-filter">
            <Ic icon={Search} size={14} />
            <input ref={box} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${list.length || ""} projects`} aria-label="Filter projects" spellCheck={false} />
          </label>
          {!all ? (
            <div className="gcp-choose-list" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skel-row"><span className="skel" style={{ width: "55%" }} /></div>)}</div>
          ) : "error" in all ? (
            <p className="tone-bad small" role="alert">{all.error}</p>
          ) : (
            <ul className="gcp-choose-list" aria-label="Projects">
              {[...gone.map((id) => ({ id, name: id, number: "", gone: true })), ...shown.map((p) => ({ ...p, gone: false }))].map((p) => (
                <li key={p.id}>
                  <label className={"gcp-choose-row" + (picked.has(p.id) ? " on" : "")}>
                    <input type="checkbox" checked={picked.has(p.id)} disabled={!picked.has(p.id) && picked.size >= 20} onChange={() => toggle(p.id)} aria-label={p.id} />
                    <span className="gcp-choose-name">{p.name}</span>
                    <span className="mono dim">{p.gone ? "not visible to you now" : p.id}</span>
                  </label>
                </li>
              ))}
              {!shown.length && !gone.length ? <li className="small dim gcp-choose-none">{f ? `No project matches “${q.trim()}”.` : "Your account sees no active project."}</li> : null}
            </ul>
          )}
          {all && !("error" in all) && all.cut ? <p className="small dim">The first 2,000 projects are listed.</p> : null}
          {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-foot">
          <span className="small dim">{picked.size} of 20 chosen</span>
          <span className="grow" />
          <button className="secondary" onClick={props.onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy || !all || "error" in all}>{busy ? <span className="spinner" /> : null}Save</button>
        </footer>
      </div>
    </div>
  );
}

type Types = { types: GcpTypeCount[]; total: number; cut: boolean; error?: string };
type Rows = { items: GcpResource[]; total: number; cut: boolean; error?: string; loading: boolean };

/** Every page of gcp:resources for one project, type and query (from main's cache, after the types read). */
async function readAll(project: string, type: string | undefined, query: string | undefined, live: () => boolean, onPage: (r: Rows) => void) {
  let items: GcpResource[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await api.invoke("gcp:resources", { project, ...(type ? { assetType: type } : {}), ...(query ? { query } : {}), ...(offset ? { offset } : {}) });
    if (!live()) return;
    if (r.error) return onPage({ items: [], total: 0, cut: false, error: r.error, loading: false });
    items = [...items, ...r.items];
    const done = !r.items.length || items.length >= r.total;
    onPage({ items, total: r.total, cut: r.cut, loading: !done });
    if (done) return;
  }
}

/** A Google Cloud resource in the table's row shape (the uid is its full name). */
type Row = KubeObject & { gcp: GcpResource };
const rowOf = (r: GcpResource): Row => ({ metadata: { uid: r.name, name: resourceLabel(r), ...(r.createTime ? { creationTimestamp: r.createTime } : {}) }, gcp: r });
const g = (o: KubeObject) => (o as Row).gcp;
const COLUMNS: Column[] = [
  { id: "name", label: "Name", cell: (o) => ({ text: o.metadata.name, title: g(o).name }), width: "minmax(180px, 2fr)" },
  { id: "type", label: "Type", cell: (o) => ({ text: `${serviceOf(g(o).assetType)} · ${shortType(g(o).assetType)}`, title: g(o).assetType }), width: "minmax(140px, 1.2fr)" },
  { id: "location", label: "Location", cell: (o) => ({ text: g(o).location ?? "" }), width: "minmax(96px, 130px)" },
  {
    id: "status", label: "State",
    cell: (o) => {
      const s = g(o).state;
      const tone = gcpTone(s);
      return s && tone ? { text: titleCase(s), tone, sort: s } : { text: "", sort: "" };
    },
    width: "128px",
  },
  {
    id: "age", label: "Created",
    cell: (o, now) => {
      const t = Date.parse(o.metadata.creationTimestamp ?? "");
      return Number.isFinite(t) ? { text: age(t, now), sort: -t, title: o.metadata.creationTimestamp ?? "" } : { text: "", sort: 0 };
    },
    width: "64px",
  },
];

export function GcpPage(props: {
  nav: GcpNav;
  onNav: (n: GcpNav) => void;
  selected?: string;
  onSelect: (p: GcpPick | undefined) => void;
  onRows?: (r: GcpRows) => void;
  width: number;
  status?: GcpStatus;
  onStatus?: (s: GcpStatus) => void;
}) {
  const now = useNow();
  const [status, check, setStatus, statusError] = useGcpStatus(props.status);
  const [checking, setChecking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const ready = status?.state === "ready";
  const names = useProjectNames(ready);
  const chosen = status?.projects ?? [];
  const project = props.nav.project && chosen.includes(props.nav.project) ? props.nav.project : chosen[0];
  const type = props.nav.type;
  const [projectFilter, setProjectFilter] = useState("");
  const [types, setTypes] = useState<Types>();
  const [typesVersion, setTypesVersion] = useState(0);
  const [rows, setRows] = useState<Rows>();
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState<string>();
  // Wide: projects, types and resources. Narrow (the table would get under ~600px): projects become a select atop the
  // types. Compact (a drawer beside a small window): types become a select too, and the table has the pane.
  const layout = props.width >= 1100 ? "wide" : props.width >= 720 ? "narrow" : "compact";
  const narrow = layout !== "wide";
  const updateStatus = (s: GcpStatus) => (setStatus(s), props.onStatus?.(s));

  // A project's types: the one read of its resources, in main (60 s), counted there.
  useEffect(() => {
    if (!ready || !project) return;
    let live = true;
    setTypes(undefined);
    api.invoke("gcp:types", { project, ...(typesVersion ? { fresh: true } : {}) }).then((t) => live && setTypes(t), (e: ApiError) => live && setTypes({ types: [], total: 0, cut: false, error: e.message }));
    return () => void (live = false);
  }, [ready, project, typesVersion]);

  // The rows of the chosen type (or all), from the same read, or a Cloud Asset query's own read.
  useEffect(() => {
    if (!ready || !project || !types || types.error) return setRows(undefined);
    let live = true;
    setRows({ items: [], total: 0, cut: false, loading: true });
    readAll(project, type, query, () => live, (r) => setRows(r)).catch((e: ApiError) => live && setRows({ items: [], total: 0, cut: false, error: e.message, loading: false }));
    return () => void (live = false);
  }, [ready, project, type, query, types]);

  useEffect(() => {
    if (project && rows && !rows.loading && !query && !type) props.onRows?.({ project, items: rows.items });
  }, [rows, project, query, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const goProject = (p: string) => {
    setQuery(undefined);
    setFilter("");
    props.onSelect(undefined);
    props.onNav({ project: p });
  };
  const goType = (t: string | undefined) => {
    props.onSelect(undefined);
    props.onNav({ ...(project ? { project } : {}), ...(t ? { type: t } : {}) });
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const items = rows?.items ?? [];
    const match = f ? items.filter((r) => `${r.name} ${r.displayName ?? ""} ${r.assetType} ${r.location ?? ""} ${r.state ?? ""} ${Object.entries(r.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}`.toLowerCase().includes(f)) : items;
    return match.map(rowOf);
  }, [rows, filter]);

  const groups = useMemo(() => {
    const by = new Map<string, GcpTypeCount[]>();
    for (const t of types?.types ?? []) by.set(serviceOf(t.assetType), [...(by.get(serviceOf(t.assetType)) ?? []), t]);
    return [...by].sort(([a], [b]) => serviceLabel(a).localeCompare(serviceLabel(b)));
  }, [types]);

  if (!status) {
    return statusError ? <div className="notice" role="alert"><Ic icon={CircleX} size={15} className="tone-bad" /><div className="notice-body"><strong>Couldn't check Google Cloud.</strong><p>{statusError}</p></div></div>
      : <div className="ov"><div className="skel" style={{ height: 120 }} /></div>;
  }
  const chooser = choosing ? <ProjectChooser chosen={chosen} onClose={() => setChoosing(false)} onSaved={updateStatus} /> : null;
  if (!ready || !chosen.length) {
    return (
      <div className="ov gcp-empty">
        <GcpNotice status={status} checking={checking} onChoose={() => setChoosing(true)} onCheck={() => (setChecking(true), void check(true).finally(() => setChecking(false)))} />
        {chooser}
      </div>
    );
  }

  const pf = projectFilter.trim().toLowerCase();
  const projectList = chosen.filter((id) => !pf || id.includes(pf) || (names[id] ?? "").toLowerCase().includes(pf));
  const cutNote = rows?.cut ? "Showing the first 5,000." : undefined;

  return (
    <div className={`gcp ${layout}`}>
      {!narrow ? (
        <section className="gcp-col gcp-projects" aria-label="Projects">
          <header className="gcp-col-head"><span>Projects</span><span className="count">{chosen.length}</span><span className="grow" />
            <button className="link-btn small" onClick={() => setChoosing(true)}>Choose projects…</button>
          </header>
          {chosen.length > 6 ? (
            <label className="field search gcp-col-filter"><Ic icon={Search} size={13} /><input type="search" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} placeholder="Filter" aria-label="Filter projects" /></label>
          ) : null}
          <ul className="gcp-list">
            {projectList.map((id) => (
              <li key={id}>
                <button className={"gcp-item gcp-project" + (id === project ? " on" : "")} aria-current={id === project ? "true" : undefined} onClick={() => goProject(id)} title={id}>
                  <Ic icon={FolderTree} size={14} />
                  <span className="gcp-item-text"><span className="gcp-item-name">{names[id] ?? id}</span><span className="mono gcp-item-sub">{id}</span></span>
                </button>
              </li>
            ))}
          </ul>
          <footer className="gcp-col-foot small dim"><Ic icon={CircleCheck} size={12} className="tone-ok" /><span className="ellipsis" title={status.account}>{status.account}</span></footer>
        </section>
      ) : null}
      {layout !== "compact" ? <section className="gcp-col gcp-types" aria-label="Types">
        <header className="gcp-col-head">
          {narrow ? (
            <label className="field select gcp-project-select">
              <select value={project} onChange={(e) => goProject(e.target.value)} aria-label="Project">{chosen.map((id) => <option key={id} value={id}>{names[id] ?? id}</option>)}</select>
            </label>
          ) : <><span>Types</span><span className="grow" /></>}
          {narrow ? <button className="icon-btn sm" aria-label="Choose projects…" title="Choose projects…" onClick={() => setChoosing(true)}><Ic icon={FolderTree} size={13} /></button> : null}
          <button className="icon-btn sm" aria-label="Read again" title="Read again" onClick={() => setTypesVersion((n) => n + 1)} disabled={!types}><Ic icon={RefreshCw} size={13} /></button>
        </header>
        {!types ? (
          <div className="gcp-list" aria-busy="true" aria-label="Reading types">{[70, 55, 62, 48, 66, 52].map((w, i) => <div key={i} className="skel-row"><span className="skel" style={{ width: `${w}%` }} /></div>)}</div>
        ) : types.error ? (
          <div className="gcp-col-error" role="alert"><Ic icon={CircleX} size={14} className="tone-bad" /><p>{types.error}</p></div>
        ) : (
          <ul className="gcp-list" aria-label={`Types in ${project}`}>
            <li><button className={"gcp-item gcp-type" + (!type ? " on" : "")} aria-current={!type ? "true" : undefined} onClick={() => goType(undefined)}>
              <Ic icon={Shapes} size={14} /><span className="gcp-item-name">All</span><span className="gcp-n">{types.total.toLocaleString()}</span>
            </button></li>
            {groups.map(([svc, ts]) => (
              <li key={svc} role="group" aria-label={serviceLabel(svc)}>
                <div className="gcp-group"><Ic icon={SERVICES[svc]?.icon ?? Server} size={12} /><span>{serviceLabel(svc)}</span><span className="mono">{svc}</span></div>
                <ul>
                  {ts.map((t) => (
                    <li key={t.assetType}><button className={"gcp-item gcp-type" + (type === t.assetType ? " on" : "")} aria-current={type === t.assetType ? "true" : undefined} title={t.assetType} onClick={() => goType(t.assetType)}>
                      <span className="gcp-item-name">{shortType(t.assetType)}</span><span className="gcp-n">{t.count.toLocaleString()}</span>
                    </button></li>
                  ))}
                </ul>
              </li>
            ))}
            {types.cut ? <li className="small dim gcp-cut">Counted from the first 5,000.</li> : null}
          </ul>
        )}
      </section> : null}
      <section className="gcp-res" aria-label="Resources">
        {layout === "compact" ? (
          <header className="gcp-res-head gcp-compact-head">
            <label className="field select gcp-project-select">
              <select value={project} onChange={(e) => goProject(e.target.value)} aria-label="Project">{chosen.map((id) => <option key={id} value={id}>{names[id] ?? id}</option>)}</select>
            </label>
            <label className="field select gcp-type-select">
              <select value={type ?? ""} onChange={(e) => goType(e.target.value || undefined)} aria-label="Type" disabled={!types || !!types.error}>
                <option value="">All types{types && !types.error ? ` (${types.total.toLocaleString()})` : ""}</option>
                {groups.map(([svc, ts]) => (
                  <optgroup key={svc} label={serviceLabel(svc)}>{ts.map((t) => <option key={t.assetType} value={t.assetType}>{shortType(t.assetType)} ({t.count.toLocaleString()})</option>)}</optgroup>
                ))}
              </select>
            </label>
            <button className="icon-btn sm" aria-label="Choose projects…" title="Choose projects…" onClick={() => setChoosing(true)}><Ic icon={FolderTree} size={13} /></button>
            <button className="icon-btn sm" aria-label="Read again" title="Read again" onClick={() => setTypesVersion((n) => n + 1)} disabled={!types}><Ic icon={RefreshCw} size={13} /></button>
          </header>
        ) : null}
        <header className="gcp-res-head">
          <label className="field search gcp-filter">
            <Ic icon={Search} size={14} />
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filter.trim()) (e.preventDefault(), setQuery(filter.trim().slice(0, 500)), setFilter(""));
                if (e.key === "Escape" && filter) (e.stopPropagation(), setFilter(""));
              }}
              placeholder="Filter, or ↵ to search Cloud Asset" aria-label="Filter resources" />
          </label>
          {query ? (
            <span className="chip gcp-query" title="Sent to Cloud Asset as a query">
              <Ic icon={Search} size={11} /><span className="mono">{query}</span>
              <button className="icon-btn sm" aria-label="Clear the query" onClick={() => setQuery(undefined)}><Ic icon={X} size={11} /></button>
            </span>
          ) : null}
          <span className="grow" />
          {rows?.loading && rows.items.length ? <span className="small dim"><span className="spinner" aria-hidden="true" /> Reading {rows.items.length.toLocaleString()} of {rows.total.toLocaleString()}…</span> : null}
          {rows && !rows.loading && !rows.error ? (
            <span className="small dim gcp-count" aria-live="polite">{filter.trim() ? `${shown.length.toLocaleString()} of ${rows.items.length.toLocaleString()}` : `${rows.items.length.toLocaleString()} resource${rows.items.length === 1 ? "" : "s"}`}</span>
          ) : null}
          {cutNote ? <span className="badge warn gcp-cut-badge"><Ic icon={CircleAlert} size={12} />{cutNote}</span> : null}
        </header>
        {rows?.error ? (
          <div className="notice" role="alert"><Ic icon={CircleX} size={15} className="tone-bad" /><div className="notice-body"><strong>Couldn't search {project}.</strong><p>{rows.error}</p></div></div>
        ) : types?.error && layout === "compact" ? (
          <div className="notice" role="alert"><Ic icon={CircleX} size={15} className="tone-bad" /><div className="notice-body"><strong>Couldn't read {project}.</strong><p>{types.error}</p></div></div>
        ) : types?.error ? (
          <div className="empty"><span className="kind-tile lg"><Ic icon={CircleAlert} size={20} /></span><strong>{project}'s resources can't be read</strong><span className="small">The reason is in the Types column.</span></div>
        ) : (
          <ResourceTable
            resource="gcp"
            columns={type ? COLUMNS.filter((c) => c.id !== "type") : COLUMNS}
            items={shown}
            now={now}
            loading={!rows || (rows.loading && !rows.items.length)}
            {...(props.selected ? { selected: props.selected } : {})}
            width={props.width - (layout === "wide" ? 500 : layout === "narrow" ? 260 : 0)}
            oneNamespace={false}
            empty={{
              title: filter.trim() ? `No resources matching “${filter.trim()}”` : query ? `Cloud Asset found nothing for “${query}”` : `No ${type ? shortType(type) : "resources"} in ${project}`,
              ...(filter.trim() ? { onClear: () => setFilter("") } : query ? { onClear: () => setQuery(undefined) } : {}),
            }}
            onSelect={(o) => project && props.onSelect({ project, resource: g(o) })}
          />
        )}
      </section>
      {chooser}
    </div>
  );
}

/** One resource: Summary (the search fields, labels, parent) and JSON (its own, read when the drawer opens). */
export function GcpDrawer(props: { pick: GcpPick; onClose: () => void }) {
  const { project, resource: r } = props.pick;
  const now = useNow();
  const [tab, setTab] = useState<"summary" | "json">("summary");
  const [d, setD] = useState<{ resource: GcpResource; json?: string; cut: boolean } | { error: string }>();
  useEffect(() => {
    let live = true;
    setD(undefined);
    api.invoke("gcp:resource", { project, name: r.name }).then((x) => live && setD(x), (e: ApiError) => live && setD({ error: e.message }));
    return () => void (live = false);
  }, [project, r.name]);
  const cur = d && !("error" in d) ? d.resource : r;
  const tone = gcpTone(cur.state);
  const svc = serviceOf(cur.assetType);
  const created = Date.parse(cur.createTime ?? "");
  const updated = Date.parse(cur.updateTime ?? "");
  const when = (t: number, raw?: string) => (Number.isFinite(t) ? <>{age(t, now)} ago <span className="dim mono">· {raw!.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, " UTC")}</span></> : "—");

  return (
    <aside className="drawer gcp-drawer" aria-label={`Google Cloud resource ${resourceLabel(cur)}`}>
      <header className="drawer-head">
        <div className="drawer-top">
          <span className={`kind-tile sm${tone === "bad" || tone === "warn" ? ` ${tone}` : ""}`}><Ic icon={serviceIcon(cur.assetType)} size={15} /></span>
          <div className="eyebrow">Google Cloud<span className="sep"> / </span>{project}</div>
          <span className="grow" />
          <button className="secondary sm" onClick={() => void copyText(cur.name)} title={cur.name}><Ic icon={Copy} size={13} />Copy name</button>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close details" title="Close (Esc)"><Ic icon={X} size={15} /></button>
        </div>
        <h2 className="drawer-title">{resourceLabel(cur)}</h2>
        <div className="drawer-meta">
          <span className="chip mono" title={cur.assetType}>{svc} · {shortType(cur.assetType)}</span>
          {cur.location ? <span className="meta">in <b className="mono">{cur.location}</b></span> : null}
          {cur.state && tone ? <Status text={titleCase(cur.state)} tone={tone} /> : null}
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Details">
        {(["summary", "json"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "summary" ? "Summary" : <><Ic icon={Braces} size={13} />JSON</>}
          </button>
        ))}
      </nav>
      <div className={"drawer-body" + (tab === "json" ? " gcp-json-body" : "")}>
        {tab === "summary" ? (
          <div className="overview">
            <dl className="facts">
              <dt>Name</dt><dd className="mono gcp-full-name">{cur.name}</dd>
              <dt>Type</dt><dd className="mono">{cur.assetType}</dd>
              <dt>Service</dt><dd>{serviceLabel(svc)}</dd>
              <dt>Location</dt><dd className="mono">{cur.location ?? "—"}</dd>
              <dt>State</dt><dd>{cur.state ? titleCase(cur.state) : "—"}</dd>
              <dt>Created</dt><dd>{when(created, cur.createTime)}</dd>
              <dt>Updated</dt><dd>{when(updated, cur.updateTime)}</dd>
              <dt>Parent</dt><dd className="mono gcp-full-name">{cur.parent ?? "—"}</dd>
            </dl>
            <section>
              <h3>Labels {cur.labels ? <span className="count">{Object.keys(cur.labels).length}</span> : null}</h3>
              {cur.labels ? <div className="chips">{Object.entries(cur.labels).map(([k, v]) => <span key={k} className="chip mono"><i>{k}</i>{v}</span>)}</div> : <p className="small dim">No labels.</p>}
            </section>
            <p className="small dim gcp-readonly"><Ic icon={Lock} size={12} />Read-only: Landlens reads Google Cloud as you, through Cloud Asset, and changes nothing.</p>
          </div>
        ) : !d ? (
          <p className="small dim"><span className="spinner" aria-hidden="true" /> Reading its JSON from Cloud Asset…</p>
        ) : "error" in d ? (
          <div className="notice" role="alert"><Ic icon={CircleX} size={15} className="tone-bad" /><div className="notice-body"><strong>Couldn't read this resource.</strong><p>{d.error}</p></div></div>
        ) : d.json === undefined ? (
          <p className="small dim">Cloud Asset gives no JSON for this type; Summary has what its search returns.</p>
        ) : (
          <>
            {d.cut ? <p className="small tone-warn gcp-json-cut"><Ic icon={CircleAlert} size={12} />Cut at 256 KB.</p> : null}
            <div className="yaml-edit gcp-json"><div className="cm"><CodeEditor value={d.json} onChange={() => undefined} marks={NO_MARKS} label="Resource JSON" readOnly /></div></div>
          </>
        )}
      </div>
    </aside>
  );
}

const NO_MARKS: never[] = [];

const CARD_STATE: Record<GcpStatus["state"], { tone: "ok" | "muted" | "warn"; word: string; icon: typeof CircleCheck }> = {
  ready: { tone: "ok", word: "Signed in", icon: CircleCheck },
  "signed-out": { tone: "warn", word: "Signed out", icon: CircleAlert },
  missing: { tone: "muted", word: "gcloud not found", icon: CircleDashed },
  "off-dev": { tone: "muted", word: "Off in development", icon: CircleDashed },
};

/** The Google Cloud card on the Connections page (D95). */
export function GcpCard(props: { status: GcpStatus; onStatus: (s: GcpStatus) => void; onOpen?: () => void }) {
  const s = props.status;
  const st = CARD_STATE[s.state];
  const [choosing, setChoosing] = useState(false);
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    api.invoke("gcp:status", { fresh: true }).then(props.onStatus, () => undefined).finally(() => setChecking(false));
  };
  return (
    <section className="panel conn-card gcp-card" aria-label="Google Cloud connection">
      <header className="panel-head">
        <span className="kind-tile sm conn-tile"><Ic icon={Cloud} size={15} /></span>
        <h3>Google Cloud</h3>
        <span className={`badge ${st.tone}`}><Ic icon={st.icon} size={13} />{st.word}</span>
        <span className="grow" />
        {props.onOpen && s.state === "ready" ? <button className="primary" onClick={props.onOpen}>Open Google Cloud</button> : null}
      </header>
      <div className="conn-body">
        {s.state === "ready" ? (
          <>
            <div className="conn-who"><span>Signed in as <b>{s.account}</b><span className="dim"> · gcloud's sign-in; Landlens stores no Google credential</span></span></div>
            <div className="conn-row">
              <span className="conn-label">Projects</span>
              <div className="gcp-card-projects">
                {s.projects.length ? <span className="chips" aria-label="Chosen projects">{s.projects.map((p) => <span key={p} className="chip mono">{p}</span>)}</span> : <span className="small dim">None chosen yet.</span>}
                <button className="secondary sm" onClick={() => setChoosing(true)}>Choose projects…</button>
              </div>
              <span className="dim small">Read-only: every resource of these projects, through Cloud Asset, as you. At most 20.</span>
            </div>
          </>
        ) : (
          <GcpNotice status={s} checking={checking} onCheck={check} onChoose={() => setChoosing(true)} />
        )}
      </div>
      {choosing ? <ProjectChooser chosen={s.projects} onClose={() => setChoosing(false)} onSaved={props.onStatus} /> : null}
    </section>
  );
}

/** Google Cloud from Welcome, with no cluster connected: the page, its drawer, and the way back. */
export function GcpStandalone(props: { onBack: () => void }) {
  const [nav, setNav] = useState<GcpNav>({});
  const [pick, setPick] = useState<GcpPick>();
  const [width, setWidth] = useState(window.innerWidth);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const ro = new ResizeObserver(() => setWidth(box.current?.clientWidth ?? window.innerWidth));
    if (box.current) ro.observe(box.current);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement | null)?.closest("input, .dialog, .cm-editor") && setPick(undefined);
    window.addEventListener("keydown", esc);
    return () => (ro.disconnect(), window.removeEventListener("keydown", esc));
  }, []);
  return (
    <div className="app no-cluster">
      <div className="gcp-standalone">
        <main className="main standalone" ref={box}>
          <header className="standalone-bar">
            <button className="secondary" onClick={props.onBack}><Ic icon={ArrowLeft} size={14} />Clusters</button>
            <h1>Google Cloud</h1>
          </header>
          <GcpPage nav={nav} onNav={setNav} {...(pick ? { selected: pick.resource.name } : {})} onSelect={setPick} width={width} />
        </main>
        {pick ? <GcpDrawer key={pick.resource.name} pick={pick} onClose={() => setPick(undefined)} /> : null}
      </div>
    </div>
  );
}
