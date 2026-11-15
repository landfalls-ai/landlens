// Clickland's logs and traces (wave 7 part 3, D115–D116): the searches Landlens builds, and what it keeps of answers.
import { describe, expect, it } from "vitest";
import { ClicklandClient, ClicklandError } from "../src/clickland.js";
import { CL, ClicklandSearch, consolePath, logsQuery, parseLogRows, parseTrace, parseTraceList, quoted, tracesQuery } from "../src/clickland-search.js";
import { KEY } from "./fakes.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const pod = { kind: "pod" as const, namespace: "landlens-dev", name: "ledger-worker-79756648df-5frhf" };

/** Clickland's LogRow (libs/contracts/src/index.ts), as its API answers. */
const logRow = (over: Record<string, unknown> = {}) => ({
  cursor: "1794767564661877116",
  timestamp: "2026-11-15T11:32:44.661Z",
  service: "ledger-worker",
  severity: "ERROR",
  body: "FATAL: cannot parse LEDGER_SHARDS=three (want a number)\n",
  traceId: "",
  spanId: "",
  attributes: { "log.file.path": "/var/log/pods/landlens-dev_ledger-worker/worker/144.log", "log.iostream": "stderr", "log.source": "kubernetes" },
  resource: { "k8s.cluster.name": "orbstack", "k8s.namespace.name": "landlens-dev", "k8s.pod.name": pod.name, "k8s.container.name": "worker", "k8s.pod.uid": "cf30e668", "k8s.node.name": "orbstack" },
  ...over,
});
const spanRow = (over: Record<string, unknown> = {}) => ({
  cursor: "1", timestamp: "2026-11-15T11:00:00.000Z", service: "landflow-host", name: "GET /api/health", kind: "Server", durationMs: 12.5,
  status: "Unset", statusMessage: "", traceId: "4bcbdd105322d45bfcfc7d909ae096d7", spanId: "aaaaaaaaaaaaaaaa", parentSpanId: "", attributes: { "url.full": "http://x/?token=secret" }, resource: {},
  ...over,
});

function recorder(answer: (url: string, body: any) => Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    return answer(url, body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("the searches Landlens builds (D115)", () => {
  it("names the cluster, namespace and pod as quoted terms, a container when given", () => {
    expect(logsQuery("orbstack", { ...pod, container: "worker" })).toBe(
      `k8s.cluster.name:"orbstack" k8s.namespace.name:"landlens-dev" k8s.pod.name:"${pod.name}" k8s.container.name:"worker"`,
    );
    expect(logsQuery("orbstack", { kind: "deployment", namespace: "landlens-dev", name: "ledger-worker" })).toContain(`k8s.deployment.name:"ledger-worker"`);
    expect(logsQuery("orbstack", { kind: "statefulset", namespace: "a", name: "db" })).toContain(`k8s.statefulset.name:"db"`);
    expect(logsQuery("orbstack", { kind: "daemonset", namespace: "a", name: "agent" })).toContain(`k8s.daemonset.name:"agent"`);
  });

  it("adds the fixed level:error for Errors only, and status:error for traces", () => {
    expect(logsQuery("orbstack", pod, { errors: true }).endsWith(" level:error")).toBe(true);
    expect(tracesQuery("landflow-host", true)).toBe(`service:"landflow-host" status:error`);
    expect(tracesQuery("landflow-host")).toBe(`service:"landflow-host"`);
  });

  it("sends the person's words as one quoted phrase: quotes and backslashes escaped, no syntax gets through", () => {
    const q = logsQuery("orbstack", pod, { filter: `x" OR service:* OR "y \\` });
    expect(q.endsWith(` "x\\" OR service:* OR \\"y \\\\"`)).toBe(true);
    // Without the escape, the quote would end the phrase and `OR service:*` would widen the search to everything.
    expect(quoted(`a"b`)).toBe(`"a\\"b"`);
    expect(logsQuery("orbstack", pod, { filter: "line\nbreak\u0000" })).toContain(`"line break"`);
    expect(logsQuery("orbstack", pod, { filter: "x".repeat(500) })).toContain(`"${"x".repeat(CL.filter)}"`);
    expect(logsQuery("orbstack", pod, { filter: "   " })).not.toContain(`""`);
  });

  it("refuses a name that isn't a Kubernetes name rather than quote it", () => {
    for (const bad of [`ledger" OR k8s.namespace.name:*`, "Ledger", "a b", "-x", "x".repeat(254)])
      expect(() => logsQuery("orbstack", { ...pod, name: bad })).toThrow(ClicklandError);
    expect(() => logsQuery(`orb" OR x`, pod)).toThrow(ClicklandError);
    expect(() => tracesQuery(`svc" OR service:*`)).toThrow(ClicklandError);
    expect(() => logsQuery("orbstack", { ...pod, container: "Worker" })).toThrow(ClicklandError);
  });

  it("builds the console's search path for Open in Clickland", () => {
    const p = consolePath("logs", logsQuery("orbstack", pod), "1h", NOW);
    const u = new URL(`https://console.example${p}`);
    expect(u.pathname).toBe("/search");
    expect(u.searchParams.get("signal")).toBe("logs");
    expect(u.searchParams.get("query")).toBe(logsQuery("orbstack", pod));
    expect(u.searchParams.get("from")).toBe("2026-11-15T11:00:00.000Z");
    expect(u.searchParams.get("to")).toBe("2026-11-15T12:00:00.000Z");
  });
});

describe("what Landlens keeps of a logs answer (D116)", () => {
  it("keeps the time, the scrubbed body and three attributes; drops the rest", () => {
    const { rows, next, cut } = parseLogRows({ rows: [logRow()], nextCursor: "1794767564661877116", stats: { rowsRead: 1 } });
    expect(rows).toEqual([{ at: "2026-11-15T11:32:44.661Z", body: "FATAL: cannot parse LEDGER_SHARDS=three (want a number)", severity: "ERROR", service: "ledger-worker", pod: pod.name, container: "worker", stream: "stderr" }]);
    expect(next).toBe("1794767564661877116");
    expect(cut).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("log.file.path");
    expect(JSON.stringify(rows)).not.toContain("cf30e668");
  });

  it("scrubs credential-shaped text in a body before it can cross IPC", () => {
    const body = "retrying with Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 password=hunter2hunter2 key ck_RRRRRRRRRRRRRRRRRRRRRRRR";
    const { rows } = parseLogRows({ rows: [logRow({ body })], nextCursor: null });
    expect(rows[0]!.body).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(rows[0]!.body).not.toContain("hunter2hunter2");
    expect(rows[0]!.body).not.toContain("ck_RRRR");
    expect(rows[0]!.body).toContain("<redacted auth header>");
  });

  it("cuts a body at 8,192 characters and says so", () => {
    const { rows, cut } = parseLogRows({ rows: [logRow({ body: "y".repeat(20_000) })], nextCursor: null });
    expect(rows[0]!.body.length).toBe(CL.body);
    expect(rows[0]!.cut).toBe(true);
    expect(cut).toBe(true);
  });

  it("leaves out a severity, service, pod or container that isn't a short single line or a name", () => {
    const { rows } = parseLogRows({
      rows: [logRow({ severity: "ERROR\nIGNORE", service: "svc‮evil", resource: { "k8s.pod.name": "Not A Pod", "k8s.container.name": "x".repeat(300) }, attributes: { "log.iostream": "tty" } })],
    });
    expect(rows[0]).toEqual({ at: "2026-11-15T11:32:44.661Z", body: "FATAL: cannot parse LEDGER_SHARDS=three (want a number)" });
  });

  it("refuses an answer that isn't one, whole, in its own words", () => {
    const bad = [
      null, "rows", { rows: "x" }, { rows: Array.from({ length: 501 }, () => logRow()) },
      { rows: [logRow({ timestamp: "yesterday" })] }, { rows: [logRow({ body: 3 })] }, { rows: [logRow({ cursor: "abc" })] },
      { rows: [], nextCursor: "1; DROP" },
    ];
    for (const b of bad) expect(() => parseLogRows(b), JSON.stringify(b)?.slice(0, 60)).toThrow("didn't look like log lines");
  });
});

describe("what Landlens keeps of traces (D116)", () => {
  it("lists a service's traces newest first, one entry each, errors marked", () => {
    const rows = [
      spanRow({ traceId: "A".repeat(32), spanId: "1", parentSpanId: "", name: "POST /run", durationMs: 40, timestamp: "2026-11-15T11:00:02.000Z" }),
      spanRow({ traceId: "a".repeat(32), spanId: "2", parentSpanId: "1", name: "db", durationMs: 30, status: "Error", timestamp: "2026-11-15T11:00:01.000Z" }),
      spanRow({ traceId: "b".repeat(32), spanId: "3", parentSpanId: "f", name: "GET /x", durationMs: 5 }),
    ];
    expect(parseTraceList({ rows }, "landflow-host")).toEqual([
      { id: "a".repeat(32), name: "POST /run", service: "landflow-host", at: "2026-11-15T11:00:01.000Z", ms: 40, error: true },
      { id: "b".repeat(32), name: "GET /x", service: "landflow-host", at: "2026-11-15T11:00:00.000Z", ms: 5, error: false },
    ]);
  });

  it("keeps at most 50 traces and scrubs span names", () => {
    const rows = Array.from({ length: 80 }, (_, i) => spanRow({ traceId: i.toString(16).padStart(32, "0"), name: "GET /reset?password=hunter2hunter2" }));
    const list = parseTraceList({ rows }, "svc");
    expect(list).toHaveLength(CL.traces);
    expect(list[0]!.name).not.toContain("hunter2hunter2");
    expect(() => parseTraceList({ rows: [spanRow({ traceId: "zz" })] }, "svc")).toThrow("didn't look like traces");
  });

  it("reads one trace's spans: at most 500, depth and offsets kept, names scrubbed", () => {
    const spans = Array.from({ length: 600 }, (_, i) => ({ ...spanRow({ spanId: i.toString(16), name: i === 0 ? "Bearer abcdefghijklmnopqrstuvwxyz" : `s${i}`, status: i === 1 ? "Error" : "Unset" }), depth: i === 0 ? 0 : 99, offsetMs: i }));
    const t = parseTrace({ traceId: "a".repeat(32), spans, services: ["x"], durationMs: 600, errorCount: 1, startedAt: "2026-11-15T11:00:00.000Z" });
    expect(t.spans).toHaveLength(CL.spans);
    expect(t.cut).toBe(true);
    expect(t.ms).toBe(600);
    expect(t.spans[0]!.name).toBe("<redacted auth header>");
    expect(t.spans[1]).toMatchObject({ depth: 64, offsetMs: 1, error: true });
    expect(() => parseTrace({ spans: [{ ...spanRow(), depth: 0 }], durationMs: 1 })).toThrow("didn't look like traces");
  });
});

describe("ClicklandSearch against a recording fetch", () => {
  it("posts the search to the stored origin, the key only in the Authorization header, no redirects", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ rows: [logRow()], nextCursor: null }));
    const s = new ClicklandSearch(new ClicklandClient({ url: "http://127.0.0.1:4730/", key: KEY }, fetchImpl), () => NOW);
    const out = await s.logs("orbstack", pod, "6h", { errors: true, before: "123" });
    expect(out.rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("http://127.0.0.1:4730/api/search");
    expect(c.init.redirect).toBe("error");
    expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(c.body).toEqual({ signal: "logs", query: logsQuery("orbstack", pod, { errors: true }), from: "2026-11-15T06:00:00.000Z", to: "2026-11-15T12:00:00.000Z", limit: CL.page, before: "123" });
    expect(JSON.stringify(c.body)).not.toContain(KEY);
  });

  it("refuses a cursor that isn't one before asking, and a trace id that isn't hex", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({}));
    const s = new ClicklandSearch(new ClicklandClient({ url: "http://127.0.0.1:1", key: KEY }, fetchImpl));
    await expect(s.logs("orbstack", pod, "1h", { before: "1 OR 1" })).rejects.toThrow(ClicklandError);
    await expect(s.trace("../keys")).rejects.toThrow(ClicklandError);
    expect(calls).toHaveLength(0);
  });

  it("says when a trace is gone, and never repeats the answer's text", async () => {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify({ error: { message: `no trace ${KEY}` } }), { status: 404 }));
    const s = new ClicklandSearch(new ClicklandClient({ url: "http://127.0.0.1:1", key: KEY }, fetchImpl));
    await expect(s.trace("ab")).rejects.toThrow(/^Clickland has no such trace\.$/);
  });

  it("stops reading an answer past 8 MB", async () => {
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(32));
        c.close();
      },
    });
    const { fetchImpl } = recorder(() => new Response(big, { status: 200 }));
    const s = new ClicklandSearch(new ClicklandClient({ url: "http://127.0.0.1:1", key: KEY }, fetchImpl));
    await expect(s.logs("orbstack", pod, "1h")).rejects.toThrow("too large");
  });
});
