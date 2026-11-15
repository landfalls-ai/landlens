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

function fake(opts: { forbid?: RegExp; podsError?: number } = {}) {
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
    jsonCapped: vi.fn(async (p: string) => answer(p)),
    jsonText: vi.fn(async (p: string) => ({ value: answer(p), bytes: 1 })),
    request: vi.fn(async (p: string) => (paths.push(p), new Response("2026-11-15T11:59:00Z FATAL: no DATABASE_URL\n2026-11-15T11:59:00Z bye\n"))),
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
      queueMicrotask(() => send(opts.podsError ? { type: "error", status: opts.podsError, message: "pods are forbidden" } : { type: "snapshot", items: [crashing] }));
      return id;
    }),
    items: (id: string) => (subs.has(id) ? [crashing] : undefined),
    unsubscribe: vi.fn((id: string) => subs.delete(id)),
  };
  const service = new DoctorService({ clusters, hub, now: () => now });
  return { service, hub, client, paths, subs, tick: (ms: number) => (now += ms), gone: (h: string) => gone?.(h) };
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
    // For the agent: a namespace's own scope, or the all-namespaces one; none read → undefined, never "no problems".
    expect(f.service.certsFor("handle-0001", ["shop"])?.map((c) => c.name)).toEqual(["shop-tls"]);
    expect(f.service.certsFor("handle-0001", ["other"])).toBeUndefined();
    expect(f.service.certsFor("handle-0001")).toBeUndefined();
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
});
