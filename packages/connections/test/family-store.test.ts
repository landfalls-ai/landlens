import { FAMILY_NOTES } from "@landlens/contracts";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FamilyStore } from "../src/family-store.js";
import { LF_KEY, TRIAGE_SECRET } from "./fake-family.js";
import { fakeCrypto, tempFile } from "./helpers.js";

const ACCESS = `lfa_fake_access_${"a".repeat(32)}`;
const REFRESH = `lfa_fake_refresh_${"b".repeat(32)}`;
const client = { client_id: "lfc_fake", issuer: "http://127.0.0.1:3001", redirect_uri: "http://127.0.0.1:5555/callback" };

const store = (available = true) => {
  const file = tempFile("family.json");
  return { s: new FamilyStore(file, fakeCrypto(available)), file };
};

describe("the family's store (D101)", () => {
  it("keeps every secret encrypted on disk, mode 0600, and never in FamilyInfo", () => {
    const { s, file } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "Fable Person", email: "fable@example.com" }, scopes: ["brain:write", "run"] });
    s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET });
    s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, refresh: REFRESH, client, scopes: ["mcp:read"] });
    const disk = readFileSync(file, "utf8");
    for (const secret of [LF_KEY, TRIAGE_SECRET, ACCESS, REFRESH, client.client_id]) expect(disk).not.toContain(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const infos = JSON.stringify([s.info("landflow"), s.info("landfall")]);
    for (const secret of [LF_KEY, TRIAGE_SECRET, ACCESS, REFRESH]) expect(infos).not.toContain(secret);
    expect(s.info("landflow")).toMatchObject({ state: "ready", method: "key", url: "http://127.0.0.1:3000", toSessions: false, readsAuto: true, can: { brain: true, run: true, runs: false, flows: false }, triage: { path: "alerts", header: "X-Webhook-Secret", hasSecret: true } });
    expect(s.info("landfall")).toMatchObject({ state: "ready", method: "oauth", scopes: ["mcp:read"] });
    expect(s.landflowSecrets()).toEqual({ url: "http://127.0.0.1:3000", key: LF_KEY, triageSecret: TRIAGE_SECRET });
    expect(s.landfallSecrets()).toMatchObject({ access: ACCESS, refresh: REFRESH, client });
  });

  it("binds a secret to its origin: another address drops the webhook's secret, keeping its path and header", () => {
    const { s } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, scopes: [] });
    s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET });
    s.saveLandflow({ url: "https://landflow.example", key: `lf_${"G".repeat(43)}`, scopes: [] });
    expect(s.landflowSecrets()?.triageSecret).toBeUndefined();
    expect(s.info("landflow").triage).toEqual({ path: "alerts", header: "X-Webhook-Secret", hasSecret: false });
    // The same origin keeps it.
    s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET });
    s.saveLandflow({ url: "https://landflow.example/", key: `lf_${"G".repeat(43)}`, scopes: [] });
    expect(s.landflowSecrets()?.triageSecret).toBe(TRIAGE_SECRET);
  });

  it("refuses to store anything when safeStorage can't encrypt, with wave 6's sentence", () => {
    const { s, file } = store(false);
    expect(s.canStore).toBe(false);
    expect(() => s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, scopes: [] })).toThrow(FAMILY_NOTES.cantStore);
    expect(() => s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, client, scopes: [] })).toThrow(FAMILY_NOTES.cantStore);
    expect(existsSync(file)).toBe(false);
  });

  it("the webhook needs Landflow connected; null removes it with its secret", () => {
    const { s } = store();
    expect(() => s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET })).toThrow(FAMILY_NOTES.connectLandflow);
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, scopes: [] });
    s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET });
    s.setTriage({ path: "team/alerts", header: "X-Alert-Key" });
    expect(s.landflowSecrets()?.triageSecret).toBe(TRIAGE_SECRET);
    s.setTriage(null);
    expect(s.info("landflow").triage).toBeUndefined();
    expect(s.landflowSecrets()?.triageSecret).toBeUndefined();
  });

  it("Disconnect forgets the blobs, account and scopes; the address, switches and webhook's names stay", () => {
    const { s, file } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
    s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET });
    s.setPrefs("landflow", { toSessions: true });
    s.remove("landflow");
    expect(s.info("landflow")).toEqual({ sibling: "landflow", state: "off", url: "http://127.0.0.1:3000", toSessions: true, readsAuto: true, triage: { path: "alerts", header: "X-Webhook-Secret", hasSecret: false } });
    expect(s.landflowSecrets()).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toMatch(/"key"|"triageSecret"/);
  });

  it("a refused refresh marks Landfall expired with its sentence; new tokens clear it", () => {
    const { s } = store();
    s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, refresh: REFRESH, client, scopes: ["mcp:read"] });
    s.markExpired();
    expect(s.info("landfall")).toMatchObject({ state: "expired", note: FAMILY_NOTES.landfallExpired });
    s.setTokens({ access: `${ACCESS}2`, refresh: `${REFRESH}2` });
    expect(s.info("landfall").state).toBe("ready");
  });

  it("keeps who Clickland's key is only for the origin it was read for", () => {
    const { s } = store();
    s.setClicklandWho("http://127.0.0.1:4710/", { account: { name: "landlens-graphs", role: "viewer" }, scopes: ["read"] });
    expect(s.clicklandWho("http://127.0.0.1:4710")).toEqual({ account: { name: "landlens-graphs", role: "viewer" }, scopes: ["read"] });
    expect(s.clicklandWho("http://127.0.0.1:4730")).toBeUndefined();
    expect(s.clicklandWho(undefined)).toBeUndefined();
  });

  it("cleans what a sibling said: one line, at most 100 characters", () => {
    const { s } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: `Fable‮ Person\n${"x".repeat(200)}` }, scopes: ["run", "not a scope!"] });
    const a = s.info("landflow").account!;
    expect(a.name!.length).toBeLessThanOrEqual(100);
    expect(a.name).not.toMatch(/[\n‮]/);
    expect(s.info("landflow").scopes).toEqual(["run"]);
  });

  it("moves a damaged file aside and keeps the sound entries", () => {
    const { s, file } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, scopes: [] });
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.landfall = { access: 42 };
    writeFileSync(file, JSON.stringify(j));
    expect(s.info("landflow").state).toBe("ready");
    expect(s.damaged).toMatch(/family\.json\.damaged-\d+$/);
    expect(s.info("landfall").state).toBe("off");
  });
});
