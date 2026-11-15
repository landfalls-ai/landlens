// Signing in to an MCP server that is its own OAuth authorization server: the MCP SDK's own `auth()`, for Linear
// (wave 6, D74) and Landfall's connector (wave 7, D103). One target names the resource (the MCP server's address), the
// one origin every OAuth address must be on, the client's name, the scope asked for, and the sentences a failure is
// told in.
//
// The flow: discovery, dynamic client registration (a public client registered at each sign-in with that sign-in's
// loopback redirect), PKCE S256, `state`, the `resource` parameter. Every request goes through pinnedFetch (the one
// origin, no redirects, a time limit), and the discovered metadata is refused before anything is registered if its
// issuer or any endpoint is elsewhere. The browser opens only an address on that origin. Client information and
// tokens are kept with the `issuer` the SDK stamps on them.
import { randomBytes } from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ConnError } from "./github.js";
import { openLoopback, LoopbackError, LOOPBACK_TIMEOUT } from "./loopback.js";
import { failureKind, pinnedFetch, readCapped } from "./providers.js";

/** The client a sign-in registered, with the loopback redirect it registered. A public client has no secret. */
export type OAuthClientRecord = { client_id: string; issuer: string; redirect_uri: string };

/** The sentences a sign-in's failures are told in (fixed; the raw error goes to main's log). */
export type McpOAuthNotes = { answer: string; elsewhere: string; expired: string; unreachable: string; denied: string; timeout: string; wider?: string };

export type McpOAuthTarget = {
  /** The MCP server's address: auth()'s serverUrl, and the `resource` parameter. */
  resource: string;
  /** The one origin the authorization server and every endpoint must be on. */
  origin: string;
  clientName: string;
  /** The scope asked for. */
  scope: string;
  /** The scopes kept from a token answer's `scope` (anything else is dropped). */
  scopes: readonly string[];
  /**
   * If set, a token answer that grants any scope outside this list is not kept: its tokens are revoked and the sign-in
   * (or the refresh, which then marks the sign-in expired) fails with `notes.wider`. Landfall's is `mcp:read` (D103).
   */
  grantOnly?: readonly string[];
  notes: McpOAuthNotes;
};

export type McpOAuthTokens = { access: string; refresh?: string; expiresAt?: number; scopes: string[] };
/** The tokens a refresh was tried with, so main marks expired only the sign-in that was refused. */
export type McpOAuthUsed = { access: string; refresh?: string };

/** The discovered authorization server, refused unless every address in it is on the target's origin. */
export function checkMcpDiscovery(origin: string, s: OAuthDiscoveryState, notes: McpOAuthNotes): void {
  const on = (u: unknown) => {
    if (u === undefined) return true;
    try {
      return typeof u === "string" && new URL(u).origin === origin;
    } catch {
      return false;
    }
  };
  const m = s.authorizationServerMetadata as Record<string, unknown> | undefined;
  if (!m) throw new ConnError(notes.answer, 502);
  const urls = [s.authorizationServerUrl, m.issuer, m.authorization_endpoint, m.token_endpoint, m.registration_endpoint, m.revocation_endpoint];
  if (!on(s.authorizationServerUrl) || !m.issuer || !m.authorization_endpoint || !m.token_endpoint || !urls.every(on)) throw new ConnError(notes.elsewhere, 502);
  const pkce = m.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || !pkce.includes("S256")) throw new ConnError(notes.answer, 502);
}

/**
 * Landlens's OAuthClientProvider for one target. In a sign-in (`open` given) it registers a client for the loopback
 * redirect and opens the browser; in a session it holds the stored client and tokens, saves refreshed tokens, and never
 * opens a browser. Only a refresh the server refused (invalid_grant, or the client refused) marks the sign-in expired;
 * a refresh that didn't get through (offline, a 5xx) fails the call as unreachable and leaves the sign-in as it is.
 */
export class McpOAuth implements OAuthClientProvider {
  private verifier = "";
  private client: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  /** The SDK threw the tokens away because the server refused them (invalidateCredentials "tokens" or "all"). */
  private refused: McpOAuthUsed | undefined;
  /**
   * Why the last saveTokens refused what a refresh gave. The SDK swallows a refresh's failure and falls through to
   * redirectToAuthorization, which throws this instead of "unreachable".
   */
  private failed: unknown;
  /** The revocation of tokens this provider didn't keep, for mcpSignIn to wait on. */
  revoking: Promise<unknown> | undefined;

  constructor(private readonly o: {
    target: McpOAuthTarget;
    redirectUri: string;
    /** Interactive only: the state the loopback expects. */
    state?: string;
    client?: OAuthClientRecord;
    tokens?: { access: string; refresh?: string };
    /** In a session: the stored tokens now, read before each use, so a refresh another session made is picked up. */
    load?: () => { access: string; refresh?: string } | undefined;
    /** Interactive: open the authorization address (already checked). Absent in a session. */
    open?: (url: string) => Promise<void>;
    /** New tokens, with the ones they replace (none at a sign-in). Throwing refuses them: they aren't kept. */
    onTokens?: (t: McpOAuthTokens, used?: McpOAuthUsed) => void;
    onExpired?: (used: McpOAuthUsed) => void;
    /** Revoke tokens this provider was given and didn't keep (a grant beyond `grantOnly`). */
    revoke?: (tokens: string[]) => Promise<unknown>;
  }) {
    this.client = o.client;
    if (o.tokens) this.saved = { access_token: o.tokens.access, token_type: "Bearer", ...(o.tokens.refresh ? { refresh_token: o.tokens.refresh } : {}), ...(o.client ? { issuer: o.client.issuer } : {}) };
  }

  get redirectUrl() {
    return this.o.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.o.target.clientName,
      redirect_uris: [this.o.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.o.target.scope,
    };
  }

  state(): string {
    // In a session there is no listener to match it; redirectToAuthorization stops the flow before any browser.
    return this.o.state ?? randomBytes(32).toString("base64url");
  }

  clientInformation() {
    // The SDK asks for the client first when it starts over after a refused refresh: in a session that is the end.
    if (this.refused && !this.o.open) this.expire(this.refused);
    return this.client;
  }

  private onOrigin(u: string | undefined): boolean {
    try {
      return !!u && new URL(u).origin === this.o.target.origin;
    } catch {
      return false;
    }
  }

  saveClientInformation(c: OAuthClientInformationMixed) {
    if (!this.onOrigin(c.issuer)) throw new ConnError(this.o.target.notes.elsewhere, 502);
    this.client = c;
  }

  /** The client as stored: id, issuer and redirect only (a public client has no secret). */
  storedClient(): OAuthClientRecord | undefined {
    const c = this.client;
    return c?.issuer ? { client_id: c.client_id, issuer: c.issuer, redirect_uri: this.o.redirectUri } : undefined;
  }

  tokens() {
    const now = !this.refused ? this.o.load?.() : undefined;
    if (now && now.access !== this.saved?.access_token) {
      this.saved = { access_token: now.access, token_type: "Bearer", ...(now.refresh ? { refresh_token: now.refresh } : {}), ...(this.o.client ? { issuer: this.o.client.issuer } : {}) };
    }
    return this.saved;
  }

  saveTokens(t: OAuthTokens) {
    const notes = this.o.target.notes;
    const used = this.saved ? { access: this.saved.access_token, ...(this.saved.refresh_token ? { refresh: this.saved.refresh_token } : {}) } : undefined;
    try {
      if (!this.onOrigin(t.issuer)) throw new ConnError(notes.elsewhere, 502);
      // One printable line each, at a refresh as at a sign-in: a token is put in a header as it is.
      if (!OAUTH_TOKEN.test(t.access_token) || (t.refresh_token !== undefined && !OAUTH_TOKEN.test(t.refresh_token))) throw new ConnError(notes.answer, 502);
      const only = this.o.target.grantOnly;
      if (only && (t.scope ?? "").split(/\s+/).some((g) => g !== "" && !only.includes(g))) {
        this.revoking = this.o.revoke?.([t.access_token, ...(t.refresh_token ? [t.refresh_token] : [])]).catch(() => false);
        // A refresh that widened the grant: the sign-in is over (the old refresh token was spent on it).
        if (!this.o.open && used) this.o.onExpired?.(used);
        throw new ConnError(notes.wider ?? notes.answer, 403);
      }
      this.o.onTokens?.(this.tokensOf(t), used);
    } catch (err) {
      this.failed = err;
      throw err;
    }
    this.saved = t;
  }

  current(): McpOAuthTokens | undefined {
    return this.saved ? this.tokensOf(this.saved) : undefined;
  }

  private tokensOf(t: OAuthTokens): McpOAuthTokens {
    const expiresIn = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : undefined;
    return {
      access: t.access_token,
      ...(t.refresh_token ? { refresh: t.refresh_token } : {}),
      ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      scopes: (t.scope ?? "").split(/\s+/).filter((s) => this.o.target.scopes.includes(s)),
    };
  }

  /** In a session nobody is there to sign in: the sign-in is expired, and the call fails with that sentence. */
  private expire(used: McpOAuthUsed): never {
    this.o.onExpired?.(used);
    throw new ConnError(this.o.target.notes.expired, 401);
  }

  async redirectToAuthorization(url: URL) {
    if (!this.o.open) {
      const failed = this.failed;
      this.failed = undefined;
      if (failed) throw failed;
      // Refused, or there was no refresh token to try: expired. Otherwise the SDK swallowed a refresh that didn't get
      // through (offline, a 5xx) and fell through to here: the sign-in stays as it is.
      if (this.refused) this.expire(this.refused);
      if (!this.saved?.refresh_token) this.expire({ access: this.saved?.access_token ?? "" });
      throw new ConnError(this.o.target.notes.unreachable, 503);
    }
    if (url.origin !== this.o.target.origin || url.username || url.password) throw new ConnError(this.o.target.notes.elsewhere, 502);
    await this.o.open(url.href);
  }

  saveCodeVerifier(v: string) {
    this.verifier = v;
  }

  codeVerifier() {
    if (!this.verifier) throw new ConnError(this.o.target.notes.answer, 502);
    return this.verifier;
  }

  saveDiscoveryState(s: OAuthDiscoveryState) {
    checkMcpDiscovery(this.o.target.origin, s, this.o.target.notes);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "tokens") {
      if (this.saved && !this.refused) this.refused = { access: this.saved.access_token, ...(this.saved.refresh_token ? { refresh: this.saved.refresh_token } : {}) };
      this.saved = undefined;
    }
    if (scope === "all" || scope === "verifier") this.verifier = "";
  }
}

export type McpSignIn = McpOAuthTokens & { client: OAuthClientRecord };

/** A failure as one of the target's sentences. */
export function oauthNote(err: unknown, notes: McpOAuthNotes): ConnError & { raw?: unknown } {
  if (err instanceof ConnError) return err;
  if (err instanceof LoopbackError) return new ConnError(err.kind === "timeout" ? notes.timeout : notes.denied, err.kind === "timeout" ? 408 : 403);
  const k = failureKind(err);
  // The raw error rides along for main's log (which cuts every secret it holds); the page gets the sentence.
  return Object.assign(new ConnError(k === "elsewhere" ? notes.elsewhere : k === "unreachable" ? notes.unreachable : notes.answer, 502), { raw: err });
}

/** An access token as Landlens will store it: one printable line. */
export const OAUTH_TOKEN = /^[\x21-\x7e]{16,2048}$/;

/**
 * The whole browser sign-in: a loopback listener, discovery and registration, the browser at the authorize page, the
 * code back on the loopback, the token exchange. Cancelled by `signal`.
 */
export async function mcpSignIn(o: { target: McpOAuthTarget; open: (url: string) => Promise<void>; signal: AbortSignal; fetch?: typeof fetch; timeoutMs?: number }): Promise<McpSignIn> {
  const state = randomBytes(32).toString("base64url");
  const lb = await openLoopback({ state, timeoutMs: o.timeoutMs ?? LOOPBACK_TIMEOUT });
  const onAbort = () => lb.close();
  o.signal.addEventListener("abort", onAbort, { once: true });
  const notes = o.target.notes;
  const fetchFn = pinnedFetch([o.target.origin], o.fetch ?? fetch);
  let provider: McpOAuth | undefined;
  try {
    // Cancel stops the browser too: discovery and registration may still be answering when it comes (L2).
    const open = async (url: string) => {
      if (o.signal.aborted) throw o.signal.reason;
      await o.open(url);
    };
    const revoke = (tokens: string[]) => {
      const client = provider?.storedClient();
      return client ? mcpRevoke(o.target.origin, tokens, client, o.fetch ?? fetch) : Promise.resolve(false);
    };
    provider = new McpOAuth({ target: o.target, redirectUri: lb.redirectUri, state, open, revoke });
    const opts = { serverUrl: o.target.resource, scope: o.target.scope, fetchFn };
    const first = await auth(provider, opts);
    if (first !== "REDIRECT") throw new ConnError(notes.answer, 502);
    const { code } = await lb.result;
    if (o.signal.aborted) throw o.signal.reason;
    if ((await auth(provider, { ...opts, authorizationCode: code })) !== "AUTHORIZED") throw new ConnError(notes.answer, 502);
    const t = provider.current();
    const client = provider.storedClient();
    if (!t || !client || !OAUTH_TOKEN.test(t.access) || (t.refresh !== undefined && !OAUTH_TOKEN.test(t.refresh))) throw new ConnError(notes.answer, 502);
    return { ...t, client };
  } catch (err) {
    await provider?.revoking;
    if (o.signal.aborted) throw o.signal.reason;
    throw oauthNote(err, notes);
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    lb.close();
  }
}

/**
 * Refresh a stored sign-in if it can be: the SDK's auth() with the stored client and refresh token. A refresh the
 * server refuses calls onExpired with the tokens it was tried with; one that doesn't get through throws unreachable.
 */
export async function mcpRefresh(o: { target: McpOAuthTarget; client: OAuthClientRecord; tokens: { access: string; refresh?: string }; onTokens: (t: McpOAuthTokens, used?: McpOAuthUsed) => void; onExpired: (used: McpOAuthUsed) => void; fetch?: typeof fetch }): Promise<McpOAuthTokens> {
  const revoke = (tokens: string[]) => mcpRevoke(o.target.origin, tokens, o.client, o.fetch ?? fetch);
  const provider = new McpOAuth({ target: o.target, redirectUri: o.client.redirect_uri, client: o.client, tokens: o.tokens, onTokens: o.onTokens, onExpired: o.onExpired, revoke });
  try {
    await auth(provider, { serverUrl: o.target.resource, scope: o.target.scope, fetchFn: pinnedFetch([o.target.origin], o.fetch ?? fetch) });
  } catch (err) {
    throw oauthNote(err, o.target.notes);
  }
  return provider.current()!;
}

/**
 * Best effort: revoke a sign-in at the revocation endpoint the server's metadata names (on its own origin only), each
 * request within 5 seconds. Every token given is revoked, in order (the access token, then the refresh token): true
 * only if all were.
 */
export async function mcpRevoke(origin: string, tokens: string | string[], client: OAuthClientRecord, base: typeof fetch = fetch): Promise<boolean> {
  const f = pinnedFetch([origin], base, 5_000);
  try {
    const m = JSON.parse(await readCapped(await f(`${origin}/.well-known/oauth-authorization-server`, { headers: { Accept: "application/json" } }), 256 * 1024)) as { revocation_endpoint?: unknown };
    if (typeof m.revocation_endpoint !== "string" || new URL(m.revocation_endpoint).origin !== origin) return false;
    let ok = true;
    for (const token of [...new Set(Array.isArray(tokens) ? tokens : [tokens])]) {
      const r = await f(m.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: client.client_id }).toString(),
      }).catch(() => undefined);
      ok = ok && !!r?.ok;
    }
    return ok;
  } catch {
    return false;
  }
}
