// Landflow on a resource, the client (wave 7 part 4, D120–D125): the requests main makes to Landflow, against the fake
// built from Landflow's own routes, and what is kept of each answer. findTriggerResult reads runs shaped as Landflow's
// GET /api/executions/:id answers them (ExecutionRecord: runData by node, outputs of items' json).
import { FAMILY_NOTES, LANDFLOW_NOTES } from "@landlens/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FamilyError } from "../src/family.js";
import { executeFlow, findTriggerResult, getExecution, lastOutput, listFlows, readExecution, runLink, sendAlert, webLink } from "../src/landflow.js";
import { FakeLandfall, FakeLandflow, LF_KEY, LF_KEY_NARROW, nodeRun, OWNED, SHARED, TRIAGE_SECRET } from "./fake-family.js";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.map((s) => s()));
  stops = [];
});
const up = async <T extends { start(): Promise<T>; stop(): Promise<void> }>(f: T): Promise<T> => {
  await f.start();
  stops.push(() => f.stop());
  return f;
};
async function answering(status: number, body: string | Buffer = "{}", headers: Record<string, string> = {}): Promise<string> {
  const s = createServer((_q, r) => {
    r.writeHead(status, { "Content-Type": "application/json", ...headers });
    r.end(body);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  stops.push(() => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r()))));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const caught = async (p: Promise<unknown>): Promise<FamilyError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FamilyError);
    return err as FamilyError;
  }
  throw new Error("expected a failure");
};
const ALERT = JSON.stringify({ source: "landlens", title: "ledger-worker is crash-looping", severity: "sev2", service: "ledger-worker", environment: "orbstack", status: "firing", id: "landlens:x", fingerprint: "landlens:x", description: "d", labels: {}, entity: {} });
const hook = (lf: FakeLandflow, over: Partial<Parameters<typeof sendAlert>[0]> = {}) =>
  sendAlert({ origin: lf.origin, path: "alerts", header: "x-webhook-secret", secret: TRIAGE_SECRET, body: ALERT, idempotencyKey: "landlens-ls1", ...over });

/** A triage run as Landflow records it: Triage decision's own `outcome` comes first, then Landfall's TriggerResult. */
const triageRun = (result: unknown, extra: Record<string, unknown> = {}) => ({
  executionId: "ex1", workflowId: "wf_triage", status: "success", lastNodeId: "saveRoom",
  executionOrder: ["hook", "decide", "open", "saveRoom"],
  runData: {
    hook: [nodeRun([{ body: { title: "t" } }])],
    decide: [nodeRun([{ outcome: "open", enforceOutcome: "open" }])],
    open: [nodeRun([result])],
    saveRoom: [nodeRun([{ id: 1 }])],
  },
  ...extra,
});

describe("Landfall's answer in a run (findTriggerResult, D122)", () => {
  it("takes the first TriggerResult in the nodes' outputs, past Triage decision's own outcome", () => {
    expect(findTriggerResult(triageRun({ outcome: "opened", incidentId: "inc_1", workspaceUrl: "https://landfall.example/o/acme/i/7", tenantId: "t", opened: true }))).toEqual({
      outcome: "opened", incidentId: "inc_1", room: "https://landfall.example/o/acme/i/7",
    });
    expect(findTriggerResult(triageRun({ outcome: "attached", incidentId: "inc_1" }))).toEqual({ outcome: "attached", incidentId: "inc_1" });
    expect(findTriggerResult(triageRun({ result: { nested: { outcome: "suppressed" } } }))).toEqual({ outcome: "suppressed" });
  });

  it("keeps a room address only if it is http(s) with no user info, an incident id only if one short line", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@landfall.example/i/1", "not a url", 7]) {
      expect(findTriggerResult(triageRun({ outcome: "opened", workspaceUrl: bad }))).toEqual({ outcome: "opened" });
    }
    expect(findTriggerResult(triageRun({ outcome: "opened", incidentId: "x".repeat(101) }))).toEqual({ outcome: "opened" });
    expect(findTriggerResult(triageRun({ outcome: "opened", incidentId: "a\nb" }))).toEqual({ outcome: "opened" });
    expect(webLink("https://landfall.example/i/1")).toBe("https://landfall.example/i/1");
  });

  it("reads only the nodes' outputs: not the workflow, the inputs, an unknown outcome, or deeper than 8", () => {
    const workflowOnly = { ...triageRun({ id: 1 }), workflow: { nodes: [{ outcome: "opened", workspaceUrl: "https://evil.example" }] } };
    expect(findTriggerResult(workflowOnly)).toBeUndefined();
    const inInputs = triageRun({ id: 1 });
    (inInputs.runData.open[0] as { inputs: unknown[] }).inputs = [[{ json: { outcome: "opened" } }]];
    expect(findTriggerResult(inInputs)).toBeUndefined();
    expect(findTriggerResult(triageRun({ outcome: "open" }))).toBeUndefined();
    let deep: unknown = { outcome: "opened" };
    for (let i = 0; i < 9; i++) deep = { x: deep };
    expect(findTriggerResult(triageRun(deep))).toBeUndefined();
    let seven: unknown = { outcome: "opened" };
    for (let i = 0; i < 6; i++) seven = { x: seven };
    expect(findTriggerResult(triageRun(seven))).toEqual({ outcome: "opened" });
    expect(findTriggerResult({ status: "running" })).toBeUndefined();
  });

  it("reads a run's status, its workflow and the last node's output, and refuses a status Landflow doesn't have", () => {
    const v = readExecution({ execution: triageRun({ outcome: "recorded" }), traceUrl: "https://x" });
    expect(v).toEqual({ status: "success", workflowId: "wf_triage", trigger: { outcome: "recorded" }, output: { id: 1 } });
    expect(lastOutput({ lastNodeId: "a", runData: { a: [nodeRun([{ x: 1 }, { x: 2 }])] } })).toEqual([{ x: 1 }, { x: 2 }]);
    expect(lastOutput({ lastNodeId: "__proto__", runData: {} })).toBeUndefined();
    expect(() => readExecution({ execution: { status: "exploded" } })).toThrow(FAMILY_NOTES.landflowAnswer);
    expect(() => readExecution({ status: "success" })).toThrow(FAMILY_NOTES.landflowAnswer);
    expect(runLink("http://lf", "wf_1", "ex 1")).toBe("http://lf/workflows/wf_1/executions/ex%201");
    expect(runLink("http://lf")).toBe("http://lf/executions");
  });
});

describe("sending an alert to the triage webhook (D120, D122)", () => {
  it("posts the body as given, the secret only in its header, no key, and an Idempotency-Key", async () => {
    const lf = await up(new FakeLandflow());
    const a = await hook(lf);
    expect(a).toMatchObject({ workflowId: "wf_triage", executionId: expect.stringMatching(/^ex/) });
    const got = lf.requests.at(-1)!;
    expect(got).toMatchObject({ method: "POST", path: "/api/webhook/alerts", body: ALERT });
    expect(got.headers["x-webhook-secret"]).toBe(TRIAGE_SECRET);
    expect(got.headers["idempotency-key"]).toBe("landlens-ls1");
    expect(got.authorization).toBeUndefined();
    expect(lf.carrying(TRIAGE_SECRET)).toHaveLength(1);
    expect(lf.carrying(LF_KEY)).toHaveLength(0);
  });

  it("answers a repeated Idempotency-Key with the first run, and says when Landflow holds alerts", async () => {
    const lf = await up(new FakeLandflow());
    const first = await hook(lf);
    const again = await hook(lf);
    expect(again).toMatchObject({ executionId: (first as { executionId: string }).executionId });
    expect(lf.alerts).toHaveLength(1);
    lf.respond = "debounced";
    expect(await hook(lf, { idempotencyKey: "landlens-ls2" })).toEqual({ held: true });
  });

  it("says each refusal in its own sentence (D122's table)", async () => {
    const lf = await up(new FakeLandflow());
    expect((await caught(hook(lf, { secret: "wrong-secret-value" }))).message).toBe(LANDFLOW_NOTES.secretRefused);
    expect((await caught(hook(lf, { path: "elsewhere" }))).message).toBe(LANDFLOW_NOTES.noWebhook);
    const e = await caught(hook(lf, { origin: await answering(500, JSON.stringify({ error: `boom ${TRIAGE_SECRET}` })) }));
    expect(e.message).toBe("Landflow answered HTTP 500.");
    expect(e.message).not.toContain(TRIAGE_SECRET);
  });

  it("takes a run's id from x-landflow-execution and Landfall's answer from a last-node reply", async () => {
    const at = await answering(200, JSON.stringify({ outcome: "attached", incidentId: "inc_9", workspaceUrl: "http://127.0.0.1:3001/o/x/i/9", opened: false }), { "x-landflow-execution": "ex_from_header" });
    expect(await hook({ origin: at } as FakeLandflow)).toEqual({ executionId: "ex_from_header", trigger: { outcome: "attached", incidentId: "inc_9", room: "http://127.0.0.1:3001/o/x/i/9" } });
  });

  it("prefers Landflow's header to an executionId in the flow's own data (review of part 4, L2)", async () => {
    // A flow that answers with its last node's output: that data names another run.
    const data = await answering(200, JSON.stringify({ executionId: "ex_from_data", workflowId: "wf_from_data", note: "done" }), { "x-landflow-execution": "ex_from_header" });
    expect(await hook({ origin: data } as FakeLandflow)).toEqual({ executionId: "ex_from_header" });
    // Data with no header: no run id at all.
    const bare = await answering(200, JSON.stringify({ executionId: "ex_from_data", workflowId: "wf_from_data" }));
    expect(await hook({ origin: bare } as FakeLandflow)).toEqual({});
    // Landflow's own answer (immediately): its body is Landflow's.
    const own = await answering(202, JSON.stringify({ status: "started", executionId: "ex_own", workflowId: "wf_triage" }));
    expect(await hook({ origin: own } as FakeLandflow)).toEqual({ executionId: "ex_own", workflowId: "wf_triage" });
  });

  it("follows no redirect: the secret never reaches another address", async () => {
    const elsewhere = await up(new FakeLandflow());
    const s = createServer((_q, r) => (r.writeHead(307, { Location: `${elsewhere.origin}/api/webhook/alerts` }), r.end()));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    stops.push(() => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r()))));
    const e = await caught(hook({ origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}` } as FakeLandflow));
    expect(e.message).toBe(FAMILY_NOTES.landflowAnswer);
    expect(elsewhere.requests).toEqual([]);
  });

  it("calls only Landflow: a triage that opens a room on a Landfall leaves that Landfall untouched (D123)", async () => {
    const lf = await up(new FakeLandflow());
    const lfa = await up(new FakeLandfall());
    lf.triage = { outcome: "opened", incidentId: "inc_2", workspaceUrl: `${lfa.origin}/o/acme/i/2` };
    const a = (await hook(lf)) as { executionId: string };
    await getExecution(lf.origin, LF_KEY, a.executionId);
    const v = await getExecution(lf.origin, LF_KEY, a.executionId);
    expect(v.trigger).toEqual({ outcome: "opened", incidentId: "inc_2", room: `${lfa.origin}/o/acme/i/2` });
    expect(lfa.requests).toEqual([]);
    expect(lfa.forbidden).toEqual([]);
  });
});

describe("flows and runs (D125)", () => {
  it("says whose each flow is, and lists an id Landlens doesn't run as such (review of part 4, M2, L9)", async () => {
    const lf = await up(new FakeLandflow());
    lf.workflows.push({ id: "wf_ops", name: "Ops check", tags: ["landlens"], updatedAt: "2026-11-15T10:00:00.000Z", ownership: SHARED });
    lf.workflows.push({ id: "wf_nobody", name: "No ownership", tags: ["landlens"], updatedAt: "2026-11-15T10:00:00.000Z", ownership: undefined });
    lf.workflows.push({ id: "w".repeat(101), name: "Long id", tags: ["landlens"], updatedAt: "", ownership: OWNED });
    lf.workflows.push({ id: "wf.dotted", name: "Dotted id", tags: ["landlens"], updatedAt: "", ownership: OWNED });
    const flows = await listFlows(lf.origin, LF_KEY);
    expect(flows.find((f) => f.id === "wf_ops")).toMatchObject({ owner: "Ops", shared: true, runnable: true });
    expect(flows.find((f) => f.id === "wf_landlens_check")).toMatchObject({ owner: "Fable Person", shared: false });
    // Not said to be the key user's: shown as shared.
    expect(flows.find((f) => f.id === "wf_nobody")).toMatchObject({ shared: true });
    expect(flows.find((f) => f.name === "Long id")).toMatchObject({ runnable: true });
    expect(flows.find((f) => f.name === "Dotted id")).toMatchObject({ runnable: false });
  });

  it("keeps a room address only while it fits family-sent.json once encoded (review of part 4, L1)", () => {
    expect(webLink(`https://landfall.example/o/${"é".repeat(1_500)}`)).toBeUndefined();
    expect(webLink(`https://landfall.example/o/${"e".repeat(1_500)}`)).toBe(`https://landfall.example/o/${"e".repeat(1_500)}`);
  });

  it("lists only the flows tagged landlens, names and descriptions as one line", async () => {
    const lf = await up(new FakeLandflow());
    lf.workflows.push({ ...lf.workflows[0]!, id: "wf_tagged_2", name: "Two\nlines‮", description: "d".repeat(400) });
    lf.workflows.push({ ...lf.workflows[0]!, id: "../escape", name: "bad id" });
    const flows = await listFlows(lf.origin, LF_KEY);
    expect(flows.map((f) => f.id)).toEqual(["wf_landlens_check", "wf_tagged_2", "../escape"]);
    expect(flows[1]).toEqual({ id: "wf_tagged_2", name: "Two lines", description: "d".repeat(300), owner: "Fable Person", shared: false, runnable: true, updatedAt: "2026-11-15T10:00:00.000Z" });
    // An id Landlens doesn't run is listed as such, never run (review of part 4, L9).
    expect(flows[2]).toMatchObject({ name: "bad id", runnable: false });
    expect((await caught(listFlows(lf.origin, LF_KEY_NARROW))).message).toBe(LANDFLOW_NOTES.cantList);
    expect((await caught(listFlows(lf.origin, `lf_${"Z".repeat(43)}`))).message).toBe(FAMILY_NOTES.landflowRefused);
  });

  it("starts a manual run with the input and key, once per Idempotency-Key, and reads it", async () => {
    const lf = await up(new FakeLandflow());
    const input = { landlens: 1, name: "ledger-worker" };
    const r = await executeFlow({ origin: lf.origin, key: LF_KEY, flow: "wf_landlens_check", input, idempotencyKey: "landlens-ls9-wf" });
    expect(r).toEqual({ executionId: expect.stringMatching(/^ex/), workflowId: "wf_landlens_check" });
    expect(lf.inputs.get(r.executionId)).toEqual(input);
    const again = await executeFlow({ origin: lf.origin, key: LF_KEY, flow: "wf_landlens_check", input, idempotencyKey: "landlens-ls9-wf" });
    expect(again.executionId).toBe(r.executionId);
    expect((await getExecution(lf.origin, LF_KEY, r.executionId)).status).toBe("running");
    expect(await getExecution(lf.origin, LF_KEY, r.executionId)).toMatchObject({ status: "success", output: { checked: true, note: "pods look fine" } });
    expect((await caught(executeFlow({ origin: lf.origin, key: LF_KEY, flow: "wf_missing", input, idempotencyKey: "k" }))).message).toBe(LANDFLOW_NOTES.noFlow);
    expect((await caught(executeFlow({ origin: lf.origin, key: LF_KEY_NARROW, flow: "wf_landlens_check", input, idempotencyKey: "k" }))).message).toBe(LANDFLOW_NOTES.cantRun);
  });

  it("says a key can't read runs, a run that is gone, and refuses an answer over 4 MB", async () => {
    const lf = await up(new FakeLandflow());
    expect((await caught(getExecution(lf.origin, LF_KEY_NARROW, "ex1"))).message).toBe(LANDFLOW_NOTES.noRuns);
    expect((await caught(getExecution(lf.origin, LF_KEY, "ex_gone"))).message).toBe(LANDFLOW_NOTES.gone);
    expect((await caught(getExecution(lf.origin, LF_KEY, "../x"))).message).toBe(FAMILY_NOTES.landflowAnswer);
    const big = await answering(200, Buffer.alloc(5 * 1024 * 1024, 0x20));
    expect((await caught(getExecution(big, LF_KEY, "ex1"))).message).toBe(FAMILY_NOTES.landflowAnswer);
  });
});
