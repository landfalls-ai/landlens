// Landlens main process: the security baseline, the front door, the clusters and their watches, and the window.
import { ClusterManager, FrontDoor, loopbackCert, WatchHub } from "@landlens/kube";
import { MetricsService } from "@landlens/metrics";
import { app, BrowserWindow, nativeTheme, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentService } from "./agent";
import { ClicklandSettingsStore } from "./clickland-settings";
import { registerIpc } from "./ipc";
import { DEV_URL, hardenApp, hardenSession, RENDERER_INDEX, secureWebPreferences } from "./security";

hardenApp();

// Development and tests only: a separate profile (the e2e test uses one, so it never touches your settings).
if (!app.isPackaged && process.env.LANDLENS_USER_DATA) app.setPath("userData", process.env.LANDLENS_USER_DATA);

/**
 * The Go sidecar holds cluster credentials, so a packaged app only runs the copy in its own Resources. The
 * LANDLENS_SIDECAR override and the repo build are for development.
 */
function sidecarBinary(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "bin", "landlens-kube-proxy")]
    : [process.env.LANDLENS_SIDECAR, resolve(app.getAppPath(), "../../sidecar/kube-proxy/bin/landlens-kube-proxy")]
        .filter((p): p is string => !!p);
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
  let win: BrowserWindow | undefined;
  const agent = new AgentService({
    frontDoor,
    clusters,
    sessionsDir: join(app.getPath("userData"), "agent-sessions"),
    push: ((channel: string, payload: unknown) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }) as ConstructorParameters<typeof AgentService>[0]["push"],
    log: (l) => console.log(l),
  });
  const settings = new ClicklandSettingsStore(join(app.getPath("userData"), "clickland.json"), safeStorage);
  const metrics = new MetricsService({
    clickland: () => ({ config: settings.config(), clusterName: (context) => settings.clusterName(context) }),
    cluster: (handle) => {
      const c = clusters.get(handle);
      return { context: c.info.context, get: (path) => c.client.json(path) };
    },
  });
  registerIpc(clusters, hub, agent, { service: metrics, settings });
  shutdown = async () => {
    metrics.stopAll();
    await agent.stop();
    await hub.stopAll();
    await clusters.disconnectAll();
    await frontDoor.stop();
  };

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: "Landlens",
    // No flash before the page paints: the window is the page's base colour (--bg-0) in the system's theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0B0C0F" : "#F3F4F6",
    // On macOS the page draws its own title bar: the traffic lights sit in the sidebar's top strip.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
    show: false,
    webPreferences: secureWebPreferences(join(__dirname, "../preload/index.js")),
  });
  win.once("ready-to-show", () => win.show());
  // A reload or a crashed renderer leaves no dock to show the agent sessions: end them, which revokes their tokens.
  win.webContents.on("did-start-navigation", (d) => {
    if (d.isMainFrame && !d.isSameDocument) void agent.closeAll();
  });
  win.webContents.on("render-process-gone", () => void agent.closeAll());
  win.webContents.on("destroyed", () => void agent.closeAll());
  if (DEV_URL) await win.loadURL(DEV_URL);
  else await win.loadFile(RENDERER_INDEX);
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
