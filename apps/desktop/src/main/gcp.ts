// Google Cloud (docs/gcp.md, wave 6 part 4): browse every resource of the projects you choose, read-only, with
// gcloud's own sign-in. Landlens stores no Google credential: GcloudAuth asks gcloud for a token when a read needs
// one and keeps it in memory for 5 minutes; the token goes only to Google's three API origins (or, in an unpackaged
// build, the loopback fake) and never to the renderer, a file, a log line or the agent.
//
// What is kept: userData/gcp.json (0600) holds the project ids you chose, the "Claude can read" switch and the GKE
// clusters you said yes to connecting. userData/gke/kubeconfig (0700/0600) is Landlens's own kubeconfig for the GKE
// clusters of those projects (part 5, D91): no token in it, and ~/.kube/config is never written.
// What is cached, in memory: the projects you can see (5 minutes); each project's resources (60 seconds, per query).
// One read per project at a time, two projects at once.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  GCP_PAGE, GcpProjectId, type GcpProject, type GcpResource, type GcpStatus, type GkeCluster, type KubeContext, type Responses,
} from "@landlens/contracts";
import {
  countTypes, endpointsFor, GcloudAuth, gcloudEnv, GcpClient, GcpError, getResource, GKE_CONTEXT, gkeKubeconfig, listClusters, LOOPBACK, rawGcpError,
  resourceBrief, searchProjects, searchResources, writeGkeKubeconfig, type GkeClusterFull, type Runner,
} from "@landlens/gcp";
import type { GcpReader } from "@landlens/gcp-mcp";

/**
 * Where Google Cloud is on (spec D86). A packaged app always talks to Google, with the gcloud on your PATH. An
 * unpackaged build is off unless it has a loopback fake (LANDLENS_GCP_ENDPOINT, http://127.0.0.1:<port>) or the person
 * set LANDLENS_GCP_REAL=1 to try their own project; LANDLENS_GCLOUD (an absolute path) replaces gcloud. No test,
 * script or agent sets LANDLENS_GCP_REAL.
 */
export type GcpMode = { on: false } | { on: true; endpoint?: string; gcloud?: string };
export function gcpMode(env: NodeJS.ProcessEnv, packaged: boolean): GcpMode {
  if (packaged) return { on: true };
  const endpoint = env.LANDLENS_GCP_ENDPOINT && LOOPBACK.test(env.LANDLENS_GCP_ENDPOINT) ? env.LANDLENS_GCP_ENDPOINT : undefined;
  if (!endpoint && env.LANDLENS_GCP_REAL !== "1") return { on: false };
  const gcloud = env.LANDLENS_GCLOUD && isAbsolute(env.LANDLENS_GCLOUD) ? env.LANDLENS_GCLOUD : undefined;
  return { on: true, ...(endpoint ? { endpoint } : {}), ...(gcloud ? { gcloud } : {}) };
}

export const PROJECTS_TTL = 5 * 60_000;
export const RESOURCES_TTL = 60_000;
const ACCOUNT_TTL = 60_000;
/** Projects read at once, across the app. */
const READS_AT_ONCE = 2;
/** Cached queries (beyond each project's full list). */
const MAX_QUERIES = 10;

type Kept = { projects: string[]; agentRead: boolean; confirmed: string[] };
/** GKE clusters listed, kept as long as a project's resources. */
export const CLUSTERS_TTL = 60_000;
type Listed = { at: number; items: GcpResource[]; cut: boolean };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

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
  private clustersCache?: { at: number; read: Promise<{ clusters: GkeClusterFull[]; errors: { project: string; message: string }[] }> };
  /** The GKE contexts in Landlens's kubeconfig now, by name. */
  private gke = new Map<string, GkeClusterFull>();

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
      const confirmed = Array.isArray(raw.confirmed) ? raw.confirmed.filter((c): c is string => typeof c === "string" && GKE_CONTEXT.test(c)).slice(0, 500) : [];
      return { projects: [...new Set(projects)], agentRead: raw.agentRead === true, confirmed: [...new Set(confirmed)] };
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
    const path = named ? (existsSync(named) ? named : undefined) : await this.o.findGcloud();
    const usable = path && isAbsolute(path) ? path : undefined;
    if (usable !== this.gcloud?.path) {
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
    this.auth?.drop();
    this.projectsCache = undefined;
    this.clustersCache = undefined;
    this.lists.clear();
  }

  async status(fresh = false): Promise<GcpStatus> {
    const base = { projects: [...this.kept.projects], agentRead: this.kept.agentRead };
    if (!this.o.mode.on) return { state: "off-dev", ...base };
    if (!(await this.locate(fresh))) return { state: "missing", ...base };
    const account = await this.account(fresh);
    if (!account) return { state: "signed-out", ...base };
    return { state: "ready", account, ...base };
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
    if (ids.join() !== this.kept.projects.join()) this.clustersCache = undefined;
    this.kept = { ...this.kept, projects: ids };
    this.save();
    return this.status();
  }

  /**
   * "Claude can read these projects" (D93). Turning it on is a grant to the agent, so main asks in a native dialog
   * (`confirm`); the renderer can't answer for you. Turning it off takes no question.
   */
  async setAgentRead(on: boolean, confirm: (q: { message: string; detail: string; yes: string }) => Promise<boolean>): Promise<GcpStatus> {
    if (on && !this.kept.agentRead) {
      const s = await this.status();
      if (s.state !== "ready") throw fail(409, "Sign in to gcloud first.");
      if (!s.projects.length) throw fail(409, "Choose the projects first.");
      const yes = await confirm({
        message: "Let Claude read these Google Cloud projects?",
        detail: `Claude's sessions get read-only Google Cloud tools for ${s.projects.join(", ")}, run in Landlens as ${s.account}. Claude gets no Google token; what it reads is scrubbed of secret values. Claude can't change anything in Google Cloud.`,
        yes: "Let Claude read them",
      });
      if (!yes) return this.status();
    }
    this.kept = { ...this.kept, agentRead: on };
    this.save();
    return this.status();
  }

  /** Reads go only to projects you chose: anything else is refused before a request is made. */
  private chosen(project: string) {
    if (!this.kept.projects.includes(project)) throw fail(404, `Choose ${project} on the Google Cloud page first.`);
  }

  /** Two project reads at once across the app; the rest wait their turn. */
  private async slot<T>(f: () => Promise<T>): Promise<T> {
    if (this.running >= READS_AT_ONCE) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await f();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** A project's resources (all, or for one query), cached 60 s; one read per project at a time. */
  private async list(project: string, query: string | undefined, fresh: boolean): Promise<Listed> {
    const key = `${project}\n${query ?? ""}`;
    const held = this.lists.get(key);
    if (held && !fresh && this.now() - held.at < RESOURCES_TTL) return held;
    const busy = this.reading.get(project);
    if (busy) {
      await busy.catch(() => undefined);
      const again = this.lists.get(key);
      if (again && this.now() - again.at < RESOURCES_TTL) return again;
    }
    // Marked as reading before anything is awaited, so a second ask for this project waits for this one.
    const read = this.client().then((client) => this.slot(() => searchResources(client, project, query ? { query } : {}))).then((r) => {
      const listed = { at: this.now(), items: r.items, cut: r.cut };
      if (this.kept.projects.includes(project)) {
        this.lists.set(key, listed);
        const queries = [...this.lists.keys()].filter((k) => !k.endsWith("\n"));
        if (queries.length > MAX_QUERIES) this.lists.delete(queries[0]!);
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

  /** One resource with its JSON, and the brief Ask Claude quotes (D94): fields and scrubbed JSON, ≤ 8,000 characters. */
  async resource(project: string, name: string): Promise<Responses["gcp:resource"]> {
    const r = await this.resourceRaw(project, name);
    return { ...r, brief: resourceBrief(project, r.resource, r.json) };
  }

  private async resourceRaw(project: string, name: string): Promise<{ resource: GcpResource; json?: string; cut: boolean }> {
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
      this.gke = new Map();
      return { contexts: [], errors: [] };
    }
    const r = await this.clustersFull();
    const open = r.clusters.filter((c) => c.endpoint && GKE_CONTEXT.test(c.context));
    writeGkeKubeconfig(this.o.gkeDir, gkeKubeconfig(open, this.gcloud.path, s.account));
    this.gke = new Map(open.map((c) => [c.context, c]));
    return {
      contexts: open.map((c) => ({
        name: c.context, cluster: c.context, user: c.context, server: `https://${c.endpoint}`, current: false,
        source: "gke" as const, project: c.project, location: c.location, confirmed: this.kept.confirmed.includes(c.context),
      })),
      errors: r.errors,
    };
  }

  /**
   * How to connect a GKE context: Landlens's kubeconfig and the login PATH (gcloud needs its Python). Undefined for a
   * context the last listing didn't have. `cloud`: you said yes to the cloud-cluster question now, which is kept; a
   * context you never said yes to is refused with that question (409).
   */
  async gkeConnect(context: string, cloud: boolean): Promise<{ kubeconfig: string; env: Record<string, string> } | undefined> {
    if (!GKE_CONTEXT.test(context) || !this.o.gkeDir) return undefined;
    if (!this.gke.has(context)) await this.gkeContexts();
    if (!this.gke.has(context)) return undefined;
    if (!this.kept.confirmed.includes(context)) {
      if (!cloud) throw fail(409, "This is a cloud cluster: say yes to connecting it first.");
      this.kept = { ...this.kept, confirmed: [...this.kept.confirmed, context].slice(-500) };
      this.save();
    }
    return { kubeconfig: join(this.o.gkeDir, "kubeconfig"), env: { PATH: await this.o.loginPath() } };
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
    if (s.state !== "ready" || !s.projects.length) return undefined;
    const reader: GcpReader = {
      projects: async () => {
        const names = await this.projects().then((r) => new Map(r.projects.map((p) => [p.id, p.name])), () => new Map<string, string>());
        // Read again at each call: you may have changed the choice or turned reading off since the session began.
        if (!this.kept.agentRead) return [];
        return this.kept.projects.map((id) => ({ id, ...(names.get(id) ? { name: names.get(id)! } : {}) }));
      },
      types: (p) => this.agentOnly(() => this.types(p)),
      resources: (r) => this.agentOnly(() => this.resources(r)),
      resource: (p, n) => this.agentOnly(() => this.resourceRaw(p, n)),
      clusters: () => this.agentOnly(() => this.clusters()),
      connected,
    };
    return { reader, projects: s.projects };
  }

  private agentOnly<T>(f: () => Promise<T>): Promise<T> {
    if (!this.kept.agentRead) return Promise.reject(fail(403, "The person turned off Claude's reading of Google Cloud."));
    return f();
  }
}
