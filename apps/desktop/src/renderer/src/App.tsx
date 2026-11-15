import { CLOUD_CONFIRM, type ClusterInfo, type KubeContext } from "@landlens/contracts";
import { useEffect, useState } from "react";
import { ArrowLeft, Cloud } from "lucide-react";
import { api, type ApiError } from "./api";
import { ConnectionsPage } from "./ConnectionsPage";
import { GcpStandalone } from "./GcpPage";
import { Ic } from "./icons";
import { Welcome } from "./Welcome";
import { Workspace } from "./Workspace";

/** The kubeconfig's contexts, the one cluster connected, and either the welcome page or the workspace. */
export function App() {
  const [contexts, setContexts] = useState<KubeContext[]>();
  const [catalogError, setCatalogError] = useState<string>();
  const [cluster, setCluster] = useState<ClusterInfo>();
  const [connecting, setConnecting] = useState<string>();
  const [connectError, setConnectError] = useState<{ context: string; message: string }>();
  /** Connections or Google Cloud opened from Welcome: they work with no cluster connected. */
  const [alone, setAlone] = useState<"connections" | "gcp">();
  /** A GKE cluster waiting on "This is a cloud cluster…" (D91), asked once per cluster. */
  const [cloudAsk, setCloudAsk] = useState<KubeContext>();
  const [gkeErrors, setGkeErrors] = useState<{ project: string; message: string }[]>([]);

  /** The catalog again: your kubeconfig's contexts, then the GKE clusters of the Google Cloud projects you chose. */
  const loadCatalog = () =>
    api.invoke("catalog:list", {}).then((r) => {
      setContexts(r.contexts);
      setCatalogError(r.error);
      setGkeErrors(r.gke?.errors ?? []);
    });
  useEffect(() => void loadCatalog(), []);

  const connect = async (context: string, cloud = false) => {
    if (cluster?.context === context || connecting) return;
    const c = contexts?.find((x) => x.name === context);
    if (c?.source === "gke" && !c.confirmed && !cloud) return setCloudAsk(c);
    setConnecting(context);
    setConnectError(undefined);
    try {
      if (cluster) await api.invoke("cluster:disconnect", { handle: cluster.handle });
      setCluster(undefined);
      setCluster(await api.invoke("cluster:connect", { context, ...(cloud ? { cloud } : {}) }));
      if (cloud) setContexts((cs) => cs?.map((x) => (x.name === context ? { ...x, confirmed: true } : x)));
    } catch (e) {
      setCluster(undefined);
      setConnectError({ context, message: (e as ApiError).message });
    } finally {
      setConnecting(undefined);
    }
  };

  const ask = cloudAsk ? (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && setCloudAsk(undefined)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cloud-title" style={{ width: 420 }}
        onKeyDown={(e) => e.key === "Escape" && setCloudAsk(undefined)}>
        <header className="dialog-head"><span className="kind-tile sm"><Ic icon={Cloud} size={15} /></span><h2 id="cloud-title">Connect {cloudAsk.name.split("_").at(-1)}?</h2></header>
        <div className="dialog-body">
          <p>{CLOUD_CONFIRM}</p>
          <p className="small dim">GKE cluster in <b className="mono">{cloudAsk.project}</b>, {cloudAsk.location}. Landlens connects as you, with gcloud's sign-in; it asks this once per cluster.</p>
        </div>
        <footer className="dialog-foot">
          <button className="secondary" autoFocus onClick={() => setCloudAsk(undefined)}>Cancel</button>
          <button className="primary" onClick={() => {
            const name = cloudAsk.name;
            setCloudAsk(undefined);
            void connect(name, true);
          }}>Connect</button>
        </footer>
      </div>
    </div>
  ) : null;

  if (cluster) return <>{ask}<Workspace key={cluster.handle} cluster={cluster} contexts={contexts} onSwitch={(c) => void connect(c)} onCatalog={() => void loadCatalog()} /></>;
  if (alone === "gcp") return <>{ask}<GcpStandalone onBack={() => (setAlone(undefined), void loadCatalog())} contexts={contexts} onConnect={(c) => void connect(c)} /></>;
  if (alone === "connections") {
    return (
      <div className="app no-cluster">
        <main className="main standalone">
          <header className="standalone-bar">
            <button className="secondary" onClick={() => (setAlone(undefined), void loadCatalog())}><Ic icon={ArrowLeft} size={14} />Clusters</button>
            <h1>Connections</h1>
          </header>
          <ConnectionsPage onOpenGcp={() => setAlone("gcp")} />
        </main>
      </div>
    );
  }
  return (
    <div className="app no-cluster">
      <Welcome onConnections={() => setAlone("connections")} onGcp={() => setAlone("gcp")} contexts={contexts} catalogError={catalogError} gkeErrors={gkeErrors} connecting={connecting} error={connectError} onConnect={(c) => void connect(c)} />
      {ask}
    </div>
  );
}
