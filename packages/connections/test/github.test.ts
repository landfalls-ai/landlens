import { CONN_NOTES } from "@landlens/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ConnError, githubWhoAmI, pollDeviceFlow, startDeviceFlow, type Clock } from "../src/github.js";
import { githubEndpoints, pinnedFetch } from "../src/providers.js";
import { FakeProvider, type FakeOptions } from "./fake-provider.js";
import { GH_TOKEN } from "./helpers.js";

const CLIENT = "Ov23liTestClient0001";
let fake: FakeProvider | undefined;
const start = async (o: FakeOptions = {}) => (fake = await new FakeProvider("github", o).start());
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

/** Fake timers for the poll: sleeping moves a virtual clock, and every wait is recorded. */
function virtualClock(): Clock & { waits: number[] } {
  let now = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      waits.push(ms);
      now += ms;
    },
  };
}

describe("GitHub's device flow", () => {
  it("shows GitHub's code, polls at the interval, slows down when told, and gets a token", async () => {
    const f = await start({ device: ["authorization_pending", "slow_down", "authorization_pending", "token"] });
    const ep = githubEndpoints(f.origin);
    const code = await startDeviceFlow(ep, CLIENT);
    expect(code).toEqual({ deviceCode: expect.any(String), userCode: "WDJB-MJHT", interval: 5, expiresIn: 900 });
    const clock = virtualClock();
    const r = await pollDeviceFlow(ep, CLIENT, code, new AbortController().signal, { clock });
    expect(r.access).toBe(f.deviceToken);
    // 5 s, 5 s, then slow_down said 10, kept from then on.
    expect(clock.waits).toEqual([5000, 5000, 10000, 10000]);
    const asked = f.requests.filter((q) => q.path === "/login/device/code");
    expect(new URLSearchParams(asked[0]!.body).get("scope")).toBe("repo read:org read:user");
    expect(new URLSearchParams(asked[0]!.body).has("client_secret")).toBe(false);
    // The token never goes to github.com's device endpoints: they get only the device code.
    expect(f.carrying(f.deviceToken)).toEqual([]);
  });

  it("stops at the code's expiry, and on expired_token or access_denied", async () => {
    const f = await start({ device: ["authorization_pending"] });
    const ep = githubEndpoints(f.origin);
    const code = { deviceCode: "dc_x", userCode: "ABCD-EFGH", interval: 5, expiresIn: 30 };
    const clock = virtualClock();
    await expect(pollDeviceFlow(ep, CLIENT, code, new AbortController().signal, { clock })).rejects.toThrow(CONN_NOTES.deviceExpired);
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBe(30_000);
    await f.stop();
    for (const [step, note] of [["expired_token", CONN_NOTES.deviceExpired], ["access_denied", CONN_NOTES.deviceDenied]] as const) {
      const g = await start({ device: [step] });
      await expect(pollDeviceFlow(githubEndpoints(g.origin), CLIENT, code, new AbortController().signal, { clock: virtualClock() })).rejects.toThrow(note);
      await g.stop();
    }
    fake = undefined;
  });

  it("never waits past 15 minutes, whatever GitHub says", async () => {
    const f = await start({ device: ["authorization_pending"] });
    const clock = virtualClock();
    await expect(pollDeviceFlow(githubEndpoints(f.origin), CLIENT, { deviceCode: "dc_x", userCode: "ABCD-EFGH", interval: 5, expiresIn: 7200 }, new AbortController().signal, { clock })).rejects.toThrow(CONN_NOTES.deviceExpired);
    expect(clock.now()).toBe(15 * 60_000);
  });

  it("tries a dropped poll again, and gives up after three in a row", async () => {
    const f = await start();
    const ep = githubEndpoints(f.origin);
    const code = await startDeviceFlow(ep, CLIENT);
    let drops = 2;
    const flaky: typeof fetch = (i, init) => (String(i).endsWith("/login/oauth/access_token") && drops-- > 0 ? Promise.reject(new TypeError("fetch failed")) : fetch(i, init));
    expect((await pollDeviceFlow(ep, CLIENT, code, new AbortController().signal, { clock: virtualClock(), fetch: flaky })).access).toBe(f.deviceToken);
    drops = 3;
    await expect(pollDeviceFlow(ep, CLIENT, code, new AbortController().signal, { clock: virtualClock(), fetch: flaky })).rejects.toThrow(CONN_NOTES.githubUnreachable);
    const bad: typeof fetch = (i, init) => (String(i).endsWith("/login/oauth/access_token") ? Promise.resolve(new Response("", { status: 502 })) : fetch(i, init));
    await expect(pollDeviceFlow(ep, CLIENT, code, new AbortController().signal, { clock: virtualClock(), fetch: bad })).rejects.toThrow(CONN_NOTES.githubAnswer);
  });

  it("stops when cancelled", async () => {
    const f = await start({ device: ["authorization_pending"] });
    const ac = new AbortController();
    const clock = virtualClock();
    let n = 0;
    const sleep = clock.sleep;
    clock.sleep = async (ms, signal) => {
      if (++n === 3) ac.abort(new Error("cancelled"));
      return sleep(ms, signal);
    };
    await expect(pollDeviceFlow(githubEndpoints(f.origin), CLIENT, { deviceCode: "dc_x", userCode: "ABCD-EFGH", interval: 5, expiresIn: 900 }, ac.signal, { clock })).rejects.toThrow("cancelled");
    expect(f.requests.filter((q) => q.path === "/login/oauth/access_token").length).toBe(2);
  });

  it("isn't offered without a client id", async () => {
    const f = await start();
    await expect(startDeviceFlow(githubEndpoints(f.origin), "")).rejects.toThrow(CONN_NOTES.noDevice);
    expect(f.requests).toEqual([]);
  });
});

describe("who a GitHub token is", () => {
  it("reads login, name and scopes from GET /user, as one-line text", async () => {
    const f = await start({ scopes: "repo, read:org, <script>" });
    f.valid.add(GH_TOKEN);
    const r = await githubWhoAmI(githubEndpoints(f.origin), GH_TOKEN);
    expect(r.account.login).toBe("octo-person");
    expect(r.account.name).toBe("Octo Person");
    expect(r.scopes).toEqual(["repo", "read:org"]);
    expect(f.carrying(GH_TOKEN).map((q) => `${q.method} ${q.path}`)).toEqual(["GET /user"]);
  });

  it("says a refused token is refused", async () => {
    const f = await start();
    await expect(githubWhoAmI(githubEndpoints(f.origin), GH_TOKEN)).rejects.toThrow(CONN_NOTES.githubRefused);
  });

  it("refuses a redirect, so the token isn't carried to another host", async () => {
    const other = await new FakeProvider("github").start();
    const f = await start({ redirectUser: `${other.origin}/user` });
    f.valid.add(GH_TOKEN);
    other.valid.add(GH_TOKEN);
    await expect(githubWhoAmI(githubEndpoints(f.origin), GH_TOKEN)).rejects.toBeInstanceOf(ConnError);
    expect(other.requests).toEqual([]);
    await other.stop();
  });

  it("sends a provider's requests only to its own origins", async () => {
    const f = await start();
    const other = await new FakeProvider("github").start();
    const pinned = pinnedFetch(githubEndpoints(f.origin).tokenOrigins);
    await expect(pinned(`${other.origin}/user`, { headers: { Authorization: `Bearer ${GH_TOKEN}` } })).rejects.toThrow(/doesn't send/);
    expect(other.requests).toEqual([]);
    await other.stop();
  });

  it("names GitHub's real hosts, and takes only a loopback override", () => {
    const ep = githubEndpoints();
    expect(ep.origins).toEqual(["https://github.com", "https://api.github.com", "https://api.githubcopilot.com"]);
    expect(ep.tokenOrigins).toEqual(["https://api.github.com", "https://api.githubcopilot.com"]);
    expect(ep.mcp).toBe("https://api.githubcopilot.com/mcp/");
    expect(ep.mcpReadonly).toBe("https://api.githubcopilot.com/mcp/readonly");
    for (const bad of ["https://evil.example", "http://localhost:1234", "http://127.0.0.1:1/x", "http://10.0.0.1:80"]) expect(() => githubEndpoints(bad)).toThrow();
  });
});
