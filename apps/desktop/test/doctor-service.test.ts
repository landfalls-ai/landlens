import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCTOR, DoctorService } from "../src/main/doctor";

const leaf = readFileSync(join(__dirname, "../../../packages/kube/test/fixtures/doctor/leaf.crt"), "utf8");
const MARKER = "SECRET-KEY-MARKER-55e1";
const b64 = (s: string) => Buffer.from(s).toString("base64");
// The fixture certificate ends 2026-12-01: 11 days after this, so it is "expiring", to watch.
const T0 = Date.parse("2026-11-20T12:00:00Z");

const crashing = {
  metadata: { name: "api-1", namespace: "shop", uid: "u1", creationTimestamp: "2026-11-15T11:00:00Z" },
  spec: { containers: [{ name: "api", image: "shop/api:1" }] },
  status: { phase: "Running", containerStatuses: [{ name: "api", restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { exitCode: 1, reason: "Error", finishedAt: "2026-11-15T11:59:00Z" } } }] },
};

function fake(opts: { forbid?: RegExp; podsError?: number; podsEvent?: any; secretGet?: (p: string) => Promise<any>; log?: (p: string) => Promise<Response> } = {}) {
  let now = T0;
  const paths: string[] = [];
  const subs = new Map<string, any>();
  let n = 0;
  const answer = (path: string): any => {
    paths.push(path);
    if (opts.forbid?.test(path)) throw Object.assign(new Error("forbidden"), { status: 403 });
    if (path.includes("/secrets?")) return { items: [{ metadata: { name: "shop-tls", namespace: "shop", resourceVersion: "7" } }] };
    if (path.includes("/secrets/shop-tls")) return { data: { "tls.crt": b64(leaf), "tls.key": b64(MARKER), other: b64(MARKER) } };
    if (path.includes("/events?")) return { items: [] };
    return { items: [] };
  };
  const client = {
    json: vi.fn(async (p: string) => answer(p)),
    jsonCapped: vi.fn(async (p: string) => (opts.secretGet && p.includes("/secrets/") ? (paths.push(p), opts.secretGet(p)) : answer(p))),
    jsonText: vi.fn(async (p: string) => ({ value: answer(p), bytes: 1 })),
    request: vi.fn(async (p: string) => (paths.push(p), opts.log ? opts.log(p) : new Response("2026-11-15T11:59:00Z FATAL: no DATABASE_URL\n2026-11-15T11:59:00Z bye\n"))),
  };
  let gone: ((h: string) => void) | undefined;
  const clusters: any = {
    get: (h: string) => {
      if (h !== "handle-0001") throw Object.assign(new Error("no such cluster"), { status: 404 });
      return { client };
    },
    onGone: (fn: (h: string) => void) => (gone = fn),
  };
  const hub: any = {
    subscribe: vi.fn((req: any, send: (e: any) => void) => {
      const id = `s${++n}`;
      subs.set(id, req);
      queueMicrotask(() => {
        if (opts.podsEvent) send(opts.podsEvent);
        send(opts.podsError ? { type: "error", status: opts.podsError, message: "pods are forbidden", fatal: true } : { type: "snapshot", items: [crashing] });
      });
      return id;
    }),
    items: (id: string) => (subs.has(id) ? [crashing] : undefined),
    unsubscribe: vi.fn((id: string) => subs.delete(id)),
  };
  const service = new DoctorService({ clusters, hub, now: () => now });
  return { service, hub, client, paths, subs, tick: (ms: number) => (now += ms), gone: (h: string) => gone?.(h), drop: (id: string) => subs.delete(id) };
}

describe("DoctorService", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("diagnoses from the shared pod watch and serves the Overview's health", async () => {
    const f = fake();
    const h = await f.service.health("handle-0001", "shop");
    expect(h.pods.total).toBe(1);
    expect(h.problems.map((p) => `${p.class} ${p.name}`)).toEqual(["crashloop api-1", "cert shop-tls"]);
    expect(h.checks).toEqual({ pods: "ok", workloads: "ok", nodes: "off", events: "ok", certs: "ok" });
    expect(f.hub.subscribe).toHaveBeenCalledWith(expect.objectContaining({ resource: "pods", namespace: "shop" }), expect.any(Function));
    // Within two seconds the held report is returned; no new reads.
    const reads = f.paths.length;
    await f.service.health("handle-0001", "shop");
    expect(f.paths.length).toBe(reads);
    expect(f.hub.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps at most two scopes per cluster and stops one nobody asked about for a minute", async () => {
    const f = fake();
    await f.service.health("handle-0001", "a");
    f.tick(10);
    await f.service.health("handle-0001", "b");
    f.tick(10);
    await f.service.health("handle-0001");
    expect(f.service.size).toBe(2);
    expect(f.hub.unsubscribe).toHaveBeenCalledWith("s1");
    vi.advanceTimersByTime(DOCTOR.idleMs + 1);
    expect(f.service.size).toBe(0);
    expect(f.subs.size).toBe(0);
  });

  it("stops a cluster's scopes when it goes", async () => {
    const f = fake();
    await f.service.health("handle-0001");
    f.gone("handle-0001");
    expect(f.service.size).toBe(0);
  });

  it("says which checks it couldn't make, and fails only without pods", async () => {
    const f = fake({ forbid: /events|secrets|statefulsets/ });
    const h = await f.service.health("handle-0001");
    expect(h.checks).toMatchObject({ pods: "ok", workloads: "forbidden", events: "forbidden", certs: "forbidden", nodes: "ok" });
    await expect(fake({ podsError: 403 }).service.health("handle-0001")).rejects.toMatchObject({ status: 403 });
    await expect(f.service.health("handle-nope")).rejects.toMatchObject({ status: 404 });
  });

  it("reads certificates once per Secret version and passes on only their facts", async () => {
    const f = fake();
    const h = await f.service.health("handle-0001", "shop");
    expect(h.problems.find((p) => p.class === "cert")).toMatchObject({ name: "shop-tls", reason: "Expiring", facts: { cert: { subject: "shop.example.test" } } });
    expect(JSON.stringify(h)).not.toMatch(new RegExp(`${MARKER}|BEGIN`));
    const gets = () => f.paths.filter((p) => p.endsWith("/secrets/shop-tls")).length;
    expect(gets()).toBe(1);
    f.tick(DOCTOR.certsMs + 1);
    await f.service.health("handle-0001", "shop");
    expect(f.paths.filter((p) => p.includes("/secrets?")).length).toBe(2);
    expect(gets()).toBe(1);
    // For the agent: a namespace's own scope, or the all-namespaces one; nothing read → pending, never "no problems";
    // an empty list is no namespaces, not all of them (part 2 review, finding 10).
    expect(f.service.certsFor("handle-0001", ["shop"])).toMatchObject({ state: "ok", certs: [{ name: "shop-tls" }] });
    expect(f.service.certsFor("handle-0001", ["other"])).toEqual({ state: "pending" });
    expect(f.service.certsFor("handle-0001")).toEqual({ state: "pending" });
    expect(f.service.certsFor("handle-0001", [])).toEqual({ state: "ok", certs: [] });
  });

  it("gives evidence only for a problem in the current report", async () => {
    const f = fake();
    await expect(f.service.evidence("handle-0001", "shop", "crashloop|Pod/shop/api-1|api|CrashLoopBackOff")).rejects.toMatchObject({ status: 404 });
    const h = await f.service.health("handle-0001", "shop");
    const e = await f.service.evidence("handle-0001", "shop", h.problems[0]!.id);
    expect(e.log).toEqual({ pod: "api-1", container: "api", previous: true, lines: ["FATAL: no DATABASE_URL", "bye"], cut: false });
    expect(f.paths.at(-1)).toBe("/api/v1/namespaces/shop/pods/api-1/log?container=api&timestamps=true&previous=true&tailLines=200");
    await expect(f.service.evidence("handle-0001", "shop", "crashloop|Pod/shop/other|api|CrashLoopBackOff")).rejects.toMatchObject({ status: 404 });
    await expect(f.service.evidence("handle-0001", "other", h.problems[0]!.id)).rejects.toMatchObject({ status: 404 });
  });

  it("says certificates are still being read rather than none, and that some were left out (review, finding 2)", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const f = fake({ secretGet: async () => (await slow, { data: { "tls.crt": b64(leaf) } }) });
    const first = f.service.health("handle-0001", "shop");
    await vi.advanceTimersByTimeAsync(3_001);
    const h = await first;
    expect(h.checks.certs).toBe("pending");
    expect(h.problems.some((p) => p.class === "cert")).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    f.tick(DOCTOR.diagnoseMs + 1);
    expect((await f.service.health("handle-0001", "shop")).checks.certs).toBe("ok");

    const g = fake({ secretGet: async () => Promise.reject(Object.assign(new Error("Too Many Requests"), { status: 429 })) });
    expect((await g.service.health("handle-0001", "shop")).checks.certs).toBe("partial");
  });

  it("reads a source that failed again after 30 seconds, not its full interval", async () => {
    let fail = true;
    const f = fake({ secretGet: async () => ({ data: { "tls.crt": b64(leaf) } }) });
    const list = f.client.jsonText;
    list.mockImplementation(async (p: string) => {
      f.paths.push(p);
      if (fail) throw Object.assign(new Error("timeout"), { status: 504 });
      return { value: { items: [{ metadata: { name: "shop-tls", namespace: "shop", resourceVersion: "7" } }] }, bytes: 1 };
    });
    expect((await f.service.health("handle-0001", "shop")).checks.certs).toBe("error");
    fail = false;
    f.tick(DOCTOR.retryMs + 1);
    expect((await f.service.health("handle-0001", "shop")).checks.certs).toBe("ok");
  });

  it("answers 503, not an empty cluster, when the watch went away; a passing watch error doesn't fail it (finding 8)", async () => {
    const f = fake({ podsEvent: { type: "error", status: 500, message: "connection reset", fatal: false } });
    const h = await f.service.health("handle-0001", "shop");
    expect(h.pods.total).toBe(1);
    f.drop("s1");
    f.tick(DOCTOR.diagnoseMs + 1);
    await expect(f.service.health("handle-0001", "shop")).rejects.toMatchObject({ status: 503 });
    // The next ask watches again.
    expect((await f.service.health("handle-0001", "shop")).pods.total).toBe(1);
  });

  it("keeps each scope's ids to itself, with two scopes live", async () => {
    const f = fake();
    const a = await f.service.health("handle-0001", "shop");
    await f.service.health("handle-0001");
    expect(f.service.size).toBe(2);
    await expect(f.service.evidence("handle-0001", "other", a.problems[0]!.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.evidence("handle-0001", undefined, "crashloop|Pod/shop/nope|api|CrashLoopBackOff")).rejects.toMatchObject({ status: 404 });
  });

  it("reads one log per problem at a time, four per scope, and says what failed in its own words (finding 6)", async () => {
    let release!: (r: Response) => void;
    const hang = new Promise<Response>((r) => (release = r));
    const f = fake({ log: () => hang });
    const h = await f.service.health("handle-0001", "shop");
    const id = h.problems[0]!.id;
    const one = f.service.evidence("handle-0001", "shop", id);
    const two = f.service.evidence("handle-0001", "shop", id);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    release(new Response("<html>proxy said: token=abc</html>", { status: 502 }));
    expect(await one).toEqual({ log: { error: "Couldn't read the log (HTTP 502)." } });
    expect(await two).toEqual(await one);
    expect(JSON.stringify(await one)).not.toMatch(/token|proxy/);

    const g = fake({ log: async () => new Response("pods \"api-1\" is forbidden: User \"x\"", { status: 403 }) });
    const hg = await g.service.health("handle-0001", "shop");
    expect(await g.service.evidence("handle-0001", "shop", hg.problems[0]!.id)).toEqual({ log: { error: "You can't read this pod's logs." } });
  });

  it("stops reading Secrets once its scope stops (finding 7)", async () => {
    let calls = 0;
    let stop = () => {};
    const f = fake({
      secretGet: async () => {
        // The cluster goes after the first four reads have started.
        if (++calls === 4) stop();
        await Promise.resolve();
        return { data: { "tls.crt": b64(leaf) } };
      },
    });
    stop = () => f.gone("handle-0001");
    f.client.jsonText.mockImplementation(async () => ({
      value: { items: Array.from({ length: 40 }, (_, i) => ({ metadata: { name: `tls-${i}`, namespace: "shop", resourceVersion: "1" } })) }, bytes: 1,
    }));
    await f.service.health("handle-0001", "shop").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(calls).toBe(4);
  });
});
