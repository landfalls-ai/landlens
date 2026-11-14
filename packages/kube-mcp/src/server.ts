// The MCP server the agent reaches its cluster tools on: loopback HTTP, one bearer token per agent session, each
// mapped to that session's cluster (its own front-door token, its namespaces). Stateless: every POST builds a fresh
// McpServer for the caller's session, so nothing one session does can reach another's.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentCluster } from "./cluster.js";
import { registerTools } from "./tools.js";

export const MCP_SERVER_NAME = "landlens-kube";
const MAX_BODY = 1_000_000;

const hash = (t: string) => createHash("sha256").update(t).digest();

export class McpHost {
  private server: Server | undefined;
  private port = 0;
  private readonly sessions = new Map<string, { cluster: AgentCluster; label: string }>(); // sha256 hex → session

  constructor(private readonly onCall: (e: { label: string; tool?: string; status: number }) => void = () => {}) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** A token for one agent session; revoke it when the session ends. */
  addSession(cluster: AgentCluster, label: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(hash(token).toString("hex"), { cluster, label });
    return token;
  }

  removeSession(token: string) {
    this.sessions.delete(hash(token).toString("hex"));
  }

  private sessionFor(header: string | undefined) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "");
    if (!m) return undefined;
    const h = hash(m[1]!);
    for (const [k, s] of this.sessions) if (timingSafeEqual(Buffer.from(k, "hex"), h)) return s;
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    // Only local MCP clients: no browser (an Origin header) and no other host name (DNS rebinding).
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}`) return deny(res, 403, "forbidden");
    if ((req.url ?? "").split("?")[0] !== "/mcp") return deny(res, 404, "not found");
    const session = this.sessionFor(req.headers.authorization);
    if (!session) {
      this.onCall({ label: "unknown", status: 401 });
      return deny(res, 401, "missing or unknown Landlens session token");
    }
    if (req.method !== "POST") return deny(res, 405, "stateless server: POST only");

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return deny(res, 400, "bad JSON");
    }
    const tool = (body as any)?.method === "tools/call" ? String((body as any).params?.name ?? "") : undefined;

    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
    registerTools(mcp, session.cluster);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    if (tool) this.onCall({ label: session.label, tool, status: res.statusCode });
  }
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
