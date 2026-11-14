import { McpServerInput } from "@landlens/contracts";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppViews, viewCsp, VIEW_HEADERS } from "../src/main/app-views";
import type { Crypto } from "../src/main/clickland-settings";
import { CSP_PROD } from "../src/main/csp";
import { McpServerStore } from "../src/main/mcp-store";

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
