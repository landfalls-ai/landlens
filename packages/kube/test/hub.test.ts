import { describe, expect, it } from "vitest";
import { WatchHub, type ClusterManager } from "../src/clusters.js";
import { KubeClient } from "../src/client.js";

const pods = { kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [{ metadata: { uid: "u1", name: "p1", namespace: "a" } }] };

/** A cluster whose list answers at once and whose watch hangs until aborted. */
function fakeClusters(listStatus = 200) {
  const gone: ((h: string) => void)[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (new URL(url).searchParams.get("watch") !== "1") {
      return new Response(JSON.stringify(listStatus === 200 ? pods : { kind: "Status", code: listStatus, message: "forbidden" }), { status: listStatus });
    }
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }) as unknown as typeof fetch;
  const client = new KubeClient({ url: "http://sidecar", secret: "s" }, fetchImpl);
  const clusters = { get: () => ({ client }), onGone: (fn: (h: string) => void) => gone.push(fn) } as unknown as ClusterManager;
  return { clusters, goneNow: (h: string) => gone.forEach((fn) => fn(h)) };
}

const req = { handle: "handleAAAA1", group: "", version: "v1", resource: "pods" };
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("WatchHub", () => {
  it("replays the current state to a late subscriber only after it has its id", async () => {
    const { clusters } = fakeClusters();
    const hub = new WatchHub(clusters);
    hub.subscribe(req, () => {});
    await tick();
    let id = "";
    const seenWithId: string[] = [];
    id = hub.subscribe(req, (e) => seenWithId.push(`${e.type}:${id}`));
    expect(seenWithId).toEqual([]); // nothing synchronously
    await tick();
    expect(seenWithId).toEqual([`snapshot:${id}`]);
    expect(hub.size).toBe(1);
    await hub.stopAll();
  });

  it("caps open subscriptions", async () => {
    const { clusters } = fakeClusters();
    const hub = new WatchHub(clusters, 2);
    hub.subscribe(req, () => {});
    hub.subscribe({ ...req, namespace: "a" }, () => {});
    expect(() => hub.subscribe(req, () => {})).toThrow(/too many/);
    await hub.stopAll();
  });

  it("starts over after a fatal error instead of keeping a dead watcher", async () => {
    const { clusters } = fakeClusters(403);
    const hub = new WatchHub(clusters);
    const errors: unknown[] = [];
    hub.subscribe(req, (e) => e.type === "error" && errors.push(e));
    await tick();
    expect(errors).toHaveLength(1);
    const again: string[] = [];
    hub.subscribe(req, (e) => again.push(e.type));
    await tick();
    expect(again).toEqual(["error"]); // a fresh watcher tried again and said why
    expect(hub.subscriptions).toBe(1); // the dead watcher's subscriber was dropped
    await hub.stopAll();
  });

  it("stops a cluster's watches when the cluster goes away", async () => {
    const { clusters, goneNow } = fakeClusters();
    const hub = new WatchHub(clusters);
    hub.subscribe(req, () => {});
    await tick();
    goneNow(req.handle);
    expect(hub.size).toBe(0);
    expect(hub.subscriptions).toBe(0);
  });
});
