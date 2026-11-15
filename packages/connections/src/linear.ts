// Signing in to Linear: the MCP authorization flow (the MCP SDK's own `auth()`), or a pasted API key.
//
// The flow, against the fixed resource https://mcp.linear.app/mcp: discovery, dynamic client registration (a public
// client, "Landlens", registered at each sign-in with that sign-in's loopback redirect), PKCE S256, `state`, the
// `resource` parameter, scope `read` or `read write`. Linear is its own authorization server, so every address the
// flow uses is pinned to mcp.linear.app: requests go through pinnedFetch, and the discovered metadata is refused
// before anything is registered if its issuer or any endpoint is elsewhere. The browser opens only an address on that
// origin. Client information and tokens are kept with the `issuer` the SDK stamps on them.
import { randomBytes } from "node:crypto";
import { CONN_NOTES, type ConnAccount, type ConnMode } from "@landlens/contracts";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ConnError } from "./github.js";
import { openLoopback, LoopbackError, LOOPBACK_TIMEOUT } from "./loopback.js";
import { failureKind, LINEAR_SCOPE, oneLine, pinnedFetch, type LinearEndpoints } from "./providers.js";
import type { LinearClient } from "./store.js";

/** The discovered authorization server, refused unless every address in it is on Linear's origin. */
export function checkDiscovery(ep: LinearEndpoints, s: OAuthDiscoveryState): void {
  const on = (u: unknown) => {
    if (u === undefined) return true;
    try {
      return typeof u === "string" && new URL(u).origin === ep.authOrigin;
    } catch {
      return false;
    }
  };
  const m = s.authorizationServerMetadata as Record<string, unknown> | undefined;
  if (!m) throw new ConnError(CONN_NOTES.linearAnswer, 502);
  const urls = [s.authorizationServerUrl, m.issuer, m.authorization_endpoint, m.token_endpoint, m.registration_endpoint, m.revocation_endpoint];
  if (!on(s.authorizationServerUrl) || !m.issuer || !m.authorization_endpoint || !m.token_endpoint || !urls.every(on)) throw new ConnError(CONN_NOTES.linearElsewhere, 502);
  const pkce = m.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || !pkce.includes("S256")) throw new ConnError(CONN_NOTES.linearAnswer, 502);
}

export type LinearTokens = { access: string; refresh?: string; expiresAt?: number; scopes: string[] };

/**
 * Landlens's OAuthClientProvider for Linear. In a sign-in (`interactive`) it registers a client for the loopback
 * redirect and opens the browser; in a session it holds the stored client and tokens, saves refreshed tokens, and never
 * opens a browser: a refresh that fails marks the connection expired.
 */
export class LinearAuth implements OAuthClientProvider {
  private verifier = "";
  private client: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;

  constructor(private readonly o: {
    endpoints: LinearEndpoints;
    mode: ConnMode;
    redirectUri: string;
    /** Interactive only: the state the loopback expects. */
    state?: string;
    client?: LinearClient;
    tokens?: { access: string; refresh?: string };
    /** Interactive: open the authorization address (already checked). Absent in a session. */
    open?: (url: string) => Promise<void>;
    onTokens?: (t: LinearTokens) => void;
    onExpired?: () => void;
  }) {
    this.client = o.client;
    if (o.tokens) this.saved = { access_token: o.tokens.access, token_type: "Bearer", ...(o.tokens.refresh ? { refresh_token: o.tokens.refresh } : {}), ...(o.client ? { issuer: o.client.issuer } : {}) };
  }

  get redirectUrl() {
    return this.o.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Landlens",
      redirect_uris: [this.o.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: LINEAR_SCOPE[this.o.mode],
    };
  }

  state(): string {
    // In a session there is no listener to match it; redirectToAuthorization stops the flow before any browser.
    return this.o.state ?? randomBytes(32).toString("base64url");
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(c: OAuthClientInformationMixed) {
    if (!c.issuer || new URL(c.issuer).origin !== this.o.endpoints.authOrigin) throw new ConnError(CONN_NOTES.linearElsewhere, 502);
    this.client = c;
  }

  /** The client as stored: id, issuer and redirect only (a public client has no secret). */
  storedClient(): LinearClient | undefined {
    const c = this.client;
    return c?.issuer ? { client_id: c.client_id, issuer: c.issuer, redirect_uri: this.o.redirectUri } : undefined;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(t: OAuthTokens) {
    if (!t.issuer || new URL(t.issuer).origin !== this.o.endpoints.authOrigin) throw new ConnError(CONN_NOTES.linearElsewhere, 502);
    this.saved = t;
    this.o.onTokens?.(this.current()!);
  }

  current(): LinearTokens | undefined {
    const t = this.saved;
    if (!t) return undefined;
    const expiresIn = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : undefined;
    return {
      access: t.access_token,
      ...(t.refresh_token ? { refresh: t.refresh_token } : {}),
      ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      scopes: (t.scope ?? "").split(/\s+/).filter((s) => s === "read" || s === "write"),
    };
  }

  async redirectToAuthorization(url: URL) {
    if (!this.o.open) {
      // In a session nobody is there to sign in: the connection is expired, and the call fails with that sentence.
      this.o.onExpired?.();
      throw new ConnError(CONN_NOTES.linearExpired, 401);
    }
    if (url.origin !== this.o.endpoints.authOrigin || url.username || url.password) throw new ConnError(CONN_NOTES.linearElsewhere, 502);
    await this.o.open(url.href);
  }

  saveCodeVerifier(v: string) {
    this.verifier = v;
  }

  codeVerifier() {
    if (!this.verifier) throw new ConnError(CONN_NOTES.linearAnswer, 502);
    return this.verifier;
  }

  saveDiscoveryState(s: OAuthDiscoveryState) {
    checkDiscovery(this.o.endpoints, s);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "tokens") this.saved = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = "";
  }
}

export type LinearSignIn = { access: string; refresh?: string; expiresAt?: number; scopes: string[]; client: LinearClient };

const linearNote = (err: unknown): ConnError => {
  if (err instanceof ConnError) return err;
  if (err instanceof LoopbackError) return new ConnError(err.kind === "timeout" ? CONN_NOTES.linearTimeout : CONN_NOTES.linearDenied, err.kind === "timeout" ? 408 : 403);
  const k = failureKind(err);
  return new ConnError(k === "elsewhere" ? CONN_NOTES.linearElsewhere : k === "unreachable" ? CONN_NOTES.linearUnreachable : CONN_NOTES.linearAnswer, 502);
};

/**
 * The whole browser sign-in: a loopback listener, discovery and registration, the browser at Linear's authorize
 * page, the code back on the loopback, the token exchange. Cancelled by `signal`.
 */
export async function linearSignIn(o: { endpoints: LinearEndpoints; mode: ConnMode; open: (url: string) => Promise<void>; signal: AbortSignal; fetch?: typeof fetch; timeoutMs?: number }): Promise<LinearSignIn> {
  const state = randomBytes(32).toString("base64url");
  const lb = await openLoopback({ state, timeoutMs: o.timeoutMs ?? LOOPBACK_TIMEOUT });
  const onAbort = () => lb.close();
  o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const provider = new LinearAuth({ endpoints: o.endpoints, mode: o.mode, redirectUri: lb.redirectUri, state, open: o.open });
    const fetchFn = pinnedFetch([o.endpoints.authOrigin], o.fetch ?? fetch);
    const opts = { serverUrl: o.endpoints.mcp, scope: LINEAR_SCOPE[o.mode], fetchFn };
    const first = await auth(provider, opts);
    if (first !== "REDIRECT") throw new ConnError(CONN_NOTES.linearAnswer, 502);
    const { code } = await lb.result;
    if (o.signal.aborted) throw o.signal.reason;
    if ((await auth(provider, { ...opts, authorizationCode: code })) !== "AUTHORIZED") throw new ConnError(CONN_NOTES.linearAnswer, 502);
    const t = provider.current();
    const client = provider.storedClient();
    if (!t || !client || !LINEAR_TOKEN.test(t.access)) throw new ConnError(CONN_NOTES.linearAnswer, 502);
    return { ...t, client };
  } catch (err) {
    if (o.signal.aborted) throw o.signal.reason;
    throw linearNote(err);
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    lb.close();
  }
}

/** An access token as Landlens will store it: one printable line. Linear's are `lin_oauth_…`, but that isn't promised. */
const LINEAR_TOKEN = /^[\x21-\x7e]{16,2048}$/;

/**
 * Refresh a stored OAuth sign-in if it can be: the SDK's auth() with the stored client and refresh token. A refused
 * refresh ends in redirectToAuthorization, which in a session marks the connection expired.
 */
export async function linearRefresh(o: { endpoints: LinearEndpoints; mode: ConnMode; client: LinearClient; tokens: { access: string; refresh?: string }; onTokens: (t: LinearTokens) => void; onExpired: () => void; fetch?: typeof fetch }): Promise<LinearTokens> {
  const provider = new LinearAuth({ endpoints: o.endpoints, mode: o.mode, redirectUri: o.client.redirect_uri, client: o.client, tokens: o.tokens, onTokens: o.onTokens, onExpired: o.onExpired });
  try {
    await auth(provider, { serverUrl: o.endpoints.mcp, scope: LINEAR_SCOPE[o.mode], fetchFn: pinnedFetch([o.endpoints.authOrigin], o.fetch ?? fetch) });
  } catch (err) {
    throw linearNote(err);
  }
  return provider.current()!;
}

/**
 * Who a pasted key (or, if Linear takes it, an OAuth token) is: `viewer` on api.linear.app. A pasted key is sent
 * as is; an OAuth token as a bearer.
 */
export async function linearViewer(ep: LinearEndpoints, token: string, base: typeof fetch = fetch): Promise<ConnAccount> {
  const f = pinnedFetch(ep.tokenOrigins, base);
  let r: Response;
  try {
    r = await f(ep.graphql, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: token.startsWith("lin_api_") ? token : `Bearer ${token}` },
      body: JSON.stringify({ query: "{ viewer { name email organization { name } } }" }),
    });
  } catch (err) {
    throw linearNote(err);
  }
  if (r.status === 401 || r.status === 403) throw new ConnError(CONN_NOTES.linearRefused, 401);
  if (!r.ok) throw new ConnError(CONN_NOTES.linearAnswer, 502);
  let j: { data?: { viewer?: { name?: unknown; email?: unknown; organization?: { name?: unknown } } }; errors?: unknown[] };
  try {
    j = (await r.json()) as typeof j;
  } catch {
    throw new ConnError(CONN_NOTES.linearAnswer, 502);
  }
  const v = j.data?.viewer;
  // Linear answers an unauthenticated query with 200 and errors.
  if (!v) throw new ConnError(Array.isArray(j.errors) ? CONN_NOTES.linearRefused : CONN_NOTES.linearAnswer, Array.isArray(j.errors) ? 401 : 502);
  const login = oneLine(v.email) ?? oneLine(v.name);
  if (!login) throw new ConnError(CONN_NOTES.linearAnswer, 502);
  const name = oneLine(v.name);
  const org = oneLine(v.organization?.name);
  return { login, ...(name && name !== login ? { name } : {}), ...(org ? { org } : {}) };
}

/**
 * Best effort: revoke an OAuth sign-in at the revocation endpoint Linear's metadata names (on its own origin only),
 * within 5 seconds. A pasted key can't be revoked from here.
 */
export async function linearRevoke(ep: LinearEndpoints, token: string, client: LinearClient, base: typeof fetch = fetch): Promise<boolean> {
  const f = pinnedFetch([ep.authOrigin], base, 5_000);
  try {
    const m = (await (await f(`${ep.authOrigin}/.well-known/oauth-authorization-server`, { headers: { Accept: "application/json" } })).json()) as { revocation_endpoint?: unknown };
    if (typeof m.revocation_endpoint !== "string" || new URL(m.revocation_endpoint).origin !== ep.authOrigin) return false;
    const r = await f(m.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: client.client_id }).toString(),
    });
    return r.ok;
  } catch {
    return false;
  }
}
