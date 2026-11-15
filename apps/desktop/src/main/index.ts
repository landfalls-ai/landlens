// Landlens main process: the security baseline, the front door, the clusters and their watches, and the window.
import { ClusterManager, FrontDoor, loopbackCert, WatchHub } from "@landlens/kube";
import { MetricsService } from "@landlens/metrics";
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentHistory, AgentSettings } from "./agent-history";
import { AgentService } from "./agent";
import { ClicklandSettingsStore } from "./clickland-settings";
import { registerIpc } from "./ipc";
import { ForwardService } from "./forwards";
import { WorkbenchService } from "./workbench";
import { McpService } from "./mcp";
import { McpServerStore } from "./mcp-store";
import { DEV_URL, hardenApp, hardenSession, registerAppProtocol, RENDERER_INDEX, secureWebPreferences } from "./security";

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
  let mcp: McpService | undefined;
  // The front door's audit trail: the MCP call log files each landlens-kube call's requests under it.
  const frontDoor = new FrontDoor(await loopbackCert(binary), (e) => mcp?.onAudit(e));
  await frontDoor.start();
  const clusters = new ClusterManager({
    sidecarBinary: binary,
    frontDoor,
    log: (l) => console.log(`[sidecar] ${l}`),
  });
  const hub = new WatchHub(clusters);
  let win: BrowserWindow | undefined;
  const send = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const settings = new ClicklandSettingsStore(join(app.getPath("userData"), "clickland.json"), safeStorage);
  const metrics = new MetricsService({
    clickland: () => ({ config: settings.config(), clusterName: (context) => settings.clusterName(context) }),
    cluster: (handle) => {
      const c = clusters.get(handle);
      return { context: c.info.context, get: (path) => c.client.json(path) };
    },
  });
  // For the metrics tool: `read` is the session's own front-door token (its policy, scrubbing and audit), so what the
  // series reads from the cluster is read as the session. The usage numbers are Clickland's or the shared sampler's.
  const series = (handle: string, r: Omit<Parameters<MetricsService["series"]>[0], "handle">, read?: (path: string) => Promise<any>) =>
    metrics.series({ handle, ...r }, read ? { read } : {});
  mcp = new McpService({
    store: new McpServerStore(join(app.getPath("userData"), "mcp-servers.json"), safeStorage),
    clickland: settings,
    frontDoor,
    clusters,
    metrics: series,
    push: (call) => send("mcp:call", call),
    ask: {
      confirm: async ({ message, detail, yes }) => {
        const opts = { type: "question" as const, buttons: [yes, "Cancel"], defaultId: 1, cancelId: 1, message, detail, noLink: true };
        const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        return r.response === 0;
      },
      openExternal: (url) => shell.openExternal(url),
    },
    log: (l) => console.log(l),
  });
  await mcp.start();
  registerAppProtocol(mcp.views);
  const gateway = mcp.gateway;
  const agent = new AgentService({
    frontDoor,
    clusters,
    sessionsDir: join(app.getPath("userData"), "agent-sessions"),
    push: send as ConstructorParameters<typeof AgentService>[0]["push"],
    mcp: mcp.forSessions(),
    onToolCall: (u) => gateway.card(u),
    onPermit: (p) => gateway.permit(p.session, p),
    metrics: series,
    history: new AgentHistory(join(app.getPath("userData"), "agent-history.json")),
    settings: new AgentSettings(join(app.getPath("userData"), "agent-settings.json")),
    log: (l) => console.log(l),
  });
  const workbench = new WorkbenchService({ clusters, frontDoor, dataDir: app.getPath("userData") });
  liveSessions = () => workbench.terminalCount();
  const forwards = new ForwardService({
    clusters, frontDoor,
    file: join(app.getPath("userData"), "forwards.json"),
    push: (list) => send("forward:update", { forwards: list }),
    // Only http(s)://127.0.0.1:<port>/, built by the service from the forward itself.
    openExternal: (url) => shell.openExternal(url),
    log: (l) => console.log(l),
  });
  registerIpc(clusters, hub, agent, { service: metrics, settings }, mcp, workbench, forwards);
  const service = mcp;
  shutdown = async () => {
    forwards.stopAll();
    metrics.stopAll();
    await agent.stop();
    await service.stop();
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
/** Shells and terminals that quitting would end (D23): asked about once. */
let liveSessions = () => 0;
app.on("before-quit", (event) => {
  if (quitting || !shutdown) return;
  const n = liveSessions();
  if (n) {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = { type: "question" as const, buttons: ["Quit", "Cancel"], defaultId: 0, cancelId: 1, message: `${n} session${n === 1 ? "" : "s"} will end`, detail: "Every shell and terminal open in Landlens closes with it." };
    const choice = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
    if (choice === 1) return event.preventDefault();
  }
  event.preventDefault();
  quitting = true;
  void shutdown().finally(() => app.quit());
});
