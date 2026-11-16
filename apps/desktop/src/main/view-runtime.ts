// The view runtime (wave 10 part 1, docs/specs/010-views D207–D211, D225): main runs every source of an open view and
// pushes what it keeps to the page. A view reads with its own front-door token, labelled `view · <context>`, under
// the agent's read-only policy (get, list and watch only, never Secrets, every answer scrubbed) limited to the
// namespaces of the session that built it (D209); it is revoked when the view closes, its cluster goes and the window
// reloads. Two sources are the stated exception (D211): the doctor's problems and Helm's release summaries, which
// Landlens derives with your read and hands over in a closed shape.
//
// Lists and events are watches through the front door (ResourceWatcher, batches every second); logs are followed;
// top, usage, the doctor and Helm are polled. Two sources with the same target share one read. Only a view on screen
// reads: hidden 30 s, its sources stop (its token stays) and start again when it is shown. Pushes are at most one per
// source a second, and nothing read for a version, a parameter or a view that has since changed is ever delivered.
import { randomBytes } from "node:crypto";
import {
  FAILURE_LINE, Handle, type HelmRelease, type DoctorReport, type KubeObject, type MetricsSeries, NamespaceName, RowRef,
  type ResourceType, type SourceData, ViewId,
} from "@landlens/contracts";
import {
  agentReadOnlyPolicy, apiPath, type ClusterManager, followLogs, type FrontDoor, frontDoorFetch, KubeClient, KubeError,
  KEY_LINES, keyState, key as typeKey, type KeyState, ResourceWatcher, WatchBudget, type WatcherEvent, type LogLine,
} from "@landlens/kube";
import { missingChecks } from "@landlens/kube/checks";
import { quantity } from "@landlens/metrics";
import {
  BASE_KEEP, cellText, checkTimes, computed, deliver, EVENT_FIELDS, JoinTooBig, type Keep, keepFor, keepKey, LIST_FIELDS,
  logLines, mergeKeep, narrowLimits, objectRows, ownerEntry, parseDocument, parseFields, plainRows, project, runPipe, SENTENCES,
  usesWorkload, VIEW_LIMITS, VIEW_TIMES, type ParsedPath, type Row, type Source, type ViewDocument, type ViewLimits,
  type ViewTimes,
} from "@landlens/views";
import { z } from "zod";

export type ViewPush = { view: string; source: string; data: SourceData };
export type SourceStatus = Pick<SourceData, "state" | "message" | "total" | "truncated" | "at"> & { rows: number };

type MetricsReq = { scope: "cluster" | "namespace" | "node" | "deployment" | "statefulset" | "daemonset" | "pod"; namespace?: string; name?: string; range: "1h" | "6h" | "24h" };

export type ViewRuntimeDeps = {
  clusters: Pick<ClusterManager, "get" | "onGone" | "discovery">;
  frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
  /** D211: the doctor's report for every namespace, as you (DoctorService.report); main filters it to the view's. */
  doctor?: (handle: string) => Promise<DoctorReport>;
  /** D211: Helm's release summaries, as you (listReleases on the IDE's client). */
  helm?: (handle: string, namespace?: string) => Promise<{ releases: HelmRelease[]; unreadable: number }>;
  /** Usage over time, as a Claude session's `metrics` reads it (sessionSeries, no Google grant); `read` is the view's token. */
  metrics?: (handle: string, req: MetricsReq, read: (path: string) => Promise<any>) => Promise<MetricsSeries>;
  /** The view's client through the front door; tests give an in-memory API. */
  client?: (url: string, token: string, certificate: string) => KubeClient;
  push: (p: ViewPush) => void;
  now?: () => number;
  /** For tests and smaller windows: may only narrow (narrowLimits). */
  limits?: Partial<ViewLimits>;
  times?: Partial<ViewTimes>;
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// Every argument is checked as an IPC request would be (part 2 puts these behind channels).
const OpenRequest = z.object({
  handle: Handle,
  document: z.unknown(),
  namespaces: z.array(NamespaceName).min(1).max(50).optional(),
  params: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), z.string().max(253)).optional(),
}).strict();
const Params = z.record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), z.string().max(253));

// ---- feeds: the reads behind sources -------------------------------------------------------------------------------

type FeedState = { status: "loading" | "ok" | "error" | "fatal"; code?: number; message?: string };

interface Feed {
  readonly key: string;
  state: FeedState;
  start(): void;
  stop(): void;
  /** A polled feed reads again now (Refresh). */
  refresh?(): void;
}

class WatchFeed implements Feed {
  state: FeedState = { status: "loading" };
  private watcher: ResourceWatcher | undefined;
  constructor(
    readonly key: string,
    private readonly client: KubeClient,
    private readonly target: { group: string; version: string; resource: string; namespace?: string; labelSelector?: string; fieldSelector?: string },
    private readonly opts: { batchMs: number; maxItems: number; keep: Keep; budget: WatchBudget },
    private readonly changed: () => void,
  ) {}
  start() {
    // Each object trimmed to what the view's document reads, within the view's budget (security review, M5).
    const keep = this.opts.keep;
    this.watcher = new ResourceWatcher(this.client, this.target, (e) => this.on(e), {
      batchMs: this.opts.batchMs, maxItems: this.opts.maxItems, budget: this.opts.budget, project: (o) => project(o, keep),
    }).start();
  }
  stop() {
    void this.watcher?.stop();
    this.watcher = undefined;
  }
  objects(): KubeObject[] {
    return this.watcher?.snapshot() ?? [];
  }
  get truncated(): boolean {
    return !!this.watcher?.truncated;
  }
  get cutBy(): false | "items" | "budget" {
    return this.watcher?.cutBy ?? false;
  }
  private on(e: WatcherEvent) {
    if (e.type === "error") this.state = { status: e.fatal ? "fatal" : "error", code: e.status, message: e.message };
    else this.state = { status: "ok" };
    this.changed();
  }
}

class PollFeed<T> implements Feed {
  state: FeedState = { status: "loading" };
  value: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run = 0;
  private busy = false;
  private stopped = true;
  constructor(readonly key: string, private readonly read: () => Promise<T>, private readonly every: number, private readonly changed: () => void) {}
  start() {
    this.stopped = false;
    void this.tick();
  }
  stop() {
    this.stopped = true;
    this.run++;
    clearTimeout(this.timer);
  }
  refresh() {
    if (this.stopped || this.busy) return;
    clearTimeout(this.timer);
    void this.tick();
  }
  private async tick() {
    const run = ++this.run;
    this.busy = true;
    try {
      const v = await this.read();
      // A read that started before a stop, a refresh or a change is never delivered.
      if (run !== this.run || this.stopped) return;
      this.value = v;
      this.state = { status: "ok" };
    } catch (err) {
      if (run !== this.run || this.stopped) return;
      const e = err as { status?: number; message?: string };
      this.state = { status: e.status === 401 || e.status === 403 || e.status === 404 ? "fatal" : "error", code: e.status ?? 0, message: e.message ?? String(err) };
    } finally {
      if (run === this.run) this.busy = false;
    }
    if (run !== this.run || this.stopped) return;
    this.changed();
    this.timer = setTimeout(() => void this.tick(), this.every);
  }
}

type KeptLine = { ts: string; text: string; failure: boolean; n: number };

/** Followed logs of a pod, or of up to five pods of a workload, merged by time; the last `tail` lines kept. */
class LogFeed implements Feed {
  state: FeedState = { status: "loading" };
  lines: KeptLine[] = [];
  pods = { followed: 0, total: 0 };
  private n = 0;
  private stops = new Map<string, () => void>();
  private last = new Map<string, string>();
  /** Each pod's log is one stream: whether a private key it logged is still open (security review, M1). */
  private keys = new Map<string, KeyState>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = new Set<ReturnType<typeof setTimeout>>();
  private stopped = true;
  private gen = 0;
  constructor(
    readonly key: string,
    private readonly client: KubeClient,
    private readonly s: { namespace: string; pod?: string; workload?: { kind: string; name: string }; container?: string; tail: number; previous: boolean },
    private readonly t: { podsEvery: number; retry: number; maxPods: number },
    private readonly changed: () => void,
  ) {}
  start() {
    this.stopped = false;
    const gen = ++this.gen;
    if (this.s.pod) void this.follow(this.s.pod, gen);
    else void this.findPods(gen);
  }
  stop() {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.timer);
    for (const t of this.retries) clearTimeout(t);
    this.retries.clear();
    for (const s of this.stops.values()) s();
    this.stops.clear();
  }
  private live(gen: number) {
    return !this.stopped && gen === this.gen;
  }
  private fail(e: { status?: number; message?: string }, gen: number) {
    if (!this.live(gen)) return;
    const status = e.status ?? 0;
    this.state = { status: status === 401 || status === 403 || status === 404 ? "fatal" : "error", code: status, message: e.message ?? "" };
    this.changed();
  }
  /** A workload's pods, by its selector, read with the view's token; the newest running ones followed. */
  private async findPods(gen: number) {
    const w = this.s.workload!;
    const t = w.kind === "Job" ? { group: "batch", version: "v1", resource: "jobs" } : { group: "apps", version: "v1", resource: `${w.kind.toLowerCase()}s` };
    try {
      const obj = await this.client.json(apiPath(t, this.s.namespace, w.name));
      const labels: Record<string, unknown> = obj?.spec?.selector?.matchLabels ?? {};
      const sel = Object.entries(labels).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}=${v}`).join(",");
      if (!sel) throw new KubeError(404, "no selector");
      const q = new URLSearchParams({ labelSelector: sel, limit: "200" });
      const list = await this.client.json(`${apiPath({ group: "", version: "v1", resource: "pods" }, this.s.namespace)}?${q}`);
      if (!this.live(gen)) return;
      const pods = ((list?.items ?? []) as KubeObject[])
        // A pod that hasn't started has no log yet: the next look finds it once it has.
        .filter((p) => !p.metadata.deletionTimestamp && p.status?.phase !== "Pending")
        .sort((a, b) => Number(b.status?.phase === "Running") - Number(a.status?.phase === "Running") || String(b.metadata.creationTimestamp ?? "").localeCompare(String(a.metadata.creationTimestamp ?? "")));
      const chosen = pods.slice(0, this.t.maxPods).map((p) => p.metadata.name);
      this.pods = { followed: chosen.length, total: pods.length };
      for (const [name, stop] of this.stops) if (!chosen.includes(name)) (stop(), this.stops.delete(name));
      for (const name of [...this.keys.keys()]) if (!chosen.includes(name)) this.keys.delete(name);
      for (const name of chosen) if (!this.stops.has(name)) void this.follow(name, gen);
      if (this.state.status !== "ok" || !chosen.length) {
        this.state = { status: "ok" };
        this.changed();
      }
    } catch (err) {
      this.fail(err as KubeError, gen);
    }
    if (this.live(gen)) this.timer = setTimeout(() => void this.findPods(gen), this.t.podsEvery);
  }
  private async follow(pod: string, gen: number) {
    let container = this.s.container;
    if (!container) {
      try {
        const p = await this.client.json(apiPath({ group: "", version: "v1", resource: "pods" }, this.s.namespace, pod));
        container = p?.spec?.containers?.[0]?.name;
      } catch (err) {
        return this.fail(err as KubeError, gen);
      }
      if (!container) return this.fail({ status: 404, message: "no container" }, gen);
    }
    if (!this.live(gen)) return;
    if (this.state.status === "loading") {
      this.state = { status: "ok" };
      this.changed();
    }
    const since = this.last.get(pod);
    const stop = followLogs(this.client, {
      namespace: this.s.namespace, pod, container, previous: this.s.previous, follow: !this.s.previous,
      // KEY_LINES more than are kept: a key that began before the kept lines is seen from its BEGIN, then cut away (M1).
      ...(since ? { sinceTime: since } : { tailLines: this.s.tail + KEY_LINES }),
    }, {
      lines: (batch) => {
        if (!this.live(gen)) return;
        this.add(pod, batch);
      },
      end: (e) => {
        this.stops.delete(pod);
        if (!this.live(gen)) return;
        // One of a workload's pods whose log can't be read now (restarting, just gone) is looked for again with the
        // rest; a refusal (401, 403) is the source's.
        if (e.status && (this.s.pod || e.status === 401 || e.status === 403)) return this.fail(e, gen);
        this.state = { status: "ok" };
        this.changed();
        // A followed log that ended (a restart, a dropped stream) is followed again from its last line.
        // A workload's pods are followed again by the next findPods.
        if (!this.s.previous && this.s.pod) {
          const t = setTimeout(() => {
            this.retries.delete(t);
            if (this.live(gen) && !this.stops.has(pod)) void this.follow(pod, gen);
          }, this.t.retry);
          this.retries.add(t);
        }
      },
    });
    this.stops.set(pod, stop);
  }
  private add(pod: string, batch: LogLine[]) {
    let st = this.keys.get(pod);
    if (!st) this.keys.set(pod, (st = keyState()));
    const texts = logLines(batch.map((l) => l.text), st);
    batch.forEach((l, i) => {
      if (l.ts) this.last.set(pod, l.ts);
      const text = texts[i]!;
      this.lines.push({ ts: l.ts, text, failure: FAILURE_LINE.test(text), n: ++this.n });
    });
    if (this.s.workload) this.lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.n - b.n));
    if (this.lines.length > this.s.tail) this.lines = this.lines.slice(-this.s.tail);
    this.state = { status: "ok" };
    this.changed();
  }
}

// ---- views ---------------------------------------------------------------------------------------------------------

type SourceRun = {
  id: string;
  source: Source;
  /** The feeds this source reads, in order; `owners` are $workload's hidden ReplicaSet and Job watches. */
  feeds: string[];
  owners: string[];
  /** Set when the source can't run at all (out of the view's scope, an unknown kind): no feed, no request. */
  refused?: Pick<SourceData, "state" | "message">;
  type?: { group: string; version: string; resource: string; kind: string };
  fields?: [string, ParsedPath][];
  /** Rows after the pipe, before the 2,000-row cut: what a join reads. */
  piped: Row[];
  /** Whether `piped` is the full answer: false while loading, failed or cut (a join that reads it says so). */
  whole: boolean;
  data: SourceData;
  /**
   * What this source's data was read for: its document, its reads, the parameters and the same of every source it
   * joins. Kept data is kept only when this is unchanged (security review, M6).
   */
  sig: string;
  lastPush: number;
  pushTimer?: ReturnType<typeof setTimeout>;
};

/** A read a source needs, planned before any is made: a watch (shared by target, its Keep merged) or another feed. */
type Read =
  | { watch: true; base: string; target: { group: string; version: string; resource: string; namespace?: string; labelSelector?: string; fieldSelector?: string }; keep: Keep }
  | { watch: false; key: string; make: () => Feed };

type View = {
  id: string;
  handle: string;
  context: string;
  token: string;
  client: KubeClient;
  namespaces?: string[];
  document: ViewDocument;
  /** By name, with no prototype: a parameter named like an Object method reads nothing inherited (L5). */
  params: Record<string, string>;
  /**
   * The values the person picked, apart from the defaults `params` fills in (review of part 2, M3): a new version keeps
   * a pick only while it fits, and never takes a default as if it were one.
   */
  picked: Record<string, string>;
  /** Bumped by every change (a version, a parameter, a stop): reads and pushes of an older one are dropped. */
  gen: number;
  /**
   * The generation `sources` were built for. While a sync waits (on discovery) it is behind `gen`: nothing is computed,
   * pushed or answered from the older sources (security review, M6).
   */
  ready: number;
  /** What the view's watches keep together (M5). */
  budget: WatchBudget;
  /** Sources whose reads changed since they were last computed; computed once, when their push is due (M3). */
  dirty: Set<string>;
  computeTimer?: ReturnType<typeof setTimeout>;
  /** Events age out of `sinceMinutes` on this tick, with no watch event (L6). */
  eventsTimer?: ReturnType<typeof setInterval>;
  feeds: Map<string, Feed>;
  sources: Map<string, SourceRun>;
  running: boolean;
  visible: boolean;
  hideTimer?: ReturnType<typeof setTimeout>;
  lastRefresh: number;
  closed: boolean;
};

const PODS = { group: "", version: "v1", resource: "pods", kind: "Pod" };
const NODES = { group: "", version: "v1", resource: "nodes", kind: "Node" };
const EVENTS = { group: "", version: "v1", resource: "events", kind: "Event" };
const HELM_STATUS = new Set(["unknown", "deployed", "uninstalled", "superseded", "failed", "uninstalling", "pending-install", "pending-upgrade", "pending-rollback"]);
const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const CHART_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const VERSION = /^[\w.+-]{1,64}$/;

export class ViewRuntime {
  private readonly views = new Map<string, View>();
  private readonly L: ViewLimits;
  private readonly T: ViewTimes;
  private readonly now: () => number;
  private computes = 0;

  constructor(private readonly deps: ViewRuntimeDeps) {
    this.L = narrowLimits({ ...VIEW_LIMITS } as ViewLimits, deps.limits);
    this.T = checkTimes({ ...VIEW_TIMES }, deps.times);
    this.now = deps.now ?? Date.now;
    // A cluster that goes (disconnected, its sidecar gone, another account) takes its views and their tokens with it.
    deps.clusters.onGone((handle) => {
      for (const v of [...this.views.values()]) if (v.handle === handle) this.close(v.id);
    });
  }

  /** Open a view: mint its token, start its sources. The document is validated again here, whoever built it. */
  open(req: { handle: string; document: unknown; namespaces?: string[]; params?: Record<string, string> }): string {
    const r = OpenRequest.safeParse(req);
    if (!r.success) throw fail(400, "not a valid view request");
    const parsed = parseDocument(r.data.document);
    if (!parsed.ok) throw Object.assign(fail(400, "the view document isn't valid"), { issues: parsed.issues });
    if (this.views.size >= this.L.openViews) throw fail(429, SENTENCES.overLimit("open views", this.views.size + 1, this.L.openViews));
    const c = this.deps.clusters.get(r.data.handle);
    const namespaces = r.data.namespaces ? [...new Set(r.data.namespaces)] : undefined;
    // Everything that can refuse the open is checked before a token exists (security review, L1).
    const { params, picked } = this.checkParams(parsed.document, r.data.params ?? {}, true);
    const label = `view · ${c.info.context}`;
    const token = this.deps.frontDoor.issueToken({ label, policy: agentReadOnlyPolicy(namespaces), clusters: [r.data.handle] });
    let id = "";
    try {
      const url = this.deps.frontDoor.clusterUrl(r.data.handle);
      const certificate = this.deps.frontDoor.certificate;
      const client = this.deps.client?.(url, token, certificate) ?? new KubeClient({ url, secret: "" }, frontDoorFetch({ certificate, token }));
      do id = randomBytes(8).toString("hex");
      while (this.views.has(id));
      const view: View = {
        id, handle: r.data.handle, context: c.info.context, token, client, ...(namespaces ? { namespaces } : {}),
        document: parsed.document, params, picked, gen: 0, ready: 0, budget: new WatchBudget(this.L.viewObjects, this.L.viewChars),
        dirty: new Set(), feeds: new Map(), sources: new Map(), running: false, visible: true, lastRefresh: 0, closed: false,
      };
      this.views.set(id, view);
      void this.sync(view);
      return id;
    } catch (e) {
      // A token whose view didn't open is never left behind.
      if (id) this.views.delete(id);
      this.deps.frontDoor.revokeToken(token);
      throw e;
    }
  }

  /**
   * A new version of the view's document: sources that read the same thing keep their reads; the rest start again.
   * Everything is checked before anything changes (review of part 2, M3): a document that doesn't parse leaves the view
   * as it was. A value the person picked that the new version's parameter doesn't take is let go, and the parameter
   * reads its default. Answers the picks kept.
   */
  update(viewId: string, document: unknown): Record<string, string> {
    const v = this.view(viewId);
    const parsed = parseDocument(document);
    if (!parsed.ok) throw Object.assign(fail(400, "the view document isn't valid"), { issues: parsed.issues });
    const { params, picked } = this.checkParams(parsed.document, v.picked, false);
    v.document = parsed.document;
    v.params = params;
    v.picked = picked;
    void this.sync(v);
    return { ...picked };
  }

  /** The person picked a parameter's value: checked against the parameter's type, or refused. Answers the picks. */
  setParams(viewId: string, params: Record<string, string>): Record<string, string> {
    const v = this.view(viewId);
    const p = Params.safeParse(params);
    if (!p.success) throw fail(400, "not valid parameters");
    const next = this.checkParams(v.document, { ...v.picked, ...p.data }, true);
    v.params = next.params;
    v.picked = next.picked;
    void this.sync(v);
    return { ...next.picked };
  }

  /** Refresh: polled sources read again now, at most once per 5 s. Answers whether it ran. */
  refresh(viewId: string): boolean {
    const v = this.view(viewId);
    const t = this.now();
    if (t - v.lastRefresh < this.T.refresh || !v.running) return false;
    v.lastRefresh = t;
    for (const f of v.feeds.values()) f.refresh?.();
    return true;
  }

  /** The view left the screen: its sources stop 30 s later; its token stays. */
  hide(viewId: string) {
    const v = this.view(viewId);
    v.visible = false;
    clearTimeout(v.hideTimer);
    v.hideTimer = setTimeout(() => {
      if (!v.visible && !v.closed) this.stopFeeds(v);
    }, this.T.hiddenStop);
  }

  show(viewId: string) {
    const v = this.view(viewId);
    v.visible = true;
    clearTimeout(v.hideTimer);
    if (!v.running) void this.sync(v);
  }

  /** Close a view: stop its reads and revoke its token. */
  close(viewId: string) {
    const v = this.views.get(viewId);
    if (!v) return;
    this.views.delete(viewId);
    v.closed = true;
    clearTimeout(v.hideTimer);
    this.stopFeeds(v);
    for (const s of v.sources.values()) clearTimeout(s.pushTimer);
    this.deps.frontDoor.revokeToken(v.token);
  }

  /** The window reloaded or went: every view closes. */
  closeAll() {
    for (const id of [...this.views.keys()]) this.close(id);
  }

  data(viewId: string, source: string): SourceData | undefined {
    const v = this.view(viewId);
    const s = v.sources.get(source);
    return s ? structuredClone(this.current(v, s)) : undefined;
  }

  /** Each source's state and counts: what part 2 tells Claude and the page (no row of it). */
  status(viewId: string): Record<string, SourceStatus> {
    const out: Record<string, SourceStatus> = {};
    const v = this.view(viewId);
    for (const [id, s] of v.sources) {
      const { state, message, total, truncated, at, rows } = this.current(v, s);
      out[id] = { state, ...(message ? { message } : {}), rows: rows.length, total, truncated, at };
    }
    return out;
  }

  /** Whether an object is one of the rows the view shows now (part 3's intents may only name these). */
  shows(viewId: string, ref: unknown): boolean {
    const r = RowRef.safeParse(ref);
    if (!r.success) return false;
    const k = refKey(r.data);
    const v = this.view(viewId);
    // While a change is being built, no row of the older sources counts (M6).
    if (v.ready !== v.gen) return false;
    for (const s of v.sources.values()) if (s.data.rows.some((row) => row._ref && refKey(row._ref) === k)) return true;
    return false;
  }

  /**
   * The row object a frame's link names (kind, namespace, name: all a landlens://object link carries), when it is one
   * of the rows the view shows now; else none (D219: a frame can't aim at an object the view doesn't show).
   */
  findRef(viewId: string, t: { kind: string; namespace?: string; name: string }, sources?: readonly string[]): RowRef | undefined {
    const v = this.views.get(viewId);
    if (!v || v.ready !== v.gen) return undefined;
    for (const [id, s] of v.sources) {
      // A block's intent finds its targets among its own sources only (wave 10 part 3, D219).
      if (sources && !sources.includes(id)) continue;
      for (const row of s.data.rows) {
        const r = row._ref;
        if (r && r.kind === t.kind && r.name === t.name && (r.namespace ?? undefined) === (t.namespace ?? undefined)) return structuredClone(r);
      }
    }
    return undefined;
  }

  get size() {
    return this.views.size;
  }

  /** How many times a source's rows were worked out, in all (the tests' count of main's work, M3). */
  get computeRuns() {
    return this.computes;
  }

  // ---- the work ------------------------------------------------------------------------------------------------

  private view(id: string): View {
    if (!ViewId.safeParse(id).success) throw fail(400, "not a view id");
    const v = this.views.get(id);
    if (!v) throw fail(404, "That view isn't open.");
    return v;
  }

  /** A source's data as main may answer it now: nothing of an older version while a change is being built (M6). */
  private current(v: View, s: SourceRun): SourceData {
    return v.ready === v.gen ? s.data : { state: "loading", rows: [], total: 0, truncated: false, at: s.data.at };
  }

  /**
   * Parameter values: the person's picks, each checked against its parameter, and the defaults for the rest; a name the
   * document has no parameter for is dropped. `strict`: a pick that doesn't fit is refused (the person's own pick);
   * otherwise it is let go and the default is read (a new version, whose parameter changed). No prototype (L5).
   */
  private checkParams(d: ViewDocument, given: Record<string, string>, strict: boolean): { params: Record<string, string>; picked: Record<string, string> } {
    const params: Record<string, string> = Object.create(null);
    const picked: Record<string, string> = Object.create(null);
    const fits = (p: NonNullable<ViewDocument["params"]>[number], v: string): boolean =>
      p.type === "namespace" ? NamespaceName.safeParse(v).success : p.type === "choice" ? p.options.includes(v) : true;
    for (const p of d.params ?? []) {
      const mine = Object.hasOwn(given, p.name) ? given[p.name]! : undefined;
      if (mine !== undefined && !fits(p, mine)) {
        if (strict) throw fail(400, p.type === "namespace" ? `${p.name} isn't a namespace` : `${p.name} isn't one of its options`);
      } else if (mine !== undefined) {
        picked[p.name] = params[p.name] = p.type === "text" ? cellText(mine, 100) : mine;
        continue;
      }
      // The schema holds a default to its parameter's type (a choice's among its options).
      if (p.default !== undefined) params[p.name] = p.type === "text" ? cellText(p.default, 100) : p.default;
    }
    return { params, picked };
  }

  private stopFeeds(v: View) {
    v.gen++;
    v.running = false;
    for (const f of v.feeds.values()) f.stop();
    v.feeds.clear();
    clearTimeout(v.computeTimer);
    v.computeTimer = undefined;
    v.dirty.clear();
    clearInterval(v.eventsTimer);
    v.eventsTimer = undefined;
    // What a stopped view read isn't kept in main (security review, M5): it is read again when it is shown.
    for (const s of v.sources.values()) {
      clearTimeout(s.pushTimer);
      s.pushTimer = undefined;
      s.piped = [];
      s.whole = false;
      s.data = { state: "loading", rows: [], total: 0, truncated: false, at: s.data.at };
    }
  }

  /**
   * (Re)build a view's sources and feeds from its document and parameters; reads with the same target are kept. Each
   * source is planned on its own and takes its reads only if all of them fit (L3); a source keeps the data it had only
   * if it, its reads, the parameters and every source it joins are unchanged (M6).
   */
  private async sync(v: View) {
    const gen = ++v.gen;
    // Until this version's sources are built, nothing of the older ones is computed or pushed (M6).
    for (const s of v.sources.values()) {
      clearTimeout(s.pushTimer);
      s.pushTimer = undefined;
    }
    clearTimeout(v.computeTimer);
    v.computeTimer = undefined;
    v.dirty.clear();
    let types: ResourceType[] = [];
    const needsTypes = Object.values(v.document.sources).some((s) => s.kind === "kube.list");
    if (needsTypes) {
      try {
        types = await this.deps.clusters.discovery(v.handle);
      } catch {
        types = [];
      }
    }
    if (gen !== v.gen || v.closed) return;
    // Hidden: nothing of the old version may go on reading; show() builds this version.
    if (!v.visible) return this.stopFeeds(v);
    const old = v.feeds;
    const sources = new Map<string, SourceRun>();
    const watches = new Map<string, { target: Extract<Read, { watch: true }>["target"]; keep: Keep }>();
    const others = new Map<string, () => Feed>();
    for (const [id, source] of Object.entries(v.document.sources)) {
      const prev = v.sources.get(id);
      const run: SourceRun = {
        id, source, feeds: [], owners: [], piped: [], whole: false, lastPush: prev?.lastPush ?? 0, sig: "",
        data: { state: "loading", rows: [], total: 0, truncated: false, at: 0 },
      };
      sources.set(id, run);
      const reads: Read[] = [];
      try {
        this.plan(v, run, types, reads);
      } catch {
        run.refused = { state: "error", message: SENTENCES.noAnswer };
      }
      const keys = new Set(reads.map((r) => (r.watch ? r.base : r.key)));
      const fresh = [...keys].filter((k) => !watches.has(k) && !others.has(k)).length;
      if (!run.refused && watches.size + others.size + fresh > this.L.feeds) {
        run.refused = { state: "error", message: SENTENCES.overLimit("reads in this view", watches.size + others.size + fresh, this.L.feeds) };
      }
      if (run.refused) {
        run.feeds = [];
        run.owners = [];
        continue;
      }
      for (const r of reads) {
        if (!r.watch) {
          if (!others.has(r.key)) others.set(r.key, r.make);
          continue;
        }
        const w = watches.get(r.base);
        watches.set(r.base, w ? { target: w.target, keep: mergeKeep(w.keep, r.keep) } : { target: r.target, keep: r.keep });
      }
    }
    // A watch's key names its target and what it keeps: sources on one target share it; a version that reads more of
    // its objects starts it again.
    const finalKey = new Map<string, string>();
    const feeds = new Map<string, Feed>();
    for (const [base, w] of watches) {
      const key = `${base}|${keepKey(w.keep)}`;
      finalKey.set(base, key);
      feeds.set(key, old.get(key) ?? new WatchFeed(key, v.client, w.target, { batchMs: this.T.batch, maxItems: this.L.watchObjects, keep: w.keep, budget: v.budget }, () => this.feedChanged(v, key)));
    }
    for (const [key, make] of others) feeds.set(key, old.get(key) ?? make());
    const params = JSON.stringify(Object.keys(v.params).sort().map((k) => [k, v.params[k]]));
    for (const id of joinOrder(sources)) {
      const run = sources.get(id)!;
      run.feeds = run.feeds.map((k) => finalKey.get(k) ?? k);
      run.owners = run.owners.map((k) => finalKey.get(k) ?? k);
      run.sig = JSON.stringify([run.source, run.feeds, run.owners, run.refused ?? null, params, joinsOf(run.source).map((j) => sources.get(j)?.sig ?? "")]);
      const prev = v.sources.get(id);
      if (prev && prev.sig === run.sig) run.data = prev.data;
    }
    // Stopped before the new ones start: a stopped watch gives its share of the view's budget back.
    for (const [k, f] of old) if (!feeds.has(k)) f.stop();
    v.feeds = feeds;
    v.sources = sources;
    v.running = true;
    v.ready = gen;
    for (const [k, f] of feeds) if (!old.has(k)) f.start();
    this.startEventsTick(v);
    // Kept feeds with data, refused sources: computed now; the rest as their reads answer.
    this.recompute(v, [...sources.keys()]);
  }

  /** Every minute (VIEW_TIMES.eventsTick), events sources are computed again, so an event ages out with no change (L6). */
  private startEventsTick(v: View) {
    clearInterval(v.eventsTimer);
    v.eventsTimer = undefined;
    const ids = [...v.sources.values()].filter((s) => s.source.kind === "kube.events" && !s.refused).map((s) => s.id);
    if (!ids.length) return;
    v.eventsTimer = setInterval(() => {
      if (v.closed || !v.running || v.ready !== v.gen) return;
      for (const id of ids) v.dirty.add(id);
      this.scheduleCompute(v);
    }, this.T.eventsTick);
  }

  /** The namespaces a source reads: `all` (everything the view may), or a list; a namespace outside the limit is refused. */
  private namespacesOf(v: View, value: unknown): { all: true } | { list: string[] } | { refused: string } {
    let ns: string | undefined;
    if (value === undefined || value === "*") ns = undefined;
    else if (typeof value === "string") ns = value;
    else if (value && typeof value === "object" && "param" in value) {
      // Own parameters only: `constructor` names nothing (L5).
      const p = (value as { param: string }).param;
      ns = Object.hasOwn(v.params, p) ? v.params[p] : undefined;
    }
    if (ns === undefined) return v.namespaces ? { list: v.namespaces } : { all: true };
    if (v.namespaces && !v.namespaces.includes(ns)) return { refused: SENTENCES.scope(ns, v.namespaces) };
    return { list: [ns] };
  }

  /**
   * Which reads a source needs, planned into `reads` (nothing is made here; sync shares them by key); or why it can't
   * run. A watch says what of its objects the source reads (keepFor), so the view keeps only that (M5).
   */
  private plan(v: View, run: SourceRun, types: ResourceType[], reads: Read[]) {
    const s = run.source;
    const changed = (key: string) => () => this.feedChanged(v, key);
    const want = (key: string, make: () => Feed) => (reads.push({ watch: false, key, make }), key);
    const watch = (t: { group: string; version: string; resource: string }, ns: string | undefined, sel: { labelSelector?: string; fieldSelector?: string } = {}, keep: Keep = BASE_KEEP) => {
      const target = { ...t, ...(ns ? { namespace: ns } : {}), ...sel };
      const base = `w|${t.group}|${t.version}|${t.resource}|${ns ?? ""}|${sel.labelSelector ?? ""}|${sel.fieldSelector ?? ""}`;
      reads.push({ watch: true, base, target, keep });
      return base;
    };
    const each = (ns: { all: true } | { list: string[] }) => ("all" in ns ? [undefined] : ns.list);
    switch (s.kind) {
      case "kube.list": {
        const t = types.find((x) => x.resource === s.resource && x.group === (s.group ?? ""));
        if (!t) return void (run.refused = { state: "unknown", message: SENTENCES.unknownKind(s.resource, s.group) });
        run.type = { group: t.group, version: s.version ?? t.version, resource: t.resource, kind: t.kind };
        run.fields = parseFields(s.fields ?? LIST_FIELDS);
        const sel = { ...(s.labelSelector ? { labelSelector: s.labelSelector } : {}), ...(s.fieldSelector ? { fieldSelector: s.fieldSelector } : {}) };
        const keep = keepFor(run.fields);
        if (!t.namespaced) {
          run.feeds.push(watch(run.type, undefined, sel, keep));
          return;
        }
        const ns = this.namespacesOf(v, s.namespace);
        if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
        for (const n of each(ns)) run.feeds.push(watch(run.type, n, sel, keep));
        if (usesWorkload(s)) {
          for (const n of each(ns)) {
            run.owners.push(watch({ group: "apps", version: "v1", resource: "replicasets" }, n), watch({ group: "batch", version: "v1", resource: "jobs" }, n));
          }
        }
        return;
      }
      case "kube.events": {
        run.type = EVENTS;
        run.fields = parseFields(s.fields ?? EVENT_FIELDS);
        const ns = this.namespacesOf(v, s.namespace);
        if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
        const sel = s.warningsOnly ? { fieldSelector: "type=Warning" } : {};
        const keep = keepFor(run.fields);
        for (const n of each(ns)) run.feeds.push(watch(EVENTS, n, sel, keep));
        if (usesWorkload(s)) for (const n of each(ns)) run.owners.push(watch({ group: "apps", version: "v1", resource: "replicasets" }, n), watch({ group: "batch", version: "v1", resource: "jobs" }, n));
        return;
      }
      case "kube.logs": {
        const ns = this.namespacesOf(v, s.namespace);
        if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
        if (!("list" in ns) || ns.list.length !== 1) return void (run.refused = { state: "error", message: SENTENCES.noAnswer });
        const namespace = ns.list[0]!;
        const key = `l|${namespace}|${s.pod ?? ""}|${s.workload ? `${s.workload.kind}/${s.workload.name}` : ""}|${s.container ?? ""}|${s.tailLines ?? 200}|${s.previous ? 1 : 0}`;
        run.feeds.push(want(key, () => new LogFeed(key, v.client, {
          namespace, ...(s.pod ? { pod: s.pod } : {}), ...(s.workload ? { workload: s.workload } : {}), ...(s.container ? { container: s.container } : {}),
          tail: Math.min(s.tailLines ?? 200, this.L.logLines), previous: !!s.previous,
        }, { podsEvery: this.T.logPods, retry: this.T.logRetry, maxPods: this.L.logPods }, changed(key))));
        return;
      }
      case "kube.top": {
        const nodes = s.of === "nodes";
        // Nodes' usage is the whole cluster's: refused here for a namespace-limited view, with no request (L4). The
        // token alone would let it through, since nodes.metrics.k8s.io is cluster-scoped and discovery knows it.
        if (nodes && v.namespaces) return void (run.refused = { state: "forbidden", message: SENTENCES.scopeCluster(v.namespaces) });
        const ns = nodes ? ({ all: true } as const) : this.namespacesOf(v, s.namespace);
        if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
        for (const n of nodes ? [undefined] : each(ns)) {
          const key = `t|${s.of}|${n ?? ""}`;
          run.feeds.push(want(key, () => new PollFeed(key, () => this.top(v.client, s.of, n), this.T.top, changed(key))));
        }
        return;
      }
      case "metrics.series": {
        if (!this.deps.metrics) return void (run.refused = { state: "off", message: SENTENCES.metricsOff });
        let namespace: string | undefined;
        if (s.scope === "cluster" || s.scope === "node") {
          if (v.namespaces) return void (run.refused = { state: "forbidden", message: SENTENCES.scopeCluster(v.namespaces) });
        } else {
          const ns = this.namespacesOf(v, s.namespace);
          if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
          if (!("list" in ns) || ns.list.length !== 1) return void (run.refused = { state: "error", message: SENTENCES.noAnswer });
          namespace = ns.list[0];
        }
        const req: MetricsReq = { scope: s.scope, range: s.range, ...(namespace ? { namespace } : {}), ...(s.name ? { name: s.name } : {}) };
        const key = `m|${JSON.stringify(req)}`;
        const metrics = this.deps.metrics;
        run.feeds.push(want(key, () => new PollFeed(key, () => metrics(v.handle, req, (path) => v.client.json(path)), this.T.metrics, changed(key))));
        return;
      }
      case "doctor.problems": {
        const ns = this.namespacesOf(v, s.namespace);
        if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
        if (!this.deps.doctor) return void (run.refused = { state: "off", message: SENTENCES.doctorOff });
        // One report for every namespace, as the Overview's (so a view doesn't take one of the doctor's two scopes);
        // main keeps only the view's namespaces' problems (computeDoctor).
        const key = "d|";
        const doctor = this.deps.doctor;
        run.feeds.push(want(key, () => new PollFeed(key, () => doctor(v.handle), this.T.doctor, changed(key))));
        return;
      }
      case "helm.releases": {
        const ns = this.namespacesOf(v, s.namespace);
        if ("refused" in ns) return void (run.refused = { state: "forbidden", message: ns.refused });
        if (!this.deps.helm) return void (run.refused = { state: "off", message: SENTENCES.helmOff });
        const helm = this.deps.helm;
        for (const n of each(ns)) {
          const key = `h|${n ?? ""}`;
          run.feeds.push(want(key, () => new PollFeed(key, () => helm(v.handle, n), this.T.helm, changed(key))));
        }
        return;
      }
    }
  }

  /** metrics-server's usage now, read with the view's token. */
  private async top(client: KubeClient, of: "pods" | "nodes", namespace?: string): Promise<Row[]> {
    let list: any;
    try {
      list = await client.json(apiPath({ group: "metrics.k8s.io", version: "v1beta1", resource: of }, of === "pods" ? namespace : undefined));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 503) throw Object.assign(new Error(SENTENCES.noMetricsServer), { status: 404, unavailable: true });
      throw err;
    }
    const items: unknown[] = Array.isArray(list?.items) ? list.items.slice(0, this.L.watchObjects) : [];
    const sum = (cs: unknown[], k: "cpu" | "memory") => cs.reduce((a: number, c) => {
      const q = quantity((c as { usage?: Record<string, unknown> })?.usage?.[k]);
      return Number.isFinite(q) ? a + q : a;
    }, 0);
    return items.flatMap((m: any) => {
      const cs: unknown[] = of === "pods" ? (Array.isArray(m?.containers) ? m.containers.slice(0, 50) : []) : [m];
      const ref = RowRef.safeParse({ ...(of === "pods" ? PODS : NODES), ...(of === "pods" ? { namespace: m?.metadata?.namespace } : {}), name: m?.metadata?.name });
      if (!ref.success) return [];
      return [{ name: ref.data.name, ...(of === "pods" ? { namespace: ref.data.namespace ?? null } : {}), cpu: sum(cs, "cpu"), memory: sum(cs, "memory"), _ref: ref.data } as Row];
    });
  }

  /**
   * A read changed: its sources are marked, and computed once when their push is due (at most once per T.push a
   * source), off the watch's own callback (security review, M3: every batch recomputed at once froze main).
   */
  private feedChanged(v: View, key: string) {
    if (v.closed || !v.running || v.ready !== v.gen || !v.feeds.has(key)) return;
    for (const s of v.sources.values()) if (s.feeds.includes(key) || s.owners.includes(key)) v.dirty.add(s.id);
    this.scheduleCompute(v);
  }

  private scheduleCompute(v: View) {
    if (v.computeTimer || !v.dirty.size) return;
    let due = Infinity;
    for (const id of v.dirty) due = Math.min(due, (v.sources.get(id)?.lastPush ?? 0) + this.T.push);
    v.computeTimer = setTimeout(() => {
      v.computeTimer = undefined;
      const ids = [...v.dirty];
      v.dirty.clear();
      if (v.closed || !v.running || v.ready !== v.gen) return;
      this.recompute(v, ids);
    }, Math.max(0, due - this.now()));
  }

  /** Recompute sources, then every source that joins one of them (joins form no circle: the schema refused one). */
  private recompute(v: View, ids: string[]) {
    const order = joinOrder(v.sources);
    const todo = new Set(ids);
    for (const id of order) {
      const s = v.sources.get(id)!;
      const joins = ("pipe" in s.source ? (s.source.pipe ?? []) : []).flatMap((st) => ("join" in st ? [st.join.with] : []));
      if (!todo.has(id) && !joins.some((j) => todo.has(j))) continue;
      todo.add(id);
      this.compute(v, s);
    }
  }

  /** A source's rows worked out; whatever goes wrong in that is its error, never main's (L2). */
  private compute(v: View, s: SourceRun) {
    this.computes++;
    try {
      this.work(v, s);
    } catch (e) {
      s.piped = [];
      s.whole = false;
      s.data = { state: "error", message: e instanceof JoinTooBig ? e.message : SENTENCES.computeFailed, rows: [], total: 0, truncated: false, at: this.now() };
      this.schedulePush(v, s);
    }
  }

  private work(v: View, s: SourceRun) {
    const at = this.now();
    const done = (data: Omit<SourceData, "at">, whole: boolean, piped: Row[] = []) => {
      s.piped = piped;
      s.whole = whole;
      s.data = { ...data, at };
      this.schedulePush(v, s);
    };
    if (s.refused) return done({ ...s.refused, rows: [], total: 0, truncated: false }, false);
    const feeds = s.feeds.map((k) => v.feeds.get(k)).filter((f): f is Feed => !!f);
    // A feed that failed for good says why; one still loading keeps the source loading: never an empty all-clear.
    const fatal = feeds.find((f) => f.state.status === "fatal");
    if (fatal) return done({ ...this.failure(v, s, fatal.state), rows: [], total: 0, truncated: false }, false);
    if (feeds.some((f) => f.state.status === "loading")) return done({ state: "loading", rows: s.data.rows, total: s.data.total, truncated: s.data.truncated }, false);
    const erred = feeds.find((f) => f.state.status === "error");
    const notes: string[] = [];
    let truncated = false;
    let base: Row[] = [];
    let series: MetricsSeries | undefined;
    let lines: SourceData["lines"];
    let state: SourceData["state"] = "ok";
    const src = s.source;
    if (src.kind === "kube.list" || src.kind === "kube.events") {
      const owners = new Map<string, { kind: string; name: string }>();
      for (const k of s.owners) {
        const f = v.feeds.get(k) as WatchFeed | undefined;
        if (!f || f.state.status !== "ok") {
          if (!notes.includes(OWNERS_UNREAD)) notes.push(OWNERS_UNREAD);
          truncated = true;
          continue;
        }
        const kind = k.includes("|replicasets|") ? "ReplicaSet" : "Job";
        for (const o of f.objects()) {
          const e = ownerEntry(o, kind);
          if (e) owners.set(e[0], e[1]);
        }
      }
      // At most sourceObjects over all of the source's watches (M3: a "*" is one watch per namespace of the limit).
      let objects: KubeObject[] = [];
      let sourceCut = false;
      for (const f of feeds as WatchFeed[]) {
        const room = this.L.sourceObjects - objects.length;
        const got = f.objects();
        if (got.length > room) sourceCut = true;
        objects = objects.concat(got.length > room ? got.slice(0, Math.max(0, room)) : got);
      }
      const cuts = new Set((feeds as WatchFeed[]).map((f) => f.cutBy));
      if (cuts.has("items")) notes.push(SENTENCES.watchCut(this.L.watchObjects));
      if (sourceCut && !cuts.has("items")) notes.push(SENTENCES.watchCut(this.L.sourceObjects));
      if (cuts.has("budget")) notes.push(SENTENCES.viewCut);
      if (cuts.has("items") || cuts.has("budget") || sourceCut) truncated = true;
      if (src.kind === "kube.events") {
        const since = at - (src.sinceMinutes ?? 60) * 60_000;
        objects = objects.filter((o) => {
          const t = computed("$last", { ...o, kind: "Event" });
          return typeof t === "number" && t >= since;
        });
      }
      base = objectRows(objects, s.fields ?? [], s.type!, { owners, now: at });
    } else if (src.kind === "kube.top") {
      for (const f of feeds as PollFeed<Row[]>[]) base = base.concat(f.value ?? []);
      base = plainRows(base, src.fields ? parseFields(src.fields) : undefined);
    } else if (src.kind === "metrics.series") {
      series = (feeds[0] as PollFeed<MetricsSeries> | undefined)?.value;
      if (series) {
        base = (series.namespaces ?? []).slice(0, this.L.rows).map((n) => ({ namespace: cellText(n.key, 253), cpu: finite(n.cpu), memory: finite(n.memory) }));
        if (series.source === "none") {
          state = "unavailable";
          // The reader's reason is its own words (Prometheus's error text included): the page shows it while the source
          // is unavailable, which Claude hears as a fixed sentence. A later read that fails makes the state `error`,
          // whose message Claude does hear, so then it goes (review of wave 10 part 2, L3).
          if (!erred) notes.push(series.reasons[0] ? cellText(series.reasons[0].message, 300) : SENTENCES.metricsOff);
        }
        base = plainRows(base, src.fields ? parseFields(src.fields) : undefined);
      }
    } else if (src.kind === "doctor.problems") {
      const report = (feeds[0] as PollFeed<DoctorReport> | undefined)?.value;
      if (report) {
        const r = this.doctorRows(v, src, report);
        base = plainRows(r.rows, src.fields ? parseFields(src.fields) : undefined);
        if (r.podsForbidden) return done({ state: "forbidden", message: SENTENCES.rbac("pods"), rows: [], total: 0, truncated: false }, false);
        if (r.notes.length) {
          truncated = true;
          notes.push(...r.notes);
        }
      }
    } else if (src.kind === "helm.releases") {
      let unreadable = 0;
      for (const f of feeds as PollFeed<{ releases: HelmRelease[]; unreadable: number }>[]) {
        const r = helmRows(f.value?.releases ?? []);
        unreadable += (f.value?.unreadable ?? 0) + r.dropped;
        base = base.concat(r.rows);
      }
      base = plainRows(base, src.fields ? parseFields(src.fields) : undefined);
      if (unreadable) {
        truncated = true;
        notes.push(SENTENCES.helmUnreadable(unreadable));
      }
    } else if (src.kind === "kube.logs") {
      const f = feeds[0] as LogFeed | undefined;
      const kept = f?.lines ?? [];
      lines = kept.map((l) => ({ n: l.n, text: l.text, failure: l.failure }));
      if (f && src.workload && f.pods.total === 0 && f.state.status === "ok") notes.push(SENTENCES.logNoPods);
      if (f && f.pods.total > f.pods.followed) {
        truncated = true;
        notes.push(SENTENCES.logPodsCut(f.pods.followed, f.pods.total));
      }
      if (erred) notes.push(this.failure(v, s, erred.state).message!);
      return done({ state: erred ? "error" : "ok", ...(notes.length ? { message: notes.join(" ") } : {}), rows: [], total: lines.length, truncated, lines }, !erred);
    }
    // Joins: a side that isn't whole is said, never joined as if empty.
    const pipe = "pipe" in src ? (src.pipe ?? []) : [];
    for (const st of pipe) {
      if (!("join" in st)) continue;
      const other = v.sources.get(st.join.with);
      if (!other || (other.data.state !== "ok" && other.data.state !== "loading")) notes.push(SENTENCES.joinMissing(st.join.with));
      else if (other.data.state === "loading") notes.push(SENTENCES.joinMissing(st.join.with));
      else if (!other.whole || other.data.truncated) notes.push(SENTENCES.joinCut(st.join.with));
      else continue;
      truncated = true;
    }
    let piped = runPipe(base, pipe, { params: v.params, rowsOf: (id) => v.sources.get(id)?.piped, joinWork: this.L.joinWork });
    // What a source keeps (what a join reads) holds at most sourceChars of text (M5).
    const fit = rowsWithin(piped, this.L.sourceChars);
    if (fit < piped.length) {
      piped = piped.slice(0, fit);
      truncated = true;
      notes.push(SENTENCES.rowsTooBig(fit));
    }
    const out = deliver(piped, this.L.rows);
    if (out.truncated) {
      truncated = true;
      notes.push(SENTENCES.rowsCut(out.rows.length, out.total));
    }
    if (erred) {
      // A read that failed this time (the watch backs off and retries): the last rows stay, said to be stale.
      state = "error";
      notes.unshift(this.failure(v, s, erred.state).message!);
    }
    done({ state, ...(notes.length ? { message: notes.join(" ") } : {}), rows: out.rows, total: out.total, truncated, ...(series ? { series } : {}) }, !erred && !truncated && state === "ok", piped);
  }

  /** D222's sentence for a failed read. */
  private failure(v: View, s: SourceRun, st: FeedState): Pick<SourceData, "state" | "message"> {
    const what = s.type ? typeKey(s.type.resource, s.type.group) : s.source.kind === "kube.top" ? `${s.source.of}.metrics.k8s.io` : s.source.kind === "helm.releases" ? "Helm releases" : s.source.kind === "kube.logs" ? "pods/log" : "pods";
    const code = st.code ?? 0;
    if (s.source.kind === "kube.top" && code === 404) return { state: "unavailable", message: SENTENCES.noMetricsServer };
    if (code === 403) {
      // The front door's own refusal (its message starts "Landlens:"): the view's scope; else the cluster's RBAC.
      if (/^Landlens:/.test(st.message ?? "") && v.namespaces) return { state: "forbidden", message: SENTENCES.scopeCluster(v.namespaces) };
      return { state: "forbidden", message: SENTENCES.rbac(what) };
    }
    if (code === 404) {
      if (s.source.kind === "kube.logs") return { state: "error", message: SENTENCES.logGone };
      if (s.source.kind === "kube.list") return { state: "unknown", message: SENTENCES.unknownKind(s.source.resource, s.source.group) };
      return { state: "error", message: SENTENCES.failed(s.id, 404) };
    }
    if (code === 401) return { state: "error", message: SENTENCES.notReadable };
    return { state: "error", message: code ? SENTENCES.failed(s.id, code) : SENTENCES.noAnswer };
  }

  /** D211: the doctor's problems as rows, only the view's namespaces', in a closed shape; what it couldn't check, said. */
  private doctorRows(v: View, src: Extract<Source, { kind: "doctor.problems" }>, report: DoctorReport): { rows: Row[]; notes: string[]; podsForbidden: boolean } {
    const ns = this.namespacesOf(v, src.namespace);
    const allowed = "list" in ns ? new Set(ns.list) : undefined;
    const rows: Row[] = [];
    for (const p of report.problems) {
      if (allowed && (!p.namespace || !allowed.has(p.namespace))) continue;
      const ref = RowRef.safeParse({ group: p.group, version: p.version, resource: p.resource, kind: p.kind, ...(p.namespace ? { namespace: p.namespace } : {}), name: p.name });
      const since = p.since ? Date.parse(p.since) : NaN;
      rows.push({
        kind: cellText(p.kind, 64), namespace: p.namespace ? cellText(p.namespace, 63) : null, name: cellText(p.name, 253), tone: p.tone,
        class: p.class, reason: cellText(p.reason, 100), title: cellText(p.title, 500), detail: cellText(p.detail, 500),
        pods: finite(p.podCount), restarts: p.restarts === undefined ? null : finite(p.restarts), since: Number.isFinite(since) ? since : null,
        ...(ref.success ? { _ref: ref.data } : {}), _tone: p.tone,
      });
    }
    const notes = missingChecks(report.checks).map((t) => cellText(t, 300));
    if (report.cut) notes.push(SENTENCES.watchCut(rows.length));
    return { rows, notes, podsForbidden: report.checks.pods === "forbidden" };
  }

  /** At most one push per source a second; the latest data wins; nothing for a stopped, hidden or changed view. */
  private schedulePush(v: View, s: SourceRun) {
    if (s.pushTimer) return;
    const gen = v.gen;
    const send = () => {
      s.pushTimer = undefined;
      if (v.closed || gen !== v.gen || v.ready !== v.gen || !v.visible || v.sources.get(s.id) !== s) return;
      s.lastPush = this.now();
      this.deps.push({ view: v.id, source: s.id, data: structuredClone(s.data) });
    };
    const wait = s.lastPush + this.T.push - this.now();
    if (wait <= 0) send();
    else s.pushTimer = setTimeout(send, wait);
  }
}

const OWNERS_UNREAD = "ReplicaSets or Jobs couldn't be read, so a pod's workload may stop at them.";

/** Sources in an order where each comes after the sources it joins. */
function joinOrder(sources: ReadonlyMap<string, SourceRun>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || depth > 16) return;
    seen.add(id);
    const s = sources.get(id);
    if (!s) return;
    for (const j of joinsOf(s.source)) visit(j, depth + 1);
    out.push(id);
  };
  for (const id of sources.keys()) visit(id, 0);
  return out;
}

const joinsOf = (src: Source): string[] => ("pipe" in src ? (src.pipe ?? []) : []).flatMap((st) => ("join" in st ? [st.join.with] : []));

/** How many of the rows fit in `max` characters (cell text, keys, about 100 for a `_ref`). */
function rowsWithin(rows: readonly Row[], max: number): number {
  let chars = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    for (const k of Object.keys(r)) {
      const c = r[k];
      chars += k.length + (typeof c === "string" ? c.length : c && typeof c === "object" ? 100 : 8);
    }
    if (chars > max) return i;
  }
  return rows.length;
}

const finite = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
const refKey = (r: { group: string; resource: string; namespace?: string; name: string }) => `${r.group}/${r.resource}/${r.namespace ?? ""}/${r.name}`;

/** D211: a release summary's eight fields, each checked; a release whose name or namespace isn't one is left out. */
export function helmRows(releases: readonly HelmRelease[]): { rows: Row[]; dropped: number } {
  const rows: Row[] = [];
  let dropped = 0;
  for (const r of releases.slice(0, VIEW_LIMITS.watchObjects)) {
    if (typeof r?.name !== "string" || r.name.length > 53 || !RELEASE_NAME.test(r.name) || !NamespaceName.safeParse(r.namespace).success) {
      dropped++;
      continue;
    }
    const updated = typeof r.updated === "string" ? Date.parse(r.updated) : NaN;
    rows.push({
      name: r.name,
      namespace: r.namespace,
      chart: typeof r.chart === "string" && CHART_NAME.test(r.chart) ? r.chart : null,
      chartVersion: typeof r.chartVersion === "string" && VERSION.test(r.chartVersion) ? r.chartVersion : null,
      appVersion: typeof r.appVersion === "string" && VERSION.test(r.appVersion) ? r.appVersion : null,
      status: typeof r.status === "string" && HELM_STATUS.has(r.status) ? r.status : "unknown",
      revision: Number.isInteger(r.revision) && r.revision > 0 ? r.revision : null,
      updated: Number.isFinite(updated) ? updated : null,
    });
  }
  return { rows, dropped };
}
