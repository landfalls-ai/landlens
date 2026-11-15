// Landflow on a resource (docs/family.md#landflow-on-a-resource, wave 7 part 4, D120–D125): the requests main makes to
// the Landflow the person connected, and what it keeps of each answer. Used from Electron main only.
//
// Shapes, as Landflow's code has them (origin/main, read 15 November 2026):
// - POST /api/webhook/<path> (apps/web/src/app/api/webhook/[...path]/route.ts): the trigger's Header Auth is checked
//   first (401/403, nothing starts); no published flow on that path is 404. The triage template answers "immediately":
//   202 `{ status: "started" | "queued", workflowId, executionId }`; debounce or batching 202 `{ status: "debounced" |
//   "batched", workflowId, … }`; a repeated Idempotency-Key 200 with the first run's `{ status, workflowId,
//   executionId }`; a flow that answers "when the last node finishes" sends that node's output with the run's id in
//   `x-landflow-execution`.
// - POST /api/workflows/:id/execute `{ input, idempotencyKey }` (scope `run`): 202 `{ executionId, workflowId, status:
//   "running" }`, a repeated key 200 `{ …, duplicate: true }`, 404 for no such workflow.
// - GET /api/workflows (scope `workflows:read`): `{ workflows: [{ id, name, description?, tags: string[], … }] }`.
// - GET /api/executions/:id (scope `executions:read`): `{ execution: { executionId, workflowId, status, runData:
//   { <nodeId>: [{ outputs: [[{ json }]] , … }] }, executionOrder, lastNodeId, … }, traceUrl?, progress? }`.
// - Landfall's Open From Alert node outputs its TriggerResult plus `opened` (plugins/landfall/README.md): `{ outcome:
//   opened | attached | recorded | ignored | suppressed, incidentId, workspaceUrl, … }`.
//
// Every request goes through pinnedFetch to Landflow's stored origin (no redirects, a time limit); the key only in the
// Authorization header, the webhook's secret only in its own header. Answers are read up to a size limit and reduced
// to a few checked fields; a failure is one of the fixed sentences, its raw error kept for main's log.
import { FAMILY_NOTES, familyHttpNote, LANDFLOW_NOTES, type LandflowFlow, type LandflowOutcome, type LandflowRunStatus } from "@landlens/contracts";
import { FamilyError } from "./family.js";
import { failureKind, oneLine, OriginRefused, pinnedFetch, readCapped, TooLarge } from "./providers.js";

export const LANDFLOW_TIMEOUT = 15_000;
/** A run's answer can carry every node's output: read up to 4 MB (D122). */
export const MAX_EXECUTION = 4 * 1024 * 1024;
const MAX_ANSWER = 1024 * 1024;
/** Ids Landflow makes (`wf_…`, nanoid execution ids): letters, digits, `_` and `-`. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OUTCOMES: ReadonlySet<string> = new Set<LandflowOutcome>(["opened", "attached", "recorded", "ignored", "suppressed"]);
const STATUSES: ReadonlySet<string> = new Set<LandflowRunStatus>(["running", "queued", "waiting", "success", "error", "canceled"]);
/** The tag that marks a flow Landlens may run (D125). */
export const LANDLENS_TAG = "landlens";

/** A request that didn't get an answer, as its sentence. */
function notSent(err: unknown): FamilyError {
  const e = err as { name?: string; cause?: { name?: string } };
  if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") return new FamilyError(504, FAMILY_NOTES.landflowSlow, err);
  if (err instanceof OriginRefused) return new FamilyError(400, FAMILY_NOTES.landflowAnswer, err);
  return failureKind(err) === "answer" ? new FamilyError(502, FAMILY_NOTES.landflowAnswer, err) : new FamilyError(502, FAMILY_NOTES.unreachable, err);
}

async function send(origin: string, path: string, init: RequestInit, base: typeof fetch): Promise<Response> {
  try {
    return await pinnedFetch([origin], base, LANDFLOW_TIMEOUT)(`${origin}${path}`, init);
  } catch (err) {
    throw notSent(err);
  }
}

async function body(r: Response, max: number): Promise<unknown> {
  let text: string;
  try {
    text = await readCapped(r, max);
  } catch (err) {
    throw err instanceof TooLarge ? new FamilyError(502, FAMILY_NOTES.landflowAnswer, err) : notSent(err);
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const idOf = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Landfall's answer as Landlens keeps it: the outcome, and the room's address and incident id when they check out. */
export type TriggerResult = { outcome: LandflowOutcome; room?: string; incidentId?: string };

/** An http(s) address with no user info, as text, or undefined. */
export function webLink(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 2_000) return undefined;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first object, depth first and at most 8 levels into `value`, whose `outcome` is one of Landfall's: that, with a
 * `workspaceUrl` that parses as http(s) and an `incidentId` of at most 100 characters on one line, each only if it
 * checks out. At most 20,000 values are looked at.
 */
function triggerIn(value: unknown, budget: { left: number }, depth = 0): TriggerResult | undefined {
  if (depth > 8 || budget.left-- <= 0 || !value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(value) && typeof v.outcome === "string" && OUTCOMES.has(v.outcome)) {
    const room = webLink(v.workspaceUrl);
    const incident = typeof v.incidentId === "string" && /^[^\p{Cc}\p{Zl}\p{Zp}]{1,100}$/u.test(v.incidentId) ? v.incidentId : undefined;
    return { outcome: v.outcome as LandflowOutcome, ...(room ? { room } : {}), ...(incident ? { incidentId: incident } : {}) };
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const got = triggerIn(v, budget, depth + 1);
    if (got) return got;
  }
  return undefined;
}

/** The nodes of a run in the order they finished, then any others its runData has. */
function nodeOrder(execution: Record<string, unknown>): string[] {
  const runData = isObj(execution.runData) ? execution.runData : {};
  const order = Array.isArray(execution.executionOrder) ? execution.executionOrder.filter((x): x is string => typeof x === "string") : [];
  return [...new Set([...order, ...Object.keys(runData)])].filter((k) => Object.hasOwn(runData, k));
}

/** Every item's `json` a node's runs output, in order. */
function itemsOf(runs: unknown): unknown[] {
  const out: unknown[] = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!isObj(run) || !Array.isArray(run.outputs)) continue;
    for (const branch of run.outputs) for (const item of Array.isArray(branch) ? branch : []) if (isObj(item)) out.push(item.json);
  }
  return out;
}

/**
 * Landfall's TriggerResult in a run (D122): the first object anywhere in the run's node outputs (each item's `json`,
 * nodes in the order they finished) whose `outcome` is Landfall's. Nothing else of the run is read.
 */
export function findTriggerResult(execution: unknown): TriggerResult | undefined {
  if (!isObj(execution) || !isObj(execution.runData)) return undefined;
  const budget = { left: 20_000 };
  for (const node of nodeOrder(execution)) {
    for (const json of itemsOf(execution.runData[node])) {
      const got = triggerIn(json, budget, 1);
      if (got) return got;
    }
  }
  return undefined;
}

/** The last main-flow node's output, as the webhook's "when the last node finishes" answer has it: one item's json, or a list. */
export function lastOutput(execution: unknown): unknown {
  if (!isObj(execution) || !isObj(execution.runData) || typeof execution.lastNodeId !== "string" || !Object.hasOwn(execution.runData, execution.lastNodeId)) return undefined;
  const runs = execution.runData[execution.lastNodeId];
  const last = Array.isArray(runs) ? runs.at(-1) : undefined;
  const items = isObj(last) && Array.isArray(last.outputs) && Array.isArray(last.outputs[0]) ? (last.outputs[0] as unknown[]) : [];
  const jsons = items.filter(isObj).map((i) => i.json);
  return jsons.length === 1 ? jsons[0] : jsons.length ? jsons : undefined;
}

/** Where a run is in Landflow's own pages: the run in its workflow when the workflow is known, else the runs list. */
export function runLink(origin: string, workflowId?: string, executionId?: string): string {
  return workflowId && executionId ? `${origin}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}` : `${origin}/executions`;
}

export type AlertAnswer = { held: true } | { held?: false; executionId?: string; workflowId?: string; trigger?: TriggerResult };

/**
 * POST the alert to Landflow's triage webhook (D120): the webhook's secret in its own header, the Idempotency-Key, the
 * body as main built it. The answer's sentences are D122's.
 */
export async function sendAlert(o: { origin: string; path: string; header: string; secret: string; body: string; idempotencyKey: string; fetch?: typeof fetch }): Promise<AlertAnswer> {
  const r = await send(o.origin, `/api/webhook/${o.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", [o.header]: o.secret, "Idempotency-Key": o.idempotencyKey },
    body: o.body,
  }, o.fetch ?? fetch);
  if (r.status === 401 || r.status === 403) throw new FamilyError(401, LANDFLOW_NOTES.secretRefused);
  if (r.status === 404) throw new FamilyError(404, LANDFLOW_NOTES.noWebhook);
  if (!r.ok) throw new FamilyError(502, familyHttpNote("Landflow", r.status));
  const j = await body(r, MAX_ANSWER);
  if (isObj(j) && (j.status === "debounced" || j.status === "batched")) return { held: true };
  const executionId = (isObj(j) ? idOf(j.executionId) : undefined) ?? idOf(r.headers.get("x-landflow-execution"));
  const workflowId = isObj(j) ? idOf(j.workflowId) : undefined;
  // A flow that answers with its last node's output may carry Landfall's answer already.
  const trigger = triggerIn(j, { left: 20_000 }, 0);
  return { ...(executionId ? { executionId } : {}), ...(workflowId ? { workflowId } : {}), ...(trigger ? { trigger } : {}) };
}

const auth = (key: string) => ({ Authorization: `Bearer ${key}`, Accept: "application/json" });

/** The flows tagged `landlens` (D125): id, and name and description as one line of text each; at most 50. */
export async function listFlows(origin: string, key: string, base: typeof fetch = fetch): Promise<LandflowFlow[]> {
  const r = await send(origin, "/api/workflows", { headers: auth(key) }, base);
  if (r.status === 401) throw new FamilyError(401, FAMILY_NOTES.landflowRefused);
  if (r.status === 403) throw new FamilyError(403, LANDFLOW_NOTES.cantList);
  if (!r.ok) throw new FamilyError(502, familyHttpNote("Landflow", r.status));
  const j = await body(r, MAX_EXECUTION);
  if (!isObj(j) || !Array.isArray(j.workflows)) throw new FamilyError(502, FAMILY_NOTES.landflowAnswer);
  const out: LandflowFlow[] = [];
  for (const w of j.workflows) {
    if (!isObj(w) || !Array.isArray(w.tags) || !w.tags.includes(LANDLENS_TAG)) continue;
    const id = idOf(w.id);
    if (!id) continue;
    const description = oneLine(w.description, 300);
    out.push({ id, name: oneLine(w.name, 100) ?? id, ...(description ? { description } : {}) });
    if (out.length >= 50) break;
  }
  return out;
}

/** Start a saved flow as a manual run, as the key's user (D125). */
export async function executeFlow(o: { origin: string; key: string; flow: string; input: unknown; idempotencyKey: string; fetch?: typeof fetch }): Promise<{ executionId: string; workflowId: string }> {
  const r = await send(o.origin, `/api/workflows/${encodeURIComponent(o.flow)}/execute`, {
    method: "POST",
    headers: { ...auth(o.key), "Content-Type": "application/json" },
    body: JSON.stringify({ input: o.input, idempotencyKey: o.idempotencyKey }),
  }, o.fetch ?? fetch);
  if (r.status === 401) throw new FamilyError(401, FAMILY_NOTES.landflowRefused);
  if (r.status === 403) throw new FamilyError(403, LANDFLOW_NOTES.cantRun);
  if (r.status === 404) throw new FamilyError(404, LANDFLOW_NOTES.noFlow);
  if (!r.ok) throw new FamilyError(502, familyHttpNote("Landflow", r.status));
  const j = await body(r, MAX_ANSWER);
  const executionId = isObj(j) ? idOf(j.executionId) : undefined;
  if (!executionId) throw new FamilyError(502, FAMILY_NOTES.landflowAnswer);
  return { executionId, workflowId: (isObj(j) ? idOf(j.workflowId) : undefined) ?? o.flow };
}

/** What Landlens keeps of a run: its status, its workflow, Landfall's TriggerResult and the last node's output. */
export type ExecutionView = { status: LandflowRunStatus; workflowId?: string; trigger?: TriggerResult; output?: unknown };

export function readExecution(j: unknown): ExecutionView {
  const e = isObj(j) && isObj(j.execution) ? j.execution : undefined;
  if (!e || typeof e.status !== "string" || !STATUSES.has(e.status)) throw new FamilyError(502, FAMILY_NOTES.landflowAnswer);
  const workflowId = idOf(e.workflowId);
  const trigger = findTriggerResult(e);
  const output = lastOutput(e);
  return { status: e.status as LandflowRunStatus, ...(workflowId ? { workflowId } : {}), ...(trigger ? { trigger } : {}), ...(output !== undefined ? { output } : {}) };
}

/** GET a run (D122): needs `executions:read`; the answer is read up to 4 MB. */
export async function getExecution(origin: string, key: string, id: string, base: typeof fetch = fetch): Promise<ExecutionView> {
  if (!ID.test(id)) throw new FamilyError(400, FAMILY_NOTES.landflowAnswer);
  const r = await send(origin, `/api/executions/${encodeURIComponent(id)}`, { headers: auth(key) }, base);
  if (r.status === 401) throw new FamilyError(401, FAMILY_NOTES.landflowRefused);
  if (r.status === 403) throw new FamilyError(403, LANDFLOW_NOTES.noRuns);
  if (r.status === 404) throw new FamilyError(404, LANDFLOW_NOTES.gone);
  if (!r.ok) throw new FamilyError(502, familyHttpNote("Landflow", r.status));
  return readExecution(await body(r, MAX_EXECUTION));
}
