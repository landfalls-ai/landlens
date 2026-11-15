// Connections (docs/connections.md): Landlens's own sign-in to GitHub and Linear, held in main. Tokens are
// encrypted with safeStorage in userData/connections.json, decrypted only here, and sent only to the provider's own
// origins (packages/connections/src/providers.ts). No channel returns one: the page gets ConnInfo.
//
// A sign-in that waits for the person (GitHub's device code, Linear's browser sign-in) is a flow: one per provider at
// a time, owned by the window that started it, cancelled by that window or when it goes. When a flow ends the
// window gets conn:update.
//
// From part 2 a ready connection is an upstream on the MCP gateway (remotes()): its vendor's own MCP server, with the
// token added here, its reads told apart by the vendor's read-only listing, pinned to the listing you accepted.
import { randomBytes } from "node:crypto";
import { CONN_NOTES, type ConnInfo, type ConnList, type ConnMode, type McpServerInfo, type McpTest, type McpToolInfo } from "@landlens/contracts";
import {
  ConnError, ConnectionStore, endpoints, githubWhoAmI, GITHUB_CLIENT_ID, GITHUB_DEVICE_PAGE, LinearAuth, linearRefresh, linearRevoke, linearSignIn,
  linearViewer, LOOPBACK_ORIGIN, pollDeviceFlow, PROVIDER_NAME, PROVIDERS, startDeviceFlow, StoreError, type Clock, type Crypto, type Endpoints, type LinearUsed, type Provider,
} from "@landlens/connections";
import { listingHash, rawError, readonlyIsSmaller, readTools, testRemote, toolInfo, type RemoteSpec } from "@landlens/mcp-gateway";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export { readTools };

/**
 * What an unpackaged build may change (spec D86): every origin of a provider replaced by one loopback fake, and a
 * GitHub client id for the device flow. A packaged app takes none of them; an override that isn't
 * http://127.0.0.1:<port> is ignored.
 */
export type ConnOverrides = { github?: string; linear?: string; githubClientId?: string };
export function connectionOverrides(env: NodeJS.ProcessEnv, packaged: boolean): ConnOverrides {
  if (packaged) return {};
  const loop = (v: string | undefined) => (v && LOOPBACK_ORIGIN.test(v) ? v : undefined);
  const github = loop(env.LANDLENS_GITHUB_ENDPOINT);
  const linear = loop(env.LANDLENS_LINEAR_ENDPOINT);
  const id = env.LANDLENS_GITHUB_CLIENT_ID;
  return { ...(github ? { github } : {}), ...(linear ? { linear } : {}), ...(id && /^[A-Za-z0-9.]{8,64}$/.test(id) ? { githubClientId: id } : {}) };
}

/** A window, as far as flows care: something that can go away. */
export type FlowOwner = object;

/**
 * The window a sign-in belongs to (ipc.ts): the first time a window starts one, its "destroyed" stops every sign-in
 * it owns, so a closed window leaves no poll or loopback listener running.
 */
export function flowOwners(c: Pick<ConnectionsService, "cancelFor">) {
  const seen = new WeakSet<object>();
  return <W extends { once(event: "destroyed", f: () => void): unknown }>(wc: W): W => {
    if (!seen.has(wc)) {
      seen.add(wc);
      wc.once("destroyed", () => c.cancelFor(wc));
    }
    return wc;
  };
}

type Flow = { id: string; provider: Provider; owner: FlowOwner; abort: AbortController };
type Transient = { state?: "connecting" | "failed"; note?: string };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** GitHub's MCP server: the toolsets Landlens gives sessions, and lockdown on (D77). */
const GITHUB_HEADERS = { "X-MCP-Toolsets": "repos,issues,pull_requests,actions", "X-MCP-Lockdown": "true" };

/** How long a listing of both endpoints is used for sessions before it is listed again (D78). */
export const LISTING_TTL = 10 * 60_000;

/** Both endpoints, listed (D78): the full listing, the reads, and the pin they make. */
type Listing = {
  at: number;
  ok: boolean;
  steps: McpTest["steps"];
  full?: Tool[];
  readonly: Tool[];
  reads: Set<string>;
  /** listingHash(full) + "." + listingHash(readonly). */
  pin?: string;
  /** Each half, for the gateway to check its own listing of the upstream against. */
  halves?: { full: string; readonly: string };
  /** The read-only endpoint listed fewer tools than the full one, all of them the full one's (H1). */
  smaller: boolean;
};

/** A connection's server on the gateway: a RemoteSpec with its provider rules. */
export type ProviderSpec = RemoteSpec & { provider: NonNullable<RemoteSpec["provider"]> };

export class ConnectionsService {
  readonly store: ConnectionStore;
  private readonly ep: Endpoints;
  private readonly clientId: string;
  private readonly flows = new Map<string, Flow>();
  private readonly transient: Partial<Record<Provider, Transient>> = {};
  /** The listings the last conn:test saw, for conn:repin. */
  private readonly lastTest: Partial<Record<Provider, { pin: string; tools: { read: number; write: number } }>> = {};
  /** Both endpoints' listings, for sessions (10 minutes) and the pages. */
  private readonly listings: Partial<Record<Provider, Listing>> = {};
  /** The one refresh of a provider's OAuth token in flight: a rotating refresh token can be spent only once. */
  private readonly refreshing: Partial<Record<Provider, Promise<string | undefined>>> = {};
  /** Tokens main holds that aren't stored (yet): a pasted token being checked, a sign-in being saved. */
  private readonly held = new Set<string>();

  constructor(private readonly o: {
    file: string;
    crypto: Crypto;
    overrides?: ConnOverrides;
    /** shell.openExternal; only GitHub's device page or Linear's authorize address are passed. */
    openExternal: (url: string) => Promise<void>;
    push: (info: ConnInfo) => void;
    log?: (line: string) => void;
    fetch?: typeof fetch;
    clock?: Clock;
    /** The names of the MCP servers you added: one named github or linear keeps that connection off (D76). */
    takenNames?: () => string[];
  }) {
    this.store = new ConnectionStore(o.file, o.crypto);
    this.ep = endpoints(o.overrides ?? {});
    this.clientId = o.overrides?.githubClientId ?? GITHUB_CLIENT_ID;
  }

  private get fetch(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  /**
   * A line for the log, with every token this service holds cut out exactly, whatever its shape: Linear's MCP tokens
   * promise none, so rawError's patterns can't be relied on for them.
   */
  private say(line: string) {
    if (!this.o.log) return;
    const known = [...this.held];
    for (const p of PROVIDERS) {
      const s = this.store.secrets(p);
      if (s) known.push(s.access, ...(s.refresh ? [s.refresh] : []));
    }
    let out = line;
    for (const t of known.filter((t) => t.length >= 8).sort((a, b) => b.length - a.length)) out = out.replaceAll(t, "<redacted token>");
    this.o.log(out);
  }

  /** A new sign-in is stored: what the last test showed and the listing kept are another sign-in's (L6). */
  private saved(p: Provider) {
    delete this.lastTest[p];
    delete this.listings[p];
  }

  /** A server you added already has this connection's name: the connection stays off until it is renamed. */
  private taken(p: Provider): boolean {
    return (this.o.takenNames?.() ?? []).includes(p);
  }

  info(p: Provider): ConnInfo {
    const base = this.store.info(p);
    const t = this.transient[p];
    const flowing = [...this.flows.values()].some((f) => f.provider === p);
    if (this.taken(p)) {
      const { method: _m, account: _a, scopes: _s, tools: _t, ...rest } = base;
      return { ...rest, state: "off", note: p === "github" ? CONN_NOTES.githubNameTaken : CONN_NOTES.linearNameTaken, ...(p === "github" ? { canDevice: !!this.clientId } : {}) };
    }
    // Ready but never accepted (its listing failed when it connected): reads ask until you look and accept.
    const unaccepted = base.state === "ready" && !this.store.pin(p) && !t?.note;
    return {
      ...base,
      ...(flowing ? { state: "connecting" as const } : t?.state === "failed" && base.state === "off" ? { state: "failed" as const } : {}),
      ...(t?.note ? { note: t.note } : unaccepted ? { note: CONN_NOTES.unaccepted } : {}),
      ...(p === "github" ? { canDevice: !!this.clientId } : {}),
    };
  }

  list(): ConnList {
    return { canStore: this.store.canStore, github: this.info("github"), linear: this.info("linear") };
  }

  private changed(p: Provider, t: Transient | undefined) {
    if (t) this.transient[p] = t;
    else delete this.transient[p];
    this.o.push(this.info(p));
  }

  private refuseIfCantStore() {
    if (!this.store.canStore) throw fail(409, CONN_NOTES.cantStore);
  }

  private refuseIfTaken(p: Provider) {
    if (this.taken(p)) throw fail(409, p === "github" ? CONN_NOTES.githubNameTaken : CONN_NOTES.linearNameTaken);
  }

  private newFlow(p: Provider, owner: FlowOwner): Flow {
    if ([...this.flows.values()].some((f) => f.provider === p)) throw fail(409, `A sign-in to ${PROVIDER_NAME[p]} is already running. Cancel it first.`);
    const flow = { id: `fl${randomBytes(12).toString("base64url")}`, provider: p, owner, abort: new AbortController() };
    this.flows.set(flow.id, flow);
    return flow;
  }

  private endFlow(flow: Flow) {
    this.flows.delete(flow.id);
  }

  /** Save a sign-in, or keep the provider as it was with the failure's note. */
  private settle(p: Provider, flow: Flow | undefined, err: unknown) {
    if (flow?.abort.signal.aborted) return this.changed(p, undefined); // cancelled: nothing to say
    const note = err instanceof ConnError || err instanceof StoreError ? err.message : p === "github" ? CONN_NOTES.githubAnswer : CONN_NOTES.linearAnswer;
    if (!(err instanceof ConnError)) this.say(`[connections] ${p}: ${rawError(err)}`);
    this.changed(p, { state: "failed", note });
  }

  /** GitHub's device flow: the code comes back at once; the poll runs on and ends in conn:update. */
  async githubDevice(owner: FlowOwner): Promise<{ flow: string; userCode: string; verificationUri: typeof GITHUB_DEVICE_PAGE; expiresIn: number }> {
    if (!this.clientId) throw fail(409, CONN_NOTES.noDevice);
    this.refuseIfCantStore();
    this.refuseIfTaken("github");
    const flow = this.newFlow("github", owner);
    let code;
    try {
      code = await startDeviceFlow(this.ep.github, this.clientId, this.fetch);
    } catch (err) {
      this.endFlow(flow);
      this.settle("github", undefined, err);
      throw fail(err instanceof ConnError ? err.status : 502, err instanceof ConnError ? err.message : CONN_NOTES.githubAnswer);
    }
    this.changed("github", undefined);
    let held: string | undefined;
    void (async () => {
      try {
        const { access } = await pollDeviceFlow(this.ep.github, this.clientId, code, flow.abort.signal, { fetch: this.fetch, ...(this.o.clock ? { clock: this.o.clock } : {}) });
        held = access;
        this.held.add(access);
        const who = await githubWhoAmI(this.ep.github, access, this.fetch);
        // Cancelled after GitHub gave the token: it is dropped. GitHub can't revoke a device token without the app's
        // secret, so the grant stays on the person's GitHub grants page (docs/connections.md says where).
        if (flow.abort.signal.aborted) return;
        this.store.save("github", { method: "device", access, account: who.account, scopes: who.scopes });
        this.saved("github");
        this.endFlow(flow);
        await this.accept("github");
        this.changed("github", undefined);
      } catch (err) {
        this.endFlow(flow);
        this.settle("github", flow, err);
      } finally {
        if (held) this.held.delete(held);
      }
    })();
    return { flow: flow.id, userCode: code.userCode, verificationUri: GITHUB_DEVICE_PAGE, expiresIn: code.expiresIn };
  }

  /** Open the person's browser at Linear's sign-in only if the address is on Linear's own origin. */
  private openLinear = async (url: string) => {
    const u = new URL(url);
    if (u.origin !== this.ep.linear.authOrigin || (u.protocol !== "https:" && !this.o.overrides?.linear)) throw new ConnError(CONN_NOTES.linearElsewhere, 502);
    await this.o.openExternal(u.href);
  };

  /** Linear's browser sign-in: returns once the browser is asked to open; the rest ends in conn:update. */
  async linearSignIn(mode: ConnMode, owner: FlowOwner): Promise<{ flow: string }> {
    this.refuseIfCantStore();
    this.refuseIfTaken("linear");
    const flow = this.newFlow("linear", owner);
    this.changed("linear", undefined);
    let opened!: () => void;
    const browserAsked = new Promise<void>((r) => (opened = r));
    let got: Awaited<ReturnType<typeof linearSignIn>> | undefined;
    let stored = false;
    const done = (async () => {
      try {
        const r = await linearSignIn({ endpoints: this.ep.linear, mode, open: async (url) => (await this.openLinear(url), opened()), signal: flow.abort.signal, fetch: this.fetch });
        got = r;
        this.held.add(r.access);
        if (r.refresh) this.held.add(r.refresh);
        // Whether Linear's API takes an MCP-issued token isn't documented: try once, else leave the account out.
        const account = await linearViewer(this.ep.linear, r.access, this.fetch).catch(() => undefined);
        if (flow.abort.signal.aborted) return; // dropped: revoked in finally
        this.store.save("linear", { method: "oauth", access: r.access, ...(r.refresh ? { refresh: r.refresh } : {}), ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), client: r.client, ...(account ? { account } : {}), scopes: r.scopes });
        stored = true;
        this.saved("linear");
        this.store.setPrefs("linear", { mode });
        this.endFlow(flow);
        await this.accept("linear");
        this.changed("linear", undefined);
      } catch (err) {
        this.endFlow(flow);
        this.settle("linear", flow, err);
        throw err;
      } finally {
        // Tokens Linear gave that weren't stored (cancelled, the window went, a disconnect, or the save failed) are
        // revoked at once, best effort, so no grant is left that Landlens can't show or end (L2).
        if (got && !stored) {
          const t = got;
          void linearRevoke(this.ep.linear, [t.access, ...(t.refresh ? [t.refresh] : [])], t.client, this.fetch).then((ok) => {
            if (!ok) this.say("[connections] linear: a sign-in that wasn't kept couldn't be revoked");
          }).finally(() => {
            this.held.delete(t.access);
            if (t.refresh) this.held.delete(t.refresh);
          });
        } else if (got) {
          this.held.delete(got.access);
          if (got.refresh) this.held.delete(got.refresh);
        }
      }
    })();
    // The answer waits for the browser to be asked, or for the flow to fail before that.
    await Promise.race([browserAsked, done.then(() => undefined)]).catch((err) => {
      throw fail(err instanceof ConnError ? err.status : 502, err instanceof ConnError ? err.message : CONN_NOTES.linearAnswer);
    });
    done.catch(() => {});
    return { flow: flow.id };
  }

  cancel(id: string, owner: FlowOwner) {
    const flow = this.flows.get(id);
    if (!flow || flow.owner !== owner) throw fail(404, "No such sign-in.");
    flow.abort.abort(new Error("cancelled"));
    this.endFlow(flow);
    this.changed(flow.provider, undefined);
  }

  /** A window went: its sign-ins stop. */
  cancelFor(owner: FlowOwner) {
    for (const f of [...this.flows.values()]) if (f.owner === owner) this.cancel(f.id, owner);
  }

  /** A pasted token: checked once (who it is), then stored. A token that fails stores nothing. */
  async token(p: Provider, token: string): Promise<ConnInfo> {
    this.refuseIfCantStore();
    this.refuseIfTaken(p);
    if ([...this.flows.values()].some((f) => f.provider === p)) throw fail(409, `A sign-in to ${PROVIDER_NAME[p]} is already running. Cancel it first.`);
    this.held.add(token);
    try {
      if (p === "github") {
        const who = await githubWhoAmI(this.ep.github, token, this.fetch);
        this.store.save("github", { method: "token", access: token, account: who.account, scopes: who.scopes });
      } else {
        const account = await linearViewer(this.ep.linear, token, this.fetch);
        this.store.save("linear", { method: "token", access: token, account });
      }
      this.saved(p);
      delete this.transient[p];
    } catch (err) {
      this.settle(p, undefined, err);
      return this.info(p);
    } finally {
      this.held.delete(token);
    }
    await this.accept(p);
    this.o.push(this.info(p));
    return this.info(p);
  }

  /**
   * A new sign-in: list both endpoints and accept that listing (D80: the pin is stored when you connect and the card
   * shows you the tools). A listing that fails leaves the connection unaccepted: its reads ask until you look.
   */
  private async accept(p: Provider) {
    delete this.listings[p];
    const l = await this.listing(p, true).catch(() => undefined);
    if (!l?.ok || !l.pin) return;
    const kept = this.store.pin(p);
    // The same account connected again with its accepted listing kept (L5): a listing that changed asks for review.
    if (kept) {
      if (kept !== l.pin) this.drifted(p);
      return;
    }
    // A read-only endpoint that isn't a smaller server isn't accepted on sight: the person looks first (H1).
    if (!l.smaller) return;
    this.store.setPin(p, l.pin, { read: l.reads.size, write: (l.full?.length ?? 0) - l.reads.size });
  }

  set(p: Provider, prefs: { mode?: ConnMode; readsAuto?: boolean; give?: boolean }): ConnInfo {
    this.store.setPrefs(p, prefs);
    const info = this.store.info(p);
    // A Linear sign-in for reading only can't write, whatever the level says.
    if (p === "linear" && prefs.mode === "ask" && info.method === "oauth" && !info.scopes?.includes("write")) this.transient.linear = { note: CONN_NOTES.linearReadScope };
    else if (prefs.mode && this.transient[p]?.note === CONN_NOTES.linearReadScope) delete this.transient[p];
    const out = this.info(p);
    this.o.push(out);
    return out;
  }

  /**
   * A refresh Linear refused marks the connection expired, unless the tokens it was tried with aren't the stored ones
   * any more: another refresh rotated them first, and the connection is fine (M2).
   */
  private expiredIfStill(used: LinearUsed) {
    const s = this.store.secrets("linear");
    if (!s) return;
    if (used.refresh ? s.refresh !== used.refresh : s.access !== used.access) return;
    this.store.markExpired("linear");
  }

  /**
   * Main only: a ready connection's bearer, refreshing Linear's OAuth token first if it ran out. One refresh at a time:
   * Linear's refresh token rotates, so a second refresh with the same one would be refused.
   */
  async bearer(p: Provider): Promise<string | undefined> {
    const s = this.store.secrets(p);
    const info = this.store.info(p);
    if (!s || info.state !== "ready") return undefined;
    if (p === "linear" && info.method === "oauth" && s.client && s.refresh && s.expiresAt && s.expiresAt - 60_000 < Date.now()) {
      const running = this.refreshing.linear;
      if (running) return running;
      const client = s.client;
      const refresh = s.refresh;
      const run = (async () => {
        try {
          const t = await linearRefresh({
            endpoints: this.ep.linear, mode: info.mode, client, tokens: { access: s.access, refresh }, fetch: this.fetch,
            onTokens: (t) => this.store.setTokens("linear", t),
            onExpired: (used) => this.expiredIfStill(used),
          });
          return t.access;
        } catch (err) {
          // Refused: expired (above). Unreachable: the connection stays ready, and this call has no bearer.
          this.say(`[connections] linear refresh: ${rawError(err)}`);
          this.o.push(this.info("linear"));
          return undefined;
        } finally {
          delete this.refreshing.linear;
        }
      })();
      this.refreshing.linear = run;
      return run;
    }
    return s.access;
  }

  private ep_(p: Provider) {
    return p === "github" ? this.ep.github : this.ep.linear;
  }

  /** The two upstreams a connection gives (D77, D78): its full endpoint and its read-only one, with its headers. */
  private async specs(p: Provider): Promise<{ full: RemoteSpec; readonly: RemoteSpec } | undefined> {
    const token = await this.bearer(p);
    if (!token) return undefined;
    const headers = { Authorization: `Bearer ${token}`, ...(p === "github" ? GITHUB_HEADERS : {}) };
    const ep = this.ep_(p);
    // Every request for a connection's server goes only to the provider's token origins, never through a redirect.
    // No MCP App views for a connection (M3): the client doesn't offer them, in Test and in sessions alike.
    return { full: { name: p, url: ep.mcp, headers, origins: ep.tokenOrigins, noViews: true }, readonly: { name: p, url: ep.mcpReadonly, headers, origins: ep.tokenOrigins, noViews: true } };
  }

  /**
   * Both endpoints, listed (D78), kept for 10 minutes unless `fresh`. A read is a tool the read-only endpoint lists
   * with the same input schema as the full one; with no read-only listing nothing is a read.
   */
  private async listing(p: Provider, fresh = false): Promise<Listing | undefined> {
    const hit = this.listings[p];
    if (!fresh && hit && Date.now() - hit.at < LISTING_TTL) return hit;
    const specs = await this.specs(p);
    if (!specs) return undefined;
    const [full, ro] = await Promise.all([testRemote(specs.full), testRemote(specs.readonly)]);
    const steps = [...full.steps.map((s) => ({ ...s, name: `full: ${s.name}` })), ...ro.steps.map((s) => ({ ...s, name: `read-only: ${s.name}` }))];
    const roTools: Tool[] = ro.ok && ro.tools ? ro.tools : [];
    if (!full.ok || !full.tools) {
      const l: Listing = { at: Date.now(), ok: false, steps, readonly: roTools, reads: new Set(), smaller: false };
      this.listings[p] = l;
      return l;
    }
    const reads = readTools(full.tools, roTools);
    const smaller = readonlyIsSmaller(full.tools, roTools);
    if (!smaller) steps.push({ name: "read-only endpoint", ok: false, detail: CONN_NOTES.readonlyUnproven });
    const halves = { full: listingHash(full.tools), readonly: listingHash(roTools) };
    const l: Listing = { at: Date.now(), ok: true, steps, full: full.tools, readonly: roTools, reads, pin: `${halves.full}.${halves.readonly}`, halves, smaller };
    this.listings[p] = l;
    this.store.setListing(p, full.tools.map((t) => toolInfo(t, { readTools: reads })), { read: reads.size, write: full.tools.length - reads.size });
    return l;
  }

  /**
   * List both endpoints again. A read is a tool the read-only endpoint lists with the same input schema as the full
   * one (D78); everything else asks. Reports a listing other than the one accepted.
   */
  async test(p: Provider): Promise<McpTest> {
    const l = await this.listing(p, true);
    if (!l) return { ok: false, steps: [{ name: "sign-in", ok: false, detail: `${PROVIDER_NAME[p]} isn't connected.` }] };
    const steps = [...l.steps];
    if (!l.ok || !l.full || !l.pin) return { ok: false, steps };
    const tools: McpToolInfo[] = l.full.map((t) => toolInfo(t, { readTools: l.reads }));
    const counts = { read: l.reads.size, write: l.full.length - l.reads.size };
    this.lastTest[p] = { pin: l.pin, tools: counts };
    const accepted = this.store.pin(p);
    if (accepted && accepted !== l.pin) {
      steps.push({ name: "listing", ok: false, detail: CONN_NOTES.drift });
      this.transient[p] = { note: CONN_NOTES.drift };
      this.o.push(this.info(p));
    } else steps.push({ name: "listing", ok: true, detail: `${l.full.length} tools: ${counts.read} read, ${counts.write} write` });
    return { ok: true, steps, tools };
  }

  /**
   * Main only: the connections an agent session gets on the gateway (D77): each ready one with "Give to Claude
   * sessions" on and no server of yours under its name. In mode read the upstream is the vendor's read-only endpoint.
   * Its reads run without asking only while both listings are the ones you accepted; the gateway checks its own
   * listing of the upstream against the half it serves.
   */
  async remotes(): Promise<ProviderSpec[]> {
    const out: ProviderSpec[] = [];
    for (const p of PROVIDERS) {
      const info = this.store.info(p);
      if (info.state !== "ready" || !info.give || this.taken(p)) continue;
      const specs = await this.specs(p);
      if (!specs) continue;
      const l = await this.listing(p).catch(() => undefined);
      const accepted = this.store.pin(p);
      const same = !!l?.pin && l.pin === accepted;
      if (accepted && l?.ok && l.pin !== accepted) this.drifted(p);
      const read = info.mode === "read";
      // Read only serves the read-only endpoint, so it must be one: a smaller server than the full one (H1).
      if (read && !(l?.ok && l.smaller)) {
        this.say(`[connections] ${p}: its read-only endpoint isn't a smaller server; not served at Read only`);
        if (l?.ok && this.transient[p]?.note !== CONN_NOTES.readonlyUnproven) this.changed(p, { note: CONN_NOTES.readonlyUnproven });
        continue;
      }
      const base = read ? specs.readonly : specs.full;
      const auth = await this.sessionAuth(p, info.mode);
      const headers = { ...(base.headers ?? {}) };
      if (auth) delete headers.Authorization;
      out.push({
        ...base,
        headers,
        ...(auth ? { authProvider: auth } : {}),
        ...(same && l?.halves ? { pin: read ? l.halves.readonly : l.halves.full } : {}),
        // At Ask for writes the reads go to the read-only endpoint (M1), whose half of the listing is pinned too.
        ...(!read ? { readUrl: specs.readonly.url, ...(same && l?.halves ? { readPin: l.halves.readonly } : {}) } : {}),
        provider: { id: p, readTools: l?.reads ?? new Set(), mode: info.mode, readsAuto: info.readsAuto },
      });
    }
    return out;
  }

  /**
   * Linear's OAuth sign-in in a session: the transport takes the bearer from it and refreshes on a 401; it never
   * opens a browser. A refresh Linear refused marks the connection expired (D74); one that didn't get through fails
   * the call and leaves the connection as it is.
   */
  private async sessionAuth(p: Provider, mode: ConnMode): Promise<LinearAuth | undefined> {
    if (p !== "linear" || this.store.info(p).method !== "oauth") return undefined;
    const s = this.store.secrets(p);
    if (!s?.client) return undefined;
    return new LinearAuth({
      endpoints: this.ep.linear, mode, redirectUri: s.client.redirect_uri, client: s.client,
      tokens: { access: s.access, ...(s.refresh ? { refresh: s.refresh } : {}) },
      // Each use reads the stored tokens, so a refresh another session or bearer() made is picked up, not spent again.
      load: () => {
        const now = this.store.secrets("linear");
        return now ? { access: now.access, ...(now.refresh ? { refresh: now.refresh } : {}) } : undefined;
      },
      onTokens: (t) => this.store.setTokens("linear", t),
      onExpired: (used) => {
        this.expiredIfStill(used);
        this.o.push(this.info("linear"));
      },
    });
  }

  /** A session (or a listing) found another listing than the one you accepted: reads ask, and the card says so. */
  drifted(p: Provider) {
    delete this.listings[p];
    if (this.transient[p]?.note === CONN_NOTES.drift) return;
    this.say(`[connections] ${p}: its tools changed since you accepted them; its reads ask again`);
    this.changed(p, { note: CONN_NOTES.drift });
  }

  /** The connections as the MCP page lists them, after landlens-kube: managed on the Connections page (D95). */
  servers(): McpServerInfo[] {
    return PROVIDERS.filter((p) => this.store.info(p).state !== "off" && !this.taken(p)).map((p) => {
      const info = this.info(p);
      const tools = this.store.list(p);
      const ep = this.ep_(p);
      return {
        id: p, name: p, builtin: false, connection: p,
        url: info.mode === "read" ? ep.mcpReadonly : ep.mcp,
        enabled: info.state === "ready" && info.give,
        autoRun: info.readsAuto && !!this.store.pin(p) && info.note !== CONN_NOTES.drift,
        ...(info.note === CONN_NOTES.drift ? { autoRunNote: CONN_NOTES.drift } : {}),
        appOrigins: [],
        ...(tools ? { tools } : {}),
        status: info.state === "ready" ? (tools ? "ready" : "unknown") : "failed",
        ...(info.state !== "ready" && info.note ? { detail: info.note } : {}),
      };
    });
  }

  /** Accept the listing the last test showed (D80). */
  repin(p: Provider): ConnInfo {
    const t = this.lastTest[p];
    if (!t) throw fail(409, "Test it first, so you've seen the tools you're accepting.");
    this.store.setPin(p, t.pin, t.tools);
    if (this.transient[p]?.note === CONN_NOTES.drift) delete this.transient[p];
    const out = this.info(p);
    this.o.push(out);
    return out;
  }

  /**
   * Forget the sign-in. Linear's OAuth grant is revoked first, best effort, each request within 5 seconds: the access
   * token, then the refresh token (L3).
   */
  async disconnect(p: Provider): Promise<ConnInfo> {
    for (const f of [...this.flows.values()]) if (f.provider === p) this.cancel(f.id, f.owner);
    const s = this.store.secrets(p);
    if (p === "linear" && this.store.info(p).method === "oauth" && s?.client) {
      const ok = await linearRevoke(this.ep.linear, [s.access, ...(s.refresh ? [s.refresh] : [])], s.client, this.fetch);
      if (!ok) this.say("[connections] linear: the revocation wasn't confirmed; the stored sign-in is deleted anyway");
    }
    this.store.remove(p);
    delete this.lastTest[p];
    delete this.listings[p];
    this.changed(p, undefined);
    return this.info(p);
  }

  stop() {
    for (const f of [...this.flows.values()]) f.abort.abort(new Error("quitting"));
    this.flows.clear();
  }
}
