import { CONN_NOTES, McpServerInput, type ConnInfo } from "@landlens/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppViews, viewCsp, VIEW_HEADERS } from "../src/main/app-views";
import { ClicklandSettingsStore, type Crypto } from "../src/main/clickland-settings";
import { CSP_PROD } from "../src/main/csp";
import { listingHash, readTools, testRemote, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
import { FakeProvider, listing } from "../../../packages/connections/test/fake-provider";
import { McpService } from "../src/main/mcp";
import type { GcpReader } from "@landlens/gcp-mcp";
import { DRIFT_NOTE, McpServerStore } from "../src/main/mcp-store";

const SECRET = "Bearer k_live_abcdefghijklmnopqrstuvwxyz";
const fake = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...s].reverse().join("") + "#enc"),
  decryptString: (b) => [...b.toString().replace(/#enc$/, "")].reverse().join(""),
});
const store = (crypto = fake()) => {
  const path = join(mkdtempSync(join(tmpdir(), "landlens-mcp-")), "mcp-servers.json");
  return { path, s: new McpServerStore(path, crypto) };
};

describe("the MCP server store", () => {
  it("keeps a header value encrypted, out of every view, and gives it only to main's connection", () => {
    const { path, s } = store();
    const saved = s.save({ name: "clickland", url: "http://127.0.0.1:4730/api/mcp", header: { name: "Authorization", value: SECRET } });
    const file = readFileSync(path, "utf8");
    expect(file).not.toContain("k_live_abcdefghijklmnopqrstuvwxyz");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(s.list("orbstack"))).not.toContain("k_live");
    expect(s.info(saved.id)).toMatchObject({ header: { name: "Authorization", stored: true }, enabled: false, builtin: false });
    expect(s.remotesFor("orbstack")).toEqual([]);
    s.enable(saved.id, "orbstack", true);
    expect(s.remotesFor("orbstack")).toEqual([{ id: saved.id, name: "clickland", url: "http://127.0.0.1:4730/api/mcp", headers: { Authorization: SECRET } }]);
    expect(s.info(saved.id).autoRun).toBe(false); // nothing it says about itself runs without asking by default
    expect(s.remotesFor("other")).toEqual([]);
  });

  it("keeps the stored value when the header is saved again without one, and drops it when the name changes", () => {
    const { s } = store();
    const a = s.save({ name: "a", url: "https://mcp.example.com/mcp", header: { name: "X-Api-Key", value: "v1" } });
    s.save({ id: a.id, name: "a", url: "https://mcp.example.com/mcp", header: { name: "x-api-key" } });
    expect(s.headerValue(a.id)).toBe("v1");
    s.save({ id: a.id, name: "a", url: "https://mcp.example.com/mcp", header: { name: "X-Other" } });
    expect(s.headerValue(a.id)).toBeUndefined();
    expect(() => s.save({ name: "a", url: "https://x.example.com/mcp" })).toThrow(/already a server named a/);
  });

  it("binds a stored value to its origin: another path keeps it, another host or port drops it", () => {
    const { s } = store();
    const a = s.save({ name: "a", url: "https://mcp.example.com/mcp", header: { name: "Authorization", value: SECRET } });
    s.save({ id: a.id, name: "a", url: "https://mcp.example.com/v2/mcp", header: { name: "Authorization" } });
    expect(s.headerValue(a.id)).toBe(SECRET);
    for (const elsewhere of ["https://evil.example/mcp", "https://mcp.example.com:8443/v2/mcp", "http://127.0.0.1:4730/mcp"]) {
      const b = s.save({ name: `b${elsewhere.length}`, url: "https://mcp.example.com/mcp", header: { name: "Authorization", value: SECRET } });
      const moved = s.save({ id: b.id, name: b.name, url: elsewhere, header: { name: "Authorization" } });
      expect(s.headerValue(moved.id)).toBeUndefined();
      expect(s.info(moved.id).header).toEqual({ name: "Authorization", stored: false });
    }
  });

  it("runs read-only tools without asking only once you turn it on for the listing you saw, and stops when it changes", () => {
    const { s } = store();
    const a = s.save({ name: "a", url: "https://mcp.example.com/mcp", header: { name: "Authorization", value: SECRET } });
    s.enable(a.id, "orbstack", true);
    expect(() => s.setAutoRun(a.id, true)).toThrow(/Test it first/);
    s.status(a.id, { status: "ready", tools: [{ name: "list", readOnly: true, visibility: ["model"], required: [] }], listing: "h1" });
    expect(s.setAutoRun(a.id, true, "orbstack")).toMatchObject({ autoRun: true, enabled: true });
    expect(s.remotesFor("orbstack")[0]).toMatchObject({ pin: "h1" });
    // The same listing again changes nothing; another one turns it off and says why.
    s.status(a.id, { status: "ready", listing: "h1" });
    expect(s.info(a.id).autoRun).toBe(true);
    s.status(a.id, { status: "ready", listing: "h2" });
    expect(s.info(a.id)).toMatchObject({ autoRun: false, autoRunNote: DRIFT_NOTE });
    expect(s.remotesFor("orbstack")[0]!.pin).toBeUndefined();
    s.setAutoRun(a.id, true);
    expect(s.remotesFor("orbstack")[0]).toMatchObject({ pin: "h2" });
    expect(s.info(a.id).autoRunNote).toBeUndefined();
    // A session that saw another listing does the same.
    s.drifted(a.id);
    expect(s.info(a.id)).toMatchObject({ autoRun: false, autoRunNote: DRIFT_NOTE });
    // A new address or credential means you haven't seen its tools yet.
    s.setAutoRun(a.id, true);
    s.save({ id: a.id, name: "a", url: "https://mcp.example.com/other", header: { name: "Authorization" } });
    expect(s.info(a.id).autoRun).toBe(false);
    expect(() => s.setAutoRun(a.id, true)).toThrow(/Test it first/);
  });

  it("refuses the names Connections serves; a server already saved under one keeps it", async () => {
    const { path, s } = store();
    for (const name of ["github", "linear", "landlens-gcp"]) {
      expect(() => s.save({ name, url: "https://mcp.example.com/mcp" })).toThrow("That name is used by Connections.");
      try {
        s.save({ name, url: "https://mcp.example.com/mcp" });
      } catch (e) {
        expect((e as { status?: number }).status).toBe(409);
      }
    }
    const a = s.save({ name: "mine", url: "https://mcp.example.com/mcp" });
    expect(() => s.save({ id: a.id, name: "github", url: "https://mcp.example.com/mcp" })).toThrow("That name is used by Connections.");
    // One saved before wave 6 keeps its name when it is edited.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify({ servers: [{ id: "s_old", name: "github", url: "https://mcp.example.com/mcp", appOrigins: [], contexts: [] }] }));
    expect(s.save({ id: "s_old", name: "github", url: "https://mcp.example.com/v2" }).name).toBe("github");
  });

  it("won't store a header it can't encrypt", () => {
    const { s } = store(fake(false));
    expect(() => s.save({ name: "a", url: "https://mcp.example.com/mcp", header: { name: "Authorization", value: "x" } })).toThrow(/can't encrypt/);
  });

  it("accepts only remote servers over https, or http on this machine, with safe names and headers", () => {
    const ok = (v: unknown) => McpServerInput.safeParse(v).success;
    expect(ok({ name: "clickland", url: "http://127.0.0.1:4710/api/mcp" })).toBe(true);
    expect(ok({ name: "linear", url: "https://mcp.linear.app/mcp", header: { name: "Authorization", value: "Bearer x" } })).toBe(true);
    expect(ok({ name: "x", url: "http://mcp.example.com/mcp" })).toBe(false); // plain http off this machine
    expect(ok({ name: "landlens-kube", url: "https://a.example.com" })).toBe(false);
    expect(ok({ name: "Bad Name", url: "https://a.example.com" })).toBe(false);
    expect(ok({ name: "a1", url: "file:///etc/passwd" })).toBe(false);
    expect(ok({ name: "a1", url: "https://a.example.com", header: { name: "Host", value: "x" } })).toBe(false);
    expect(ok({ name: "a1", url: "https://a.example.com", header: { name: "Cookie", value: "x" } })).toBe(false);
    expect(ok({ name: "a1", url: "https://a.example.com", header: { name: "X-Landlens-Call", value: "x" } })).toBe(false);
    expect(ok({ name: "a1", url: "https://a.example.com", header: { name: "Authorization", value: "a\r\nb" } })).toBe(false);
  });
});

describe("MCP App views on landlens-app:", () => {
  const none = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };

  it("serves a live view only at its own address, under its own CSP, with no network by default", () => {
    const views = new AppViews();
    const v = views.add({ call: "c1", server: "landlens-kube", tool: "describe", html: "<!doctype html><p>hi</p>", csp: viewCsp(none, []) });
    const url = AppViews.url(v.id);
    expect(url).toMatch(/^landlens-app:\/\/view\/[0-9a-f]{32}$/);
    const r = views.respond("GET", url);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<!doctype html><p>hi</p>");
    expect(r.headers).toMatchObject(VIEW_HEADERS);
    const csp = r.headers["Content-Security-Policy"]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("webrtc 'block'");
    expect(r.headers["X-DNS-Prefetch-Control"]).toBe("off");
    expect(csp).not.toMatch(/unsafe-eval|https?:|\*/);
    for (const bad of [`${url}?x=1`, `${url}/`, url.replace("view", "other"), "landlens-app://view/" + "0".repeat(32), "https://view/" + v.id, "nonsense"]) {
      expect(views.respond("GET", bad).status).toBe(404);
      expect(views.isViewUrl(bad)).toBe(false);
    }
    expect(views.respond("POST", url).status).toBe(404);
    expect(views.isViewUrl(url)).toBe(true);
    views.close(v.id);
    expect(views.respond("GET", url).status).toBe(404);
  });

  it("opens the network only to https origins the resource declares and you allowed for its server", () => {
    const csp = viewCsp({ ...none, connectDomains: ["https://api.example.com", "https://evil.example", "http://plain.example", "*", "https://a.example.com/path"], resourceDomains: ["https://cdn.example"] }, ["https://api.example.com", "https://a.example.com/path"]);
    expect(csp).toContain("connect-src https://api.example.com;");
    expect(csp).not.toContain("evil");
    expect(csp).not.toContain("cdn.example");
    expect(csp).toContain("img-src data:");
  });

  it("limits a view to 60 tool calls a minute", () => {
    const views = new AppViews();
    const v = views.add({ call: "c1", server: "s", tool: "t", html: "", csp: "" });
    for (let i = 0; i < 60; i++) expect(views.allowCall(v.id, 0)).toBe(true);
    expect(views.allowCall(v.id, 1)).toBe(false);
    expect(views.allowCall(v.id, 60_000)).toBe(true);
    expect(views.allowCall("nope")).toBe(false);
  });

  it("leaves the renderer's CSP as it was but for framing views", () => {
    expect(CSP_PROD).toContain("frame-src landlens-app:;");
    expect(CSP_PROD).toContain("script-src 'self';");
    expect(CSP_PROD).toContain("connect-src 'self';");
    expect(CSP_PROD).not.toContain("unsafe-eval");
  });
});

describe("McpService", () => {
  const service = (asked: { n: number; answer: () => Promise<boolean> }) => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-svc-"));
    const st = new McpServerStore(join(dir, "mcp-servers.json"), fake());
    const svc = new McpService({
      store: st,
      clickland: new ClicklandSettingsStore(join(dir, "clickland.json"), fake()),
      frontDoor: {} as never,
      clusters: { onGone: () => {} } as never,
      metrics: async () => { throw new Error("no metrics"); },
      push: () => {},
      ask: { confirm: () => (asked.n++, asked.answer()), openExternal: async () => {} },
    });
    return { st, svc };
  };

  it("Test never sends a stored header value to another origin or under another header name", async () => {
    const seen: { url: string; auth?: string; other?: string }[] = [];
    const srv = createServer((req, res) => {
      seen.push({ url: req.url ?? "", ...(req.headers.authorization ? { auth: String(req.headers.authorization) } : {}), ...(req.headers["x-other"] ? { other: String(req.headers["x-other"]) } : {}) });
      res.writeHead(401).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const { st, svc } = service({ n: 0, answer: async () => false });
      const a = st.save({ name: "a", url: `${base}/mcp`, header: { name: "Authorization", value: SECRET } });
      const moved = await svc.test({ id: a.id, url: "http://localhost:1/mcp" });
      expect(moved).toMatchObject({ ok: false, steps: [{ name: "header", ok: false }] });
      const renamed = await svc.test({ id: a.id, header: { name: "X-Other" } });
      expect(renamed.ok).toBe(false);
      expect(seen).toEqual([]);
      // The same origin, another path: the stored value goes, and the page hears only Landlens's own words.
      const same = await svc.test({ id: a.id, url: `${base}/v2/mcp` });
      expect(same.steps[0]).toMatchObject({ ok: false, detail: "The server refused the credentials (401)." });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((x) => x.auth === SECRET && x.url === "/v2/mcp" && !x.other)).toBe(true);
      // A test of another address doesn't change what's saved.
      expect(st.info(a.id).status).toBe("unknown");
    } finally {
      srv.close();
    }
  });

  it("gives sessions the connections after your servers, names them for the prompt, and sends their drift back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-svc-"));
    const st = new McpServerStore(join(dir, "mcp-servers.json"), fake());
    const mine = st.save({ name: "mine", url: "http://127.0.0.1:1/mcp" });
    st.enable(mine.id, "orbstack", true);
    const drifted: string[] = [];
    const conn: RemoteSpec = { name: "github", url: "http://127.0.0.1:1/mcp/", pin: "0".repeat(64), provider: { id: "github", readTools: new Set(), mode: "ask", readsAuto: true } };
    const svc = new McpService({
      store: st,
      clickland: new ClicklandSettingsStore(join(dir, "clickland.json"), fake()),
      frontDoor: {} as never,
      clusters: { onGone: () => {} } as never,
      metrics: async () => { throw new Error("no metrics"); },
      push: () => {},
      ask: { confirm: async () => false, openExternal: async () => {} },
      connections: {
        remotes: async () => [conn],
        servers: () => [{ id: "github", name: "github", builtin: false, connection: "github", url: conn.url, enabled: true, autoRun: true, appOrigins: [], status: "ready" }],
        drifted: (p) => drifted.push(p),
      },
    });
    await svc.start();
    try {
      const listed = await svc.servers("orbstack");
      expect(listed.servers.map((x) => x.name)).toEqual(["landlens-kube", "github", "mine"]);
      const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
      const s = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
      expect(s.servers.map((x) => x.name)).toEqual(["landlens-kube", "mine", "github"]);
      expect(s.providers).toEqual(["GitHub"]);
      // Nothing answers at the connection's address, so its listing isn't said to have changed.
      expect(drifted).toEqual([]);
      await s.close();
      (svc.gateway as unknown as { opts: { onDrift: (s: RemoteSpec) => void } }).opts.onDrift(conn);
      expect(drifted).toEqual(["github"]);
    } finally {
      await svc.stop();
    }
  });

  it("gives sessions landlens-gcp, allowed whole, only while Claude may read Google Cloud; off leaves them at once (D93)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-svc-"));
    let on = false;
    const reader: GcpReader = {
      projects: async () => [{ id: "demo-shop", name: "Demo Shop" }], types: async () => ({ types: [], total: 0, cut: false }),
      resources: async () => ({ items: [], total: 0, cut: false }), resource: async () => { throw new Error("none"); },
      clusters: async () => ({ clusters: [], errors: [] }), connected: () => false,
    };
    const svc = new McpService({
      store: new McpServerStore(join(dir, "mcp-servers.json"), fake()),
      clickland: new ClicklandSettingsStore(join(dir, "clickland.json"), fake()),
      frontDoor: {} as never,
      clusters: { onGone: () => {} } as never,
      metrics: async () => { throw new Error("no metrics"); },
      push: () => {},
      ask: { confirm: async () => false, openExternal: async () => {} },
      gcp: { reader: async () => (on ? { reader, projects: ["demo-shop"] } : undefined) },
    });
    await svc.start();
    try {
      const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
      const off = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
      expect(off.servers.map((x) => x.name)).toEqual(["landlens-kube"]);
      expect(off.gcp).toBeUndefined();
      await off.close();
      expect((await svc.servers("orbstack")).servers.map((x) => x.name)).toEqual(["landlens-kube"]);
      on = true;
      const s = await svc.forSessions().open({ label: "agent 2 · orbstack", context: "orbstack", handle: "h", cluster });
      expect(s.servers.map((x) => x.name)).toEqual(["landlens-kube", "landlens-gcp"]);
      expect(s.allow).toEqual(["mcp__landlens-kube", "mcp__landlens-gcp"]);
      expect(s.gcp).toEqual(["demo-shop"]);
      const page = (await svc.servers("orbstack")).servers.find((x) => x.name === "landlens-gcp")!;
      expect(page).toMatchObject({ builtin: true, connection: "gcp", status: "ready" });
      expect(page.tools!.every((t) => t.readOnly)).toBe(true);
      const list = () => fetch(s.servers[1]!.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: s.servers[1]!.headers[0]!.value }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect((await list()).status).toBe(200);
      svc.gcpOff();
      expect((await list()).status).toBe(404);
      await s.close();
    } finally {
      await svc.stop();
    }
  });

  it("M2 (review of part 2): a connection's change reaches open sessions at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-svc-"));
    const st = new McpServerStore(join(dir, "mcp-servers.json"), fake());
    const conn: RemoteSpec = { name: "github", url: "http://127.0.0.1:1/mcp/", provider: { id: "github", readTools: new Set(["list_issues"]), mode: "ask", readsAuto: true } };
    const svc = new McpService({
      store: st,
      clickland: new ClicklandSettingsStore(join(dir, "clickland.json"), fake()),
      frontDoor: {} as never,
      clusters: { onGone: () => {} } as never,
      metrics: async () => { throw new Error("no metrics"); },
      push: () => {},
      ask: { confirm: async () => false, openExternal: async () => {} },
      connections: { remotes: async () => [conn], servers: () => [], drifted: () => {} },
    });
    await svc.start();
    try {
      const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
      const open = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
      open.bind("acp-m2");
      const session = () => [...(svc.gateway as unknown as { sessions: Map<string, GatewaySession> }).sessions.values()].find((x) => x.acpSession === "acp-m2")!;
      // Two unused yeses for a write (an "always" for a connection's write is one call's yes since part 3's review, M1).
      svc.gateway.permit("acp-m2", { toolCallId: "t2", toolName: "mcp__github__issue_write", always: false });
      svc.gateway.permit("acp-m2", { toolCallId: "t3", toolName: "mcp__github__issue_write", always: false });
      const info = { provider: "github" as const, state: "ready" as const, mode: "ask" as const, readsAuto: true, give: true };
      svc.connectionChanged(info);
      expect(session().takePermit("mcp__github__issue_write", "t2")).toBe(true); // nothing changed: the yes stands
      svc.connectionChanged({ ...info, readsAuto: false });
      expect(session().takePermit("mcp__github__issue_write", "t3")).toBe(false);
      expect(session().upstreams.has("github")).toBe(true);
      svc.connectionChanged({ ...info, mode: "read" });
      expect(session().upstreams.has("github")).toBe(false);
      await open.close();
    } finally {
      await svc.stop();
    }
  });

  it("autonomous (part 3): turned on only for a connection ready at Ask for writes; a change to it stops it at once", async () => {
    const TOKEN = `ghp_${"A".repeat(36)}`;
    const fp = await new FakeProvider("github").start();
    fp.valid.add(TOKEN);
    const dir = mkdtempSync(join(tmpdir(), "landlens-svc-"));
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const full = await testRemote({ name: "github", url: `${fp.origin}/mcp/`, headers, noViews: true });
    const ro = await testRemote({ name: "github", url: `${fp.origin}/mcp/readonly`, headers, noViews: true });
    const gh = listing("github");
    const conn: RemoteSpec = {
      name: "github", url: `${fp.origin}/mcp/`, headers, origins: [fp.origin], noViews: true,
      pin: listingHash(full.tools!), readUrl: `${fp.origin}/mcp/readonly`, readPin: listingHash(ro.tools!),
      provider: { id: "github", readTools: readTools(gh.full, gh.readonly), mode: "ask", readsAuto: true },
    };
    let info: ConnInfo = { provider: "github", state: "ready", mode: "ask", readsAuto: true, give: true } as ConnInfo;
    const pushed: unknown[] = [];
    const svc = new McpService({
      store: new McpServerStore(join(dir, "mcp-servers.json"), fake()),
      clickland: new ClicklandSettingsStore(join(dir, "clickland.json"), fake()),
      frontDoor: {} as never,
      clusters: { onGone: () => {} } as never,
      metrics: async () => { throw new Error("no metrics"); },
      push: () => {},
      pushAutonomy: (s) => pushed.push(s),
      ask: { confirm: async () => false, openExternal: async () => {} },
      connections: { remotes: async () => [conn], servers: () => [], drifted: () => {}, info: () => info },
    });
    await svc.start();
    const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
    const scope = { repos: ["landfalls-ai/landlens"] };
    try {
      const open = await svc.forSessions().open({ label: "agent 1 · orbstack", context: "orbstack", handle: "h", cluster });
      open.bind("acp-auto");
      expect(svc.autonomyStates("acp-auto")).toMatchObject([{ provider: "github", on: false, mode: "ask" }]);
      // Not while the connection is read only, not given to sessions, or its tools need a look.
      for (const c of [{ mode: "read" }, { give: false }, { state: "expired" }, { note: CONN_NOTES.drift }] as Partial<ConnInfo>[]) {
        info = { ...info, ...c } as ConnInfo;
        expect(() => svc.setAutonomy("acp-auto", "github", true, scope)).toThrow(/isn't connected|read only|need a look/);
        info = { provider: "github", state: "ready", mode: "ask", readsAuto: true, give: true } as ConnInfo;
      }
      expect(svc.setAutonomy("acp-auto", "github", true, scope)).toMatchObject({ on: true, used: 0, budget: 20 });
      // Reads off leaves it on; Read only stops it ("you"); a listing found changed stops it ("drift").
      svc.connectionChanged({ ...info, readsAuto: false });
      expect(svc.autonomyStates("acp-auto")[0]!.on).toBe(true);
      svc.connectionChanged({ ...info, mode: "read" });
      expect(svc.autonomyStates("acp-auto")[0]).toMatchObject({ on: false, offBecause: "you" });
      await open.close();
      const again = await svc.forSessions().open({ label: "agent 2 · orbstack", context: "orbstack", handle: "h", cluster });
      again.bind("acp-auto2");
      expect(svc.autonomyStates("acp-auto2")[0]!.on).toBe(false); // never stored: a new session starts off
      svc.setAutonomy("acp-auto2", "github", true, scope);
      svc.connectionChanged({ ...info, note: CONN_NOTES.drift });
      expect(svc.autonomyStates("acp-auto2")[0]).toMatchObject({ on: false, offBecause: "drift" });
      expect(pushed.length).toBeGreaterThanOrEqual(4); // each change reached the dock
      await again.close();
    } finally {
      await svc.stop();
      await fp.stop();
    }
  });

  it("asks about one view link at a time, at most three a minute per view", async () => {
    let release: (v: boolean) => void = () => {};
    const asked = { n: 0, answer: () => new Promise<boolean>((r) => (release = r)) };
    const { svc } = service(asked);
    const v = svc.views.add({ call: "c1", server: "s", tool: "t", html: "", csp: "" });
    const first = svc.viewLink(v.id, "https://example.com/a");
    await expect(svc.viewLink(v.id, "https://example.com/b")).rejects.toMatchObject({ status: 429 });
    release(false);
    expect(await first).toBe(false);
    asked.answer = async () => false;
    expect(await svc.viewLink(v.id, "https://example.com/c")).toBe(false);
    expect(await svc.viewLink(v.id, "https://example.com/d")).toBe(false);
    await expect(svc.viewLink(v.id, "https://example.com/e")).rejects.toMatchObject({ status: 429 });
    expect(asked.n).toBe(3);
    await expect(svc.viewLink(v.id, "http://example.com/")).rejects.toMatchObject({ status: 429 });
    const w = svc.views.add({ call: "c2", server: "s", tool: "t", html: "", csp: "" });
    await expect(svc.viewLink(w.id, "http://example.com/")).rejects.toMatchObject({ status: 400 });
  });
});
