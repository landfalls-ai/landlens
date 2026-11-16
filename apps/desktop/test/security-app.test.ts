// hardenApp's switches and registrations, against a stand-in for Electron's app and protocol (it must run before the
// app is ready, so the e2e suite sees only its effect: views.e2e 4 reads a Chromium net log for DNS lookups).
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ switches: [] as [string, string | undefined][], sandbox: 0, schemes: [] as unknown[] }));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    enableSandbox: () => calls.sandbox++,
    commandLine: { appendSwitch: (k: string, v?: string) => calls.switches.push([k, v]) },
    on: () => {},
  },
  protocol: { registerSchemesAsPrivileged: (s: unknown[]) => calls.schemes.push(...s) },
  session: {},
}));

describe("hardenApp", () => {
  it("turns Blink's DNS prefetching off for every frame, with the one spelling Electron 45 obeys (review of part 2, H1)", async () => {
    const { hardenApp, BLINK_SETTINGS } = await import("../src/main/security");
    hardenApp();
    expect(calls.sandbox).toBe(1);
    expect(calls.switches).toContainEqual(["blink-settings", "dnsPrefetchingEnabled=false"]);
    expect(BLINK_SETTINGS).toBe("dnsPrefetchingEnabled=false");
    expect(calls.schemes).toEqual([{ scheme: "landlens-app", privileges: { standard: true, secure: true } }]);
  });
});
