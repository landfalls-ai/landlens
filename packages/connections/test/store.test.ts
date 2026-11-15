import { readFileSync, statSync, writeFileSync } from "node:fs";
import { CONN_NOTES } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { ConnectionStore } from "../src/store.js";
import { fakeCrypto, GH_TOKEN, LIN_KEY, tempFile } from "./helpers.js";

const PIN = `${"a".repeat(64)}.${"b".repeat(64)}`;
const client = { client_id: "client_abc", issuer: "https://mcp.linear.app", redirect_uri: "http://127.0.0.1:5555/callback" };

describe("the connections store", () => {
  it("keeps tokens encrypted in a 0600 file and out of every ConnInfo", () => {
    const path = tempFile("connections.json");
    const s = new ConnectionStore(path, fakeCrypto());
    s.save("github", { method: "token", access: GH_TOKEN, account: { login: "octo" }, scopes: ["repo", "read:org"] });
    s.save("linear", { method: "oauth", access: LIN_KEY, refresh: "lin_refresh_secret_value", expiresAt: 1_900_000_000_000, client });
    const file = readFileSync(path, "utf8");
    for (const secret of [GH_TOKEN, LIN_KEY, "lin_refresh_secret_value", "client_abc"]) expect(file).not.toContain(secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const infos = JSON.stringify([s.info("github"), s.info("linear")]);
    for (const secret of [GH_TOKEN, LIN_KEY, "lin_refresh", "client_abc", "127.0.0.1"]) expect(infos).not.toContain(secret);
    expect(s.info("github")).toEqual({ provider: "github", state: "ready", method: "token", account: { login: "octo" }, scopes: ["repo", "read:org"], mode: "ask", readsAuto: true, give: true });
    expect(s.secrets("github")).toEqual({ access: GH_TOKEN });
    expect(s.secrets("linear")).toEqual({ access: LIN_KEY, refresh: "lin_refresh_secret_value", expiresAt: 1_900_000_000_000, client });
  });

  it("refuses to store anything when the machine can't encrypt", () => {
    const path = tempFile("connections.json");
    const s = new ConnectionStore(path, fakeCrypto(false));
    expect(s.canStore).toBe(false);
    expect(() => s.save("github", { method: "token", access: GH_TOKEN })).toThrow(CONN_NOTES.cantStore);
    expect(s.info("github").state).toBe("off");
  });

  it("starts off, at ask with reads running, and keeps the level and switches across a disconnect", () => {
    const s = new ConnectionStore(tempFile("connections.json"), fakeCrypto());
    expect(s.info("linear")).toEqual({ provider: "linear", state: "off", mode: "ask", readsAuto: true, give: true });
    s.setPrefs("linear", { mode: "read", readsAuto: false, give: false });
    s.save("linear", { method: "token", access: LIN_KEY });
    s.setPin("linear", PIN, { read: 3, write: 2 });
    expect(s.info("linear")).toMatchObject({ state: "ready", mode: "read", readsAuto: false, tools: { read: 3, write: 2 } });
    s.remove("linear");
    expect(s.info("linear")).toEqual({ provider: "linear", state: "off", mode: "read", readsAuto: false, give: false });
    expect(s.secrets("linear")).toBeUndefined();
    expect(s.pin("linear")).toBeUndefined();
  });

  it("a new sign-in replaces the old one's account, pin and refresh token", () => {
    const s = new ConnectionStore(tempFile("connections.json"), fakeCrypto());
    s.save("linear", { method: "oauth", access: LIN_KEY, refresh: "r1", client, account: { login: "a@example.com" } });
    s.setPin("linear", PIN, { read: 1, write: 1 });
    s.save("linear", { method: "token", access: LIN_KEY });
    expect(s.secrets("linear")).toEqual({ access: LIN_KEY });
    expect(s.pin("linear")).toBeUndefined();
    expect(s.info("linear").account).toBeUndefined();
  });

  it("marks a refused refresh expired, and new tokens clear it", () => {
    const s = new ConnectionStore(tempFile("connections.json"), fakeCrypto());
    s.save("linear", { method: "oauth", access: "lin_oauth_old", refresh: "r1", client });
    s.markExpired("linear");
    expect(s.info("linear")).toMatchObject({ state: "expired", note: CONN_NOTES.linearExpired });
    s.setTokens("linear", { access: "lin_oauth_new", refresh: "r2" });
    expect(s.info("linear").state).toBe("ready");
    expect(s.secrets("linear")).toMatchObject({ access: "lin_oauth_new", refresh: "r2" });
  });

  it("keeps an account to one line of 100 characters", () => {
    const s = new ConnectionStore(tempFile("connections.json"), fakeCrypto());
    s.save("github", { method: "token", access: GH_TOKEN, account: { login: "octo", name: `Evil‮\nname ${"x".repeat(300)}` } });
    const name = s.info("github").account!.name!;
    expect(name.length).toBe(100);
    expect(name).not.toMatch(/[\n‮]/);
  });

  it("refuses to store anything on Linux's basic_text backend, a key fixed in the app (Fable's L1)", () => {
    const crypto = { ...fakeCrypto(true), getSelectedStorageBackend: () => "basic_text" };
    const s = new ConnectionStore(tempFile("connections.json"), crypto);
    expect(s.canStore).toBe(false);
    expect(() => s.save("github", { method: "token", access: GH_TOKEN })).toThrow(CONN_NOTES.cantStore);
    expect(new ConnectionStore(tempFile("c.json"), { ...fakeCrypto(true), getSelectedStorageBackend: () => "gnome_libsecret" }).canStore).toBe(true);
    expect(new ConnectionStore(tempFile("c.json"), { ...fakeCrypto(true), getSelectedStorageBackend: () => { throw new Error("not linux"); } }).canStore).toBe(true);
  });

  it("moves a damaged file aside instead of writing over it, keeping the sound provider and its pin (Fable's L4)", () => {
    const path = tempFile("connections.json");
    const s = new ConnectionStore(path, fakeCrypto());
    s.save("github", { method: "token", access: GH_TOKEN });
    s.setPin("github", `${"a".repeat(64)}.${"b".repeat(64)}`, { read: 1, write: 1 });
    s.save("linear", { method: "token", access: LIN_KEY });
    const good = readFileSync(path, "utf8");
    // A file that doesn't parse: kept aside whole, and the next change doesn't lose it.
    writeFileSync(path, good.slice(0, -5));
    expect(s.info("github").state).toBe("off");
    expect(s.damaged).toMatch(/connections\.json\.damaged-\d+$/);
    expect(readFileSync(s.damaged!, "utf8")).toBe(good.slice(0, -5));
    s.setPrefs("linear", { mode: "read" });
    expect(readFileSync(s.damaged!, "utf8")).toBe(good.slice(0, -5));
    // One entry that isn't what the store writes: the other provider and its pin stay.
    const t = new ConnectionStore(tempFile("connections.json"), fakeCrypto());
    const j = JSON.parse(good);
    j.linear.tools = "many";
    writeFileSync((t as unknown as { path: string }).path, JSON.stringify(j));
    expect(t.info("github").state).toBe("ready");
    expect(t.pin("github")).toBe(`${"a".repeat(64)}.${"b".repeat(64)}`);
    expect(t.info("linear").state).toBe("off");
    expect(t.damaged).toBeDefined();
    t.setPrefs("linear", { mode: "read" });
    expect(t.pin("github")).toBe(`${"a".repeat(64)}.${"b".repeat(64)}`);
    expect(t.secrets("github")?.access).toBe(GH_TOKEN);
  });

  it("writes through a temp file of its own: a file planted at the old fixed temp name isn't followed (Fable's L4)", () => {
    const path = tempFile("connections.json");
    const planted = `${path}.tmp`;
    writeFileSync(planted, "planted");
    const s = new ConnectionStore(path, fakeCrypto());
    s.save("github", { method: "token", access: GH_TOKEN });
    expect(readFileSync(planted, "utf8")).toBe("planted");
    expect(s.secrets("github")?.access).toBe(GH_TOKEN);
  });

  it("reads a damaged or foreign file as nothing stored", () => {
    const path = tempFile("connections.json");
    writeFileSync(path, "{not json");
    const s = new ConnectionStore(path, fakeCrypto());
    expect(s.info("github").state).toBe("off");
    writeFileSync(path, JSON.stringify({ github: { access: "not-base64-ciphertext", method: "token", mode: "ask", readsAuto: true }, other: { access: "x" } }));
    expect(s.secrets("github")).toBeUndefined();
  });
});
