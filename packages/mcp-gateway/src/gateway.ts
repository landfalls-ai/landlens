// The MCP gateway: the one MCP endpoint an agent session has. It runs in main on loopback, serves Landlens's own
// cluster tools at /mcp and, per session, the remote MCP servers you turned on for that cluster at /mcp/<name>,
// under their own names. Every call, whoever makes it (the agent, an app's view, you on the MCP page), goes through
// run(): checked against the tool's visibility and approval rules, logged, and paired with the dock's tool card.
//
// Only local MCP clients get in: no browser (an Origin header), no other host name (DNS rebinding), and one bearer
// token per session, kept hashed. Stateless: every POST builds a fresh MCP server for the caller's session, so
// nothing one session does reaches another's.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BUILTIN_MCP_SERVER, type McpCall, type McpToolResult } from "@landlens/contracts";
import type { AuditEntry } from "@landlens/kube";
import { APP_HTML, CALL_META, type AgentCluster } from "@landlens/kube-mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { appMayCall, isReadOnly, modelMayCall, preAllowed, toolUi } from "./approval.js";
import { CallLog, newCallId } from "./calls.js";
import { Pairing, TOOL_USE_META } from "./pairing.js";
import { BuiltinUpstream, describeError, RemoteUpstream, type RemoteSpec, type Upstream } from "./upstream.js";

const MAX_BODY = 1_000_000;
export const APP_MIME = "text/html;profile=mcp-app";
/** The most HTML Landlens will load for one view. */
export const MAX_APP_HTML = 5_000_000;
const MAX_CACHED_APPS = 20;

const hash = (t: string) => createHash("sha256").update(t).digest();

export type Origin = McpCall["origin"];

/** What a view's resource declares: its CSP domains, border preference and permissions (MCP Apps `_meta.ui`). */
export type AppResource = {
  html: string;
  csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] };
  prefersBorder?: boolean;
};

export type SessionInit = {
  /** "agent 3 · orbstack", "you · orbstack". */
  label: string;
  context: string;
  origin: "agent" | "you";
  /** The session's cluster, through the front door with its own token. */
  cluster: AgentCluster;
  /** The remote servers turned on for this cluster, with their headers. */
  remotes: RemoteSpec[];
};

/** Asked before an app's view (or you) runs a tool that doesn't say it only reads. */
export type Approver = (q: { label: string; server: string; tool: string; args: Record<string, unknown>; origin: Origin }) => Promise<boolean>;

export class GatewaySession {
  /** The ACP session id, once Claude Code made it; "console" for yours. */
  acpSession: string | undefined;
  closed = false;
  readonly upstreams = new Map<string, Upstream>();
  /** Permission rules Claude Code gets: what runs without asking. */
  allow: string[] = [];

  constructor(readonly gateway: McpGateway, readonly token: string, readonly init: SessionInit) {
    this.upstreams.set(BUILTIN_MCP_SERVER, new BuiltinUpstream(BUILTIN_MCP_SERVER, init.cluster));
    for (const r of init.remotes) this.upstreams.set(r.name, new RemoteUpstream(r));
    if (init.origin === "you") this.acpSession = "console";
  }

  get label() { return this.init.label; }
  get id() { return this.acpSession ?? this.label; }

  /** The MCP servers to give Claude Code: every one on the gateway, each with this session's token. */
  servers(): { name: string; url: string; headers: { name: string; value: string }[] }[] {
    return [...this.upstreams.keys()].map((name) => ({
      name,
      url: this.gateway.urlFor(name),
      headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
    }));
  }

  bind(acpSession: string) {
    this.acpSession = acpSession;
  }

  /** Call a tool as an app's view or as you; the agent's calls come in over HTTP. */
  call(server: string, tool: string, args: Record<string, unknown>, origin: "app" | "you", onCall?: (id: string) => void): Promise<CallToolResult> {
    return this.gateway.run(this, server, tool, args, origin, onCall ? { onCall } : {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.gateway.drop(this);
    await Promise.all([...this.upstreams.values()].map((u) => u.close()));
  }
}

export class McpGateway {
  readonly log = new CallLog();
  readonly pairing = new Pairing((call, card) => this.log.pair(call, card));
  private server: HttpServer | undefined;
  private port = 0;
  private readonly sessions = new Map<string, GatewaySession>(); // sha256(token) hex → session
  private readonly apps = new Map<string, AppResource>();
  private readonly toolsOf = new Map<string, Tool>(); // `${server}\0${tool}` → last listing, for the log's app field

  constructor(private readonly opts: { approve?: Approver; log?: (line: string) => void } = {}) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch((err) => {
      this.opts.log?.(`[mcp] ${describeError(err)}`);
      if (!res.headersSent) deny(res, 500, "internal error");
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  urlFor(server: string): string {
    return server === BUILTIN_MCP_SERVER ? this.url : `${this.url}/${server}`;
  }

  /**
   * Open a session: its token, its upstreams, and the permission rules for Claude Code. Remote servers are listed
   * now so their read-only tools can run without asking; one that doesn't answer is still served, with every tool
   * asking.
   */
  async open(init: SessionInit): Promise<GatewaySession> {
    for (const r of init.remotes) if (r.name === BUILTIN_MCP_SERVER || !/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(r.name)) throw new Error(`Landlens: bad MCP server name ${r.name}`);
    const token = randomBytes(32).toString("hex");
    const session = new GatewaySession(this, token, init);
    this.sessions.set(hash(token).toString("hex"), session);
    const listed = await Promise.all([...session.upstreams.values()].map(async (u) => {
      try {
        return { name: u.name, tools: await this.listTools(u) };
      } catch (err) {
        this.opts.log?.(`[mcp] ${init.label}: ${u.name} didn't list its tools: ${describeError(err)}`);
        return { name: u.name, tools: [] };
      }
    }));
    session.allow = preAllowed(listed);
    return session;
  }

  /** Called by GatewaySession.close(). */
  drop(s: GatewaySession) {
    this.sessions.delete(hash(s.token).toString("hex"));
    if (s.acpSession) this.pairing.forget(s.acpSession);
  }

  /** The front door's audit trail: requests made for a gateway call are added to it. */
  onAudit(e: AuditEntry) {
    if (!e.call) return;
    this.log.request(e.call, { at: e.at, method: e.method, path: e.path, allowed: e.allowed, ...(e.status !== undefined ? { status: e.status } : {}), ...(e.reason ? { reason: e.reason } : {}) });
  }

  /** The dock saw an ACP tool call: pair it with its gateway call. */
  card(u: { session: string; toolCallId: string; toolName?: string; title?: string; rawInput?: unknown }) {
    this.pairing.card(u);
  }

  async listTools(u: Upstream): Promise<Tool[]> {
    const tools = await u.tools();
    for (const t of tools) this.toolsOf.set(`${u.name}\0${t.name}`, t);
    return tools;
  }

  /** A tool as last listed (for the MCP page and app views). */
  tool(server: string, name: string): Tool | undefined {
    return this.toolsOf.get(`${server}\0${name}`);
  }

  /**
   * Every call goes through here. Refused before it reaches the server: a tool the caller may not see (an app-only
   * tool for the agent, a model-only tool for a view), and a tool that doesn't say it only reads when called by a
   * view without your yes, or by you from the MCP page at all.
   */
  async run(s: GatewaySession, server: string, tool: string, args: Record<string, unknown>, origin: Origin, extra: { toolUseId?: string; onCall?: (id: string) => void } = {}): Promise<CallToolResult> {
    const id = newCallId();
    this.log.start({ id, session: s.id, label: s.label, server, tool, origin, args });
    extra.onCall?.(id);
    const toolUseId = extra.toolUseId;
    const refuse = (why: string): CallToolResult => {
      this.log.finish(id, { status: "refused", error: why });
      return { content: [{ type: "text", text: `Landlens: ${why}` }], isError: true };
    };
    if (s.closed) return refuse("this session has ended.");
    const up = s.upstreams.get(server);
    if (!up) return refuse(`no MCP server named ${server} in this session.`);
    let t: Tool | undefined;
    try {
      t = (await this.listTools(up)).find((x) => x.name === tool);
    } catch (err) {
      this.log.finish(id, { status: "error", error: describeError(err) });
      return { content: [{ type: "text", text: `Landlens: ${server} didn't answer: ${describeError(err)}` }], isError: true };
    }
    if (!t) return refuse(`${server} has no tool named ${tool}.`);
    if (origin === "agent") {
      if (!modelMayCall(t)) return refuse(`${tool} is for its app's view only.`);
      this.pairing.call({ id, session: s.id, server, tool, args, ...(toolUseId ? { toolUseId } : {}) });
    } else if (origin === "app") {
      if (!appMayCall(t)) return refuse(`${tool} isn't offered to app views.`);
      if (!isReadOnly(t)) {
        const yes = this.opts.approve ? await this.opts.approve({ label: s.label, server, tool, args, origin }).catch(() => false) : false;
        if (!yes) return refuse(`you didn't allow ${server} · ${tool}.`);
      }
    } else if (!isReadOnly(t)) {
      return refuse(`${tool} doesn't say it only reads, so Landlens won't run it from the MCP page.`);
    }

    const app = toolUi(t).resourceUri;
    try {
      const result = await up.call(tool, args, server === BUILTIN_MCP_SERVER ? { [CALL_META]: id } : undefined);
      const status = result.isError ? "error" : "ok";
      if (app && !result.isError) {
        this.log.keepResult(id, { args, result: result as McpToolResult });
        void this.appResource(s, server, app).catch(() => {}); // warm the view's HTML
      }
      this.log.finish(id, { status, result: result as McpToolResult, ...(app && !result.isError ? { app } : {}) });
      return origin === "agent" ? forModel(result, t) : result;
    } catch (err) {
      const why = describeError(err);
      this.log.finish(id, { status: "error", error: why });
      return { content: [{ type: "text", text: `Landlens: ${server} · ${tool} failed: ${why}` }], isError: true };
    }
  }

  /**
   * A view's HTML and what it declares. landlens-kube's are part of Landlens; a remote server's is read through the
   * session (or from the last read, if the session has ended) and must be an MCP App document of at most 5 MB.
   */
  async appResource(s: GatewaySession | undefined, server: string, uri: string): Promise<AppResource> {
    if (server === BUILTIN_MCP_SERVER) {
      const html = APP_HTML[uri];
      if (!html) throw new Error(`Landlens: no view ${uri}`);
      return { html, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false };
    }
    const up = s && !s.closed ? s.upstreams.get(server) : undefined;
    const key = `${server}\0${up ? (s!.init.remotes.find((r) => r.name === server)?.url ?? "") : ""}\0${uri}`;
    const cached = [...this.apps.entries()].find(([k]) => k.startsWith(`${server}\0`) && k.endsWith(`\0${uri}`))?.[1];
    if (!up) {
      if (cached) return cached;
      throw new Error("Landlens: the session that made this call has ended.");
    }
    const hit = this.apps.get(key);
    if (hit) return hit;
    const r = await up.read(uri);
    const c = r.contents.find((x) => x.uri === uri) ?? r.contents[0];
    if (!c || !("text" in c) || typeof c.text !== "string") throw new Error(`Landlens: ${server} sent no HTML for ${uri}.`);
    if ((c.mimeType ?? "").replace(/\s+/g, "").toLowerCase() !== APP_MIME) throw new Error(`Landlens: ${uri} isn't an MCP App view (${c.mimeType ?? "no type"}).`);
    if (c.text.length > MAX_APP_HTML) throw new Error(`Landlens: ${uri} is larger than 5 MB.`);
    const ui = ((c._meta as Record<string, unknown> | undefined)?.ui ?? {}) as { csp?: Record<string, unknown>; prefersBorder?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : []);
    const res: AppResource = {
      html: c.text,
      csp: {
        connectDomains: list(ui.csp?.connectDomains),
        resourceDomains: list(ui.csp?.resourceDomains),
        frameDomains: list(ui.csp?.frameDomains),
        baseUriDomains: list(ui.csp?.baseUriDomains),
      },
      ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
    };
    this.apps.set(key, res);
    while (this.apps.size > MAX_CACHED_APPS) this.apps.delete(this.apps.keys().next().value!);
    return res;
  }

  /** The session that made a call, if it's still open. */
  sessionOf(callId: string): GatewaySession | undefined {
    const c = this.log.get(callId);
    if (!c) return undefined;
    return [...this.sessions.values()].find((s) => s.id === c.session && s.label === c.label);
  }

  private sessionFor(header: string | undefined): GatewaySession | undefined {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "");
    if (!m) return undefined;
    const h = hash(m[1]!);
    for (const [k, s] of this.sessions) if (timingSafeEqual(Buffer.from(k, "hex"), h)) return s;
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    // Only local MCP clients: no browser (an Origin header) and no other host name (DNS rebinding).
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}`) return deny(res, 403, "forbidden");
    const m = /^\/mcp(?:\/([a-z][a-z0-9-]{0,30}[a-z0-9]))?$/.exec((req.url ?? "").split("?")[0]!);
    if (!m) return deny(res, 404, "not found");
    const session = this.sessionFor(req.headers.authorization);
    if (!session || session.init.origin !== "agent") return deny(res, 401, "missing or unknown Landlens session token");
    const name = m[1] ?? BUILTIN_MCP_SERVER;
    if (m[1] === BUILTIN_MCP_SERVER) return deny(res, 404, "not found");
    const up = session.upstreams.get(name);
    if (!up) return deny(res, 404, `no MCP server named ${name} in this session`);
    if (req.method !== "POST") return deny(res, 405, "stateless server: POST only");

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return deny(res, 400, "bad JSON or too large");
    }

    const mcp = new Server({ name, version: "0.2.0" }, { capabilities: { tools: { listChanged: false } } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        return { tools: (await this.listTools(up)).filter(modelMayCall) };
      } catch (err) {
        this.opts.log?.(`[mcp] ${session.label}: ${name} didn't list its tools: ${describeError(err)}`);
        return { tools: [] };
      }
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      const toolUseId = r.params._meta?.[TOOL_USE_META];
      return this.run(session, name, r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>, "agent", typeof toolUseId === "string" ? { toolUseId } : {});
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

/**
 * What the model gets back: the text, as the server wrote it. A view's structured data (MCP Apps: "for the UI, not
 * the model") is dropped when there's text beside it and the tool doesn't promise an output schema.
 */
export function forModel(r: CallToolResult, t: Tool): CallToolResult {
  if (!toolUi(t).resourceUri || t.outputSchema || !r.structuredContent || !r.content?.length) return r;
  const { structuredContent: _drop, ...rest } = r;
  return rest;
}

function deny(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `Landlens: ${message}` }, id: null }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
