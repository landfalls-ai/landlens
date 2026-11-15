// The queue (D128): the cap and its drops, a batch at 200, three tries then dropped, no redirects, never a throw.
import type { TelemetryRecord } from "@landlens/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { QUEUE, TelemetryQueue, event, resourceOf } from "../src/index";

const rec = (n: number): TelemetryRecord => event("gateway.refused", "warn", n, 1_000 + n)!;
const resource = () => resourceOf({ version: "0.1.0", platform: "darwin" });
type Sent = { url: string; body: any; redirect?: string };

function fakeFetch(answer: (url: string) => number | Error, sent: Sent[] = []) {
  return Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)), ...(init?.redirect ? { redirect: init.redirect } : {}) });
    const a = answer(String(url));
    if (a instanceof Error) throw a;
    return new Response("{}", { status: a });
  }, { sent }) as unknown as typeof fetch & { sent: Sent[] };
}

describe("the telemetry queue", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("keeps at most 2,000 records, dropping the oldest, and reports the drops as one event", async () => {
    const f = fakeFetch(() => 200);
    const q = new TelemetryQueue({ collector: () => undefined, resource, fetch: f });
    for (let i = 0; i < QUEUE.max + 50; i++) q.push(rec(i));
    expect(q.waiting).toBe(QUEUE.max);
    expect(q.dropped).toBe(50);
    expect(q.recent()).toHaveLength(QUEUE.recent);
    // Telemetry off: nothing is sent.
    await q.flush();
    expect(f.sent).toHaveLength(0);
  });

  it("sends each signal to its OTLP path with no redirects, and says when it was sent", async () => {
    const sent: Sent[] = [];
    const q = new TelemetryQueue({ collector: () => "http://127.0.0.1:4318", resource, fetch: fakeFetch(() => 200, sent), now: () => 99 });
    q.push(rec(1));
    await q.flush();
    expect(sent.map((s) => s.url)).toEqual(["http://127.0.0.1:4318/v1/logs"]);
    expect(sent[0]!.redirect).toBe("error");
    expect(q.last).toEqual({ at: 99, ok: true });
    expect(q.waiting).toBe(0);
  });

  it("tries a failing batch three times, then drops it, and never throws", async () => {
    const sent: Sent[] = [];
    const q = new TelemetryQueue({ collector: () => "http://127.0.0.1:4318", resource, fetch: fakeFetch(() => new Error("ECONNREFUSED"), sent) });
    q.push(rec(1));
    await q.flush();
    expect(q.waiting).toBe(1);
    expect(q.last?.ok).toBe(false);
    await q.flush();
    await q.flush();
    expect(q.waiting).toBe(0);
    expect(q.dropped).toBe(1);
    expect(sent).toHaveLength(3);
    // The next flush reports the drop: the collector still fails, so it waits too.
    q.push(rec(2));
    await q.flush();
    const names = sent.at(-1)!.body.resourceLogs[0].scopeLogs[0].logRecords.map((l: any) => l.body.stringValue);
    expect(names).toContain("telemetry.dropped");
  });

  it("flushes as soon as 200 records wait", async () => {
    const sent: Sent[] = [];
    const q = new TelemetryQueue({ collector: () => "http://127.0.0.1:4318", resource, fetch: fakeFetch(() => 200, sent) });
    for (let i = 0; i < QUEUE.batch; i++) q.push(rec(i));
    await q.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(QUEUE.batch);
  });

  it("doesn't follow a collector's redirect (a real server)", async () => {
    let hits = 0;
    const elsewhere = createServer((_q, r) => (hits++, r.end("{}")));
    await new Promise<void>((r) => elsewhere.listen(0, "127.0.0.1", r));
    const to = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
    const collector = createServer((_q, r) => r.writeHead(307, { Location: `${to}/v1/logs` }).end());
    await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
    stop = () => (collector.close(), elsewhere.close());
    const q = new TelemetryQueue({ collector: () => `http://127.0.0.1:${(collector.address() as AddressInfo).port}`, resource });
    q.push(rec(1));
    await q.flush();
    expect(q.last?.ok).toBe(false);
    expect(hits).toBe(0);
  });

  it("drops what waits when telemetry is turned off", () => {
    const q = new TelemetryQueue({ collector: () => undefined, resource });
    q.push(rec(1));
    q.clear();
    expect(q.waiting).toBe(0);
    expect(q.recent()).toEqual([]);
  });
});
