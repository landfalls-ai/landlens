// Connections as stored: userData/connections.json, mode 0600, written through a temp file and a rename. Per
// provider: how it signed in, who as, its scopes, its level and switches, the pinned listing, and three blobs
// encrypted with Electron's safeStorage (the access token, a refresh token, Linear's registered client). Nothing
// here is returned to the renderer but ConnInfo; secrets() is for main alone.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CONN_NOTES, type ConnAccount, type ConnInfo, type ConnMethod, type ConnMode, type McpToolInfo } from "@landlens/contracts";
import { oneLine, cleanScopes, PROVIDERS, type Provider } from "./providers.js";

/** The part of Electron's safeStorage the store needs (a fake in tests). */
export type Crypto = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/** Linear's client, registered at sign-in with that sign-in's loopback redirect. */
export type LinearClient = { client_id: string; issuer: string; redirect_uri: string };
export type Secrets = { access: string; refresh?: string; expiresAt?: number; client?: LinearClient };

type Entry = {
  mode: ConnMode;
  readsAuto: boolean;
  /** "Give to Claude sessions" (D77). */
  give: boolean;
  method?: ConnMethod;
  account?: ConnAccount;
  scopes?: string[];
  /** listingHash(full) + "." + listingHash(readonly), accepted by the person (D80). */
  pin?: string;
  tools?: { read: number; write: number };
  /** The last listing's tools as the pages show them (names, descriptions, read or write), in clear. */
  list?: McpToolInfo[];
  /** base64 of safeStorage's ciphertext. */
  access?: string;
  refresh?: string;
  client?: string;
  /** ms since the epoch; in clear. */
  expiresAt?: number;
  /** A refresh was refused: the person has to sign in again. */
  expired?: boolean;
};
type File = Partial<Record<Provider, Entry>>;

const DEFAULTS: Pick<Entry, "mode" | "readsAuto" | "give"> = { mode: "ask", readsAuto: true, give: true };

export class StoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Keep only what a ConnAccount may hold: one line each, at most 100 characters. */
export function cleanAccount(a: { login?: unknown; name?: unknown; org?: unknown }): ConnAccount | undefined {
  const login = oneLine(a.login);
  if (!login) return undefined;
  const name = oneLine(a.name);
  const org = oneLine(a.org);
  return { login, ...(name ? { name } : {}), ...(org ? { org } : {}) };
}

export class ConnectionStore {
  constructor(private readonly path: string, private readonly crypto: Crypto) {}

  get canStore(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  private read(): File {
    if (!existsSync(this.path)) return {};
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      if (!s || typeof s !== "object") return {};
      const out: File = {};
      for (const p of PROVIDERS) if (s[p] && typeof s[p] === "object") out[p] = s[p];
      return out;
    } catch {
      return {};
    }
  }

  private write(f: File) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  private update(p: Provider, f: (e: Entry) => void) {
    const all = this.read();
    const e: Entry = { ...DEFAULTS, ...(all[p] ?? {}) };
    f(e);
    all[p] = e;
    this.write(all);
  }

  private enc(s: string): string {
    if (!this.canStore) throw new StoreError(409, CONN_NOTES.cantStore);
    return this.crypto.encryptString(s).toString("base64");
  }

  private dec(b: string | undefined): string | undefined {
    if (!b || !this.canStore) return undefined;
    try {
      return this.crypto.decryptString(Buffer.from(b, "base64"));
    } catch {
      return undefined;
    }
  }

  /** What the renderer may know. State is off, ready or expired here; main adds connecting and failed. */
  info(p: Provider): ConnInfo {
    const e = { ...DEFAULTS, ...(this.read()[p] ?? {}) };
    const connected = !!e.access;
    return {
      provider: p,
      state: !connected ? "off" : e.expired ? "expired" : "ready",
      ...(connected && e.method ? { method: e.method } : {}),
      ...(connected && e.account ? { account: e.account } : {}),
      ...(connected && e.scopes ? { scopes: e.scopes } : {}),
      mode: e.mode,
      readsAuto: e.readsAuto,
      give: e.give,
      ...(connected && e.tools ? { tools: e.tools } : {}),
      ...(connected && e.expired && p === "linear" ? { note: CONN_NOTES.linearExpired } : {}),
    };
  }

  /** Store a new sign-in, replacing whatever was stored for the provider (its level and switches stay). */
  save(p: Provider, c: { method: ConnMethod; access: string; refresh?: string; expiresAt?: number; client?: LinearClient; account?: ConnAccount; scopes?: string[] }) {
    if (!this.canStore) throw new StoreError(409, CONN_NOTES.cantStore);
    const access = this.enc(c.access);
    const refresh = c.refresh ? this.enc(c.refresh) : undefined;
    const client = c.client ? this.enc(JSON.stringify(c.client)) : undefined;
    this.update(p, (e) => {
      for (const k of ["account", "scopes", "pin", "tools", "list", "refresh", "client", "expiresAt", "expired"] as const) delete e[k];
      e.method = c.method;
      e.access = access;
      if (refresh) e.refresh = refresh;
      if (client) e.client = client;
      if (c.expiresAt) e.expiresAt = c.expiresAt;
      const account = c.account ? cleanAccount(c.account) : undefined;
      if (account) e.account = account;
      if (c.scopes) e.scopes = cleanScopes(c.scopes.join(" "));
    });
  }

  /** Main only: the provider's tokens and client, decrypted. Undefined if none is stored or it doesn't decrypt. */
  secrets(p: Provider): Secrets | undefined {
    const e = this.read()[p];
    const access = this.dec(e?.access);
    if (!e || !access) return undefined;
    const refresh = this.dec(e.refresh);
    let client: LinearClient | undefined;
    const c = this.dec(e.client);
    if (c) {
      try {
        const j = JSON.parse(c);
        if (typeof j?.client_id === "string" && typeof j.issuer === "string" && typeof j.redirect_uri === "string") client = { client_id: j.client_id, issuer: j.issuer, redirect_uri: j.redirect_uri };
      } catch {
        // an unreadable client means signing in again
      }
    }
    return { access, ...(refresh ? { refresh } : {}), ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}), ...(client ? { client } : {}) };
  }

  /** A refresh gave new tokens. */
  setTokens(p: Provider, t: { access: string; refresh?: string; expiresAt?: number }) {
    const access = this.enc(t.access);
    const refresh = t.refresh ? this.enc(t.refresh) : undefined;
    this.update(p, (e) => {
      if (!e.access) return;
      e.access = access;
      if (refresh) e.refresh = refresh;
      if (t.expiresAt) e.expiresAt = t.expiresAt;
      else delete e.expiresAt;
      delete e.expired;
    });
  }

  markExpired(p: Provider) {
    this.update(p, (e) => {
      if (e.access) e.expired = true;
    });
  }

  setPrefs(p: Provider, prefs: { mode?: ConnMode; readsAuto?: boolean; give?: boolean }) {
    this.update(p, (e) => {
      if (prefs.mode) e.mode = prefs.mode;
      if (prefs.readsAuto !== undefined) e.readsAuto = prefs.readsAuto;
      if (prefs.give !== undefined) e.give = prefs.give;
    });
  }

  /** The last listing's tools and counts, for the Connections and MCP pages (what the next accept would pin). */
  setListing(p: Provider, list: McpToolInfo[], tools: { read: number; write: number }) {
    this.update(p, (e) => {
      if (!e.access) return;
      e.list = list.slice(0, 500);
      e.tools = tools;
    });
  }

  /** The last listing's tools, if any. */
  list(p: Provider): McpToolInfo[] | undefined {
    const e = this.read()[p];
    return e?.access ? e.list : undefined;
  }

  /** The listing the person accepted, and its counts. */
  setPin(p: Provider, pin: string, tools: { read: number; write: number }) {
    this.update(p, (e) => {
      if (!e.access) return;
      e.pin = pin;
      e.tools = tools;
    });
  }

  pin(p: Provider): string | undefined {
    return this.read()[p]?.pin;
  }

  /** Forget the sign-in: tokens, client, account, scopes and pin. The level and switches stay. */
  remove(p: Provider) {
    const all = this.read();
    if (!all[p]) return;
    all[p] = { mode: all[p]!.mode ?? DEFAULTS.mode, readsAuto: all[p]!.readsAuto ?? DEFAULTS.readsAuto, give: all[p]!.give ?? DEFAULTS.give };
    this.write(all);
  }
}
