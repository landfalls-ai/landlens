// The views:* channels in main's IPC (wave 10 part 2): a prompt goes through the Secrets check before it reaches the
// view's session (D209: a Secret's copied value never reaches Claude), and the page can't name another window's view.
import { beforeAll, describe, expect, it, vi } from "vitest";

const handles = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handles.set(name, fn), on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  shell: {},
  dialog: {},
  app: { getPath: () => "/nonexistent", getVersion: () => "0.0.0", isPackaged: true },
}));

/** Anything: a function that answers itself, so services registerIpc touches at start do nothing. */
const anything: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : anything), apply: () => anything });

const calls: { channel: string; req: unknown }[] = [];
const views: any = {
  start: async (req: unknown) => (calls.push({ channel: "start", req }), { view: "0123456789abcdef", session: {} }),
  prompt: async (req: unknown) => (calls.push({ channel: "prompt", req }), { stopReason: "end_turn" }),
};
const MARK = "concealed-secret-value";
const secrets: any = new Proxy({}, {
  get: (_t, k) => k === "refusePrompt"
    ? async ({ text, context }: { text: string; context?: { resource: string }[] }) => {
      if (text.includes(MARK) || context?.some((c) => c.resource === "secrets")) throw Object.assign(new Error("That holds a Secret's value."), { status: 400 });
    }
    : anything,
});

beforeAll(async () => {
  const { registerIpc } = await import("../src/main/ipc");
  const { RENDERER_INDEX } = await import("../src/main/security");
  event = { senderFrame: { url: (await import("node:url")).pathToFileURL(RENDERER_INDEX).href }, sender: anything };
  registerIpc(anything, anything, anything, anything, anything, anything, anything, anything, anything, anything, anything, anything, anything, anything, secrets, new Set(), views);
});

let event: any;
const invoke = (channel: string, raw: unknown) => handles.get(channel)!(event, raw);

describe("views:start and views:prompt", () => {
  it("refuse a prompt that holds a Secret's copied value, or a Secret as context, before the view sees it", async () => {
    await expect(invoke("views:start", { handle: "handle-01", text: `why is ${MARK} wrong?` })).rejects.toThrow(/Secret/);
    await expect(invoke("views:prompt", { view: "0123456789abcdef", text: `and ${MARK}?` })).rejects.toThrow(/Secret/);
    await expect(invoke("views:prompt", { view: "0123456789abcdef", text: "this one", context: [{ group: "", version: "v1", resource: "secrets", namespace: "landlens-dev", name: "db" }] })).rejects.toThrow(/Secret/);
    expect(calls).toEqual([]);
    await invoke("views:start", { handle: "handle-01", text: "Pods that restarted" });
    await invoke("views:prompt", { view: "0123456789abcdef", text: "worst first" });
    expect(calls.map((c) => c.channel)).toEqual(["start", "prompt"]);
  });

  it("refuse a block's frame calling anything through mcp:app-call's shape, and a request from outside the app", async () => {
    await expect(handles.get("views:start")!({ senderFrame: { url: "https://example.com" } }, { handle: "handle-01", text: "x" })).rejects.toThrow(/not from Landlens/);
    await expect(invoke("views:app-call", { frame: "a".repeat(32), name: "list_resources;rm", arguments: {} })).rejects.toThrow(/bad request/);
  });
});
