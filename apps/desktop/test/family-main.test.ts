// FamilyService (main/family.ts, wave 7 part 1) against the loopback fakes of the Land family: what is stored, where
// a key goes, what the page and the log may see, and the addresses a build takes.
import { FAMILY_NOTES, type FamilyInfo } from "@landlens/contracts";
import type { Crypto, McpOAuth } from "@landlens/connections";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { familyOverrides, FamilyService } from "../src/main/family";
import { CK_READ, CK_WRITE, FakeClickland, FakeLandfall, FakeLandflow, LF_KEY, LF_KEY_ADMIN, TRIAGE_SECRET } from "../../../packages/connections/test/fake-family";
import { fakeCrypto, tempFile } from "../../../packages/connections/test/helpers";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.map((s) => s()));
  stops = [];
});
const up = async <T extends { start(): Promise<T>; stop(): Promise<void> }>(f: T): Promise<T> => {
  await f.start();
  stops.push(() => f.stop());
  return f;
};

function service(o: { canStore?: boolean; httpHosts?: string[]; fetch?: typeof fetch; crypto?: Crypto; file?: string; ckFile?: string } = {}) {
  const file = o.file ?? tempFile("family.json");
  const ckFile = o.ckFile ?? tempFile("clickland.json");
  const crypto = o.crypto ?? fakeCrypto(o.canStore ?? true);
  const clickland = new ClicklandSettingsStore(ckFile, crypto);
  const opened: string[] = [];
  const pushed: FamilyInfo[] = [];
  const logs: string[] = [];
  const browser = async (url: string) => {
    opened.push(url);
    const r = await fetch(url, { redirect: "manual" });
    const back = r.headers.get("location");
    if (back) await fetch(back);
  };
  const s = new FamilyService({
    file, crypto, clickland,
    overrides: { httpHosts: o.httpHosts ?? [] },
    openExternal: browser,
    push: (i) => pushed.push(i),
    log: (l) => logs.push(l),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { s, file, ckFile, clickland, opened, pushed, logs };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};
const owner = {};

describe("the family's addresses (D102)", () => {
  it("LANDLENS_FAMILY_HTTP_HOSTS is read in an unpackaged build only, exact names only", () => {
    const env = { LANDLENS_FAMILY_HTTP_HOSTS: "landflow-host.landflow-dev.svc.cluster.local, BAD HOST,-x.example,a..b,http://x.example,ok.example" };
    expect(familyOverrides(env, false)).toEqual({ httpHosts: ["landflow-host.landflow-dev.svc.cluster.local", "ok.example"] });
    expect(familyOverrides(env, true)).toEqual({ httpHosts: [] });
    expect(familyOverrides({}, false)).toEqual({ httpHosts: [] });
  });

  it("refuses plain http to a name before any request, unless the build lists it; then the key goes only there", async () => {
    const lf = await up(new FakeLandflow());
    const port = new URL(lf.origin).port;
    const sent: string[] = [];
    // The listed name stands for the fake: the request is pinned to the name's origin, then delivered to the fake.
    const via = (async (u: string | URL | Request, init?: RequestInit) => {
      sent.push(String(u));
      return fetch(String(u).replace(`http://landflow.test:${port}`, lf.origin), init);
    }) as typeof fetch;
    const strict = service({ fetch: via });
    await expect(strict.s.connectLandflow(`http://landflow.test:${port}`, LF_KEY)).rejects.toThrow(FAMILY_NOTES.httpOnlyHere);
    expect(sent).toEqual([]);
    const dev = service({ fetch: via, httpHosts: ["landflow.test"] });
    const info = await dev.s.connectLandflow(`http://landflow.test:${port}`, LF_KEY);
    expect(info).toMatchObject({ state: "ready", url: `http://landflow.test:${port}` });
    expect(sent).toEqual([`http://landflow.test:${port}/api/auth/me`]);
  });
});

describe("Landflow by a pasted key (D103)", () => {
  it("connects: who it is, what the key covers; the list, the pushes and the file carry no key", async () => {
    const lf = await up(new FakeLandflow());
    const { s, file, pushed } = service();
    const info = await s.connectLandflow(lf.origin, LF_KEY);
    expect(info).toMatchObject({ sibling: "landflow", state: "ready", method: "key", account: { name: "Fable Person", email: "fable@example.com", role: "member" }, can: { brain: true, run: true, runs: true, flows: true }, toSessions: false, readsAuto: true });
    expect(info.note).toBeUndefined();
    const all = JSON.stringify([s.list(), pushed, readFileSync(file, "utf8")]);
    expect(all).not.toContain(LF_KEY);
    expect(lf.carrying(LF_KEY).map((r) => r.path)).toEqual(["/api/auth/me"]);
  });

  it("a key that can change workflows is kept, with the sentence", async () => {
    const lf = await up(new FakeLandflow());
    const { s } = service();
    expect((await s.connectLandflow(lf.origin, LF_KEY_ADMIN)).note).toBe(FAMILY_NOTES.landflowWrites);
  });

  it("a refused key stores nothing and changes nothing stored", async () => {
    const lf = await up(new FakeLandflow());
    const { s } = service();
    await s.connectLandflow(lf.origin, LF_KEY);
    await expect(s.connectLandflow(lf.origin, `lf_${"Q".repeat(43)}`)).rejects.toMatchObject({ status: 401, message: FAMILY_NOTES.landflowRefused });
    expect(s.store.landflowSecrets()?.key).toBe(LF_KEY);
  });

  it("without a key, uses the stored one only for the origin it was saved for: the page can't send it elsewhere", async () => {
    const lf = await up(new FakeLandflow());
    const other = await up(new FakeLandflow());
    const { s } = service();
    await s.connectLandflow(lf.origin, LF_KEY);
    await expect(s.connectLandflow(other.origin)).rejects.toMatchObject({ status: 400, message: FAMILY_NOTES.keyElsewhere });
    expect(other.requests).toEqual([]);
    expect((await s.connectLandflow(lf.origin)).state).toBe("ready");
  });

  it("refuses when safeStorage can't encrypt, before any request", async () => {
    const lf = await up(new FakeLandflow());
    const { s } = service({ canStore: false });
    expect(s.list().canStore).toBe(false);
    await expect(s.connectLandflow(lf.origin, LF_KEY)).rejects.toMatchObject({ status: 409, message: FAMILY_NOTES.cantStore });
    expect(lf.requests).toEqual([]);
  });

  it("a failure's raw error reaches the log with the key cut out, and the page gets the sentence", async () => {
    const boom = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { message: `connect ECONNREFUSED while sending Bearer ${LF_KEY} as ${LF_KEY}` } });
    }) as typeof fetch;
    const { s, logs } = service({ fetch: boom });
    await expect(s.connectLandflow("http://127.0.0.1:3000", LF_KEY)).rejects.toThrow(FAMILY_NOTES.unreachable);
    expect(logs.join("\n")).toContain("[family] landflow");
    expect(logs.join("\n")).not.toContain(LF_KEY);
  });

  it("the triage webhook: its secret encrypted, never shown; Landflow must be connected", async () => {
    const lf = await up(new FakeLandflow());
    const { s, file, pushed } = service();
    expect(() => s.set("landflow", { triage: { path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET } })).toThrow(FAMILY_NOTES.connectLandflow);
    await s.connectLandflow(lf.origin, LF_KEY);
    const info = s.set("landflow", { triage: { path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET } });
    expect(info.triage).toEqual({ path: "alerts", header: "X-Webhook-Secret", hasSecret: true });
    expect(JSON.stringify([info, pushed, s.list(), readFileSync(file, "utf8")])).not.toContain(TRIAGE_SECRET);
    expect(s.store.landflowSecrets()?.triageSecret).toBe(TRIAGE_SECRET);
    expect(() => s.set("clickland", { triage: null })).toThrow(/Only Landflow/);
  });

  it("Check: health and who-am-I again, to the stored origin only", async () => {
    const lf = await up(new FakeLandflow());
    const { s } = service();
    await s.connectLandflow(lf.origin, LF_KEY);
    const t = await s.test("landflow");
    expect(t.ok).toBe(true);
    expect(t.steps.map((x) => x.name)).toEqual(["health", "who-am-I"]);
    expect(t.steps[1]!.detail).toContain("Fable Person");
    expect(JSON.stringify(t)).not.toContain(LF_KEY);
    expect(lf.requests.find((r) => r.path === "/api/health")?.authorization).toBeUndefined();
  });

  it("Disconnect forgets the key and the webhook's secret; the address stays for the form", async () => {
    const lf = await up(new FakeLandflow());
    const { s, file } = service();
    await s.connectLandflow(lf.origin, LF_KEY);
    s.set("landflow", { triage: { path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET }, toSessions: true });
    const info = await s.disconnect("landflow");
    expect(info).toMatchObject({ state: "off", url: lf.origin, toSessions: false, triage: { hasSecret: false } });
    expect(readFileSync(file, "utf8")).not.toMatch(/"key"|"triageSecret"/);
  });
});

describe("Landfall by its connector's OAuth (D103)", () => {
  it("signs in in the browser on Landfall's own page, for mcp:read only, and never touches a trigger", async () => {
    const lf = await up(new FakeLandfall());
    const { s, opened, pushed, file } = service();
    const { flow } = await s.signinLandfall(lf.origin, owner);
    expect(flow).toMatch(/^fl[A-Za-z0-9_-]{16}$/);
    await until(() => s.info("landfall").state === "ready");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.startsWith(`${lf.origin}/mcp/authorize?`)).toBe(true);
    expect(new URL(opened[0]!).searchParams.get("scope")).toBe("mcp:read");
    const info = s.info("landfall");
    expect(info).toMatchObject({ method: "oauth", scopes: ["mcp:read"], url: lf.origin, toSessions: false });
    const sec = s.store.landfallSecrets()!;
    expect(JSON.stringify([s.list(), pushed, readFileSync(file, "utf8")])).not.toContain(sec.access);
    expect(lf.forbidden).toEqual([]);
    // Check: the connector and its MCP endpoint answer with the token.
    const t = await s.test("landfall");
    expect(t.steps.map((x) => [x.name, x.ok])).toEqual([["connector", true], ["initialize", true]]);
    // Sign out revokes both tokens first.
    await s.disconnect("landfall");
    expect(lf.revoked).toEqual([sec.access, sec.refresh]);
    expect(s.info("landfall").state).toBe("off");
  });

  it("a Landfall without its connector is refused before a listener opens or a client is registered", async () => {
    const lf = await up(new FakeLandfall());
    lf.off = true;
    const { s, opened } = service();
    await expect(s.signinLandfall(lf.origin, owner)).rejects.toMatchObject({ status: 409, message: FAMILY_NOTES.landfallOff });
    expect(opened).toEqual([]);
    expect(lf.requests.map((r) => r.path)).toEqual(["/.well-known/oauth-authorization-server"]);
    expect(s.info("landfall")).toMatchObject({ state: "failed", note: FAMILY_NOTES.landfallOff });
  });

  it("only the window that started a sign-in can cancel it, and a cancelled sign-in stores nothing", async () => {
    const lf = await up(new FakeLandfall());
    const { s } = service();
    // A browser that never comes back: the flow waits.
    (s as unknown as { o: { openExternal: (u: string) => Promise<void> } }).o.openExternal = async () => undefined;
    const { flow } = await s.signinLandfall(lf.origin, owner);
    expect(s.info("landfall").state).toBe("connecting");
    expect(() => s.cancel(flow, {})).toThrow("No such sign-in.");
    s.cancelFor(owner);
    await until(() => s.info("landfall").state === "off");
    expect(s.store.landfallSecrets()).toBeUndefined();
  });
});

describe("Clickland: the key that is already there (D103)", () => {
  it("says who the stored key is, once, in the background; a key that can write is kept with the sentence", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland, pushed } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    expect(s.info("clickland")).toMatchObject({ state: "ready", method: "key", url: ck.origin });
    await until(() => pushed.some((p) => p.sibling === "clickland" && !!p.account));
    expect(s.info("clickland")).toMatchObject({ account: { name: "landlens-graphs", role: "viewer" }, scopes: ["read"] });
    expect(s.info("clickland").note).toBeUndefined();
    s.list();
    s.list();
    expect(ck.requests.filter((r) => r.path === "/api/auth/me")).toHaveLength(1);

    clickland.set({ url: ck.origin, key: CK_WRITE });
    s.clicklandChanged();
    await until(() => s.info("clickland").note === FAMILY_NOTES.clicklandWrites);
    expect(JSON.stringify([s.list(), pushed])).not.toMatch(/ck_[A-Z]{32}/);
  });

  it("a key saved for another address never shows the old key's account", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.info("clickland");
    await until(() => !!s.info("clickland").account);
    clickland.set({ url: "http://127.0.0.1:9" });
    s.clicklandChanged();
    expect(s.info("clickland")).toMatchObject({ state: "off" });
    expect(s.info("clickland").account).toBeUndefined();
  });

  it("a refused key is Failed with the sentence; the console address is an origin", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: `ck_${"Z".repeat(32)}` });
    s.info("clickland");
    await until(() => s.info("clickland").state === "failed");
    expect(s.info("clickland").note).toBe(FAMILY_NOTES.clicklandRefused);
    expect(s.set("clickland", { console: "http://127.0.0.1:4711/" }).console).toBe("http://127.0.0.1:4711");
    expect(s.set("clickland", { console: null }).console).toBeUndefined();
    expect(() => s.set("clickland", { console: "http://console.example" })).toThrow(FAMILY_NOTES.httpOnlyHere);
  });

  it("Disconnect forgets Clickland's key (the graphs' key)", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland, ckFile } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    await s.disconnect("clickland");
    expect(clickland.config()).toBeUndefined();
    expect(readFileSync(ckFile, "utf8")).not.toContain('"key"');
  });
});

describe("Fable's security review of wave 7 part 1, fixed", () => {
  const url = (i: Parameters<typeof fetch>[0]) => String(i instanceof Request ? i.url : i);
  /** Signed in to a fake Landfall whose access tokens live 30 s, so the next bearer refreshes first. */
  const landfallDue = async (o: Parameters<typeof service>[0] = {}) => {
    const lf = await up(new FakeLandfall());
    lf.expiresIn = 30;
    const svc = service(o);
    await svc.s.signinLandfall(lf.origin, owner);
    await until(() => svc.s.info("landfall").state === "ready");
    return { lf, ...svc };
  };
  const refreshes = (lf: FakeLandfall) => lf.requests.filter((q) => q.path === "/mcp/token" && q.body.includes("grant_type=refresh_token")).length;
  /** A keychain whose errors echo what it was given, once `on` is set. */
  const echoing = () => {
    const base = fakeCrypto(true);
    const c = { on: false, crypto: { ...base, encryptString: (t: string) => { if (c.on) throw new Error(`could not encrypt ${t}`); return base.encryptString(t); } } as Crypto };
    return c;
  };

  it("M1: a refresh that answers after a sign-in to another Landfall is revoked there, never stored under the new address", async () => {
    const { lf: a, s } = await landfallDue();
    const b = await up(new FakeLandfall());
    const release = a.hold("/mcp/token", true);
    const bearer = s.landfallBearer();
    await until(() => a.issued.length === 2);
    await s.signinLandfall(b.origin, owner);
    await until(() => s.info("landfall").state === "ready" && s.info("landfall").url === b.origin);
    release();
    expect(await bearer).toBeUndefined();
    const refreshed = a.issued[1]!;
    await until(() => a.revoked.includes(refreshed.access) && a.revoked.includes(refreshed.refresh));
    const sec = s.store.landfallSecrets()!;
    expect(sec.url).toBe(b.origin);
    expect(b.valid.has(sec.access)).toBe(true);
    expect((await s.test("landfall")).ok).toBe(true);
    for (const t of a.issued) expect([...b.carrying(t.access), ...b.carrying(t.refresh)]).toEqual([]);
  });

  it("M1: a Disconnect during a refresh revokes what the refresh gave when it answers", async () => {
    const { lf, s } = await landfallDue();
    const release = lf.hold("/mcp/token", true);
    const bearer = s.landfallBearer();
    await until(() => lf.issued.length === 2);
    await s.disconnect("landfall");
    release();
    expect(await bearer).toBeUndefined();
    const refreshed = lf.issued[1]!;
    await until(() => lf.revoked.includes(refreshed.access) && lf.revoked.includes(refreshed.refresh));
    expect(s.store.landfallSecrets()).toBeUndefined();
  });

  it("M2: a stored address this build doesn't take is off: no request, connect again", async () => {
    const lf = await up(new FakeLandflow());
    const port = new URL(lf.origin).port;
    const sent: string[] = [];
    const via = (async (u: string | URL | Request, init?: RequestInit) => {
      sent.push(url(u));
      return fetch(url(u).replace(`http://landflow.test:${port}`, lf.origin), init);
    }) as typeof fetch;
    const dev = service({ fetch: via, httpHosts: ["landflow.test"] });
    await dev.s.connectLandflow(`http://landflow.test:${port}`, LF_KEY);
    dev.s.set("landflow", { toSessions: true });
    await dev.s.settled();
    sent.length = 0;
    // The same profile, a build without LANDLENS_FAMILY_HTTP_HOSTS.
    const strict = service({ fetch: via, httpHosts: [], file: dev.file, ckFile: dev.ckFile });
    const t = await strict.s.test("landflow");
    expect(t).toEqual({ ok: false, steps: [{ name: "key", ok: false, detail: FAMILY_NOTES.httpOnlyHere }] });
    expect(strict.s.info("landflow")).toMatchObject({ state: "off", note: FAMILY_NOTES.httpOnlyHere });
    expect(strict.s.info("landflow").account).toBeUndefined();
    expect(await strict.s.remotes()).toEqual([]);
    await expect(strict.s.connectLandflow(`http://landflow.test:${port}`)).rejects.toThrow(FAMILY_NOTES.httpOnlyHere);
    expect(sent).toEqual([]);
  });

  it("M3: another Landflow, another Landfall sign-in or another Clickland key turns Tools for Claude off", async () => {
    const lf = await up(new FakeLandflow());
    const other = await up(new FakeLandflow());
    const { s, clickland } = service();
    await s.connectLandflow(lf.origin, LF_KEY);
    s.set("landflow", { toSessions: true, readsAuto: false });
    await s.settled();
    // The same key at the same address again: kept.
    await s.connectLandflow(lf.origin);
    expect(s.info("landflow")).toMatchObject({ toSessions: true, readsAuto: false });
    await s.connectLandflow(other.origin, LF_KEY);
    expect(s.info("landflow")).toMatchObject({ toSessions: false, readsAuto: true });
    expect(s.store.pin("landflow", lf.origin)).toBeUndefined();

    const fa = await up(new FakeLandfall());
    await s.signinLandfall(fa.origin, owner);
    await until(() => s.info("landfall").state === "ready");
    s.set("landfall", { toSessions: true });
    await s.settled();
    await s.signinLandfall(fa.origin, owner);
    await until(() => s.store.landfallSecrets()?.access === fa.issued[1]?.access);
    expect(s.info("landfall").toSessions).toBe(false);

    const ck = await up(new FakeClickland());
    const ck2 = await up(new FakeClickland());
    clickland.set({ url: ck.origin, key: CK_READ });
    s.clicklandChanged();
    s.set("clickland", { toSessions: true, readsAuto: false });
    await s.settled();
    // A new cluster name: the same key at the same origin keeps them.
    clickland.set({ url: ck.origin, cluster: { context: "orbstack", name: "dev" } });
    s.clicklandChanged();
    expect(s.info("clickland")).toMatchObject({ toSessions: true, readsAuto: false });
    // Another key, then another address: off.
    clickland.set({ url: ck.origin, key: CK_WRITE });
    s.clicklandChanged();
    expect(s.info("clickland")).toMatchObject({ toSessions: false, readsAuto: true });
    s.set("clickland", { toSessions: true });
    await s.settled();
    clickland.set({ url: ck2.origin, key: CK_READ });
    s.clicklandChanged();
    expect(s.info("clickland").toSessions).toBe(false);
    s.set("clickland", { toSessions: true });
    await s.disconnect("clickland");
    expect(s.store.prefs("clickland").toSessions).toBe(false);
  });

  it("M5: two bearers at once refresh once, and Landfall stays ready", async () => {
    const { lf, s } = await landfallDue();
    const before = refreshes(lf);
    const [a, b] = await Promise.all([s.landfallBearer(), s.landfallBearer()]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(refreshes(lf) - before).toBe(1);
    expect(s.info("landfall").state).toBe("ready");
  });

  it("M5: a session's refusal of tokens that are no longer the stored ones expires nothing", async () => {
    const { lf, s } = await landfallDue();
    const session = (s as unknown as { landfallAuth(): McpOAuth }).landfallAuth();
    const stale = session.tokens()!;
    expect(await s.landfallBearer()).toBeDefined();
    expect(s.store.landfallSecrets()!.refresh).not.toBe(stale.refresh_token);
    session.invalidateCredentials("tokens");
    await expect(session.redirectToAuthorization(new URL(`${lf.origin}/mcp/authorize`))).rejects.toThrow(FAMILY_NOTES.landfallExpired);
    expect(s.info("landfall").state).toBe("ready");
    // A refusal of the stored ones does.
    lf.refuseRefresh = true;
    lf.valid.clear();
    const now = (s as unknown as { landfallAuth(): McpOAuth }).landfallAuth();
    now.tokens();
    now.invalidateCredentials("tokens");
    await expect(now.redirectToAuthorization(new URL(`${lf.origin}/mcp/authorize`))).rejects.toThrow(FAMILY_NOTES.landfallExpired);
    expect(s.info("landfall").state).toBe("expired");
  });

  it("M5: a sign-in cancelled after Landfall gave the tokens, or whose save failed, is revoked", async () => {
    const lf = await up(new FakeLandfall());
    let svc!: ReturnType<typeof service>;
    // The window goes while the code is exchanged: Landfall has issued the tokens.
    svc = service({ fetch: (i, init) => (url(i).endsWith("/mcp/token") ? (svc.s.cancelFor(owner), fetch(i, init)) : fetch(i, init)) });
    await svc.s.signinLandfall(lf.origin, owner);
    await until(() => lf.revoked.length === 2);
    expect(lf.revoked).toEqual([lf.issued[0]!.access, lf.issued[0]!.refresh]);
    expect(svc.s.store.landfallSecrets()).toBeUndefined();
    expect(svc.s.info("landfall").state).toBe("off");

    const lf2 = await up(new FakeLandfall());
    const keychain = echoing();
    const { s, logs } = service({ crypto: keychain.crypto });
    keychain.on = true;
    await s.signinLandfall(lf2.origin, owner);
    await until(() => lf2.revoked.length === 2);
    expect(lf2.revoked).toEqual([lf2.issued[0]!.access, lf2.issued[0]!.refresh]);
    await until(() => s.info("landfall").state === "failed");
    // M6: the keychain's error echoed the access token; the log has it cut, by the exact secret main held.
    expect(logs.join("\n")).toContain("<redacted secret>");
    expect(logs.join("\n")).not.toContain(lf2.issued[0]!.access);
  });

  it("M6: the webhook's secret and a refreshed token, echoed by an error, are cut from the log", async () => {
    const lf = await up(new FakeLandflow());
    const keychain = echoing();
    const { s, logs } = service({ crypto: keychain.crypto });
    await s.connectLandflow(lf.origin, LF_KEY);
    keychain.on = true;
    expect(() => s.set("landflow", { triage: { path: "alerts", header: "X-Webhook-Secret", secret: TRIAGE_SECRET } })).toThrow(FAMILY_NOTES.landflowAnswer);
    expect(logs.join("\n")).toContain("[family] landflow");
    expect(logs.join("\n")).not.toContain(TRIAGE_SECRET);

    const fa = await up(new FakeLandfall());
    fa.expiresIn = 30;
    keychain.on = false;
    await s.signinLandfall(fa.origin, owner);
    await until(() => s.info("landfall").state === "ready");
    keychain.on = true;
    logs.length = 0;
    expect(await s.landfallBearer()).toBeUndefined();
    const refreshed = fa.issued[1]!;
    expect(logs.join("\n")).toContain("[family] landfall refresh");
    expect(logs.join("\n")).toContain("<redacted secret>");
    expect(logs.join("\n")).not.toContain(refreshed.access);
  });

  it("L1: signing in again revokes the sign-in it replaces, at its own server", async () => {
    const { lf: a, s } = await landfallDue();
    const first = s.store.landfallSecrets()!;
    const b = await up(new FakeLandfall());
    await s.signinLandfall(b.origin, owner);
    await until(() => a.revoked.length === 2);
    expect(a.revoked).toEqual([first.access, first.refresh]);
    expect(b.revoked).toEqual([]);
  });

  it("L3: a sign-in cancelled before the browser opened answers 'cancelled' and logs nothing; a failure logs once", async () => {
    const lf = await up(new FakeLandfall());
    const { s, logs, opened } = service();
    const release = lf.hold("/mcp/register");
    const starting = s.signinLandfall(lf.origin, owner);
    await until(() => lf.requests.some((q) => q.path === "/mcp/register"));
    s.cancelFor(owner);
    release();
    await expect(starting).rejects.toMatchObject({ status: 499, message: "The sign-in was cancelled." });
    expect(opened).toEqual([]);
    expect(logs.filter((l) => l.startsWith("[family] landfall"))).toEqual([]);
    expect(s.info("landfall").state).toBe("off");

    // A failure before the browser opens: the starter gets the card's sentence.
    const boom = (async (i: Parameters<typeof fetch>[0], init?: RequestInit) => (url(i).endsWith("/mcp/register") ? Promise.reject(new Error("socket hang up")) : fetch(i, init))) as typeof fetch;
    const two = service({ fetch: boom });
    await expect(two.s.signinLandfall(lf.origin, owner)).rejects.toMatchObject({ status: 502, message: FAMILY_NOTES.landfallUnreachable });
    expect(two.s.info("landfall")).toMatchObject({ state: "failed", note: FAMILY_NOTES.landfallUnreachable });
  });

  it("L4: an address that passes the rule but reads as another host, or not at all, is refused before any request", async () => {
    const sent: string[] = [];
    const rec = (async (u: Parameters<typeof fetch>[0]) => (sent.push(url(u)), new Response("{}"))) as typeof fetch;
    const { s } = service({ fetch: rec });
    for (const bad of ["https://1.2.3.4.5", "https://1.2.3", "https://0x7f.1"]) {
      await expect(s.connectLandflow(bad, LF_KEY), bad).rejects.toMatchObject({ status: 400, message: FAMILY_NOTES.httpOnlyHere });
      await expect(s.signinLandfall(bad, owner), bad).rejects.toMatchObject({ status: 400, message: FAMILY_NOTES.httpOnlyHere });
    }
    expect(() => s.set("clickland", { console: "https://1.2.3" })).toThrow(FAMILY_NOTES.httpOnlyHere);
    expect(sent).toEqual([]);
  });

  it("L7: a refresh that didn't get through says so and stays ready; a token past its time with nothing to refresh it is expired", async () => {
    let down = false;
    const { s } = await landfallDue({ fetch: (i, init) => (down && url(i).endsWith("/mcp/token") ? Promise.reject(new TypeError("fetch failed")) : fetch(i, init)) });
    down = true;
    const t = await s.test("landfall");
    expect(t.steps.at(-1)).toEqual({ name: "sign-in", ok: false, detail: FAMILY_NOTES.landfallUnreachable });
    expect(s.info("landfall").state).toBe("ready");

    const lf = await up(new FakeLandfall());
    const two = service();
    two.s.store.saveLandfall({ url: lf.origin, access: `lfa_fake_access_${"d".repeat(32)}`, expiresAt: Date.now() - 1000, client: { client_id: "lfc_x", issuer: lf.origin, redirect_uri: "http://127.0.0.1:1/callback" }, scopes: ["mcp:read"] });
    expect(await two.s.landfallBearer()).toBeUndefined();
    expect(two.s.info("landfall")).toMatchObject({ state: "expired", note: FAMILY_NOTES.landfallExpired });
  });

  it("L8: a Check whose key changed while it asked doesn't keep the old key's identity", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.info("clickland");
    await until(() => !!s.info("clickland").account);
    const release = ck.hold("/api/auth/me");
    const asked = ck.requests.length;
    const checking = s.test("clickland");
    await until(() => ck.requests.slice(asked).some((q) => q.path === "/api/auth/me"));
    clickland.set({ url: ck.origin, key: CK_WRITE });
    s.clicklandChanged();
    await until(() => s.info("clickland").note === FAMILY_NOTES.clicklandWrites);
    release();
    await checking;
    expect(s.info("clickland")).toMatchObject({ account: { name: "ops-bot" }, note: FAMILY_NOTES.clicklandWrites });
  });
});
