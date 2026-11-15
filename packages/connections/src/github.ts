// Signing in to GitHub: the OAuth device flow (Landlens shows the code; the person types it at github.com), or a
// pasted token. Either way the token is checked once with GET /user, which says who it is and, for classic tokens,
// its scopes. Every request goes through pinnedFetch: GitHub's own origins only, no redirects, a time limit.
import { CONN_NOTES, GITHUB_TOKEN_SHAPE, type ConnAccount } from "@landlens/contracts";
import { cleanScopes, failureKind, GITHUB_SCOPE, oneLine, pinnedFetch, type GithubEndpoints } from "./providers.js";

/** A sign-in step failed; `note` is one of CONN_NOTES. */
export class ConnError extends Error {
  constructor(readonly note: string, readonly status = 400) {
    super(note);
  }
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** The longest Landlens waits for a device code to be entered, whatever GitHub says. */
export const DEVICE_MAX_MS = 15 * 60_000;

export type DeviceCode = { deviceCode: string; userCode: string; interval: number; expiresIn: number };

/** Ask GitHub for a device code. No secret: the client id is public. */
export async function startDeviceFlow(ep: GithubEndpoints, clientId: string, base: typeof fetch = fetch): Promise<DeviceCode> {
  if (!clientId) throw new ConnError(CONN_NOTES.noDevice, 409);
  const f = pinnedFetch(ep.origins, base);
  let j: Record<string, unknown>;
  try {
    const r = await f(ep.deviceCode, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: GITHUB_SCOPE }).toString(),
    });
    if (!r.ok) throw httpError(r.status);
    j = (await r.json()) as Record<string, unknown>;
  } catch (err) {
    throw new ConnError(failureKind(err) === "unreachable" ? CONN_NOTES.githubUnreachable : CONN_NOTES.githubAnswer, 502);
  }
  const deviceCode = typeof j.device_code === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(j.device_code) ? j.device_code : undefined;
  // GitHub's codes are XXXX-XXXX; shown in the page, so held to a plain shape.
  const userCode = typeof j.user_code === "string" && /^[A-Z0-9]{4,8}-?[A-Z0-9]{0,8}$/.test(j.user_code) ? j.user_code : undefined;
  if (!deviceCode || !userCode) throw new ConnError(CONN_NOTES.githubAnswer, 502);
  const interval = typeof j.interval === "number" && j.interval >= 1 && j.interval <= 60 ? Math.ceil(j.interval) : 5;
  const expiresIn = typeof j.expires_in === "number" && j.expires_in > 0 ? Math.min(Math.floor(j.expires_in), DEVICE_MAX_MS / 1000) : DEVICE_MAX_MS / 1000;
  return { deviceCode, userCode, interval, expiresIn };
}

export type Clock = { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const t = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
      const onAbort = () => (clearTimeout(t), reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * Wait for the person to enter the code: poll the token endpoint every `interval` seconds, five more after each
 * slow_down (or what GitHub says), until a token, a refusal, the code's expiry or 15 minutes. Cancelled by `signal`.
 */
export async function pollDeviceFlow(ep: GithubEndpoints, clientId: string, code: DeviceCode, signal: AbortSignal, opts: { fetch?: typeof fetch; clock?: Clock } = {}): Promise<{ access: string; scopes: string[] }> {
  const clock = opts.clock ?? realClock;
  const f = pinnedFetch(ep.origins, opts.fetch ?? fetch);
  const deadline = clock.now() + Math.min(code.expiresIn * 1000, DEVICE_MAX_MS);
  let interval = code.interval;
  let failures = 0;
  for (;;) {
    await clock.sleep(interval * 1000, signal);
    if (clock.now() >= deadline) throw new ConnError(CONN_NOTES.deviceExpired, 410);
    let j: Record<string, unknown>;
    try {
      const r = await f(ep.accessToken, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).toString(),
        signal,
      });
      if (!r.ok) throw httpError(r.status);
      j = (await r.json()) as Record<string, unknown>;
      failures = 0;
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      // A dropped poll is tried again at the next interval, three times in a row at most.
      if (++failures >= 3) throw new ConnError(failureKind(err) === "unreachable" ? CONN_NOTES.githubUnreachable : CONN_NOTES.githubAnswer, 502);
      continue;
    }
    if (typeof j.access_token === "string") {
      if (!GITHUB_TOKEN_SHAPE.test(j.access_token)) throw new ConnError(CONN_NOTES.githubAnswer, 502);
      return { access: j.access_token, scopes: cleanScopes(typeof j.scope === "string" ? j.scope : "") };
    }
    switch (j.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval = typeof j.interval === "number" && j.interval > interval && j.interval <= 120 ? Math.ceil(j.interval) : interval + 5;
        continue;
      case "expired_token":
        throw new ConnError(CONN_NOTES.deviceExpired, 410);
      case "access_denied":
        throw new ConnError(CONN_NOTES.deviceDenied, 403);
      default:
        throw new ConnError(CONN_NOTES.githubAnswer, 502);
    }
  }
}

/** Who a token is: GET /user. Scopes come from X-OAuth-Scopes (a fine-grained token sends none). */
export async function githubWhoAmI(ep: GithubEndpoints, token: string, base: typeof fetch = fetch): Promise<{ account: ConnAccount; scopes: string[] }> {
  // GET /user goes to api.github.com, one of the token's origins.
  const f = pinnedFetch(ep.tokenOrigins, base);
  let r: Response;
  try {
    r = await f(ep.user, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  } catch (err) {
    throw new ConnError(failureKind(err) === "unreachable" ? CONN_NOTES.githubUnreachable : CONN_NOTES.githubAnswer, 502);
  }
  if (r.status === 401 || r.status === 403) throw new ConnError(CONN_NOTES.githubRefused, 401);
  if (!r.ok) throw new ConnError(CONN_NOTES.githubAnswer, 502);
  let j: Record<string, unknown>;
  try {
    j = (await r.json()) as Record<string, unknown>;
  } catch {
    throw new ConnError(CONN_NOTES.githubAnswer, 502);
  }
  const login = typeof j.login === "string" && /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(j.login) ? j.login : undefined;
  if (!login) throw new ConnError(CONN_NOTES.githubAnswer, 502);
  const name = oneLine(j.name);
  return { account: { login, ...(name ? { name } : {}) }, scopes: cleanScopes(r.headers.get("x-oauth-scopes"), /\s*,\s*/) };
}
