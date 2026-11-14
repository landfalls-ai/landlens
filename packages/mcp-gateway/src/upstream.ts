// The servers behind the gateway. The built-in landlens-kube runs in memory, one per session, bound to that
// session's cluster. A remote server is reached over streamable HTTP only (never stdio: nothing Landlens proxies
// runs on this machine), with the header you stored for it added here, in main; redirects are refused, so the
// header can't follow one to another host.
import type { AgentCluster } from "@landlens/kube-mcp";
import { kubeMcpServer } from "@landlens/kube-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ReadResourceResult, Tool } from "@modelcontextprotocol/sdk/types.js";

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

abstract class ClientUpstream implements Upstream {
  private client: Promise<Client> | undefined;
  private listed: Promise<Tool[]> | undefined;
  constructor(readonly name: string) {}

  /** Connect a fresh client to this server. */
  abstract connect(client: Client): Promise<void>;

  private get conn(): Promise<Client> {
    this.client ??= (async () => {
      const c = new Client(CLIENT_INFO, { capabilities: CAPABILITIES as never });
      await this.connect(c);
      return c;
    })();
    // A failed connection is retried next time rather than kept.
    this.client.catch(() => { this.client = undefined; });
    return this.client;
  }

  tools(): Promise<Tool[]> {
    this.listed ??= (async () => {
      const c = await this.conn;
      const all: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await c.listTools(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT });
        all.push(...r.tools);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return all.slice(0, 500);
    })();
    this.listed.catch(() => { this.listed = undefined; });
    return this.listed;
  }

  async call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallToolResult> {
    const c = await this.conn;
    return (await c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: CALL_TIMEOUT })) as CallToolResult;
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

/** landlens-kube for one session, in memory. */
export class BuiltinUpstream extends ClientUpstream {
  constructor(name: string, private readonly cluster: AgentCluster) {
    super(name);
  }
  async connect(client: Client) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await kubeMcpServer(this.cluster).connect(a);
    await client.connect(b);
  }
}

export type RemoteSpec = {
  name: string;
  url: string;
  /** Added to every request; from the store, decrypted in main. */
  headers?: Record<string, string>;
};

/** fetch, refusing redirects (a redirect would carry the header elsewhere). */
const noRedirect: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

/** A remote MCP server over streamable HTTP. */
export class RemoteUpstream extends ClientUpstream {
  constructor(private readonly spec: RemoteSpec) {
    super(spec.name);
  }
  async connect(client: Client) {
    const transport = new StreamableHTTPClientTransport(new URL(this.spec.url), {
      requestInit: { headers: { ...(this.spec.headers ?? {}) } },
      fetch: noRedirect,
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
    const client = new Client(CLIENT_INFO, { capabilities: CAPABILITIES as never });
    const started = Date.now();
    try {
      await up.connect(client);
      const v = client.getServerVersion();
      server = v ? `${v.name} ${v.version}` : undefined;
      steps.push({ name: "initialize", ok: true, detail: `${server ?? "answered"} in ${Date.now() - started} ms` });
    } catch (err) {
      steps.push({ name: "initialize", ok: false, detail: describeError(err) });
      return { ok: false, steps };
    }
    try {
      const r = await client.listTools({}, { timeout: LIST_TIMEOUT });
      const ro = r.tools.filter((t) => t.annotations?.readOnlyHint === true).length;
      steps.push({ name: "tools/list", ok: true, detail: `${r.tools.length} tools, ${ro} read-only` });
      return { ok: true, steps, tools: r.tools, ...(server ? { server } : {}) };
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

/** An error as a person reads it, without echoing headers. */
export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: unknown; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  const msg = String(e?.message ?? err).replace(/Bearer\s+\S+/gi, "Bearer …");
  if (/redirect/i.test(msg) || /redirect/i.test(String(cause ?? ""))) return "The server redirected; Landlens doesn't follow redirects. Use the final URL.";
  if (/ECONNREFUSED/.test(String(cause ?? msg))) return "Nothing is listening at that address.";
  if (/401|Unauthorized/i.test(msg)) return "The server refused the credentials (401).";
  if (/403|Forbidden/i.test(msg)) return "The server refused (403).";
  if (/timed? ?out/i.test(msg)) return "The server didn't answer in time.";
  return (cause ? `${msg} (${cause})` : msg).slice(0, 300);
}
