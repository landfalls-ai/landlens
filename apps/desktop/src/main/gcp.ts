// Google Cloud (docs/gcp.md, wave 6 part 4): browse every resource of the projects you choose, read-only, with
// gcloud's own sign-in. Landlens stores no Google credential: GcloudAuth asks gcloud for a token when a read needs
// one and keeps it in memory for 5 minutes; the token goes only to Google's three API origins (or, in an unpackaged
// build, the loopback fake) and never to the renderer, a file, a log line or the agent.
//
// What is kept: userData/gcp.json (0600) holds the project ids you chose and the "Claude can read" switch (part 5).
// What is cached, in memory: the projects you can see (5 minutes); each project's resources (60 seconds, per query).
// One read per project at a time, two projects at once.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  GCP_PAGE, GcpProjectId, type GcpProject, type GcpResource, type GcpStatus, type GkeCluster, type Responses,
} from "@landlens/contracts";
import {
  countTypes, endpointsFor, GcloudAuth, gcloudEnv, GcpClient, GcpError, getResource, listClusters, LOOPBACK, rawGcpError, searchProjects, searchResources,
  type Runner,
} from "@landlens/gcp";

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

type Kept = { projects: string[]; agentRead: boolean };
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

  constructor(private readonly o: {
    file: string;
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
      return { projects: [...new Set(projects)], agentRead: raw.agentRead === true };
    } catch {
      return { projects: [], agentRead: false };
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

  async choose(projects: string[], agentRead?: boolean): Promise<GcpStatus> {
    const ids = [...new Set(projects)];
    if (ids.length > 20 || ids.some((p) => !GcpProjectId.safeParse(p).success)) throw fail(400, "At most 20 project ids.");
    for (const key of [...this.lists.keys()]) if (!ids.includes(key.split("\n")[0]!)) this.lists.delete(key);
    this.kept = { projects: ids, agentRead: agentRead ?? this.kept.agentRead };
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

  async resource(project: string, name: string): Promise<Responses["gcp:resource"]> {
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

  async clusters(): Promise<Responses["gcp:clusters"]> {
    const client = await this.client();
    const clusters: GkeCluster[] = [];
    const errors: { project: string; message: string }[] = [];
    for (const project of this.kept.projects) {
      try {
        clusters.push(...(await this.slot(() => listClusters(client, project))));
      } catch (e) {
        errors.push({ project, message: this.failed(`clusters ${project}`, e).message });
      }
    }
    return { clusters, errors };
  }
}
