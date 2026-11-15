// Landflow on a resource (docs/family.md#landflow-on-a-resource, wave 7 part 4, D119–D126), in main.
//
// Every send is the person's click on a sheet that showed what leaves. The window asks main to prepare a sheet with
// choices only (a problem's id in the scope's current report, a severity, whether to add log lines; an object, whether
// to add its YAML); main builds the body from the cluster's own report, keeps it under the sheet's id, and gives the
// window that body to show. Send names the sheet, and main sends exactly what it kept, to the Landflow it holds the key
// and webhook secret for, with an Idempotency-Key per sheet (a retry of one click never starts two runs). A sheet
// belongs to the window that asked for it.
//
// A send or run gets an id of main's (`lr…`): landflow:follow reads the run in Landflow (status, Landfall's
// TriggerResult, a flow's last node's output, scrubbed and cut) and landflow:open opens the run or the room after the
// native dialog that shows the host. Landlens never calls Landfall: the room's address is only read from the run.
// Sends to triage are remembered without secrets in family-sent.json (D124), for the problems' chips.
import { randomBytes } from "node:crypto";
import { LANDFLOW_NOTES, type AlertPreview, type FlowPreview, type LandflowFlow, type LandflowRun, type LandflowSent, type Problem, type ResourceRef, type TriageAlert, type TriageSeverity, type FlowInput } from "@landlens/contracts";
import { executeFlow, FamilyError, getExecution, listFlows, runLink, sendAlert, type ExecutionView, type FamilySentStore, type SentEntry, type TriggerResult } from "@landlens/connections";
import { alertFor, flowInput, KubeError, redactObject, redactText, type AlertLogs } from "@landlens/kube";
import { rawError } from "@landlens/mcp-gateway";
import type { DoctorEvidence, KubeObject, ResourceType } from "@landlens/contracts";
import { stringify } from "yaml";
import type { FamilyService } from "./family";

export const LANDFLOW = {
  /** A sheet is kept this long, and at most this many at once. */
  sheetMs: 30 * 60_000,
  sheets: 20,
  /** Runs followed from this launch (flows); sends to triage are in family-sent.json. */
  runs: 50,
  /** One read of a run serves every ask within this. */
  followMs: 1_500,
  output: 4_000,
  yaml: 32 * 1024,
} as const;

type Owner = object;
type AlertSheet = { kind: "alert"; owner: Owner; at: number; handle: string; cluster: string; problem: Problem; alert: TriageAlert; sent?: string };
type FlowSheet = { kind: "flow"; owner: Owner; at: number; handle: string; input: FlowInput; sent?: Map<string, string> };
type Sheet = AlertSheet | FlowSheet;
type FlowRunRecord = { origin: string; executionId: string; workflowId: string; at: number; last?: LandflowRun; reading?: { at: number; p: Promise<LandflowRun> } };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const id = (prefix: "ls" | "lr") => `${prefix}${randomBytes(18).toString("base64url")}`;

export type LandflowDeps = {
  family: Pick<FamilyService, "landflowUse" | "log">;
  doctor: { problem(handle: string, namespace: string | undefined, id: string): Problem; evidence(handle: string, namespace: string | undefined, id: string): Promise<DoctorEvidence> };
  clusters: { context(handle: string): string; typeOf(handle: string, ref: ResourceRef): Promise<ResourceType>; getObject(handle: string, ref: ResourceRef): Promise<KubeObject> };
  sent: FamilySentStore;
  fetch?: typeof fetch;
  now?: () => number;
};

export class LandflowActions {
  private readonly sheets = new Map<string, Sheet>();
  private readonly runs = new Map<string, FlowRunRecord>();
  private readonly triageReads = new Map<string, { at: number; p: Promise<LandflowRun> }>();
  constructor(private readonly d: LandflowDeps) {}

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  private landflow() {
    const lf = this.d.family.landflowUse();
    if (!lf) throw fail(409, LANDFLOW_NOTES.notReady);
    return lf;
  }

  /** A failure as the window sees it: a fixed sentence; the raw error to main's log, secrets cut. */
  private failure(err: unknown): Error & { status: number } {
    if (err instanceof FamilyError) {
      if (err.raw !== undefined) this.d.family.log(`[landflow] ${rawError(err.raw)}`);
      return fail(err.status, err.message);
    }
    if (err instanceof KubeError) return fail(err.status, err.message);
    if (typeof (err as { status?: unknown })?.status === "number") return err as Error & { status: number };
    this.d.family.log(`[landflow] ${rawError(err)}`);
    return fail(502, "Landflow's answer wasn't what Landlens expected.");
  }

  private keep(sheet: string | undefined, s: Sheet): string {
    const now = this.now;
    for (const [k, v] of this.sheets) if (now - v.at > LANDFLOW.sheetMs) this.sheets.delete(k);
    // Asked again with the same sheet (another severity, the box ticked): the same id, so the same Idempotency-Key,
    // while nothing has been sent from it.
    const prior = sheet ? this.sheets.get(sheet) : undefined;
    const reuse = prior && prior.owner === s.owner && prior.kind === s.kind && !prior.sent ? sheet! : undefined;
    if (!reuse && this.sheets.size >= LANDFLOW.sheets) {
      const oldest = [...this.sheets.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
      this.sheets.delete(oldest[0]);
    }
    const key = reuse ?? id("ls");
    this.sheets.set(key, s);
    return key;
  }

  private sheet<K extends Sheet["kind"]>(key: string, kind: K, owner: Owner): Extract<Sheet, { kind: K }> {
    const s = this.sheets.get(key);
    if (!s || s.kind !== kind || s.owner !== owner || this.now - s.at > LANDFLOW.sheetMs) throw fail(404, LANDFLOW_NOTES.noSheet);
    return s as Extract<Sheet, { kind: K }>;
  }

  // ---- A problem to triage (D120–D124) ------------------------------------------------------------------------------

  /**
   * The alert for a problem in the scope's current report, built here (D120), kept under a sheet for this window. Log
   * lines only when asked: the problem's evidence (the kubelet's, else Clickland's), the last 40, scrubbed.
   */
  async prepareAlert(req: { handle: string; namespace?: string; problem: string; severity: TriageSeverity; logs: boolean; sheet?: string }, owner: Owner): Promise<AlertPreview> {
    const lf = this.landflow();
    if (!lf.triage) throw fail(409, LANDFLOW_NOTES.noTriage);
    const cluster = this.d.clusters.context(req.handle);
    const p = this.d.doctor.problem(req.handle, req.namespace, req.problem);
    let logs: AlertLogs | undefined;
    let logsNote: string | undefined;
    if (req.logs) {
      const ev = await this.d.doctor.evidence(req.handle, req.namespace, req.problem).catch((e: { message?: string }) => ({ log: { error: String(e?.message ?? "Couldn't read the log.") } }) as DoctorEvidence);
      const log = ev.log;
      if (!log) logsNote = "This problem has no log lines to add.";
      else if ("error" in log) logsNote = log.error;
      else logs = { container: log.container, pod: log.pod, lines: log.lines, ...(log.source ? { source: log.source } : {}) };
    }
    const alert = alertFor(p, cluster, { severity: req.severity, ...(logs ? { logs } : {}) });
    const sheet = this.keep(req.sheet, { kind: "alert", owner, at: this.now, handle: req.handle, cluster, problem: p, alert });
    return {
      sheet, to: `${lf.origin}/api/webhook/${lf.triage.path}`, header: lf.triage.header, alert,
      ...(req.logs ? { logs: { lines: logs ? Math.min(logs.lines.length, 40) : 0, ...(logsNote ? { note: logsNote } : {}) } } : {}),
    };
  }

  /** Send the sheet's alert, exactly as it was shown, to Landflow's triage webhook (D120, D122). */
  async sendAlert(req: { sheet: string }, owner: Owner): Promise<LandflowRun> {
    const s = this.sheet(req.sheet, "alert", owner);
    const lf = this.landflow();
    if (!lf.triage) throw fail(409, LANDFLOW_NOTES.noTriage);
    let a;
    try {
      a = await sendAlert({ origin: lf.origin, ...lf.triage, body: JSON.stringify(s.alert), idempotencyKey: `landlens-${req.sheet}`, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    } catch (err) {
      throw this.failure(err);
    }
    if (a.held) return { note: LANDFLOW_NOTES.held, tone: "info", follow: false };
    const run = s.sent ?? id("lr");
    s.sent = run;
    const entry: SentEntry = {
      run, alert: s.alert.id, cluster: s.cluster, problem: s.problem.id, title: s.alert.title, severity: s.alert.severity, at: new Date(this.now).toISOString(), origin: lf.origin,
      ...(a.executionId ? { executionId: a.executionId } : {}), ...(a.workflowId ? { workflowId: a.workflowId } : {}),
      ...(a.trigger ? { outcome: a.trigger.outcome, ...(a.trigger.room ? { room: a.trigger.room } : {}) } : {}),
    };
    this.d.sent.add(entry);
    if (a.trigger) return this.triageView(entry, { status: "success", trigger: a.trigger }, lf.can.runs);
    if (!a.executionId || !lf.can.runs) return { run, note: LANDFLOW_NOTES.sent, tone: "ok", follow: false, runLink: runLink(lf.origin, a.workflowId, a.executionId) };
    return { run, note: LANDFLOW_NOTES.following, tone: "info", follow: true, status: "running", runLink: runLink(lf.origin, a.workflowId, a.executionId) };
  }

  /** A triage run as the window sees it: D122's sentences, the room only for an outcome that has one. */
  private triageView(e: SentEntry, v: Pick<ExecutionView, "status" | "trigger">, canFollow: boolean): LandflowRun {
    const base = { run: e.run, runLink: runLink(e.origin, e.workflowId, e.executionId), status: v.status };
    const t: TriggerResult | undefined = v.trigger;
    if (t) {
      const room = t.room && (t.outcome === "opened" || t.outcome === "attached") ? { room: t.room } : {};
      if (t.outcome === "opened") return { ...base, note: LANDFLOW_NOTES.opened, tone: "bad", follow: false, outcome: t.outcome, ...room };
      if (t.outcome === "attached") return { ...base, note: LANDFLOW_NOTES.attached, tone: "warn", follow: false, outcome: t.outcome, ...room };
      return { ...base, note: LANDFLOW_NOTES.recorded, tone: "ok", follow: false, outcome: t.outcome };
    }
    if (v.status === "waiting") return { ...base, note: LANDFLOW_NOTES.waiting, tone: "warn", follow: canFollow };
    if (v.status === "error" || v.status === "canceled") return { ...base, note: LANDFLOW_NOTES.failed, tone: "bad", follow: false };
    if (v.status === "success") return { ...base, note: LANDFLOW_NOTES.triageDone, tone: "ok", follow: false };
    return { ...base, note: LANDFLOW_NOTES.following, tone: "info", follow: canFollow };
  }

  // ---- A flow on a resource (D125) ----------------------------------------------------------------------------------

  /** The flows tagged `landlens`. */
  async flows(): Promise<{ flows: LandflowFlow[] }> {
    const lf = this.landflow();
    if (!lf.can.flows) throw fail(403, LANDFLOW_NOTES.cantList);
    try {
      return { flows: await listFlows(lf.origin, lf.key, this.d.fetch ?? fetch) };
    } catch (err) {
      throw this.failure(err);
    }
  }

  /**
   * A flow's input for an object of this cluster (D125): names from the cluster's own answer, the problem it was
   * started from (by id, in the scope's current report), and the object's YAML only when asked, as Ask Claude would
   * attach it (redactObject: no env[].value, no last-applied), never a Secret's.
   */
  async prepareInput(req: { handle: string; ref: ResourceRef; namespace?: string; problem?: string; yaml: boolean; sheet?: string }, owner: Owner): Promise<FlowPreview> {
    const lf = this.landflow();
    if (!lf.can.run) throw fail(403, LANDFLOW_NOTES.cantRun);
    const cluster = this.d.clusters.context(req.handle);
    const type = await this.d.clusters.typeOf(req.handle, req.ref);
    const p = req.problem ? this.d.doctor.problem(req.handle, req.namespace, req.problem) : undefined;
    let yaml: string | undefined;
    let note: string | undefined;
    if (req.yaml) {
      if (type.group === "" && type.resource === "secrets") note = "A Secret's YAML is never sent.";
      else {
        const o = await this.d.clusters.getObject(req.handle, req.ref);
        yaml = stringify(redactObject(o), { lineWidth: 0 });
        if (yaml.length > LANDFLOW.yaml) note = "The YAML is cut at 32 KiB.";
      }
    }
    const input = flowInput({
      cluster, ...(req.ref.namespace ? { namespace: req.ref.namespace } : {}), kind: type.kind,
      apiVersion: type.group ? `${type.group}/${type.version}` : type.version, name: req.ref.name,
      ...(p ? { problem: p } : {}), ...(yaml !== undefined ? { yaml } : {}),
    });
    const sheet = this.keep(req.sheet, { kind: "flow", owner, at: this.now, handle: req.handle, input });
    return { sheet, to: `${lf.origin}/api/workflows/<flow>/execute`, input, ...(note ? { yaml: { note } } : {}) };
  }

  /** Run a flow tagged `landlens` with the sheet's input, as a manual run of the saved workflow (D125). */
  async run(req: { sheet: string; flow: string }, owner: Owner): Promise<LandflowRun> {
    const s = this.sheet(req.sheet, "flow", owner);
    const lf = this.landflow();
    if (!lf.can.run) throw fail(403, LANDFLOW_NOTES.cantRun);
    // Only a flow Landflow lists with the tag, now.
    const listed = await this.flows();
    if (!listed.flows.some((f) => f.id === req.flow)) throw fail(404, LANDFLOW_NOTES.noFlow);
    s.sent ??= new Map();
    const run = s.sent.get(req.flow) ?? id("lr");
    let r;
    try {
      r = await executeFlow({ origin: lf.origin, key: lf.key, flow: req.flow, input: s.input, idempotencyKey: `landlens-${req.sheet}-${req.flow}`, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    } catch (err) {
      throw this.failure(err);
    }
    s.sent.set(req.flow, run);
    this.runs.set(run, { origin: lf.origin, executionId: r.executionId, workflowId: r.workflowId, at: this.now });
    while (this.runs.size > LANDFLOW.runs) this.runs.delete(this.runs.keys().next().value!);
    const link = runLink(lf.origin, r.workflowId, r.executionId);
    return lf.can.runs
      ? { run, note: LANDFLOW_NOTES.started, tone: "info", follow: true, status: "running", runLink: link }
      : { run, note: LANDFLOW_NOTES.startedOnly, tone: "ok", follow: false, runLink: link };
  }

  /** A flow's run as the window sees it: its status and the last node's output, scrubbed and cut, as text. */
  private flowView(run: string, rec: FlowRunRecord, v: ExecutionView): LandflowRun {
    const base = { run, runLink: runLink(rec.origin, v.workflowId ?? rec.workflowId, rec.executionId), status: v.status };
    if (v.status === "success") {
      const out = v.output === undefined ? undefined : redactText(JSON.stringify(v.output, null, 2) ?? "");
      return { ...base, note: LANDFLOW_NOTES.finished, tone: "ok", follow: false, ...(out ? { output: out.length > LANDFLOW.output ? `${out.slice(0, LANDFLOW.output)}\n… (cut)` : out } : {}) };
    }
    if (v.status === "error" || v.status === "canceled") return { ...base, note: LANDFLOW_NOTES.failed, tone: "bad", follow: false };
    if (v.status === "waiting") return { ...base, note: LANDFLOW_NOTES.flowWaiting, tone: "warn", follow: true };
    return { ...base, note: LANDFLOW_NOTES.running, tone: "info", follow: true };
  }

  // ---- Following, the chips, the links ------------------------------------------------------------------------------

  /**
   * Read a send's or a run's state once (D122): GET /api/executions/:id with the key, if it can read runs. Every ask
   * within 1.5 s gets the same read.
   */
  async follow(req: { run: string }): Promise<LandflowRun> {
    const flow = this.runs.get(req.run);
    const entry = flow ? undefined : this.d.sent.get(req.run);
    if (!flow && !entry) throw fail(404, "Landlens has no such send or run.");
    const cache = flow ? flow.reading : this.triageReads.get(req.run);
    if (cache && this.now - cache.at < LANDFLOW.followMs) return cache.p;
    const p = this.read(req.run, flow, entry);
    const reading = { at: this.now, p };
    if (flow) flow.reading = reading;
    else this.triageReads.set(req.run, reading);
    if (this.triageReads.size > LANDFLOW.runs) this.triageReads.delete(this.triageReads.keys().next().value!);
    return p;
  }

  private async read(run: string, flow: FlowRunRecord | undefined, entry: SentEntry | undefined): Promise<LandflowRun> {
    const lf = this.landflow();
    const origin = flow?.origin ?? entry!.origin;
    const executionId = flow?.executionId ?? entry?.executionId;
    const link = runLink(origin, flow?.workflowId ?? entry?.workflowId, executionId);
    // A run on another Landflow than the one connected now, or one Landflow gave no id for: only its link.
    if (origin !== lf.origin || !executionId) return entry ? this.triageView(entry, { status: entry.status ?? "running", ...(entry.outcome ? { trigger: { outcome: entry.outcome, ...(entry.room ? { room: entry.room } : {}) } } : {}) }, false) : { run, note: LANDFLOW_NOTES.startedOnly, tone: "ok", follow: false, runLink: link };
    if (!lf.can.runs) return { run, note: LANDFLOW_NOTES.noRuns, tone: "warn", follow: false, runLink: link };
    let v: ExecutionView;
    try {
      v = await getExecution(lf.origin, lf.key, executionId, this.d.fetch ?? fetch);
    } catch (err) {
      const e = this.failure(err);
      if (e.status === 403 || e.status === 404) return { run, note: e.message, tone: "warn", follow: false, runLink: link };
      throw e;
    }
    if (flow) return (flow.last = this.flowView(run, flow, v));
    this.d.sent.update(run, { status: v.status, ...(v.workflowId ? { workflowId: v.workflowId } : {}), ...(v.trigger ? { outcome: v.trigger.outcome, ...(v.trigger.room ? { room: v.trigger.room } : {}) } : {}) });
    return this.triageView(this.d.sent.get(run) ?? entry!, v, true);
  }

  /** The problems sent to triage from this cluster, for their chips (D124): the newest send per problem. */
  sentFor(req: { handle: string }): { entries: LandflowSent[] } {
    const cluster = this.d.clusters.context(req.handle);
    const seen = new Set<string>();
    const entries: LandflowSent[] = [];
    for (const e of this.d.sent.forCluster(cluster)) {
      if (seen.has(e.problem)) continue;
      seen.add(e.problem);
      const room = e.room && (e.outcome === "opened" || e.outcome === "attached") ? e.room : undefined;
      entries.push({ run: e.run, problem: e.problem, title: e.title, severity: e.severity, at: e.at, state: room ? "room" : "triage", ...(room ? { room } : {}) });
    }
    return { entries };
  }

  /**
   * Open a run in Landflow, or the room its triage opened (D122, security row 10): an address main holds for that send
   * or run, http(s) only, after the native dialog that shows its host. The window never supplies an address.
   */
  async open(req: { run: string; what: "run" | "room" }, ask: { confirm(q: { message: string; detail: string; yes: string }): Promise<boolean>; openExternal(url: string): Promise<void> }): Promise<{ opened: boolean }> {
    const flow = this.runs.get(req.run);
    const entry = flow ? undefined : this.d.sent.get(req.run);
    if (!flow && !entry) throw fail(404, "Landlens has no such send or run.");
    let url: string | undefined;
    if (req.what === "room") url = entry?.outcome === "opened" || entry?.outcome === "attached" ? entry.room : undefined;
    else url = runLink(flow?.origin ?? entry!.origin, flow?.workflowId ?? entry?.workflowId, flow?.executionId ?? entry?.executionId);
    if (!url) throw fail(404, "No room was opened for this send.");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw fail(400, "not an address Landlens opens");
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw fail(400, "not an address Landlens opens");
    const what = req.what === "room" ? "The war room Landflow's triage opened" : "The run in Landflow";
    const yes = await ask.confirm({ message: `Open ${u.host} in your browser?`, detail: `${what}, at:\n${u.href.slice(0, 500)}`, yes: "Open" });
    if (yes) await ask.openExternal(u.href);
    return { opened: yes };
  }
}
