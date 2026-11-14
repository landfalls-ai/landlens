import { describe, expect, it } from "vitest";
import { KubeClient } from "../src/client.js";
import { ResourceWatcher, type WatcherEvent } from "../src/watch.js";

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
});
