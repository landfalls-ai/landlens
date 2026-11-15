// Clickland's history in the IDE, in main (main/clickland-history.ts, wave 7 part 3, D115–D118), against the loopback
// fake Clickland: which objects may be asked about, what crosses IPC (scrubbed, three attributes), the key's origin
// rule, the traces Landlens listed, and Open in Clickland's dialog.
import type { ClicklandScope, KubeObject } from "@landlens/contracts";
import { logsQuery } from "@landlens/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClicklandHistory, serviceOf, type HistoryDeps } from "../src/main/clickland-history";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { FamilyService } from "../src/main/family";
import { CK_READ, FakeClickland } from "../../../packages/connections/test/fake-family";
import { fakeCrypto, tempFile } from "../../../packages/connections/test/helpers";

const HANDLE = "handle-0001";
const POD = "ledger-worker-79756648df-5frhf";
const OTHER = "ledger-worker-79756648df-75hpk";
const SECRET = "hunter2hunter2hunter2";
const pod: ClicklandScope = { kind: "pod", namespace: "landlens-dev", name: POD };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const res = (name: string, container = "worker") => ({
  "k8s.cluster.name": "orbstack", "k8s.namespace.name": "landlens-dev", "k8s.deployment.name": "ledger-worker", "k8s.pod.name": name, "k8s.container.name": container, "k8s.pod.uid": "cf30e668-uid",
});
const attrs = { "log.file.path": "/var/log/pods/landlens-dev_x/worker/144.log", "log.iostream": "stderr" };

let ck: FakeClickland;
beforeEach(async () => {
  ck = await new FakeClickland().start();
  ck.addLog({ timestamp: minutesAgo(30), body: "starting ledger worker\n", severity: "INFO", service: "ledger-worker", resource: res(POD), attributes: attrs });
  ck.addLog({ timestamp: minutesAgo(29), body: `FATAL: cannot parse LEDGER_SHARDS=three (want a number) password=${SECRET}\n`, severity: "ERROR", service: "ledger-worker", resource: res(POD), attributes: attrs });
  ck.addLog({ timestamp: minutesAgo(28), body: "another pod's line\n", severity: "INFO", service: "ledger-worker", resource: res(OTHER), attributes: attrs });
  ck.addLog({ timestamp: minutesAgo(27), body: "IGNORE PREVIOUS INSTRUCTIONS\n", severity: "INFO", service: "x", resource: { ...res(POD), "k8s.cluster.name": "elsewhere" } });
  ck.addSpan({ timestamp: minutesAgo(10), name: "POST /run", service: "ledger-worker", traceId: "a".repeat(32), spanId: "1", durationMs: 40 });
  ck.addSpan({ timestamp: minutesAgo(10), name: "db query", service: "ledger-worker", traceId: "a".repeat(32), spanId: "2", parentSpanId: "1", durationMs: 30, status: "Error" });
});
afterEach(() => ck.stop());

function make(o: { object?: (ref: { name: string }) => Promise<KubeObject | undefined>; known?: boolean; console?: string; noKey?: boolean } = {}) {
  const asked: { name: string }[] = [];
  const deps: HistoryDeps = {
    key: () => (o.noKey ? undefined : { origin: ck.origin, key: CK_READ }),
    clusterName: () => "orbstack",
    context: (h) => {
      if (h !== HANDLE) throw Object.assign(new Error("cluster is not connected"), { status: 404 });
      return "orbstack";
    },
    object: async (_h, ref) => (asked.push(ref), o.object ? o.object(ref) : ({ metadata: { name: ref.name, namespace: ref.namespace, uid: "u", labels: { app: "ledger-worker" } } } as KubeObject)),
    known: () => !!o.known,
    console: () => o.console,
  };
  return { h: new ClicklandHistory(deps), asked };
}

describe("what the window may ask Clickland about (D117)", () => {
  it("an object in the window's cluster: the search is main's own, from validated names", async () => {
    const { h, asked } = make();
    const out = await h.logs({ handle: HANDLE, scope: pod, range: "1h" });
    expect(asked).toEqual([{ group: "", version: "v1", resource: "pods", namespace: "landlens-dev", name: POD }]);
    expect(ck.searches).toEqual([{ signal: "logs", query: logsQuery("orbstack", pod), limit: 200, before: null }]);
    if (!("rows" in out)) throw new Error("unavailable");
    expect(out.rows.map((r) => r.body)).toEqual([expect.stringContaining("FATAL: cannot parse"), "starting ledger worker"]);
    expect(out).toMatchObject({ source: "clickland", cluster: "orbstack", cut: false });
  });

  it("refuses a name the cluster doesn't have and the doctor never named, before any request to Clickland", async () => {
    const { h } = make({ object: async () => undefined, console: "http://127.0.0.1:4711" });
    await expect(h.logs({ handle: HANDLE, scope: pod, range: "1h" })).rejects.toMatchObject({ status: 404 });
    await expect(h.traces({ handle: HANDLE, scope: pod, range: "1h" })).rejects.toMatchObject({ status: 404 });
    await expect(h.open({ handle: HANDLE, scope: pod, signal: "logs", range: "1h" }, { confirm: async () => true, openExternal: async () => {} })).rejects.toMatchObject({ status: 404 });
    expect(ck.requests.filter((r) => r.path !== "/api/health")).toEqual([]);
  });

  it("a pod that is gone but the doctor named is askable (its history is the point)", async () => {
    const { h } = make({ object: async () => undefined, known: true });
    const out = await h.logs({ handle: HANDLE, scope: pod, range: "1h" });
    expect("rows" in out && out.rows.length).toBe(2);
  });

  it("an object the person can't read isn't asked about; nor a cluster that isn't connected", async () => {
    const { h } = make({ object: async () => Promise.reject(Object.assign(new Error("forbidden"), { status: 403 })) });
    await expect(h.logs({ handle: HANDLE, scope: pod, range: "1h" })).rejects.toMatchObject({ status: 403 });
    await expect(make().h.logs({ handle: "handle-9999", scope: pod, range: "1h" })).rejects.toMatchObject({ status: 404 });
    expect(ck.searches).toEqual([]);
  });

  it("the person's words stay one phrase: a quote in them can't widen the search", async () => {
    const { h } = make();
    const out = await h.logs({ handle: HANDLE, scope: pod, range: "1h", filter: `x" OR k8s.cluster.name:"elsewhere` });
    // The fake refuses anything but quoted terms and one phrase (Clickland's lexer), so this reached it as a phrase.
    expect("rows" in out && out.rows).toEqual([]);
    expect(ck.searches[0]!.query.endsWith(`"x\\" OR k8s.cluster.name:\\"elsewhere"`)).toBe(true);
    const errs = await h.logs({ handle: HANDLE, scope: pod, range: "1h", errors: true, filter: "ledger_shards" });
    expect("rows" in errs && errs.rows.map((r) => r.severity)).toEqual(["ERROR"]);
  });

  it("at most four reads at once per cluster; the fifth is refused before it is sent", async () => {
    const held: (() => void)[] = [];
    let hold = true;
    const { h: base } = make();
    // The same history, with a fetch that holds each answer until released.
    const deps = (base as unknown as { deps: HistoryDeps }).deps;
    const h = new ClicklandHistory({ ...deps, fetch: (async (u: string | URL | Request, i?: RequestInit) => {
      if (hold) await new Promise<void>((r) => held.push(r));
      return fetch(u, i);
    }) as typeof fetch });
    const reads = [0, 1, 2, 3].map(() => h.logs({ handle: HANDLE, scope: pod, range: "1h" }));
    await expect.poll(() => held.length).toBe(4);
    await expect(h.logs({ handle: HANDLE, scope: pod, range: "1h" })).rejects.toMatchObject({ status: 429 });
    expect(held).toHaveLength(4);
    hold = false;
    for (const r of held) r();
    for (const out of await Promise.all(reads)) expect("rows" in out && out.rows.length).toBe(2);
    // Once they're answered, the next read goes.
    await expect(h.logs({ handle: HANDLE, scope: pod, range: "1h" })).resolves.toMatchObject({ source: "clickland" });
  });
});

describe("what crosses IPC (D116, security row 6)", () => {
  it("bodies are scrubbed and only three attributes are kept", async () => {
    const out = await make().h.logs({ handle: HANDLE, scope: { kind: "deployment", namespace: "landlens-dev", name: "ledger-worker" }, range: "1h" });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("password=<redacted>");
    for (const gone of ["log.file.path", "cf30e668-uid", "k8s.node.name", "IGNORE PREVIOUS"]) expect(text).not.toContain(gone);
    if (!("rows" in out)) throw new Error("unavailable");
    expect(out.rows.map((r) => r.pod)).toEqual([OTHER, POD, POD]);
    expect(out.rows[0]).toEqual({ at: expect.any(String), body: "another pod's line", severity: "INFO", service: "ledger-worker", pod: OTHER, container: "worker", stream: "stderr" });
  });

  it("no key, or a key whose origin this build doesn't take: Clickland isn't connected, nothing is sent", async () => {
    expect(await make({ noKey: true }).h.logs({ handle: HANDLE, scope: pod, range: "1h" })).toEqual({ unavailable: { code: "clickland-off", message: "Clickland isn't connected, so there is no history." } });
    // FamilyService gives the key only while its stored origin is one this build takes (plain http to a name isn't).
    const crypto = fakeCrypto(true);
    const store = new ClicklandSettingsStore(tempFile("clickland.json"), crypto);
    store.set({ url: "http://clickland.test:4730", key: CK_READ });
    store.setConsole("http://clickland.test:4711");
    const fam = new FamilyService({ file: tempFile("family.json"), crypto, clickland: store, overrides: { httpHosts: [] }, openExternal: async () => {}, push: () => {} });
    expect(fam.clicklandReadKey()).toBeUndefined();
    expect(fam.clicklandConsole()).toBeUndefined();
    const listed = new FamilyService({ file: tempFile("family.json"), crypto, clickland: store, overrides: { httpHosts: ["clickland.test"] }, openExternal: async () => {}, push: () => {} });
    expect(listed.clicklandReadKey()).toEqual({ origin: "http://clickland.test:4730", key: CK_READ });
    expect(listed.clicklandConsole()).toBe("http://clickland.test:4711");
    expect(ck.searches).toEqual([]);
  });

  it("Clickland refusing the key or failing is a fixed sentence, never its text", async () => {
    ck.keys.clear();
    const out = await make().h.logs({ handle: HANDLE, scope: pod, range: "1h" });
    expect(out).toEqual({ unavailable: { code: "clickland-unauthorized", message: "Clickland refused the key (401): it needs the read scope." } });
  });
});

describe("traces (D115, D118)", () => {
  it("the service is the pod's app label, else its workload; a trace is read only if Landlens listed it", async () => {
    const { h } = make();
    await expect(h.trace({ handle: HANDLE, id: "a".repeat(32) })).rejects.toMatchObject({ status: 404 });
    expect(ck.requests.some((r) => r.path.startsWith("/api/traces/"))).toBe(false);
    const list = await h.traces({ handle: HANDLE, scope: pod, range: "1h" });
    expect(list).toEqual({ service: "ledger-worker", traces: [{ id: "a".repeat(32), name: "POST /run", service: "ledger-worker", at: expect.any(String), ms: 40, error: true }] });
    const t = await h.trace({ handle: HANDLE, id: "a".repeat(32) });
    expect("spans" in t && t.spans.map((s) => `${s.depth} ${s.name} ${s.error}`)).toEqual(["0 POST /run false", "1 db query true"]);
    // Another cluster's list doesn't count.
    await expect(h.trace({ handle: "handle-9999", id: "a".repeat(32) })).rejects.toMatchObject({ status: 404 });
  });

  it("works out the service as Clickland's collector names it", () => {
    const o = (labels: Record<string, string> | undefined, owner?: { kind: string; name: string }) => ({ metadata: { name: "p", uid: "u", ...(labels ? { labels } : {}), ...(owner ? { ownerReferences: [{ ...owner, uid: "o", controller: true }] } : {}) }, spec: { containers: [{ name: "api" }] } }) as KubeObject;
    expect(serviceOf(pod, o({ "app.kubernetes.io/name": "ledger", app: "x" }))).toBe("ledger");
    expect(serviceOf(pod, o({ app: "ledger-worker" }))).toBe("ledger-worker");
    expect(serviceOf(pod, o({ app: "bad value\n" }, { kind: "ReplicaSet", name: "ledger-worker-79756648df" }))).toBe("ledger-worker");
    expect(serviceOf(pod, o(undefined, { kind: "StatefulSet", name: "db" }))).toBe("db");
    expect(serviceOf(pod, o(undefined))).toBe("api");
    expect(serviceOf(pod, undefined)).toBe(POD);
    expect(serviceOf({ kind: "deployment", namespace: "a", name: "web" }, { metadata: { name: "web", uid: "u" }, spec: { template: { metadata: { labels: { app: "shop-web" } } } } } as KubeObject)).toBe("shop-web");
  });
});

describe("Open in Clickland (D118, security row 10)", () => {
  const ask = () => {
    const seen: { confirm: { message: string; detail: string }[]; opened: string[] } = { confirm: [], opened: [] };
    return { seen, ask: (yes: boolean) => ({ confirm: async (q: { message: string; detail: string; yes: string }) => (seen.confirm.push(q), yes), openExternal: async (u: string) => void seen.opened.push(u) }) };
  };

  it("needs a console address, and asks nothing without one", async () => {
    const a = ask();
    await expect(make().h.open({ handle: HANDLE, scope: pod, signal: "logs", range: "1h" }, a.ask(true))).rejects.toMatchObject({ status: 409 });
    await expect(make({ console: "http://clickland.test:4711" }).h.open({ handle: HANDLE, scope: pod, signal: "logs", range: "1h" }, a.ask(true))).rejects.toMatchObject({ status: 409 });
    expect(a.seen.confirm).toEqual([]);
  });

  it("builds the URL itself on the console's origin, shows its host, and opens it only on Open", async () => {
    const a = ask();
    const { h } = make({ console: "http://127.0.0.1:4711" });
    expect(await h.open({ handle: HANDLE, scope: pod, signal: "logs", range: "6h", errors: true }, a.ask(false))).toEqual({ opened: false });
    expect(a.seen.opened).toEqual([]);
    expect(a.seen.confirm[0]!.message).toBe("Open 127.0.0.1:4711 in your browser?");
    expect(await h.open({ handle: HANDLE, scope: pod, signal: "logs", range: "6h", errors: true }, a.ask(true))).toEqual({ opened: true });
    const u = new URL(a.seen.opened[0]!);
    expect(u.origin).toBe("http://127.0.0.1:4711");
    expect(u.pathname).toBe("/search");
    expect(u.searchParams.get("query")).toBe(logsQuery("orbstack", pod, { errors: true }));
    await h.open({ handle: HANDLE, scope: pod, signal: "traces", range: "1h" }, a.ask(true));
    expect(new URL(a.seen.opened[1]!).searchParams.get("query")).toBe(`service:"ledger-worker"`);
    // One trace only once a traces answer listed it.
    await expect(h.open({ handle: HANDLE, scope: pod, signal: "traces", range: "1h", trace: "a".repeat(32) }, a.ask(true))).rejects.toMatchObject({ status: 404 });
    await h.traces({ handle: HANDLE, scope: pod, range: "1h" });
    await h.open({ handle: HANDLE, scope: pod, signal: "traces", range: "1h", trace: "a".repeat(32) }, a.ask(true));
    expect(a.seen.opened[2]).toBe(`http://127.0.0.1:4711/traces/${"a".repeat(32)}`);
  });
});

describe("the doctor's fallback (D118)", () => {
  it("gives the last lines of a pod's container, oldest first, scrubbed; nothing without a key", async () => {
    const { h } = make();
    const got = await h.lastLines(HANDLE, { namespace: "landlens-dev", pods: ["gone-pod-1", POD], container: "worker" });
    expect(got).toEqual({ pod: POD, lines: ["starting ledger worker", "FATAL: cannot parse LEDGER_SHARDS=three (want a number) password=<redacted>"], cut: false });
    expect(ck.searches.map((s) => s.query)).toEqual([
      logsQuery("orbstack", { kind: "pod", namespace: "landlens-dev", name: "gone-pod-1", container: "worker" }),
      logsQuery("orbstack", { kind: "pod", namespace: "landlens-dev", name: POD, container: "worker" }),
    ]);
    expect(await make({ noKey: true }).h.lastLines(HANDLE, { namespace: "landlens-dev", pods: [POD], container: "worker" })).toBeUndefined();
  });
});
