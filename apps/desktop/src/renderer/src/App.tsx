import { CLOUD_DECLINED, type ClusterInfo, type ClusterStatusEvent, type KubeContext } from "@landlens/contracts";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
  const [gkeErrors, setGkeErrors] = useState<{ project: string; message: string }[]>([]);

  /** The catalog again: your kubeconfig's contexts, then the GKE clusters of the Google Cloud projects you chose. */
  const loadCatalog = () =>
    api.invoke("catalog:list", {}).then((r) => {
      setContexts(r.contexts);
      setCatalogError(r.error);
      setGkeErrors(r.gke?.errors ?? []);
    });
  useEffect(() => void loadCatalog(), []);

  // Main disconnected a GKE cluster (its project was taken out, or gcloud's sign-in changed: review of part 5, L7).
  const current = useRef<ClusterInfo | undefined>(undefined);
  current.current = cluster;
  useEffect(() => api.on("cluster:status", (e: ClusterStatusEvent) => {
    if (e.state !== "disconnected") return;
    if (current.current?.handle === e.handle) {
      setCluster(undefined);
      setConnectError({ context: e.context, message: `Disconnected, because ${e.reason}` });
    }
    void loadCatalog();
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A GKE cluster's first connect asks "This is a cloud cluster…" in main's own dialog (D91, part 5 L3); a no shows
  // nothing here.
  const connect = async (context: string) => {
    if (cluster?.context === context || connecting) return;
    const c = contexts?.find((x) => x.name === context);
    setConnecting(context);
    setConnectError(undefined);
    try {
      if (cluster) await api.invoke("cluster:disconnect", { handle: cluster.handle });
      setCluster(undefined);
      setCluster(await api.invoke("cluster:connect", { context }));
      if (c?.source === "gke" && !c.confirmed) setContexts((cs) => cs?.map((x) => (x.name === context ? { ...x, confirmed: true } : x)));
    } catch (e) {
      setCluster(undefined);
      if ((e as ApiError).message !== CLOUD_DECLINED) setConnectError({ context, message: (e as ApiError).message });
    } finally {
      setConnecting(undefined);
    }
  };

  if (cluster) return <><Workspace key={cluster.handle} cluster={cluster} contexts={contexts} onSwitch={(c) => void connect(c)} onCatalog={() => void loadCatalog()} /></>;
  if (alone === "gcp") return <><GcpStandalone onBack={() => (setAlone(undefined), void loadCatalog())} contexts={contexts} onConnect={(c) => void connect(c)} /></>;
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
    </div>
  );
}
