// The Land family's clients (docs/family.md, wave 7 D100–D103): who a key is at Clickland and Landflow, whether a
// Landfall offers its MCP connector, and Landfall's sign-in as an McpOAuth target. Used from Electron main only.
//
// Every request goes through pinnedFetch to the one origin it was given (no redirects, 8 s for the health and who-am-I
// reads), the key only in the Authorization header. What a sibling answers is reduced to a few checked fields (one
// line each, at most 100 characters; scopes as words); a failure is one of FAMILY_NOTES, never the answer's text. The
// raw error stays in `cause`, for main's log through rawError.
import { FAMILY_NOTES, familyHttpNote, type FamilyAccount, type Sibling } from "@landlens/contracts";
import { z } from "zod";
import { type McpOAuthNotes, type McpOAuthTarget } from "./mcp-oauth.js";
import { failureKind, oneLine, OriginRefused, pinnedFetch } from "./providers.js";

export const SIBLINGS: readonly Sibling[] = ["clickland", "landflow", "landfall"];
export const SIBLING_NAME = { clickland: "Clickland", landflow: "Landflow", landfall: "Landfall" } as const satisfies Record<Sibling, string>;

/** The health and who-am-I reads. */
export const FAMILY_READ_TIMEOUT = 8_000;

export class FamilyError extends Error {
  constructor(readonly status: number, message: string, readonly raw?: unknown) {
    super(message);
  }
}

/** An address as stored: its origin. Throws if it isn't an http(s) URL. */
export function originOf(url: string): string {
  const u = new URL(url);
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw new FamilyError(400, FAMILY_NOTES.httpOnlyHere);
  return u.origin;
}

const SLOW: Record<Sibling, string> = { clickland: FAMILY_NOTES.clicklandSlow, landflow: FAMILY_NOTES.landflowSlow, landfall: FAMILY_NOTES.landfallSlow };
const ANSWER: Record<Sibling, string> = { clickland: FAMILY_NOTES.clicklandAnswer, landflow: FAMILY_NOTES.landflowAnswer, landfall: FAMILY_NOTES.landfallAnswer };
const REFUSED: Record<Sibling, string> = { clickland: FAMILY_NOTES.clicklandRefused, landflow: FAMILY_NOTES.landflowRefused, landfall: FAMILY_NOTES.landfallExpired };

/** A request that didn't get an answer, as its sentence. */
function sentFailed(s: Sibling, err: unknown): FamilyError {
  const e = err as { name?: string; cause?: { name?: string } };
  if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") return new FamilyError(504, SLOW[s], err);
  if (err instanceof OriginRefused) return new FamilyError(400, ANSWER[s], err);
  const k = failureKind(err);
  // A redirect is refused (redirect: "error"): the address answers, but not as the sibling should.
  return k === "answer" ? new FamilyError(502, ANSWER[s], err) : new FamilyError(502, FAMILY_NOTES.unreachable, err);
}

/** At most this much of an answer is read (who-am-I and health are small). */
const MAX_ANSWER = 256 * 1024;

/** GET a JSON answer from the sibling. A 401 or 403 is "refused"; any other non-2xx its HTTP sentence. */
async function getJson(s: Sibling, origin: string, path: string, key: string | undefined, base: typeof fetch): Promise<unknown> {
  const f = pinnedFetch([origin], base, FAMILY_READ_TIMEOUT);
  let r: Response;
  try {
    r = await f(`${origin}${path}`, { headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  } catch (err) {
    throw sentFailed(s, err);
  }
  if (key && (r.status === 401 || r.status === 403)) throw new FamilyError(401, REFUSED[s]);
  if (!r.ok) throw new FamilyError(502, familyHttpNote(SIBLING_NAME[s], r.status));
  let text: string;
  try {
    text = await r.text();
  } catch (err) {
    throw sentFailed(s, err);
  }
  if (text.length > MAX_ANSWER) throw new FamilyError(502, ANSWER[s]);
  try {
    return JSON.parse(text);
  } catch {
    throw new FamilyError(502, ANSWER[s]);
  }
}

const Health = z.object({ status: z.string().max(32), version: z.string().max(64).optional() });

/** GET /api/health (no key sent): "ok" or not, and a version that looks like one. Clickland and Landflow. */
export async function siblingHealth(s: "clickland" | "landflow", origin: string, base: typeof fetch = fetch): Promise<{ ok: boolean; version?: string }> {
  const r = Health.safeParse(await getJson(s, origin, "/api/health", undefined, base));
  if (!r.success) throw new FamilyError(502, ANSWER[s]);
  const version = r.data.version && /^[0-9A-Za-z.+_-]{1,40}$/.test(r.data.version) ? r.data.version : undefined;
  return { ok: r.data.status === "ok", ...(version ? { version } : {}) };
}

const account = (a: { name?: unknown; email?: unknown; org?: unknown; role?: unknown }): FamilyAccount | undefined => {
  const out: FamilyAccount = {};
  for (const k of ["name", "email", "org", "role"] as const) {
    const v = oneLine(a[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
};
/** Scopes as a list of words: each item whole (1–40 of letters, digits, ":", "_", "-"), at most 20. */
export const scopeList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^[a-z][a-z0-9:_-]{0,39}$/i.test(x)))].slice(0, 20) : [];
const scopesOf = scopeList;

/** What a Clickland key may do beyond Landlens's reads. */
export const CLICKLAND_READ_SCOPES = ["read", "usage:read"] as const;

export type ClicklandWho = { account?: FamilyAccount; scopes: string[]; writes: boolean };

/**
 * Who a Clickland key is: GET /api/auth/me with it (D103). A key is `kind: key` (or the bootstrap key, or anyone on a
 * Clickland in dev mode, which names no kind); a person's session isn't something a bearer can be.
 */
export async function clicklandWho(origin: string, key: string, base: typeof fetch = fetch): Promise<ClicklandWho> {
  const j = (await getJson("clickland", origin, "/api/auth/me", key, base)) as { kind?: unknown; user?: { name?: unknown; email?: unknown; roles?: unknown }; role?: unknown; scopes?: unknown } | null;
  if (!j || typeof j !== "object" || !Array.isArray(j.scopes) || (j.kind !== undefined && j.kind !== "key" && j.kind !== "bootstrap" && j.kind !== "dev")) throw new FamilyError(502, FAMILY_NOTES.clicklandAnswer);
  const scopes = scopesOf(j.scopes);
  const role = typeof j.role === "string" ? j.role : Array.isArray(j.user?.roles) ? j.user!.roles[0] : undefined;
  const a = account({ name: j.user?.name, role });
  return { ...(a ? { account: a } : {}), scopes, writes: scopes.some((s) => !(CLICKLAND_READ_SCOPES as readonly string[]).includes(s)) };
}

export type LandflowCan = { brain: boolean; run: boolean; runs: boolean; flows: boolean };
/** What a Landflow key's scopes cover (D103). `admin` covers everything. */
export function landflowCan(scopes: readonly string[]): LandflowCan {
  const has = (s: string) => scopes.includes(s) || scopes.includes("admin");
  return { brain: has("brain:write"), run: has("run"), runs: has("executions:read"), flows: has("workflows:read") };
}
/** A key that can change workflows, which Landlens never needs. */
export const landflowWrites = (scopes: readonly string[]) => scopes.includes("admin") || scopes.includes("workflows:write");

export type LandflowWho = { account?: FamilyAccount; scopes: string[] };

/** Who a Landflow key is: GET /api/auth/me with it, which must answer `via: "api-key"` (D103). */
export async function landflowWho(origin: string, key: string, base: typeof fetch = fetch): Promise<LandflowWho> {
  const j = (await getJson("landflow", origin, "/api/auth/me", key, base)) as { user?: { name?: unknown; email?: unknown; role?: unknown }; via?: unknown; apiKey?: { scopes?: unknown } } | null;
  if (!j || typeof j !== "object" || !j.user || typeof j.user !== "object") throw new FamilyError(502, FAMILY_NOTES.landflowAnswer);
  if (j.via !== "api-key" || !j.apiKey || !Array.isArray(j.apiKey.scopes)) throw new FamilyError(401, FAMILY_NOTES.landflowNotKey);
  const a = account({ name: j.user.name, email: j.user.email, role: j.user.role });
  return { ...(a ? { account: a } : {}), scopes: scopesOf(j.apiKey.scopes) };
}

export const LANDFALL_NOTES: McpOAuthNotes = {
  answer: FAMILY_NOTES.landfallAnswer,
  elsewhere: FAMILY_NOTES.landfallElsewhere,
  expired: FAMILY_NOTES.landfallExpired,
  unreachable: FAMILY_NOTES.landfallUnreachable,
  denied: FAMILY_NOTES.landfallDenied,
  timeout: FAMILY_NOTES.landfallTimeout,
};
/** The one scope Landlens asks Landfall for: never `mcp:ack` (D103). */
export const LANDFALL_SCOPE = "mcp:read";

/** Landfall's hosted connector as an OAuth target: resource `<origin>/mcp`, everything on that origin, read only. */
export function landfallTarget(origin: string): McpOAuthTarget {
  return { resource: `${origin}/mcp`, origin, clientName: "Landlens", scope: LANDFALL_SCOPE, scopes: ["mcp:read", "mcp:ack"], notes: LANDFALL_NOTES };
}

/**
 * Whether this Landfall offers its connector: its authorization-server metadata answers, names itself as the issuer
 * and has its endpoints on its own origin. A 404 (the flag is off, today's local one) is landfallOff.
 */
export async function landfallConnector(origin: string, base: typeof fetch = fetch): Promise<void> {
  let m: unknown;
  try {
    m = await getJson("landfall", origin, "/.well-known/oauth-authorization-server", undefined, base);
  } catch (err) {
    if (err instanceof FamilyError && /answered HTTP 404\.$/.test(err.message)) throw new FamilyError(409, FAMILY_NOTES.landfallOff);
    throw err;
  }
  const o = m as Record<string, unknown> | null;
  const on = (u: unknown) => {
    try {
      return typeof u === "string" && new URL(u).origin === origin;
    } catch {
      return false;
    }
  };
  if (!o || typeof o !== "object" || !on(o.issuer) || !on(o.authorization_endpoint) || !on(o.token_endpoint)) throw new FamilyError(502, FAMILY_NOTES.landfallElsewhere);
}
