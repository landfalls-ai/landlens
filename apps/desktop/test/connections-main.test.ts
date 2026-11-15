import { CONN_NOTES } from "@landlens/contracts";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { connectionOverrides, ConnectionsService, readTools } from "../src/main/connections";
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

function service(o: { github?: FakeProvider; linear?: FakeProvider; clientId?: string; canStore?: boolean; taken?: string[] } = {}) {
  const file = tempFile("connections.json");
  const opened: string[] = [];
  const pushed: unknown[] = [];
  const browser = async (url: string) => {
    opened.push(url);
    const r = await fetch(url, { redirect: "manual" });
    const back = r.headers.get("location");
    if (back) await fetch(back);
  };
  const s = new ConnectionsService({
    file,
    crypto: fakeCrypto(o.canStore ?? true),
    overrides: { ...(o.github ? { github: o.github.origin } : {}), ...(o.linear ? { linear: o.linear.origin } : {}), ...(o.clientId ? { githubClientId: o.clientId } : {}) },
    openExternal: browser,
    push: (i) => pushed.push(i),
    clock: instantClock,
    ...(o.taken ? { takenNames: () => o.taken! } : {}),
  });
  return { s, file, opened, pushed };
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
    const refresh = s.store.secrets("linear")!.refresh!;
    expect(await s.disconnect("linear")).toMatchObject({ state: "off", mode: "ask" });
    expect(lin.revoked).toEqual([refresh]);
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
