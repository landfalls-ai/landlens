import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
import { Flow, localEnv, loginShell, WorkbenchService } from "../src/main/workbench";

/** A window: sends are recorded; "destroyed" ends what it owns. */
function window() {
  const e = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; send(c: string, p: unknown): void; sent: [string, any][] };
  e.sent = [];
  e.isDestroyed = () => false;
  e.send = (c, p) => e.sent.push([c, p]);
  return e;
}

/** A cluster whose log endpoint streams until aborted. */
function cluster() {
  const aborted: string[] = [];
  const request = vi.fn(async (path: string, init: { signal: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("2026-11-15T10:00:00Z one\n2026-11-15T10:00:01Z two\n"));
        init.signal.addEventListener("abort", () => {
          aborted.push(path);
          c.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      },
    });
    return new Response(body, { status: 200 });
  });
  return { request, aborted, get: () => ({ client: { request }, info: { context: "orbstack" } }) as any, onGone: (fn: (h: string) => void) => (gone = fn) };
}
let gone: (h: string) => void = () => {};

const door = { issueToken: vi.fn(() => "t".repeat(64)), revokeToken: vi.fn(), clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "", url: "https://127.0.0.1:1" };

describe("the workbench service", () => {
  it("streams a pod's log to the window that asked, and stops it when that window goes", async () => {
    const c = cluster();
    const svc = new WorkbenchService({ clusters: c as any, frontDoor: door as any, dataDir: mkdtempSync(join(tmpdir(), "wb-")) });
    const wc = window();
    const { stream } = svc.openLogs({ handle: "h1234567", namespace: "n", pod: "p", container: "c" }, wc as any);
    await vi.waitFor(() => expect(wc.sent.find(([ch]) => ch === "logs:lines")?.[1]).toEqual({ stream, lines: [{ ts: "2026-11-15T10:00:00Z", text: "one" }, { ts: "2026-11-15T10:00:01Z", text: "two" }] }));
    expect(c.request.mock.calls[0]![0]).toContain("follow=true");
    wc.emit("destroyed");
    expect(c.aborted).toHaveLength(1);
  });

  it("lets only the window that opened a stream close it, and ends streams when the cluster goes", async () => {
    const c = cluster();
    const svc = new WorkbenchService({ clusters: c as any, frontDoor: door as any, dataDir: mkdtempSync(join(tmpdir(), "wb-")) });
    const a = window();
    const b = window();
    const { stream } = svc.openLogs({ handle: "h1234567", namespace: "n", pod: "p", container: "c" }, a as any);
    svc.closeLogsFor(stream, b as any);
    expect(c.aborted).toHaveLength(0);
    expect(() => svc.input("nope-nope-nope", "x", a as any)).toThrow(/no such terminal/);
    gone("h1234567");
    expect(c.aborted).toHaveLength(1);
  });

  it("gives each pod shell its own token for that pod's exec alone, labelled as you, revoked when it ends", async () => {
    const c = cluster();
    const issue = vi.fn(() => "s".repeat(64));
    const revoke = vi.fn();
    const svc = new WorkbenchService({ clusters: c as any, frontDoor: { ...door, issueToken: issue, revokeToken: revoke } as any, dataDir: mkdtempSync(join(tmpdir(), "wb-")) });
    const a = window();
    const b = window();
    const { terminal, label } = svc.openTerminal({ handle: "h1234567", namespace: "shop", pod: "web-1", container: "app" }, a as any);
    expect(label).toBe("you · orbstack · shell shop/web-1");
    expect(issue).toHaveBeenCalledWith({ label, policy: { access: "exec", pod: { namespace: "shop", name: "web-1" } }, clusters: ["h1234567"] });
    // Another window can't type into it, resize it or close it.
    expect(() => svc.input(terminal, "id\n", b as any)).toThrow(/no such terminal/);
    expect(() => svc.resize(terminal, 80, 24, b as any)).toThrow(/no such terminal/);
    svc.close(terminal, b as any);
    expect(svc.terminalCount()).toBe(1);
    // Nothing listens on port 1: the session is refused, the token revoked, the window told.
    await vi.waitFor(() => expect(a.sent.some(([ch, p]) => ch === "terminal:status" && p.state === "exited")).toBe(true));
    expect(a.sent.find(([ch, p]) => ch === "terminal:status" && p.state === "exited")![1]).toMatchObject({ terminal, ended: "refused" });
    expect(revoke).toHaveBeenCalledWith("s".repeat(64));
    expect(svc.terminalCount()).toBe(0);
    expect(b.sent).toHaveLength(0);
  });

  it("ends a window's shells when it closes, and caps how many it may open", () => {
    const c = cluster();
    const revoke = vi.fn();
    const svc = new WorkbenchService({ clusters: c as any, frontDoor: { ...door, revokeToken: revoke } as any, dataDir: mkdtempSync(join(tmpdir(), "wb-")) });
    const a = window();
    for (let i = 0; i < 20; i++) svc.openTerminal({ handle: "h1234567", namespace: "n", pod: `p${i}`, container: "c" }, a as any);
    expect(() => svc.openTerminal({ handle: "h1234567", namespace: "n", pod: "one-more", container: "c" }, a as any)).toThrow(/at most 20/);
    a.emit("destroyed");
    expect(svc.terminalCount()).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(20);
  });

  it("gives a local terminal your environment, not Landlens's or Electron's", () => {
    expect(localEnv({ HOME: "/h", PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", LANDLENS_USER_DATA: "/x", KUBECONFIG: "/k", NODE_OPTIONS: "--x", LANG: "C" }))
      .toEqual({ HOME: "/h", PATH: "/bin", LANG: "C" });
  });

  it("runs your login shell only if /etc/shells lists it", () => {
    const shells = ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"];
    expect(loginShell(shells, "/opt/homebrew/bin/fish", "/bin/bash")).toBe("/opt/homebrew/bin/fish");
    expect(loginShell(shells, "", "/bin/bash")).toBe("/bin/bash");
    expect(loginShell(shells, "/tmp/evil", "/bin/../tmp/evil")).toBe("/bin/zsh");
  });

  it("pauses a terminal's source while the window is more than 2 MB behind, and resumes under 512 KB", () => {
    const src = { pause: vi.fn(), resume: vi.fn() };
    const f = new Flow(src);
    f.sent(1024 * 1024);
    f.sent(1024 * 1024);
    expect(src.pause).not.toHaveBeenCalled();
    f.sent(1);
    expect(src.pause).toHaveBeenCalledTimes(1);
    f.sent(1024 * 1024);
    expect(src.pause).toHaveBeenCalledTimes(1);
    f.ack(2 * 1024 * 1024);
    expect(src.resume).not.toHaveBeenCalled();
    f.ack(700 * 1024);
    expect(src.resume).toHaveBeenCalledTimes(1);
    expect(f.isPaused).toBe(false);
  });
});
