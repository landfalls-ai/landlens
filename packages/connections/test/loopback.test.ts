import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { LoopbackError, openLoopback, sameSecret } from "../src/loopback.js";

/** A raw GET, so the Host header can be anything. */
function get(url: string, host?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: host ? { Host: host } : {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const STATE = "s".repeat(43);

describe("the loopback redirect", () => {
  it("listens on 127.0.0.1 at /callback and takes one code with the right state", async () => {
    const lb = await openLoopback({ state: STATE });
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const r = await get(`${lb.redirectUri}?code=abc123&state=${STATE}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("close this tab");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    await expect(lb.result).resolves.toEqual({ code: "abc123" });
    // One request only: the listener is gone.
    await expect(get(`${lb.redirectUri}?code=again&state=${STATE}`)).rejects.toThrow();
  });

  it("answers 404 and keeps waiting on a wrong state, another path, another Host or a POST", async () => {
    const lb = await openLoopback({ state: STATE });
    const port = new URL(lb.redirectUri).port;
    expect((await get(`${lb.redirectUri}?code=x&state=${"t".repeat(43)}`)).status).toBe(404);
    expect((await get(`${lb.redirectUri}?code=x`)).status).toBe(404);
    expect((await get(`http://127.0.0.1:${port}/other?code=x&state=${STATE}`)).status).toBe(404);
    expect((await get(`${lb.redirectUri}?code=x&state=${STATE}`, `localhost:${port}`)).status).toBe(404);
    expect((await get(`${lb.redirectUri}?code=x&state=${STATE}`, `evil.example:${port}`)).status).toBe(404);
    // Still the one right answer afterwards.
    expect((await get(`${lb.redirectUri}?code=good&state=${STATE}`)).status).toBe(200);
    await expect(lb.result).resolves.toEqual({ code: "good" });
  });

  it("ends the flow when the provider turns it down", async () => {
    const lb = await openLoopback({ state: STATE });
    await get(`${lb.redirectUri}?error=access_denied&state=${STATE}`);
    await expect(lb.result).rejects.toMatchObject({ kind: "denied" });
  });

  it("closes after its time limit and on cancel", async () => {
    const a = await openLoopback({ state: STATE, timeoutMs: 50 });
    await expect(a.result).rejects.toBeInstanceOf(LoopbackError);
    await expect(a.result).rejects.toMatchObject({ kind: "timeout" });
    await expect(get(`${a.redirectUri}?code=x&state=${STATE}`)).rejects.toThrow();
    const b = await openLoopback({ state: STATE });
    b.close();
    await expect(b.result).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("compares states of any length without throwing", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});
