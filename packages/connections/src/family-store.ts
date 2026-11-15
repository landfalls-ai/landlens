// The Land family as stored (docs/family.md, wave 7 D101): userData/family.json, mode 0600, written through a new temp
// file and a rename. Per sibling: its address, who it is, its scopes, the switches, and safeStorage blobs: Landflow's
// key and its triage webhook's secret; Landfall's access and refresh tokens and its registered client. Clickland's key
// stays in its own store (clickland.json, ClicklandSettingsStore); its entry here holds only who that key is, and the
// origin it was read for, so a key saved for another address never shows the old account.
//
// A secret is bound to the origin it was saved for: storing another origin drops every secret that wasn't given again.
// The binding holds against the file too (wave 7 review, M2): each entry is sealed with an HMAC-SHA256 under a key made
// once per entry and kept encrypted beside it (wave 6's pin seal, store.ts), over everything in the entry. An entry
// changed by anything but this store (its address, account, scopes, switches, pin or a blob moved from another entry)
// doesn't verify, and is moved aside with the file like a damaged one. On a machine that can't encrypt, nothing is
// sealed (nothing there decrypts either).
//
// The switches and the accepted listing belong to one sign-in (M3): Disconnect, another address or another account
// turns Tools for Claude off, Reads run without asking back to on, and forgets the pin.
//
// Nothing here is returned to the renderer but FamilyInfo; secrets() is for main alone. A file that doesn't parse, or
// an entry that isn't what this store writes, is moved aside (family.json.damaged-…) and never written over.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { FAMILY_NOTES, type FamilyAccount, type FamilyInfo, type Sibling } from "@landlens/contracts";
import { z } from "zod";
import { FamilyError, landflowCan, landflowWrites, scopeList, SIBLINGS } from "./family.js";
import type { OAuthClientRecord } from "./mcp-oauth.js";
import { oneLine } from "./providers.js";
import type { Crypto } from "./store.js";

type Entry = {
  /** The origin. Landflow's and Landfall's; Clickland's address is in clickland.json. */
  url?: string;
  method?: "key" | "oauth";
  account?: FamilyAccount;
  scopes?: string[];
  toSessions?: boolean;
  readsAuto?: boolean;
  /** Clickland: the origin its key had when `account` and `scopes` were read. */
  keyOrigin?: string;
  /** Landflow: the triage webhook's path and header name, in clear (D121). */
  triage?: { path: string; header: string };
  /** base64 of safeStorage's ciphertext. */
  key?: string;
  triageSecret?: string;
  access?: string;
  refresh?: string;
  client?: string;
  /** ms since the epoch; in clear. */
  expiresAt?: number;
  /** A refresh was refused: the person has to sign in again. */
  expired?: boolean;
  /** The tool listing the person accepted for its server (D111), for the origin it was listed at. */
  pin?: FamilyPin;
  /** The seal's key: 32 random bytes, hex, encrypted with safeStorage (base64). */
  seal?: string;
  /** HMAC-SHA256 of the sibling and the rest of the entry under the seal's key. */
  mac?: string;
};
/**
 * An accepted listing (D111): its hash (approval.ts listingHash), each tool's short hash by name (for Review's diff),
 * and its reads and writes as Landlens counted them (D110). Bound to the origin it was listed at.
 */
export type FamilyPin = { origin: string; hash: string; tools: Record<string, string>; read: number; write: number };
type File = Partial<Record<Sibling, Entry>>;

const line = z.string().max(4096);
const blob = z.string().max(65_536);
const ENTRY = z.object({
  url: z.string().max(300).optional(),
  method: z.enum(["key", "oauth"]).optional(),
  account: z.object({ name: line.optional(), email: line.optional(), org: line.optional(), role: line.optional() }).strict().optional(),
  scopes: z.array(line).max(40).optional(),
  toSessions: z.boolean().optional(),
  readsAuto: z.boolean().optional(),
  keyOrigin: z.string().max(300).optional(),
  triage: z.object({ path: z.string().max(200), header: z.string().max(100) }).strict().optional(),
  key: blob.optional(),
  triageSecret: blob.optional(),
  access: blob.optional(),
  refresh: blob.optional(),
  client: blob.optional(),
  expiresAt: z.number().optional(),
  expired: z.boolean().optional(),
  pin: z.object({
    origin: z.string().max(300),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    tools: z.record(z.string().max(128), z.string().regex(/^[0-9a-f]{16}$/)).refine((t) => Object.keys(t).length <= 500, "at most 500 tools"),
    read: z.number().int().min(0).max(500),
    write: z.number().int().min(0).max(500),
  }).strict().optional(),
  seal: blob.optional(),
  mac: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

/** Off until the person turns it on (D108); reads run without asking once it is (D110). */
const DEFAULTS = { toSessions: false, readsAuto: true } as const;

/** Keep only what a FamilyAccount may hold: one line each, at most 100 characters. */
export function cleanFamilyAccount(a: FamilyAccount | undefined): FamilyAccount | undefined {
  if (!a) return undefined;
  const out: FamilyAccount = {};
  for (const k of ["name", "email", "org", "role"] as const) {
    const v = oneLine(a[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** JSON with every object's keys in order: the same entry always gives the same text. */
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);

/** The same person: by email, else by name, as each was cleaned. Unknown on either side is another person. */
const sameAccount = (a: FamilyAccount | undefined, b: FamilyAccount | undefined) => {
  const id = (x: FamilyAccount | undefined) => x?.email?.toLowerCase() ?? x?.name;
  return !!id(a) && id(a) === id(b);
};

/** Tools for Claude off, Reads run without asking back to on, the accepted listing gone (M3). */
const resetSwitches = (e: Entry) => {
  delete e.toSessions;
  delete e.readsAuto;
  delete e.pin;
};

const sameOrigin = (a: string | undefined, b: string | undefined) => {
  try {
    return !!a && !!b && new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

export type LandflowSecrets = { key: string; triageSecret?: string };
export type LandfallSecrets = { access: string; refresh?: string; expiresAt?: number; client?: OAuthClientRecord };

export class FamilyStore {
  constructor(private readonly path: string, private readonly crypto: Crypto) {}

  /** Encryption that is real: not on Linux's basic_text backend, a key fixed in the app (wave 6, L1). */
  get canStore(): boolean {
    if (!this.crypto.isEncryptionAvailable()) return false;
    try {
      return this.crypto.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return true;
    }
  }

  /** Where a damaged file was moved, if one was. */
  damaged: string | undefined;

  private aside(): void {
    const to = `${this.path}.damaged-${Date.now()}`;
    try {
      renameSync(this.path, to);
      this.damaged = to;
    } catch {
      // gone already
    }
  }

  private read(): File {
    if (!existsSync(this.path)) return {};
    let s: unknown;
    try {
      s = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.aside();
      return {};
    }
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      this.aside();
      return {};
    }
    const out: File = {};
    let bad = false;
    for (const [k, v] of Object.entries(s)) {
      if (!(SIBLINGS as readonly string[]).includes(k)) continue;
      const e = ENTRY.safeParse(v);
      if (e.success && this.holds(k as Sibling, e.data as Entry)) out[k as Sibling] = e.data as Entry;
      else bad = true;
    }
    if (bad) {
      this.aside();
      this.write(out);
    }
    return out;
  }

  /** The seal's key for an entry, made (and stored encrypted in it) if it has none and `make`. */
  private sealKey(e: Entry, make: boolean): Buffer | undefined {
    const k = this.dec(e.seal);
    if (k && /^[0-9a-f]{64}$/.test(k)) return Buffer.from(k, "hex");
    if (!make) return undefined;
    const fresh = randomBytes(32);
    e.seal = this.enc(fresh.toString("hex"));
    return fresh;
  }

  private mac(s: Sibling, key: Buffer, e: Entry): string {
    const { seal: _seal, mac: _mac, ...rest } = e;
    return createHmac("sha256", key).update(`family\0${s}\0${canon(rest)}`).digest("hex");
  }

  /** Whether an entry read from the file is one this store sealed, unchanged. */
  private holds(s: Sibling, e: Entry): boolean {
    if (!this.canStore) return true;
    const key = e.mac ? this.sealKey(e, false) : undefined;
    if (!key || !e.mac) return false;
    return timingSafeEqual(Buffer.from(this.mac(s, key, e), "hex"), Buffer.from(e.mac, "hex"));
  }

  private write(f: File) {
    if (this.canStore) {
      for (const s of SIBLINGS) {
        const e = f[s];
        if (e) e.mac = this.mac(s, this.sealKey(e, true)!, e);
      }
    }
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    chmodSync(this.path, 0o600);
  }

  private update(s: Sibling, f: (e: Entry) => void) {
    const all = this.read();
    const e: Entry = { ...(all[s] ?? {}) };
    f(e);
    all[s] = e;
    this.write(all);
  }

  private enc(plain: string): string {
    if (!this.canStore) throw new FamilyError(409, FAMILY_NOTES.cantStore);
    return this.crypto.encryptString(plain).toString("base64");
  }

  private dec(b: string | undefined): string | undefined {
    if (!b || !this.canStore) return undefined;
    try {
      return this.crypto.decryptString(Buffer.from(b, "base64"));
    } catch {
      return undefined;
    }
  }

  /** The stored origin of Landflow or Landfall, if any (kept across Disconnect, so the card can offer it again). */
  url(s: "landflow" | "landfall"): string | undefined {
    return this.read()[s]?.url;
  }

  /**
   * What the renderer may know about Landflow or Landfall. State is off, ready or expired here; main adds connecting
   * and failed. Clickland's is made in main from clickland.json and clicklandWho().
   */
  info(s: "landflow" | "landfall"): FamilyInfo {
    const e = this.read()[s] ?? {};
    const connected = s === "landflow" ? !!e.key : !!e.access;
    // Held to D100's shapes as they leave, as well as when they were stored.
    const scopes = connected && e.scopes ? scopeList(e.scopes) : undefined;
    const account = connected ? cleanFamilyAccount(e.account) : undefined;
    const base: FamilyInfo = {
      sibling: s,
      state: !connected ? "off" : e.expired ? "expired" : "ready",
      url: e.url ?? "",
      toSessions: e.toSessions ?? DEFAULTS.toSessions,
      readsAuto: e.readsAuto ?? DEFAULTS.readsAuto,
      ...(connected && e.method ? { method: e.method } : {}),
      ...(account ? { account } : {}),
      ...(scopes ? { scopes } : {}),
    };
    if (s === "landfall") return { ...base, ...(connected && e.expired ? { note: FAMILY_NOTES.landfallExpired } : {}) };
    return {
      ...base,
      ...(connected && scopes ? { can: landflowCan(scopes) } : {}),
      ...(connected && scopes && landflowWrites(scopes) ? { note: FAMILY_NOTES.landflowWrites } : {}),
      ...(e.triage ? { triage: { path: e.triage.path, header: e.triage.header, hasSecret: !!e.triageSecret && connected } } : {}),
    };
  }

  /** The switches for any sibling (D108, D110). */
  prefs(s: Sibling): { toSessions: boolean; readsAuto: boolean } {
    const e = this.read()[s] ?? {};
    return { toSessions: e.toSessions ?? DEFAULTS.toSessions, readsAuto: e.readsAuto ?? DEFAULTS.readsAuto };
  }

  setPrefs(s: Sibling, p: { toSessions?: boolean; readsAuto?: boolean }) {
    this.update(s, (e) => {
      if (p.toSessions !== undefined) e.toSessions = p.toSessions;
      if (p.readsAuto !== undefined) e.readsAuto = p.readsAuto;
    });
  }

  /**
   * Store Landflow's key for an origin, with who it is. Another origin than the stored one drops the triage secret
   * (it was saved for the other address); the webhook's path and header name stay. Another origin or another person
   * than the stored ones also resets the switches and the accepted listing (M3).
   */
  saveLandflow(c: { url: string; key: string; account?: FamilyAccount; scopes: string[] }) {
    if (!this.canStore) throw new FamilyError(409, FAMILY_NOTES.cantStore);
    const key = this.enc(c.key);
    this.update("landflow", (e) => {
      const account = cleanFamilyAccount(c.account);
      if (!sameOrigin(e.url, c.url)) delete e.triageSecret;
      if (!sameOrigin(e.url, c.url) || !e.key || !sameAccount(e.account, account)) resetSwitches(e);
      e.url = new URL(c.url).origin;
      e.method = "key";
      e.key = key;
      if (account) e.account = account;
      else delete e.account;
      e.scopes = scopeList(c.scopes);
      delete e.expired;
    });
  }

  /** Landflow's account and scopes as a later who-am-I read them (the key unchanged). */
  setLandflowWho(c: { account?: FamilyAccount; scopes: string[] }) {
    this.update("landflow", (e) => {
      if (!e.key) return;
      const account = cleanFamilyAccount(c.account);
      if (account) e.account = account;
      else delete e.account;
      e.scopes = scopeList(c.scopes);
    });
  }

  /**
   * The triage webhook (D121): its path and header name, and its secret, encrypted and bound to Landflow's stored
   * origin. Absent `secret` keeps the stored one; `null` removes the webhook and its secret. Landflow must be connected.
   */
  setTriage(t: { path: string; header: string; secret?: string } | null) {
    const e = this.read().landflow;
    if (!e?.key) throw new FamilyError(409, FAMILY_NOTES.connectLandflow);
    const secret = t?.secret !== undefined ? this.enc(t.secret) : undefined;
    this.update("landflow", (x) => {
      if (!t) {
        delete x.triage;
        delete x.triageSecret;
        return;
      }
      x.triage = { path: t.path, header: t.header };
      if (secret) x.triageSecret = secret;
    });
  }

  /**
   * Store a Landfall sign-in for an origin (D103): tokens and client encrypted. Landfall names no account to Landlens,
   * so a new sign-in can't be shown to be the same person: the switches and the accepted listing start over (M3).
   */
  saveLandfall(c: { url: string; access: string; refresh?: string; expiresAt?: number; client: OAuthClientRecord; scopes: string[] }) {
    if (!this.canStore) throw new FamilyError(409, FAMILY_NOTES.cantStore);
    const access = this.enc(c.access);
    const refresh = c.refresh ? this.enc(c.refresh) : undefined;
    const client = this.enc(JSON.stringify(c.client));
    this.update("landfall", (e) => {
      for (const k of ["account", "scopes", "refresh", "client", "expiresAt", "expired"] as const) delete e[k];
      resetSwitches(e);
      e.url = new URL(c.url).origin;
      e.method = "oauth";
      e.access = access;
      if (refresh) e.refresh = refresh;
      e.client = client;
      if (c.expiresAt) e.expiresAt = c.expiresAt;
      e.scopes = scopeList(c.scopes);
    });
  }

  /**
   * A refresh gave Landfall new tokens: stored only if the sign-in is still the one the refresh was made with (the same
   * origin, and the refresh token, or else the access token, it used). False if not: the caller revokes them at the
   * origin they came from (M1), so a slow answer from the last server never lands under another's address.
   */
  setTokens(t: { access: string; refresh?: string; expiresAt?: number }, made: { origin: string; used: { access: string; refresh?: string } }): boolean {
    const access = this.enc(t.access);
    const refresh = t.refresh ? this.enc(t.refresh) : undefined;
    let kept = false;
    this.update("landfall", (e) => {
      if (!e.access || !sameOrigin(e.url, made.origin)) return;
      if (made.used.refresh ? this.dec(e.refresh) !== made.used.refresh : this.dec(e.access) !== made.used.access) return;
      e.access = access;
      if (refresh) e.refresh = refresh;
      if (t.expiresAt) e.expiresAt = t.expiresAt;
      else delete e.expiresAt;
      delete e.expired;
      kept = true;
    });
    return kept;
  }

  markExpired() {
    this.update("landfall", (e) => {
      if (e.access) e.expired = true;
    });
  }

  /** Who Clickland's key is, read for the key's origin. */
  setClicklandWho(keyOrigin: string, who: { account?: FamilyAccount; scopes: string[] }) {
    this.update("clickland", (e) => {
      e.keyOrigin = new URL(keyOrigin).origin;
      const account = cleanFamilyAccount(who.account);
      if (account) e.account = account;
      else delete e.account;
      e.scopes = scopeList(who.scopes);
    });
  }

  /** The accepted listing, if it was accepted for this origin (D111). */
  pin(s: Sibling, origin: string | undefined): FamilyPin | undefined {
    const p = this.read()[s]?.pin;
    return p && sameOrigin(p.origin, origin) ? p : undefined;
  }

  /** Accept a listing for a sibling's server at an origin (D111): at Tools for Claude, Check, or Accept. */
  setPin(s: Sibling, pin: FamilyPin) {
    this.update(s, (e) => {
      e.pin = { ...pin, origin: new URL(pin.origin).origin };
    });
  }

  /** Tools for Claude off, Reads run without asking on, no accepted listing: Clickland's key or origin changed (M3). */
  resetSwitches(s: Sibling) {
    const e = this.read()[s];
    if (!e || (e.toSessions === undefined && e.readsAuto === undefined && !e.pin)) return;
    this.update(s, resetSwitches);
  }

  /** Clickland's key changed: who the old one was no longer counts. */
  forgetClicklandWho() {
    const all = this.read();
    const e = all.clickland;
    if (!e || (!e.keyOrigin && !e.account && !e.scopes)) return;
    delete e.keyOrigin;
    delete e.account;
    delete e.scopes;
    this.write(all);
  }

  /** Who Clickland's key is, if it was read for this origin. */
  clicklandWho(keyOrigin: string | undefined): { account?: FamilyAccount; scopes: string[] } | undefined {
    const e = this.read().clickland;
    if (!e?.keyOrigin || !e.scopes || !sameOrigin(e.keyOrigin, keyOrigin)) return undefined;
    const account = cleanFamilyAccount(e.account);
    return { ...(account ? { account } : {}), scopes: scopeList(e.scopes) };
  }

  /** Main only: Landflow's key and webhook secret, decrypted, if its key is stored and decrypts. */
  landflowSecrets(): (LandflowSecrets & { url: string }) | undefined {
    const e = this.read().landflow;
    const key = this.dec(e?.key);
    if (!e?.url || !key) return undefined;
    const triageSecret = this.dec(e.triageSecret);
    return { url: e.url, key, ...(triageSecret ? { triageSecret } : {}) };
  }

  /** Main only: Landfall's tokens and client, decrypted. */
  landfallSecrets(): (LandfallSecrets & { url: string }) | undefined {
    const e = this.read().landfall;
    const access = this.dec(e?.access);
    if (!e?.url || !access) return undefined;
    const refresh = this.dec(e.refresh);
    let client: OAuthClientRecord | undefined;
    const c = this.dec(e.client);
    if (c) {
      try {
        const j = JSON.parse(c);
        if (typeof j?.client_id === "string" && typeof j.issuer === "string" && typeof j.redirect_uri === "string") client = { client_id: j.client_id, issuer: j.issuer, redirect_uri: j.redirect_uri };
      } catch {
        // an unreadable client means signing in again
      }
    }
    return { url: e.url, access, ...(refresh ? { refresh } : {}), ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}), ...(client ? { client } : {}) };
  }

  /**
   * Forget a sign-in (D103): every blob, the account and scopes, the switches and the accepted listing (M3: they were
   * the person's choice for that sign-in). The address and the webhook's path and header name stay, for the form; the
   * webhook's secret goes.
   */
  remove(s: Sibling) {
    const all = this.read();
    const e = all[s];
    if (!e) return;
    const next: Entry = {};
    if (e.url) next.url = e.url;
    if (e.triage) next.triage = e.triage;
    all[s] = next;
    this.write(all);
  }
}
