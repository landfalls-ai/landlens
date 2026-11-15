import type { ClusterInfo, KubeContext } from "@landlens/contracts";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, type ApiError } from "./api";
import { ConnectionsPage } from "./ConnectionsPage";
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
  /** Connections opened from Welcome: they work with no cluster connected. */
  const [connections, setConnections] = useState(false);

  useEffect(() => {
    api.invoke("catalog:list", {}).then((r) => {
      setContexts(r.contexts);
      if (r.error) setCatalogError(r.error);
    });
  }, []);

  const connect = async (context: string) => {
    if (cluster?.context === context || connecting) return;
    setConnecting(context);
    setConnectError(undefined);
    try {
      if (cluster) await api.invoke("cluster:disconnect", { handle: cluster.handle });
      setCluster(undefined);
      setCluster(await api.invoke("cluster:connect", { context }));
    } catch (e) {
      setCluster(undefined);
      setConnectError({ context, message: (e as ApiError).message });
    } finally {
      setConnecting(undefined);
    }
  };

  if (cluster) return <Workspace key={cluster.handle} cluster={cluster} contexts={contexts} onSwitch={(c) => void connect(c)} />;
  if (connections) {
    return (
      <div className="app no-cluster">
        <main className="main standalone">
          <header className="standalone-bar">
            <button className="secondary" onClick={() => setConnections(false)}><Ic icon={ArrowLeft} size={14} />Clusters</button>
            <h1>Connections</h1>
          </header>
          <ConnectionsPage />
        </main>
      </div>
    );
  }
  return (
    <div className="app no-cluster">
      <Welcome onConnections={() => setConnections(true)} contexts={contexts} catalogError={catalogError} connecting={connecting} error={connectError} onConnect={(c) => void connect(c)} />
    </div>
  );
}
