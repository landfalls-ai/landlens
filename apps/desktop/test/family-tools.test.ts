// The family's tools in Claude sessions (wave 7 part 2, D107–D111, D109), in main, against the loopback fakes:
// FamilyService gives the gateway a sibling's server only when it is ready and Tools for Claude is on, with its key
// added in main and every request pinned to its origin; it accepts a listing when Tools for Claude is turned on or at
// Check, notices a changed one, and accepts it again only on family:repin. McpService serves the siblings after the
// connections and follows a sibling's change in open sessions; Add Clickland's server moves to the family once.
import { FAMILY_NOTES, type FamilyInfo } from "@landlens/contracts";
import { listingHash, type RemoteSpec } from "@landlens/mcp-gateway";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { FamilyService } from "../src/main/family";
import { McpService, moveClicklandServer } from "../src/main/mcp";
import { McpServerStore } from "../src/main/mcp-store";
import { CK_READ, CLICKLAND_TOOLS, FakeClickland, FakeLandfall, FakeLandflow, LF_KEY, LF_KEY_NARROW } from "../../../packages/connections/test/fake-family";
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
const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

function service(o: { taken?: string[] } = {}) {
  const file = tempFile("family.json");
  const crypto = fakeCrypto(true);
  const clickland = new ClicklandSettingsStore(tempFile("clickland.json"), crypto);
  const pushed: FamilyInfo[] = [];
  const logs: string[] = [];
  const browser = async (url: string) => {
    const r = await fetch(url, { redirect: "manual" });
    const back = r.headers.get("location");
    if (back) await fetch(back);
  };
  const s = new FamilyService({
    file, crypto, clickland, overrides: { httpHosts: [] }, openExternal: browser,
    push: (i) => pushed.push(i), log: (l) => logs.push(l), takenNames: () => o.taken ?? [],
  });
  return { s, file, clickland, pushed, logs };
}

describe("a sibling's server for sessions (D107, D108)", () => {
  it("is given to sessions only when ready and Tools for Claude is on; the key is added in main, pinned to the origin", async () => {
    const lf = await up(new FakeLandflow());
    const { s, pushed, file } = service();
    expect(await s.remotes()).toEqual([]);
    await s.connectLandflow(lf.origin, LF_KEY);
    // Off when first connected: nothing is listed and nothing is served.
    expect(s.info("landflow")).toMatchObject({ toSessions: false, readsAuto: true });
    expect(s.info("landflow").tools).toBeUndefined();
    expect(await s.remotes()).toEqual([]);
    expect(lf.requests.some((r) => r.path === "/api/mcp")).toBe(false);
    // Turned on: its listing is accepted, and the card says how many read and ask.
    s.set("landflow", { toSessions: true });
    await s.settled();
    expect(s.info("landflow")).toMatchObject({ toSessions: true, tools: { read: 21, write: 7 } });
    expect(s.info("landflow").note).toBeUndefined();
    const [spec] = await s.remotes();
    expect(spec).toMatchObject({ name: "landflow", url: `${lf.origin}/api/mcp`, origins: [lf.origin], noViews: true, headers: { Authorization: `Bearer ${LF_KEY}` } });
    expect(spec!.provider).toMatchObject({ id: "landflow", mode: "ask", readsAuto: true });
    expect(spec!.provider.views).toBeUndefined();
    expect(spec!.provider.readTools.has("my_briefing")).toBe(true);
    expect(spec!.provider.readTools.has("execute_workflow")).toBe(false);
    expect(spec!.pin).toMatch(/^[0-9a-f]{64}$/);
    // The key never reaches the page or the file in the clear.
    expect(JSON.stringify([s.list(), pushed, s.servers(), readFileSync(file, "utf8")])).not.toContain(LF_KEY);
    // Off again: no longer served.
    s.set("landflow", { toSessions: false });
    expect(await s.remotes()).toEqual([]);
  });

  it("keeps Clickland's views and nobody else's (D112)", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.set("clickland", { toSessions: true });
    await s.settled();
    const [spec] = await s.remotes();
    expect(spec).toMatchObject({ name: "clickland", url: `${ck.origin}/api/mcp`, origins: [ck.origin], headers: { Authorization: `Bearer ${CK_READ}` } });
    expect(spec!.noViews).toBeUndefined();
    expect(spec!.provider.views).toBe(true);
    expect(s.info("clickland").tools).toEqual({ read: 18, write: 5 });
  });

  it("serves Landfall with its sign-in as the transport's OAuth provider, never a token in a header", async () => {
    const lf = await up(new FakeLandfall());
    const { s } = service();
    await s.signinLandfall(lf.origin, {});
    await until(() => s.info("landfall").state === "ready");
    s.set("landfall", { toSessions: true });
    await s.settled();
    expect(s.info("landfall").tools).toEqual({ read: 21, write: 0 }); // mcp:read only: acknowledge_incident isn't listed
    const [spec] = await s.remotes();
    expect(spec).toMatchObject({ name: "landfall", url: `${lf.origin}/mcp`, origins: [lf.origin], noViews: true });
    expect(spec!.headers).toBeUndefined();
    expect(spec!.authProvider).toBeDefined();
    expect(lf.forbidden).toEqual([]);
  });

  it("stays off while a server you added has the sibling's name, and says so", async () => {
    const lf = await up(new FakeLandflow());
    const { s } = service({ taken: ["landflow"] });
    await s.connectLandflow(lf.origin, LF_KEY);
    s.set("landflow", { toSessions: true });
    expect(s.info("landflow").note).toBe(FAMILY_NOTES.nameTaken);
    expect(await s.remotes()).toEqual([]);
    expect(s.servers()).toEqual([]);
  });

  it("lists on the MCP page from Connections, its tools counted by D110", async () => {
    const lf = await up(new FakeLandflow());
    const { s } = service();
    await s.connectLandflow(lf.origin, LF_KEY_NARROW); // brain:read only: Landflow lists the brain's reads
    s.set("landflow", { toSessions: true });
    await s.settled();
    await s.test("landflow");
    const [srv] = s.servers();
    expect(srv).toMatchObject({ id: "landflow", name: "landflow", connection: "landflow", enabled: true, autoRun: true, status: "ready" });
    expect(srv!.tools!.every((t) => t.readOnly)).toBe(true);
    expect(srv!.tools!.map((t) => t.name)).toContain("my_briefing");
  });
});

describe("the pin (D111)", () => {
  it("notices a changed listing at Check, shows the diff by name, and accepts it again only on repin", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland, logs } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.set("clickland", { toSessions: true });
    await s.settled();
    const accepted = (await s.remotes())[0]!.pin;
    expect(accepted).toBe(listingHash(CLICKLAND_TOOLS));
    // Clickland adds a tool and rewrites one.
    ck.tools = [...CLICKLAND_TOOLS.map((t) => (t.name === "count" ? { ...t, description: "counts, and now deletes" } : t)), { name: "export_everything", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
    const t = await s.test("clickland");
    expect(t.ok).toBe(false);
    expect(t.steps.at(-1)).toMatchObject({ name: "listing", ok: false, detail: FAMILY_NOTES.drift });
    expect(t.diff).toEqual({ added: ["export_everything"], removed: [], changed: ["count"] });
    expect(t.tools!.find((x) => x.name === "export_everything")).toMatchObject({ readOnly: false }); // not on Landlens's list: asks
    expect(s.info("clickland")).toMatchObject({ drift: true, note: FAMILY_NOTES.drift });
    expect(logs.some((l) => l.includes("its tools changed"))).toBe(true);
    // The session still gets the old pin, so the gateway asks for everything.
    expect((await s.remotes())[0]!.pin).toBe(accepted);
    expect(s.servers()[0]).toMatchObject({ autoRun: false, autoRunNote: FAMILY_NOTES.drift });
    // Accept: the new listing is the pin.
    const info = s.repin("clickland");
    expect(info.drift).toBeUndefined();
    expect(info.note).toBeUndefined();
    expect((await s.remotes())[0]!.pin).toBe(listingHash(ck.tools));
  });

  it("repin needs a Check of this origin first, and a session's drift marks the card", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    expect(() => s.repin("clickland")).toThrow(/Check it first/);
    s.set("clickland", { toSessions: true });
    await s.settled();
    s.drifted("clickland");
    expect(s.info("clickland").drift).toBe(true);
    // A pin is bound to its origin: another Clickland starts with Tools for Claude off (wave 7 review, M3), and is
    // accepted afresh when it is turned on, never under the old pin.
    const other = await up(new FakeClickland());
    clickland.set({ url: other.origin, key: CK_READ });
    s.clicklandChanged();
    expect(s.info("clickland").toSessions).toBe(false);
    s.set("clickland", { toSessions: true });
    await s.settled();
    expect(s.info("clickland").drift).toBeUndefined();
    expect(s.store.pin("clickland", other.origin)?.origin).toBe(other.origin);
    expect(s.store.pin("clickland", ck.origin)).toBeUndefined();
    // A Check of the old origin can't be accepted for the new one.
    clickland.set({ url: ck.origin, key: CK_READ });
    s.clicklandChanged();
    s.set("clickland", { toSessions: true });
    await s.settled();
    await s.test("clickland");
    clickland.set({ url: other.origin, key: CK_READ });
    s.clicklandChanged();
    await s.settled();
    expect(() => s.repin("clickland")).toThrow(/Check it first/);
  });
});

describe("McpService and the family", () => {
  const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };

  it("serves the siblings after your servers and the connections, names them for the standing rules, and routes their drift", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-fam-"));
    const st = new McpServerStore(join(dir, "mcp-servers.json"), fakeCrypto(true));
    const drifted: string[] = [];
    const fam: RemoteSpec = { name: "clickland", url: "http://127.0.0.1:1/api/mcp", origins: ["http://127.0.0.1:1"], pin: "0".repeat(64), provider: { id: "clickland", readTools: new Set(), mode: "ask", readsAuto: true, views: true } };
    const conn: RemoteSpec = { name: "github", url: "http://127.0.0.1:1/mcp/", pin: "0".repeat(64), provider: { id: "github", readTools: new Set(), mode: "ask", readsAuto: true } };
    const svc = new McpService({
      store: st, clickland: new ClicklandSettingsStore(join(dir, "clickland.json"), fakeCrypto(true)),
      frontDoor: {} as never, clusters: { onGone: () => {} } as never, metrics: async () => { throw new Error("none"); }, push: () => {},
      ask: { confirm: async () => false, openExternal: async () => {} },
      connections: { remotes: async () => [conn], servers: () => [], drifted: () => {} },
      family: {
        remotes: async () => [fam],
        servers: () => [{ id: "clickland", name: "clickland", builtin: false, connection: "clickland", url: fam.url, enabled: true, autoRun: true, appOrigins: [], status: "unknown" }],
        drifted: (s) => drifted.push(s),
      },
    });
    await svc.start();
    try {
      expect((await svc.servers("orbstack")).servers.map((x) => x.name)).toEqual(["landlens-kube", "clickland"]);
      const s = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
      expect(s.servers.map((x) => x.name)).toEqual(["landlens-kube", "github", "clickland"]);
      expect(s.providers).toEqual(["GitHub"]);
      expect(s.family).toEqual(["Clickland"]);
      // Nothing listens there: it didn't list, so every tool asks and nothing is said to have changed.
      expect(s.allow).toEqual(["mcp__landlens-kube"]);
      await s.close();
      (svc.gateway as unknown as { opts: { onDrift: (s: RemoteSpec) => void } }).opts.onDrift(fam);
      expect(drifted).toEqual(["clickland"]);
    } finally {
      await svc.stop();
    }
  });

  it("follows a sibling's change in open sessions at once: off or signed out drops its server; reads off makes them ask", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.set("clickland", { toSessions: true });
    await s.settled();
    const dir = mkdtempSync(join(tmpdir(), "landlens-fam-"));
    const svc = new McpService({
      store: new McpServerStore(join(dir, "mcp-servers.json"), fakeCrypto(true)), clickland,
      frontDoor: {} as never, clusters: { onGone: () => {} } as never, metrics: async () => { throw new Error("none"); }, push: () => {},
      ask: { confirm: async () => false, openExternal: async () => {} }, family: s,
    });
    await svc.start();
    try {
      const open = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
      expect(open.allow).toContain("mcp__clickland__list_services");
      expect(open.readsFree).toEqual(["Clickland"]);
      const session = [...(svc.gateway as unknown as { sessions: Map<string, { upstreams: Map<string, unknown>; allow: string[] }> }).sessions.values()][0]!;
      svc.familyChanged(s.set("clickland", { readsAuto: false }));
      expect(session.allow.filter((a) => a.startsWith("mcp__clickland__"))).toEqual([]);
      expect(session.upstreams.has("clickland")).toBe(true);
      svc.familyChanged(s.set("clickland", { toSessions: false }));
      expect(session.upstreams.has("clickland")).toBe(false);
      await open.close();
    } finally {
      await svc.stop();
    }
  });

  it("D109: moves the server Add Clickland made to the family, once, and leaves one you typed elsewhere alone", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland, logs } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    // mcp-servers.json as wave 6 left it: Add Clickland's server (reads asked) and one typed by hand elsewhere.
    const path = tempFile("mcp-servers.json");
    const server = (id: string, name: string, url: string, autoRun: boolean) => ({ id, name, url, appOrigins: [], contexts: ["orbstack"], listing: "a".repeat(64), autoRun });
    writeFileSync(path, JSON.stringify({ servers: [server("s_made", "clickland", `${ck.origin}/api/mcp`, false), server("s_typed", "logs-elsewhere", "http://127.0.0.1:4799/api/mcp", true)] }));
    const st = new McpServerStore(path, fakeCrypto(true));
    const typed = { id: "s_typed" };
    const said: string[] = [];
    expect(moveClicklandServer({ store: st, clickland, family: s, log: (l) => said.push(l) })).toBe(true);
    await s.settled();
    expect(st.list().map((x) => x.id)).toEqual([typed.id]);
    expect(s.info("clickland")).toMatchObject({ toSessions: true, readsAuto: false, tools: { read: 18, write: 5 } });
    expect(said.join("\n")).toContain("moved clickland");
    expect(logs.some((l) => l.includes("moved to the Land family"))).toBe(true);
    // Once: nothing more to move.
    expect(moveClicklandServer({ store: st, clickland, family: s })).toBe(false);
    // Without a Clickland key, nothing is moved.
    const bare = service();
    const path2 = tempFile("mcp-servers.json");
    writeFileSync(path2, JSON.stringify({ servers: [server("s_made", "clickland", `${ck.origin}/api/mcp`, true)] }));
    const st2 = new McpServerStore(path2, fakeCrypto(true));
    expect(moveClicklandServer({ store: st2, clickland: bare.clickland, family: bare.s })).toBe(false);
    expect(st2.list()).toHaveLength(1);
  });
});
