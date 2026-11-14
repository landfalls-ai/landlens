import type { ClusterInfo, KubeContext, KubeObject } from "@landlens/contracts";
import { useEffect, useMemo, useState } from "react";
import { api, useNow, useWatch, type ApiError } from "./api";
import { Details } from "./Details";
import { buildNav, SECTIONS, type NavItem } from "./kinds";
import { ResourceTable } from "./ResourceTable";

export function App() {
  const [contexts, setContexts] = useState<KubeContext[]>();
  const [catalogError, setCatalogError] = useState<string>();
  const [cluster, setCluster] = useState<ClusterInfo>();
  const [connecting, setConnecting] = useState<string>();
  const [connectError, setConnectError] = useState<{ context: string; message: string }>();

  useEffect(() => {
    api.invoke("catalog:list", {}).then((r) => {
      setContexts(r.contexts);
      if (r.error) setCatalogError(r.error);
    });
  }, []);

  const connect = async (context: string) => {
    if (cluster?.context === context) return;
    setConnecting(context);
    setConnectError(undefined);
    try {
      if (cluster) await api.invoke("cluster:disconnect", { handle: cluster.handle });
      setCluster(await api.invoke("cluster:connect", { context }));
    } catch (e) {
      setCluster(undefined);
      setConnectError({ context, message: (e as ApiError).message });
    } finally {
      setConnecting(undefined);
    }
  };

  return (
    <div className={"app" + (cluster ? "" : " no-cluster")}>
      <aside className="rail" aria-label="Clusters">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Landlens</div>
        <div className="rail-title">Clusters</div>
        <ul className="contexts">
          {contexts?.map((c) => (
            <li key={c.name}>
              <button
                className={"context" + (cluster?.context === c.name ? " on" : "")}
                onClick={() => void connect(c.name)}
                disabled={!!connecting}
                title={c.server}
              >
                <span className={"status-dot" + (cluster?.context === c.name ? " live" : connecting === c.name ? " busy" : "")} />
                <span className="ctx-name">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {catalogError ? <p className="small tone-bad">{catalogError}</p> : null}
      </aside>
      {cluster ? (
        <Workspace key={cluster.handle} cluster={cluster} />
      ) : (
        <Welcome contexts={contexts} connecting={connecting} error={connectError} onConnect={(c) => void connect(c)} />
      )}
    </div>
  );
}

function Welcome(props: { contexts?: KubeContext[]; connecting?: string; error?: { context: string; message: string }; onConnect: (c: string) => void }) {
  return (
    <main className="welcome">
      <h1>Pick a cluster</h1>
      <p className="muted">
        These are the contexts in your kubeconfig. Landlens connects with your own credentials, kept in a separate process;
        nothing else on this machine can use them.
      </p>
      {props.contexts?.length === 0 ? <p>No contexts found in your kubeconfig.</p> : null}
      <div className="cards">
        {props.contexts?.map((c) => (
          <button key={c.name} className="card" onClick={() => props.onConnect(c.name)} disabled={!!props.connecting}>
            <div className="row-between">
              <strong>{c.name}</strong>
              {c.current ? <span className="pill">current</span> : null}
            </div>
            <div className="mono small muted">{c.server}</div>
            {props.connecting === c.name ? <div className="small">Connecting…</div> : null}
            {props.error?.context === c.name ? <div className="small tone-bad">{props.error.message}</div> : null}
          </button>
        ))}
      </div>
    </main>
  );
}

function Workspace({ cluster }: { cluster: ClusterInfo }) {
  const now = useNow();
  const [nav, setNav] = useState<NavItem[]>();
  const [navError, setNavError] = useState<string>();
  const [current, setCurrent] = useState<NavItem>();
  const [namespace, setNamespace] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<KubeObject>();

  useEffect(() => {
    api.invoke("cluster:discovery", { handle: cluster.handle }).then(
      ({ types }) => {
        const items = buildNav(types);
        setNav(items);
        setCurrent(items.find((n) => n.type.resource === "pods" && !n.type.group) ?? items[0]);
      },
      (e: ApiError) => setNavError(e.message),
    );
  }, [cluster.handle]);

  const namespaces = useWatch({ handle: cluster.handle, group: "", version: "v1", resource: "namespaces" });
  const scoped = current?.type.namespaced && namespace ? namespace : undefined;
  const list = useWatch(
    current
      ? { handle: cluster.handle, group: current.type.group, version: current.type.version, resource: current.type.resource, ...(scoped ? { namespace: scoped } : {}) }
      : undefined,
  );

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return list.items;
    return list.items.filter((o) => o.metadata.name.toLowerCase().includes(f) || (o.metadata.namespace ?? "").toLowerCase().includes(f));
  }, [list.items, filter]);

  // Keep the drawer showing the live object.
  const live = selected && list.items.find((o) => o.metadata.uid === selected.metadata.uid);

  const sections = useMemo(() => {
    const by = new Map<string, NavItem[]>();
    for (const n of nav ?? []) by.set(n.section, [...(by.get(n.section) ?? []), n]);
    const order = [...SECTIONS, ...[...by.keys()].filter((s) => !SECTIONS.includes(s)).sort()];
    return order.filter((s) => by.has(s)).map((s) => [s, by.get(s)!] as const);
  }, [nav]);

  return (
    <>
      <aside className="nav" aria-label="Resources">
        <div className="cluster-head">
          <div className="cluster-name">{cluster.context}</div>
          <div className="muted small mono">{cluster.version}</div>
        </div>
        {navError ? <p className="small tone-bad">{navError}</p> : null}
        {sections.map(([section, items]) => (
          <details key={section} open={SECTIONS.includes(section)}>
            <summary>{section === "core" ? "Core (other)" : section}</summary>
            <ul>
              {items.map((n) => (
                <li key={`${n.type.group}/${n.type.resource}`}>
                  <button
                    className={"nav-item" + (current === n ? " on" : "")}
                    onClick={() => {
                      setCurrent(n);
                      setSelected(undefined);
                    }}
                  >
                    {n.label}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </aside>
      <main className="main">
        <header className="toolbar">
          <h1 className="view-title">{current?.label ?? "…"}</h1>
          <span className="count-badge" aria-live="polite">{list.loading ? "…" : shown.length}</span>
          <div className="grow" />
          {current?.type.namespaced ? (
            <label className="field">
              <span className="sr-only">Namespace</span>
              <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                <option value="">All namespaces</option>
                {namespaces.items
                  .map((n) => n.metadata.name)
                  .sort()
                  .map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span className="sr-only">Filter by name</span>
            <input type="search" placeholder="Filter by name or namespace" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        </header>
        {list.error ? (
          <div className="notice">
            <strong>{list.error.status === 403 ? "You don't have access to this list." : "Couldn't load this list."}</strong>
            <p className="small">{list.error.message}</p>
          </div>
        ) : current ? (
          <ResourceTable columns={current.columns} items={shown} now={now} selected={selected?.metadata.uid} onSelect={setSelected} />
        ) : null}
      </main>
      {selected && current ? (
        <Details handle={cluster.handle} type={current.type} object={live ?? selected} now={now} onClose={() => setSelected(undefined)} />
      ) : null}
    </>
  );
}
