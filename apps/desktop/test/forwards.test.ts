// Port-forwards in main (wave 4, part 3): each pod gets a token for its one port, labelled as you; a Service's or a
// controller's pod is replaced when it goes; a busy port says so with a free one; kept forwards are saved without
// tokens and start again on reconnect; forwards end with their cluster.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection as connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
import type { ForwardInfo } from "@landlens/contracts";
import { ForwardService, MAX_CONNECTIONS, MAX_FORWARDS, replacementLabels } from "../src/main/forwards";

const pod = (name: string, o: { ready?: boolean; created?: string; owner?: boolean; app?: string; rs?: string } = {}) => ({
  apiVersion: "v1", kind: "Pod",
  metadata: {
    name, namespace: "shop", uid: name, creationTimestamp: o.created ?? "2026-11-15T00:00:00Z",
    labels: { app: o.app ?? (o.owner === false ? "bare" : "web"), "pod-template-hash": "abc" },
    ...(o.owner === false ? {} : { ownerReferences: [{ kind: "ReplicaSet", name: o.rs ?? "web-abc", controller: true }] }),
  },
  spec: { containers: [{ name: "app", ports: [{ name: "http", containerPort: 8080 }] }] },
  status: { phase: "Running", conditions: [{ type: "Ready", status: o.ready === false ? "False" : "True" }] },
});
const svc = { metadata: { name: "web", namespace: "shop" }, spec: { selector: { app: "web" }, ports: [{ port: 80, targetPort: "http", name: "http" }] } };

function harness(dir = mkdtempSync(join(tmpdir(), "landlens-fw-"))) {
  const objects = new Map<string, unknown>([
    ["/api/v1/namespaces/shop/services/web", svc],
    ["/api/v1/namespaces/shop/pods/web-1", pod("web-1", { created: "2026-11-15T00:00:00Z" })],
    ["/api/v1/namespaces/shop/pods/web-2", pod("web-2", { created: "2026-11-15T01:00:00Z" })],
    ["/api/v1/namespaces/shop/pods/bare", pod("bare", { owner: false })],
  ]);
  /** Reads of these paths wait until the promise settles. */
  const holds = new Map<string, Promise<unknown>>();
  const json = vi.fn(async (path: string) => {
    for (const [k, p] of holds) if (path.startsWith(k)) await p;
    if (path.startsWith("/api/v1/namespaces/shop/pods?")) {
      const sel = Object.fromEntries(decodeURIComponent(path.split("labelSelector=")[1] ?? "").split(",").map((kv) => kv.split("=")));
      const items = [...objects].filter(([k]) => k.startsWith("/api/v1/namespaces/shop/pods/")).map(([, v]) => v as ReturnType<typeof pod>);
      return { items: items.filter((p) => Object.entries(sel).every(([k, v]) => (p.metadata.labels as Record<string, string>)[k] === v)) };
    }
    const o = objects.get(path);
    if (!o) throw Object.assign(new Error("not found"), { status: 404 });
    return o;
  });
  const gone: ((h: string) => void)[] = [];
  let connected = true;
  const clusters = {
    get: (handle: string) => {
      if (!connected || handle !== "h1") throw Object.assign(new Error("cluster is not connected"), { status: 404 });
      return { info: { handle: "h1", context: "orbstack", server: "s", version: "v" }, client: { json } };
    },
    onGone: (fn: (h: string) => void) => gone.push(fn),
  };
  let n = 0;
  const issued: { token: string; label: string; policy: unknown }[] = [];
  const revoked: string[] = [];
  const frontDoor = {
    issueToken: vi.fn((g: { label: string; policy: unknown }) => {
      const token = String(++n % 10).repeat(64);
      issued.push({ token, label: g.label, policy: g.policy });
      return token;
    }),
    revokeToken: vi.fn((t: string) => void revoked.push(t)),
    clusterUrl: () => "https://127.0.0.1:1/c/h1",
    certificate: "",
  };
  const pushed: ForwardInfo[][] = [];
  const opened: string[] = [];
  const file = join(dir, "forwards.json");
  const make = (more: { clusterUrl?: string } = {}) => new ForwardService({ clusters: clusters as never, frontDoor: (more.clusterUrl ? { ...frontDoor, clusterUrl: () => more.clusterUrl } : frontDoor) as never, file, push: (l) => pushed.push(l), openExternal: (u) => opened.push(u), checkMs: 20 });
  return { objects, holds, json, frontDoor, issued, revoked, pushed, opened, file, dir, make, goneNow: () => ((connected = false), gone.forEach((g) => g("h1"))), dropSilently: () => (connected = false), reconnect: () => (connected = true) };
}

const free = () => new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const state = (f: ForwardService, id: string) => f.list().find((x) => x.id === id);

describe("port-forwards in main", () => {
  it("forwards a Service through its oldest ready pod with a token for that pod's one port, and moves when the pod goes", async () => {
    const h = harness();
    const f = h.make();
    const localPort = await free();
    const fw = await f.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort, keep: false });
    await expect.poll(() => state(f, fw.id)?.state).toBe("running");
    expect(state(f, fw.id)).toMatchObject({ pod: "web-1", podPort: 8080, scheme: "http", localPort });
    expect(h.issued).toEqual([{ token: expect.any(String), label: "you · orbstack · forward shop/web-1:8080", policy: { access: "forward", pod: { namespace: "shop", name: "web-1" }, port: 8080 } }]);

    // web-1 goes: the forward moves to web-2, and web-1's token is revoked. The window hears of it, though the state
    // stays Running.
    const heard = () => h.pushed.at(-1)?.find((x) => x.id === fw.id)?.pod;
    await expect.poll(heard).toBe("web-1");
    h.objects.delete("/api/v1/namespaces/shop/pods/web-1");
    await expect.poll(() => state(f, fw.id)?.pod).toBe("web-2");
    await expect.poll(heard).toBe("web-2");
    expect(h.revoked).toContain(h.issued[0]!.token);
    expect(h.issued[1]!.label).toBe("you · orbstack · forward shop/web-2:8080");

    // No ready pod: reconnecting, with no token.
    h.objects.delete("/api/v1/namespaces/shop/pods/web-2");
    await expect.poll(() => state(f, fw.id)?.state).toBe("reconnecting");
    expect(state(f, fw.id)).toMatchObject({ message: "No ready pod behind web yet." });
    expect(h.revoked).toContain(h.issued[1]!.token);

    f.stop(fw.id);
    expect(state(f, fw.id)?.state).toBe("stopped");
    expect(await free()).toBeGreaterThan(0);
    f.remove(fw.id);
    expect(f.list()).toEqual([]);

    // Removing a running forward revokes its token and frees its port.
    const again = await f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "bare", port: 8080, localPort, keep: false });
    await expect.poll(() => state(f, again.id)?.state).toBe("running");
    f.remove(again.id);
    expect(h.revoked).toContain(h.issued.at(-1)!.token);
    expect(await f.check(localPort)).toEqual({ free: true });
  });

  it("fails a bare pod's forward when the pod goes, and opens only its own address", async () => {
    const h = harness();
    const f = h.make();
    const fw = await f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "bare", port: 8080, localPort: await free(), keep: false });
    await expect.poll(() => state(f, fw.id)?.state).toBe("running");
    f.open(fw.id);
    expect(h.opened).toEqual([`http://127.0.0.1:${fw.localPort}/`]);
    h.objects.delete("/api/v1/namespaces/shop/pods/bare");
    await expect.poll(() => state(f, fw.id)?.state).toBe("failed");
    expect(state(f, fw.id)?.message).toBe("bare is gone or not running.");
    expect(() => f.open("fwnosuchforward0")).toThrow(/no such forward/);
    f.stopAll();
  });

  it("says a port is taken and offers a free one", async () => {
    const h = harness();
    const f = h.make();
    const busy: Server = await new Promise((r) => {
      const s = createServer().listen(0, "127.0.0.1", () => r(s));
    });
    const port = (busy.address() as { port: number }).port;
    await expect(f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "web-1", port: 8080, localPort: port, keep: false })).rejects.toMatchObject({ status: 409, next: expect.any(Number) });
    expect(await f.check(port)).toMatchObject({ free: false, next: expect.any(Number) });
    busy.close();
    expect(f.list()).toEqual([]);
    expect(h.issued).toEqual([]);
  });

  it("refuses a Service port that doesn't exist, and a Service without a selector", async () => {
    const h = harness();
    h.objects.set("/api/v1/namespaces/shop/services/headless", { metadata: { name: "headless" }, spec: { ports: [{ port: 80 }] } });
    const f = h.make();
    await expect(f.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 81, localPort: await free(), keep: false })).rejects.toThrow("web has no TCP port 81");
    await expect(f.start({ handle: "h1", namespace: "shop", kind: "service", name: "headless", port: 80, localPort: await free(), keep: false })).rejects.toThrow(/no selector/);
  });

  it("saves kept forwards without tokens, starts them again on reconnect, and not the ones you stopped", async () => {
    const h = harness();
    const f = h.make();
    const a = await f.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: true });
    const b = await f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "web-2", port: 8080, localPort: await free(), keep: true });
    const c = await f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "web-1", port: 8080, localPort: await free(), keep: false });
    await expect.poll(() => f.list().every((x) => x.state === "running")).toBe(true);
    f.stop(b.id);
    const saved = readFileSync(h.file, "utf8");
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
    expect(saved).not.toMatch(/[0-9]{64}|token/);
    expect(JSON.parse(saved).forwards).toEqual([
      expect.objectContaining({ id: a.id, kind: "service", name: "web", port: 80 }),
      expect.objectContaining({ id: b.id, kind: "pod", name: "web-2", labels: { app: "web" }, stopped: true }),
    ]);

    // The cluster goes: everything stops; the kept ones stay listed.
    h.goneNow();
    expect(f.list().map((x) => [x.id, x.state])).toEqual([[a.id, "stopped"], [b.id, "stopped"]]);
    expect(f.list().find((x) => x.id === c.id)).toBeUndefined();
    f.stopAll();

    // A new start of Landlens: the kept forwards load, and reconnecting starts the one you didn't stop.
    const again = h.make();
    h.reconnect();
    again.restore({ handle: "h1", context: "orbstack", server: "s", version: "v" });
    await expect.poll(() => state(again, a.id)?.state).toBe("running");
    expect(state(again, b.id)?.state).toBe("stopped");
    const resumed = await again.resume(b.id, "h1");
    expect(resumed.state).toBe("starting");
    await expect.poll(() => state(again, b.id)?.state).toBe("running");
    again.stopAll();
  });

  it("finds a controller's pod's replacement by its stable labels", () => {
    expect(replacementLabels(pod("x") as never)).toEqual({ app: "web" });
    expect(replacementLabels(pod("x", { owner: false }) as never)).toBeUndefined();
  });

  // --- The security review of part 3 ---

  it("doesn't run a forward that was removed or stopped while it started, or whose cluster went (finding 3)", async () => {
    const h = harness();
    const f = h.make();
    const kept = await f.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: true });
    const port = kept.localPort;
    f.stop(kept.id);
    f.stopAll();
    // A new start of Landlens, kept forward not stopped: restore, then remove in the same turn.
    const saved = JSON.parse(readFileSync(h.file, "utf8"));
    delete saved.forwards[0].stopped;
    writeFileSync(h.file, JSON.stringify(saved));
    const issuedBefore = h.issued.length;
    const a = h.make();
    a.restore({ handle: "h1", context: "orbstack", server: "s", version: "v" });
    a.remove(kept.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(a.list()).toEqual([]);
    expect(h.issued.length).toBe(issuedBefore);
    expect(await f.check(port)).toEqual({ free: true });

    // Restore, then stop: stopped, no token, the port free.
    writeFileSync(h.file, JSON.stringify(saved));
    const b = h.make();
    b.restore({ handle: "h1", context: "orbstack", server: "s", version: "v" });
    b.stop(kept.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(state(b, kept.id)?.state).toBe("stopped");
    expect(h.issued.length).toBe(issuedBefore);
    expect(await f.check(port)).toEqual({ free: true });

    // The cluster goes while start reads the Service: the start fails and nothing is left.
    let release!: () => void;
    h.holds.set("/api/v1/namespaces/shop/services/web", new Promise<void>((r) => (release = r)));
    const c = h.make();
    const starting = c.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: false });
    await new Promise((r) => setTimeout(r, 20));
    h.goneNow();
    release();
    await expect(starting).rejects.toThrow(/not connected/);
    expect(c.list().map((x) => [x.id, x.state])).toEqual([[kept.id, "stopped"]]);
    expect(h.issued.length).toBe(issuedBefore);
    h.holds.clear();
    h.reconnect();

    // The cluster went without a word: the next check stops it and drops a forward that isn't kept.
    const d = h.make();
    const fw = await d.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: false });
    await expect.poll(() => state(d, fw.id)?.state).toBe("running");
    h.dropSilently();
    await expect.poll(() => d.list().map((x) => x.id)).toEqual([kept.id]);
    expect(h.revoked).toContain(h.issued.at(-1)!.token);
    expect(await f.check(fw.localPort)).toEqual({ free: true });
  });

  it("holds the cap after the reads, counts it per cluster, and checks one at a time (finding 4)", async () => {
    const h = harness();
    const f = h.make();
    const ports = await Promise.all(Array.from({ length: MAX_FORWARDS + 5 }, () => free()));
    const all = await Promise.allSettled(ports.map((localPort) => f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "web-1", port: 8080, localPort, keep: false })));
    expect(all.filter((x) => x.status === "fulfilled")).toHaveLength(MAX_FORWARDS);
    expect(f.list()).toHaveLength(MAX_FORWARDS);
    expect((all.find((x) => x.status === "rejected") as PromiseRejectedResult).reason.message).toBe(`at most ${MAX_FORWARDS} forwards for one cluster`);
    f.stopAll();

    // A check whose read hangs: the ticks (every 20 ms) don't start more.
    const g = harness();
    const s = g.make();
    const fw = await s.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: false });
    await expect.poll(() => state(s, fw.id)?.state).toBe("running");
    g.holds.set("/api/v1/namespaces/shop/services/web", new Promise(() => {}));
    const before = g.json.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(g.json.mock.calls.length - before).toBeLessThanOrEqual(1);
    s.stopAll();
  });

  it("refuses connections past the per-forward cap and says so (finding 4)", async () => {
    // A front door that accepts and never answers: each connection stays open, waiting for its upgrade.
    const sink = createServer((c) => c.on("error", () => {}));
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const h = harness();
    const f = h.make({ clusterUrl: `https://127.0.0.1:${(sink.address() as { port: number }).port}/c/h1` });
    const fw = await f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "bare", port: 8080, localPort: await free(), keep: false });
    await expect.poll(() => state(f, fw.id)?.state).toBe("running");
    const socks = await Promise.all(Array.from({ length: MAX_CONNECTIONS + 6 }, () => new Promise<Socket>((r) => {
      const c = connect({ port: fw.localPort, host: "127.0.0.1" }, () => r(c));
      c.on("error", () => {});
    })));
    await expect.poll(() => state(f, fw.id)?.lastError).toMatch(/Too many connections at once/);
    expect(state(f, fw.id)?.connections).toBe(MAX_CONNECTIONS);
    for (const c of socks) c.destroy();
    f.stopAll();
    sink.close();
  });

  it("follows only what the forward is for (finding 6)", async () => {
    const h = harness();
    // An older pod with the same labels, not under web's controller.
    h.objects.set("/api/v1/namespaces/shop/pods/canary-9", { ...pod("canary-9", { created: "2026-11-14T00:00:00Z", rs: "canary-1" }) });
    h.objects.set("/apis/apps/v1/namespaces/shop/replicasets/web-abc", { metadata: { name: "web-abc", ownerReferences: [{ kind: "Deployment", name: "web", controller: true }] } });
    h.objects.set("/apis/apps/v1/namespaces/shop/replicasets/web-def", { metadata: { name: "web-def", ownerReferences: [{ kind: "Deployment", name: "web", controller: true }] } });
    const f = h.make();
    const fw = await f.start({ handle: "h1", namespace: "shop", kind: "pod", name: "web-1", port: 8080, localPort: await free(), keep: true });
    await expect.poll(() => state(f, fw.id)?.state).toBe("running");
    expect(JSON.parse(readFileSync(h.file, "utf8")).forwards[0].owner).toEqual({ kind: "Deployment", name: "web" });
    // web-1 and web-2 go; a rollout's new ReplicaSet brings web-3. canary-9 is older and ready, but not web's.
    h.objects.delete("/api/v1/namespaces/shop/pods/web-1");
    h.objects.delete("/api/v1/namespaces/shop/pods/web-2");
    await expect.poll(() => state(f, fw.id)?.state).toBe("reconnecting");
    expect(h.issued.some((i) => i.label.includes("canary-9"))).toBe(false);
    h.objects.set("/api/v1/namespaces/shop/pods/web-3", pod("web-3", { rs: "web-def" }));
    await expect.poll(() => state(f, fw.id)?.pod).toBe("web-3");
    f.stopAll();

    // A Service's selector emptied: no forward to every pod in the namespace.
    const g = harness();
    const s = g.make();
    const sv = await s.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: false });
    await expect.poll(() => state(s, sv.id)?.pod).toBe("web-1");
    g.objects.set("/api/v1/namespaces/shop/services/web", { ...svc, spec: { ...svc.spec, selector: {} } });
    await expect.poll(() => state(s, sv.id)?.state).toBe("reconnecting");
    expect(state(s, sv.id)?.pod).toBeUndefined();
    expect(g.json.mock.calls.some(([p]) => p.endsWith("labelSelector="))).toBe(false);
    // Its selector changes to other pods: it moves; the Service goes: it stops forwarding.
    g.objects.set("/api/v1/namespaces/shop/services/web", { ...svc, spec: { ...svc.spec, selector: { app: "bare" } } });
    await expect.poll(() => state(s, sv.id)?.pod).toBe("bare");
    g.objects.delete("/api/v1/namespaces/shop/services/web");
    await expect.poll(() => state(s, sv.id)?.pod).toBeUndefined();
    expect(state(s, sv.id)).toMatchObject({ state: "reconnecting", message: "Service web is gone." });
    s.stopAll();
  });

  it("trusts forwards.json no more than the window (finding 7)", async () => {
    const h = harness();
    const ok = { id: "fwAAAAAAAAAA", context: "orbstack", server: "s", namespace: "shop", kind: "pod", name: "web-1", port: 8080, localPort: 18080 };
    writeFileSync(h.file, JSON.stringify({ version: 2, forwards: [
      ok,
      { ...ok, id: "fwBBBBBBBBBB", name: "x/../../kube-system/services/kube-dns:53/proxy/any?a=b#" },
      { ...ok, id: "fwCCCCCCCCCC", namespace: "Shop" },
      { ...ok, id: "fwDDDDDDDDDD", labels: { "app,tier!": "web" } },
      { ...ok, id: "fwEEEEEEEEEE", extra: true },
      { ...ok, id: "fwFFFFFFFFFF", localPort: 22 },
    ] }));
    expect(h.make().list().map((x) => x.id)).toEqual(["fwAAAAAAAAAA"]);
    writeFileSync(h.file, JSON.stringify({ version: 9, forwards: [ok] }));
    expect(h.make().list()).toEqual([]);
  });

  it("starts a kept forward only on the cluster it was made on (finding 8)", async () => {
    const h = harness();
    h.objects.set("/api/v1/namespaces/kube-system", { metadata: { name: "kube-system", uid: "aaaa-1111" } });
    const f = h.make();
    const fw = await f.start({ handle: "h1", namespace: "shop", kind: "service", name: "web", port: 80, localPort: await free(), keep: true });
    await expect.poll(() => state(f, fw.id)?.state).toBe("running");
    expect(JSON.parse(readFileSync(h.file, "utf8")).forwards[0]).toMatchObject({ server: "s", cluster: "aaaa-1111" });
    f.stopAll();
    const issued = h.issued.length;

    // The context now names another API server.
    const a = h.make();
    a.restore({ handle: "h1", context: "orbstack", server: "https://elsewhere:6443", version: "v" });
    await expect.poll(() => state(a, fw.id)?.message).toMatch(/another cluster/);
    expect(state(a, fw.id)?.state).toBe("stopped");

    // The same URL, but another cluster behind it: kube-system's uid differs.
    h.objects.set("/api/v1/namespaces/kube-system", { metadata: { name: "kube-system", uid: "bbbb-2222" } });
    const b = h.make();
    b.restore({ handle: "h1", context: "orbstack", server: "s", version: "v" });
    await expect.poll(() => state(b, fw.id)?.message).toMatch(/another cluster/);
    await expect(b.resume(fw.id, "h1")).rejects.toThrow(/another cluster/);
    expect(h.issued.length).toBe(issued);

    // Back to the cluster it was made on: it starts.
    h.objects.set("/api/v1/namespaces/kube-system", { metadata: { name: "kube-system", uid: "aaaa-1111" } });
    const c = h.make();
    c.restore({ handle: "h1", context: "orbstack", server: "s", version: "v" });
    await expect.poll(() => state(c, fw.id)?.state).toBe("running");
    expect(h.opened).toEqual([]);
    c.stopAll();
    expect(h.revoked).toContain(h.issued.at(-1)!.token);
  });
});
