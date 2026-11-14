// MCP in main (docs/mcp.md): the gateway every agent session's MCP calls go through, the servers you added, the call
// log the MCP page and the dock read, Preview (you running a read-only tool from the MCP page), and MCP App views.
import { BUILTIN_MCP_SERVER, type McpAppView, type McpCall, type McpServerInfo, type McpServers, type McpTest, type McpToolResult, type MetricsSeries } from "@landlens/contracts";
import { agentReadOnlyPolicy, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorCluster, type AgentCluster } from "@landlens/kube-mcp";
import { BuiltinUpstream, McpGateway, testRemote, toolInfo, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
import type { SessionMcp } from "@landlens/acp-host";
import { AppViews, viewCsp } from "./app-views";
import type { ClicklandSettingsStore } from "./clickland-settings";
import type { McpServerStore } from "./mcp-store";

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

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

  constructor(private readonly deps: {
    store: McpServerStore;
    clickland: ClicklandSettingsStore;
    frontDoor: FrontDoor;
    clusters: ClusterManager;
    metrics: (handle: string, req: Parameters<NonNullable<AgentCluster["metrics"]>>[0]) => Promise<MetricsSeries>;
    push: (call: McpCall) => void;
    ask: Ask;
    log?: (l: string) => void;
  }) {
    this.gateway = new McpGateway({
      approve: (q) => deps.ask.confirm({
        message: `Let a view run ${q.server} · ${q.tool}?`,
        detail: `${q.tool} doesn't say it only reads, so Landlens asks first. It was asked for by an app view in ${q.label}, with:\n${JSON.stringify(q.args, null, 2).slice(0, 600)}`,
        yes: "Run it once",
      }),
      ...(deps.log ? { log: deps.log } : {}),
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
        const s = await this.gateway.open({ label, context, origin: "agent", cluster, remotes: this.deps.store.remotesFor(context) });
        return { servers: s.servers(), allow: s.allow, bind: (id) => s.bind(id), close: () => s.close() };
      },
    };
  }

  /** The front door's audit trail, for the requests behind each landlens-kube call. */
  onAudit = (e: Parameters<McpGateway["onAudit"]>[0]) => this.gateway.onAudit(e);

  // ---- servers -------------------------------------------------------------------------------------------------

  async servers(context?: string): Promise<McpServers> {
    this.builtinTools ??= new BuiltinUpstream(BUILTIN_MCP_SERVER, stubCluster()).tools().then((t) => t.map(toolInfo));
    const builtin: McpServerInfo = {
      id: BUILTIN_MCP_SERVER, name: BUILTIN_MCP_SERVER, builtin: true, url: this.gateway.url, enabled: true, appOrigins: [],
      tools: (await this.builtinTools) ?? [], status: "ready",
    };
    const remotes = this.deps.store.list(context);
    const c = this.deps.clickland.view();
    const url = clicklandMcpUrl(c.url);
    return {
      gateway: this.gateway.url,
      servers: [builtin, ...remotes],
      canStore: this.deps.store.canStore,
      presets: [{ id: "clickland", name: "Clickland", url, reachable: await reachable(url), hasKey: c.hasKey, added: remotes.some((s) => s.url === url) }],
    };
  }

  save(input: Parameters<McpServerStore["save"]>[0], context?: string): McpServerInfo {
    const s = this.deps.store.save(input);
    return this.deps.store.info(s.id, context);
  }

  /** Initialize and list tools, with the typed header or, for a saved server, the stored one. */
  async test(req: { id?: string; url?: string; header?: { name: string; value?: string } }): Promise<McpTest> {
    let spec: RemoteSpec;
    if (req.id) {
      const saved = this.deps.store.spec(req.id);
      const name = req.header?.name ?? Object.keys(saved.headers ?? {})[0];
      const value = req.header?.value ?? this.deps.store.headerValue(req.id);
      spec = { name: saved.name, url: req.url ?? saved.url, ...(name && value ? { headers: { [name]: value } } : {}) };
    } else {
      if (!req.url) throw fail(400, "Give the server's address.");
      spec = { name: "test", url: req.url, ...(req.header?.value ? { headers: { [req.header.name]: req.header.value } } : {}) };
    }
    const r = await testRemote(spec);
    const tools = r.tools?.map(toolInfo);
    if (req.id) this.deps.store.status(req.id, { status: r.ok ? "ready" : "failed", ...(r.ok ? {} : { detail: r.steps.at(-1)?.detail ?? "failed" }), ...(tools ? { tools } : {}) });
    return { ok: r.ok, steps: r.steps, ...(tools ? { tools } : {}) };
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
          types: async () => types, metrics: (r) => this.deps.metrics(handle, r),
        });
        const session = await this.gateway.open({ label, context: info.context, origin: "you", cluster, remotes: this.deps.store.remotesFor(info.context) });
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
    const res = await this.gateway.appResource(session, call.server, call.app);
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

  /** ui/open-link: https only, after you've seen the host and said yes. */
  async viewLink(viewId: string, raw: string): Promise<boolean> {
    const v = this.views.get(viewId);
    if (!v) throw fail(404, "That view has closed.");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw fail(400, "not a link");
    }
    if (u.protocol !== "https:" || u.username || u.password) throw fail(400, "Views may open https links only.");
    const yes = await this.deps.ask.confirm({
      message: `Open ${u.host} in your browser?`,
      detail: `The ${v.server} view (${v.tool}) wants to open:\n${u.href.slice(0, 500)}`,
      yes: "Open",
    });
    if (yes) await this.deps.ask.openExternal(u.href);
    return yes;
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
