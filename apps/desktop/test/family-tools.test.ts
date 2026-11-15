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
import type { GatewaySession } from "@landlens/mcp-gateway";
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

function service(o: { taken?: string[]; file?: string; clickland?: ClicklandSettingsStore; push?: (i: FamilyInfo) => void } = {}) {
  const file = o.file ?? tempFile("family.json");
  const crypto = fakeCrypto(true);
  const clickland = o.clickland ?? new ClicklandSettingsStore(tempFile("clickland.json"), crypto);
  const pushed: FamilyInfo[] = [];
  const logs: string[] = [];
  const browser = async (url: string) => {
    const r = await fetch(url, { redirect: "manual" });
    const back = r.headers.get("location");
    if (back) await fetch(back);
  };
  const s = new FamilyService({
    file, crypto, clickland, overrides: { httpHosts: [] }, openExternal: browser,
    push: (i) => (pushed.push(i), o.push?.(i)), log: (l) => logs.push(l), takenNames: () => o.taken ?? [],
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
    // Main lists nothing for a session (L7 of the part 2 review): the gateway works the reads out from its own listing.
    expect(spec!.provider.readTools.size).toBe(0);
    expect(spec!.pinTools).toEqual(s.store.pin("landflow", lf.origin)!.tools);
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
    expect(t.listing).toBe(listingHash(ck.tools));
    const info = s.repin("clickland", t.listing!);
    expect(info.drift).toBeUndefined();
    expect(info.note).toBeUndefined();
    expect((await s.remotes())[0]!.pin).toBe(listingHash(ck.tools));
  });

  it("repin needs a Check of this origin first, and a session's drift marks the card", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    expect(() => s.repin("clickland", "0".repeat(64))).toThrow(/Check it first/);
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
    expect(() => s.repin("clickland", listingHash(CLICKLAND_TOOLS))).toThrow(/Check it first/);
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

  it("D109, M4: moves the server Add Clickland made once, only as on as it was, keeping its pin only for the same tools", async () => {
    const ck = await up(new FakeClickland());
    type Old = { contexts: string[]; pin?: string };
    // mcp-servers.json as wave 6 left it: Add Clickland's server, and one typed by hand elsewhere.
    const move = (old: Old, o: { file?: string; clickland?: ClicklandSettingsStore } = {}) => {
      const svc = service(o);
      if (!o.clickland) svc.clickland.set({ url: ck.origin, key: CK_READ });
      const path = tempFile("mcp-servers.json");
      const server = (id: string, name: string, url: string, x: Old) => ({ id, name, url, appOrigins: [], contexts: x.contexts, listing: "a".repeat(64), ...(x.pin ? { autoRun: { pin: x.pin } } : {}) });
      writeFileSync(path, JSON.stringify({ servers: [server("s_made", "clickland", `${ck.origin}/api/mcp`, old), server("s_typed", "logs-elsewhere", "http://127.0.0.1:4799/api/mcp", { contexts: ["orbstack"], pin: "b".repeat(64) })] }));
      const st = new McpServerStore(path, fakeCrypto(true));
      const said: string[] = [];
      const moved = moveClicklandServer({ store: st, clickland: svc.clickland, family: svc.s, log: (l) => said.push(l) });
      return { ...svc, st, said, moved, path };
    };
    // On for one cluster, reads allowed for the listing Clickland still has: on everywhere, the pin kept, and the card
    // says it moved.
    const same = move({ contexts: ["orbstack"], pin: listingHash(CLICKLAND_TOOLS) });
    expect(same.moved).toBe(true);
    await same.s.settled();
    expect(same.st.list().map((x) => x.id)).toEqual(["s_typed"]);
    expect(same.s.info("clickland")).toMatchObject({ toSessions: true, readsAuto: true, tools: { read: 18, write: 5 }, note: FAMILY_NOTES.moved });
    expect(same.said.join("\n")).toContain("moved clickland");
    expect(same.logs.some((l) => l.includes("moved to the Land family"))).toBe(true);
    // A switch the person sets says the note was read.
    same.s.set("clickland", { readsAuto: true });
    expect(same.s.info("clickland").note).toBeUndefined();
    // Reads allowed for another listing than Clickland's now: nothing accepted unseen; the card asks for a Review.
    const other = move({ contexts: ["orbstack"], pin: "c".repeat(64) });
    await other.s.settled();
    expect(other.s.info("clickland")).toMatchObject({ toSessions: true, readsAuto: true, note: FAMILY_NOTES.unaccepted });
    expect(other.s.store.pin("clickland", ck.origin)).toBeUndefined();
    expect(other.logs.some((l) => l.includes("changed since you allowed them"))).toBe(true);
    // Off on every cluster: removed, and Tools for Claude stays off.
    const off = move({ contexts: [] });
    await off.s.settled();
    expect(off.st.list().map((x) => x.id)).toEqual(["s_typed"]);
    expect(off.s.info("clickland").toSessions).toBe(false);
    expect(off.s.store.pin("clickland", ck.origin)).toBeUndefined();
    // Once: after a move, Tools for Claude off and a server added again at that address, the next start moves nothing.
    same.s.set("clickland", { toSessions: false });
    const again = move({ contexts: ["orbstack"], pin: listingHash(CLICKLAND_TOOLS) }, { file: same.file, clickland: same.clickland });
    expect(again.moved).toBe(false);
    expect(again.st.list().map((x) => x.id)).toEqual(["s_made", "s_typed"]);
    expect(again.s.info("clickland").toSessions).toBe(false);
    // Without a Clickland key, nothing is moved.
    const bare = service();
    const path2 = tempFile("mcp-servers.json");
    writeFileSync(path2, JSON.stringify({ servers: [{ id: "s_made", name: "clickland", url: `${ck.origin}/api/mcp`, appOrigins: [], contexts: ["orbstack"] }] }));
    const st2 = new McpServerStore(path2, fakeCrypto(true));
    expect(moveClicklandServer({ store: st2, clickland: bare.clickland, family: bare.s })).toBe(false);
    expect(st2.list()).toHaveLength(1);
  });
});

describe("review of part 2", () => {
  const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
  const sessionsOf = (svc: McpService) => [...(svc.gateway as unknown as { sessions: Map<string, GatewaySession> }).sessions.values()];
  /** McpService over a FamilyService, with the family's pushes reaching it as index.ts wires them. */
  const withMcp = async (o: { store?: McpServerStore } = {}) => {
    let svc: McpService | undefined;
    const fam = service({ push: (i) => svc?.familyChanged(i) });
    const dir = mkdtempSync(join(tmpdir(), "landlens-fam-"));
    svc = new McpService({
      store: o.store ?? new McpServerStore(join(dir, "mcp-servers.json"), fakeCrypto(true)), clickland: fam.clickland,
      frontDoor: {} as never, clusters: { onGone: () => {} } as never, metrics: async () => { throw new Error("none"); }, push: () => {},
      ask: { confirm: async () => false, openExternal: async () => {} }, family: fam.s,
    });
    await svc.start();
    stops.push(() => svc!.stop());
    return { ...fam, svc };
  };

  it("M2: another key for the same Landflow, or another Landflow, leaves the open sessions that have the old one", async () => {
    const a = await up(new FakeLandflow());
    const b = await up(new FakeLandflow());
    const { s, svc } = await withMcp();
    await s.connectLandflow(a.origin, LF_KEY);
    s.set("landflow", { toSessions: true });
    await s.settled();
    // The same address, the same person, a new key: the switches stay, so nothing but M2 takes the old key out.
    let open = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
    let session = sessionsOf(svc)[0]!;
    expect(session.upstreams.has("landflow")).toBe(true);
    await s.connectLandflow(a.origin, LF_KEY_NARROW);
    expect(s.info("landflow").toSessions).toBe(true);
    expect(session.upstreams.has("landflow")).toBe(false);
    const sent = a.carrying(LF_KEY).length;
    expect((await svc.gateway.run(session, "landflow", "my_briefing", {}, "agent")).content).toEqual([{ type: "text", text: "Landlens: no MCP server named landflow in this session." }]);
    expect(a.carrying(LF_KEY).length).toBe(sent);
    await open.close();
    // A new session gets the new key.
    open = await svc.forSessions().open({ label: "agent 2 · orbstack", context: "orbstack", handle: "h", cluster });
    session = sessionsOf(svc)[0]!;
    expect(session.upstreams.has("landflow")).toBe(true);
    // Another Landflow: the old one's server leaves too, and neither saw the other's key.
    await s.connectLandflow(b.origin, LF_KEY);
    expect(session.upstreams.has("landflow")).toBe(false);
    expect(b.carrying(LF_KEY_NARROW)).toEqual([]);
    await open.close();
  });

  it("M3: Accept pins only the listing Review showed; a Check in between, or a session that found another, means Review again", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland } = service();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.set("clickland", { toSessions: true });
    await s.settled();
    const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: true } });
    const l2 = [...CLICKLAND_TOOLS, tool("export_a")];
    const l3 = [...CLICKLAND_TOOLS, tool("export_b")];
    ck.tools = l2;
    const review = await s.test("clickland");
    expect(review.listing).toBe(listingHash(l2));
    // The sibling changes again; a Check (the card's, or another window's) sees it.
    ck.tools = l3;
    const check = await s.test("clickland");
    expect(check.listing).toBe(listingHash(l3));
    // The open Review's Accept names L2: refused, and nothing is pinned.
    expect(() => s.repin("clickland", review.listing!)).toThrow(FAMILY_NOTES.reviewAgain);
    expect(s.store.pin("clickland", ck.origin)!.hash).toBe(listingHash(CLICKLAND_TOOLS));
    // A session found yet another listing: the last Check's can't be accepted either.
    s.drifted("clickland", listingHash([...CLICKLAND_TOOLS, tool("export_c")]));
    expect(() => s.repin("clickland", check.listing!)).toThrow(/Check it first/);
    // Reviewed again, and a session that found the same: accepted.
    const again = await s.test("clickland");
    s.drifted("clickland", again.listing);
    expect(s.repin("clickland", again.listing!).drift).toBeUndefined();
    expect(s.store.pin("clickland", ck.origin)!.hash).toBe(listingHash(l3));
  });

  it("L1: a server you added at a connected sibling's address, however it spells this machine, stays out of sessions", async () => {
    const lf = await up(new FakeLandflow());
    const dir = mkdtempSync(join(tmpdir(), "landlens-fam-"));
    const store = new McpServerStore(join(dir, "mcp-servers.json"), fakeCrypto(true));
    const mine = store.save({ name: "my-landflow", url: `${lf.origin.replace("127.0.0.1", "localhost")}/api/mcp`, header: { name: "Authorization", value: `Bearer ${LF_KEY}` } });
    store.enable(mine.id, "orbstack", true);
    const other = store.save({ name: "elsewhere", url: "http://127.0.0.1:1/mcp" });
    store.enable(other.id, "orbstack", true);
    const { s, svc } = await withMcp({ store });
    await s.connectLandflow(lf.origin, LF_KEY);
    const open = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
    expect(open.servers.map((x) => x.name)).toEqual(["landlens-kube", "elsewhere"]);
    expect((await svc.servers("orbstack")).servers.find((x) => x.name === "my-landflow")).toMatchObject({ status: "failed", detail: FAMILY_NOTES.siblingAddress });
    await open.close();
  });

  it("L2: a Check of one Landfall still waiting when another is signed in to sends that one none of the new tokens", async () => {
    const a = await up(new FakeLandfall());
    const b = await up(new FakeLandfall());
    const { s } = service();
    await s.signinLandfall(a.origin, {});
    await until(() => s.info("landfall").state === "ready");
    s.set("landfall", { toSessions: true });
    await s.settled();
    const release = a.hold("/mcp");
    const before = a.requests.filter((r) => r.path === "/mcp").length;
    const check = s.test("landfall");
    await until(() => a.requests.filter((r) => r.path === "/mcp").length > before);
    await s.signinLandfall(b.origin, {});
    await until(() => s.store.url("landfall") === b.origin && s.info("landfall").state === "ready");
    // A's token no longer counts there: its 401 makes the SDK ask the provider for tokens.
    a.valid.clear();
    release();
    await check;
    const fresh = b.issued.at(-1)!;
    expect(a.carrying(fresh.access)).toEqual([]);
    expect(a.carrying(fresh.refresh)).toEqual([]);
    expect(s.info("landfall").state).toBe("ready");
  });

  it("M6: a Landfall whose 401 names metadata on another origin gets nothing sent there, through the gateway", async () => {
    const lf = await up(new FakeLandfall());
    const elsewhere = await up(new FakeClickland());
    const { s, svc } = await withMcp();
    await s.signinLandfall(lf.origin, {});
    await until(() => s.info("landfall").state === "ready");
    s.set("landfall", { toSessions: true });
    await s.settled();
    const token = lf.issued.at(-1)!;
    lf.valid.clear();
    lf.metadataAt = `${elsewhere.origin}/.well-known/oauth-protected-resource/mcp`;
    const open = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
    const session = sessionsOf(svc)[0]!;
    // The SDK reads the metadata the 401 names before anything else: refused before it is asked. (It then refreshes at
    // Landfall's own origin, which is allowed.)
    await svc.gateway.run(session, "landfall", "list_incidents", {}, "agent");
    expect(lf.requests.length).toBeGreaterThan(0);
    expect(elsewhere.requests).toEqual([]);
    expect(elsewhere.carrying(token.access)).toEqual([]);
    await open.close();
  });

  it("L5: a listing with a tool name over 128 characters is refused, and the key stays stored", async () => {
    const lf = await up(new FakeLandflow());
    lf.extraTools = [{ name: `x${"y".repeat(199)}`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
    const { s, file } = service();
    await s.connectLandflow(lf.origin, LF_KEY);
    s.set("landflow", { toSessions: true });
    await s.settled();
    expect(s.store.pin("landflow", lf.origin)).toBeUndefined();
    const t = await s.test("landflow");
    expect(t.steps.at(-1)).toMatchObject({ name: "listing", ok: false, detail: FAMILY_NOTES.badListing });
    expect(s.store.landflowSecrets()?.key).toBe(LF_KEY);
    expect(s.store.damaged).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain('"landflow"');
    expect(() => s.store.setPin("landflow", { origin: lf.origin, hash: "a".repeat(64), tools: { [`x${"y".repeat(199)}`]: "b".repeat(16) }, read: 1, write: 0 })).toThrow(FAMILY_NOTES.badListing);
  });

  it("L6: a push that changes nothing sessions get leaves Preview open; one that does closes it", async () => {
    const ck = await up(new FakeClickland());
    const { s, clickland, svc } = await withMcp();
    clickland.set({ url: ck.origin, key: CK_READ });
    s.set("clickland", { toSessions: true });
    await s.settled();
    let closed = 0;
    const consoles = (svc as unknown as { consoles: Map<string, Promise<unknown>> }).consoles;
    const fake = () => consoles.set("h", Promise.resolve({ session: { close: async () => void closed++, init: { context: "orbstack" } }, revoke: () => {} }));
    svc.familyChanged(s.info("clickland"));
    fake();
    // A who-am-I's or a Check's push: the same for sessions.
    svc.familyChanged(s.info("clickland"));
    await s.test("clickland");
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(0);
    expect(consoles.has("h")).toBe(true);
    // Reads off: Preview is opened again as the sibling is now.
    s.set("clickland", { readsAuto: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(1);
  });

  it("L7: a session opens without main listing the sibling first", async () => {
    const lf = await up(new FakeLandflow());
    const first = service();
    await first.s.connectLandflow(lf.origin, LF_KEY);
    first.s.set("landflow", { toSessions: true });
    await first.s.settled();
    // A fresh start: nothing listed in memory.
    const { s } = service({ file: first.file, clickland: first.clickland });
    const before = lf.requests.filter((r) => r.path === "/api/mcp").length;
    const [spec] = await s.remotes();
    expect(lf.requests.filter((r) => r.path === "/api/mcp").length).toBe(before);
    expect(spec).toMatchObject({ name: "landflow", pin: s.store.pin("landflow", lf.origin)!.hash, pinTools: s.store.pin("landflow", lf.origin)!.tools });
  });

  it("L8: a changed listing is still said after a restart, until a Check finds the accepted one again", async () => {
    const ck = await up(new FakeClickland());
    const first = service();
    first.clickland.set({ url: ck.origin, key: CK_READ });
    first.s.set("clickland", { toSessions: true });
    await first.s.settled();
    first.s.drifted("clickland", "d".repeat(64));
    const { s } = service({ file: first.file, clickland: first.clickland });
    expect(s.info("clickland")).toMatchObject({ drift: true, note: FAMILY_NOTES.drift });
    expect(s.servers()[0]).toMatchObject({ autoRun: false });
    await s.test("clickland");
    expect(s.info("clickland").drift).toBeUndefined();
  });
});
