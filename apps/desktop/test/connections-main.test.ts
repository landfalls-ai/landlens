import { CONN_NOTES } from "@landlens/contracts";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Clock, Crypto } from "@landlens/connections";
import { connectionOverrides, ConnectionsService, flowOwners, readTools } from "../src/main/connections";
import { FakeProvider, listing, type FakeOptions } from "../../../packages/connections/test/fake-provider";
import { fakeCrypto, GH_TOKEN, LIN_KEY, tempFile } from "../../../packages/connections/test/helpers";

let fakes: FakeProvider[] = [];
const fake = async (vendor: "github" | "linear", o: FakeOptions = {}) => {
  const f = await new FakeProvider(vendor, o).start();
  fakes.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
  fakes = [];
});

const instantClock = { now: () => 0, sleep: async () => {} };

function service(o: { github?: FakeProvider; linear?: FakeProvider; clientId?: string; canStore?: boolean; taken?: string[]; fetch?: typeof fetch; crypto?: Crypto; clock?: Clock } = {}) {
  const file = tempFile("connections.json");
  const opened: string[] = [];
  const pushed: unknown[] = [];
  const logs: string[] = [];
  const browser = async (url: string) => {
    opened.push(url);
    const r = await fetch(url, { redirect: "manual" });
    const back = r.headers.get("location");
    if (back) await fetch(back);
  };
  const s = new ConnectionsService({
    file,
    crypto: o.crypto ?? fakeCrypto(o.canStore ?? true),
    overrides: { ...(o.github ? { github: o.github.origin } : {}), ...(o.linear ? { linear: o.linear.origin } : {}), ...(o.clientId ? { githubClientId: o.clientId } : {}) },
    openExternal: browser,
    push: (i) => pushed.push(i),
    log: (l) => logs.push(l),
    clock: o.clock ?? instantClock,
    ...(o.taken ? { takenNames: () => o.taken! } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { s, file, opened, pushed, logs };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

describe("the connections service", () => {
  it("connects GitHub with a pasted token; conn:list and every push carry no token", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s, file, pushed } = service({ github: gh });
    const info = await s.token("github", GH_TOKEN);
    expect(info).toMatchObject({ provider: "github", state: "ready", method: "token", account: { login: "octo-person" }, canDevice: false, mode: "ask", readsAuto: true });
    const everything = JSON.stringify([s.list(), pushed]) + readFileSync(file, "utf8");
    expect(everything).not.toContain(GH_TOKEN);
    expect(everything).not.toContain(gh.origin);
    // The token went to /user, then to the two MCP endpoints to list the tools you accept on connecting.
    expect(new Set(gh.carrying(GH_TOKEN).map((q) => q.path))).toEqual(new Set(["/user", "/mcp/", "/mcp/readonly"]));
    expect(gh.carrying(GH_TOKEN)[0]!.path).toBe("/user");
  });

  it("stores nothing for a token the provider refuses", async () => {
    const gh = await fake("github");
    const { s } = service({ github: gh });
    expect(await s.token("github", GH_TOKEN)).toMatchObject({ state: "failed", note: CONN_NOTES.githubRefused });
    expect(s.store.secrets("github")).toBeUndefined();
  });

  it("refuses to connect when the machine can't encrypt", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s } = service({ github: gh, canStore: false, clientId: "Ov23liTestClient0001" });
    expect(s.list().canStore).toBe(false);
    await expect(s.token("github", GH_TOKEN)).rejects.toThrow(CONN_NOTES.cantStore);
    await expect(s.githubDevice({})).rejects.toThrow(CONN_NOTES.cantStore);
    expect(gh.requests).toEqual([]);
  });

  it("offers the device flow only with a client id, and finishes it in the background", async () => {
    const gh = await fake("github", { device: ["authorization_pending", "token"] });
    await expect(service({ github: gh }).s.githubDevice({})).rejects.toThrow(CONN_NOTES.noDevice);
    const { s, pushed } = service({ github: gh, clientId: "Ov23liTestClient0001" });
    expect(s.info("github").canDevice).toBe(true);
    const r = await s.githubDevice({});
    expect(r).toMatchObject({ flow: expect.stringMatching(/^fl[A-Za-z0-9_-]{16}$/), userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" });
    await until(() => (pushed.at(-1) as { state?: string } | undefined)?.state === "ready");
    expect(s.info("github")).toMatchObject({ method: "device", account: { login: "octo-person" } });
    expect(pushed.at(-1)).toMatchObject({ provider: "github", state: "ready" });
    expect(JSON.stringify(pushed)).not.toContain(gh.deviceToken);
  });

  it("runs one sign-in per provider, cancelled only by the window that started it", async () => {
    const gh = await fake("github", { device: ["authorization_pending"] });
    const { s } = service({ github: gh, clientId: "Ov23liTestClient0001" });
    // A clock that never lets the poll finish while the test looks at it.
    (s as unknown as { o: { clock: unknown } }).o.clock = { now: () => 0, sleep: (_ms: number, signal: AbortSignal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))) };
    const win = {};
    const { flow } = await s.githubDevice(win);
    expect(s.info("github").state).toBe("connecting");
    await expect(s.githubDevice(win)).rejects.toThrow(/already running/);
    expect(() => s.cancel(flow, {})).toThrow("No such sign-in.");
    s.cancelFor({});
    expect(s.info("github").state).toBe("connecting");
    s.cancelFor(win);
    expect(s.info("github").state).toBe("off");
  });

  it("signs in to Linear in the browser, opening only Linear's own address", async () => {
    const lin = await fake("linear");
    const { s, opened } = service({ linear: lin });
    const { flow } = await s.linearSignIn("read", {});
    expect(flow).toMatch(/^fl/);
    await until(() => s.info("linear").state === "ready");
    expect(opened.map((u) => new URL(u).origin + new URL(u).pathname)).toEqual([`${lin.origin}/authorize`]);
    expect(s.info("linear")).toMatchObject({ method: "oauth", mode: "read", scopes: ["read"], account: { login: "lin@example.com" } });
    // Switching to Ask for writes on a read-only sign-in says it needs signing in again.
    expect(s.set("linear", { mode: "ask" }).note).toBe(CONN_NOTES.linearReadScope);
    const file = readFileSync((s as unknown as { o: { file: string } }).o.file, "utf8");
    expect(file).not.toMatch(/lin_oauth_|lin_refresh_|client_/);
  });

  it("leaves the account out when Linear's API won't take the MCP token", async () => {
    const lin = await fake("linear", { graphqlKeysOnly: true });
    const { s } = service({ linear: lin });
    await s.linearSignIn("ask", {});
    await until(() => s.info("linear").state === "ready");
    expect(s.info("linear").account).toBeUndefined();
  });

  it("lists both endpoints on test, counts reads by the read-only listing, and pins on repin", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s } = service({ github: gh });
    expect(() => s.repin("github")).toThrow(/Test it first/);
    await s.token("github", GH_TOKEN);
    const t = await s.test("github");
    expect(t.ok).toBe(true);
    const l = listing("github");
    expect(t.tools!.filter((x) => x.readOnly).length).toBe(l.readonly.length);
    expect(t.tools!.find((x) => x.name === "merge_pull_request")!.readOnly).toBe(false);
    const mcp = gh.requests.filter((q) => q.path.startsWith("/mcp"));
    expect(new Set(mcp.map((q) => q.path))).toEqual(new Set(["/mcp/", "/mcp/readonly"]));
    expect(mcp.every((q) => q.authorization === `Bearer ${GH_TOKEN}`)).toBe(true);
    const info = s.repin("github");
    expect(info.tools).toEqual({ read: l.readonly.length, write: l.full.length - l.readonly.length });
    expect(s.store.pin("github")).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  });

  it("disconnects, revoking Linear's grant first", async () => {
    const lin = await fake("linear");
    const { s } = service({ linear: lin });
    await s.linearSignIn("ask", {});
    await until(() => s.info("linear").state === "ready");
    const { access, refresh } = s.store.secrets("linear")!;
    expect(await s.disconnect("linear")).toMatchObject({ state: "off", mode: "ask" });
    // Both tokens, the access token first (Fable's L3).
    expect(lin.revoked).toEqual([access, refresh]);
    expect(s.store.secrets("linear")).toBeUndefined();
  });

  it("connects Linear with a pasted key", async () => {
    const lin = await fake("linear");
    lin.valid.add(LIN_KEY);
    const { s } = service({ linear: lin });
    expect(await s.token("linear", LIN_KEY)).toMatchObject({ state: "ready", method: "token", account: { login: "lin@example.com", org: "Landfalls" } });
  });
});

describe("the provider overrides", () => {
  const env = { LANDLENS_GITHUB_ENDPOINT: "http://127.0.0.1:4100", LANDLENS_LINEAR_ENDPOINT: "http://127.0.0.1:4200", LANDLENS_GITHUB_CLIENT_ID: "Ov23liTestClient0001" };
  it("are read only when the app isn't packaged", () => {
    expect(connectionOverrides(env, true)).toEqual({});
    expect(connectionOverrides(env, false)).toEqual({ github: "http://127.0.0.1:4100", linear: "http://127.0.0.1:4200", githubClientId: "Ov23liTestClient0001" });
  });
  it("take only a loopback address", () => {
    for (const bad of ["https://api.github.com", "http://localhost:4100", "http://127.0.0.1:4100/x", "http://10.1.2.3:80"]) {
      expect(connectionOverrides({ LANDLENS_GITHUB_ENDPOINT: bad, LANDLENS_LINEAR_ENDPOINT: bad }, false)).toEqual({});
    }
  });
});

describe("reads and writes (D78)", () => {
  it("are told apart by the read-only listing, never by readOnlyHint", () => {
    const schema = { type: "object" as const, properties: { owner: { type: "string" } } };
    const full = [
      { name: "list_issues", inputSchema: schema },
      { name: "merge_pull_request", inputSchema: schema, annotations: { readOnlyHint: true } },
      { name: "changed", inputSchema: { ...schema, properties: { ...schema.properties, body: { type: "string" } } } },
    ];
    const ro = [{ name: "list_issues", inputSchema: { properties: { owner: { type: "string" } }, type: "object" as const } }, { name: "changed", inputSchema: schema }];
    expect(readTools(full, ro)).toEqual(new Set(["list_issues"]));
    expect(readTools(full, [])).toEqual(new Set());
  });
});

describe("connections on the gateway (part 2, D76–D80)", () => {
  const ghReads = () => new Set(listing("github").readonly.map((t) => t.name));

  it("gives sessions GitHub's full endpoint at Ask for writes: its headers, its origins, its reads, the accepted listing's half", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s } = service({ github: gh });
    const info = await s.token("github", GH_TOKEN);
    // Connecting lists both endpoints and accepts that listing: the card shows the tools you accepted.
    expect(info.tools).toEqual({ read: 25, write: 19 });
    expect(info.note).toBeUndefined();
    const [r, ...rest] = await s.remotes();
    expect(rest).toEqual([]);
    expect(r).toMatchObject({
      name: "github", url: `${gh.origin}/mcp/`, origins: [gh.origin],
      headers: { Authorization: `Bearer ${GH_TOKEN}`, "X-MCP-Toolsets": "repos,issues,pull_requests,actions", "X-MCP-Lockdown": "true" },
      provider: { id: "github", mode: "ask", readsAuto: true },
    });
    expect(r!.provider.readTools).toEqual(ghReads());
    expect(r!.pin).toBe(s.store.pin("github")!.split(".")[0]);
    // The MCP page lists it after landlens-kube, managed on the Connections page, reads marked by the read-only listing.
    const [srv] = s.servers();
    expect(srv).toMatchObject({ id: "github", name: "github", connection: "github", enabled: true, autoRun: true, status: "ready" });
    expect(srv!.tools!.filter((t) => t.readOnly).map((t) => t.name).sort()).toEqual([...ghReads()].sort());
    expect(JSON.stringify(s.servers())).not.toContain(GH_TOKEN);
  });

  it("serves the read-only endpoint at Read only, and nothing when Give to Claude sessions is off", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s } = service({ github: gh });
    await s.token("github", GH_TOKEN);
    s.set("github", { mode: "read" });
    const [r] = await s.remotes();
    expect(r).toMatchObject({ url: `${gh.origin}/mcp/readonly`, provider: { mode: "read" } });
    expect(r!.pin).toBe(s.store.pin("github")!.split(".")[1]);
    expect(s.set("github", { give: false }).give).toBe(false);
    expect(await s.remotes()).toEqual([]);
    expect(s.servers()[0]).toMatchObject({ enabled: false });
  });

  it("drops the pin for sessions when the listing changed, and says so on the card", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s, pushed } = service({ github: gh });
    await s.token("github", GH_TOKEN);
    s.store.setPin("github", "a".repeat(64) + "." + "b".repeat(64), { read: 1, write: 1 });
    // A fresh listing (the cache is cleared by a drift report from a session).
    s.drifted("github");
    const [r] = await s.remotes();
    expect(r!.pin).toBeUndefined();
    expect(s.info("github").note).toBe(CONN_NOTES.drift);
    expect(pushed.some((p) => (p as { note?: string }).note === CONN_NOTES.drift)).toBe(true);
    expect(s.servers()[0]).toMatchObject({ autoRun: false, autoRunNote: CONN_NOTES.drift });
    // Review tools, then accept: the pin is the listing now, and sessions get it.
    await s.test("github");
    s.repin("github");
    expect(s.info("github").note).toBeUndefined();
    expect((await s.remotes())[0]!.pin).toBeDefined();
  });

  it("leaves a connection whose listing failed unaccepted: reads ask until you look", async () => {
    const gh = await fake("github", { mcpDown: true });
    gh.valid.add(GH_TOKEN);
    const { s } = service({ github: gh });
    const info = await s.token("github", GH_TOKEN);
    expect(info).toMatchObject({ state: "ready", note: CONN_NOTES.unaccepted });
    expect(s.store.pin("github")).toBeUndefined();
    gh.opts.mcpDown = false;
    const [r] = await s.remotes();
    expect(r!.pin).toBeUndefined();
  });

  it("keeps a connection off while a server you added has its name, and refuses to connect it", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const { s } = service({ github: gh, taken: ["github"] });
    expect(s.info("github")).toMatchObject({ state: "off", note: CONN_NOTES.githubNameTaken });
    await expect(s.token("github", GH_TOKEN)).rejects.toThrow(CONN_NOTES.githubNameTaken);
    expect(gh.requests).toEqual([]);
    expect(await s.remotes()).toEqual([]);
    expect(s.servers()).toEqual([]);
  });

  it("gives Linear's OAuth sign-in to the gateway as an auth provider, not a header", async () => {
    const ln = await fake("linear");
    const { s } = service({ linear: ln });
    await s.linearSignIn("ask", {});
    await until(() => s.info("linear").state === "ready" && !!s.store.pin("linear"));
    const [r] = await s.remotes();
    expect(r).toMatchObject({ name: "linear", url: `${ln.origin}/mcp`, origins: [ln.origin], provider: { id: "linear", mode: "ask" } });
    expect(r!.headers).not.toHaveProperty("Authorization");
    expect(r!.authProvider).toBeDefined();
    const t = await r!.authProvider!.tokens();
    expect(t?.access_token).toBe(s.store.secrets("linear")!.access);
  });
});

describe("Fable's security review of part 1, fixed", () => {
  const url = (i: Parameters<typeof fetch>[0]) => String(i instanceof Request ? i.url : i);
  /** Signed in to Linear's OAuth with an access token that is about to run out, so bearer() refreshes. */
  const linearDue = async (o: { fetch?: typeof fetch } = {}) => {
    const lin = await fake("linear", { expiresIn: 30 });
    const svc = service({ linear: lin, ...o });
    await svc.s.linearSignIn("ask", {});
    await until(() => svc.s.info("linear").state === "ready" && !!svc.s.store.pin("linear"));
    return { lin, ...svc };
  };

  it("M1: a refresh that doesn't get through leaves the connection ready, and the next one works", async () => {
    let down: (() => Promise<Response>) | undefined;
    const { s, lin, logs } = await linearDue({ fetch: (i, init) => (down && url(i).endsWith("/token") ? down() : fetch(i, init)) });
    for (const d of [() => Promise.reject(new TypeError("fetch failed")), () => Promise.resolve(new Response("bad gateway", { status: 502 }))]) {
      down = d;
      expect(await s.bearer("linear")).toBeUndefined();
      expect(s.info("linear").state).toBe("ready");
    }
    expect(logs.some((l) => l.includes(CONN_NOTES.linearUnreachable))).toBe(true);
    down = undefined;
    const before = s.store.secrets("linear")!.access;
    const after = await s.bearer("linear");
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(lin.carrying(after!).length).toBe(0);
    expect(s.info("linear").state).toBe("ready");
  });

  it("M1: a refresh Linear refuses still marks it expired", async () => {
    let refuse = false;
    const { s } = await linearDue({ fetch: (i, init) => (refuse && url(i).endsWith("/token") ? Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })) : fetch(i, init)) });
    refuse = true;
    expect(await s.bearer("linear")).toBeUndefined();
    expect(s.info("linear")).toMatchObject({ state: "expired", note: CONN_NOTES.linearExpired });
  });

  it("M2: two bearer() calls at once refresh once, and the connection stays ready", async () => {
    const { s, lin } = await linearDue();
    const refreshes = () => lin.requests.filter((q) => q.path === "/token" && q.body.includes("grant_type=refresh_token")).length;
    const before = refreshes();
    const [a, b] = await Promise.all([s.bearer("linear"), s.bearer("linear")]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(refreshes() - before).toBe(1);
    expect(s.info("linear").state).toBe("ready");
  });

  it("M2: a session's refusal of tokens that are no longer the stored ones doesn't expire the connection", async () => {
    const { s, lin } = await linearDue();
    const [r] = await s.remotes();
    const session = r!.authProvider!;
    const stale = (await session.tokens())!;
    // bearer() rotates the refresh token while the session still holds the old one, and Linear refuses the old one.
    await s.bearer("linear");
    expect(s.store.secrets("linear")!.refresh).not.toBe(stale.refresh_token);
    session.invalidateCredentials!("tokens");
    await expect(Promise.resolve().then(() => session.redirectToAuthorization(new URL(`${lin.origin}/authorize`)))).rejects.toThrow(CONN_NOTES.linearExpired);
    expect(s.info("linear").state).toBe("ready");
    // A session picks up the stored tokens rather than spending a rotated refresh token again.
    const fresh = await (await s.remotes())[0]!.authProvider!;
    await s.bearer("linear");
    expect((await fresh.tokens())!.access_token).toBe(s.store.secrets("linear")!.access);
    expect(await auth(fresh, { serverUrl: `${lin.origin}/mcp` })).toBe("AUTHORIZED");
    expect(s.info("linear").state).toBe("ready");
  });

  it("L2: a Linear sign-in that isn't kept is revoked: the window went after the code exchange, or the save failed", async () => {
    const lin = await fake("linear");
    const owner = {};
    let svc!: ReturnType<typeof service>;
    // The window goes while the account is looked up, after Linear gave the tokens.
    svc = service({ linear: lin, fetch: (i, init) => (url(i).endsWith("/graphql") ? (svc.s.cancelFor(owner), fetch(i, init)) : fetch(i, init)) });
    await svc.s.linearSignIn("ask", owner);
    await until(() => lin.revoked.length === 2);
    const issued = lin.requests.filter((q) => q.path === "/token").length;
    expect(issued).toBe(1);
    expect(svc.s.store.secrets("linear")).toBeUndefined();
    expect(lin.revoked[0]).toMatch(/^lin_oauth_/);
    expect(lin.revoked[1]).toMatch(/^lin_refresh_/);

    // The save fails (the keychain refuses): the tokens are revoked, and the card says it failed.
    const lin2 = await fake("linear");
    let refuse = false;
    const crypto = fakeCrypto(true);
    const flaky: Crypto = { ...crypto, encryptString: (t) => { if (refuse) throw new Error("keychain locked"); return crypto.encryptString(t); } };
    const { s } = service({ linear: lin2, crypto: flaky });
    refuse = true;
    await s.linearSignIn("ask", {});
    await until(() => lin2.revoked.length === 2);
    expect(s.info("linear").state).toBe("failed");
  });

  it("L5: the log never carries a token the service holds, whatever its shape", async () => {
    const lin = await fake("linear");
    const opaque = `4f9c2d7e-aaaa-bbbb-cccc-1234567890ab:${"Z".repeat(40)}`;
    lin.valid.add(opaque);
    const crypto = fakeCrypto(true);
    // A keychain whose error echoes what it was given.
    const echo: Crypto = { ...crypto, encryptString: (t) => { throw new Error(`could not encrypt ${t}`); } };
    const { s, logs } = service({ linear: lin, crypto: echo });
    expect((await s.token("linear", opaque)).state).toBe("failed");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(opaque);
    expect(logs.join("\n")).toContain("<redacted token>");
  });

  it("L6: a new sign-in forgets the last test, so repin can't accept another account's listing", async () => {
    const gh = await fake("github");
    gh.valid.add(GH_TOKEN);
    const other = `ghp_${"O".repeat(36)}`;
    gh.valid.add(other);
    const { s } = service({ github: gh });
    await s.token("github", GH_TOKEN);
    expect((await s.test("github")).ok).toBe(true);
    await s.token("github", other);
    expect(() => s.repin("github")).toThrow("Test it first");
  });

  it("a window that goes stops its sign-ins: the destroyed wiring of ipc.ts", async () => {
    const gh = await fake("github", { device: ["authorization_pending"] });
    // A poll that waits until it is cancelled.
    const waiting: Clock = { now: () => 0, sleep: (_ms, signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) };
    const { s } = service({ github: gh, clientId: "Ov23liTestClient0001", clock: waiting });
    const owner = flowOwners(s);
    const wc = new EventEmitter();
    const other = new EventEmitter();
    expect(owner(wc)).toBe(owner(wc));
    expect(wc.listenerCount("destroyed")).toBe(1);
    await s.githubDevice(owner(wc));
    expect(s.info("github").state).toBe("connecting");
    other.emit("destroyed");
    expect(s.info("github").state).toBe("connecting");
    wc.emit("destroyed");
    expect(s.info("github").state).toBe("off");
    await expect(s.githubDevice(owner(other))).resolves.toMatchObject({ userCode: "WDJB-MJHT" });
  });
});
