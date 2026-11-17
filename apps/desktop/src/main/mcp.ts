// MCP in main (docs/mcp.md): the gateway every agent session's MCP calls go through, the servers you added, the call
// log the MCP page and the dock read, Preview (you running a read-only tool from the MCP page), and MCP App views.
// GitHub and Linear (Connections) and the Land family's servers (Clickland, Landflow, Landfall; docs/family.md) are
// served after the servers you added, under their reserved names.
import { BUILTIN_MCP_SERVER, CONN_NOTES, FAMILY_NOTES, GCP_MCP_SERVER, VIEWS_MCP_SERVER, type AutonomyScope, type AutonomyState, type ConnInfo, type ConnProvider, type FamilyInfo, type McpAppView, type McpCall, type McpServerInfo, type McpServers, type McpTest, type McpToolResult, type MetricsSeries, type Sibling } from "@landlens/contracts";
import { agentReadOnlyPolicy, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorCluster, type AgentCluster } from "@landlens/kube-mcp";
import { createHash } from "node:crypto";
import { BuiltinUpstream, isBuiltin, isSibling, listingHash, McpGateway, PROVIDER_LABEL, rawError, testRemote, toolInfo, WHY, type BuiltinSpec, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
import { gcpMcpServer, type GcpReader } from "@landlens/gcp-mcp";
import type { SessionGoogle, SessionMcp } from "@landlens/acp-host";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppViews, viewCsp } from "./app-views";
import type { ClicklandSettingsStore } from "./clickland-settings";
import { originOf, type McpServerStore } from "./mcp-store";

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Connections as the MCP side needs them (main's ConnectionsService): their upstreams, their panels, drift. */
export type ConnectionServers = {
  remotes(): Promise<RemoteSpec[]>;
  servers(): McpServerInfo[];
  drifted(p: ConnProvider): void;
  /** The connection as the page sees it: autonomous needs it ready, at Ask for writes, its tools accepted. */
  info?(p: ConnProvider): ConnInfo;
};

/** The Land family as the MCP side needs it (main's FamilyService): its upstreams, its panels, drift (D107). */
export type FamilyServers = {
  remotes(): Promise<RemoteSpec[]>;
  servers(): McpServerInfo[];
  /** `listing`: the hash of the listing the session found. */
  drifted(s: Sibling, listing?: string): void;
  /** Whether a session's server for the sibling is its server and key now (M2 of the part 2 review). */
  serves?(s: Sibling, spec: RemoteSpec): boolean;
  /** The siblings' origins: a server you added at one stays out of sessions (L1). */
  origins?(): string[];
};

export type Ask = {
  /** A yes/no question in a native dialog. */
  confirm(q: { message: string; detail: string; yes: string }): Promise<boolean>;
  openExternal(url: string): Promise<void>;
};

/** The longest view link the dialog shows whole (review of wave 10 part 2, M2); a longer one is refused. */
export const VIEW_LINK_SHOWN = 500;

/** What a view's tool source hears (ViewRuntime's ToolAnswer): the result's text, or why it didn't run, in D222's words. */
export type ViewToolAnswer = { text: string } | { off: string } | { error: string };

export class McpService {
  readonly gateway: McpGateway;
  readonly views = new AppViews();
  private readonly consoles = new Map<string, Promise<{ session: GatewaySession; revoke(): void }>>(); // handle → yours
  /**
   * The Views page's gateway sessions (wave 10 part 4, D212), handle → `view · <context>`, origin "view", with the
   * digest of the remotes it was opened with: a session whose cluster's remotes changed since (a server's switch, its
   * address or header, Run read-only tools without asking, a connection or a sibling) is closed and opened again as
   * things are now before its next read (security review of part 4, M4).
   */
  private readonly viewSessions = new Map<string, Promise<{ session: GatewaySession; digest: string }>>();
  /** What each sibling was for sessions at its last push, so a push that changes nothing leaves Preview open (L6). */
  private readonly familyWas = new Map<Sibling, string>();
  private builtinTools: Promise<McpServerInfo["tools"]> | undefined;
  /** A view's link dialog is open. */
  private linkAsked = false;
  /** Bumped by gcpOff(): a session opened before has no Google Cloud from then on, its kube tools' included (M1). */
  private gcpEpoch = 0;

  constructor(private readonly deps: {
    store: McpServerStore;
    clickland: ClicklandSettingsStore;
    frontDoor: FrontDoor;
    clusters: ClusterManager;
    /** `google`: what the session may use of Google Cloud (D194); without it, no Cloud Monitoring. */
    metrics: (handle: string, req: Parameters<NonNullable<AgentCluster["metrics"]>>[0], read?: (path: string) => Promise<any>, google?: SessionGoogle) => Promise<MetricsSeries>;
    /** The person's certificate facts for cluster_overview's Preview (DoctorService.certsFor). */
    certs?: (handle: string, namespaces?: string[]) => Awaited<ReturnType<NonNullable<AgentCluster["certs"]>>>;
    push: (call: McpCall) => void;
    /** A connection's autonomous mode changed in a session (agent:autonomy push). */
    pushAutonomy?: (s: AutonomyState) => void;
    ask: Ask;
    /** GitHub and Linear, served to every session after the servers you added (docs/connections.md). */
    connections?: ConnectionServers;
    /** Clickland, Landflow and Landfall, served after the connections, when Tools for Claude is on (docs/family.md). */
    family?: FamilyServers;
    /**
     * Google Cloud for landlens-gcp (GcpService.agentReader): undefined while Claude may not read it. `session`: the
     * session's cluster (its context, address, checked CA and namespace limit, for D195). `projectsNow`: the projects a
     * session that began with `start` may read now (GcpService.agentProjectsNow; security review of wave 9 part 4, M1).
     * `line`: cluster_overview's line for a session's cluster from what main holds (GcpService.heldLine, D194).
     */
    gcp?: {
      reader(session?: { context: string; server?: string; ca?: string; namespaces?: string[] }): Promise<{ reader: GcpReader; projects: string[] } | undefined>;
      projectsNow(start: string[]): string[];
      line?(handle: string, projects: string[], namespaces?: string[]): string | undefined;
    };
    log?: (l: string) => void;
  }) {
    this.gateway = new McpGateway({
      approve: (q) => deps.ask.confirm({
        message: `Let a view run ${q.server} · ${q.tool}?`,
        detail: `${q.tool} doesn't say it only reads, so Landlens asks first. It was asked for by an app view in ${q.label}, with:\n${JSON.stringify(q.args, null, 2).slice(0, 600)}`,
        yes: "Run it once",
      }),
      ...(deps.log ? { log: deps.log } : {}),
      // Every RemoteSpec the gateway gets comes from the store, with its id, or from Connections, with its provider.
      onDrift: (spec, listing) => {
        const p = spec.provider?.id;
        if (!p) deps.store.drifted((spec as RemoteSpec & { id: string }).id);
        else if (isSibling(p)) deps.family?.drifted(p, listing);
        else deps.connections?.drifted(p);
      },
      ...(deps.pushAutonomy ? { onAutonomy: deps.pushAutonomy } : {}),
    });
    this.gateway.log.subscribe(deps.push);
    // closeConsole ends the cluster's view sessions too.
    deps.clusters.onGone((handle) => void this.closeConsole(handle));
  }

  /**
   * A view's tool source (wave 10 part 4, D212): one call through the cluster's view session, `view · <context>`, with
   * origin "view". It runs only when it is a read this cluster's Claude sessions run without asking (the gateway checks
   * the session's pre-allowed set at the call); Landlens's own servers have their own source kinds. The answer is the
   * result's text for the view's runtime, which keeps it as cells; every refusal is a fixed sentence.
   */
  async viewRead(handle: string, server: string, tool: string, args: Record<string, unknown>): Promise<ViewToolAnswer> {
    if (isBuiltin(server) || server.startsWith("landlens")) return { off: `${server} isn't a server a tool source reads: use its own source kinds.` };
    // The person's switches as they are at this call (M4): never a session opened before one of them changed.
    const s = await this.viewSession(handle, true);
    if (!s.upstreams.has(server)) return { off: `${server} isn't connected for this cluster's Claude sessions.` };
    if (!s.allow.includes(`mcp__${server}__${tool}`)) return { off: `${server} · ${tool} isn't a read that runs without asking.` };
    const r = (await s.call(server, tool, args, "view")) as McpToolResult;
    if (r.isError) {
      const why = r.content.find((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")?.text ?? "";
      // The gateway's own refusal (it changed since the check above): off; the server's error: an error.
      return /^Landlens: /.test(why) ? { off: `${server} · ${tool} isn't a read that runs without asking.` } : { error: "failed" };
    }
    const text = r.content.flatMap((c) => ((c as { type?: string }).type === "text" ? [String((c as { text?: unknown }).text ?? "")] : [])).join("\n");
    return { text: text || (r.structuredContent ? JSON.stringify(r.structuredContent) : "") };
  }

  /**
   * Google Cloud for a view (D212): the reader a Claude session on this cluster with these namespaces would get (the
   * person's grant, its chosen projects, the session's cluster for the namespace limit), or undefined while it is off.
   */
  async viewGcp(handle: string, namespaces?: string[]) {
    let context: string;
    try {
      context = this.deps.clusters.get(handle).info.context;
    } catch {
      return undefined;
    }
    const g = await this.deps.gcp?.reader(this.sessionCluster(handle, context, namespaces)).catch(() => undefined);
    return g;
  }

  /** The gateway reads a view's tool source may use on this cluster now (view_context's list): `server · tool`. */
  async viewReads(handle: string): Promise<string[]> {
    const s = await this.viewSession(handle, true).catch(() => undefined);
    if (!s) return [];
    return s.allow
      .map((r) => /^mcp__([a-z][a-z0-9-]*)__(.+)$/.exec(r))
      .filter((m): m is RegExpExecArray => !!m && !isBuiltin(m[1]!) && !m[1]!.startsWith("landlens") && s.upstreams.has(m[1]!))
      .map((m) => `${m[1]} · ${m[2]}`)
      .slice(0, 60);
  }

  /**
   * The cluster's view session. `fresh`: its remotes are read again and compared with the ones it was opened with; a
   * difference closes it and opens another, so a read runs only as the person's switches are now (M4).
   */
  private async viewSession(handle: string, fresh = false): Promise<GatewaySession> {
    const info = this.deps.clusters.get(handle).info;
    let v = this.viewSessions.get(handle);
    if (v && fresh) {
      const was = await v.catch(() => undefined);
      const now = remotesDigest(await this.remotesFor(info.context));
      if (!was || was.digest !== now) {
        if (this.viewSessions.get(handle) === v) this.viewSessions.delete(handle);
        await was?.session.close();
        v = this.viewSessions.get(handle);
      }
    }
    if (!v) {
      v = (async () => {
        const remotes = await this.remotesFor(info.context);
        // No cluster behind it (landlens-kube answers nothing here) and no built-ins: a view reads its cluster with its
        // own token in the runtime, and Google Cloud through its own sources.
        const session = await this.gateway.open({ label: `view · ${info.context}`, context: info.context, origin: "view", cluster: stubCluster(), remotes });
        return { session, digest: remotesDigest(remotes) };
      })();
      this.viewSessions.set(handle, v);
      v.catch(() => this.viewSessions.delete(handle));
    }
    return (await v).session;
  }

  /**
   * The view sessions end with the consoles: a connection, a sibling or a server changed (its switch for a cluster, its
   * address or header, Run read-only tools without asking), or the cluster went (M4).
   */
  private async closeViewSessions(handle?: string) {
    for (const [h, p] of [...this.viewSessions]) {
      if (handle && h !== handle) continue;
      this.viewSessions.delete(h);
      const s = await p.catch(() => undefined);
      await s?.session.close();
    }
  }

  start() {
    return this.gateway.start();
  }

  async stop() {
    for (const h of [...this.consoles.keys()]) await this.closeConsole(h);
    await this.closeViewSessions();
    await this.gateway.stop();
  }

  /** The gateway as an agent session sees it (acp-host's SessionMcp). */
  forSessions(): SessionMcp {
    return {
      open: async ({ label, context, handle, cluster, views }) => {
        const remotes = await this.remotesFor(context);
        const gcp = await this.gcpBuiltin(this.sessionCluster(handle, context, cluster.namespaces));
        // A session from the Views page also gets landlens-views (wave 10, D205), built by main's ViewService.
        const builtins: BuiltinSpec[] = [];
        if (gcp) builtins.push(gcp.spec);
        if (views) builtins.push({ name: VIEWS_MCP_SERVER, server: views as () => McpServer });
        const s = await this.gateway.open({ label, context, origin: "agent", cluster, remotes, ...(builtins.length ? { builtins } : {}) });
        const providers = remotes.flatMap((r) => (r.provider && !isSibling(r.provider.id) ? [PROVIDER_LABEL[r.provider.id]] : []));
        // The Land family's servers get their own paragraph in the standing rules (D114).
        const family = remotes.flatMap((r) => (r.provider && isSibling(r.provider.id) ? [PROVIDER_LABEL[r.provider.id]] : []));
        // The standing rules say a connection's reads run without asking only when this session lets them (L3).
        const readsFree = remotes.flatMap((r) => (r.provider && s.allow.some((a) => a.startsWith(`mcp__${r.name}__`)) ? [PROVIDER_LABEL[r.provider.id]] : []));
        return {
          servers: s.servers(), allow: s.allow, ...(providers.length || family.length ? { providers, readsFree } : {}), ...(family.length ? { family } : {}), ...(gcp ? { gcp: gcp.projects } : {}),
          google: this.sessionGoogle(s, handle, gcp?.projects ?? [], cluster.namespaces),
          ...(views ? { views: true } : {}),
          bind: (id) => s.bind(id), close: () => s.close(),
        };
      },
    };
  }

  /**
   * A session's cluster as landlens-gcp's reader needs it (D195): its context, its address, the fingerprint of the CA its
   * sidecar checks TLS against (only when TLS is checked, with no override: M2), its namespace limit.
   */
  private sessionCluster(handle: string, context: string, namespaces?: string[]) {
    let server: string | undefined;
    let ca: string | undefined;
    try {
      const c = this.deps.clusters.get(handle);
      server = c.info.server;
      const t = c.sidecar?.tls;
      ca = t && !t.insecure && !t.serverName && t.ca ? t.ca : undefined;
    } catch {
      server = undefined;
    }
    return { context, ...(server ? { server } : {}), ...(ca ? { ca } : {}), ...(namespaces?.length ? { namespaces } : {}) };
  }

  /**
   * What a session's kube tools may use of Google Cloud (D194): the projects its landlens-gcp began with (none without
   * the grant) as they are at each call (`projects()`: GcpService's answer now, and none at all once gcpOff() ran since
   * the session opened; security review of wave 9 part 4, M1), a hold on this very gateway session (its GitHub and
   * Linear writes ask from then on, as after a landlens-gcp call), and cluster_overview's line from what main holds,
   * for those projects only.
   */
  private sessionGoogle(s: GatewaySession, handle: string, start: string[], namespaces?: string[]): SessionGoogle {
    const gcp = this.deps.gcp;
    const line = gcp?.line;
    const begun = [...start];
    const epoch = this.gcpEpoch;
    const projects = () => (gcp && begun.length && epoch === this.gcpEpoch ? gcp.projectsNow(begun) : []);
    return {
      projects,
      hold: () => s.hold(WHY.gcp),
      ...(line && begun.length ? {
        line: () => {
          const now = projects();
          return now.length ? line(handle, now, namespaces) : undefined;
        },
      } : {}),
    };
  }

  /** landlens-gcp for a session (D93), when you let Claude read your Google Cloud projects and gcloud is ready. */
  private async gcpBuiltin(session?: { context: string; server?: string; namespaces?: string[] }): Promise<{ spec: BuiltinSpec; projects: string[] } | undefined> {
    const g = await this.deps.gcp?.reader(session).catch((err) => {
      this.deps.log?.(`[mcp] landlens-gcp: ${rawError(err)}`);
      return undefined;
    });
    // One server per session: its 30-calls-a-minute limit is the session's.
    return g ? { spec: { name: GCP_MCP_SERVER, server: () => gcpMcpServer(g.reader) }, projects: g.projects } : undefined;
  }

  /**
   * You turned "Claude can read these projects" off (or gcloud's account changed): landlens-gcp leaves every open session
   * at once, and their kube tools read Cloud Monitoring no more (M1), even after reading is turned on again.
   */
  gcpOff() {
    this.gcpEpoch++;
    this.gateway.dropBuiltin(GCP_MCP_SERVER);
    for (const h of [...this.consoles.keys()]) void this.closeConsole(h);
    void this.closeViewSessions();
  }

  /**
   * A session's remote servers: the ones you added and turned on for the cluster, then the connections, then the Land
   * family's (whose names a server of yours can't take; one that already has such a name keeps it, and that connection
   * or sibling stays off). A server you added at a connected sibling's address stays out (review of part 2, L1): it
   * would be that sibling without the family's rules (its reads, its data line, the hold on autonomy).
   */
  private async remotesFor(context: string): Promise<RemoteSpec[]> {
    const mine = this.deps.store.remotesFor(context).filter((r) => {
      if (!this.atSibling(r.url)) return true;
      this.deps.log?.(`[mcp] ${r.name} is at a Land family app's address; it stays out of sessions (Connections → Land family gives its tools)`);
      return false;
    });
    const conns = await this.deps.connections?.remotes().catch((err) => {
      this.deps.log?.(`[mcp] connections: ${rawError(err)}`);
      return [];
    }) ?? [];
    const family = await this.deps.family?.remotes().catch((err) => {
      this.deps.log?.(`[mcp] family: ${rawError(err)}`);
      return [];
    }) ?? [];
    const out: RemoteSpec[] = [...mine];
    for (const r of [...conns, ...family]) if (!out.some((m) => m.name === r.name)) out.push(r);
    return out;
  }

  /**
   * A sibling changed (FamilyService's push), and open sessions follow at once, as connections do (M2): one signed out,
   * expired, taken from sessions or blocked by a server of yours with its name leaves every session that has it; one
   * whose reads stopped running without asking (the switch, or its tools changed) has its reads ask again. Preview
   * sessions are closed, to be opened again as the sibling is now.
   */
  familyChanged(info: FamilyInfo) {
    const served = info.state === "ready" && info.toSessions && info.note !== FAMILY_NOTES.nameTaken;
    const readsFree = info.readsAuto && !info.drift;
    const fam = this.deps.family;
    // Another key or address that never left ready (Landflow connected again with a new key, M2) is another server:
    // it leaves the sessions that have the old one, with every standing yes for it.
    let dropped = false;
    this.gateway.restrictProvider(info.sibling, (spec) => {
      if (served && (!fam?.serves || fam.serves(info.sibling, spec))) return readsFree ? undefined : "reads";
      dropped = true;
      return "drop";
    });
    // Preview is opened again only when something sessions get changed (L6): not on a who-am-I or a Check's push.
    const now = [served, readsFree, info.url, info.tools?.read, info.tools?.write].join(" ");
    if (!dropped && this.familyWas.get(info.sibling) === now) return;
    this.familyWas.set(info.sibling, now);
    for (const h of [...this.consoles.keys()]) void this.closeConsole(h);
    void this.closeViewSessions();
  }

  /** Whether an address is a signed-in sibling's origin, this machine's spellings (localhost, 127.0.0.1, [::1]) alike. */
  private atSibling(url: string): boolean {
    const key = (u: string) => {
      try {
        const x = new URL(u);
        const host = ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname) ? "loopback" : x.hostname;
        return `${x.protocol}//${host}:${x.port || (x.protocol === "https:" ? "443" : "80")}`;
      } catch {
        return "";
      }
    };
    const k = key(url);
    return !!k && (this.deps.family?.origins?.() ?? []).some((o) => key(o) === k);
  }

  /**
   * A connection changed (ConnectionsService's push), and open sessions follow at once (M2): one disconnected, taken
   * from sessions, expired or set to Read only leaves every session that has it at Ask for writes; one whose reads
   * stopped running without asking (the switch, or its tools changed) has its reads ask again. Every standing yes for
   * its tools goes with it. Preview sessions are closed, to be opened again as the connection is now.
   */
  connectionChanged(info: ConnInfo) {
    const served = info.state === "ready" && info.give;
    const readsFree = info.readsAuto && info.note !== CONN_NOTES.drift;
    this.gateway.restrictProvider(info.provider, (spec) => {
      if (!served || (spec.provider?.mode === "ask" && info.mode === "read")) return "drop";
      return readsFree ? undefined : "reads";
    });
    for (const h of [...this.consoles.keys()]) void this.closeConsole(h);
    void this.closeViewSessions();
    // Autonomous ends with the connection as it was turned on: gone, read only, or its tools changed (D82).
    if (!served || info.mode === "read") this.gateway.stopAutonomy(info.provider, "you");
    else if (info.note === CONN_NOTES.drift) this.gateway.stopAutonomy(info.provider, "drift");
  }

  // ---- the autonomous mode (D82) -----------------------------------------------------------------------------------

  /**
   * agent:autonomy: turn a connection's autonomous mode on (with its scope) or off in one session. On needs the
   * connection ready, at Ask for writes, given to sessions and with no tools-changed note; the gateway checks the rest.
   */
  setAutonomy(session: string, provider: ConnProvider, on: boolean, scope?: AutonomyScope): AutonomyState {
    if (on) {
      const c = this.deps.connections?.info?.(provider);
      const name = PROVIDER_LABEL[provider];
      if (!c || c.state !== "ready" || !c.give) throw fail(409, `${name} isn't connected for Claude sessions.`);
      if (c.mode !== "ask") throw fail(409, `${name} is read only: there are no writes to run on their own.`);
      if (c.note === CONN_NOTES.drift || c.note === CONN_NOTES.unaccepted) throw fail(409, `${name}'s tools need a look on the Connections page first.`);
    }
    return this.gateway.setAutonomy(session, provider, on, scope);
  }

  /** What main asks before answering Claude Code's question for a routine write itself. */
  autonomyCheck(session: string, toolName: string, input: unknown) {
    return this.gateway.autonomyCheck(session, toolName, input);
  }

  /** Main's yes for a write that passed the check: the gateway checks it again when it arrives. */
  autonomyPermit(session: string, p: { toolCallId: string; toolName: string }) {
    this.gateway.permit(session, { ...p, always: false, autonomous: true });
  }

  autonomyStates(session: string): AutonomyState[] {
    return this.gateway.autonomyStates(session);
  }

  /** The front door's audit trail, for the requests behind each landlens-kube call. */
  onAudit = (e: Parameters<McpGateway["onAudit"]>[0]) => this.gateway.onAudit(e);

  // ---- servers -------------------------------------------------------------------------------------------------

  async servers(context?: string): Promise<McpServers> {
    this.builtinTools ??= new BuiltinUpstream(BUILTIN_MCP_SERVER, stubCluster()).tools().then((t) => t.map((t) => toolInfo(t)));
    const builtin: McpServerInfo = {
      id: BUILTIN_MCP_SERVER, name: BUILTIN_MCP_SERVER, builtin: true, url: this.gateway.url, enabled: true, autoRun: true, appOrigins: [],
      tools: (await this.builtinTools) ?? [], status: "ready",
    };
    // A server you added at a sibling's address is listed with why it isn't in sessions (L1).
    const remotes = this.deps.store.list(context).map((r) => (this.atSibling(r.url) ? { ...r, status: "failed" as const, detail: FAMILY_NOTES.siblingAddress } : r));
    const gcp = await this.gcpInfo();
    return {
      gateway: this.gateway.url,
      servers: [builtin, ...(this.deps.connections?.servers() ?? []), ...(this.deps.family?.servers() ?? []), ...(gcp ? [gcp] : []), ...remotes],
      canStore: this.deps.store.canStore,
    };
  }

  /** landlens-gcp as the MCP page lists it, while it is on: built in, managed on the Connections page. */
  private gcpTools: Promise<McpServerInfo["tools"]> | undefined;
  private async gcpInfo(): Promise<McpServerInfo | undefined> {
    const g = await this.deps.gcp?.reader().catch(() => undefined);
    if (!g) return undefined;
    this.gcpTools ??= new BuiltinUpstream(GCP_MCP_SERVER, () => gcpMcpServer(g.reader)).tools().then((t) => t.map((x) => toolInfo(x)));
    return {
      id: GCP_MCP_SERVER, name: GCP_MCP_SERVER, builtin: true, connection: "gcp", url: `${this.gateway.url}/${GCP_MCP_SERVER}`, enabled: true, autoRun: true, appOrigins: [],
      tools: (await this.gcpTools.catch(() => undefined)) ?? [], status: "ready",
    };
  }

  save(input: Parameters<McpServerStore["save"]>[0], context?: string): McpServerInfo {
    const s = this.deps.store.save(input);
    // A new address or header: no view session keeps the old one (M4).
    void this.closeViewSessions();
    return this.deps.store.info(s.id, context);
  }

  /**
   * Initialize and list tools, with the typed header or, for a saved server, the stored one. A stored value goes only
   * to the origin and under the header name it was saved with: for another address or name, type it again.
   */
  async test(req: { id?: string; url?: string; header?: { name: string; value?: string } }): Promise<McpTest> {
    let spec: RemoteSpec;
    // Only a test of the saved server as it is saved updates its status, tools and listing.
    let asSaved = false;
    if (req.id) {
      const saved = this.deps.store.spec(req.id);
      const storedName = this.deps.store.headerName(req.id);
      const url = req.url ?? saved.url;
      const name = req.header?.name ?? storedName;
      let value = req.header?.value;
      if (value === undefined && saved.headers) {
        if (originOf(url) !== originOf(saved.url) || name?.toLowerCase() !== storedName?.toLowerCase()) {
          return { ok: false, steps: [{ name: "header", ok: false, detail: "The stored header value is only sent to the address and header it was saved for. Type it again to test this one." }] };
        }
        value = Object.values(saved.headers)[0];
      }
      spec = { name: saved.name, url, ...(name && value ? { headers: { [name]: value } } : {}) };
      asSaved = url === saved.url && req.header?.value === undefined && name?.toLowerCase() === storedName?.toLowerCase();
    } else {
      if (!req.url) throw fail(400, "Give the server's address.");
      spec = { name: "test", url: req.url, ...(req.header?.value ? { headers: { [req.header.name]: req.header.value } } : {}) };
    }
    const r = await testRemote(spec);
    const tools = r.tools?.map((t) => toolInfo(t));
    if (req.id && asSaved) {
      this.deps.store.status(req.id, {
        status: r.ok ? "ready" : "failed", ...(r.ok ? {} : { detail: r.steps.at(-1)?.detail ?? "failed" }),
        ...(tools ? { tools } : {}), ...(r.tools ? { listing: listingHash(r.tools) } : {}),
      });
      // A listing that changed takes Run read-only tools without asking away: the view sessions follow (M4).
      void this.closeViewSessions();
    }
    return { ok: r.ok, steps: r.steps, ...(tools ? { tools } : {}) };
  }

  /** "Run read-only tools without asking" for a server, pinned to the tools the page shows. */
  autoRun(id: string, on: boolean, context?: string): McpServerInfo {
    const s = this.deps.store.setAutoRun(id, on, context);
    // A view's reads of the server stop (or may start) at once, not when its session ends (M4).
    void this.closeViewSessions();
    return s;
  }

  enable(id: string, context: string, on: boolean): McpServerInfo {
    const s = this.deps.store.enable(id, context, on);
    void this.closeConsoleFor(context); // Preview picks up the change next time
    // A cluster with no Preview console still has its view session: it ends too (M4).
    void this.closeViewSessions();
    return s;
  }

  remove(id: string) {
    this.deps.store.remove(id);
    for (const h of [...this.consoles.keys()]) void this.closeConsole(h);
    void this.closeViewSessions();
  }

  // ---- calls and Preview -----------------------------------------------------------------------------------------

  calls(): McpCall[] {
    return this.gateway.log.list();
  }

  /** You run a tool with no required arguments from the MCP page: read-only tools only, with your own session. */
  async try(handle: string, server: string, tool: string): Promise<McpCall> {
    const { session } = await this.console(handle);
    if (!session.upstreams.has(server)) throw fail(404, `${server} isn't turned on for this cluster.`);
    let id = "";
    await session.call(server, tool, {}, "you", (c) => (id = c));
    const call = this.gateway.log.get(id);
    if (!call) throw fail(500, "the call wasn't logged");
    return call;
  }

  private console(handle: string) {
    let c = this.consoles.get(handle);
    if (!c) {
      c = (async () => {
        const info = this.deps.clusters.get(handle).info;
        const types = await this.deps.clusters.discovery(handle);
        const label = `you · ${info.context}`;
        const gcp = await this.gcpBuiltin(this.sessionCluster(handle, info.context));
        // Preview runs the session's tools as a session would get them: Cloud Monitoring only with the grant (D194).
        let google: SessionGoogle | undefined;
        const token = this.deps.frontDoor.issueToken({ label, policy: agentReadOnlyPolicy(), clusters: [handle] });
        const cluster = frontDoorCluster({
          url: this.deps.frontDoor.clusterUrl(handle), certificate: this.deps.frontDoor.certificate, token, context: info.context,
          types: async () => types, metrics: (r, read) => this.deps.metrics(handle, r, read, google),
          google: () => google?.line?.(),
          ...(this.deps.certs ? { certs: async (ns: string[] | undefined) => this.deps.certs!(handle, ns) } : {}),
        });
        const session = await this.gateway.open({ label, context: info.context, origin: "you", cluster, remotes: await this.remotesFor(info.context), ...(gcp ? { builtins: [gcp.spec] } : {}) });
        google = this.sessionGoogle(session, handle, gcp?.projects ?? []);
        return { session, revoke: () => this.deps.frontDoor.revokeToken(token) };
      })();
      this.consoles.set(handle, c);
      c.catch(() => this.consoles.delete(handle));
    }
    return c;
  }

  /** The cluster was disconnected: end your Preview session on it. */
  forget(handle: string) {
    return this.closeConsole(handle);
  }

  private async closeConsole(handle: string) {
    // A view session follows its cluster's Preview: opened again, as things are now, at its next read.
    void this.closeViewSessions(handle);
    const c = this.consoles.get(handle);
    this.consoles.delete(handle);
    const s = await c?.catch(() => undefined);
    s?.revoke();
    await s?.session.close();
  }

  private async closeConsoleFor(context: string) {
    for (const [h, c] of [...this.consoles]) {
      const s = await c.catch(() => undefined);
      if (!s || s.session.init.context === context) await this.closeConsole(h);
    }
  }

  // ---- app views ---------------------------------------------------------------------------------------------------

  /** A call's view: its HTML on the sandbox origin, and the input and result the host hands it. */
  async openView(callId: string): Promise<McpAppView> {
    const call = this.gateway.log.get(callId);
    const kept = this.gateway.log.result(callId);
    if (!call?.app || !kept) throw fail(404, "That call has no view (or it's too old to show).");
    const session = this.gateway.sessionOf(callId);
    const res = await this.gateway.appResource(session, call.server, call.app, kept.url);
    const csp = viewCsp(res.csp, isBuiltin(call.server) ? [] : this.deps.store.appOriginsOf(call.server));
    const view = this.views.add({ call: callId, server: call.server, tool: call.tool, html: res.html, csp });
    const t = this.gateway.tool(call.server, call.tool);
    return {
      view: view.id,
      url: AppViews.url(view.id),
      server: call.server,
      tool: t ? toolInfo(t) : { name: call.tool, readOnly: false, visibility: ["model", "app"], required: [] },
      input: kept.args,
      result: kept.result,
      ...(res.prefersBorder !== undefined ? { prefersBorder: res.prefersBorder } : {}),
      csp,
    };
  }

  /** A view's tools/call: through the gateway, as the view's session, on the view's own server only. */
  async viewCall(viewId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const v = this.views.get(viewId);
    if (!v) throw fail(404, "That view has closed.");
    // A block of a view calls only view_data, through views:app-call (wave 10, D204).
    if (v.block) throw fail(403, "A view's block calls its own view's data only.");
    if (!this.views.allowCall(viewId)) throw fail(429, "That view is calling tools too often.");
    const session = this.gateway.sessionOf(v.call);
    if (!session) return { content: [{ type: "text", text: "Landlens: the session this view came from has ended." }], isError: true };
    return (await session.call(v.server, name, args, "app")) as McpToolResult;
  }

  /**
   * ui/open-link: https only, after you've seen the whole address and said yes. One dialog at a time for all views, and
   * at most three a minute per view, so a view can't bury you in dialogs until you click Open. An address longer than
   * the dialog shows whole is refused without one (review of wave 10 part 2, M2: it showed 500 characters and opened
   * 2,000, so the rest could carry a view's data unseen); the dialog says when the address carries data after `?`, and
   * names who asks: a block Claude built on the Views page by its caption, never as Landlens's own render_view.
   */
  async viewLink(viewId: string, raw: string): Promise<boolean> {
    const v = this.views.get(viewId);
    if (!v) throw fail(404, "That view has closed.");
    if (this.linkAsked) throw fail(429, "Landlens is already asking about a link.");
    if (!this.views.allowLink(viewId)) throw fail(429, "That view is opening links too often.");
    // Who wrote the block, as ViewService said when it opened it (security review of wave 10 part 4, M6).
    const who = v.block ? `${v.block.by ?? "A block Claude built"} on the Views page (${v.block.caption ?? v.block.block})` : `The ${v.server} view (${v.tool})`;
    return this.confirmLink(who, raw);
  }

  /**
   * Main's one dialog for a link something other than the person wrote (a view's frame, a text block on the Views
   * page: security review of wave 10 part 3, L4): https only, no credentials, at most VIEW_LINK_SHOWN characters shown
   * whole, a query said, `who` asking; one dialog at a time. Opens only on Open.
   */
  async confirmLink(who: string, raw: string): Promise<boolean> {
    if (this.linkAsked) throw fail(429, "Landlens is already asking about a link.");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw fail(400, "not a link");
    }
    if (u.protocol !== "https:" || u.username || u.password) throw fail(400, "Views may open https links only.");
    if (u.href.length > VIEW_LINK_SHOWN) throw fail(400, `That link is ${u.href.length.toLocaleString("en-US")} characters: Landlens shows a view's link whole before it opens it, and opens none over ${VIEW_LINK_SHOWN}.`);
    this.linkAsked = true;
    try {
      const yes = await this.deps.ask.confirm({
        message: `Open ${u.host} in your browser?`,
        detail: `${who} wants to open this address${u.search ? ", which carries data after the ?" : ""}:\n${u.href}`,
        yes: "Open",
      });
      if (yes) await this.deps.ask.openExternal(u.href);
      return yes;
    } finally {
      this.linkAsked = false;
    }
  }
}

export const clicklandMcpUrl = (base: string) => `${base.replace(/\/+$/, "")}/api/mcp`;

/** Two server addresses that are the same endpoint: scheme, host, port and path, a trailing slash aside. */
function sameEndpoint(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "") && !x.search && !y.search;
  } catch {
    return false;
  }
}

/**
 * D109, once ever (the first start of a Landlens with the family's tools; review of part 2, M4): a server Add Clickland
 * made (its address is the connected Clickland's /api/mcp) leaves mcp-servers.json. Only one that was on for a cluster
 * turns Clickland's Tools for Claude on (on every cluster now, which the card says), with Reads run without asking as
 * its "Run read-only tools without asking" was, and its pin kept only if Clickland lists the same tools now. One off
 * everywhere is removed and Tools for Claude stays off. A server you typed with another address, even one named
 * clickland, is left alone; after the move, one at the sibling's address stays out of sessions (L1).
 */
export function moveClicklandServer(o: {
  store: Pick<McpServerStore, "records" | "remove">;
  clickland: Pick<ClicklandSettingsStore, "keyOrigin" | "config">;
  family: { startClicklandMove(): boolean; adoptClickland(old: { on: boolean; readsAuto: boolean; pin?: string }): boolean };
  log?: (l: string) => void;
}): boolean {
  if (!o.family.startClicklandMove()) return false;
  const origin = o.clickland.config() ? o.clickland.keyOrigin() : undefined;
  if (!origin) return false;
  const url = clicklandMcpUrl(origin);
  const old = o.store.records().filter((s) => sameEndpoint(s.url, url));
  if (!old.length) return false;
  const on = old.filter((s) => s.contexts.length > 0);
  // The pin the person allowed reads for, if the servers that were on agree on one.
  const pins = new Set(on.map((s) => s.autoRunPin));
  const pin = pins.size === 1 ? [...pins][0] : undefined;
  if (!o.family.adoptClickland({ on: on.length > 0, readsAuto: on.some((s) => s.autoRunPin), ...(pin ? { pin } : {}) })) return false;
  for (const s of old) o.store.remove(s.id);
  o.log?.(`[mcp] moved ${old.map((s) => s.name).join(", ")} (${url}) to the Land family's clickland server; see Connections → Land family`);
  return true;
}

/**
 * What a view session's reads depend on in its remotes (M4): each one's name, addresses, a hash of its headers, its pins
 * and its provider's rules. Its OAuth provider is left out (a function): Linear's sign-in changes reach sessions as a
 * connection change.
 */
function remotesDigest(remotes: RemoteSpec[]): string {
  const h = createHash("sha256");
  for (const r of remotes) {
    h.update(JSON.stringify([
      r.name, r.url, r.readUrl ?? null, r.headers ? createHash("sha256").update(JSON.stringify(r.headers)).digest("hex") : null, r.pin ?? null, r.readPin ?? null,
      r.pinTools ?? null, r.origins ?? null, r.noViews ?? null,
      r.provider ? [r.provider.id, r.provider.mode, r.provider.readsAuto, [...(r.provider.readTools ?? [])].sort()] : null,
    ]));
  }
  return h.digest("hex");
}

/** A cluster that answers nothing: enough to list landlens-kube's tools for the MCP page. */
function stubCluster(): AgentCluster {
  return { context: "", types: async () => [], get: async () => ({ status: 503, text: "{}" }) };
}
