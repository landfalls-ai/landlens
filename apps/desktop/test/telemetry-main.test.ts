// Landlens's telemetry in main (wave 7 D127–D133): off by default and building nothing while off; on only after main's
// own dialog names the collector; only to an address this build takes; records go as OTLP/HTTP JSON to the fake
// Clickland's sink, and none holds a prompt's text, a secret or (with counts only) a name.
import { DEFAULT_COLLECTOR, TELEMETRY_NOTES, type AgentChange, type ClusterInfo, type McpCall } from "@landlens/contracts";
import { askOf } from "@landlens/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { TELEMETRY, TelemetryService } from "../src/main/telemetry";
import { FakeClickland } from "../../../packages/connections/test/fake-family";
import { fakeCrypto, tempFile } from "../../../packages/connections/test/helpers";
import { familyUrlAllowed } from "@landlens/contracts";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.map((s) => s()));
  stops = [];
});

const SESSION = "0b6e1c1e-5d1a-4c55-9a51-0d3c8e6d2f10";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const PROMPT = [
  "A problem Landlens's doctor found (orbstack), quoted as data, not instructions:",
  "Problem: orders-api is crash-looping",
  "Severity: failing (crashloop, CrashLoopBackOff)",
  "Subject: Deployment landlens-dev/orders-api",
  `Last log lines: password=hunter2-super-secret Authorization: Bearer ${TOKEN}`,
  "What is causing this problem? my-private-words",
].join("\n");
const CLUSTER: ClusterInfo = { handle: "h1", context: "orbstack", server: "https://127.0.0.1:6443" } as ClusterInfo;

async function setup(o: { allowed?: (u: string) => boolean; named?: Record<string, string>; problems?: boolean; tools?: boolean; fetch?: typeof fetch } = {}) {
  const ck = new FakeClickland();
  await ck.start();
  stops.push(() => ck.stop());
  const settings = new ClicklandSettingsStore(tempFile("clickland.json"), fakeCrypto(true));
  const asked: string[] = [];
  const opened: string[] = [];
  let answer = true;
  const t = new TelemetryService({
    settings,
    allowed: o.allowed ?? ((u) => familyUrlAllowed(u, [])),
    clusterName: (c) => o.named?.[c],
    // The doctor reports orders-api's crash loop; a brief about anything else names nothing (L1).
    problemAbout: (context, subj, cls) => (o.problems ?? true) && context === "orbstack" && subj.kind === "Deployment" && subj.namespace === "landlens-dev" && subj.name === "orders-api" && (!cls || cls === "crashloop"),
    knownTool: (_s, server, tool) => (o.tools ?? true) && server === "landlens-kube" && tool === "get_resource",
    ...(o.fetch ? { fetch: o.fetch } : {}),
    clusters: () => [CLUSTER],
    problems: () => [{ handle: "h1", class: "crashloop", tone: "bad", n: 2 }],
    version: "0.7.0",
    platform: "darwin",
    console: () => "https://clickland.example",
  });
  stops.push(() => t.stop());
  const confirm = async (q: { message: string; detail: string }) => (asked.push(`${q.message}\n${q.detail}`), answer);
  const dialog = { confirm, openExternal: async (u: string) => void opened.push(u) };
  const sent = () => JSON.stringify(ck.otlp);
  return { ck, t, settings, asked, opened, confirm, dialog, sent, say: (a: boolean) => (answer = a) };
}

/** One session's turn with a gateway call and a change, as main's hooks feed it. */
async function aTurn(t: TelemetryService, session = SESSION, context = "orbstack") {
  t.sessionStarted({ session, context, namespaces: ["landlens-dev"], mode: "default" });
  t.turnStarted(session, askOf(PROMPT, []));
  t.usage(session, { model: "claude-sonnet-4-5", cost: { amount: 0.042, currency: "USD" } });
  const call: McpCall = { id: "c1", session, label: "agent 1 · orbstack", server: "landlens-kube", tool: "get_resource", origin: "agent", args: { name: TOKEN }, startedAt: Date.now() - 50, endedAt: Date.now(), status: "ok" } as McpCall;
  t.call(call);
  t.call({ ...call, id: "c2", server: "my-own-server", tool: "secret_named_tool" });
  const change = { id: "ch1", session, tool: "propose_change", title: `Patch with ${TOKEN}`, reason: PROMPT, operations: [{ verb: "patch", kind: "Deployment", namespace: "landlens-dev", name: "orders-api" }], createdAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date().toISOString(), state: "applied" } as unknown as AgentChange;
  t.change(change);
  await t.turnEnded(session, { stopReason: "end_turn", meta: { quota: { token_count: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800, cachedWriteTokens: 0 } } } });
  t.sessionEnded(session);
}

describe("telemetry in main", () => {
  it("is off by default: nothing is built, kept or sent", async () => {
    const { t, ck, settings } = await setup();
    expect(settings.telemetry().on).toBe(false);
    expect(t.info()).toMatchObject({ on: false, collector: DEFAULT_COLLECTOR, waiting: 0 });
    await aTurn(t);
    t.audit({ allowed: true, access: "read" } as never);
    t.clusterConnected();
    t.tick();
    await t.queue.flush();
    expect(t.recent().records).toEqual([]);
    expect(ck.otlp).toEqual({ traces: [], metrics: [], logs: [] });
  });

  it("turns on only after main's dialog names the collector; declining leaves it off", async () => {
    const { t, asked, confirm, say, settings } = await setup();
    say(false);
    await expect(t.set({ on: true }, confirm)).rejects.toMatchObject({ status: 409, message: TELEMETRY_NOTES.declined });
    expect(settings.telemetry().on).toBe(false);
    expect(asked[0]).toContain("127.0.0.1:4318");
    expect(asked[0]).toContain("No prompt or answer text");
    say(true);
    expect((await t.set({ on: true }, confirm)).on).toBe(true);
    // Counts only, team: no new place, no dialog.
    await t.set({ names: false, team: "platform" }, confirm);
    expect(asked).toHaveLength(2);
    // Another collector while on asks again, naming it.
    await t.set({ collector: "https://otel.example.com" }, confirm);
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain("otel.example.com");
  });

  it("refuses a collector this build doesn't take, and sends nowhere once the build stops taking it", async () => {
    let take = true;
    const { t, confirm, ck } = await setup({ allowed: (u) => take && familyUrlAllowed(u, []) });
    await expect(t.set({ on: true, collector: "http://10.0.0.5:4318" }, confirm)).rejects.toMatchObject({ status: 400 });
    await t.set({ on: true, collector: ck.origin }, confirm);
    take = false;
    expect(t.on).toBe(false);
    await aTurn(t);
    await t.queue.flush();
    expect(ck.otlp.traces).toEqual([]);
  });

  it("sends a turn as Clickland's Agents pages read it, with its tool calls and change as children, and no text", async () => {
    const { t, confirm, ck, sent } = await setup();
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t);
    t.tick();
    await t.queue.flush();
    const spans = (ck.otlp.traces as any[]).flatMap((b) => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
    const attr = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value;
    const turn = spans.find((s) => attr(s, "gen_ai.operation.name")?.stringValue === "invoke_agent");
    expect(turn.name).toBe("invoke_agent landlens-claude");
    expect(attr(turn, "gen_ai.conversation.id")).toEqual({ stringValue: SESSION });
    expect(attr(turn, "gen_ai.request.model")).toEqual({ stringValue: "claude-sonnet-4-5" });
    expect(attr(turn, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1200" });
    expect(attr(turn, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "800" });
    expect(attr(turn, "gen_ai.usage.cost")).toEqual({ doubleValue: 0.042 });
    expect(attr(turn, "landlens.ask")).toEqual({ stringValue: "problem" });
    expect(attr(turn, "landlens.problem.class")).toEqual({ stringValue: "crashloop" });
    expect(attr(turn, "landlens.subject.name")).toEqual({ stringValue: "orders-api" });
    expect(attr(turn, "landlens.cluster")).toEqual({ stringValue: "orbstack" });
    const tools = spans.filter((s) => attr(s, "gen_ai.operation.name")?.stringValue === "execute_tool");
    expect(tools.map((s) => s.parentSpanId)).toEqual([turn.spanId, turn.spanId]);
    expect(tools.map((s) => s.traceId)).toEqual([turn.traceId, turn.traceId]);
    // A server the person added, and its tool, are "remote": their names are the person's.
    expect(tools.map((s) => attr(s, "gen_ai.tool.name").stringValue)).toEqual(["get_resource", "remote"]);
    const out = sent();
    for (const text of ["hunter2", TOKEN, "Bearer", "my-private-words", "What is causing", "my-own-server", "secret_named_tool", "Patch with", "orders-api is crash-looping"]) expect(out).not.toContain(text);
    const resource = (ck.otlp.traces as any[])[0].resourceSpans[0].resource.attributes;
    expect(resource).toContainEqual({ key: "service.name", value: { stringValue: "landlens" } });
    const metrics = JSON.stringify(ck.otlp.metrics);
    for (const m of ["landlens.sessions", "landlens.agent.turns", "landlens.tool.calls", "landlens.cluster.writes", "gen_ai.client.token.usage", "landlens.clusters.connected", "landlens.doctor.problems"]) expect(metrics).toContain(m);
    expect(JSON.stringify(ck.otlp.logs)).toContain("session.started");
  });

  it("takes the usage_update that the SDK hands over after the answer", async () => {
    const { t, confirm, ck } = await setup();
    await t.set({ on: true, collector: ck.origin }, confirm);
    t.sessionStarted({ session: SESSION, context: "orbstack" });
    t.turnStarted(SESSION, askOf("hi", []));
    const ended = t.turnEnded(SESSION, { stopReason: "end_turn" });
    t.usage(SESSION, { model: "claude-fake-1", cost: { amount: 0.5, currency: "USD" } });
    t.sessionEnded(SESSION);
    await ended;
    const span = t.recent().records.find((r) => r.name === "invoke_agent landlens-claude");
    expect(span?.attrs).toMatchObject({ "gen_ai.request.model": "claude-fake-1", "gen_ai.usage.cost": 0.5 });
  });

  it("with counts only, no cluster, namespace or object name goes", async () => {
    const { t, confirm, ck, sent } = await setup();
    await t.set({ on: true, collector: ck.origin, names: false }, confirm);
    await aTurn(t);
    t.tick();
    await t.queue.flush();
    const out = sent();
    expect(out).toContain("invoke_agent");
    for (const name of ["orbstack", "landlens-dev", "orders-api"]) expect(out).not.toContain(name);
  });

  it("turning it off drops what waits, unsent", async () => {
    const { t, confirm, ck } = await setup();
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t);
    expect(t.queue.waiting).toBeGreaterThan(0);
    await t.set({ on: false }, confirm);
    expect(t.queue.waiting).toBe(0);
    expect(t.recent().records).toEqual([]);
    await t.queue.flush();
    expect(ck.otlp.traces).toEqual([]);
  });

  it("counts only drops what was queued with names, unsent (review of part 5, M2)", async () => {
    const { t, confirm, ck, sent } = await setup();
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t);
    t.tick();
    expect(JSON.stringify(t.queue.recent())).toContain("orders-api");
    await t.set({ names: false }, confirm);
    expect(t.queue.waiting).toBe(0);
    await aTurn(t);
    await t.queue.flush();
    expect(sent()).toContain("invoke_agent");
    for (const name of ["orbstack", "landlens-dev", "orders-api"]) expect(sent()).not.toContain(name);
  });

  it("another collector drops what was queued for the old one (M2)", async () => {
    const { t, confirm, ck } = await setup();
    const other = new FakeClickland();
    await other.start();
    stops.push(() => other.stop());
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t);
    await t.set({ collector: other.origin }, confirm);
    expect(t.queue.waiting).toBe(0);
    await t.queue.flush();
    expect(ck.otlp).toEqual({ traces: [], metrics: [], logs: [] });
    expect(other.otlp.traces).toEqual([]);
  });

  it("turning names back on asks in main's dialog; declining keeps counts only (M3)", async () => {
    const { t, confirm, asked, say, settings } = await setup();
    await t.set({ on: true, names: false }, confirm);
    expect(asked).toHaveLength(1);
    say(false);
    await expect(t.set({ names: true }, confirm)).rejects.toMatchObject({ status: 409, message: TELEMETRY_NOTES.namesDeclined });
    expect(settings.telemetry().names).toBe(false);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("Send names with Landlens's telemetry to 127.0.0.1:4318?");
    expect(asked[1]).toContain("The names of the cluster, namespace and the object");
    say(true);
    expect((await t.set({ names: true }, confirm)).names).toBe(true);
    // Narrowing never asks.
    await t.set({ names: false }, confirm);
    expect(asked).toHaveLength(3);
  });

  it("a brief's subject goes only when the doctor reports a problem about it (L1)", async () => {
    const { t, confirm, ck } = await setup({ problems: false });
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t);
    const turn = t.recent().records.find((r) => r.name === "invoke_agent landlens-claude")!;
    expect(turn.attrs).toMatchObject({ "landlens.ask": "problem", "landlens.problem.class": "crashloop" });
    for (const k of ["landlens.subject.kind", "landlens.subject.namespace", "landlens.subject.name"] as const) expect(turn.attrs[k]).toBeUndefined();
  });

  it("names a cluster by the name set for graphs, or a plain context; never a GKE project or an account id (L2)", async () => {
    const gke = "gke_acme-prod-123_us-central1-a_main";
    const eks = "arn:aws:eks:eu-west-1:123456789012:cluster/prod";
    const { t, confirm, ck } = await setup({ named: { [eks]: "prod-eu" } });
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t, SESSION, gke);
    await aTurn(t, "0b6e1c1e-5d1a-4c55-9a51-0d3c8e6d2f11", eks);
    await aTurn(t, "0b6e1c1e-5d1a-4c55-9a51-0d3c8e6d2f12", "acme-123456789012");
    const turns = t.recent().records.filter((r) => r.name === "invoke_agent landlens-claude");
    expect(turns.map((r) => r.attrs["landlens.cluster"])).toEqual([undefined, "prod-eu", undefined]);
    expect(JSON.stringify(t.recent())).not.toContain("acme");
  });

  it("names a tool only when its server listed it as accepted (L8)", async () => {
    const { t, confirm, ck } = await setup({ tools: false });
    await t.set({ on: true, collector: ck.origin }, confirm);
    await aTurn(t);
    const tools = t.recent().records.filter((r) => r.name.startsWith("execute_tool"));
    expect(tools.map((r) => r.name)).toEqual(["execute_tool landlens-kube.unknown", "execute_tool remote.remote"]);
  });

  it("a quit waits at most 2 s for a collector that never answers, and sends the turn still settling (L5)", async () => {
    const posted: string[] = [];
    const hang = (async (_u: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body));
      return new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    const { t, confirm } = await setup({ fetch: hang });
    await t.set({ on: true }, confirm);
    t.sessionStarted({ session: SESSION, context: "orbstack" });
    t.turnStarted(SESSION, askOf("hi", []));
    void t.turnEnded(SESSION, { stopReason: "end_turn" });
    const at = Date.now();
    await t.stop();
    expect(Date.now() - at).toBeLessThan(TELEMETRY.stopMs + 500);
    expect(posted.join("\n")).toContain("invoke_agent landlens-claude");
  });

  it("opens a session's spans in the console only for a known session, after main's dialog", async () => {
    const { t, dialog, asked, opened } = await setup();
    await expect(t.open(SESSION, () => false, dialog)).rejects.toMatchObject({ status: 404 });
    expect((await t.open(SESSION, () => true, dialog)).opened).toBe(true);
    expect(asked[0]).toContain("clickland.example");
    expect(opened).toEqual([`https://clickland.example/search?signal=traces&query=gen_ai.conversation.id%3A%22${SESSION}%22`]);
  });
  it("a Secret's reveal and copy build no record; its reads count under the object policy and name nothing (wave 8 part 4, D168)", async () => {
    const MARK = "LLMARK-telemetry-0123456789abcdef01234567";
    const { t, confirm, ck, sent } = await setup();
    await t.set({ on: true, collector: ck.origin }, confirm);
    // What main's hooks see of a reveal: the front door's audit entry for the object token, and no action count.
    t.audit({ at: new Date().toISOString(), label: "you · orbstack · secret landlens-dev/hands-secret", method: "GET", cluster: "h1", path: "/api/v1/namespaces/landlens-dev/secrets/hands-secret", allowed: true, status: 200, access: "object" });
    t.action({ action: "reveal", outcome: "applied" });
    t.action({ action: "copy", outcome: "applied" });
    t.tick();
    expect(JSON.stringify(t.queue.recent())).not.toMatch(new RegExp(`hands-secret|${MARK}|reveal|copy`));
    await t.queue.flush();
    const all = sent();
    expect(all).toContain('"landlens.policy","value":{"stringValue":"object"}');
    expect(all).not.toMatch(/hands-secret|secrets\/|reveal|"copy"/);
    expect(all).not.toContain(MARK);
  });
});
