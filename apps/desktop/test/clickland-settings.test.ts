import { ClicklandSettingsInput } from "@landlens/contracts";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClicklandSettingsStore, DEFAULT_CLICKLAND_URL, type Crypto } from "../src/main/clickland-settings";

const KEY = "ck_abcdefghijklmnopqrstuvwxyz012345";
/** A stand-in for safeStorage: reversible, and visibly not the plain text. */
const fake = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...s].reverse().join("") + "#enc"),
  decryptString: (b) => [...b.toString().replace(/#enc$/, "")].reverse().join(""),
});
const store = (crypto = fake()) => {
  const path = join(mkdtempSync(join(tmpdir(), "landlens-settings-")), "clickland.json");
  return { path, s: new ClicklandSettingsStore(path, crypto) };
};

describe("Clickland settings", () => {
  it("stores the key encrypted, readable only through config(), never in view()", () => {
    const { path, s } = store();
    expect(s.view()).toEqual({ url: DEFAULT_CLICKLAND_URL, hasKey: false, canStore: true });
    const view = s.set({ url: "http://127.0.0.1:4710", key: KEY });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view).toMatchObject({ hasKey: true });
    const file = readFileSync(path, "utf8");
    expect(file).not.toContain(KEY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(s.config()).toEqual({ url: "http://127.0.0.1:4710", key: KEY });
  });

  it("keeps the key when only the address changes, and forgets it on clear", () => {
    const { s } = store();
    s.set({ url: "http://127.0.0.1:4710", key: KEY });
    s.set({ url: "https://clickland.example" });
    expect(s.config()).toEqual({ url: "https://clickland.example", key: KEY });
    expect(s.clear()).toMatchObject({ hasKey: false, url: "https://clickland.example" });
    expect(s.config()).toBeUndefined();
  });

  it("maps a context to its Clickland cluster name, defaulting to the context", () => {
    const { s } = store();
    expect(s.set({ url: DEFAULT_CLICKLAND_URL, cluster: { context: "orbstack", name: "dev-1" } }).cluster).toBe("dev-1");
    expect(s.clusterName("orbstack")).toBe("dev-1");
    expect(s.view("other").cluster).toBe("other");
  });

  it("refuses to store a key when safeStorage can't encrypt", () => {
    const { s } = store(fake(false));
    expect(s.view().canStore).toBe(false);
    expect(() => s.set({ url: DEFAULT_CLICKLAND_URL, key: KEY })).toThrow(/won't store it/);
  });

  it("takes https anywhere, but http only to this machine, and no credentials in the URL", () => {
    const ok = (url: string) => ClicklandSettingsInput.safeParse({ url }).success;
    expect(ok("http://127.0.0.1:4710")).toBe(true);
    expect(ok("http://localhost:4710")).toBe(true);
    expect(ok("https://clickland.example")).toBe(true);
    expect(ok("http://clickland.example")).toBe(false);
    expect(ok("https://u:p@clickland.example")).toBe(false);
    expect(ok("file:///etc/passwd")).toBe(false);
    expect(ClicklandSettingsInput.safeParse({ url: "http://127.0.0.1:4710", key: "not-a-key" }).success).toBe(false);
  });
});
