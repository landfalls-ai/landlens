import { readFileSync, statSync, writeFileSync } from "node:fs";
import { CONN_NOTES } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { ConnectionStore } from "../src/store.js";
import { fakeCrypto, GH_TOKEN, LIN_KEY, tempFile } from "./helpers.js";

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
    s.setPin("linear", "aaa.bbb", { read: 3, write: 2 });
    expect(s.info("linear")).toMatchObject({ state: "ready", mode: "read", readsAuto: false, tools: { read: 3, write: 2 } });
    s.remove("linear");
    expect(s.info("linear")).toEqual({ provider: "linear", state: "off", mode: "read", readsAuto: false, give: false });
    expect(s.secrets("linear")).toBeUndefined();
    expect(s.pin("linear")).toBeUndefined();
  });

  it("a new sign-in replaces the old one's account, pin and refresh token", () => {
    const s = new ConnectionStore(tempFile("connections.json"), fakeCrypto());
    s.save("linear", { method: "oauth", access: LIN_KEY, refresh: "r1", client, account: { login: "a@example.com" } });
    s.setPin("linear", "x.y", { read: 1, write: 1 });
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

  it("reads a damaged or foreign file as nothing stored", () => {
    const path = tempFile("connections.json");
    writeFileSync(path, "{not json");
    const s = new ConnectionStore(path, fakeCrypto());
    expect(s.info("github").state).toBe("off");
    writeFileSync(path, JSON.stringify({ github: { access: "not-base64-ciphertext", method: "token", mode: "ask", readsAuto: true }, other: { access: "x" } }));
    expect(s.secrets("github")).toBeUndefined();
  });
});
