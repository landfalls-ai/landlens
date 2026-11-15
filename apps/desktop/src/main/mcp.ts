// MCP in main (docs/mcp.md): the gateway every agent session's MCP calls go through, the servers you added, the call
// log the MCP page and the dock read, Preview (you running a read-only tool from the MCP page), and MCP App views.
import { BUILTIN_MCP_SERVER, CONN_NOTES, type ConnInfo, type ConnProvider, type McpAppView, type McpCall, type McpServerInfo, type McpServers, type McpTest, type McpToolResult, type MetricsSeries } from "@landlens/contracts";
import { agentReadOnlyPolicy, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorCluster, type AgentCluster } from "@landlens/kube-mcp";
import { BuiltinUpstream, listingHash, McpGateway, PROVIDER_LABEL, rawError, testRemote, toolInfo, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
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
    ask: Ask;
    /** GitHub and Linear, served to every session after the servers you added (docs/connections.md). */
    connections?: ConnectionServers;
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
      onDrift: (spec) => (spec.provider ? deps.connections?.drifted(spec.provider.id) : deps.store.drifted((spec as RemoteSpec & { id: string }).id)),
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
        const s = await this.gateway.open({ label, context, origin: "agent", cluster, remotes });
        const providers = remotes.flatMap((r) => (r.provider ? [PROVIDER_LABEL[r.provider.id]] : []));
        // The standing rules say a connection's reads run without asking only when this session lets them (L3).
        const readsFree = remotes.flatMap((r) => (r.provider && s.allow.some((a) => a.startsWith(`mcp__${r.name}__`)) ? [PROVIDER_LABEL[r.provider.id]] : []));
        return { servers: s.servers(), allow: s.allow, ...(providers.length ? { providers, readsFree } : {}), bind: (id) => s.bind(id), close: () => s.close() };
      },
    };
  }

  /**
   * A session's remote servers: the ones you added and turned on for the cluster, then the connections (whose names
   * a server of yours can't take; one that already has such a name keeps it, and that connection stays off).
   */
  private async remotesFor(context: string): Promise<RemoteSpec[]> {
    const mine = this.deps.store.remotesFor(context);
    const conns = await this.deps.connections?.remotes().catch((err) => {
      this.deps.log?.(`[mcp] connections: ${rawError(err)}`);
      return [];
    }) ?? [];
    return [...mine, ...conns.filter((c) => !mine.some((m) => m.name === c.name))];
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
    const remotes = this.deps.store.list(context);
    const c = this.deps.clickland.view();
    const url = clicklandMcpUrl(c.url);
    return {
      gateway: this.gateway.url,
      servers: [builtin, ...(this.deps.connections?.servers() ?? []), ...remotes],
      canStore: this.deps.store.canStore,
      // Only a Clickland you connected is probed: Landlens doesn't knock on addresses you haven't given it a key for.
      presets: [{ id: "clickland", name: "Clickland", url, reachable: c.hasKey ? await reachable(url) : false, hasKey: c.hasKey, added: remotes.some((s) => s.url === url) }],
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

  /** Clickland in one step: its MCP endpoint, with the read key Connect Clickland stored. */
  async preset(): Promise<McpServerInfo> {
    const c = this.deps.clickland.config();
    if (!c) throw fail(409, "Connect Clickland first (Graphs → Connect Clickland), or add it as a server with a key.");
    const url = clicklandMcpUrl(c.url);
    if (!(await reachable(url))) throw fail(424, `Clickland isn't answering at ${url}.`);
    const existing = this.deps.store.list().find((s) => s.url === url);
    const name = existing?.name ?? (this.deps.store.list().some((s) => s.name === "clickland") ? `clickland-${Date.now().toString(36).slice(-4)}` : "clickland");
    const saved = this.deps.store.save({ ...(existing ? { id: existing.id } : {}), name, url, header: { name: "Authorization", value: `Bearer ${c.key}` } });
    await this.test({ id: saved.id });
    return this.deps.store.info(saved.id);
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
        const session = await this.gateway.open({ label, context: info.context, origin: "you", cluster, remotes: await this.remotesFor(info.context) });
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

/** Whether anything answers HTTP at the address within 1.5 s (any status counts). */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** A cluster that answers nothing: enough to list landlens-kube's tools for the MCP page. */
function stubCluster(): AgentCluster {
  return { context: "", types: async () => [], get: async () => ({ status: 503, text: "{}" }) };
}
