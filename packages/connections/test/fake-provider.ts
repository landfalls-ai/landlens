// One loopback HTTP server that plays GitHub or Linear for tests (spec D97). No test reaches the real hosts: every
// provider origin is replaced by this server's (the LANDLENS_*_ENDPOINT override), and it records every request, so
// a test can say where a token went.
//
//   MCP          /mcp, /mcp/ (full) and /mcp/readonly, stateless; 401 with WWW-Authenticate without a valid bearer
//   OAuth        /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server, /register,
//                /authorize (redirects at once to the registered redirect with a code and the state), /token, /revoke
//   GitHub       /login/device/code, /login/oauth/access_token (scripted: pending, slow_down, then a token), /user
//   Linear       /graphql (viewer)
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type Vendor = "github" | "linear";
export type Recorded = { method: string; path: string; host?: string; authorization?: string; body: string };
export type Listing = { recorded: boolean; full: Tool[]; readonly: Tool[] };

export const listing = (vendor: Vendor): Listing => JSON.parse(readFileSync(join(__dirname, "fixtures", `${vendor}-tools.json`), "utf8"));

export type FakeOptions = {
  /** Device-flow answers in order, then a token. Each is an error code or "token". */
  device?: ("authorization_pending" | "slow_down" | "expired_token" | "access_denied" | "token")[];
  /** The scopes /user reports. */
  scopes?: string;
  /** Seconds an issued OAuth access token lives (then expires_in is sent). */
  expiresIn?: number;
  refuseRefresh?: boolean;
  /** The authorize page sends error=access_denied instead of a code. */
  deny?: boolean;
  /** Fields of the authorization server's metadata replaced (e.g. an issuer or endpoint elsewhere). */
  metadata?: Record<string, unknown>;
  /** /user answers with this redirect instead. */
  redirectUser?: string;
  /** /graphql refuses OAuth tokens (only pasted keys get a viewer). */
  graphqlKeysOnly?: boolean;
};

export class FakeProvider {
  readonly requests: Recorded[] = [];
  /** Bearers the MCP endpoints, /user and /graphql accept. Tests add pasted tokens here. */
  readonly valid = new Set<string>();
  readonly clients = new Map<string, { redirect_uris: string[] }>();
  private codes = new Map<string, { client: string; redirect: string; challenge: string; scope: string; resource?: string }>();
  private refresh = new Map<string, string>();
  private deviceStep = 0;
  revoked: string[] = [];
  /** The token the device flow hands out. */
  readonly deviceToken = `gho_${"D".repeat(36)}`;
  private server!: HttpServer;
  origin = "";

  constructor(readonly vendor: Vendor, readonly opts: FakeOptions = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); }));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Every request that carried this string anywhere (header or body). */
  carrying(secret: string): Recorded[] {
    return this.requests.filter((r) => r.authorization?.includes(secret) || r.body.includes(secret));
  }

  private metadata() {
    const o = this.origin;
    return {
      issuer: o,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      revocation_endpoint: `${o}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write"],
      ...(this.opts.metadata ?? {}),
    };
  }

  private issue(scope: string) {
    const access = `lin_oauth_${randomBytes(16).toString("hex")}`;
    const refresh = `lin_refresh_${randomBytes(16).toString("hex")}`;
    this.valid.add(access);
    this.refresh.set(refresh, scope);
    return { access_token: access, token_type: "Bearer", refresh_token: refresh, scope, ...(this.opts.expiresIn ? { expires_in: this.opts.expiresIn } : {}) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.origin);
    this.requests.push({ method: req.method ?? "", path: url.pathname, host: req.headers.host, authorization: req.headers.authorization, body });
    const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(v));
    };
    const form = () => new URLSearchParams(body);
    const auth = req.headers.authorization ?? "";
    const bearer = /^Bearer (.+)$/.exec(auth)?.[1];

    switch (url.pathname) {
      case "/mcp":
      case "/mcp/":
      case "/mcp/readonly": {
        if (!bearer || !this.valid.has(bearer)) {
          return json(401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"` });
        }
        const l = listing(this.vendor);
        const tools = url.pathname === "/mcp/readonly" ? l.readonly : l.full;
        const mcp = new Server({ name: `fake-${this.vendor}`, version: "1.0.0" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
        mcp.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `fake ${r.params.name}` }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => void transport.close());
        await mcp.connect(transport);
        return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      }
      case "/.well-known/oauth-protected-resource/mcp":
      case "/.well-known/oauth-protected-resource":
        return json(200, { resource: `${this.origin}/mcp`, authorization_servers: [this.metadata().issuer], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"] });
      case "/.well-known/oauth-authorization-server":
        return json(200, this.metadata());
      case "/register": {
        const m = JSON.parse(body || "{}");
        const id = `client_${randomBytes(8).toString("hex")}`;
        this.clients.set(id, { redirect_uris: m.redirect_uris ?? [] });
        return json(201, { ...m, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      case "/authorize": {
        const q = url.searchParams;
        const client = this.clients.get(q.get("client_id") ?? "");
        const redirect = q.get("redirect_uri") ?? "";
        if (!client || !client.redirect_uris.includes(redirect) || q.get("code_challenge_method") !== "S256" || !q.get("state")) return json(400, { error: "invalid_request" });
        const back = new URL(redirect);
        back.searchParams.set("state", q.get("state")!);
        if (this.opts.deny) back.searchParams.set("error", "access_denied");
        else {
          const code = randomBytes(12).toString("hex");
          this.codes.set(code, { client: q.get("client_id")!, redirect, challenge: q.get("code_challenge")!, scope: q.get("scope") ?? "read", ...(q.get("resource") ? { resource: q.get("resource")! } : {}) });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { Location: back.href });
        return res.end();
      }
      case "/token": {
        const f = form();
        if (f.get("grant_type") === "authorization_code") {
          const c = this.codes.get(f.get("code") ?? "");
          this.codes.delete(f.get("code") ?? "");
          const verifier = f.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!c || c.client !== f.get("client_id") || c.redirect !== f.get("redirect_uri") || c.challenge !== challenge) return json(400, { error: "invalid_grant" });
          return json(200, this.issue(c.scope));
        }
        if (f.get("grant_type") === "refresh_token") {
          const scope = this.refresh.get(f.get("refresh_token") ?? "");
          if (!scope || this.opts.refuseRefresh) return json(400, { error: "invalid_grant" });
          this.refresh.delete(f.get("refresh_token")!);
          return json(200, this.issue(scope));
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      case "/revoke": {
        const t = form().get("token") ?? "";
        this.revoked.push(t);
        this.valid.delete(t);
        this.refresh.delete(t);
        return json(200, {});
      }
      case "/login/device/code":
        return json(200, { device_code: "dc_" + "a".repeat(37), user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      case "/login/oauth/access_token": {
        const steps = this.opts.device ?? ["token"];
        const step = steps[Math.min(this.deviceStep++, steps.length - 1)];
        if (step === "token") {
          this.valid.add(this.deviceToken);
          return json(200, { access_token: this.deviceToken, token_type: "bearer", scope: "repo,read:org,read:user" });
        }
        return json(200, step === "slow_down" ? { error: step, interval: 10 } : { error: step });
      }
      case "/user": {
        if (this.opts.redirectUser) {
          res.writeHead(307, { Location: this.opts.redirectUser });
          return res.end();
        }
        if (!bearer || !this.valid.has(bearer)) return json(401, { message: "Bad credentials" });
        return json(200, { login: "octo-person", name: "Octo‮ Person\n" }, { "X-OAuth-Scopes": this.opts.scopes ?? "repo, read:org, read:user" });
      }
      case "/graphql": {
        const key = auth.startsWith("Bearer ") ? bearer : auth;
        const oauth = auth.startsWith("Bearer ");
        if (!key || !this.valid.has(key) || (oauth && this.opts.graphqlKeysOnly)) return json(401, { errors: [{ message: "Authentication required" }] });
        return json(200, { data: { viewer: { name: "Lin Person", email: "lin@example.com", organization: { name: "Landfalls" } } } });
      }
      default:
        return json(404, { error: "not found" });
    }
  }
}
