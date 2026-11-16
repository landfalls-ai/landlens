// The view runtime's connection sources (wave 10 part 4, D207, D212): Google Cloud under the person's grant, Clickland
// with its key in main, and a gateway server's pre-allowed read. Each is asked at every read whether Claude could read it
// now, and every refusal is one of D222's sentences. Each safety rule here has a test that fails without it.
import { FAMILY_NOTES, type ClicklandLogs, type ClicklandTraces, type FamilyInfo, type GcpResource, type SourceData } from "@landlens/contracts";
import type { GcpReader } from "@landlens/gcp-mcp";
import { SENTENCES } from "@landlens/views";
import { afterEach, describe, expect, it } from "vitest";
import { clicklandReadsFree, ViewRuntime, type ToolAnswer, type ViewPush, type ViewRuntimeDeps } from "../src/main/view-runtime";
import { FakeApi, fakeClusters, sleep, until } from "./view-fakes";

const H = "handle-0001";
const FAST = { batch: 10, push: 40, top: 30, metrics: 30, doctor: 30, helm: 30, eventsTick: 50, logPods: 40, logRetry: 20, refresh: 200, hiddenStop: 60, gcp: 40, clickland: 40, tool: 40 };
const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
const CTX = "gke_my-project_europe-west1_prod";

const doc = (s: Record<string, unknown>) => ({ schema: 1, title: "t", sources: { s }, blocks: [{ type: "text", markdown: "x" }] });

let runtimes: ViewRuntime[] = [];
afterEach(() => {
  for (const r of runtimes) r.closeAll();
  runtimes = [];
});

function setup(o: Partial<ViewRuntimeDeps> = {}) {
  const api = new FakeApi();
  const c = fakeClusters();
  const pushes: ViewPush[] = [];
  const rt = new ViewRuntime({ clusters: c.clusters, frontDoor: api.door, client: (_u, t) => api.client(t), push: (p) => pushes.push(p), times: FAST, ...o });
  runtimes.push(rt);
  const latest = (v: string): SourceData | undefined => [...pushes].reverse().find((p) => p.view === v && p.source === "s")?.data;
  const wait = async (v: string, f: (d: SourceData) => boolean, what = "data") => {
    await until(() => !!latest(v) && f(latest(v)!), what);
    return latest(v)!;
  };
  return { api, rt, pushes, latest, wait };
}

/** A reader as GcpService.agentReader gives one: the chosen projects, and what each read answers. */
function reader(opts: Partial<Omit<GcpReader, "limit">> & { chosen?: string[]; limit?: string[] } = {}): GcpReader & { calls: string[] } {
  const { chosen, limit, ...o } = opts;
  const calls: string[] = [];
  const r: GcpReader & { calls: string[] } = {
    calls,
    projects: async () => (calls.push("projects"), (chosen ?? ["my-project"]).map((id) => ({ id, name: id }))),
    types: async () => ({ types: [] }),
    resources: async (q: { project: string }) => (calls.push(`resources ${q.project}`), { items: [{ name: "//sqladmin.googleapis.com/projects/my-project/instances/db", assetType: "sqladmin.googleapis.com/Instance", displayName: `db ${TOKEN}`, state: "RUNNABLE", location: "europe-west1" } as GcpResource], cut: false }),
    resource: async () => undefined,
    clusters: async () => ({ clusters: [{ context: CTX, name: "prod", project: "my-project", location: "europe-west1", status: "RUNNING", version: "1.31" } as never], errors: [] }),
    connected: () => true,
    advice: async () => ({ clusters: [], errors: [] }),
    alerts: async () => ({
      items: [
        { id: "a1", opened: "2026-11-16T10:00:00Z", policy: "Restarts", severity: "critical", resourceType: "k8s_container", kube: true, namespace: "shop", cluster: { location: "europe-west1", name: "prod" } },
        { id: "a2", opened: "2026-11-16T10:00:00Z", policy: "Other team", severity: "warning", resourceType: "k8s_container", kube: true, namespace: "payments", cluster: { location: "europe-west1", name: "prod" } },
      ] as never,
      cut: false,
    }),
    alert: async () => undefined,
    metrics: async () => ({ series: { source: "cloud-monitoring", from: 0, to: 1, step: 60, cpu: { series: [] }, memory: { series: [] } } as never }),
    limit: async () => limit,
    ...o,
  } as never;
  return r;
}

describe("Google Cloud sources (D212)", () => {
  it("is off, in D222's sentence, while Claude can't read Google Cloud, and reads again once it can, asked at every run", async () => {
    let r: GcpReader | undefined;
    const { rt, wait } = setup({ gcp: async () => r });
    const v = rt.open({ handle: H, document: doc({ kind: "gcp.resources", project: "my-project" }) });
    const off = await wait(v, (d) => d.state !== "loading");
    expect(off).toMatchObject({ state: "off", message: SENTENCES.connectionOff("Google Cloud"), rows: [] });
    r = reader();
    const on = await wait(v, (d) => d.state === "ok", "reads once on");
    expect(on.rows[0]!.name).toBe("//sqladmin.googleapis.com/projects/my-project/instances/db");
    // Every string a cell: a token in a display name is redacted.
    expect(JSON.stringify(on.rows)).not.toContain(TOKEN);
    r = undefined;
    await wait(v, (d) => d.state === "off", "off again at the next read");
  });

  it("reads only a project the person let Claude read", async () => {
    const { rt, wait } = setup({ gcp: async () => reader({ chosen: ["another-proj"] }) });
    const v = rt.open({ handle: H, document: doc({ kind: "gcp.resources", project: "my-project" }) });
    expect(await wait(v, (d) => d.state !== "loading")).toMatchObject({ state: "off", message: SENTENCES.gcpProject("my-project") });
  });

  it("passes the view's namespaces to Google Cloud as the session's limit, and hides alerts of other namespaces", async () => {
    const asked: (string[] | undefined)[] = [];
    const { rt, wait } = setup({ gcp: async (_h, ns) => (asked.push(ns), reader({ limit: ns })) });
    const v = rt.open({ handle: H, document: doc({ kind: "gcp.alerts", project: "my-project" }), namespaces: ["shop"] });
    const d = await wait(v, (x) => x.state === "ok");
    expect(asked[0]).toEqual(["shop"]);
    expect(d.rows.map((r) => r.id)).toEqual(["a1"]);
    expect(d.message).toBe(SENTENCES.gcpOutside(1));
  });

  it("refuses cluster-wide usage to a limited view, as gcp_metrics does", async () => {
    const { rt, wait } = setup({ gcp: async (_h, ns) => reader({ limit: ns }) });
    const v = rt.open({ handle: H, document: { ...doc({ kind: "gcp.metrics", cluster: CTX, scope: "cluster", range: "1h" }), blocks: [{ type: "chart", source: "s", kind: "line", y: ["cpu"] }] }, namespaces: ["shop"] });
    expect(await wait(v, (d) => d.state !== "loading")).toMatchObject({ state: "forbidden", message: SENTENCES.gcpScope(["shop"]) });
  });

  it("says nothing of Google's own error text", async () => {
    const { rt, wait } = setup({ gcp: async () => reader({ resources: async () => Promise.reject(Object.assign(new Error(`quota for ${TOKEN}`), { status: 429 })) }) });
    const v = rt.open({ handle: H, document: doc({ kind: "gcp.resources", project: "my-project" }) });
    const d = await wait(v, (x) => x.state !== "loading");
    expect(d).toMatchObject({ state: "error", message: SENTENCES.connectionFailed("Google Cloud") });
    expect(JSON.stringify(d)).not.toContain("quota");
  });
});

describe("Clickland sources (D212)", () => {
  const logs: ClicklandLogs = { rows: [{ at: "2026-11-16T10:00:01Z", body: `password=${"x".repeat(12)} failed`, severity: "ERROR", pod: "api-1" }, { at: "2026-11-16T10:00:00Z", body: "started", severity: "INFO", pod: "api-1" }], cut: false } as never;
  it("is off while Clickland's reads don't run without asking, checked at every read", async () => {
    let on = false;
    const asked: unknown[] = [];
    const { rt, wait } = setup({ clickland: { on: () => on, logs: async (q) => (asked.push(q), logs), traces: async () => ({ traces: [], scoped: true }) as never } });
    const v = rt.open({ handle: H, document: { ...doc({ kind: "clickland.logs", namespace: "shop", pod: "api-1", range: "1h" }), blocks: [{ type: "logs", source: "s" }] } });
    expect(await wait(v, (d) => d.state !== "loading")).toMatchObject({ state: "off", message: SENTENCES.connectionOff("Clickland") });
    expect(asked).toEqual([]);
    on = true;
    const d = await wait(v, (x) => x.state === "ok", "reads once on");
    // This cluster's handle and the source's own scope, never another's.
    expect(asked[0]).toEqual({ handle: H, scope: { kind: "pod", namespace: "shop", name: "api-1" }, range: "1h" });
    // Oldest first, scrubbed, the failure marked.
    expect(d.lines!.map((l) => l.text)).toEqual(["started", expect.stringMatching(/^password=.*failed$/)]);
    expect(JSON.stringify(d)).not.toContain("x".repeat(12));
    expect(d.lines![1]!.failure).toBe(true);
  });

  it("reads only inside the view's namespaces", async () => {
    const { rt, wait } = setup({ clickland: { on: () => true, logs: async () => logs, traces: async () => ({ traces: [], scoped: true }) as never } });
    const v = rt.open({ handle: H, document: { ...doc({ kind: "clickland.logs", namespace: "payments", pod: "api-1", range: "1h" }), blocks: [{ type: "logs", source: "s" }] }, namespaces: ["shop"] });
    expect((await wait(v, (d) => d.state !== "loading")).state).toBe("forbidden");
  });

  it("maps a refusal of pods/log to forbidden and an object it doesn't know to unknown, in fixed sentences", async () => {
    const fails = [Object.assign(new Error("x"), { status: 403 }), Object.assign(new Error("y"), { status: 404 })];
    for (const [e, state, message] of [[fails[0], "forbidden", SENTENCES.clicklandLogsRbac], [fails[1], "unknown", SENTENCES.clicklandUnknown]] as const) {
      const { rt, wait } = setup({ clickland: { on: () => true, logs: async () => Promise.reject(e), traces: async () => Promise.reject(e) } });
      const v = rt.open({ handle: H, document: doc({ kind: "clickland.traces", namespace: "shop", workload: { kind: "Deployment", name: "api" }, range: "1h" }) });
      expect(await wait(v, (d) => d.state !== "loading")).toMatchObject({ state, message });
    }
  });

  it("shows traces as rows and says when they aren't all tagged with this cluster", async () => {
    const tr: ClicklandTraces = { traces: [{ id: "t1", name: "GET /", service: "api", at: "2026-11-16T10:00:00Z", ms: 12, error: true }], scoped: false } as never;
    const { rt, wait } = setup({ clickland: { on: () => true, logs: async () => logs, traces: async () => tr } });
    const v = rt.open({ handle: H, document: doc({ kind: "clickland.traces", namespace: "shop", pod: "api-1", range: "6h" }) });
    const d = await wait(v, (x) => x.state === "ok");
    expect(d.rows[0]).toMatchObject({ id: "t1", name: "GET /", error: true, _tone: "bad" });
    expect(d.message).toBe(SENTENCES.clicklandUnscoped);
  });
});

describe("tool sources (D212)", () => {
  it("is off in main's sentence when the read isn't free, asked at every run", async () => {
    let answer: ToolAnswer = { off: SENTENCES.toolNotFree("github", "list_issues") };
    const calls: unknown[] = [];
    const { rt, wait } = setup({ tool: async (h, server, tool, args) => (calls.push({ h, server, tool, args }), answer) });
    const v = rt.open({ handle: H, document: doc({ kind: "tool", server: "github", tool: "list_issues", arguments: { state: "open" }, rows: "items" }) });
    expect(await wait(v, (d) => d.state !== "loading")).toMatchObject({ state: "off", message: SENTENCES.toolNotFree("github", "list_issues") });
    expect(calls[0]).toEqual({ h: H, server: "github", tool: "list_issues", args: { state: "open" } });
    answer = { text: JSON.stringify({ items: [{ title: `fix ${TOKEN}`, number: 7, state: "open", toString: "x", nested: { a: 1 } }] }) };
    const d = await wait(v, (x) => x.state === "ok", "reads once free");
    expect(d.rows).toEqual([{ title: "fix <redacted>", number: 7, state: "open" }].map((r) => ({ ...r, title: expect.stringMatching(/^fix /) })));
    expect(JSON.stringify(d.rows)).not.toContain(TOKEN);
    expect(Object.keys(d.rows[0]!)).not.toContain("toString");
  });

  it("takes a non-JSON answer as one row of text, and an error as D222's sentence", async () => {
    let answer: ToolAnswer = { text: "plain words" };
    const { rt, wait } = setup({ tool: async () => answer });
    const v = rt.open({ handle: H, document: doc({ kind: "tool", server: "linear", tool: "list_issues" }) });
    const d = await wait(v, (x) => x.state === "ok");
    expect(d.rows).toEqual([{ text: "plain words" }]);
    expect(d.message).toBe(SENTENCES.toolText);
    answer = { error: "server said: drop table" };
    const e = await wait(v, (x) => x.state === "error", "error");
    expect(e.message).toBe(SENTENCES.toolFailed("linear", "list_issues"));
  });

  it("reads the rows a path names, through the document's fields", async () => {
    const { rt, wait } = setup({ tool: async () => ({ text: JSON.stringify({ data: { issues: [{ t: "a", n: 1 }, { t: "b", n: 2 }] } }) }) });
    const v = rt.open({ handle: H, document: doc({ kind: "tool", server: "linear", tool: "list_issues", rows: "data.issues", fields: { title: "t", num: "n" } }) });
    const d = await wait(v, (x) => x.state === "ok");
    expect(d.rows).toEqual([{ title: "a", num: 1 }, { title: "b", num: 2 }]);
  });

  it("without a tool dependency, says the read isn't free", async () => {
    const { rt, wait } = setup();
    const v = rt.open({ handle: H, document: doc({ kind: "tool", server: "github", tool: "x" }) });
    expect((await wait(v, (d) => d.state !== "loading")).state).toBe("off");
    await sleep(10);
  });
});

describe("when a view may read Clickland (D212, as a Claude session's reads without asking)", () => {
  it("only while connected, given to sessions, reads unasked, the listing accepted and unchanged, the name its own", () => {
    const ready: FamilyInfo = { sibling: "clickland", state: "ready", url: "http://127.0.0.1:4710", toSessions: true, readsAuto: true, tools: { read: 9, write: 5 } };
    expect(clicklandReadsFree(ready)).toBe(true);
    expect(clicklandReadsFree({ ...ready, note: FAMILY_NOTES.moved })).toBe(true);
    for (const off of [
      { state: "expired" as const }, { state: "connecting" as const }, { toSessions: false }, { readsAuto: false }, { tools: undefined }, { drift: true },
      { note: FAMILY_NOTES.nameTaken },
    ]) expect(clicklandReadsFree({ ...ready, ...off } as FamilyInfo), JSON.stringify(off)).toBe(false);
  });
});
