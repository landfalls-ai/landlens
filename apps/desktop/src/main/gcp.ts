// Google Cloud (docs/gcp.md, wave 6 part 4): browse every resource of the projects you choose, read-only, with
// gcloud's own sign-in. Landlens stores no Google credential: GcloudAuth asks gcloud for a token when a read needs
// one and keeps it in memory for 5 minutes; the token goes only to Google's three API origins (or, in an unpackaged
// build, the loopback fake) and never to the renderer, a file, a log line or the agent.
//
// What is kept: userData/gcp.json (0600) holds the project ids you chose, the "Claude can read" grant (the account and
// the projects you said yes to, review of part 5 M3) and the GKE clusters you said yes to connecting (each with its
// address, a hash of its CA and the account, L3). userData/gke/kubeconfig (0700/0600) is Landlens's own kubeconfig for the GKE
// clusters of those projects (part 5, D91): no token in it, and ~/.kube/config is never written.
// What is cached, in memory: the projects you can see (5 minutes); each project's resources (60 seconds, per query);
// Google's suggestions for each GKE cluster (10 minutes, wave 9 D177); each Cloud Monitoring PromQL answer (25 s, D183).
// One read per project at a time, two at once; PromQL queries four at once, in their own slot.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  CLOUD_CONFIRM, CLOUD_DECLINED, GCP_PAGE, GcpProjectId, type GcpClusterView, type GcpProject, type GcpResource, type GcpStatus, type GkeAdvice, type GkeCluster,
  type GkeRef, type KubeContext, type Responses,
} from "@landlens/contracts";
import {
  ACCOUNT_SHAPE, caFingerprint, countTypes, endpointsFor, GcloudAuth, gcloudEnv, GcpClient, GcpError, getResource, GKE_CONTEXT, gkeAdvice, gkeKubeconfig, listClusters, LOOPBACK,
  promRange, rawGcpError, resourceBrief, searchProjects, searchResources, writeGkeKubeconfig, type GkeClusterFull, type Runner,
} from "@landlens/gcp";
import type { PromAsk } from "@landlens/metrics";
import type { GcpReader } from "@landlens/gcp-mcp";
import type { SidecarTls } from "@landlens/kube";

/**
 * Where Google Cloud is on (spec D86). A packaged app always talks to Google, with the gcloud on your PATH. An
 * unpackaged build (`dev`) is off unless it has a loopback fake (LANDLENS_GCP_ENDPOINT, http://127.0.0.1:<port>) or
 * the person set LANDLENS_GCP_REAL=1 to try their own project; LANDLENS_GCLOUD (an absolute path) replaces gcloud.
 * Even then it connects no real GKE cluster (CLAUDE.md: never a cloud cluster in development; review of part 5, L4):
 * only the fake's, pointed at this machine, unless LANDLENS_GKE_REAL=1 is set as well. No test, script or agent sets
 * LANDLENS_GCP_REAL or LANDLENS_GKE_REAL.
 */
export type GcpMode = { on: false } | { on: true; endpoint?: string; gcloud?: string; dev?: true; gkeReal?: true };
export function gcpMode(env: NodeJS.ProcessEnv, packaged: boolean): GcpMode {
  if (packaged) return { on: true };
  const endpoint = env.LANDLENS_GCP_ENDPOINT && LOOPBACK.test(env.LANDLENS_GCP_ENDPOINT) ? env.LANDLENS_GCP_ENDPOINT : undefined;
  if (!endpoint && env.LANDLENS_GCP_REAL !== "1") return { on: false };
  const gcloud = env.LANDLENS_GCLOUD && isAbsolute(env.LANDLENS_GCLOUD) ? env.LANDLENS_GCLOUD : undefined;
  return { on: true, dev: true, ...(endpoint ? { endpoint } : {}), ...(gcloud ? { gcloud } : {}), ...(!endpoint && env.LANDLENS_GKE_REAL === "1" ? { gkeReal: true as const } : {}) };
}

/** The native question main asks (a grant to Claude, or a cloud cluster's first connect): the renderer can't answer it. */
export type Confirm = (q: { message: string; detail: string; yes: string }) => Promise<boolean>;

export const PROJECTS_TTL = 5 * 60_000;
export const RESOURCES_TTL = 60_000;
const ACCOUNT_TTL = 60_000;
/** Projects read at once, across the app. */
const READS_AT_ONCE = 2;
/** Cached queries (beyond each project's full list). */
const MAX_QUERIES = 10;
/** Resources held in all the cached lists together; the oldest lists go first (review of part 4, L7). */
export const MAX_CACHED = 50_000;

/**
 * A GKE cluster you said yes to connecting (L3): by name, address, a hash of its CA ("" for a DNS endpoint) and the
 * account, so a cluster recreated under the same name, moved, or opened as someone else asks again.
 */
type Confirmed = { context: string; endpoint: string; ca: string; account: string };
/** What you said yes to for Claude (M3): the account and the projects at that question. */
type Grant = { account: string; projects: string[] };
type Kept = { projects: string[]; agentRead: boolean; grant?: Grant; confirmed: Confirmed[] };
const caHash = (ca: string | undefined) => (ca ? createHash("sha256").update(ca).digest("hex") : "");
/** GKE clusters listed, kept as long as a project's resources. */
export const CLUSTERS_TTL = 60_000;
type Listed = { at: number; items: GcpResource[]; cut: boolean };
/** Google's suggestions for a GKE cluster are kept 10 minutes (Google refreshes them daily); a failure a minute (D177). */
export const ADVICE_TTL = 10 * 60_000;
export const ADVICE_FAILED_TTL = 60_000;
/** "Check again" reads at once, but at most once in 10 seconds per cluster. */
export const FRESH_EVERY = 10_000;
/** Clusters whose view is kept; the oldest goes first. */
export const MAX_VIEWS = 50;
type Advice = { items: GkeAdvice[]; cut: boolean; at: string } | { error: string };
type HeldAdvice = { at: number; ok: boolean; read: Promise<Advice> };
/**
 * A connected cluster as main knows it (D173): its context, the address it was connected at, how, and whom its sidecar
 * trusts to be the cluster (the CA's fingerprint and whether TLS checking is loosened; review of part 1, M1).
 */
export type ConnectedCluster = { context: string; server: string; viaLandlens: boolean; tls?: SidecarTls };

/**
 * `gcp:cluster-view`'s cluster, from the handle alone: its context and address and its sidecar's trust as the sidecar
 * reported them, and `viaLandlens` only when Landlens connected that very handle from its GKE kubeconfig (a context of
 * yours by the same name isn't one).
 */
export function connectedOf(
  clusters: { get(handle: string): { info: { context: string; server: string }; sidecar: { tls?: SidecarTls } } },
  gkeHandles: ReadonlySet<string>,
  handle: string,
): ConnectedCluster {
  const c = clusters.get(handle);
  return { context: c.info.context, server: c.info.server, viaLandlens: gkeHandles.has(handle), ...(c.sidecar.tls ? { tls: c.sidecar.tls } : {}) };
}

/** A PromQL answer is kept 25 s (D183): two charts of one view, the 30 s refresh and the agent share it. */
export const PROM_TTL = 25_000;
/** PromQL answers kept; the oldest go first. */
export const MAX_PROMS = 200;
/** PromQL queries in flight at once, in a slot of their own (a view asks four). */
export const PROMS_AT_ONCE = 4;
type HeldProm = { at: number; read: Promise<unknown> };

/** At most `max` calls at once; one that ends hands its place straight to the next in line. */
class Slots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.running++;
    try {
      return await f();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/** Your own GKE-named context's project, chosen, but its listing couldn't be read (wave 9 part 2): said, not silent. */
export const unlisted = (project: string, sentence: string) =>
  `Landlens couldn't list ${project}'s GKE clusters to check that this is one of them: ${sentence}`;

/** What a GKE cluster's view says when the project's number is unknown (review of part 1, L1). */
export const numberUnknown = (project: string) => `Landlens couldn't read ${project}'s number, so it can't tell which suggestions are this cluster's.`;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
/** An address's origin, or "" when it isn't a URL. */
const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

export class GcpService {
  private kept: Kept;
  private gcloud?: { path: string | undefined; at: number };
  private acct?: { value: string | undefined; at: number };
  private auth?: GcloudAuth;
  private projectsCache?: { at: number; read: Promise<{ projects: GcpProject[]; cut: boolean }> };
  private readonly lists = new Map<string, Listed>();
  private readonly reading = new Map<string, Promise<Listed>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  /** Bumped by forget(): a read that started before is not cached after (review of part 4, L2). */
  private gen = 0;
  private clustersCache?: { at: number; read: Promise<{ clusters: GkeClusterFull[]; errors: { project: string; message: string }[] }> };
  /** The GKE contexts in Landlens's kubeconfig now, by name. */
  private gke = new Map<string, GkeClusterFull>();
  /** Told the GKE contexts that left the catalog, so main disconnects them (review of part 5, L7). */
  private readonly goneListeners: ((contexts: string[]) => void)[] = [];
  /** Google's suggestions per project/location/name (D177). */
  private readonly advice = new Map<string, HeldAdvice>();
  /** Cloud Monitoring's PromQL answers, by project|query|step|from in steps (D183). */
  private readonly proms = new Map<string, HeldProm>();
  private readonly promSlots = new Slots(PROMS_AT_ONCE);

  constructor(private readonly o: {
    file: string;
    /** Where Landlens's GKE kubeconfig goes (userData/gke): made 0700, the file 0600. */
    gkeDir?: string;
    mode: GcpMode;
    /** gcloud on the login PATH (acp-host's which + loginPath), unless the mode names one. */
    findGcloud: () => Promise<string | undefined>;
    /** The login PATH, for gcloud's own environment (it needs its Python). */
    loginPath: () => Promise<string>;
    env: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    fetch?: typeof fetch;
    run?: Runner;
    now?: () => number;
    /** Claude's reading went off without the switch (gcloud's account changed): landlens-gcp leaves open sessions. */
    onAgentOff?: () => void;
  }) {
    this.kept = this.load();
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private load(): Kept {
    try {
      const raw = JSON.parse(readFileSync(this.o.file, "utf8")) as Partial<Kept>;
      const projects = Array.isArray(raw.projects) ? raw.projects.filter((p): p is string => typeof p === "string" && GcpProjectId.safeParse(p).success).slice(0, 20) : [];
      // Only entries of this shape: a name kept by an older Landlens (a bare context) asks again.
      const confirmed = Array.isArray(raw.confirmed) ? raw.confirmed.filter((c): c is Confirmed => !!c && typeof c === "object" && typeof c.context === "string" && GKE_CONTEXT.test(c.context)
        && typeof c.endpoint === "string" && c.endpoint.length <= 253 && typeof c.ca === "string" && /^([0-9a-f]{64})?$/.test(c.ca) && typeof c.account === "string" && ACCOUNT_SHAPE.test(c.account))
        .map((c) => ({ context: c.context, endpoint: c.endpoint, ca: c.ca, account: c.account })).slice(-500) : [];
      // Claude's reading needs the grant it was given with (M3): an older file's bare switch asks again.
      const g = raw.grant;
      const grant = g && typeof g === "object" && typeof g.account === "string" && ACCOUNT_SHAPE.test(g.account) && Array.isArray(g.projects)
        ? { account: g.account, projects: g.projects.filter((p): p is string => typeof p === "string" && GcpProjectId.safeParse(p).success).slice(0, 20) }
        : undefined;
      const agentRead = raw.agentRead === true && !!grant;
      return { projects: [...new Set(projects)], agentRead, ...(agentRead ? { grant } : {}), confirmed };
    } catch {
      return { projects: [], agentRead: false, confirmed: [] };
    }
  }

  private save() {
    const tmp = `${this.o.file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.kept, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.o.file);
  }

  /** gcloud's absolute path, looked for again on `fresh` or after a minute. */
  private async locate(fresh: boolean): Promise<string | undefined> {
    if (!this.o.mode.on) return undefined;
    if (!fresh && this.gcloud && this.now() - this.gcloud.at < ACCOUNT_TTL) return this.gcloud.path;
    const named = this.o.mode.gcloud;
    // With the development fake, only the gcloud named for it runs: never the real one, whose token would go to the
    // fake over plain HTTP (review of part 4, M1). Without one, gcloud is missing.
    const path = named ? (existsSync(named) ? named : undefined) : this.o.mode.endpoint ? undefined : await this.o.findGcloud();
    const usable = path && isAbsolute(path) ? path : undefined;
    if (usable !== this.gcloud?.path) {
      // Another gcloud may be signed in as someone else: nothing read with the last one is kept (L2).
      if (this.gcloud) this.forget();
      this.auth = usable ? new GcloudAuth({ gcloud: usable, env: gcloudEnv(this.o.env, await this.o.loginPath()), ...(this.o.run ? { run: this.o.run } : {}), ...(this.o.now ? { now: this.o.now } : {}) }) : undefined;
      this.acct = undefined;
    }
    this.gcloud = { path: usable, at: this.now() };
    return usable;
  }

  private async account(fresh: boolean): Promise<string | undefined> {
    if (!this.auth) return undefined;
    if (!fresh && this.acct && this.now() - this.acct.at < ACCOUNT_TTL) return this.acct.value;
    const value = await this.auth.account();
    if (this.acct && value !== this.acct.value) this.forget();
    this.acct = { value, at: this.now() };
    return value;
  }

  /** Every cache and the held token: another account signed in, or gcloud went. */
  private forget() {
    this.gen++;
    this.auth?.drop();
    this.projectsCache = undefined;
    this.clustersCache = undefined;
    this.lists.clear();
    this.advice.clear();
    this.proms.clear();
  }

  async status(fresh = false): Promise<GcpStatus> {
    const base = () => ({
      projects: [...this.kept.projects], agentRead: this.kept.agentRead,
      ...(this.kept.agentRead ? { agentProjects: this.readable() } : {}),
    });
    if (!this.o.mode.on) return { state: "off-dev", ...base() };
    if (!(await this.locate(fresh))) return { state: "missing", ...base() };
    const account = await this.account(fresh);
    if (!account) return { state: "signed-out", ...base() };
    this.settle(account);
    return { state: "ready", account, ...base() };
  }

  /**
   * gcloud is signed in as `account`: a grant to Claude given as another account ends (M3), and so does every GKE
   * cluster opened as another (L7); yes-to-connect answers of another account no longer count (L3).
   */
  private settle(account: string) {
    if (this.kept.grant && this.kept.grant.account !== account) {
      const { grant: _g, ...rest } = this.kept;
      this.kept = { ...rest, agentRead: false };
      this.save();
      this.o.onAgentOff?.();
    }
    if (this.kept.confirmed.some((c) => c.account !== account)) {
      this.kept = { ...this.kept, confirmed: this.kept.confirmed.filter((c) => c.account === account) };
      this.save();
    }
    if (this.gkeAccount !== undefined && this.gkeAccount !== account) this.dropGke([...this.gke.keys()]);
  }

  /** The account Landlens's GKE kubeconfig was last written for. */
  private gkeAccount: string | undefined;

  /** The chosen projects Claude may read: those in the grant, while it is on (M3). */
  private readable(): string[] {
    const g = this.kept.grant;
    return this.kept.agentRead && g ? this.kept.projects.filter((p) => g.projects.includes(p)) : [];
  }

  /** Main's listener for GKE contexts that left the catalog: it disconnects them (L7). */
  onGkeGone(fn: (contexts: string[]) => void) {
    this.goneListeners.push(fn);
  }

  private dropGke(contexts: string[]) {
    if (!contexts.length) return;
    for (const c of contexts) this.gke.delete(c);
    for (const fn of this.goneListeners) fn(contexts);
  }

  /** A client for the signed-in account, or the sentence that says why there is none. */
  private async client(): Promise<GcpClient> {
    const s = await this.status();
    if (s.state === "off-dev") throw fail(409, "Google Cloud is off in development builds.");
    if (s.state === "missing") throw fail(409, "Install the Google Cloud CLI, then run `gcloud auth login`.");
    if (s.state === "signed-out" || !s.account) throw fail(409, "gcloud isn't signed in. Run `gcloud auth login`.");
    const auth = this.auth!;
    const account = s.account;
    return new GcpClient({
      ...(this.o.mode.on && this.o.mode.endpoint ? { endpoints: endpointsFor(this.o.mode.endpoint) } : {}),
      auth: { token: () => auth.token(account), drop: () => auth.drop() },
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  /** A Google failure: its raw form to main's log (token cut), its sentence to the caller. */
  private failed(what: string, err: unknown): Error {
    const held = this.auth?.held();
    let line = `[gcp] ${what}: ${rawGcpError(err)}`;
    if (held) line = line.split(held).join("<token>");
    this.o.log?.(line);
    if (err instanceof GcpError) return fail(err.status || 502, err.message);
    if (typeof (err as { status?: unknown }).status === "number") return err as Error;
    return fail(500, "Google Cloud couldn't be read.");
  }

  async projects(fresh = false): Promise<Responses["gcp:projects"]> {
    const client = await this.client();
    const c = this.projectsCache;
    if (c && !fresh && this.now() - c.at < PROJECTS_TTL) return c.read;
    const read = searchProjects(client).catch((e) => {
      if (this.projectsCache?.read === read) this.projectsCache = undefined;
      throw this.failed("projects:search", e);
    });
    this.projectsCache = { at: this.now(), read };
    return read;
  }

  /**
   * The projects to browse. A project you add must be one your account can see (the project search, cached 5 minutes),
   * so a renderer can't name any other (L6 of part 4's review); one already chosen may stay or go.
   */
  async choose(projects: string[]): Promise<GcpStatus> {
    const ids = [...new Set(projects)];
    if (ids.length > 20 || ids.some((p) => !GcpProjectId.safeParse(p).success)) throw fail(400, "At most 20 project ids.");
    const added = ids.filter((p) => !this.kept.projects.includes(p));
    if (added.length) {
      const seen = new Set((await this.projects()).projects.map((p) => p.id));
      const unknown = added.filter((p) => !seen.has(p));
      if (unknown.length) throw fail(404, `Your account can't see ${unknown.join(", ")}.`);
    }
    for (const key of [...this.lists.keys()]) if (!ids.includes(key.split("\n")[0]!)) this.lists.delete(key);
    for (const key of [...this.advice.keys()]) if (!ids.includes(key.split("/")[0]!)) this.advice.delete(key);
    for (const key of [...this.proms.keys()]) if (!ids.includes(key.split("|")[0]!)) this.proms.delete(key);
    if (ids.join() !== this.kept.projects.join()) this.clustersCache = undefined;
    // A project you take out leaves Claude's grant (adding it back asks again, M3), and its GKE clusters are
    // disconnected (L7).
    const grant = this.kept.grant ? { ...this.kept.grant, projects: this.kept.grant.projects.filter((p) => ids.includes(p)) } : undefined;
    this.kept = { ...this.kept, projects: ids, ...(grant ? { grant } : {}) };
    this.save();
    this.dropGke([...this.gke.values()].filter((c) => !ids.includes(c.project)).map((c) => c.context));
    return this.status();
  }

  /**
   * "Claude can read these projects" (D93). Turning it on is a grant to the agent, so main asks in a native dialog
   * (`confirm`); the renderer can't answer for you. The grant names the account and the projects at that question
   * (M3): a project chosen later, or another account, isn't covered, and on again asks again for all of them. Turning
   * it off takes no question.
   */
  async setAgentRead(on: boolean, confirm: Confirm): Promise<GcpStatus> {
    if (!on) {
      const { grant: _g, ...rest } = this.kept;
      this.kept = { ...rest, agentRead: false };
      this.save();
      return this.status();
    }
    const s = await this.status();
    if (s.state !== "ready" || !s.account) throw fail(409, "Sign in to gcloud first.");
    if (!s.projects.length) throw fail(409, "Choose the projects first.");
    const g = this.kept.grant;
    if (this.kept.agentRead && g && g.account === s.account && s.projects.every((p) => g.projects.includes(p))) return s;
    const yes = await confirm({
      message: "Let Claude read these Google Cloud projects?",
      detail: `Claude's sessions get read-only Google Cloud tools for ${s.projects.join(", ")}, run in Landlens as ${s.account}. Claude gets no Google token; what it reads is scrubbed of secret values. Claude can't change anything in Google Cloud. A project you choose later isn't included until Landlens asks again.`,
      yes: "Let Claude read them",
    });
    if (!yes) return this.status();
    // The answer covers what the question named: the account and projects as they are now, not as they become.
    const now = await this.status();
    if (now.account !== s.account) throw fail(409, "gcloud's account changed while Landlens asked. Ask again.");
    this.kept = { ...this.kept, agentRead: true, grant: { account: s.account, projects: s.projects.filter((p) => this.kept.projects.includes(p)) } };
    this.save();
    return this.status();
  }

  /** Reads go only to projects you chose: anything else is refused before a request is made. */
  private chosen(project: string) {
    if (!this.kept.projects.includes(project)) throw fail(404, `Choose ${project} on the Google Cloud page first.`);
  }

  /**
   * Two project reads at once across the app; the rest wait their turn. A read that ends hands its place straight to
   * the next in line, so one arriving meanwhile can't take it too (review of part 4, L5).
   */
  private async slot<T>(f: () => Promise<T>): Promise<T> {
    if (this.running >= READS_AT_ONCE) await new Promise<void>((r) => this.waiting.push(r));
    else this.running++;
    try {
      return await f();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  /** Lists older than their 60 s go; then the oldest, until at most MAX_CACHED resources are held (L7). */
  private sweep() {
    const t = this.now();
    for (const [k, l] of this.lists) if (t - l.at >= RESOURCES_TTL) this.lists.delete(k);
    let total = 0;
    for (const l of this.lists.values()) total += l.items.length;
    for (const [k, l] of [...this.lists].sort((a, b) => a[1].at - b[1].at)) {
      if (total <= MAX_CACHED) break;
      this.lists.delete(k);
      total -= l.items.length;
    }
  }

  /** A project's resources (all, or for one query), cached 60 s; one read per project at a time. */
  private async list(project: string, query: string | undefined, fresh: boolean): Promise<Listed> {
    const key = `${project}\n${query ?? ""}`;
    this.sweep();
    const held = this.lists.get(key);
    if (held && !fresh && this.now() - held.at < RESOURCES_TTL) return held;
    // Wait while the project is being read, and look again each time: several waiters on one read don't all start
    // their own after it (review of part 4, L5); the first starts one and the others wait for that.
    for (let busy = this.reading.get(project); busy; busy = this.reading.get(project)) {
      await busy.catch(() => undefined);
      const again = this.lists.get(key);
      if (again && this.now() - again.at < RESOURCES_TTL) return again;
    }
    const gen = this.gen;
    // Marked as reading before anything is awaited, so a second ask for this project waits for this one.
    const read = this.client().then((client) => this.slot(() => searchResources(client, project, query ? { query } : {}))).then((r) => {
      const listed = { at: this.now(), items: r.items, cut: r.cut };
      // Kept only if nothing was forgotten meanwhile (another account, another gcloud: L2) and it is still chosen.
      if (gen === this.gen && this.kept.projects.includes(project)) {
        this.lists.set(key, listed);
        const queries = [...this.lists.keys()].filter((k) => !k.endsWith("\n"));
        if (queries.length > MAX_QUERIES) this.lists.delete(queries[0]!);
        this.sweep();
      }
      return listed;
    });
    this.reading.set(project, read);
    try {
      return await read;
    } catch (e) {
      throw this.failed(`searchAllResources ${project}`, e);
    } finally {
      if (this.reading.get(project) === read) this.reading.delete(project);
    }
  }

  async types(project: string, fresh = false): Promise<Responses["gcp:types"]> {
    this.chosen(project);
    try {
      const l = await this.list(project, undefined, fresh);
      return { types: countTypes(l.items), total: l.items.length, cut: l.cut };
    } catch (e) {
      return { types: [], total: 0, cut: false, error: (e as Error).message };
    }
  }

  async resources(r: { project: string; assetType?: string; query?: string; offset?: number }): Promise<Responses["gcp:resources"]> {
    this.chosen(r.project);
    try {
      const l = await this.list(r.project, r.query, false);
      const items = r.assetType ? l.items.filter((x) => x.assetType === r.assetType) : l.items;
      const from = r.offset ?? 0;
      return { items: items.slice(from, from + GCP_PAGE), total: items.length, cut: l.cut };
    } catch (e) {
      return { items: [], total: 0, cut: false, error: (e as Error).message };
    }
  }

  /**
   * One resource with its JSON, and the brief Ask Claude quotes (D94): fields and the configuration scrubbed whole,
   * then cut (M1), ≤ 8,000 characters. The parsed configuration itself stays in main.
   */
  async resource(project: string, name: string): Promise<Responses["gcp:resource"]> {
    const { config, ...r } = await this.resourceRaw(project, name);
    return { ...r, brief: resourceBrief(project, r.resource, config) };
  }

  private async resourceRaw(project: string, name: string): Promise<{ resource: GcpResource; json?: string; cut: boolean; config?: unknown }> {
    this.chosen(project);
    const client = await this.client();
    let r: Awaited<ReturnType<typeof getResource>>;
    try {
      r = await this.slot(() => getResource(client, project, name));
    } catch (e) {
      throw this.failed(`resource ${project}`, e);
    }
    if (!r) throw fail(404, `Google has no resource by that name in ${project} now.`);
    return r;
  }

  /** The GKE clusters of the chosen projects, for the page (no CA). */
  async clusters(): Promise<Responses["gcp:clusters"]> {
    const r = await this.clustersFull();
    return { clusters: r.clusters.map(({ ca: _ca, ...c }): GkeCluster => c), errors: r.errors };
  }

  /** The chosen projects' GKE clusters with their CAs, cached a minute; a project that fails says why, the rest load. */
  private clustersFull(fresh = false): Promise<{ clusters: GkeClusterFull[]; errors: { project: string; message: string }[] }> {
    const c = this.clustersCache;
    if (c && !fresh && this.now() - c.at < CLUSTERS_TTL) return c.read;
    // Only the development fake may point a cluster at this machine (it points one at OrbStack).
    const allowLocal = this.o.mode.on && !!this.o.mode.endpoint;
    const read = this.client().then(async (client) => {
      const clusters: GkeClusterFull[] = [];
      const errors: { project: string; message: string }[] = [];
      for (const project of [...this.kept.projects]) {
        try {
          clusters.push(...(await this.slot(() => listClusters(client, project, { allowLocal }))));
        } catch (e) {
          errors.push({ project, message: this.failed(`clusters ${project}`, e).message });
        }
      }
      return { clusters, errors };
    });
    this.clustersCache = { at: this.now(), read };
    read.catch(() => this.clustersCache?.read === read && (this.clustersCache = undefined));
    return read;
  }

  // ---- GKE clusters in the catalog (D91) ---------------------------------------------------------------------------

  /**
   * The GKE clusters of the chosen projects as catalog contexts, with Landlens's kubeconfig for them written again. When
   * Google Cloud isn't ready, or no project is chosen, there are none (and the kubeconfig is left as it was: it holds
   * no token, and a context is only connected while it is listed here).
   */
  async gkeContexts(): Promise<{ contexts: KubeContext[]; errors: { project: string; message: string }[] }> {
    const s = await this.status();
    if (s.state !== "ready" || !s.account || !this.kept.projects.length || !this.o.gkeDir || !this.gcloud?.path) {
      // Google Cloud off, gcloud gone or signed out, or no project: every GKE cluster leaves, connected ones too (L7).
      this.dropGke([...this.gke.keys()]);
      this.gke = new Map();
      return { contexts: [], errors: [] };
    }
    const r = await this.clustersFull();
    const open = r.clusters.filter((c) => c.endpoint && GKE_CONTEXT.test(c.context) && this.kept.projects.includes(c.project));
    writeGkeKubeconfig(this.o.gkeDir, gkeKubeconfig(open, this.gcloud.path, s.account));
    // A context that left the listing, or whose address or CA changed, is disconnected (L7).
    const changed = [...this.gke.values()].filter((was) => {
      const now = open.find((c) => c.context === was.context);
      return !now || now.endpoint !== was.endpoint || now.ca !== was.ca;
    }).map((c) => c.context);
    this.dropGke(changed);
    this.gke = new Map(open.map((c) => [c.context, c]));
    this.gkeAccount = s.account;
    return {
      contexts: open.map((c) => ({
        name: c.context, cluster: c.context, user: c.context, server: `https://${c.endpoint}`, current: false,
        source: "gke" as const, project: c.project, location: c.location, confirmed: this.isConfirmed(c, s.account!),
      })),
      errors: r.errors,
    };
  }

  private isConfirmed(c: GkeClusterFull, account: string): boolean {
    const ca = caHash(c.ca);
    return this.kept.confirmed.some((x) => x.context === c.context && x.endpoint === c.endpoint && x.ca === ca && x.account === account);
  }

  /**
   * How to connect a GKE context: Landlens's kubeconfig, gcloud's environment only (HOME, the login PATH for its
   * Python, CLOUDSDK_*, proxies: L6), and the sidecar's check of the address it dials (L1) unless it is the development
   * fake's. Undefined for a context the last listing didn't have. The first time (for this address, CA and account),
   * main asks "This is a cloud cluster…" itself in a native dialog (`confirm`, L3); a no is CLOUD_DECLINED (409). An
   * unpackaged build opens only the fake's clusters, on this machine, unless LANDLENS_GKE_REAL=1 (L4).
   */
  async gkeConnect(context: string, confirm: Confirm): Promise<{ kubeconfig: string; env: Record<string, string>; envOnly: true; refuseLocal: boolean } | undefined> {
    if (!GKE_CONTEXT.test(context) || !this.o.gkeDir) return undefined;
    if (!this.gke.has(context)) await this.gkeContexts();
    const c = this.gke.get(context);
    if (!c) return undefined;
    const mode = this.o.mode;
    const fakeOnly = mode.on && mode.dev && !mode.gkeReal;
    const local = /^127\.(?:\d{1,3}\.){2}\d{1,3}(?::\d+)?$/.test(c.endpoint);
    if (fakeOnly && !(mode.on && mode.endpoint && local)) {
      throw fail(403, "A development build opens only the fake's GKE clusters, on this machine. Set LANDLENS_GKE_REAL=1 as well to open a real one.");
    }
    const account = (await this.status()).account;
    if (!account) throw fail(409, "gcloud isn't signed in. Run `gcloud auth login`.");
    if (!this.isConfirmed(c, account)) {
      const yes = await confirm({
        message: `Connect ${c.name}?`,
        detail: `${CLOUD_CONFIRM}\n\nGKE cluster in ${c.project}, ${c.location}, at ${c.endpoint}. Landlens connects as ${account}, with gcloud's sign-in. It asks this once per cluster, and again if the cluster is recreated.`,
        yes: "Connect",
      });
      if (!yes) throw fail(409, CLOUD_DECLINED);
      // Still the cluster you were asked about.
      const now = this.gke.get(context);
      if (!now || now.endpoint !== c.endpoint || now.ca !== c.ca) throw fail(409, "The cluster changed while Landlens asked. Try again.");
      this.kept = { ...this.kept, confirmed: [...this.kept.confirmed.filter((x) => x.context !== context), { context, endpoint: c.endpoint, ca: caHash(c.ca), account }].slice(-500) };
      this.save();
    }
    const allowLocal = mode.on && !!mode.endpoint;
    return { kubeconfig: join(this.o.gkeDir, "kubeconfig"), env: gcloudEnv(this.o.env, await this.o.loginPath()), envOnly: true, refuseLocal: !allowLocal };
  }

  // ---- Google's view of a connected cluster (wave 9, D173–D177) --------------------------------------------------------

  /**
   * Whether a connected cluster is a GKE cluster of a chosen project (D173), the only place that answers it. A cluster
   * Landlens connected from its own listing (`viaLandlens`): that listing's entry, at the address it was listed with.
   * A context of your own kubeconfig: only when its name is gcloud's shape for a chosen project, the last listing (60 s)
   * has a cluster of exactly that name, and the listing's checked address is the one the cluster is connected at. A
   * name alone isn't enough: a context only named like a GKE cluster, or pointing elsewhere, could otherwise draw
   * another cluster's graphs and alerts. Nor is the address (review of part 1, M1): a private endpoint such as
   * 172.16.0.2 is shared by clusters in different VPCs, and a kubeconfig can loosen what TLS checks. So both kinds also
   * need the sidecar to verify TLS (no insecure-skip-tls-verify, no tls-server-name) against the CA Google lists: for an
   * IP endpoint the CA's fingerprint must be the listing's masterAuth CA's; for a gke.goog name, no CA of its own (the
   * system roots). With TLS checked against the cluster's own CA, a proxy-url can't change who answers. A GKE-shaped name of a project you haven't chosen gets a hint; anything else
   * (Google Cloud off, gcloud missing or signed out, a failed listing) is undefined, silently.
   */
  async gkeOf(c: ConnectedCluster): Promise<GkeRef | { hint: string } | undefined>;
  /**
   * With `unread`, your own context of a chosen project whose listing couldn't be read is `{ unread }` with the sentence
   * (the metrics source says it, wave 9 part 2), not silence. Who the cluster is is still only this method's answer.
   */
  async gkeOf(c: ConnectedCluster, o: { unread: true }): Promise<GkeRef | { hint: string } | { unread: string } | undefined>;
  async gkeOf(c: ConnectedCluster, o: { unread?: true } = {}): Promise<GkeRef | { hint: string } | { unread: string } | undefined> {
    if (!this.o.mode.on || !GKE_CONTEXT.test(c.context)) return undefined;
    const s = await this.status().catch(() => undefined);
    if (s?.state !== "ready") return undefined;
    const [, project, location, name] = c.context.split("_") as [string, string, string, string];
    if (!this.kept.projects.includes(project)) {
      return c.viaLandlens ? undefined : { hint: `This looks like a GKE cluster of ${project}. Choose that project on the Google Cloud page to see Google's metrics, alerts and suggestions for it.` };
    }
    let unread: string | undefined;
    const listed = c.viaLandlens
      ? this.gke.get(c.context)
      : await this.clustersFull().then(
        (r) => {
          const found = r.clusters.find((x) => x.context === c.context);
          if (!found) unread = r.errors.find((e) => e.project === project)?.message;
          return found;
        },
        (e: Error) => void (unread = e.message),
      );
    if (!listed && unread !== undefined && o.unread) return { unread: unlisted(project, unread) };
    if (!listed || !listed.endpoint || listed.project !== project || listed.location !== location || listed.name !== name) return undefined;
    if (originOf(`https://${listed.endpoint}`) !== originOf(c.server)) return undefined;
    const t = c.tls;
    if (!t || t.insecure || t.serverName || t.ca !== (listed.ca ? caFingerprint(listed.ca) : "")) return undefined;
    const number = await this.numberOf(project);
    return { project, ...(number ? { number } : {}), location, name };
  }

  /** A project's number from the project search (cached 5 minutes): the recommender names clusters by it. */
  private async numberOf(project: string): Promise<string | undefined> {
    const r = await this.projects().catch(() => undefined);
    const n = r?.projects.find((p) => p.id === project)?.number;
    return n && /^\d{1,30}$/.test(n) ? n : undefined;
  }

  /**
   * Google's view of a GKE cluster (D177): its suggestions (and, from part 3, its open alerts), each failing alone into
   * its fixed sentence. Kept per cluster 10 minutes (a failure a minute); `fresh` reads again, at most once in 10 s.
   * Reads go through the two-at-once slot. Only `gkeOf`'s answer reaches here, never a name from the page.
   */
  async clusterView(ref: GkeRef, fresh = false): Promise<GcpClusterView> {
    this.chosen(ref.project);
    const key = `${ref.project}/${ref.location}/${ref.name}`;
    const held = this.advice.get(key);
    const age = held ? this.now() - held.at : Infinity;
    const reuse = held && (fresh ? age < FRESH_EVERY : age < (held.ok ? ADVICE_TTL : ADVICE_FAILED_TTL));
    const advice = reuse ? held.read : this.readAdvice(key, ref);
    const at = new Date(this.now()).toISOString();
    return {
      gke: true,
      cluster: { project: ref.project, location: ref.location, name: ref.name },
      advice: await advice,
      // Wave 9 part 3 reads Cloud Monitoring's open alerts here.
      alerts: { items: [], others: 0, cut: false, at },
    };
  }

  private readAdvice(key: string, ref: GkeRef): Promise<Advice> {
    const gen = this.gen;
    const entry: HeldAdvice = { at: this.now(), ok: true, read: Promise.resolve({ items: [], cut: false, at: "" }) };
    // Without the project's number Landlens can't tell which suggestions are this cluster's (Google names clusters by
    // it): a sentence, kept a minute like a failure, never an empty list that reads as "nothing" (review of part 1, L1).
    const read: Promise<Advice> = ref.number
      ? this.client()
        .then((client) => this.slot(() => gkeAdvice(client, ref)))
        .then(({ items, cut }): Advice => ({ items, cut, at: new Date(this.now()).toISOString() }))
      : Promise.resolve({ error: numberUnknown(ref.project) });
    entry.read = read
      .then((r) => {
        if ("error" in r) entry.ok = false;
        return r;
      })
      .catch((e: unknown): Advice => {
        entry.ok = false;
        return { error: this.failed(`recommender ${ref.project}/${ref.location}`, e).message };
      })
      .then((r) => {
        // Kept only if nothing was forgotten meanwhile (another account, another gcloud) and the project is still chosen;
        // and only this read's own entry goes, never a newer one for the same cluster (review of part 1, T3).
        if ((gen !== this.gen || !this.kept.projects.includes(ref.project)) && this.advice.get(key) === entry) this.advice.delete(key);
        return r;
      });
    this.advice.delete(key);
    this.advice.set(key, entry);
    while (this.advice.size > MAX_VIEWS) this.advice.delete(this.advice.keys().next().value!);
    return entry.read;
  }

  /**
   * How Cloud Monitoring's PromQL is asked for a GKE cluster `gkeOf` answered (D183), handed to packages/metrics as a
   * function: it never sees the client or the token. Each answer is kept 25 s under project|query|step|from (in steps),
   * at most 200, the oldest going first; a failure isn't kept. Queries run four at once in their own slot, only while the
   * project is chosen; a failure is its fixed sentence (`failed`: the raw error to the log, token cut). An answer read
   * across an account change isn't kept for the new account.
   */
  promAsk(ref: GkeRef): PromAsk {
    return (query, fromMs, toMs, stepS) => {
      try {
        this.chosen(ref.project);
      } catch (e) {
        return Promise.reject(e);
      }
      const key = `${ref.project}|${query}|${stepS}|${Math.round(fromMs / (stepS * 1000))}`;
      const held = this.proms.get(key);
      if (held && this.now() - held.at < PROM_TTL) return held.read;
      const gen = this.gen;
      const read = this.client()
        .then((client) => this.promSlots.run(() => promRange(client, ref.project, query, fromMs, toMs, stepS)))
        .catch((e: unknown) => {
          throw this.failed(`promql ${ref.project}`, e);
        });
      const entry: HeldProm = { at: this.now(), read };
      this.proms.delete(key);
      this.proms.set(key, entry);
      while (this.proms.size > MAX_PROMS) this.proms.delete(this.proms.keys().next().value!);
      const drop = () => this.proms.get(key) === entry && this.proms.delete(key);
      read.then(() => gen !== this.gen && drop(), drop);
      return read;
    };
  }

  /** `gcp:cluster-view`: a connected cluster's view, or `{ gke: false }` (with the hint, when there is one). */
  async view(c: ConnectedCluster, fresh = false): Promise<GcpClusterView> {
    const ref = await this.gkeOf(c);
    if (!ref) return { gke: false };
    if ("hint" in ref) return { gke: false, hint: ref.hint };
    return this.clusterView(ref, fresh);
  }

  // ---- landlens-gcp, the agent's read-only tools (D93) ---------------------------------------------------------------

  /**
   * What landlens-gcp reads with, for one session, when you turned "Claude can read these projects" on and gcloud is
   * signed in; otherwise undefined and the session has no Google Cloud tools. Every read goes through this service:
   * the chosen projects only, its caches and limits.
   */
  async agentReader(connected: (context: string) => boolean): Promise<{ reader: GcpReader; projects: string[] } | undefined> {
    if (!this.kept.agentRead) return undefined;
    const s = await this.status();
    // The projects you said yes to for Claude (M3), as the session begins: a project granted later isn't readable in
    // this session, so the prompt's list stays true (L8).
    const start = this.readable();
    if (s.state !== "ready" || !start.length) return undefined;
    const allowed = () => this.readable().filter((p) => start.includes(p));
    const reader: GcpReader = {
      projects: async () => {
        const names = await this.projects().then((r) => new Map(r.projects.map((p) => [p.id, p.name])), () => new Map<string, string>());
        // Read again at each call: you may have changed the choice or turned reading off since the session began.
        return allowed().map((id) => ({ id, ...(names.get(id) ? { name: names.get(id)! } : {}) }));
      },
      types: (p) => this.agentOnly(allowed, p, () => this.types(p)),
      resources: (r) => this.agentOnly(allowed, r.project, () => this.resources(r)),
      resource: (p, n) => this.agentOnly(allowed, p, async () => {
        // The whole configuration goes to the tool, which scrubs it before it cuts (M1); the drawer's cut JSON doesn't.
        const r = await this.resourceRaw(p, n);
        return { resource: r.resource, ...(r.config !== undefined ? { config: r.config } : {}) };
      }),
      clusters: () => this.agentOnly(allowed, undefined, async () => {
        const r = await this.clusters();
        const ok = allowed();
        return { clusters: r.clusters.filter((c) => ok.includes(c.project)), errors: r.errors.filter((e) => ok.includes(e.project)) };
      }),
      connected,
    };
    return { reader, projects: start };
  }

  /** A read for the agent: reading is on, and the project is one it may read in this session (M3, L8). */
  private agentOnly<T>(allowed: () => string[], project: string | undefined, f: () => Promise<T>): Promise<T> {
    if (!this.kept.agentRead) return Promise.reject(fail(403, "The person turned off Claude's reading of Google Cloud."));
    if (project !== undefined && !allowed().includes(project)) {
      return Promise.reject(fail(403, `${project} isn't one of the projects the person let Claude read in this session.`));
    }
    return f();
  }
}
