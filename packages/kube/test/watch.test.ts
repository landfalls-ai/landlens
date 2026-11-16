import { describe, expect, it } from "vitest";
import { KubeClient } from "../src/client.js";
import { ResourceWatcher, WatchBudget, type WatcherEvent } from "../src/watch.js";

const pod = (uid: string, rv: string, name = uid) => ({ metadata: { uid, name, namespace: "a", resourceVersion: rv, managedFields: [{}] } });

/** A scripted API server: each call to fetch takes the next response for the matching kind of request. */
function scripted(script: { list: Response[]; watch: (() => Response)[] }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const isWatch = new URL(url).searchParams.get("watch") === "1";
    const next = isWatch ? script.watch.shift()?.() : script.list.shift();
    if (next) return next;
    // Nothing scripted: hang like an idle watch until aborted.
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }) as unknown as typeof fetch;
  return { client: new KubeClient({ url: "http://sidecar", secret: "s" }, fetchImpl), calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stream = (...events: unknown[]) =>
  new Response(new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"));
      c.close();
    },
  }));

function collect(w: (on: (e: WatcherEvent) => void) => ResourceWatcher, until: (events: WatcherEvent[]) => boolean) {
  const events: WatcherEvent[] = [];
  return new Promise<{ events: WatcherEvent[]; watcher: ResourceWatcher }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(events.map((e) => e.type))}`)), 3000);
    const watcher = w((e) => {
      events.push(e);
      if (until(events)) {
        clearTimeout(t);
        resolve({ events, watcher });
      }
    }).start();
  });
}

describe("ResourceWatcher", () => {
  it("lists every page, then applies watch events in one batch", async () => {
    const { client, calls } = scripted({
      list: [
        json({ kind: "PodList", apiVersion: "v1", metadata: { continue: "c1", resourceVersion: "10" }, items: [pod("u1", "1")] }),
        json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "11" }, items: [pod("u2", "2")] }),
      ],
      watch: [() => stream(
        { type: "ADDED", object: pod("u3", "12") },
        { type: "MODIFIED", object: pod("u1", "13") },
        { type: "DELETED", object: pod("u2", "14") },
        { type: "BOOKMARK", object: { metadata: { resourceVersion: "20" } } },
      )],
    });
    const { events, watcher } = await collect(
      (on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods", namespace: "a" }, on, { batchMs: 10 }),
      (ev) => ev.some((e) => e.type === "delta"),
    );
    await watcher.stop();

    const snap = events[0]!;
    expect(snap.type).toBe("snapshot");
    if (snap.type !== "snapshot") return;
    expect(snap.items.map((o) => o.metadata.uid)).toEqual(["u1", "u2"]);
    expect(snap.items[0]).toMatchObject({ kind: "Pod", apiVersion: "v1" });
    expect(snap.items[0]!.metadata).not.toHaveProperty("managedFields");

    const delta = events.find((e) => e.type === "delta")!;
    expect(delta).toMatchObject({ type: "delta", removed: ["u2"] });
    if (delta.type === "delta") expect(delta.upserted.map((o) => o.metadata.uid).sort()).toEqual(["u1", "u3"]);
    expect(watcher.snapshot().map((o) => o.metadata.uid).sort()).toEqual(["u1", "u3"]);

    expect(calls[0]).toBe("http://sidecar/api/v1/namespaces/a/pods?limit=500");
    expect(calls[1]).toContain("continue=c1");
    const w = new URL(calls[2]!);
    expect(Object.fromEntries(w.searchParams)).toMatchObject({ watch: "1", resourceVersion: "11", allowWatchBookmarks: "true" });
    // The next watch resumes from the bookmark.
    await new Promise((r) => setTimeout(r, 20));
    expect(new URL(calls[3]!).searchParams.get("resourceVersion")).toBe("20");
  });

  it("relists when the watch says 410 Gone", async () => {
    const { client } = scripted({
      list: [
        json({ kind: "PodList", metadata: { resourceVersion: "5" }, items: [pod("u1", "1")] }),
        json({ kind: "PodList", metadata: { resourceVersion: "50" }, items: [pod("u9", "9")] }),
      ],
      watch: [() => stream({ type: "ERROR", object: { kind: "Status", code: 410, message: "too old" } })],
    });
    const { events, watcher } = await collect(
      (on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, on, { batchMs: 5 }),
      (ev) => ev.filter((e) => e.type === "snapshot").length === 2,
    );
    await watcher.stop();
    const last = events.at(-1)!;
    expect(last.type === "snapshot" && last.items.map((o) => o.metadata.uid)).toEqual(["u9"]);
  });

  it("stops for good on 403 and says why", async () => {
    const { client, calls } = scripted({
      list: [json({ kind: "Status", code: 403, message: 'pods is forbidden: User "x" cannot list' }, 403)],
      watch: [],
    });
    const { events, watcher } = await collect(
      (on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, on),
      (ev) => ev.some((e) => e.type === "error"),
    );
    await watcher.done;
    expect(events[0]).toMatchObject({ type: "error", status: 403, fatal: true, message: expect.stringContaining("forbidden") });
    expect(calls).toHaveLength(1);
  });

  it("backs off when the server keeps answering 410, and stop() ends the wait at once", async () => {
    const list = () => json({ kind: "PodList", metadata: { resourceVersion: "5" }, items: [pod("u1", "1")] });
    const gone = () => stream({ type: "ERROR", object: { kind: "Status", code: 410, message: "too old" } });
    const { client } = scripted({ list: [list(), list(), list(), list()], watch: [gone, gone, gone, gone] });
    const events: WatcherEvent[] = [];
    const watcher = new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, (e) => events.push(e), {
      backoffMs: 10_000,
    }).start();
    await new Promise((r) => setTimeout(r, 300));
    // One relist at once, then a 10 s backoff rather than a third list.
    expect(events.filter((e) => e.type === "snapshot")).toHaveLength(2);
    const t0 = Date.now();
    await watcher.stop();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("ResourceWatcher's selectors and cap (wave 10)", () => {
  it("sends label and field selectors on the list and the watch", async () => {
    const { client, calls } = scripted({ list: [json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [] })], watch: [] });
    const target = { group: "", version: "v1", resource: "pods", namespace: "a", labelSelector: "app=api,tier!=db", fieldSelector: "status.phase=Running" };
    const { watcher } = await collect((on) => new ResourceWatcher(client, target, on, { batchMs: 10 }), (e) => e.some((x) => x.type === "snapshot"));
    await new Promise((r) => setTimeout(r, 20));
    await watcher.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      const q = new URL(c).searchParams;
      expect(q.get("labelSelector")).toBe("app=api,tier!=db");
      expect(q.get("fieldSelector")).toBe("status.phase=Running");
    }
  });

  it("keeps at most maxItems: stops paging, drops watch adds, says it is truncated", async () => {
    const { client, calls } = scripted({
      list: [
        json({ kind: "PodList", apiVersion: "v1", metadata: { continue: "c1", resourceVersion: "10" }, items: [pod("u1", "1"), pod("u2", "2")] }),
        json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "10" }, items: [pod("u3", "3")] }),
      ],
      watch: [() => stream({ type: "ADDED", object: pod("u4", "11") }, { type: "MODIFIED", object: pod("u1", "12") })],
    });
    const { watcher } = await collect(
      (on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods", namespace: "a" }, on, { batchMs: 10, maxItems: 2 }),
      (e) => e.some((x) => x.type === "delta"),
    );
    await watcher.stop();
    expect(calls.filter((c) => new URL(c).searchParams.get("watch") !== "1")).toHaveLength(1); // the second page wasn't asked
    expect(watcher.snapshot().map((o) => o.metadata.uid).sort()).toEqual(["u1", "u2"]);
    expect(watcher.snapshot().find((o) => o.metadata.uid === "u1")!.metadata.resourceVersion).toBe("12");
    expect(watcher.truncated).toBe(true);
  });

  it("cuts a single page that holds more than maxItems", async () => {
    const { client } = scripted({ list: [json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [pod("u1", "1"), pod("u2", "2"), pod("u3", "3")] })], watch: [] });
    const { watcher } = await collect((on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, on, { maxItems: 2 }), (e) => e.some((x) => x.type === "snapshot"));
    await watcher.stop();
    expect(watcher.snapshot()).toHaveLength(2);
    expect(watcher.truncated).toBe(true);
  });

  it("is not truncated when everything fits, and refuses a cap that isn't a positive integer", async () => {
    const { client } = scripted({ list: [json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [pod("u1", "1"), pod("u2", "2")] })], watch: [] });
    const { watcher } = await collect((on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, on, { maxItems: 2 }), (e) => e.some((x) => x.type === "snapshot"));
    await watcher.stop();
    expect(watcher.truncated).toBe(false);
    for (const maxItems of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, () => {}, { maxItems })).toThrow(RangeError);
    }
  });

  // Security review of wave 10 part 1, M5: a view's watches keep objects trimmed, within one budget for all of them.
  it("trims each object with `project`, and several watchers keep at most their shared budget", async () => {
    const big = (uid: string) => ({ ...pod(uid, "1"), data: { blob: "x".repeat(1000) } });
    const list = () => json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [big("a1"), big("a2"), big("a3")] });
    const budget = new WatchBudget(4, 1_000_000);
    const project = (o: any) => ({ metadata: { uid: o.metadata.uid, name: o.metadata.name } }) as never;
    const one = scripted({ list: [list()], watch: [] });
    const w1 = (await collect((on) => new ResourceWatcher(one.client, { group: "", version: "v1", resource: "pods" }, on, { project, budget }), (e) => e.some((x) => x.type === "snapshot"))).watcher;
    expect(w1.snapshot()).toHaveLength(3);
    expect(Object.keys(w1.snapshot()[0]!)).toEqual(["metadata"]); // no data, no kind: only what project kept
    expect(budget.objects).toBe(3);
    const two = scripted({ list: [list()], watch: [() => stream({ type: "ADDED", object: big("a9") })] });
    const w2 = (await collect((on) => new ResourceWatcher(two.client, { group: "", version: "v1", resource: "pods" }, on, { project, budget, batchMs: 10 }), (e) => e.some((x) => x.type === "snapshot"))).watcher;
    expect(w2.snapshot()).toHaveLength(1);
    expect(w2.cutBy).toBe("budget");
    expect(w1.truncated).toBe(false);
    expect(budget.objects).toBe(4);
    await w1.stop();
    expect(budget.objects).toBe(1); // a stopped watcher gives its share back
    await w2.stop();
    expect(budget).toMatchObject({ objects: 0, chars: 0 });
  });

  it("counts characters too: an object that grows past the budget is dropped and said", async () => {
    const budget = new WatchBudget(100, 400);
    const sized = (uid: string, n: number, rv: string) => ({ ...pod(uid, rv), data: "y".repeat(n) });
    const { client } = scripted({
      list: [json({ kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [sized("b1", 50, "1"), sized("b2", 50, "2")] })],
      watch: [() => stream({ type: "MODIFIED", object: sized("b1", 500, "3") })],
    });
    const { watcher } = await collect((on) => new ResourceWatcher(client, { group: "", version: "v1", resource: "pods" }, on, { budget, batchMs: 10 }), (e) => e.some((x) => x.type === "delta"));
    expect(watcher.snapshot().map((o) => o.metadata.uid)).toEqual(["b2"]);
    expect(watcher.cutBy).toBe("budget");
    expect(budget.objects).toBe(1);
    expect(budget.chars).toBe(JSON.stringify(watcher.snapshot()[0]).length);
    await watcher.stop();
    expect(() => new WatchBudget(0, 1)).toThrow(RangeError);
  });
});
