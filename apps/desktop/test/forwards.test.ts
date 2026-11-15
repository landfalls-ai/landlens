// Port-forwards in main (wave 4, part 3): each pod gets a token for its one port, labelled as you; a Service's or a
// controller's pod is replaced when it goes; a busy port says so with a free one; kept forwards are saved without
// tokens and start again on reconnect; forwards end with their cluster.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
import type { ForwardInfo } from "@landlens/contracts";
import { ForwardService, replacementLabels } from "../src/main/forwards";

const pod = (name: string, o: { ready?: boolean; created?: string; owner?: boolean } = {}) => ({
  apiVersion: "v1", kind: "Pod",
  metadata: {
    name, namespace: "shop", uid: name, creationTimestamp: o.created ?? "2026-11-15T00:00:00Z",
    labels: { app: o.owner === false ? "bare" : "web", "pod-template-hash": "abc" },
    ...(o.owner === false ? {} : { ownerReferences: [{ kind: "ReplicaSet", name: "web-abc", controller: true }] }),
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
  const json = vi.fn(async (path: string) => {
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
  const make = () => new ForwardService({ clusters: clusters as never, frontDoor: frontDoor as never, file, push: (l) => pushed.push(l), openExternal: (u) => opened.push(u), checkMs: 20 });
  return { objects, issued, revoked, pushed, opened, file, dir, make, goneNow: () => ((connected = false), gone.forEach((g) => g("h1"))), reconnect: () => (connected = true) };
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

    // web-1 goes: the forward moves to web-2, and web-1's token is revoked.
    h.objects.delete("/api/v1/namespaces/shop/pods/web-1");
    await expect.poll(() => state(f, fw.id)?.pod).toBe("web-2");
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
});
