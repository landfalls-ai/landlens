// The Views page's store in the window (wave 10 part 2): main is the record; a data push for a version other than the
// shown one is dropped (part 1's review), and a new version starts with no data from the old.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (p: any) => void>();
const invoked: { channel: string; req: any }[] = [];
vi.mock("../src/renderer/src/api", () => ({
  api: {
    on: (channel: string, fn: (p: any) => void) => (listeners.set(channel, fn), () => listeners.delete(channel)),
    invoke: async (channel: string, req: any) => {
      invoked.push({ channel, req });
      if (channel === "views:start") return { view: "0123456789abcdef", session: { session: "s1" } };
      if (channel === "views:get") return state(0);
      return {};
    },
  },
}));

const state = (version: number): any => ({ id: "0123456789abcdef", session: "s1", version, sources: {}, versions: [], params: {}, busy: false, ask: "x", canUndo: false, canRedo: false, shownBy: "claude", context: "orbstack", title: "t" });
const rows = (n: number) => ({ state: "ok", rows: Array.from({ length: n }, (_, i) => ({ name: `p${i}` })), total: n });

describe("viewStore", () => {
  beforeEach(() => void (invoked.length = 0));

  it("keeps a source's data only for the shown version, and starts a new version empty", async () => {
    const { viewStore } = await import("../src/renderer/src/viewStore");
    const off = viewStore.subscribe(() => {});
    await viewStore.start("handle-01", "Show me the pods");
    const seen: number[] = [];
    viewStore.onData((_s, d: any) => seen.push(d.rows.length));
    listeners.get("views:state")!(state(1));
    listeners.get("views:data")!({ view: "0123456789abcdef", version: 1, source: "pods", data: rows(2) });
    expect((viewStore.data("pods") as any).rows).toHaveLength(2);
    // A late push from the version before: dropped, for the page and the frames.
    listeners.get("views:state")!(state(2));
    expect(viewStore.data("pods")).toBeUndefined();
    listeners.get("views:data")!({ view: "0123456789abcdef", version: 1, source: "pods", data: rows(5) });
    expect(viewStore.data("pods")).toBeUndefined();
    listeners.get("views:data")!({ view: "0123456789abcdef", version: 2, source: "pods", data: rows(3) });
    expect((viewStore.data("pods") as any).rows).toHaveLength(3);
    // Another view's push is never this one's.
    listeners.get("views:data")!({ view: "fedcba9876543210", version: 2, source: "pods", data: rows(9) });
    expect((viewStore.data("pods") as any).rows).toHaveLength(3);
    // Nor is its state (review of part 2, M4): this view stays on its version, with its data.
    listeners.get("views:state")!({ ...state(7), id: "fedcba9876543210", title: "another" });
    expect(viewStore.get().view?.state).toMatchObject({ version: 2, title: "t" });
    expect((viewStore.data("pods") as any).rows).toHaveLength(3);
    expect(seen).toEqual([2, 3]);
    // A question from the view's session is kept until it's answered, and heard, so the page can open the dock.
    const heard: string[] = [];
    viewStore.onPermission((p) => heard.push(p.request));
    listeners.get("agent:permission")!({ request: "r1", session: "s1", toolCall: { toolCallId: "t1" }, options: [] });
    listeners.get("agent:permission")!({ request: "r2", session: "other", toolCall: { toolCallId: "t2" }, options: [] });
    expect(viewStore.asks("s1").map((p) => p.request)).toEqual(["r1"]);
    expect(heard).toEqual(["r1", "r2"]);
    listeners.get("agent:status")!({ state: "answered", request: "r1", session: "s1" });
    expect(viewStore.asks("s1")).toEqual([]);
    await viewStore.close();
    expect(invoked.at(-1)).toEqual({ channel: "views:close", req: { view: "0123456789abcdef" } });
    off();
  });
});
