import { channels, pushChannels } from "@landlens/contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The preload can't import zod in a sandbox, so it keeps its own list; this keeps the two in step.
describe("preload bridge", () => {
  const src = readFileSync(resolve(__dirname, "../src/preload/index.ts"), "utf8");
  it("lists exactly the contract's channels", () => {
    const listed = [...src.matchAll(/"([a-z]+:[a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set([...Object.keys(channels), ...pushChannels]));
  });

  it("never exposes ipcRenderer itself", () => {
    expect(src).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(src).toContain('contextBridge.exposeInMainWorld("landlens", bridge)');
  });
});
