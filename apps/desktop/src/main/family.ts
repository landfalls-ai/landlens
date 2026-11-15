// The Land family (docs/family.md, wave 7 part 1): Landlens's own sign-in to the Clickland, Landflow and Landfall the
// person runs, held in main. Landflow's key and Landfall's tokens are encrypted with safeStorage in
// userData/family.json (FamilyStore); Clickland's key stays in clickland.json (ClicklandSettingsStore), read and
// written through that class, so the graphs and the status bar's Connect Clickland keep working. No channel returns a
// secret: the page gets FamilyInfo.
//
// A sibling's address is the person's: https, or plain http only to this machine, or (an unpackaged build only) to the
// exact hosts in LANDLENS_FAMILY_HTTP_HOSTS (D102). Every request goes to the stored origin only, with no redirects and
// a time limit; every failure reaches the page as a fixed sentence, and its raw error goes to main's log, cut.
//
// Landfall's browser sign-in is a flow, as Linear's is: one at a time, owned by the window that started it, ended by
// conn:cancel or when that window goes.
import { randomBytes } from "node:crypto";
import { FAMILY_HTTP_HOST, FAMILY_NOTES, familyUrlAllowed, type FamilyInfo, type FamilyList, type McpTest, type Sibling } from "@landlens/contracts";
import {
  clicklandWho, ConnError, FamilyError, FamilyStore, landfallConnector, landfallTarget, landflowWho, mcpRefresh, mcpRevoke, mcpSignIn, originOf, siblingHealth,
  type Crypto, type McpOAuthUsed, type McpSignIn,
} from "@landlens/connections";
import { rawError, testRemote } from "@landlens/mcp-gateway";
import type { ClicklandSettingsStore } from "./clickland-settings";
import type { FlowOwner } from "./connections";

/**
 * What an unpackaged build may change (D102): plain http to these exact host names, from LANDLENS_FAMILY_HTTP_HOSTS
 * (comma-separated, each `^[a-z0-9.-]{1,253}$`, at most 20). A packaged app takes none.
 */
export type FamilyOverrides = { httpHosts: string[] };
export function familyOverrides(env: NodeJS.ProcessEnv, packaged: boolean): FamilyOverrides {
  if (packaged) return { httpHosts: [] };
  const hosts = (env.LANDLENS_FAMILY_HTTP_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => FAMILY_HTTP_HOST.test(h) && !/^[.-]|[.-]$|\.\./.test(h));
  return { httpHosts: [...new Set(hosts)].slice(0, 20) };
}

type Flow = { id: string; owner: FlowOwner; abort: AbortController };
type Transient = { state?: "failed"; note?: string };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export class FamilyService {
  readonly store: FamilyStore;
  private flow: Flow | undefined;
  private readonly transient: Partial<Record<Sibling, Transient>> = {};
  /** Secrets main holds that aren't stored (yet): a pasted key being checked, a sign-in being saved. */
  private readonly held = new Set<string>();
  /** The one refresh of Landfall's token in flight: a rotating refresh token can be spent only once. */
  private refreshing: Promise<string | undefined> | undefined;
  /** The Clickland key origin a who-am-I was last started for, so a list doesn't start another. */
  private clicklandAsked: string | undefined;

  constructor(private readonly o: {
    file: string;
    crypto: Crypto;
    clickland: ClicklandSettingsStore;
    overrides?: FamilyOverrides;
    /** shell.openExternal; only an address on the Landfall origin being signed in to is passed. */
    openExternal: (url: string) => Promise<void>;
    push: (info: FamilyInfo) => void;
    log?: (line: string) => void;
    fetch?: typeof fetch;
  }) {
    this.store = new FamilyStore(o.file, o.crypto);
  }

  private get fetch(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  /** A line for main's log with every secret this service holds cut out exactly, whatever its shape. */
  private say(line: string) {
    if (!this.o.log) return;
    const known = [...this.held];
    const lf = this.store.landflowSecrets();
    if (lf) known.push(lf.key, ...(lf.triageSecret ? [lf.triageSecret] : []));
    const fa = this.store.landfallSecrets();
    if (fa) known.push(fa.access, ...(fa.refresh ? [fa.refresh] : []));
    const ck = this.o.clickland.config();
    if (ck) known.push(ck.key);
    let out = line;
    for (const t of known.filter((t) => t.length >= 8).sort((a, b) => b.length - a.length)) out = out.replaceAll(t, "<redacted secret>");
    this.o.log(out);
  }

  /** A failure as the page sees it: a FamilyError's sentence, else the sibling's "wasn't expected"; the raw to the log. */
  private failure(s: Sibling, err: unknown): Error & { status: number } {
    if (err instanceof FamilyError) {
      if (err.raw !== undefined) this.say(`[family] ${s}: ${rawError(err.raw)}`);
      return fail(err.status, err.message);
    }
    if (err instanceof ConnError) return fail(err.status, err.message);
    this.say(`[family] ${s}: ${rawError(err)}`);
    const answer = { clickland: FAMILY_NOTES.clicklandAnswer, landflow: FAMILY_NOTES.landflowAnswer, landfall: FAMILY_NOTES.landfallAnswer }[s];
    return fail(typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 502, answer);
  }

  /** An address the person typed, as its origin, if this build may use it (D102). */
  private origin(url: string): string {
    if (!familyUrlAllowed(url, this.o.overrides?.httpHosts ?? [])) throw fail(400, FAMILY_NOTES.httpOnlyHere);
    return originOf(url);
  }

  private refuseIfCantStore() {
    if (!this.store.canStore) throw fail(409, FAMILY_NOTES.cantStore);
  }

  // ---- What the page may know -------------------------------------------------------------------------------------

  private clicklandInfo(): FamilyInfo {
    const cfg = this.o.clickland.config();
    const keyOrigin = this.o.clickland.keyOrigin();
    const who = cfg ? this.store.clicklandWho(keyOrigin) : undefined;
    const t = this.transient.clickland;
    const consoleUrl = this.o.clickland.consoleUrl();
    // A key nobody has asked about yet (saved before wave 7, or just now): ask once, in the background.
    if (cfg && keyOrigin && !who && this.clicklandAsked !== keyOrigin) void this.readClickland().catch(() => {});
    const writes = !!who && who.scopes.some((s) => s !== "read" && s !== "usage:read");
    return {
      sibling: "clickland",
      state: !cfg ? "off" : t?.state === "failed" ? "failed" : "ready",
      url: this.o.clickland.view().url,
      ...this.store.prefs("clickland"),
      ...(cfg ? { method: "key" as const } : {}),
      ...(who?.account ? { account: who.account } : {}),
      ...(who ? { scopes: who.scopes } : {}),
      ...(cfg && t?.note ? { note: t.note } : writes ? { note: FAMILY_NOTES.clicklandWrites } : {}),
      ...(consoleUrl ? { console: consoleUrl } : {}),
    };
  }

  info(s: Sibling): FamilyInfo {
    if (s === "clickland") return this.clicklandInfo();
    const base = this.store.info(s);
    const t = this.transient[s];
    const connecting = s === "landfall" && !!this.flow;
    return {
      ...base,
      ...(connecting ? { state: "connecting" as const } : t?.state === "failed" && base.state === "off" ? { state: "failed" as const } : {}),
      ...(t?.note ? { note: t.note } : {}),
    };
  }

  list(): FamilyList {
    return { canStore: this.store.canStore, clickland: this.info("clickland"), landflow: this.info("landflow"), landfall: this.info("landfall") };
  }

  private changed(s: Sibling, t: Transient | undefined) {
    if (t) this.transient[s] = t;
    else delete this.transient[s];
    this.o.push(this.info(s));
  }

  // ---- Clickland: the key that is already there ---------------------------------------------------------------------

  /** Who Clickland's stored key is (D103), kept for the key's origin. */
  private async readClickland(): Promise<void> {
    const cfg = this.o.clickland.config();
    const keyOrigin = this.o.clickland.keyOrigin();
    if (!cfg || !keyOrigin) return;
    this.clicklandAsked = keyOrigin;
    try {
      const who = await clicklandWho(keyOrigin, cfg.key, this.fetch);
      // The key changed while it was asked: this answer is another key's.
      if (this.o.clickland.keyOrigin() !== keyOrigin || this.o.clickland.config()?.key !== cfg.key) return;
      this.store.setClicklandWho(keyOrigin, who);
      this.changed("clickland", undefined);
    } catch (err) {
      const e = this.failure("clickland", err);
      this.changed("clickland", { ...(err instanceof FamilyError && err.status === 401 ? { state: "failed" as const } : {}), note: e.message });
      throw e;
    }
  }

  /** Clickland's key or address changed (metrics:configure, metrics:disconnect): ask who it is again. */
  clicklandChanged() {
    this.clicklandAsked = undefined;
    this.store.forgetClicklandWho();
    delete this.transient.clickland;
    this.o.push(this.info("clickland"));
  }

  // ---- Landflow: a pasted API key -----------------------------------------------------------------------------------

  /**
   * Check a Landflow key once (who it is), then store it for that origin. Absent `key`: the stored one, only if it was
   * saved for the same origin. A key that fails stores nothing and changes nothing stored.
   */
  async connectLandflow(url: string, key?: string): Promise<FamilyInfo> {
    this.refuseIfCantStore();
    const origin = this.origin(url);
    let use = key;
    if (!use) {
      const stored = this.store.landflowSecrets();
      if (!stored || stored.url !== origin) throw fail(400, FAMILY_NOTES.keyElsewhere);
      use = stored.key;
    }
    this.held.add(use);
    try {
      const who = await landflowWho(origin, use, this.fetch);
      this.store.saveLandflow({ url: origin, key: use, ...(who.account ? { account: who.account } : {}), scopes: who.scopes });
      delete this.transient.landflow;
    } catch (err) {
      throw this.failure("landflow", err);
    } finally {
      this.held.delete(use);
    }
    const out = this.info("landflow");
    this.o.push(out);
    return out;
  }

  // ---- Landfall: its connector's own OAuth --------------------------------------------------------------------------

  hasFlow(id: string): boolean {
    return this.flow?.id === id;
  }

  /**
   * Landfall's browser sign-in (D103): returns once the browser is asked to open; the rest ends in family:update. A
   * Landfall without its connector is refused before any listener opens or anything is registered.
   */
  async signinLandfall(url: string, owner: FlowOwner): Promise<{ flow: string }> {
    this.refuseIfCantStore();
    const origin = this.origin(url);
    if (this.flow) throw fail(409, "A sign-in to Landfall is already running. Cancel it first.");
    try {
      await landfallConnector(origin, this.fetch);
    } catch (err) {
      const e = this.failure("landfall", err);
      this.changed("landfall", { state: "failed", note: e.message });
      throw e;
    }
    if (this.flow) throw fail(409, "A sign-in to Landfall is already running. Cancel it first.");
    const flow: Flow = { id: `fl${randomBytes(12).toString("base64url")}`, owner, abort: new AbortController() };
    this.flow = flow;
    this.changed("landfall", undefined);
    let opened!: () => void;
    const browserAsked = new Promise<void>((r) => (opened = r));
    let got: McpSignIn | undefined;
    let stored = false;
    const open = async (address: string) => {
      const u = new URL(address);
      // Only Landfall's own page, on the origin being signed in to.
      if (u.origin !== origin || u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) throw new ConnError(FAMILY_NOTES.landfallElsewhere, 502);
      await this.o.openExternal(u.href);
      opened();
    };
    const end = () => {
      if (this.flow === flow) this.flow = undefined;
    };
    const done = (async () => {
      try {
        const r = await mcpSignIn({ target: landfallTarget(origin), open, signal: flow.abort.signal, fetch: this.fetch });
        got = r;
        this.held.add(r.access);
        if (r.refresh) this.held.add(r.refresh);
        if (flow.abort.signal.aborted) return; // dropped: revoked in finally
        this.store.saveLandfall({ url: origin, access: r.access, ...(r.refresh ? { refresh: r.refresh } : {}), ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), client: r.client, scopes: r.scopes });
        stored = true;
        end();
        this.changed("landfall", undefined);
      } catch (err) {
        end();
        if (flow.abort.signal.aborted) {
          this.changed("landfall", undefined);
        } else {
          const e = this.failure("landfall", err);
          this.changed("landfall", { state: "failed", note: e.message });
        }
        throw err;
      } finally {
        // Tokens Landfall gave that weren't stored (cancelled, the window went, the save failed) are revoked at once,
        // best effort, so no grant is left that Landlens can't show or end.
        if (got) {
          const t = got;
          if (!stored) {
            void mcpRevoke(origin, [t.access, ...(t.refresh ? [t.refresh] : [])], t.client, this.fetch).then((ok) => {
              if (!ok) this.say("[family] landfall: a sign-in that wasn't kept couldn't be revoked");
            }).finally(() => {
              this.held.delete(t.access);
              if (t.refresh) this.held.delete(t.refresh);
            });
          } else {
            this.held.delete(t.access);
            if (t.refresh) this.held.delete(t.refresh);
          }
        }
      }
    })();
    await Promise.race([browserAsked, done.then(() => undefined)]).catch((err) => {
      throw this.failure("landfall", err);
    });
    done.catch(() => {});
    return { flow: flow.id };
  }

  cancel(id: string, owner: FlowOwner) {
    const flow = this.flow;
    if (!flow || flow.id !== id || flow.owner !== owner) throw fail(404, "No such sign-in.");
    flow.abort.abort(new Error("cancelled"));
    this.flow = undefined;
    this.changed("landfall", undefined);
  }

  /** A window went: its sign-in stops. */
  cancelFor(owner: FlowOwner) {
    if (this.flow && this.flow.owner === owner) this.cancel(this.flow.id, owner);
  }

  /** A refresh Landfall refused marks the sign-in expired, unless another refresh rotated the tokens first. */
  private expiredIfStill(used: McpOAuthUsed) {
    const s = this.store.landfallSecrets();
    if (!s) return;
    if (used.refresh ? s.refresh !== used.refresh : s.access !== used.access) return;
    this.store.markExpired();
  }

  /** Main only: Landfall's bearer, refreshed first if it ran out. One refresh at a time. */
  async landfallBearer(): Promise<string | undefined> {
    const s = this.store.landfallSecrets();
    if (!s || this.store.info("landfall").state !== "ready") return undefined;
    if (s.client && s.refresh && s.expiresAt && s.expiresAt - 60_000 < Date.now()) {
      if (this.refreshing) return this.refreshing;
      const client = s.client;
      const refresh = s.refresh;
      const run = (async () => {
        try {
          const t = await mcpRefresh({
            target: landfallTarget(s.url), client, tokens: { access: s.access, refresh }, fetch: this.fetch,
            onTokens: (t) => this.store.setTokens(t),
            onExpired: (used) => this.expiredIfStill(used),
          });
          return t.access;
        } catch (err) {
          this.say(`[family] landfall refresh: ${rawError(err)}`);
          this.o.push(this.info("landfall"));
          return undefined;
        } finally {
          this.refreshing = undefined;
        }
      })();
      this.refreshing = run;
      return run;
    }
    return s.access;
  }

  // ---- Settings, Test, Disconnect -----------------------------------------------------------------------------------

  /**
   * The switches (D108, D110), Clickland's console address (D118) and Landflow's triage webhook (D121). The webhook's
   * secret is encrypted and bound to Landflow's stored origin; absent, the stored one is kept.
   */
  set(s: Sibling, p: { toSessions?: boolean; readsAuto?: boolean; console?: string | null; triage?: { path: string; header: string; secret?: string } | null }): FamilyInfo {
    if (p.console !== undefined) {
      if (s !== "clickland") throw fail(400, "Only Clickland has a console address.");
      this.o.clickland.setConsole(p.console === null ? null : this.origin(p.console));
    }
    if (p.triage !== undefined) {
      if (s !== "landflow") throw fail(400, "Only Landflow has a triage webhook.");
      if (p.triage?.secret) this.held.add(p.triage.secret);
      try {
        this.store.setTriage(p.triage);
      } catch (err) {
        throw this.failure("landflow", err);
      } finally {
        if (p.triage?.secret) this.held.delete(p.triage.secret);
      }
    }
    if (p.toSessions !== undefined || p.readsAuto !== undefined) {
      this.store.setPrefs(s, { ...(p.toSessions !== undefined ? { toSessions: p.toSessions } : {}), ...(p.readsAuto !== undefined ? { readsAuto: p.readsAuto } : {}) });
    }
    const out = this.info(s);
    this.o.push(out);
    return out;
  }

  /** Health and who-am-I again (and, for Landfall, the connector and its MCP endpoint). Updates who it is. */
  async test(s: Sibling): Promise<McpTest> {
    const steps: McpTest["steps"] = [];
    const step = async (name: string, f: () => Promise<string>): Promise<boolean> => {
      try {
        steps.push({ name, ok: true, detail: await f() });
        return true;
      } catch (err) {
        steps.push({ name, ok: false, detail: this.failure(s, err).message });
        return false;
      }
    };
    const who = (a: { name?: string; email?: string; role?: string } | undefined, scopes: string[]) =>
      [a?.name ?? a?.email ?? "a key", a?.role ? `role ${a.role}` : "", scopes.length ? `scopes ${scopes.join(", ")}` : "no scopes"].filter(Boolean).join(" · ");
    if (s === "clickland") {
      const cfg = this.o.clickland.config();
      const origin = this.o.clickland.keyOrigin();
      if (!cfg || !origin) return { ok: false, steps: [{ name: "key", ok: false, detail: "No Clickland key is stored." }] };
      await step("health", async () => {
        const h = await siblingHealth("clickland", origin, this.fetch);
        return h.ok ? `ok${h.version ? `, version ${h.version}` : ""}` : "answered, but not ok";
      });
      const ok = await step("who-am-I", async () => {
        this.clicklandAsked = origin;
        const w = await clicklandWho(origin, cfg.key, this.fetch);
        this.store.setClicklandWho(origin, w);
        return who(w.account, w.scopes);
      });
      this.changed("clickland", ok ? undefined : { ...(steps.at(-1)?.detail === FAMILY_NOTES.clicklandRefused ? { state: "failed" as const } : {}), note: steps.at(-1)!.detail });
    } else if (s === "landflow") {
      const sec = this.store.landflowSecrets();
      if (!sec) return { ok: false, steps: [{ name: "key", ok: false, detail: "Landflow isn't connected." }] };
      await step("health", async () => ((await siblingHealth("landflow", sec.url, this.fetch)).ok ? "ok" : "answered, but not ok"));
      this.held.add(sec.key);
      try {
        await step("who-am-I", async () => {
          const w = await landflowWho(sec.url, sec.key, this.fetch);
          this.store.setLandflowWho(w);
          return who(w.account, w.scopes);
        });
      } finally {
        this.held.delete(sec.key);
      }
      this.o.push(this.info("landflow"));
    } else {
      const sec = this.store.landfallSecrets();
      if (!sec) return { ok: false, steps: [{ name: "sign-in", ok: false, detail: "Landfall isn't signed in." }] };
      if (await step("connector", async () => (await landfallConnector(sec.url, this.fetch), "its OAuth metadata answers, on its own origin"))) {
        const token = await this.landfallBearer();
        if (!token) steps.push({ name: "sign-in", ok: false, detail: FAMILY_NOTES.landfallExpired });
        else {
          const r = await testRemote({ name: "landfall", url: `${sec.url}/mcp`, headers: { Authorization: `Bearer ${token}` }, origins: [sec.url], noViews: true });
          // The listing is part 2's (D110, D111): shown only when the tools are given to sessions.
          steps.push(...r.steps.filter((x) => x.name === "initialize" || this.store.prefs("landfall").toSessions));
        }
      }
      this.o.push(this.info("landfall"));
    }
    return { ok: steps.every((x) => x.ok), steps };
  }

  /**
   * Forget a sign-in (D103). Clickland: its key (graphs stop until a key is saved again). Landflow: its key and the
   * webhook's secret (the person revokes the key in Landflow: Settings → API keys). Landfall: its tokens, revoked first
   * at the metadata's revocation endpoint, best effort, 5 s.
   */
  async disconnect(s: Sibling): Promise<FamilyInfo> {
    if (s === "clickland") {
      this.o.clickland.clear();
      this.clicklandChanged();
      return this.info("clickland");
    }
    if (s === "landfall") {
      if (this.flow) this.cancel(this.flow.id, this.flow.owner);
      const sec = this.store.landfallSecrets();
      if (sec?.client) {
        const ok = await mcpRevoke(sec.url, [sec.access, ...(sec.refresh ? [sec.refresh] : [])], sec.client, this.fetch);
        if (!ok) this.say("[family] landfall: the revocation wasn't confirmed; the stored sign-in is deleted anyway");
      }
    }
    this.store.remove(s);
    this.changed(s, undefined);
    return this.info(s);
  }

  stop() {
    this.flow?.abort.abort(new Error("quitting"));
    this.flow = undefined;
  }
}
