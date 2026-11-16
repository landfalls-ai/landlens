// Landlens main process: the security baseline, the front door, the clusters and their watches, and the window.
import { checkAccess, ClusterManager, FrontDoor, loopbackCert, WatchHub } from "@landlens/kube";
import { MetricsService } from "@landlens/metrics";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeTheme, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentHistory, AgentSettings } from "./agent-history";
import { adapterEntry, AgentService } from "./agent";
import { TelemetryService } from "./telemetry";
import { BrainService } from "./brain";
import { ClicklandSettingsStore } from "./clickland-settings";
import { PrometheusChoices } from "./prometheus-choice";
import { registerIpc } from "./ipc";
import { DoctorService } from "./doctor";
import { ClicklandHistory } from "./clickland-history";
import { SiblingText } from "./sibling-text";
import { ForwardService } from "./forwards";
import { WorkbenchService } from "./workbench";
import { ActionService, nodeWritesFrom, quitQuestion } from "./actions";
import { ActionLog } from "./action-log";
import { clipboardFormats, clipboardMarker, SecretService } from "./secrets";
import { McpService, moveClicklandServer } from "./mcp";
import { McpServerStore } from "./mcp-store";
import { connectionOverrides, ConnectionsService } from "./connections";
import { gcpMode, GcpService } from "./gcp";
import { familyOverrides, FamilyService } from "./family";
import { LandflowActions } from "./landflow";
import { FamilySentStore } from "@landlens/connections";
import { loginPath, which } from "@landlens/acp-host";
import { askOf } from "@landlens/telemetry";
import type { AgentChange } from "@landlens/contracts";
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
  /** The agent service, once made: the gateway's autonomy pushes go through it (M1 of the wave 7 part 2 review). */
  let agentRef: AgentService | undefined;
  /** Landlens's own telemetry (wave 7 part 5): off until the person turns it on. */
  let telemetry: TelemetryService | undefined;
  // The front door's audit trail: the MCP call log files each landlens-kube call's requests under it; telemetry counts it.
  // D153 lives in the front door (security review of wave 8 part 2, M5): an unpackaged build sends no node write and no
  // eviction through any token unless LANDLENS_NODE_WRITES names the cluster's context and API server; packaged, any.
  const nodeWrites = nodeWritesFrom(process.env, app.isPackaged);
  const frontDoor = new FrontDoor(await loopbackCert(binary), (e) => {
    mcp?.onAudit(e);
    telemetry?.audit(e);
  }, { nodeWrites });
  await frontDoor.start();
  const clusters = new ClusterManager({
    sidecarBinary: binary,
    frontDoor,
    log: (l) => console.log(`[sidecar] ${l}`),
  });
  const hub = new WatchHub(clusters);
  // The doctor's evidence falls back to Clickland's history when the kubelet has neither run (D118); set below.
  let history: ClicklandHistory | undefined;
  // What main sent the window from Clickland, so a question that quotes it holds autonomy (review of part 3, M2).
  const siblingText = new SiblingText();
  const doctor = new DoctorService({ clusters, hub, history: (handle, q) => history?.lastLines(handle, q) ?? Promise.resolve(undefined) });
  let win: BrowserWindow | undefined;
  const send = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const settings = new ClicklandSettingsStore(join(app.getPath("userData"), "clickland.json"), safeStorage);
  const prometheus = new PrometheusChoices(join(app.getPath("userData"), "prometheus.json"));
  const metrics = new MetricsService({
    clickland: () => ({ config: settings.config(), clusterName: (context) => settings.clusterName(context) }),
    cluster: (handle) => {
      const c = clusters.get(handle);
      // Prometheus answers are capped and timed: a Service anyone made could hold the call or send gigabytes.
      return { context: c.info.context, get: (path) => c.client.json(path), ask: (path) => c.client.jsonCapped(path, { maxBytes: 8 * 1048576, timeoutMs: 10_000 }) };
    },
    prometheus: { chosen: (context) => prometheus.chosen(context) },
  });
  // For the metrics tool: `read` is the session's own front-door token (its policy, scrubbing and audit), so what the
  // series reads from the cluster is read as the session. The usage numbers are Clickland's or the shared sampler's.
  const series = (handle: string, r: Omit<Parameters<MetricsService["series"]>[0], "handle">, read?: (path: string) => Promise<any>) =>
    metrics.series({ handle, ...r }, read ? { read } : {});
  const mcpStore = new McpServerStore(join(app.getPath("userData"), "mcp-servers.json"), safeStorage);
  // GitHub and Linear (docs/connections.md). The provider overrides are for tests and development only.
  const connections = new ConnectionsService({
    file: join(app.getPath("userData"), "connections.json"),
    crypto: safeStorage,
    overrides: connectionOverrides(process.env, app.isPackaged),
    // Only GitHub's device page or an address on Linear's own origin reach this (connections.ts checks).
    openExternal: (url) => shell.openExternal(url),
    // Open sessions follow a connection's change at once (M2).
    push: (info) => {
      send("conn:update", info);
      mcp?.connectionChanged(info);
    },
    // A server you added under github or linear keeps that name, and the connection stays off.
    takenNames: () => mcpStore.list().map((s) => s.name),
    log: (l) => console.log(l),
  });
  // The Land family (docs/family.md): Landflow's key and Landfall's sign-in in family.json; Clickland's key stays in
  // clickland.json. LANDLENS_FAMILY_HTTP_HOSTS is for an unpackaged build only.
  const family = new FamilyService({
    file: join(app.getPath("userData"), "family.json"),
    crypto: safeStorage,
    clickland: settings,
    overrides: familyOverrides(process.env, app.isPackaged),
    // Only an address on the Landfall origin being signed in to reaches this (family.ts checks).
    openExternal: (url) => shell.openExternal(url),
    // Open sessions follow a sibling's change at once, as a connection's (M2).
    push: (info) => {
      send("family:update", info);
      mcp?.familyChanged(info);
    },
    // A server you added under clickland, landflow or landfall keeps that name, and the sibling's tools stay off.
    takenNames: () => mcpStore.list().map((s) => s.name),
    log: (l) => console.log(l),
  });
  // Clickland's logs and traces in the IDE (docs/metrics.md#logs-and-traces): its key and console through the family's
  // rule; an object only if the window's cluster has it or the doctor named it.
  history = new ClicklandHistory({
    key: () => family.clicklandReadKey(),
    clusterName: (context) => settings.clusterName(context),
    context: (handle) => clusters.get(handle).info.context,
    object: (handle, ref) => clusters.getObject(handle, ref).catch((e: { status?: number }) => (e?.status === 404 ? undefined : Promise.reject(e))),
    known: (handle, scope) => doctor.knows(handle, scope),
    console: () => family.clicklandConsole(),
    // History shows log lines only when the cluster would (review of part 3, L1).
    canReadLogs: async (handle, namespace) => (await checkAccess(clusters.get(handle).client, [{ verb: "get", group: "", resource: "pods", subresource: "log", namespace }]))[0] === true,
    served: (rows) => siblingText.served("clickland", rows),
  });
  clusters.onGone((handle) => history?.forget(handle));
  // Landlens's telemetry (docs/family.md#what-landlens-reports): to the collector the person confirmed, through the
  // family's address rule; counts and names only, built by packages/telemetry. The sidecar sends nothing (D131).
  const tel = new TelemetryService({
    settings,
    allowed: (url) => family.urlAllowed(url),
    // The name set for graphs; without one, a plain context name only (clusterLabel; review of part 5, L2).
    clusterName: (context) => settings.namedCluster(context),
    // A doctor brief's subject goes only when the doctor's own report names it (L1).
    problemAbout: (context, subject, cls) => clusters.list().some((c) => c.context === context && doctor.reports(c.handle, subject, cls)),
    // A tool's name goes only when its server listed it as the person accepted it (L8).
    knownTool: (session, server, tool) => mcp?.gateway.knownTool(session, server, tool) ?? false,
    clusters: () => clusters.list(),
    problems: () => doctor.problemCounts(),
    version: app.getVersion(),
    platform: process.platform,
    console: () => family.clicklandConsole(),
    push: () => send("family:update", family.info("clickland")),
    log: (l) => console.log(l),
  });
  telemetry = tel;
  family.telemetryInfo = () => tel.info();
  tel.start();
  clusters.onConnected(() => tel.clusterConnected());
  clusters.onGone((_handle, why) => tel.clusterGone(why));
  // D109: the server Add Clickland made on the MCP page becomes the family's clickland server, once.
  moveClicklandServer({ store: mcpStore, clickland: settings, family, log: (l) => console.log(l) });
  // Google Cloud (docs/gcp.md): gcloud's sign-in, read-only. An unpackaged build is off unless it has a loopback fake
  // (LANDLENS_GCP_ENDPOINT, with LANDLENS_GCLOUD for a fake gcloud) or the person set LANDLENS_GCP_REAL=1.
  const gcp = new GcpService({
    file: join(app.getPath("userData"), "gcp.json"),
    gkeDir: join(app.getPath("userData"), "gke"),
    mode: gcpMode(process.env, app.isPackaged),
    findGcloud: async () => which("gcloud", await loginPath()),
    loginPath: () => loginPath(),
    env: process.env,
    log: (l) => console.log(l),
    // gcloud's account changed: the grant to Claude ends, and landlens-gcp leaves open sessions at once (part 5, M3).
    onAgentOff: () => mcp?.gcpOff(),
  });
  mcp = new McpService({
    store: mcpStore,
    connections,
    // Clickland, Landflow and Landfall (D107): served after the connections when Tools for Claude is on.
    family,
    // landlens-gcp (D93): read-only Google Cloud tools for sessions, when you turned "Claude can read" on.
    gcp: { reader: () => gcp.agentReader((context) => clusters.list().some((c) => c.context === context)) },
    clickland: settings,
    frontDoor,
    clusters,
    metrics: series,
    certs: (handle, namespaces) => doctor.certsFor(handle, namespaces),
    push: (call) => send("mcp:call", call),
    // The dock hears of it, and a hold goes into the session's history, so a resume holds again (M1).
    pushAutonomy: (s) => (agentRef ? agentRef.autonomyChanged(s) : send("agent:autonomy", s)),
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
  const mcpSvc = mcp;
  const agentHistory = new AgentHistory(join(app.getPath("userData"), "agent-history.json"));
  // A session's summary to the brain (D134): facts counted here, sent only from the sheet.
  let brainRef: BrainService | undefined;
  gateway.log.subscribe((c) => {
    tel.call(c);
    brainRef?.call(c);
  });
  const agentPush = ((channel: string, payload: unknown) => {
    if (channel === "agent:change") {
      tel.change(payload as AgentChange);
      brainRef?.change(payload as AgentChange);
    }
    send(channel, payload);
  }) as ConstructorParameters<typeof AgentService>[0]["push"];
  const agent = new AgentService({
    siblingText,
    frontDoor,
    clusters,
    sessionsDir: join(app.getPath("userData"), "agent-sessions"),
    push: agentPush,
    mcp: mcp.forSessions(),
    onToolCall: (u) => gateway.card(u),
    onPermit: (p) => gateway.permit(p.session, p),
    // GitHub's and Linear's autonomous mode: main answers a routine write's question only when the gateway's check passes.
    autonomy: {
      check: (session, toolName, input) => mcpSvc.autonomyCheck(session, toolName, input),
      permit: (session, p) => mcpSvc.autonomyPermit(session, p),
      states: (session) => mcpSvc.autonomyStates(session),
      gcpQuoted: (session) => gateway.gcpQuoted(session),
      familyQuoted: (session, sibling) => gateway.familyQuoted(session, sibling),
      hold: (session, why) => gateway.hold(session, why),
    },
    metrics: series,
    certs: (handle, namespaces) => doctor.certsFor(handle, namespaces),
    history: agentHistory,
    settings: new AgentSettings(join(app.getPath("userData"), "agent-settings.json")),
    observers: [{
      started: (st) => tel.sessionStarted(st),
      ended: (id) => tel.sessionEnded(id),
      asked: (id, text, refs) => tel.turnStarted(id, askOf(text, refs)),
      answered: (id, end) => tel.turnEnded(id, end),
      usage: (id, u) => tel.usage(id, u),
      mode: (id, m) => tel.modeChanged(id, m),
      exited: () => tel.adapterExited(),
    }],
    // Tests only (unpackaged): a fake ACP agent from test/fixtures in place of claude-agent-acp, with a warning (L9).
    adapter: adapterEntry(process.env, app.isPackaged, resolve(app.getAppPath(), "test/fixtures"), (l) => console.warn(l)),
    // While Claude drafts the brain's summary, the gateway refuses the agent's calls (L4).
    onDraft: (session, on) => gateway.drafting(session, on),
    log: (l) => console.log(l),
  });
  agentRef = agent;
  const brain = new BrainService({ family, history: agentHistory, agent, clusterName: (context) => settings.namedCluster(context) });
  brainRef = brain;
  agent.addObserver(brain.observer);
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
  // Landflow on a resource (wave 7 part 4): sends to triage and flow runs, built in main, sent on the person's click.
  const landflow = new LandflowActions({
    family, doctor,
    clusters: { context: (handle) => clusters.get(handle).info.context, server: (handle) => clusters.get(handle).info.server, typeOf: (handle, ref) => clusters.typeOf(handle, ref), getObject: (handle, ref) => clusters.getObject(handle, ref) },
    sent: new FamilySentStore(join(app.getPath("userData"), "family-sent.json")),
    // A flow's output is Landflow's text: a question quoting it holds autonomy, decided here (review of part 4, M4).
    served: (rows) => siblingText.served("landflow", rows),
  });
  // Your actions (wave 8 parts 1–2): Scale, Restart, Delete, Trigger, Suspend and Resume, Cordon and Drain as you,
  // with its own broker, and one kept row per apply in actions.json (D147); telemetry counts the action and its outcome
  // only. An unpackaged build writes to no node unless LANDLENS_NODE_WRITES names the context (D153).
  const actionLog = new ActionLog(join(app.getPath("userData"), "actions.json"));
  const actions = new ActionService({
    clusters, frontDoor,
    log: actionLog,
    counted: (a) => tel.action(a),
    nodeWrites,
  });
  // Secret values (wave 8 part 4, D161–D168): one key to the window that unlocked it, or to the clipboard from main
  // with the platform's markers in the same write (macOS's concealed type; Windows's no-monitor, no-history, no-cloud);
  // cleared after 30 s, and at quit, if the clipboard still holds it (read only while the marker is still there).
  const secrets = new SecretService({
    clusters, frontDoor,
    log: actionLog,
    clipboard: {
      write: (text) => clipboard.write([new ClipboardItem(clipboardFormats(process.platform, text))]),
      marked: async () => {
        const f = clipboardMarker(process.platform);
        return f ? clipboard.has(f) : true;
      },
      readText: () => clipboard.readText(),
      clear: () => clipboard.clear(),
    },
  });
  liveDrains = () => actions.liveRuns();
  endDrains = () => actions.quit();
  registerIpc(clusters, hub, agent, { service: metrics, settings, prometheus, history }, mcp, workbench, forwards, doctor, connections, gcp, family, landflow, { telemetry: tel, brain }, actions, secrets);
  const service = mcp;
  shutdown = async () => {
    await secrets.quit();
    forwards.stopAll();
    metrics.stopAll();
    connections.stop();
    family.stop();
    await agent.stop();
    await tel.stop();
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
/** Drains running in main (security review of part 2, L9): quitting asks, then stops them and writes their rows. */
let liveDrains = () => 0;
let endDrains = () => {};
app.on("before-quit", (event) => {
  if (quitting || !shutdown) return;
  const n = liveSessions();
  const d = liveDrains();
  if (n || d) {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = { type: "question" as const, buttons: ["Quit", "Cancel"], defaultId: 0, cancelId: 1, ...quitQuestion(n, d) };
    const choice = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
    if (choice === 1) return event.preventDefault();
  }
  event.preventDefault();
  quitting = true;
  endDrains();
  void shutdown().finally(() => app.quit());
});
