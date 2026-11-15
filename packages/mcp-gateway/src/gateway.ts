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
import { BUILTIN_MCP_SERVER, GCP_MCP_SERVER, type AnyProvider, type AutonomyOff, type AutonomyScope, type AutonomyState, type ConnProvider, type McpCall, type McpToolResult } from "@landlens/contracts";
import type { AuditEntry } from "@landlens/kube";
import { APP_HTML, CALL_META, type AgentCluster } from "@landlens/kube-mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { appMayCall, drifted, holds, listingHash, modelMayCall, preAllowed, readsOnly, toolDigest, toolUi, type ListedServer } from "./approval.js";
import { Autonomy, WHY } from "./autonomy.js";
import { CallLog, newCallId } from "./calls.js";
import { Pairing, TOOL_USE_META } from "./pairing.js";
import { familyHeld, familyReadTools, isSibling, providerResult, providerTool, schemaTooLarge, type ProviderRules } from "./providers/index.js";
import type { Sibling } from "@landlens/contracts";
import { BuiltinUpstream, describeError, rawError, RemoteUpstream, type RemoteSpec, type Upstream } from "./upstream.js";

const MAX_BODY = 1_000_000;
export const APP_MIME = "text/html;profile=mcp-app";
/** The most HTML Landlens will load for one view. */
export const MAX_APP_HTML = 5_000_000;
const MAX_CACHED_APPS = 20;

const hash = (t: string) => createHash("sha256").update(t).digest();

export type Origin = McpCall["origin"];

/**
 * Landlens's own servers, in memory: landlens-kube at /mcp (every session) and landlens-gcp at /mcp/landlens-gcp (only
 * when the person lets Claude read their Google Cloud projects). Allowed whole, like landlens-kube: their tools only
 * read, and run in main under Landlens's own limits. No remote server may take one of these names.
 */
export const BUILTIN_SERVERS: ReadonlySet<string> = new Set([BUILTIN_MCP_SERVER, GCP_MCP_SERVER]);
export const isBuiltin = (name: string) => BUILTIN_SERVERS.has(name);
/** The refusal of a call made while Claude drafts the brain's summary (L4). */
export const DRAFTING = "no tool runs while Claude drafts the brain's summary.";
/** A built-in other than landlens-kube, for one session. */
export type BuiltinSpec = { name: typeof GCP_MCP_SERVER; server: () => McpServer };

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
  /** Built-ins beside landlens-kube (landlens-gcp), when the person turned them on. */
  builtins?: BuiltinSpec[];
};

/** Asked before an app's view (or you) runs a tool that doesn't say it only reads. */
export type Approver = (q: { label: string; server: string; tool: string; args: Record<string, unknown>; origin: Origin }) => Promise<boolean>;

/** The most permission answers and card names a session or the gateway remembers. */
const MAX_PERMITS = 200;
const MAX_CARD_NAMES = 2000;

/** Why a connection's autonomous mode can't be turned on in a session (the dock shows it in the sheet). */
export const AUTONOMY_UNACCEPTED = "Its tools aren't accepted yet. Look at them on the Connections page, then start a new session.";
export const AUTONOMY_DRIFT = "Its tools changed since you accepted them. Review them on the Connections page, then start a new session.";
export const AUTONOMY_UNLISTED = "Its tools didn't list when this session opened. Start a new session.";

export class GatewaySession {
  /** The ACP session id, once Claude Code made it; "console" for yours. */
  acpSession: string | undefined;
  closed = false;
  readonly upstreams = new Map<string, Upstream>();
  /** A connection's read-only endpoint, where its reads go at Ask for writes (M1). */
  readonly readUpstreams = new Map<string, Upstream>();
  /** Permission rules Claude Code gets: what runs without asking. */
  allow: string[] = [];
  /**
   * A yes to one tool call (its ACP toolCallId → `mcp__<server>__<tool>`, if known): yours in the dock, or main's for
   * a routine write in an autonomous session, which run() checks again on the arguments that arrive.
   */
  private readonly once = new Map<string, { rule: string | undefined; autonomous: boolean }>();
  /** Each connection's autonomous mode in this session (agent sessions only); off until you turn it on. */
  readonly autonomy = new Map<ConnProvider, Autonomy>();
  /** Tools you said "don't ask again" for in this session. */
  private readonly always = new Set<string>();
  /**
   * The family siblings whose reads may skip the question in this session: the listing it got is the accepted one and
   * Reads run without asking is on (review of wave 7 part 2, M5). A sibling not here has every tool treated as a write:
   * a view's call asks, and the dock offers no "always allow". Leaves when the sibling's reads stop (restrict).
   */
  readonly readsFree = new Set<string>();
  /**
   * Each family sibling's tools the model is offered in this session: those whose digest is the accepted one (L3). A
   * sibling that didn't list when the session opened offers none.
   */
  readonly offered = new Map<string, ReadonlySet<string>>();
  /**
   * Each server's tools as the person accepted them (security review of wave 7 part 5, L8): Landlens's own servers as
   * listed; a connection's while its listing is the pinned one; a family sibling's as offered. Only these names are
   * Landlens's to report (telemetry); any other is the agent's or the server's word.
   */
  readonly accepted = new Map<string, ReadonlySet<string>>();
  /** "Ask Claude to draft" is running in this session: every call of the agent's is refused (L4). */
  drafting = false;

  constructor(readonly gateway: McpGateway, readonly token: string, readonly init: SessionInit) {
    this.upstreams.set(BUILTIN_MCP_SERVER, new BuiltinUpstream(BUILTIN_MCP_SERVER, init.cluster));
    for (const b of init.builtins ?? []) if (b.name === GCP_MCP_SERVER) this.upstreams.set(b.name, new BuiltinUpstream(b.name, b.server));
    for (const r of init.remotes) {
      this.upstreams.set(r.name, new RemoteUpstream(r));
      if (r.provider && r.readUrl && r.readUrl !== r.url) this.readUpstreams.set(r.name, new RemoteUpstream({ ...r, url: r.readUrl }));
    }
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

  /** You allowed a tool call in the dock (Claude Code's permission request, answered through main). */
  permit(toolCallId: string, rule: string | undefined, always: boolean, autonomous = false) {
    if (always && rule && !autonomous) this.always.add(rule);
    else {
      this.once.set(toolCallId, { rule, autonomous });
      while (this.once.size > MAX_PERMITS) this.once.delete(this.once.keys().next().value!);
    }
  }

  /**
   * Whether you allowed this call: a "don't ask again" for the tool, or a yes to this very tool call (by its tool_use
   * id; if Claude Code stopped sending that, the oldest unused yes for the same tool, but only while every unused yes
   * for it is of one kind: L4 of the part 3 review, so a call that main let run on its own can't take your yes for
   * another call and run uncounted, nor the other way). A yes is used up by its call.
   */
  takePermit(rule: string, toolUseId: string | undefined): boolean {
    return !!this.takePermitKind(rule, toolUseId);
  }

  /** As takePermit, saying whose yes it was: yours ("asked") or main's for an autonomous routine write. */
  takePermitKind(rule: string, toolUseId: string | undefined): "asked" | "autonomous" | undefined {
    if (this.always.has(rule)) return "asked";
    const kind = (p: { autonomous: boolean }) => (p.autonomous ? "autonomous" as const : "asked" as const);
    if (toolUseId) {
      const p = this.once.get(toolUseId);
      if (!p) return undefined;
      if (p.rule !== undefined && p.rule !== rule) return undefined;
      this.once.delete(toolUseId);
      return kind(p);
    }
    const same = [...this.once].filter(([, p]) => p.rule === rule);
    if (!same.length || same.some(([, p]) => p.autonomous !== same[0]![1].autonomous)) return undefined;
    this.once.delete(same[0]![0]);
    return kind(same[0]![1]);
  }

  /** A server's rules and every yes for its tools leave the session: they run only after a new yes. */
  private forgetRules(server: string) {
    const prefix = `mcp__${server}__`;
    this.allow = this.allow.filter((a) => !a.startsWith(prefix));
    for (const a of [...this.always]) if (a.startsWith(prefix)) this.always.delete(a);
    for (const [id, p] of [...this.once]) if (p.rule === undefined || p.rule.startsWith(prefix)) this.once.delete(id);
  }

  /**
   * A connection changed under an open session (M2). `drop`: it was disconnected, taken from sessions or set to
   * Read only, so its server leaves the session (a call to it is refused). `reads`: its reads stop running without
   * asking. Either way every standing yes for its tools goes.
   */
  restrict(server: string, what: "drop" | "reads") {
    this.forgetRules(server);
    this.readsFree.delete(server);
    if (what !== "drop") return;
    const provider = this.init.remotes.find((r) => r.name === server)?.provider;
    if (provider && !isSibling(provider.id)) this.autonomy.get(provider.id)?.stop("you");
    for (const m of [this.upstreams, this.readUpstreams]) {
      const u = m.get(server);
      m.delete(server);
      void u?.close().catch(() => {});
    }
  }

  /**
   * A built-in other than landlens-kube leaves the session (the person turned "Claude can read these projects" off, or
   * gcloud signed out): its rule goes, and a call to it is refused.
   */
  dropBuiltin(name: string) {
    if (name === BUILTIN_MCP_SERVER || !this.upstreams.has(name)) return;
    this.allow = this.allow.filter((a) => a !== `mcp__${name}`);
    const u = this.upstreams.get(name);
    this.upstreams.delete(name);
    void u?.close().catch(() => {});
  }

  /** Call a tool as an app's view or as you; the agent's calls come in over HTTP. */
  call(server: string, tool: string, args: Record<string, unknown>, origin: "app" | "you", onCall?: (id: string) => void): Promise<CallToolResult> {
    return this.gateway.run(this, server, tool, args, origin, onCall ? { onCall } : {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const a of this.autonomy.values()) a.stop("session");
    this.gateway.drop(this);
    await Promise.all([...this.upstreams.values(), ...this.readUpstreams.values()].map((u) => u.close()));
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
  /** ACP toolCallId → the tool's name (`mcp__<server>__<tool>`), from the dock's cards, for permission answers. */
  private readonly cardNames = new Map<string, string>();

  constructor(private readonly opts: {
    approve?: Approver;
    log?: (line: string) => void;
    /**
     * A remote server's listing changed since you let its read-only tools run without asking: they ask again. `listing`
     * is the hash of the listing the session got.
     */
    onDrift?: (server: RemoteSpec, listing: string) => void;
    /** A connection's autonomous mode changed in a session (turned on or off, a write counted). */
    onAutonomy?: (s: AutonomyState) => void;
    /** The clock autonomy's per-minute limit reads (tests). */
    now?: () => number;
  } = {}) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch((err) => {
      this.opts.log?.(`[mcp] ${rawError(err)}`);
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
   * now; the read-only tools of one you opted in run without asking only if this listing is the one you pinned, and
   * the session keeps this listing for its life. One that doesn't answer is still served, with every tool asking.
   */
  async open(init: SessionInit): Promise<GatewaySession> {
    for (const r of init.remotes) if (isBuiltin(r.name) || r.name.startsWith("landlens") || !/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(r.name)) throw new Error(`Landlens: bad MCP server name ${r.name}`);
    const token = randomBytes(32).toString("hex");
    const session = new GatewaySession(this, token, init);
    this.sessions.set(hash(token).toString("hex"), session);
    const listed = await Promise.all([...session.upstreams.values()].map(async (u): Promise<ListedServer | undefined> => {
      const spec = init.remotes.find((r) => r.name === u.name);
      try {
        return { name: u.name, tools: await this.listTools(u), ...(spec?.pin ? { pin: spec.pin } : {}), ...(spec?.provider ? { provider: spec.provider } : {}) };
      } catch (err) {
        this.opts.log?.(`[mcp] ${init.label}: ${u.name} didn't list its tools: ${rawError(err)}`);
        return undefined; // nothing runs without asking, and nothing is said to have changed
      }
    }));
    const answered = listed.filter((l): l is ListedServer => !!l);
    // A family sibling's reads, from the listing this session got (D110): Landlens's list and the server's hints of
    // that listing, so what main listed earlier can't make a tool a read here. One that didn't list has none.
    for (const r of init.remotes) {
      if (!r.provider || !isSibling(r.provider.id)) continue;
      const l = answered.find((x) => x.name === r.name);
      r.provider = { ...r.provider, readTools: familyReadTools(r.provider.id, l?.tools) };
      if (!l) continue;
      l.provider = r.provider;
      // Its reads skip the question only while this listing is the accepted one and the switch is on (M5).
      if (holds(l) && r.provider.readsAuto) session.readsFree.add(r.name);
      // The model is offered only the tools the person accepted, as accepted (L3): all of them while the listing holds;
      // else those whose digest is unchanged. A new or changed tool waits for Accept.
      const digest = toolDigest(l.tools);
      const pinned = r.pinTools;
      session.offered.set(r.name, new Set(l.tools.filter((t) => holds(l) || (!!pinned && Object.hasOwn(pinned, t.name) && pinned[t.name] === digest[t.name])).map((t) => t.name)));
    }
    // A connection's read-only endpoint is pinned too: its reads run without asking only while both halves hold.
    for (const l of answered) {
      const ro = session.readUpstreams.get(l.name);
      const spec = init.remotes.find((r) => r.name === l.name);
      if (!ro || !spec) continue;
      l.readPin = spec.readPin;
      l.readListing = await this.listTools(ro, false).catch((err) => {
        this.opts.log?.(`[mcp] ${init.label}: ${l.name}'s read-only endpoint didn't list its tools: ${rawError(err)}`);
        return undefined;
      });
    }
    // What telemetry may name (L8): Landlens's own tools, a sibling's offered ones, a pinned listing's while it holds.
    for (const l of answered) {
      const offered = session.offered.get(l.name);
      if (isBuiltin(l.name)) session.accepted.set(l.name, new Set(l.tools.map((t) => t.name)));
      else if (offered) session.accepted.set(l.name, offered);
      else if (l.pin && listingHash(l.tools) === l.pin) session.accepted.set(l.name, new Set(l.tools.map((t) => t.name)));
    }
    // Landlens's own servers are allowed whole: landlens-kube always, landlens-gcp when the session has it.
    session.allow = [...preAllowed(answered), ...[...session.upstreams.keys()].filter((n) => isBuiltin(n) && n !== BUILTIN_MCP_SERVER).map((n) => `mcp__${n}`)];
    const changed = drifted(answered);
    for (const name of changed) {
      this.opts.log?.(`[mcp] ${init.label}: ${name}'s tools changed since you allowed its read-only tools; they ask again`);
      const spec = init.remotes.find((r) => r.name === name);
      const l = answered.find((x) => x.name === name)!;
      if (spec) this.opts.onDrift?.(spec, listingHash(l.tools));
    }
    // A connection's autonomous mode, off; it can be turned on only while the session's listing is the accepted one
    // (D80, D82). Views and Preview have none.
    // A family sibling has none (D113): its writes always ask.
    if (init.origin === "agent") {
      for (const r of init.remotes) {
        if (!r.provider || isSibling(r.provider.id)) continue;
        const listedOk = answered.some((l) => l.name === r.name);
        const blocked = !r.pin ? AUTONOMY_UNACCEPTED : changed.includes(r.name) ? AUTONOMY_DRIFT : !listedOk ? AUTONOMY_UNLISTED : undefined;
        const id = r.provider.id;
        session.autonomy.set(id, new Autonomy(id, {
          session: () => session.id, mode: r.provider.mode, ...(blocked ? { blocked } : {}),
          ...(this.opts.now ? { now: this.opts.now } : {}),
          changed: (st) => this.opts.onAutonomy?.(st),
        }));
      }
    }
    return session;
  }

  /** An agent session by Claude Code's id for it. */
  private agentSession(acpSession: string): GatewaySession | undefined {
    return [...this.sessions.values()].find((x) => x.init.origin === "agent" && x.acpSession === acpSession && !x.closed);
  }

  /**
   * Whether a call's tool is one its server listed as the person accepted it, in the gateway session the call log names
   * (`McpCall.session`): what telemetry may report by name (L8).
   */
  knownTool(session: string, server: string, tool: string): boolean {
    const s = [...this.sessions.values()].find((x) => x.id === session);
    return !!s?.accepted.get(server)?.has(tool);
  }

  /** "Ask Claude to draft" starts or ends in an agent session: while on, the agent's calls are refused (L4). */
  drafting(acpSession: string, on: boolean) {
    const s = this.agentSession(acpSession);
    if (s) s.drafting = on;
  }

  /** Each connection's autonomous mode in a session. */
  autonomyStates(acpSession: string): AutonomyState[] {
    return [...(this.agentSession(acpSession)?.autonomy.values() ?? [])].map((a) => a.state());
  }

  /**
   * Turn a connection's autonomous mode on, with its scope, or off (Stop), in one session (agent:autonomy). Turning it
   * on needs the connection in the session at Ask for writes, with the accepted listing; main checks the connection
   * itself is still ready.
   */
  setAutonomy(acpSession: string, provider: ConnProvider, on: boolean, scope?: AutonomyScope): AutonomyState {
    const s = this.agentSession(acpSession);
    const a = s?.autonomy.get(provider);
    if (!s || !a) throw Object.assign(new Error("That session has no such connection."), { status: 404 });
    const spec = s.init.remotes.find((r) => r.provider?.id === provider);
    if (on && (!spec || !s.upstreams.has(spec.name))) throw Object.assign(new Error("That connection has left this session."), { status: 409 });
    if (on) a.turnOn(scope!);
    else a.stop("you");
    return a.state();
  }

  /** A connection changed (Disconnect, Read only, its tools changed): its autonomous mode ends in every session. */
  stopAutonomy(provider: ConnProvider, because: AutonomyOff) {
    for (const s of this.sessions.values()) s.autonomy.get(provider)?.stop(because);
  }

  /**
   * Main asks before answering Claude Code's question itself (D82): whether this tool call, with the input Claude Code
   * showed, may run on its own. Only a connection's write in a session where its autonomous mode is on, a routine
   * write in scope within the budget, passes. A failure on the rules counts toward the three in a row that turn it
   * off. Nothing is counted on a pass: run() checks the arguments that arrive and counts then.
   */
  async autonomyCheck(acpSession: string, toolName: string, input: unknown): Promise<{ ok: boolean; why?: string; provider?: AnyProvider; write?: boolean }> {
    const m = /^mcp__([a-z][a-z0-9-]{0,30}[a-z0-9])__([A-Za-z0-9_.-]{1,128})$/.exec(toolName);
    const s = this.agentSession(acpSession);
    if (!m || !s || isBuiltin(m[1]!)) return { ok: false };
    const spec = s.init.remotes.find((r) => r.name === m[1]);
    const up = spec?.provider ? s.upstreams.get(spec.name) : undefined;
    if (!spec?.provider || !up) return { ok: false };
    const provider = spec.provider.id;
    // A family sibling has no autonomous mode (D113): its writes go to the dock, marked as its.
    const a = isSibling(provider) ? undefined : s.autonomy.get(provider);
    // A provider's write is never offered "always allow" (M1), autonomous or not: `write` tells main so. A sibling's
    // read counts as one only while the session's listing is the accepted one and its reads run without asking (M5).
    if (this.freeRead(s, spec.name, m[2]!, spec.provider)) return { ok: false, provider };
    if (!a?.on) return { ok: false, provider, write: true };
    const t = await this.listTools(up).then((ts) => ts.find((x) => x.name === m[2]), () => undefined);
    if (!t) return { ok: false, provider, write: true, why: "not one of the routine writes" };
    const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const r = a.check(providerTool(t), args);
    if (!r) return { ok: true, provider, write: true };
    if (r.rules) a.refused();
    return { ok: false, provider, write: true, why: r.why };
  }

  /** A built-in (landlens-gcp) leaves every open session, at once. */
  dropBuiltin(name: string) {
    for (const s of this.sessions.values()) s.dropBuiltin(name);
  }

  /**
   * The person quoted a Google Cloud resource into this session (main saw its brief in the prompt): from now on its
   * writes ask, as after a landlens-gcp read (review of wave 6 part 5, W1).
   */
  gcpQuoted(acpSession: string) {
    this.hold(acpSession, WHY.gcp);
  }

  /**
   * A sibling's text entered this session another way than its tools (the workbench's quotes in parts 3 and 4): its
   * GitHub and Linear writes ask from now on, as after a call to the sibling (review of wave 7 part 2, L8).
   */
  familyQuoted(acpSession: string, sibling: Sibling) {
    this.hold(acpSession, familyHeld(sibling));
  }

  /**
   * Every autonomy of one agent session asks from now on, with `why`: text it read could steer a write. Main calls it
   * for a resumed session, whose transcript the gateway never saw (review of wave 7 part 2, M1).
   */
  hold(acpSession: string, why: string) {
    const s = this.agentSession(acpSession);
    if (s) for (const a of s.autonomy.values()) a.hold(why);
  }

  /**
   * Whether a tool of a connection's or sibling's server is a read that may skip the question: by the provider's reads;
   * for a sibling, also only while the session's listing is the accepted one and Reads run without asking is on (M5).
   */
  private freeRead(s: GatewaySession, server: string, tool: string, provider: ProviderRules): boolean {
    return provider.readTools.has(tool) && (!isSibling(provider.id) || s.readsFree.has(server));
  }

  /**
   * Whether the model and views may use a provider's tool in this session (L3): its schema isn't too large, and a
   * sibling's is one the person accepted, as accepted.
   */
  private offers(s: GatewaySession, server: string, t: Tool, provider: ProviderRules): boolean {
    if (schemaTooLarge(t)) return false;
    return !isSibling(provider.id) || !!s.offered.get(server)?.has(t.name);
  }

  /** Called by GatewaySession.close(). */
  drop(s: GatewaySession) {
    this.sessions.delete(hash(s.token).toString("hex"));
    if (s.acpSession) this.pairing.forget(s.acpSession);
  }

  /**
   * The front door's audit trail: requests made for a gateway call are added to it. Any holder of a front-door token
   * can send X-Landlens-Call (the agent's shell has its session's token), so a request is filed under a call only if
   * that call is a landlens-kube call still running, and the request came with the same session's token (the audit
   * label of a session's front-door token is the session's label). Call ids are random, so they can't be guessed.
   */
  onAudit(e: AuditEntry) {
    if (!e.call) return;
    const c = this.log.get(e.call);
    if (!c || c.server !== BUILTIN_MCP_SERVER || c.status !== "running" || c.label !== e.label) return;
    this.log.request(e.call, { at: e.at, method: e.method, path: e.path, allowed: e.allowed, ...(e.status !== undefined ? { status: e.status } : {}), ...(e.reason ? { reason: e.reason } : {}) });
  }

  /** The dock saw an ACP tool call: pair it with its gateway call. */
  card(u: { session: string; toolCallId: string; toolName?: string; title?: string; rawInput?: unknown }) {
    if (u.toolName) {
      this.cardNames.set(u.toolCallId, u.toolName);
      while (this.cardNames.size > MAX_CARD_NAMES) this.cardNames.delete(this.cardNames.keys().next().value!);
    }
    this.pairing.card(u);
  }

  /**
   * You answered Claude Code's permission request in the dock with a yes. The gateway lets a proxied tool that isn't
   * pre-allowed run only after such a yes, so a Claude Code that skipped the ask still can't run it.
   */
  permit(acpSession: string, p: { toolCallId: string; toolName?: string; always: boolean; autonomous?: boolean }) {
    const s = [...this.sessions.values()].find((x) => x.init.origin === "agent" && x.acpSession === acpSession);
    const name = p.toolName ?? this.cardNames.get(p.toolCallId);
    // Main's yes for an autonomous write names its tool: it never stands in for another.
    if (p.autonomous && !name) return;
    // "Always allow" never covers a connection's write (M1): it would run every later call of that tool anywhere,
    // uncounted, past the autonomous limits. It counts as this one call's yes. A write with no name can't be told
    // from a read, so its "always" is this call's yes too.
    const m = name ? /^mcp__([a-z0-9-]+)__(.+)$/.exec(name) : null;
    const prov = m ? s?.init.remotes.find((r) => r.name === m[1])?.provider : undefined;
    // A sibling's tool counts as a read here only while its reads skip the question in this session (M5).
    const always = p.always && !!m && !(prov && !(s && this.freeRead(s, m[1]!, m[2]!, prov)));
    s?.permit(p.toolCallId, name && /^mcp__/.test(name) ? name : undefined, always, !!p.autonomous);
  }

  async listTools(u: Upstream, keep = true): Promise<Tool[]> {
    const tools = await u.tools();
    if (keep) for (const t of tools) this.toolsOf.set(`${u.name}\0${t.name}`, t);
    return tools;
  }

  /**
   * A connection changed (M2): in every open session that has it, its server leaves (`drop`) or its reads stop
   * running without asking (`reads`).
   */
  restrictProvider(provider: string, decide: (spec: RemoteSpec) => "drop" | "reads" | undefined) {
    for (const s of this.sessions.values()) {
      const spec = s.init.remotes.find((r) => r.provider?.id === provider);
      if (!spec || !s.upstreams.has(spec.name)) continue;
      const what = decide(spec);
      if (what) s.restrict(spec.name, what);
    }
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
    if (origin === "agent" && s.drafting) return refuse(DRAFTING);
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
    // A connection's server: reads are what its vendor's read-only listing says, not what a tool says of itself. Its
    // tools get no views (M3): their MCP Apps metadata is set aside, and views can't call them.
    const provider = s.init.remotes.find((r) => r.name === server)?.provider;
    if (provider) t = providerTool(t, !!provider.views);
    const readOnly = readsOnly(t, provider);
    // A tool the session doesn't offer (a sibling's new or changed one, an oversized schema) runs for nobody (L3).
    const offered = !provider || this.offers(s, server, t, provider);
    const unoffered = `${server} · ${tool} isn't one of the tools you accepted. Review its tools on the Connections page.`;
    if (origin === "agent") {
      if (!modelMayCall(t)) return refuse(`${tool} is for its app's view only.`);
      // Google Cloud data enters the session: its writes ask from now on, before this read runs (W1).
      if (server === GCP_MCP_SERVER) for (const a of s.autonomy.values()) a.hold(WHY.gcp);
      // So does a sibling's text (D113): any call to a family server holds the session's GitHub and Linear autonomy.
      if (provider && isSibling(provider.id)) for (const a of s.autonomy.values()) a.hold(familyHeld(provider.id));
      if (!offered) return refuse(unoffered);
      const rule = `mcp__${server}__${tool}`;
      if (!isBuiltin(server)) {
        if (s.allow.includes(rule)) this.log.gate(id, "read");
        else {
          const kind = s.takePermitKind(rule, toolUseId);
          if (!kind) return refuse(`${server} · ${tool} needs your yes in the dock first, and Landlens didn't see one.`);
          if (kind === "autonomous") {
            // The check that counts (D82): on the arguments that arrived, not the ones the question showed. Only then
            // is the write counted against the budget and forwarded.
            const a = provider && !isSibling(provider.id) ? s.autonomy.get(provider.id) : undefined;
            const r = a ? a.check(t, args) : { why: "autonomous is off", rules: false };
            if (r) {
              if (r.rules) a?.refused();
              return refuse(`${server} · ${tool} wasn't run on its own: ${r.why}. Ask the person, or change the call.`);
            }
            a!.count();
          }
          this.log.gate(id, kind);
        }
      }
      this.pairing.call({ id, session: s.id, server, tool, args, ...(toolUseId ? { toolUseId } : {}) });
    } else if (origin === "app") {
      // A connection's tools have no views (M3); Clickland's views call its own server's tools (D112), and a write
      // still asks you first.
      if ((provider && !provider.views) || !appMayCall(t)) return refuse(`${tool} isn't offered to app views.`);
      if (!offered) return refuse(unoffered);
      // A sibling's read runs without asking only while its listing is the accepted one and its reads may (M5).
      const free = readOnly && (!provider || !isSibling(provider.id) || s.readsFree.has(server));
      if (!free) {
        const yes = this.opts.approve ? await this.opts.approve({ label: s.label, server, tool, args, origin }).catch(() => false) : false;
        if (!yes) return refuse(`you didn't allow ${server} · ${tool}.`);
      }
      if (!isBuiltin(server)) this.log.gate(id, free ? "read" : "asked");
    } else if (!offered) {
      return refuse(unoffered);
    } else if (!readOnly) {
      return refuse(`${tool} doesn't say it only reads, so Landlens won't run it from the MCP page.`);
    } else if (!isBuiltin(server)) this.log.gate(id, "preview");

    const app = toolUi(t).resourceUri;
    // A connection's read goes to its read-only endpoint when the session has one (M1): the full server can't be
    // asked under a read's name. The read-only endpoint must list the tool.
    const ro = provider && readOnly ? s.readUpstreams.get(server) : undefined;
    if (ro) {
      const listed = await this.listTools(ro, false).catch(() => [] as Tool[]);
      if (!listed.some((x) => x.name === tool)) return refuse(`${server}'s read-only endpoint has no tool named ${tool}.`);
    }
    try {
      const result = await (ro ?? up).call(tool, args, server === BUILTIN_MCP_SERVER ? { [CALL_META]: id } : undefined);
      const status = result.isError ? "error" : "ok";
      if (app && !result.isError) {
        const url = s.init.remotes.find((r) => r.name === server)?.url;
        this.log.keepResult(id, { args, result: result as McpToolResult, ...(url ? { url } : {}) });
        void this.appResource(s, server, app).catch(() => {}); // warm the view's HTML
      }
      this.log.finish(id, { status, result: result as McpToolResult, ...(app && !result.isError ? { app } : {}) });
      return origin === "agent" ? forModel(result, t, provider) : result;
    } catch (err) {
      const why = describeError(err);
      this.log.finish(id, { status: "error", error: why });
      return { content: [{ type: "text", text: `Landlens: ${server} · ${tool} failed: ${why}` }], isError: true };
    }
  }

  /**
   * A view's HTML and what it declares. landlens-kube's are part of Landlens; a remote server's is read through the
   * session (or, once the session has ended, from the last read of the same address) and must be an MCP App document
   * of at most 5 MB. The cache is keyed by the server's address and the view's URI, never by the server's name, so a
   * server renamed, re-pointed or replaced under the same name never gets another's HTML.
   */
  async appResource(s: GatewaySession | undefined, server: string, uri: string, callUrl?: string): Promise<AppResource> {
    if (server === BUILTIN_MCP_SERVER) {
      const html = APP_HTML[uri];
      if (!html) throw new Error(`Landlens: no view ${uri}`);
      return { html, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false };
    }
    const up = s && !s.closed ? s.upstreams.get(server) : undefined;
    const live = up ? s!.init.remotes.find((r) => r.name === server)?.url : undefined;
    const url = callUrl ?? live;
    if (!url) throw new Error("Landlens: the session that made this call has ended.");
    const key = `${url}\0${uri}`;
    const hit = this.apps.get(key);
    if (hit) return hit;
    if (!up || live !== url) throw new Error("Landlens: the session that made this call has ended.");
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
    // landlens-kube is at /mcp only; landlens-gcp, when the session has it, at /mcp/landlens-gcp.
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
        const provider = session.init.remotes.find((r) => r.name === name)?.provider;
        const tools = await this.listTools(up);
        // A provider's tools as offered (L3): never an oversized schema, and of a sibling only what the person accepted.
        return { tools: provider ? tools.filter((t) => (!provider.views || modelMayCall(t)) && this.offers(session, name, t, provider)).map((t) => providerTool(t, !!provider.views)) : tools.filter(modelMayCall) };
      } catch (err) {
        this.opts.log?.(`[mcp] ${session.label}: ${name} didn't list its tools: ${rawError(err)}`);
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
 * the model") is dropped when there's text beside it and the tool doesn't promise an output schema. A connection's
 * tool (GitHub, Linear) gives text only, under a line that says it is other people's words, capped (D81).
 */
export function forModel(r: CallToolResult, t: Tool, provider?: Pick<ProviderRules, "id">): CallToolResult {
  if (provider) return providerResult(r, provider.id);
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
