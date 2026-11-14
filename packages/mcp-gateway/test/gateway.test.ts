import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpCall, ResourceType } from "@landlens/contracts";
import type { AgentCluster } from "@landlens/kube-mcp";
import { APP_URI } from "@landlens/kube-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpGateway, testRemote, type GatewaySession } from "../src/index.js";

const types: ResourceType[] = [
  { group: "", version: "v1", resource: "pods", kind: "Pod", namespaced: true, verbs: ["get", "list"], shortNames: ["po"] },
  { group: "", version: "v1", resource: "events", kind: "Event", namespaced: true, verbs: ["list"] },
  { group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false, verbs: ["get", "list"] },
];

/** A cluster that reports each request to the gateway's audit hook, tagged with the call it was made for. */
function fakeCluster(audit: (call: string | undefined, path: string) => void, call?: string): AgentCluster {
  return {
    context: "orbstack",
    types: async () => types,
    withCall: (id) => fakeCluster(audit, id),
    get: async (path) => {
      audit(call, path);
      return { status: 200, text: JSON.stringify({ items: [] }) };
    },
  };
}

/** A remote MCP server: a read-only tool with a view, a writing tool, an app-only tool, and the view. */
function fakeRemote(seen: string[]) {
  const make = () => {
    const s = new McpServer({ name: "fake", version: "1.0.0" });
    s.registerTool("list_things", {
      description: "Lists things.", inputSchema: { filter: z.string().optional() },
      annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://fake/view" } },
    }, async (a) => ({ content: [{ type: "text", text: `things matching ${a.filter ?? "*"}: token=abcdefghijklmnopqrstuvwxyz0123` }], structuredContent: { things: ["a", "b"] } }));
    s.registerTool("delete_thing", { description: "Deletes a thing.", inputSchema: { id: z.string() } }, async (a) => ({ content: [{ type: "text", text: `deleted ${a.id}` }] }));
    s.registerTool("refresh", {
      description: "For the view.", inputSchema: {}, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } },
    }, async () => ({ content: [{ type: "text", text: "refreshed" }] }));
    s.registerResource("view", "ui://fake/view", { mimeType: "text/html;profile=mcp-app" }, async () => ({
      contents: [{ uri: "ui://fake/view", mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>view</p>", _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] }, prefersBorder: true } } }],
    }));
    s.registerResource("plain", "ui://fake/plain", { mimeType: "text/html" }, async () => ({ contents: [{ uri: "ui://fake/plain", mimeType: "text/html", text: "<p>x</p>" }] }));
    return s;
  };
  return createServer(async (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(307, { Location: "http://127.0.0.1:1/mcp" });
      return res.end();
    }
    seen.push(String(req.headers["x-api-key"] ?? ""));
    if (req.headers["x-api-key"] !== "k_secret") {
      res.writeHead(401).end();
      return;
    }
    const s = make();
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void s.close());
    await s.connect(t);
    await t.handleRequest(req, res);
  });
}

let remote: HttpServer;
let remoteUrl: string;
const seen: string[] = [];
const audited: { call?: string; path: string }[] = [];
let approvals = false;
const asked: string[] = [];
let gateway: McpGateway;
let session: GatewaySession;
const events: McpCall[] = [];

const connect = async (url: string, token: string) => {
  const c = new Client({ name: "claude-code-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};

beforeAll(async () => {
  remote = fakeRemote(seen);
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`;
  gateway = new McpGateway({ approve: async (q) => { asked.push(`${q.server}/${q.tool}`); return approvals; } });
  await gateway.start();
  gateway.log.subscribe((c) => events.push(c));
  session = await gateway.open({
    label: "agent 1 · orbstack", context: "orbstack", origin: "agent",
    cluster: fakeCluster((call, path) => {
      audited.push({ ...(call ? { call } : {}), path });
      gateway.onAudit({ at: new Date().toISOString(), label: "agent 1 · orbstack", method: "GET", cluster: "h", path, allowed: true, status: 200, ...(call ? { call } : {}) });
    }),
    remotes: [{ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" } }],
  });
  session.bind("acp-1");
});

afterAll(async () => {
  await gateway?.stop();
  remote?.close();
});

describe("the MCP gateway", () => {
  it("gives Claude Code one gateway address per server, with only the session's token", () => {
    const servers = session.servers();
    expect(servers.map((s) => s.name)).toEqual(["landlens-kube", "fake"]);
    expect(servers[0]!.url).toBe(gateway.url);
    expect(servers[1]!.url).toBe(`${gateway.url}/fake`);
    for (const s of servers) {
      expect(s.url.startsWith("http://127.0.0.1:")).toBe(true);
      expect(s.headers).toEqual([{ name: "Authorization", value: `Bearer ${session.token}` }]);
    }
    expect(JSON.stringify(servers)).not.toContain("k_secret");
  });

  it("lets only the built-in server and read-only, model-visible tools run without asking", () => {
    expect(session.allow).toEqual(["mcp__landlens-kube", "mcp__fake__list_things"]);
  });

  it("proxies a remote server under its own name, with its header, and hides app-only tools from the model", async () => {
    const c = await connect(`${gateway.url}/fake`, session.token);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["delete_thing", "list_things"]);
    const r: any = await c.callTool({ name: "list_things", arguments: { filter: "x" }, _meta: { "claudecode/toolUseId": "toolu_01ABC" } });
    expect(r.content[0].text).toContain("things matching x");
    expect(r.structuredContent).toBeUndefined(); // the view's data isn't the model's
    expect(seen.every((h) => h === "k_secret")).toBe(true);
    const refused: any = await c.callTool({ name: "refresh", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("for its app's view only");
    await c.close();
  });

  it("logs each call: who, what, how long, a scrubbed preview, and the dock card it belongs to", () => {
    const call = gateway.log.list().find((c) => c.tool === "list_things")!;
    expect(call).toMatchObject({ session: "acp-1", label: "agent 1 · orbstack", server: "fake", origin: "agent", status: "ok", args: { filter: "x" }, toolCallId: "toolu_01ABC", app: "ui://fake/view" });
    expect(call.ms).toBeGreaterThanOrEqual(0);
    expect(call.preview).toContain("things matching x");
    expect(call.preview).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(gateway.log.result(call.id)?.result.structuredContent).toEqual({ things: ["a", "b"] });
    expect(gateway.log.list().find((c) => c.tool === "refresh")).toMatchObject({ status: "refused", origin: "agent" });
    expect(events.some((e) => e.id === call.id && e.status === "running")).toBe(true);
    expect(events.some((e) => e.id === call.id && e.status === "ok")).toBe(true);
  });

  it("serves landlens-kube at /mcp and records the front-door requests of each call", async () => {
    const c = await connect(gateway.url, session.token);
    const { tools } = await c.listTools();
    expect(tools.some((t) => t.name === "cluster_overview")).toBe(true);
    const r: any = await c.callTool({ name: "get_events", arguments: { namespace: "landlens-dev" } });
    expect(r.isError).toBeFalsy();
    await c.close();
    const call = gateway.log.list().find((x) => x.tool === "get_events")!;
    expect(audited.some((a) => a.call === call.id)).toBe(true);
    expect(call.requests.map((q) => q.path).some((p) => p.startsWith("/api/v1/namespaces/landlens-dev/events"))).toBe(true);
  });

  it("asks you before a view runs a tool that doesn't say it only reads, and refuses model-only tools to views", async () => {
    expect((await session.call("fake", "refresh", {}, "app")).isError).toBeFalsy();
    approvals = false;
    const no = await session.call("fake", "delete_thing", { id: "1" }, "app");
    expect(no.isError).toBe(true);
    expect(asked).toEqual(["fake/delete_thing"]);
    approvals = true;
    expect((await session.call("fake", "delete_thing", { id: "1" }, "app")).isError).toBeFalsy();
    expect(gateway.log.list().filter((c) => c.origin === "app").map((c) => c.status)).toEqual(["ok", "refused", "ok"]);
  });

  it("runs only read-only tools for you from the MCP page", async () => {
    const you = await gateway.open({ label: "you · orbstack", context: "orbstack", origin: "you", cluster: fakeCluster(() => {}), remotes: [{ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" } }] });
    expect((await you.call("fake", "list_things", {}, "you")).isError).toBeFalsy();
    expect((await you.call("fake", "delete_thing", { id: "2" }, "you")).isError).toBe(true);
    // Its token doesn't open the HTTP endpoint: that's for Claude Code's sessions only.
    await expect(connect(gateway.url, you.token)).rejects.toThrow();
    await you.close();
  });

  it("serves views: Landlens's own, and a remote's with its declared CSP; refuses other documents", async () => {
    const own = await gateway.appResource(undefined, "landlens-kube", APP_URI.health);
    expect(own.html).toMatch(/^<!doctype html>/i);
    const v = await gateway.appResource(session, "fake", "ui://fake/view");
    expect(v).toMatchObject({ html: "<!doctype html><p>view</p>", prefersBorder: true, csp: { connectDomains: ["https://api.example.com"] } });
    await expect(gateway.appResource(session, "fake", "ui://fake/plain")).rejects.toThrow(/isn't an MCP App view/);
  });

  it("refuses callers without the session token, browsers, other host names and unknown servers", async () => {
    const post = (path: string, headers: Record<string, string>) =>
      fetch(`${gateway.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const auth = { Authorization: `Bearer ${session.token}` };
    expect((await post("", {})).status).toBe(401);
    expect((await post("", { Authorization: `Bearer ${"f".repeat(64)}` })).status).toBe(401);
    expect((await post("", { ...auth, Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/nope", auth)).status).toBe(404);
    expect((await post("/landlens-kube", auth)).status).toBe(404);
    const other = await gateway.open({ label: "agent 2 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [] });
    expect((await post("/fake", { Authorization: `Bearer ${other.token}` })).status).toBe(404); // not turned on for it
    await other.close();
    expect((await post("", { Authorization: `Bearer ${other.token}` })).status).toBe(401);
    expect((await other.call("landlens-kube", "top", {}, "app")).isError).toBe(true);
  });

  it("tests a remote server: initialize, then tools/list; refuses redirects and says why", async () => {
    const ok = await testRemote({ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" } });
    expect(ok.ok).toBe(true);
    expect(ok.steps.map((s) => s.name)).toEqual(["initialize", "tools/list"]);
    expect(ok.steps[1]!.detail).toBe("3 tools, 2 read-only");
    const bad = await testRemote({ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "wrong" } });
    expect(bad.ok).toBe(false);
    const moved = await testRemote({ name: "fake", url: remoteUrl.replace(/\/mcp$/, "/redirect"), headers: { "X-Api-Key": "k_secret" } });
    expect(moved.ok).toBe(false);
    expect(moved.steps[0]!.detail).toMatch(/redirect/i);
  });
});
