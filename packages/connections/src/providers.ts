// The providers Landlens signs in to, and every address a provider's token may go to. Addresses are constants here:
// no channel takes one, and the page names a provider, never an address. An unpackaged build may swap all of a
// provider's origins for one loopback fake (LANDLENS_GITHUB_ENDPOINT, LANDLENS_LINEAR_ENDPOINT; main decides that,
// see apps/desktop/src/main/connections.ts), so tests never reach the real hosts.
import type { ConnProvider } from "@landlens/contracts";

export type Provider = ConnProvider;
export const PROVIDERS: readonly Provider[] = ["github", "linear"];
export const PROVIDER_NAME: Record<Provider, string> = { github: "GitHub", linear: "Linear" };

/**
 * Landlens's OAuth App for GitHub's device flow. It needs registering under landfalls-ai ("Landlens", device flow
 * enabled, no callback used; docs/connections.md). Until then it is empty, the device flow isn't offered and only a
 * pasted token works. A client id is public; no client secret is needed or shipped.
 */
export const GITHUB_CLIENT_ID = "";
/** What the device flow asks GitHub for. */
export const GITHUB_SCOPE = "repo read:org read:user";
/** Where the person enters the device code: always this constant, whatever GitHub's answer says. */
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device" as const;
/** Where an OAuth app's grant is revoked (Landlens has no client secret, so it can't revoke one itself). */
export const GITHUB_GRANTS_PAGE = "https://github.com/settings/applications";

/** The scope Landlens asks Linear for in each mode. */
export const LINEAR_SCOPE = { read: "read", ask: "read write" } as const;

/** A loopback fake's origin: plain http, 127.0.0.1, a port. Nothing else may replace a provider's hosts. */
export const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export type GithubEndpoints = {
  /** github.com: the device flow. No token is sent there. */
  deviceCode: string;
  accessToken: string;
  /** api.github.com: who you are (GET /user only). */
  user: string;
  /** api.githubcopilot.com: GitHub's remote MCP server, and its read-only listing. */
  mcp: string;
  mcpReadonly: string;
  /** The origins a GitHub token may be sent to. */
  tokenOrigins: string[];
  /** Every origin Landlens talks to for GitHub. */
  origins: string[];
};

export type LinearEndpoints = {
  /** mcp.linear.app: the MCP server, which is also its own authorization server (token, register, revoke). */
  mcp: string;
  mcpReadonly: string;
  authOrigin: string;
  /** api.linear.app: who you are, for a pasted key (`viewer` only). */
  graphql: string;
  tokenOrigins: string[];
  origins: string[];
};

function checkOverride(o: string | undefined): string | undefined {
  if (o === undefined) return undefined;
  if (!LOOPBACK_ORIGIN.test(o)) throw new Error("a provider override must be http://127.0.0.1:<port>");
  return o;
}

export function githubEndpoints(override?: string): GithubEndpoints {
  const o = checkOverride(override);
  const login = o ?? "https://github.com";
  const api = o ?? "https://api.github.com";
  const copilot = o ?? "https://api.githubcopilot.com";
  return {
    deviceCode: `${login}/login/device/code`,
    accessToken: `${login}/login/oauth/access_token`,
    user: `${api}/user`,
    mcp: `${copilot}/mcp/`,
    mcpReadonly: `${copilot}/mcp/readonly`,
    tokenOrigins: [...new Set([api, copilot])],
    origins: [...new Set([login, api, copilot])],
  };
}

export function linearEndpoints(override?: string): LinearEndpoints {
  const o = checkOverride(override);
  const mcp = o ?? "https://mcp.linear.app";
  const api = o ?? "https://api.linear.app";
  return {
    mcp: `${mcp}/mcp`,
    mcpReadonly: `${mcp}/mcp/readonly`,
    authOrigin: mcp,
    graphql: `${api}/graphql`,
    tokenOrigins: [...new Set([mcp, api])],
    origins: [...new Set([mcp, api])],
  };
}

export type Endpoints = { github: GithubEndpoints; linear: LinearEndpoints };
export const endpoints = (overrides: { github?: string; linear?: string } = {}): Endpoints => ({
  github: githubEndpoints(overrides.github),
  linear: linearEndpoints(overrides.linear),
});

export const REQUEST_TIMEOUT = 15_000;

/** Thrown before a request leaves for an origin that isn't the provider's. */
export class OriginRefused extends Error {
  constructor(readonly origin: string) {
    super(`Landlens doesn't send this provider's requests to ${origin}`);
  }
}

const originOf = (u: string | URL) => {
  try {
    return new URL(String(u)).origin;
  } catch {
    return "";
  }
};

/**
 * fetch for one provider: only to its origins, never following a redirect (a redirect would carry the token
 * elsewhere), always with a time limit.
 */
export function pinnedFetch(origins: readonly string[], base: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT): typeof fetch {
  const allowed = new Set(origins);
  return (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const o = originOf(url);
    if (!allowed.has(o)) return Promise.reject(new OriginRefused(o || "an address that isn't one"));
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return base(input, { ...init, redirect: "error", signal });
  };
}

/** An answer over the size limit; the read was stopped there. */
export class TooLarge extends Error {
  constructor(readonly max: number) {
    super(`the answer is over ${max} bytes`);
  }
}

/**
 * An answer's body as text, at most `max` bytes: a Content-Length over the limit is refused before reading, and a body
 * that streams past it is cancelled there (the connection closes), so a server can't fill main's memory.
 */
export async function readCapped(r: Response, max: number): Promise<string> {
  const declared = Number(r.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await r.body?.cancel().catch(() => {});
    throw new TooLarge(max);
  }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge(max);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One line of text a provider sent, safe for a text node: control, format and separator characters gone, cut. */
export function oneLine(v: unknown, max = 100): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
}

/** Scopes as a provider listed them: words only, at most 20. */
export function cleanScopes(raw: string | null | undefined, sep: RegExp = /[\s,]+/): string[] {
  return (raw ?? "").split(sep).map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9:_-]{0,39}$/i.test(s)).slice(0, 20);
}

/** Why a request failed, as a kind the caller turns into one of the fixed notes. */
export function failureKind(err: unknown): "refused" | "unreachable" | "answer" | "elsewhere" {
  if (err instanceof OriginRefused) return "elsewhere";
  const e = err as { status?: unknown; name?: string; message?: string; cause?: { code?: string } };
  if (e?.status === 401 || e?.status === 403) return "refused";
  if (typeof e?.status === "number") return "answer";
  if (/redirect/i.test(String(e?.message ?? "")) || /redirect/i.test(String(e?.cause ?? ""))) return "answer";
  return "unreachable";
}
