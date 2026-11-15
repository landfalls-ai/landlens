import { FAMILY_NOTES } from "@landlens/contracts";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FamilyStore } from "../src/family-store.js";
import { LF_KEY, TRIAGE_SECRET } from "./fake-family.js";
import { fakeCrypto, tempFile } from "./helpers.js";

const ACCESS = `lfa_fake_access_${"a".repeat(32)}`;
const REFRESH = `lfa_fake_refresh_${"b".repeat(32)}`;
const client = { client_id: "lfc_fake", issuer: "http://127.0.0.1:3001", redirect_uri: "http://127.0.0.1:5555/callback" };
const PIN = (origin: string) => ({ origin, hash: "a".repeat(64), tools: { list_workflows: "b".repeat(16) }, read: 1, write: 0 });
/** The store's own writer: what this store (or an older build of it) would have written, sealed. */
const writeSealed = (s: FamilyStore, f: unknown) => (s as unknown as { write(f: unknown): void }).write(f);

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

  it("Disconnect forgets the blobs, account, scopes, switches and accepted listing; the address and webhook's names stay", () => {
    const { s, file } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
    s.setTriage({ path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET });
    s.setPrefs("landflow", { toSessions: true, readsAuto: false });
    s.setPin("landflow", PIN("http://127.0.0.1:3000"));
    s.remove("landflow");
    expect(s.info("landflow")).toEqual({ sibling: "landflow", state: "off", url: "http://127.0.0.1:3000", toSessions: false, readsAuto: true, triage: { path: "alerts", header: "X-Webhook-Secret", hasSecret: false } });
    expect(s.pin("landflow", "http://127.0.0.1:3000")).toBeUndefined();
    expect(s.landflowSecrets()).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toMatch(/"key"|"triageSecret"/);
  });

  it("a refused refresh marks Landfall expired with its sentence; new tokens clear it", () => {
    const { s } = store();
    s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, refresh: REFRESH, client, scopes: ["mcp:read"] });
    s.markExpired();
    expect(s.info("landfall")).toMatchObject({ state: "expired", note: FAMILY_NOTES.landfallExpired });
    expect(s.setTokens({ access: `${ACCESS}2`, refresh: `${REFRESH}2` }, { origin: "http://127.0.0.1:3001", used: { access: ACCESS, refresh: REFRESH } })).toBe(true);
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

describe("Fable's security review of wave 7 part 1, fixed", () => {
  it("M2: an entry changed by anything but the store doesn't count: its address, a blob from another entry, a pin, a missing seal", () => {
    const edits: [string, (j: Record<string, Record<string, unknown>>) => void][] = [
      ["the address", (j) => (j.landflow!.url = "https://evil.example")],
      ["the switches", (j) => (j.landflow!.toSessions = true)],
      ["the scopes", (j) => (j.landflow!.scopes = ["admin"])],
      ["a pin", (j) => (j.landflow!.pin = PIN("http://127.0.0.1:3000"))],
      ["Landfall's token as Landflow's key", (j) => (j.landflow!.key = j.landfall!.access)],
      ["the seal gone", (j) => (delete j.landflow!.mac, delete j.landflow!.seal)],
      ["the whole entry as Landfall's", (j) => (j.landfall = j.landflow!)],
    ];
    for (const [what, edit] of edits) {
      const { s, file } = store();
      s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
      s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, refresh: REFRESH, client, scopes: ["mcp:read"] });
      const j = JSON.parse(readFileSync(file, "utf8"));
      edit(j);
      writeFileSync(file, JSON.stringify(j));
      const changed = what === "the whole entry as Landfall's" ? "landfall" : "landflow";
      expect(s.info(changed).state, what).toBe("off");
      expect(changed === "landflow" ? s.landflowSecrets() : s.landfallSecrets(), what).toBeUndefined();
      expect(s.prefs(changed).toSessions, what).toBe(false);
      expect(s.pin(changed, "http://127.0.0.1:3000"), what).toBeUndefined();
      expect(s.damaged, what).toMatch(/family\.json\.damaged-\d+$/);
      // The entry nobody touched is still there, sealed.
      if (changed === "landflow") expect(s.landfallSecrets()?.access, what).toBe(ACCESS);
    }
  });

  it("M2: what leaves for the page is held to D100's shapes, whatever was stored", () => {
    const { s, file } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, scopes: ["run"] });
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.landflow.account = { name: `Mallory\n${"x".repeat(3990)}`, email: `m@example.com\u202e` };
    j.landflow.scopes = ["run", "not a scope!", "x".repeat(300)];
    writeSealed(s, j);
    const info = s.info("landflow");
    expect(info.state).toBe("ready");
    expect(info.account!.name!.length).toBeLessThanOrEqual(100);
    expect(info.account!.name).not.toMatch(/\n/);
    expect(info.account!.email).toBe("m@example.com");
    expect(info.scopes).toEqual(["run"]);
  });

  it("M1: refreshed tokens are stored only for the sign-in the refresh was made with", () => {
    const { s } = store();
    s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, refresh: REFRESH, client, scopes: ["mcp:read"] });
    const next = { access: `${ACCESS}2`, refresh: `${REFRESH}2` };
    // Another server's refresh, or one made with a refresh token that isn't the stored one: not kept.
    expect(s.setTokens(next, { origin: "http://127.0.0.1:3009", used: { access: ACCESS, refresh: REFRESH } })).toBe(false);
    expect(s.setTokens(next, { origin: "http://127.0.0.1:3001", used: { access: ACCESS, refresh: `${REFRESH}x` } })).toBe(false);
    expect(s.landfallSecrets()).toMatchObject({ access: ACCESS, refresh: REFRESH });
    // After a Disconnect: nothing to put them in.
    s.remove("landfall");
    expect(s.setTokens(next, { origin: "http://127.0.0.1:3001", used: { access: ACCESS, refresh: REFRESH } })).toBe(false);
    expect(s.landfallSecrets()).toBeUndefined();
  });

  it("M3: another address or another person turns Tools for Claude off and forgets the pin; the same keeps them", () => {
    const { s } = store();
    const on = (origin: string) => (s.setPrefs("landflow", { toSessions: true, readsAuto: false }), s.setPin("landflow", PIN(origin)));
    const fable = { name: "Fable Person", email: "fable@example.com" };
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: fable, scopes: ["run"] });
    on("http://127.0.0.1:3000");
    // The same origin and the same person (a new key): kept.
    s.saveLandflow({ url: "http://127.0.0.1:3000/", key: `lf_${"G".repeat(43)}`, account: fable, scopes: ["run"] });
    expect(s.prefs("landflow")).toEqual({ toSessions: true, readsAuto: false });
    expect(s.pin("landflow", "http://127.0.0.1:3000")).toBeDefined();
    // Another person on the same origin.
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "Other", email: "other@example.com" }, scopes: ["run"] });
    expect(s.prefs("landflow")).toEqual({ toSessions: false, readsAuto: true });
    expect(s.pin("landflow", "http://127.0.0.1:3000")).toBeUndefined();
    // Another origin, the same person.
    on("http://127.0.0.1:3000");
    s.saveLandflow({ url: "http://127.0.0.1:3010", key: LF_KEY, account: { name: "Other", email: "other@example.com" }, scopes: ["run"] });
    expect(s.prefs("landflow")).toEqual({ toSessions: false, readsAuto: true });
    // Landfall names no account: every new sign-in starts over, even at the same origin.
    s.saveLandfall({ url: "http://127.0.0.1:3001", access: ACCESS, refresh: REFRESH, client, scopes: ["mcp:read"] });
    s.setPrefs("landfall", { toSessions: true });
    s.saveLandfall({ url: "http://127.0.0.1:3001", access: `${ACCESS}2`, client, scopes: ["mcp:read"] });
    expect(s.prefs("landfall").toSessions).toBe(false);
    // Clickland's are reset by main when its key or origin changes.
    s.setPrefs("clickland", { toSessions: true, readsAuto: false });
    s.resetSwitches("clickland");
    expect(s.prefs("clickland")).toEqual({ toSessions: false, readsAuto: true });
  });
});

describe("Fable's security review of wave 7 part 2, fixed", () => {
  it("L8: the accepted listing is sealed with its entry: a pin changed in the file, Clickland's too, isn't one", () => {
    for (const sib of ["clickland", "landflow"] as const) {
      const { s, file } = store();
      if (sib === "landflow") s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
      s.setPrefs(sib, { toSessions: true });
      s.setPin(sib, PIN("http://127.0.0.1:3000"));
      const j = JSON.parse(readFileSync(file, "utf8"));
      j[sib].pin.hash = "c".repeat(64);
      j[sib].pin.tools = { list_workflows: "b".repeat(16), export_everything: "d".repeat(16) };
      writeFileSync(file, JSON.stringify(j));
      expect(s.pin(sib, "http://127.0.0.1:3000"), sib).toBeUndefined();
      expect(s.prefs(sib).toSessions, sib).toBe(false);
    }
  });

  it("L8: a changed listing is kept across a restart; accepting one clears it, as does another sign-in", () => {
    const { s, file } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
    s.setPin("landflow", PIN("http://127.0.0.1:3000"));
    s.setDrift("landflow", true);
    expect(new FamilyStore(file, fakeCrypto(true)).drift("landflow")).toBe(true);
    s.setPin("landflow", PIN("http://127.0.0.1:3000"));
    expect(s.drift("landflow")).toBe(false);
    s.setDrift("landflow", true);
    s.saveLandflow({ url: "http://127.0.0.1:3009", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
    expect(s.drift("landflow")).toBe(false);
  });

  it("L5: a pin the store couldn't read back is refused, and the entry with its key stays", () => {
    const { s } = store();
    s.saveLandflow({ url: "http://127.0.0.1:3000", key: LF_KEY, account: { name: "P" }, scopes: ["run"] });
    const long = `x${"y".repeat(199)}`;
    expect(() => s.setPin("landflow", { ...PIN("http://127.0.0.1:3000"), tools: { [long]: "b".repeat(16) } })).toThrow(FAMILY_NOTES.badListing);
    // Counts that don't add up to the tools aren't a listing Landlens made.
    expect(() => s.setPin("landflow", { ...PIN("http://127.0.0.1:3000"), read: 5 })).toThrow(FAMILY_NOTES.badListing);
    expect(s.landflowSecrets()?.key).toBe(LF_KEY);
    expect(s.damaged).toBeUndefined();
  });

  it("M4: D109's move is marked once, and the mark outlives a Disconnect", () => {
    const { s } = store();
    expect(s.moved()).toEqual({ ran: false, note: false });
    s.markMoved(true);
    expect(s.moved()).toEqual({ ran: true, note: true });
    s.setPrefs("clickland", { readsAuto: true });
    expect(s.moved()).toEqual({ ran: true, note: false });
    s.remove("clickland");
    expect(s.moved().ran).toBe(true);
  });
});
