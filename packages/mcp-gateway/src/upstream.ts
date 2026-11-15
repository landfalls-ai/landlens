// The servers behind the gateway. The built-in landlens-kube runs in memory, one per session, bound to that
// session's cluster. A remote server is reached over streamable HTTP only (never stdio: nothing Landlens proxies
// runs on this machine), with the header you stored for it added here, in main; redirects are refused, so the
// header can't follow one to another host.
import type { AgentCluster } from "@landlens/kube-mcp";
import { kubeMcpServer, WRITE_CALL_TIMEOUT_MS, WRITE_TOOLS } from "@landlens/kube-mcp";
import { BUILTIN_MCP_SERVER } from "@landlens/contracts";
import { redactText } from "@landlens/kube-mcp";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderRules } from "./providers/index.js";

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
const CLIENT_INFO = { name: "landlens-gateway", version: "0.1.0" };
/** Landlens can show MCP App views, so servers may offer them. */
const CAPABILITIES = { extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html;profile=mcp-app"] } } } as Record<string, unknown>;
export const LIST_TIMEOUT = 15_000;
export const CALL_TIMEOUT = 120_000;

export interface Upstream {
  readonly name: string;
  /** The server's tools, listed once and kept. */
  tools(): Promise<Tool[]>;
  call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallToolResult>;
  read(uri: string): Promise<ReadResourceResult>;
  close(): Promise<void>;
}

/**
 * Every page of a server's tools (at most 20 pages, 500 tools). One function for sessions and for Test, so a vendor
 * that pages its listing hashes the same in both (L1).
 */
export async function listAllTools(c: Client): Promise<Tool[]> {
  const all: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await c.listTools(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT });
    all.push(...r.tools);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return all.slice(0, 500);
}

/** A client for a server: one that may offer MCP App views is told Landlens shows them; a connection's isn't (M3). */
const newClient = (views: boolean) => new Client(CLIENT_INFO, { capabilities: (views ? CAPABILITIES : {}) as never });

abstract class ClientUpstream implements Upstream {
  private client: Promise<Client> | undefined;
  private listed: Promise<Tool[]> | undefined;
  constructor(readonly name: string, private readonly views = true) {}

  /** Connect a fresh client to this server. */
  abstract connect(client: Client): Promise<void>;

  private get conn(): Promise<Client> {
    this.client ??= (async () => {
      const c = newClient(this.views);
      await this.connect(c);
      return c;
    })();
    // A failed connection is retried next time rather than kept.
    this.client.catch(() => { this.client = undefined; });
    return this.client;
  }

  tools(): Promise<Tool[]> {
    this.listed ??= (async () => listAllTools(await this.conn))();
    this.listed.catch(() => { this.listed = undefined; });
    return this.listed;
  }

  async call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallToolResult> {
    const c = await this.conn;
    // A write tool waits for the person's answer (the broker's 15 minutes), so it isn't cut off at the usual limit.
    const timeout = this.name === BUILTIN_MCP_SERVER && WRITE_TOOLS.includes(name) ? WRITE_CALL_TIMEOUT_MS : CALL_TIMEOUT;
    return (await c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout })) as CallToolResult;
  }

  async read(uri: string): Promise<ReadResourceResult> {
    const c = await this.conn;
    return c.readResource({ uri }, { timeout: LIST_TIMEOUT });
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.listed = undefined;
    await (await c?.catch(() => undefined))?.close().catch(() => {});
  }
}

/**
 * A built-in server for one session, in memory: landlens-kube (bound to the session's cluster), or landlens-gcp (the
 * person's chosen Google Cloud projects, wave 6). Given an AgentCluster, it is landlens-kube.
 */
export class BuiltinUpstream extends ClientUpstream {
  private readonly make: () => McpServer;
  constructor(name: string, source: AgentCluster | (() => McpServer)) {
    super(name);
    this.make = typeof source === "function" ? source : () => kubeMcpServer(source);
  }
  async connect(client: Client) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await this.make().connect(a);
    await client.connect(b);
  }
}

export type RemoteSpec = {
  name: string;
  url: string;
  /** Added to every request; from the store, decrypted in main. */
  headers?: Record<string, string>;
  /**
   * Set when you let this server's read-only tools run without asking: the hash of the tool listing you saw then
   * (approval.ts listingHash). Absent: every tool asks.
   */
  pin?: string;
  /** Linear's OAuth sign-in: the transport takes its bearer from here and refreshes it on a 401 (D77). */
  authProvider?: OAuthClientProvider;
  /**
   * Set for a connection's server (GitHub, Linear) or a family sibling's (Clickland, Landflow, Landfall) only: which
   * of its tools read, and its level (D78, D79, D110).
   */
  provider?: ProviderRules;
  /** When set, the only origins any request for this server may go to (a connection's token origins). */
  origins?: string[];
  /** A connection's server: Landlens doesn't offer it MCP App views (M3). Implied by `provider`, unless its `views`. */
  noViews?: boolean;
  /**
   * A connection at Ask for writes: its read-only endpoint. The reads of the session go there, so a tool the full
   * server serves under a read's name can't write unasked (M1).
   */
  readUrl?: string;
  /** The read-only endpoint's half of the accepted listing; its reads run without asking only while it holds. */
  readPin?: string;
};

/** Whether Landlens tells this server it shows MCP App views: not a connection's (M3), except Clickland's (D112). */
const offersViews = (spec: RemoteSpec) => !spec.noViews && (!spec.provider || !!spec.provider.views);

/** fetch, refusing redirects (a redirect would carry the header elsewhere). */
const noRedirect: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

/** noRedirect, and only to these origins: anything else is refused before it is asked. */
function pinnedTo(origins: string[]): typeof fetch {
  const allowed = new Set(origins);
  return (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      // not an address: refused below
    }
    if (!allowed.has(origin)) return Promise.reject(new Error("Landlens: refused a request to an origin that isn't this server's"));
    return noRedirect(input, init);
  };
}

/** A remote MCP server over streamable HTTP. */
export class RemoteUpstream extends ClientUpstream {
  constructor(private readonly spec: RemoteSpec) {
    super(spec.name, offersViews(spec));
  }
  async connect(client: Client) {
    const transport = new StreamableHTTPClientTransport(new URL(this.spec.url), {
      requestInit: { headers: { ...(this.spec.headers ?? {}) } },
      fetch: this.spec.origins ? pinnedTo(this.spec.origins) : noRedirect,
      ...(this.spec.authProvider ? { authProvider: this.spec.authProvider } : {}),
      reconnectionOptions: { maxReconnectionDelay: 30_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 },
    });
    await client.connect(transport, { timeout: LIST_TIMEOUT });
  }
}

/** Test a remote server the way the MCP page's Test does: initialize, then list its tools. */
export async function testRemote(spec: RemoteSpec): Promise<{ ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; tools?: Tool[]; server?: string }> {
  const steps: { name: string; ok: boolean; detail: string }[] = [];
  const up = new RemoteUpstream(spec);
  let server: string | undefined;
  try {
    const client = newClient(offersViews(spec));
    const started = Date.now();
    try {
      await up.connect(client);
      const v = client.getServerVersion();
      // The server names itself; only a plain name and version are repeated to the page.
      const plain = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9 ._@\/+-]{1,64}$/.test(x);
      server = v && plain(v.name) && plain(v.version) ? `${v.name} ${v.version}` : undefined;
      steps.push({ name: "initialize", ok: true, detail: `${server ?? "answered"} in ${Date.now() - started} ms` });
    } catch (err) {
      steps.push({ name: "initialize", ok: false, detail: describeError(err) });
      return { ok: false, steps };
    }
    try {
      const tools = await listAllTools(client);
      const ro = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
      steps.push({ name: "tools/list", ok: true, detail: `${tools.length} tools, ${ro} read-only` });
      return { ok: true, steps, tools, ...(server ? { server } : {}) };
    } catch (err) {
      steps.push({ name: "tools/list", ok: false, detail: describeError(err) });
      return { ok: false, steps };
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await up.close();
  }
}

/**
 * An error as a person reads it: one of a fixed set of sentences, never the server's own words. Test and the call
 * log show this to the page and the model, and the address may be one the page chose, so nothing a server sent back
 * (an error body, a reason phrase) passes through; main's own log gets rawError.
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: unknown; cause?: { code?: string; message?: string } };
  const msg = String(e?.message ?? err);
  const cause = String(e?.cause?.code ?? e?.cause?.message ?? "");
  const code = typeof e?.code === "number" ? e.code : undefined;
  const all = `${msg} ${cause}`;
  if (/redirect/i.test(all)) return "The server redirected; Landlens doesn't follow redirects. Use the final URL.";
  if (/ECONNREFUSED/.test(all)) return "Nothing is listening at that address.";
  if (/ENOTFOUND|EAI_AGAIN/.test(all)) return "That host name doesn't resolve.";
  if (/CERT|SSL|TLS|self[- ]signed/i.test(cause) || /certificate/i.test(all)) return "The server's TLS certificate wasn't accepted.";
  if (/ECONNRESET|socket hang up|other side closed/i.test(all)) return "The server closed the connection.";
  if (/timed? ?out|TimeoutError|ETIMEDOUT/i.test(all) || code === -32001) return "The server didn't answer in time.";
  // The SDK's StreamableHTTPError carries the HTTP status as its code.
  const status = code !== undefined && code >= 100 && code < 600 ? String(code) : (/HTTP (\d{3})/.exec(msg)?.[1] ?? /\b(401|403|404|405|406|415|429|500|502|503|504)\b/.exec(msg)?.[1]);
  if (status === "401") return "The server refused the credentials (401).";
  if (status === "403") return "The server refused (403).";
  if (status === "404") return "Nothing at that path (404). Check the address.";
  if (status) return `The server answered HTTP ${status}.`;
  return "The server's answer wasn't a valid MCP response.";
}

/** The error's own text, for main's log only (never the page or the model); bearer values cut. */
export function rawError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  const msg = String(e?.message ?? err).replace(/Bearer\s+\S+/gi, "Bearer …");
  // Provider tokens (GitHub, Linear) and other credential shapes are cut too, wherever they appear.
  return redactText(cause ? `${msg} (${cause})` : msg).slice(0, 500);
}
