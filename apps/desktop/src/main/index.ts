// Landlens main process: the security baseline, the front door, the clusters and their watches, and the window.
import { ClusterManager, FrontDoor, loopbackCert, WatchHub } from "@landlens/kube";
import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerIpc } from "./ipc";
import { DEV_URL, hardenApp, hardenSession, secureWebPreferences } from "./security";

hardenApp();

/** The Go sidecar: bundled in Resources when packaged; built in the repo during development. */
function sidecarBinary(): string {
  const candidates = [
    process.env.LANDLENS_SIDECAR,
    join(process.resourcesPath ?? "", "bin", "landlens-kube-proxy"),
    resolve(app.getAppPath(), "../../sidecar/kube-proxy/bin/landlens-kube-proxy"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`landlens-kube-proxy not found; run pnpm build:sidecar (looked in ${candidates.join(", ")})`);
  return found;
}

let shutdown: (() => Promise<void>) | undefined;

async function start() {
  hardenSession();
  const binary = sidecarBinary();
  const frontDoor = new FrontDoor(await loopbackCert(binary));
  await frontDoor.start();
  const clusters = new ClusterManager({
    sidecarBinary: binary,
    frontDoor,
    log: (l) => console.log(`[sidecar] ${l}`),
  });
  const hub = new WatchHub(clusters);
  registerIpc(clusters, hub);
  shutdown = async () => {
    await hub.stopAll();
    await clusters.disconnectAll();
    await frontDoor.stop();
  };

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Landlens",
    backgroundColor: "#0e1217",
    show: false,
    webPreferences: secureWebPreferences(join(__dirname, "../preload/index.js")),
  });
  win.once("ready-to-show", () => win.show());
  if (DEV_URL) await win.loadURL(DEV_URL);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(start).catch((err) => {
  console.error(err);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !shutdown) return;
  event.preventDefault();
  quitting = true;
  void shutdown().finally(() => app.quit());
});
