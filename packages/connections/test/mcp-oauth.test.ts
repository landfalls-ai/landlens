// McpOAuth, the MCP sign-in Linear and Landfall share (wave 7 D103). Linear's own suite (linear.test.ts) runs
// unchanged against it; these cases are Landfall's: its paths, the one scope, and its origin pin.
import { FAMILY_NOTES } from "@landlens/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { landfallTarget } from "../src/family.js";
import { mcpRefresh, mcpRevoke, mcpSignIn } from "../src/mcp-oauth.js";
import { FakeLandfall } from "./fake-family.js";

let fakes: FakeLandfall[] = [];
const start = async () => {
  const f = await new FakeLandfall().start();
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

describe("Landfall's sign-in through McpOAuth", () => {
  it("registers a public Landlens client, asks for mcp:read only, with PKCE, state and the /mcp resource", async () => {
    const f = await start();
    f.expiresIn = 3600;
    const opened: string[] = [];
    const r = await mcpSignIn({ target: landfallTarget(f.origin), open: browser(opened), signal: new AbortController().signal });
    expect(r.access).toMatch(/^lfa_fake_access_/);
    expect(r.scopes).toEqual(["mcp:read"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    expect(r.client.issuer).toContain(f.origin);

    const reg = JSON.parse(f.requests.find((q) => q.path === "/mcp/register")!.body);
    expect(reg).toMatchObject({ client_name: "Landlens", token_endpoint_auth_method: "none", scope: "mcp:read" });
    const a = new URL(opened[0]!);
    expect(a.origin + a.pathname).toBe(`${f.origin}/mcp/authorize`);
    expect(a.searchParams.get("scope")).toBe("mcp:read");
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.searchParams.get("resource")).toBe(`${f.origin}/mcp`);
    // Never mcp:ack, anywhere.
    expect(f.requests.some((q) => q.body.includes("mcp:ack") || q.path.includes("ack"))).toBe(false);
    expect(opened.some((u) => u.includes("mcp%3Aack") || u.includes("mcp:ack"))).toBe(false);
    expect(f.forbidden).toEqual([]);
  });

  it("refuses discovery that names an endpoint off Landfall's origin, before registering", async () => {
    const f = await start();
    const real = globalThis.fetch;
    const lying = (async (u: string | URL | Request, init?: RequestInit) => {
      const r = await real(u, init);
      if (String(u).endsWith("/.well-known/oauth-authorization-server")) {
        const m = (await r.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...m, token_endpoint: "https://evil.example/token" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return r;
    }) as typeof fetch;
    await expect(mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal, fetch: lying })).rejects.toThrow(FAMILY_NOTES.landfallElsewhere);
    expect(f.requests.some((q) => q.path === "/mcp/register")).toBe(false);
  });

  it("a turned-down sign-in is Landfall's sentence", async () => {
    const f = await start();
    f.deny = true;
    await expect(mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal })).rejects.toThrow(FAMILY_NOTES.landfallDenied);
  });

  it("refreshes with the stored client, and a refused refresh is expired", async () => {
    const f = await start();
    const r = await mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal });
    let saved: string | undefined;
    // An access token that has run out is refreshed by auth() from the refresh token.
    f.valid.delete(r.access);
    const t = await mcpRefresh({ target: landfallTarget(f.origin), client: r.client, tokens: { access: r.access, refresh: r.refresh! }, onTokens: (x) => (saved = x.access), onExpired: () => undefined });
    expect(t.access).not.toBe(r.access);
    expect(saved).toBe(t.access);
    f.refuseRefresh = true;
    let expired = false;
    await expect(mcpRefresh({ target: landfallTarget(f.origin), client: r.client, tokens: { access: t.access, refresh: t.refresh! }, onTokens: () => undefined, onExpired: () => (expired = true) })).rejects.toThrow(FAMILY_NOTES.landfallExpired);
    expect(expired).toBe(true);
  });

  it("revokes both tokens at the metadata's endpoint, on Landfall's origin only", async () => {
    const f = await start();
    const r = await mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal });
    expect(await mcpRevoke(f.origin, [r.access, r.refresh!], r.client)).toBe(true);
    expect(f.revoked).toEqual([r.access, r.refresh]);
    expect(await mcpRevoke("http://127.0.0.1:9", [r.access], r.client)).toBe(false);
  });
});

describe("Fable's security review of wave 7 part 1, fixed", () => {
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(f()).toBe(true);
  };

  it("M4: a Landfall that grants more than mcp:read is refused at sign-in, and both tokens are revoked", async () => {
    const f = await start();
    f.grantScope = "mcp:read mcp:ack";
    await expect(mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal })).rejects.toThrow(FAMILY_NOTES.landfallWider);
    expect(f.issued).toHaveLength(1);
    expect(f.revoked).toEqual([f.issued[0]!.access, f.issued[0]!.refresh]);
  });

  it("M4: a refresh that widens the grant marks the sign-in expired, keeps nothing, and revokes what it gave", async () => {
    const f = await start();
    const r = await mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal });
    f.grantScope = "mcp:read mcp:ack";
    const kept: string[] = [];
    let expired: unknown;
    await expect(mcpRefresh({ target: landfallTarget(f.origin), client: r.client, tokens: { access: r.access, refresh: r.refresh! }, onTokens: (t) => kept.push(t.access), onExpired: (u) => (expired = u) })).rejects.toThrow(FAMILY_NOTES.landfallWider);
    expect(kept).toEqual([]);
    expect(expired).toEqual({ access: r.access, refresh: r.refresh });
    const wide = f.issued[1]!;
    await until(() => f.revoked.length === 2);
    expect(f.revoked).toEqual([wide.access, wide.refresh]);
  });

  it("L2: Cancel during discovery or registration stops the browser from opening", async () => {
    const f = await start();
    const release = f.hold("/mcp/register");
    const opened: string[] = [];
    const ac = new AbortController();
    const signing = mcpSignIn({ target: landfallTarget(f.origin), open: browser(opened), signal: ac.signal });
    await until(() => f.requests.some((q) => q.path === "/mcp/register"));
    ac.abort(new Error("cancelled"));
    release();
    await expect(signing).rejects.toThrow("cancelled");
    expect(opened).toEqual([]);
  });

  it("L6: a refreshed token that isn't one printable line is refused, not stored", async () => {
    const f = await start();
    const r = await mcpSignIn({ target: landfallTarget(f.origin), open: browser([]), signal: new AbortController().signal });
    f.nextAccess = `lfa_fake_access_${"c".repeat(20)}\nX-Injected: 1`;
    const kept: string[] = [];
    await expect(mcpRefresh({ target: landfallTarget(f.origin), client: r.client, tokens: { access: r.access, refresh: r.refresh! }, onTokens: (t) => kept.push(t.access), onExpired: () => undefined })).rejects.toThrow(FAMILY_NOTES.landfallAnswer);
    expect(kept).toEqual([]);
  });
});
