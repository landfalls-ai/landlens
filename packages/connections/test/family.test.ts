import { channels, FAMILY_NOTES, familyUrlAllowed, FamilyOrigin, FamilyUrl, ClicklandUrl, LANDFLOW_KEY_SHAPE, LandflowKey, TriageHeader, TriagePath, TriageSecret } from "@landlens/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { clicklandWho, FamilyError, landfallConnector, landflowCan, landflowWho, siblingHealth } from "../src/family.js";
import { CK_READ, CK_WRITE, FakeClickland, FakeLandfall, FakeLandflow, LF_KEY, LF_KEY_ADMIN, LF_KEY_NARROW } from "./fake-family.js";

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
/** A server that answers everything with this status (and, for 3xx, a redirect elsewhere). */
async function answering(status: number): Promise<string> {
  const s = createServer((_q, r) => {
    r.writeHead(status, status >= 300 && status < 400 ? { Location: "http://127.0.0.1:9/elsewhere" } : { "Content-Type": "application/json" });
    r.end(status >= 300 && status < 400 ? "" : JSON.stringify({ error: `secret ${LF_KEY}` }));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  stops.push(() => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r()))));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
/** An origin nothing listens at: a port that was just closed. */
async function nothingAt(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}
const caught = async (p: Promise<unknown>): Promise<FamilyError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FamilyError);
    return err as FamilyError;
  }
  throw new Error("expected a failure");
};

describe("a sibling's address (D102)", () => {
  it("takes https anywhere, plain http only to this machine, an origin only", () => {
    expect(familyUrlAllowed("https://landflow.example")).toBe(true);
    expect(familyUrlAllowed("http://127.0.0.1:3000")).toBe(true);
    expect(familyUrlAllowed("http://localhost:3000/")).toBe(true);
    expect(familyUrlAllowed("http://[::1]:3000")).toBe(true);
    expect(familyUrlAllowed("http://landflow-host.landflow-dev.svc.cluster.local:3000")).toBe(false);
    expect(familyUrlAllowed("http://192.168.1.10:3000")).toBe(false);
    for (const bad of ["https://landflow.example/api", "https://u:p@landflow.example", "https://landflow.example?x=1", "https://landflow.example#f", "ftp://landflow.example", "http://127.0.0.1:99999", "javascript:alert(1)"]) {
      expect(familyUrlAllowed(bad), bad).toBe(false);
    }
  });

  it("takes plain http to a listed host only, exactly", () => {
    const hosts = ["landflow-host.landflow-dev.svc.cluster.local"];
    expect(familyUrlAllowed("http://landflow-host.landflow-dev.svc.cluster.local:3000", hosts)).toBe(true);
    expect(familyUrlAllowed("http://evil.landflow-host.landflow-dev.svc.cluster.local:3000", hosts)).toBe(false);
    expect(familyUrlAllowed("http://landflow-host.landflow-dev.svc.cluster.local.evil:3000", hosts)).toBe(false);
  });

  it("FamilyUrl, and ClicklandUrl with it, refuse a path; FamilyOrigin is the shape only", () => {
    expect(ClicklandUrl).toBe(FamilyUrl);
    expect(FamilyUrl.safeParse("http://127.0.0.1:4710").success).toBe(true);
    expect(FamilyUrl.safeParse("http://127.0.0.1:4710/api").success).toBe(false);
    expect(FamilyUrl.safeParse("http://clickland.example").success).toBe(false);
    expect(FamilyOrigin.safeParse("http://clickland.example").success).toBe(true);
    expect(FamilyOrigin.safeParse("http://clickland.example/x").success).toBe(false);
  });
});

describe("key shapes and the channels' schemas", () => {
  it("a Landflow key is lf_…, never an MCP token, a debug token or a Landfall key", () => {
    expect(LANDFLOW_KEY_SHAPE.test(LF_KEY)).toBe(true);
    for (const bad of [`lf_mcp_${"x".repeat(40)}`, `lf_key_${"x".repeat(40)}`, `lf_dbg_${"x".repeat(40)}`, "lf_short", `ck_${"x".repeat(40)}`, `${LF_KEY}\n`]) {
      expect(LandflowKey.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("the triage webhook's settings refuse what could carry the secret elsewhere", () => {
    expect(TriagePath.safeParse("alerts").success).toBe(true);
    expect(TriagePath.safeParse("team/alerts_2").success).toBe(true);
    for (const bad of ["../api/brain/work", "/alerts", "a?b=1", "a%2F..", ""]) expect(TriagePath.safeParse(bad).success, bad).toBe(false);
    expect(TriageHeader.safeParse("X-Webhook-Secret").success).toBe(true);
    for (const bad of ["Authorization", "authorization", "Host", "Cookie", "X-Landlens-Thing", "Content-Type", "Idempotency-Key", "Bad Header"]) expect(TriageHeader.safeParse(bad).success, bad).toBe(false);
    expect(TriageSecret.safeParse("s3cret value").success).toBe(true);
    for (const bad of [" lead", "trail ", "two\nlines", "x".repeat(401)]) expect(TriageSecret.safeParse(bad).success, bad).toBe(false);
  });

  it("family:set keeps the console to Clickland and the webhook to Landflow; family:connect is Landflow's only", () => {
    const set = channels["family:set"];
    expect(set.safeParse({ sibling: "clickland", console: "http://127.0.0.1:4711" }).success).toBe(true);
    expect(set.safeParse({ sibling: "landflow", console: "http://127.0.0.1:4711" }).success).toBe(false);
    expect(set.safeParse({ sibling: "clickland", console: "http://console.example" }).success).toBe(false);
    expect(set.safeParse({ sibling: "landflow", triage: { path: "alerts", header: "X-Webhook-Secret", secret: "s" } }).success).toBe(true);
    expect(set.safeParse({ sibling: "landfall", triage: { path: "alerts", header: "X-Webhook-Secret" } }).success).toBe(false);
    expect(channels["family:connect"].safeParse({ sibling: "landfall", url: "http://127.0.0.1:1" }).success).toBe(false);
    expect(channels["family:connect"].safeParse({ sibling: "landflow", url: "http://127.0.0.1:1/api", key: LF_KEY }).success).toBe(false);
    expect(channels["family:signin"].safeParse({ sibling: "landfall", url: "http://127.0.0.1:3001" }).success).toBe(true);
  });
});

describe("who a key is (D103)", () => {
  it("Clickland: a read key's name, role and scopes; a key that can write says so", async () => {
    const ck = await up(new FakeClickland());
    expect(await clicklandWho(ck.origin, CK_READ)).toEqual({ account: { name: "landlens-graphs", role: "viewer" }, scopes: ["read"], writes: false });
    const w = await clicklandWho(ck.origin, CK_WRITE);
    expect(w.writes).toBe(true);
    expect(w.scopes).toEqual(["read", "notes:write", "views:write"]);
    expect(ck.requests.every((r) => r.path === "/api/auth/me")).toBe(true);
  });

  it("Clickland in dev mode names no kind and reads as the developer", async () => {
    const f = (async () => new Response(JSON.stringify({ user: { name: "Local developer", email: null, roles: ["admin"] }, authMode: "dev", scopes: ["admin"] }), { status: 200 })) as typeof fetch;
    expect(await clicklandWho("http://127.0.0.1:4730", CK_READ, f)).toEqual({ account: { name: "Local developer", role: "admin" }, scopes: ["admin"], writes: true });
  });

  it("Clickland: a person's session isn't a key; an unknown key is refused", async () => {
    const ck = await up(new FakeClickland());
    const e = await caught(clicklandWho(ck.origin, `ck_${"Z".repeat(32)}`));
    expect([e.status, e.message]).toEqual([401, FAMILY_NOTES.clicklandRefused]);
    const person = (async () => new Response(JSON.stringify({ kind: "person", user: { name: "P" }, scopes: ["read"] }))) as typeof fetch;
    expect((await caught(clicklandWho(ck.origin, CK_READ, person))).message).toBe(FAMILY_NOTES.clicklandAnswer);
  });

  it("Landflow: the user, the key's scopes, and what they cover", async () => {
    const lf = await up(new FakeLandflow());
    const w = await landflowWho(lf.origin, LF_KEY);
    expect(w).toEqual({ account: { name: "Fable Person", email: "fable@example.com", role: "member" }, scopes: ["brain:read", "brain:write", "workflows:read", "run", "executions:read"] });
    expect(landflowCan(w.scopes)).toEqual({ brain: true, run: true, runs: true, flows: true });
    expect(landflowCan((await landflowWho(lf.origin, LF_KEY_NARROW)).scopes)).toEqual({ brain: false, run: false, runs: false, flows: false });
    expect(landflowCan(["admin"])).toEqual({ brain: true, run: true, runs: true, flows: true });
    expect(lf.carrying(LF_KEY).every((r) => r.path === "/api/auth/me" && r.authorization === `Bearer ${LF_KEY}`)).toBe(true);
    expect(lf.carrying(LF_KEY_ADMIN)).toEqual([]);
  });

  it("Landflow: a session or an MCP token isn't a personal key; a refused key and other answers are fixed sentences", async () => {
    const session = (async () => new Response(JSON.stringify({ user: { name: "P" }, via: "session" }))) as typeof fetch;
    expect((await caught(landflowWho("http://127.0.0.1:1", LF_KEY, session))).message).toBe(FAMILY_NOTES.landflowNotKey);
    const lf = await up(new FakeLandflow());
    expect((await caught(landflowWho(lf.origin, `lf_${"Q".repeat(43)}`))).message).toBe(FAMILY_NOTES.landflowRefused);
    const e502 = await caught(landflowWho(await answering(502), LF_KEY));
    expect(e502.message).toBe("Landflow answered HTTP 502.");
    expect(e502.message).not.toContain(LF_KEY);
    expect((await caught(landflowWho(await nothingAt(), LF_KEY))).message).toBe(FAMILY_NOTES.unreachable);
    expect((await caught(landflowWho(await answering(200), LF_KEY))).message).toBe(FAMILY_NOTES.landflowAnswer);
  });

  it("refuses a redirect (the key would follow it) and says a slow sibling is slow", async () => {
    const r = await caught(landflowWho(await answering(307), LF_KEY));
    expect(r.message).toBe(FAMILY_NOTES.landflowAnswer);
    const slow = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as typeof fetch;
    expect((await caught(clicklandWho("http://127.0.0.1:4710", CK_READ, slow))).message).toBe(FAMILY_NOTES.clicklandSlow);
  });

  it("sends the key only to the origin it was given, in the Authorization header, and health with no key", async () => {
    const seen: { url: string; auth?: string; redirect?: string }[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), auth: (init?.headers as Record<string, string>)?.Authorization, redirect: init?.redirect as string });
      return new Response(JSON.stringify({ status: "ok" }));
    }) as typeof fetch;
    await siblingHealth("landflow", "http://127.0.0.1:3000", f);
    expect(seen).toEqual([{ url: "http://127.0.0.1:3000/api/health", redirect: "error" }]);
  });
});

describe("Landfall's connector", () => {
  it("is off when its metadata is missing (MCP_GATEWAY_ENABLED unset), and on when it names itself", async () => {
    const lf = await up(new FakeLandfall());
    await landfallConnector(lf.origin);
    lf.off = true;
    const e = await caught(landfallConnector(lf.origin));
    expect([e.status, e.message]).toEqual([409, FAMILY_NOTES.landfallOff]);
  });

  it("refuses metadata whose endpoints are on another origin", async () => {
    const f = (async () => new Response(JSON.stringify({ issuer: "http://127.0.0.1:3001", authorization_endpoint: "https://evil.example/authorize", token_endpoint: "http://127.0.0.1:3001/mcp/token" }))) as typeof fetch;
    expect((await caught(landfallConnector("http://127.0.0.1:3001", f))).message).toBe(FAMILY_NOTES.landfallElsewhere);
  });
});
