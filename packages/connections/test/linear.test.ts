import { CONN_NOTES } from "@landlens/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { linearRefresh, linearRevoke, linearSignIn, linearViewer } from "../src/linear.js";
import { linearEndpoints } from "../src/providers.js";
import { FakeProvider, type FakeOptions } from "./fake-provider.js";
import { LIN_KEY } from "./helpers.js";

let fakes: FakeProvider[] = [];
const start = async (o: FakeOptions = {}) => {
  const f = await new FakeProvider("linear", o).start();
  fakes.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
  fakes = [];
});

/** The person's browser: follows the authorize page's redirect to the loopback. */
function browser(opened: string[]) {
  return async (url: string) => {
    opened.push(url);
    const r = await fetch(url, { redirect: "manual" });
    const back = r.headers.get("location");
    if (back) await fetch(back);
  };
}

describe("Linear's sign-in", () => {
  it("registers a public client for the loopback, uses PKCE S256, state and resource, and gets tokens", async () => {
    const f = await start({ expiresIn: 3600 });
    const ep = linearEndpoints(f.origin);
    const opened: string[] = [];
    const r = await linearSignIn({ endpoints: ep, mode: "ask", open: browser(opened), signal: new AbortController().signal });
    expect(r.access).toMatch(/^lin_oauth_/);
    expect(r.refresh).toMatch(/^lin_refresh_/);
    expect(r.scopes).toEqual(["read", "write"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    expect(r.client).toEqual({ client_id: expect.stringMatching(/^client_/), issuer: expect.stringContaining(f.origin), redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/) });

    const reg = JSON.parse(f.requests.find((q) => q.path === "/register")!.body);
    expect(reg).toMatchObject({ client_name: "Landlens", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [r.client.redirect_uri] });
    expect(reg.client_secret).toBeUndefined();

    expect(opened).toHaveLength(1);
    const a = new URL(opened[0]!);
    expect(a.origin + a.pathname).toBe(`${f.origin}/authorize`);
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.searchParams.get("resource")).toBe(`${f.origin}/mcp`);
    expect(a.searchParams.get("scope")).toBe("read write");

    const token = new URLSearchParams(f.requests.find((q) => q.path === "/token")!.body);
    expect(token.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(token.get("resource")).toBe(`${f.origin}/mcp`);
  });

  it("asks only for read in Read only", async () => {
    const f = await start();
    const opened: string[] = [];
    const r = await linearSignIn({ endpoints: linearEndpoints(f.origin), mode: "read", open: browser(opened), signal: new AbortController().signal });
    expect(new URL(opened[0]!).searchParams.get("scope")).toBe("read");
    expect(r.scopes).toEqual(["read"]);
  });

  it("stops before registering when the metadata names another issuer or endpoint", async () => {
    const other = await start();
    for (const metadata of [{ issuer: other.origin }, { token_endpoint: `${other.origin}/token` }, { registration_endpoint: `${other.origin}/register` }, { authorization_endpoint: "https://evil.example/authorize" }]) {
      const f = await start({ metadata });
      const opened: string[] = [];
      await expect(linearSignIn({ endpoints: linearEndpoints(f.origin), mode: "ask", open: browser(opened), signal: new AbortController().signal })).rejects.toThrow(CONN_NOTES.linearElsewhere);
      expect(opened).toEqual([]);
      expect(f.requests.some((q) => q.path === "/register")).toBe(false);
    }
    expect(other.requests).toEqual([]);
  });

  it("refuses metadata without S256", async () => {
    const f = await start({ metadata: { code_challenge_methods_supported: ["plain"] } });
    await expect(linearSignIn({ endpoints: linearEndpoints(f.origin), mode: "ask", open: browser([]), signal: new AbortController().signal })).rejects.toThrow(CONN_NOTES.linearAnswer);
  });

  it("says when the person turns it down, and when it isn't finished in time", async () => {
    const f = await start({ deny: true });
    await expect(linearSignIn({ endpoints: linearEndpoints(f.origin), mode: "ask", open: browser([]), signal: new AbortController().signal })).rejects.toThrow(CONN_NOTES.linearDenied);
    await expect(linearSignIn({ endpoints: linearEndpoints(f.origin), mode: "ask", open: async () => {}, signal: new AbortController().signal, timeoutMs: 50 })).rejects.toThrow(CONN_NOTES.linearTimeout);
  });

  it("is cancelled by its signal and closes the listener", async () => {
    const f = await start();
    const ac = new AbortController();
    let redirect = "";
    const p = linearSignIn({ endpoints: linearEndpoints(f.origin), mode: "ask", open: async (url) => { redirect = new URL(url).searchParams.get("redirect_uri")!; ac.abort(new Error("cancelled")); }, signal: ac.signal });
    await expect(p).rejects.toThrow("cancelled");
    await expect(fetch(`${redirect}?code=x&state=y`)).rejects.toThrow();
  });

  it("refreshes with the stored client, and marks the connection expired when the refresh is refused", async () => {
    const f = await start({ expiresIn: 60 });
    const ep = linearEndpoints(f.origin);
    const s = await linearSignIn({ endpoints: ep, mode: "ask", open: browser([]), signal: new AbortController().signal });
    const saved: string[] = [];
    let expired = 0;
    const t = await linearRefresh({ endpoints: ep, mode: "ask", client: s.client, tokens: { access: s.access, refresh: s.refresh! }, onTokens: (x) => saved.push(x.access), onExpired: () => expired++ });
    expect(t.access).not.toBe(s.access);
    expect(saved).toEqual([t.access]);
    expect(expired).toBe(0);

    const g = await start({ refuseRefresh: true });
    const s2 = await linearSignIn({ endpoints: linearEndpoints(g.origin), mode: "ask", open: browser([]), signal: new AbortController().signal });
    const opened = g.requests.filter((q) => q.path === "/authorize").length;
    await expect(linearRefresh({ endpoints: linearEndpoints(g.origin), mode: "ask", client: s2.client, tokens: { access: s2.access, refresh: s2.refresh! }, onTokens: () => {}, onExpired: () => expired++ })).rejects.toThrow(CONN_NOTES.linearExpired);
    expect(expired).toBe(1);
    // In a session no browser opens.
    expect(g.requests.filter((q) => q.path === "/authorize").length).toBe(opened);
  });

  it("revokes at the metadata's revocation endpoint, on Linear's origin only", async () => {
    const f = await start();
    const ep = linearEndpoints(f.origin);
    const s = await linearSignIn({ endpoints: ep, mode: "ask", open: browser([]), signal: new AbortController().signal });
    expect(await linearRevoke(ep, s.refresh!, s.client)).toBe(true);
    expect(f.revoked).toEqual([s.refresh]);
    const other = await start();
    const g = await start({ metadata: { revocation_endpoint: `${other.origin}/revoke` } });
    expect(await linearRevoke(linearEndpoints(g.origin), "lin_oauth_x", s.client)).toBe(false);
    expect(other.requests).toEqual([]);
  });
});

describe("who a Linear key is", () => {
  it("asks viewer on the GraphQL API with the key as is", async () => {
    const f = await start();
    f.valid.add(LIN_KEY);
    expect(await linearViewer(linearEndpoints(f.origin), LIN_KEY)).toEqual({ login: "lin@example.com", name: "Lin Person", org: "Landfalls" });
    expect(f.carrying(LIN_KEY).map((q) => `${q.method} ${q.path}`)).toEqual(["POST /graphql"]);
    expect(f.carrying(LIN_KEY)[0]!.authorization).toBe(LIN_KEY);
  });

  it("says a refused key is refused", async () => {
    const f = await start();
    await expect(linearViewer(linearEndpoints(f.origin), LIN_KEY)).rejects.toThrow(CONN_NOTES.linearRefused);
  });

  it("names Linear's real hosts", () => {
    const ep = linearEndpoints();
    expect(ep).toMatchObject({ mcp: "https://mcp.linear.app/mcp", mcpReadonly: "https://mcp.linear.app/mcp/readonly", authOrigin: "https://mcp.linear.app", graphql: "https://api.linear.app/graphql" });
    expect(ep.origins).toEqual(["https://mcp.linear.app", "https://api.linear.app"]);
  });
});
