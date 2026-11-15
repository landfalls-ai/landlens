// MCP in main (docs/mcp.md): the gateway every agent session's MCP calls go through, the servers you added, the call
// log the MCP page and the dock read, Preview (you running a read-only tool from the MCP page), and MCP App views.
// GitHub and Linear (Connections) and the Land family's servers (Clickland, Landflow, Landfall; docs/family.md) are
// served after the servers you added, under their reserved names.
import { BUILTIN_MCP_SERVER, CONN_NOTES, FAMILY_NOTES, GCP_MCP_SERVER, type AutonomyScope, type AutonomyState, type ConnInfo, type ConnProvider, type FamilyInfo, type McpAppView, type McpCall, type McpServerInfo, type McpServers, type McpTest, type McpToolResult, type MetricsSeries, type Sibling } from "@landlens/contracts";
import { agentReadOnlyPolicy, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorCluster, type AgentCluster } from "@landlens/kube-mcp";
import { BuiltinUpstream, isSibling, listingHash, McpGateway, PROVIDER_LABEL, rawError, testRemote, toolInfo, type BuiltinSpec, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
import { gcpMcpServer, type GcpReader } from "@landlens/gcp-mcp";
import type { SessionMcp } from "@landlens/acp-host";
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

export class McpService {
  readonly gateway: McpGateway;
  readonly views = new AppViews();
  private readonly consoles = new Map<string, Promise<{ session: GatewaySession; revoke(): void }>>(); // handle → yours
  /** What each sibling was for sessions at its last push, so a push that changes nothing leaves Preview open (L6). */
  private readonly familyWas = new Map<Sibling, string>();
  private builtinTools: Promise<McpServerInfo["tools"]> | undefined;
  /** A view's link dialog is open. */
  private linkAsked = false;

  constructor(private readonly deps: {
    store: McpServerStore;
    clickland: ClicklandSettingsStore;
    frontDoor: FrontDoor;
    clusters: ClusterManager;
    metrics: (handle: string, req: Parameters<NonNullable<AgentCluster["metrics"]>>[0], read?: (path: string) => Promise<any>) => Promise<MetricsSeries>;
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
    /** Google Cloud for landlens-gcp (GcpService.agentReader): undefined while Claude may not read it. */
    gcp?: { reader(): Promise<{ reader: GcpReader; projects: string[] } | undefined> };
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
    deps.clusters.onGone((handle) => void this.closeConsole(handle));
  }

  start() {
    return this.gateway.start();
  }

  async stop() {
    for (const h of [...this.consoles.keys()]) await this.closeConsole(h);
    await this.gateway.stop();
  }

  /** The gateway as an agent session sees it (acp-host's SessionMcp). */
  forSessions(): SessionMcp {
    return {
      open: async ({ label, context, cluster }) => {
        const remotes = await this.remotesFor(context);
        const gcp = await this.gcpBuiltin();
        const s = await this.gateway.open({ label, context, origin: "agent", cluster, remotes, ...(gcp ? { builtins: [gcp.spec] } : {}) });
        const providers = remotes.flatMap((r) => (r.provider && !isSibling(r.provider.id) ? [PROVIDER_LABEL[r.provider.id]] : []));
        // The Land family's servers get their own paragraph in the standing rules (D114).
        const family = remotes.flatMap((r) => (r.provider && isSibling(r.provider.id) ? [PROVIDER_LABEL[r.provider.id]] : []));
        // The standing rules say a connection's reads run without asking only when this session lets them (L3).
        const readsFree = remotes.flatMap((r) => (r.provider && s.allow.some((a) => a.startsWith(`mcp__${r.name}__`)) ? [PROVIDER_LABEL[r.provider.id]] : []));
        return {
          servers: s.servers(), allow: s.allow, ...(providers.length || family.length ? { providers, readsFree } : {}), ...(family.length ? { family } : {}), ...(gcp ? { gcp: gcp.projects } : {}),
          bind: (id) => s.bind(id), close: () => s.close(),
        };
      },
    };
  }

  /** landlens-gcp for a session (D93), when you let Claude read your Google Cloud projects and gcloud is ready. */
  private async gcpBuiltin(): Promise<{ spec: BuiltinSpec; projects: string[] } | undefined> {
    const g = await this.deps.gcp?.reader().catch((err) => {
      this.deps.log?.(`[mcp] landlens-gcp: ${rawError(err)}`);
      return undefined;
    });
    // One server per session: its 30-calls-a-minute limit is the session's.
    return g ? { spec: { name: GCP_MCP_SERVER, server: () => gcpMcpServer(g.reader) }, projects: g.projects } : undefined;
  }

  /** You turned "Claude can read these projects" off: landlens-gcp leaves every open session at once. */
  gcpOff() {
    this.gateway.dropBuiltin(GCP_MCP_SERVER);
    for (const h of [...this.consoles.keys()]) void this.closeConsole(h);
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
    }
    return { ok: r.ok, steps: r.steps, ...(tools ? { tools } : {}) };
  }

  /** "Run read-only tools without asking" for a server, pinned to the tools the page shows. */
  autoRun(id: string, on: boolean, context?: string): McpServerInfo {
    return this.deps.store.setAutoRun(id, on, context);
  }

  enable(id: string, context: string, on: boolean): McpServerInfo {
    const s = this.deps.store.enable(id, context, on);
    void this.closeConsoleFor(context); // Preview picks up the change next time
    return s;
  }

  remove(id: string) {
    this.deps.store.remove(id);
    for (const h of [...this.consoles.keys()]) void this.closeConsole(h);
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
        const token = this.deps.frontDoor.issueToken({ label, policy: agentReadOnlyPolicy(), clusters: [handle] });
        const cluster = frontDoorCluster({
          url: this.deps.frontDoor.clusterUrl(handle), certificate: this.deps.frontDoor.certificate, token, context: info.context,
          types: async () => types, metrics: (r, read) => this.deps.metrics(handle, r, read),
          ...(this.deps.certs ? { certs: async (ns: string[] | undefined) => this.deps.certs!(handle, ns) } : {}),
        });
        const gcp = await this.gcpBuiltin();
        const session = await this.gateway.open({ label, context: info.context, origin: "you", cluster, remotes: await this.remotesFor(info.context), ...(gcp ? { builtins: [gcp.spec] } : {}) });
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
    const csp = viewCsp(res.csp, call.server === BUILTIN_MCP_SERVER ? [] : this.deps.store.appOriginsOf(call.server));
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
    if (!this.views.allowCall(viewId)) throw fail(429, "That view is calling tools too often.");
    const session = this.gateway.sessionOf(v.call);
    if (!session) return { content: [{ type: "text", text: "Landlens: the session this view came from has ended." }], isError: true };
    return (await session.call(v.server, name, args, "app")) as McpToolResult;
  }

  /**
   * ui/open-link: https only, after you've seen the host and said yes. One dialog at a time for all views, and at
   * most three a minute per view, so a view can't bury you in dialogs until you click Open.
   */
  async viewLink(viewId: string, raw: string): Promise<boolean> {
    const v = this.views.get(viewId);
    if (!v) throw fail(404, "That view has closed.");
    if (this.linkAsked) throw fail(429, "Landlens is already asking about a link.");
    if (!this.views.allowLink(viewId)) throw fail(429, "That view is opening links too often.");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw fail(400, "not a link");
    }
    if (u.protocol !== "https:" || u.username || u.password) throw fail(400, "Views may open https links only.");
    this.linkAsked = true;
    try {
      const yes = await this.deps.ask.confirm({
        message: `Open ${u.host} in your browser?`,
        detail: `The ${v.server} view (${v.tool}) wants to open:\n${u.href.slice(0, 500)}`,
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

/** A cluster that answers nothing: enough to list landlens-kube's tools for the MCP page. */
function stubCluster(): AgentCluster {
  return { context: "", types: async () => [], get: async () => ({ status: 503, text: "{}" }) };
}
