// Signing in to Linear: the MCP authorization flow (mcp-oauth.ts, the MCP SDK's own `auth()`), or a pasted API key.
//
// The flow, against the fixed resource https://mcp.linear.app/mcp: discovery, dynamic client registration (a public
// client, "Landlens", registered at each sign-in with that sign-in's loopback redirect), PKCE S256, `state`, the
// `resource` parameter, scope `read` or `read write`. Linear is its own authorization server, so every address the
// flow uses is pinned to mcp.linear.app (McpOAuth's one origin). Since wave 7 the flow itself is McpOAuth's, shared
// with Landfall's connector; this file names Linear's target and keeps its functions' names and behaviour.
import { CONN_NOTES, type ConnAccount, type ConnMode } from "@landlens/contracts";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { ConnError } from "./github.js";
import { checkMcpDiscovery, McpOAuth, mcpRefresh, mcpRevoke, mcpSignIn, oauthNote, type McpOAuthNotes, type McpOAuthTarget, type McpOAuthTokens, type McpOAuthUsed } from "./mcp-oauth.js";
import { LINEAR_SCOPE, oneLine, pinnedFetch, type LinearEndpoints } from "./providers.js";
import type { LinearClient } from "./store.js";

export const LINEAR_NOTES: McpOAuthNotes = {
  answer: CONN_NOTES.linearAnswer,
  elsewhere: CONN_NOTES.linearElsewhere,
  expired: CONN_NOTES.linearExpired,
  unreachable: CONN_NOTES.linearUnreachable,
  denied: CONN_NOTES.linearDenied,
  timeout: CONN_NOTES.linearTimeout,
};

/** Linear's MCP server as an OAuth target, at a level. */
export function linearTarget(ep: LinearEndpoints, mode: ConnMode): McpOAuthTarget {
  return { resource: ep.mcp, origin: ep.authOrigin, clientName: "Landlens", scope: LINEAR_SCOPE[mode], scopes: ["read", "write"], notes: LINEAR_NOTES };
}

/** The discovered authorization server, refused unless every address in it is on Linear's origin. */
export function checkDiscovery(ep: LinearEndpoints, s: OAuthDiscoveryState): void {
  checkMcpDiscovery(ep.authOrigin, s, LINEAR_NOTES);
}

export type LinearTokens = McpOAuthTokens;
export type LinearUsed = McpOAuthUsed;

/** Landlens's OAuthClientProvider for Linear: McpOAuth with Linear's target (see mcp-oauth.ts). */
export class LinearAuth extends McpOAuth {
  constructor(o: {
    endpoints: LinearEndpoints;
    mode: ConnMode;
    redirectUri: string;
    state?: string;
    client?: LinearClient;
    tokens?: { access: string; refresh?: string };
    load?: () => { access: string; refresh?: string } | undefined;
    open?: (url: string) => Promise<void>;
    onTokens?: (t: LinearTokens) => void;
    onExpired?: (used: LinearUsed) => void;
  }) {
    const { endpoints, mode, ...rest } = o;
    super({ target: linearTarget(endpoints, mode), ...rest });
  }
}

export type LinearSignIn = { access: string; refresh?: string; expiresAt?: number; scopes: string[]; client: LinearClient };

const linearNote = (err: unknown): ConnError => oauthNote(err, LINEAR_NOTES);

/**
 * The whole browser sign-in: a loopback listener, discovery and registration, the browser at Linear's authorize
 * page, the code back on the loopback, the token exchange. Cancelled by `signal`.
 */
export async function linearSignIn(o: { endpoints: LinearEndpoints; mode: ConnMode; open: (url: string) => Promise<void>; signal: AbortSignal; fetch?: typeof fetch; timeoutMs?: number }): Promise<LinearSignIn> {
  return mcpSignIn({ target: linearTarget(o.endpoints, o.mode), open: o.open, signal: o.signal, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
}

/**
 * Refresh a stored OAuth sign-in if it can be: the SDK's auth() with the stored client and refresh token. A refresh
 * Linear refuses calls onExpired with the tokens it was tried with; one that doesn't get through throws unreachable.
 */
export async function linearRefresh(o: { endpoints: LinearEndpoints; mode: ConnMode; client: LinearClient; tokens: { access: string; refresh?: string }; onTokens: (t: LinearTokens) => void; onExpired: (used: LinearUsed) => void; fetch?: typeof fetch }): Promise<LinearTokens> {
  const { endpoints, mode, ...rest } = o;
  return mcpRefresh({ target: linearTarget(endpoints, mode), ...rest });
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
 * each request within 5 seconds. Every token given is revoked, in order (the access token, then the refresh token):
 * true only if all were. A pasted key can't be revoked from here.
 */
export async function linearRevoke(ep: LinearEndpoints, tokens: string | string[], client: LinearClient, base: typeof fetch = fetch): Promise<boolean> {
  return mcpRevoke(ep.authOrigin, tokens, client, base);
}
