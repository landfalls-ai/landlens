// The Views page's store in the window (wave 10 part 2): main is the record; a data push for a version other than the
// shown one is dropped (part 1's review), and a new version starts with no data from the old.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (p: any) => void>();
const invoked: { channel: string; req: any }[] = [];
let hold: Promise<void> | undefined;
vi.mock("../src/renderer/src/api", () => ({
  api: {
    on: (channel: string, fn: (p: any) => void) => (listeners.set(channel, fn), () => listeners.delete(channel)),
    invoke: async (channel: string, req: any) => {
      invoked.push({ channel, req });
      if (channel === "views:start") {
        if (hold) await hold;
        return { view: "0123456789abcdef", session: { session: "s1", context: req.handle === "handle-02" ? "orbstack-b" : "orbstack" } };
      }
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

const D = (name: string, o: Record<string, unknown> = {}): any => ({ group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespace: "landlens-dev", name, ...o });

describe("a view is its cluster's (security review of part 3, H1)", () => {
  beforeEach(() => void (invoked.length = 0));

  it("shows and acts on a view only under the cluster it was built on, and closes it when another cluster's window mounts", async () => {
    const { viewStore, viewOn } = await import("../src/renderer/src/viewStore");
    const off = viewStore.subscribe(() => {});
    viewStore.bind("handle-01");
    await viewStore.start("handle-01", "Show me the pods");
    expect(viewStore.get().view).toMatchObject({ handle: "handle-01", context: "orbstack" });
    expect(viewOn(viewStore.get(), "handle-01").view?.id).toBe("0123456789abcdef");
    // Under another cluster's handle there is no view to show or act on, even before the switch closes it.
    expect(viewOn(viewStore.get(), "handle-02").view).toBeUndefined();
    // The other cluster's Workspace mounts: the view closes, here and in main.
    viewStore.bind("handle-02");
    expect(viewStore.get().view).toBeUndefined();
    expect(invoked.at(-1)).toEqual({ channel: "views:close", req: { view: "0123456789abcdef" } });
    // Binding the same cluster again keeps its view.
    await viewStore.start("handle-02", "Pods");
    viewStore.bind("handle-02");
    expect(viewStore.get().view?.handle).toBe("handle-02");
    await viewStore.close();
    off();
  });

  it("lets go of a view whose start answers after the person switched cluster", async () => {
    const { viewStore } = await import("../src/renderer/src/viewStore");
    viewStore.bind("handle-01");
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const started = viewStore.start("handle-01", "Show me the pods");
    expect(viewStore.get().starting).toBe("Show me the pods");
    viewStore.bind("handle-02");
    expect(viewStore.get().starting).toBeUndefined();
    release();
    await started;
    hold = undefined;
    expect(viewStore.get().view).toBeUndefined();
    expect(invoked.at(-1)).toEqual({ channel: "views:close", req: { view: "0123456789abcdef" } });
  });

  it("leaves the page when main says the view closed (its cluster went), never a frozen Live", async () => {
    const { viewStore } = await import("../src/renderer/src/viewStore");
    viewStore.bind("handle-01");
    await viewStore.start("handle-01", "Show me the pods");
    listeners.get("views:state")!(state(1));
    expect(viewStore.get().view?.state?.version).toBe(1);
    listeners.get("views:state")!({ ...state(1), closed: true });
    expect(viewStore.get().view).toBeUndefined();
    expect(viewStore.get().error).toMatch(/closed/);
  });
});

describe("the selection bar's rows (security review of part 3, M2; L2's survivors)", () => {
  it("keeps a block's rows the block's when the person ticks one more, unticks one or ticks all", async () => {
    const { nextSelection, chosenBy } = await import("../src/renderer/src/viewStore");
    const { selectionActions } = await import("../src/renderer/src/viewBlocks");
    const T = { group: "apps", resource: "deployments", verbs: ["get", "list", "delete", "patch"] };
    const block = nextSelection(undefined, [D("a"), D("b")], "block", "Chooser")!;
    expect(chosenBy(block)).toBe("block");
    expect(selectionActions(T, chosenBy(block))).toEqual(["restart"]);
    // The table's checkboxes hand every ticked row (the block's too) to pick: one more tick.
    const more = nextSelection(block, [D("a"), D("b"), D("c")], "you")!;
    expect(more.refs.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(chosenBy(more)).toBe("block");
    expect(more.block).toBe("Chooser");
    expect(selectionActions(T, chosenBy(more))).not.toContain("delete");
    // Unticking one of the block's rows: the other is still the block's.
    expect(chosenBy(nextSelection(more, [D("b"), D("c")], "you")!)).toBe("block");
    // Only once every row the block chose is gone is the selection the person's, with Delete.
    const mine = nextSelection(more, [D("c")], "you")!;
    expect(chosenBy(mine)).toBe("you");
    expect(mine.block).toBeUndefined();
    expect(selectionActions(T, chosenBy(mine))).toEqual(["restart", "delete"]);
    // A block's select replaces the person's selection wholesale, all of it the block's.
    expect(nextSelection(mine, [D("c")], "block")!.fromBlock).toEqual(["apps/deployments/landlens-dev/c"]);
    expect(nextSelection(mine, [], "you")).toBeUndefined();
  });

  it("the store keeps who chose (by), at most 50 rows, and never chips a Secret", async () => {
    const { viewStore, chosenBy } = await import("../src/renderer/src/viewStore");
    viewStore.bind("handle-01");
    await viewStore.start("handle-01", "Show me the pods");
    viewStore.select([D("a")], "block", "Chooser");
    expect(viewStore.get().view?.selection).toEqual({ refs: [D("a")], fromBlock: ["apps/deployments/landlens-dev/a"], block: "Chooser" });
    viewStore.select([D("a"), D("z")]);
    expect(chosenBy(viewStore.get().view!.selection!)).toBe("block");
    viewStore.select(Array.from({ length: 60 }, (_, i) => D(`d${i}`)));
    expect(viewStore.get().view?.selection?.refs).toHaveLength(50);
    viewStore.select(Array.from({ length: 60 }, (_, i) => D(`d${i}`)), "block");
    expect(viewStore.get().view?.selection?.fromBlock).toHaveLength(50);
    viewStore.select([]);
    expect(viewStore.get().view?.selection).toBeUndefined();
    viewStore.chip({ group: "", version: "v1", resource: "secrets", kind: "Secret", namespace: "landlens-dev", name: "shop-tls" });
    expect(viewStore.get().view?.chips ?? []).toEqual([]);
    viewStore.chip(D("a"));
    expect(viewStore.get().view?.chips).toEqual([D("a")]);
    await viewStore.close();
  });
});
