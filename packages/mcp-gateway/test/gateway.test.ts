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
import { DRAFTING, listingHash, McpGateway, newCallId, testRemote, type GatewaySession, type RemoteSpec } from "../src/index.js";

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
    if (req.url === "/relay") {
      // A page could point Test anywhere; whatever comes back must not be repeated to it.
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("RELAYED-BODY from somewhere the page can't reach");
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
const drifts: string[] = [];
let pin = "";

const connect = async (url: string, token: string) => {
  const c = new Client({ name: "claude-code-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};

beforeAll(async () => {
  remote = fakeRemote(seen);
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`;
  gateway = new McpGateway({ approve: async (q) => { asked.push(`${q.server}/${q.tool}`); return approvals; }, onDrift: (s) => drifts.push(s.name) });
  await gateway.start();
  gateway.log.subscribe((c) => events.push(c));
  // What the MCP page showed after Test, pinned when you turned on "Run read-only tools without asking".
  pin = listingHash((await testRemote({ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" } })).tools!);
  session = await gateway.open({
    label: "agent 1 · orbstack", context: "orbstack", origin: "agent",
    cluster: fakeCluster((call, path) => {
      audited.push({ ...(call ? { call } : {}), path });
      gateway.onAudit({ at: new Date().toISOString(), label: "agent 1 · orbstack", method: "GET", cluster: "h", path, allowed: true, status: 200, ...(call ? { call } : {}) });
    }),
    remotes: [{ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" }, pin }],
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

  it("lets only the built-in server and, for a server you opted in, its read-only, model-visible tools run without asking", () => {
    expect(session.allow).toEqual(["mcp__landlens-kube", "mcp__fake__list_things"]);
    expect(drifts).toEqual([]);
  });

  it("pre-allows nothing of a remote server you didn't opt in, or whose listing changed since you did", async () => {
    const spec: RemoteSpec = { name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" } };
    const off = await gateway.open({ label: "agent 7 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [spec] });
    expect(off.allow).toEqual(["mcp__landlens-kube"]);
    await off.close();
    const changed = await gateway.open({ label: "agent 8 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [{ ...spec, pin: "0".repeat(64) }] });
    expect(changed.allow).toEqual(["mcp__landlens-kube"]);
    expect(drifts).toEqual(["fake"]);
    await changed.close();
    drifts.length = 0;
    // One that doesn't answer isn't said to have changed: it just asks.
    const down = await gateway.open({ label: "agent 9 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [{ ...spec, url: "http://127.0.0.1:1/mcp", pin }] });
    expect(down.allow).toEqual(["mcp__landlens-kube"]);
    expect(drifts).toEqual([]);
    await down.close();
  });

  it("runs an agent's call to a tool that isn't pre-allowed only after your yes in the dock, once per yes", async () => {
    const c = await connect(`${gateway.url}/fake`, session.token);
    const call = (id?: string) => c.callTool({ name: "delete_thing", arguments: { id: "9" }, ...(id ? { _meta: { "claudecode/toolUseId": id } } : {}) }) as Promise<any>;
    const no = await call("toolu_skip");
    expect(no.isError).toBe(true);
    expect(no.content[0].text).toContain("needs your yes in the dock");
    gateway.card({ session: "acp-1", toolCallId: "toolu_yes", toolName: "mcp__fake__delete_thing" });
    gateway.permit("acp-1", { toolCallId: "toolu_yes", always: false });
    expect((await call("toolu_yes")).isError).toBeFalsy();
    expect((await call("toolu_yes")).isError).toBe(true); // a yes is used up by its call
    // A yes for one tool doesn't run another.
    gateway.card({ session: "acp-1", toolCallId: "toolu_other", toolName: "mcp__fake__list_things" });
    gateway.permit("acp-1", { toolCallId: "toolu_other", always: false });
    expect((await call("toolu_other")).isError).toBe(true);
    // Without a tool_use id (an older Claude Code), the oldest unused yes for the same tool.
    gateway.permit("acp-1", { toolCallId: "toolu_noid", toolName: "mcp__fake__delete_thing", always: false });
    expect((await call()).isError).toBeFalsy();
    expect((await call()).isError).toBe(true);
    // "Don't ask again" holds for the session; another session's answers don't count.
    gateway.permit("acp-2", { toolCallId: "toolu_x", toolName: "mcp__fake__delete_thing", always: true });
    expect((await call("toolu_y")).isError).toBe(true);
    gateway.permit("acp-1", { toolCallId: "toolu_x", toolName: "mcp__fake__delete_thing", always: true });
    expect((await call("toolu_y")).isError).toBeFalsy();
    expect((await call()).isError).toBeFalsy();
    await c.close();
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

  it("refuses every call of the agent's while Claude drafts the brain's summary (review of wave 7 part 5, L4)", async () => {
    const c = await connect(`${gateway.url}/fake`, session.token);
    gateway.drafting("acp-1", true);
    const r: any = await c.callTool({ name: "list_things", arguments: { filter: "x" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Landlens: ${DRAFTING}`);
    gateway.drafting("acp-1", false);
    const after: any = await c.callTool({ name: "list_things", arguments: { filter: "x" } });
    expect(after.isError).toBeFalsy();
    await c.close();
  });

  it("knows a tool by name only as its server listed it, pinned or Landlens's own (L8)", async () => {
    expect(gateway.knownTool(session.id, "landlens-kube", "get_events")).toBe(true);
    expect(gateway.knownTool(session.id, "fake", "list_things")).toBe(true);
    expect(gateway.knownTool(session.id, "fake", "a_name_the_agent_made_up")).toBe(false);
    expect(gateway.knownTool(session.id, "landlens-kube", "a_name_the_agent_made_up")).toBe(false);
    expect(gateway.knownTool("not-a-session", "landlens-kube", "get_events")).toBe(false);
    // A listing that isn't the pinned one: none of its names.
    const changed = await gateway.open({ label: "agent 18 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [{ name: "fake", url: remoteUrl, headers: { "X-Api-Key": "k_secret" }, pin: "0".repeat(64) }] });
    changed.bind("acp-18");
    expect(gateway.knownTool(changed.id, "fake", "list_things")).toBe(false);
    await changed.close();
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

  it("files a front-door request under a call only for that session's token, a landlens-kube call, while it runs", async () => {
    const done = gateway.log.list().find((x) => x.tool === "get_events")!;
    const before = done.requests.length;
    const plant = (call: string, label: string) => gateway.onAudit({ at: new Date().toISOString(), label, method: "GET", cluster: "h", path: "/planted", allowed: true, status: 200, call });
    plant(done.id, "agent 1 · orbstack"); // finished
    const remoteCall = gateway.log.list().find((x) => x.server === "fake")!;
    plant(remoteCall.id, "agent 1 · orbstack"); // not landlens-kube
    expect(gateway.log.get(done.id)!.requests.length).toBe(before);
    expect(gateway.log.get(remoteCall.id)!.requests).toEqual([]);
    // While a call runs, a request made with another token (another label) isn't filed under it.
    let running = "";
    const slow = gateway.open({
      label: "agent 5 · orbstack", context: "orbstack", origin: "agent", remotes: [],
      cluster: { ...fakeCluster(() => {}), withCall: (id) => ({ ...fakeCluster(() => {}), get: async (path) => {
        running = id;
        plant(id, "agent 6 · orbstack");
        plant(id, "agent 5 · orbstack");
        return { status: 200, text: JSON.stringify({ items: [] }) };
      } }) },
    });
    const s5 = await slow;
    await s5.call("landlens-kube", "get_events", { namespace: "x" }, "app");
    expect(gateway.log.get(running)!.requests.map((r) => r.path)).toEqual(["/planted"]);
    await s5.close();
    // Ids are random, in the format the front door accepts.
    const ids = new Set(Array.from({ length: 200 }, () => newCallId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^c[0-9a-z]{20}$/);
  });

  it("asks you before a view runs a tool that doesn't say it only reads, and refuses model-only tools to views", async () => {
    expect((await session.call("fake", "refresh", {}, "app")).isError).toBeFalsy();
    approvals = false;
    const no = await session.call("fake", "delete_thing", { id: "1" }, "app");
    expect(no.isError).toBe(true);
    expect(asked).toEqual(["fake/delete_thing"]);
    approvals = true;
    expect((await session.call("fake", "delete_thing", { id: "1" }, "app")).isError).toBeFalsy();
    expect(gateway.log.list().filter((c) => c.origin === "app" && c.label === "agent 1 · orbstack").map((c) => c.status)).toEqual(["ok", "refused", "ok"]);
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
    // After the session ends, a call's view comes from the cache of the address that call used, never by name.
    expect(await gateway.appResource(undefined, "fake", "ui://fake/view", remoteUrl)).toBe(v);
    await expect(gateway.appResource(undefined, "fake", "ui://fake/view", "https://elsewhere.example/mcp")).rejects.toThrow(/ended/);
    await expect(gateway.appResource(undefined, "fake", "ui://fake/view")).rejects.toThrow(/ended/);
    const kept = gateway.log.list().find((c) => c.tool === "list_things" && c.status === "ok")!;
    expect(gateway.log.result(kept.id)?.url).toBe(remoteUrl);
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

  it("never repeats what a tested address answered: fixed sentences only", async () => {
    const r = await testRemote({ name: "test", url: remoteUrl.replace(/\/mcp$/, "/relay") });
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.detail).toBe("The server answered HTTP 500.");
    expect(JSON.stringify(r)).not.toContain("RELAYED");
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const port = (free.address() as AddressInfo).port;
    await new Promise((r) => free.close(r));
    const none = await testRemote({ name: "test", url: `http://127.0.0.1:${port}/mcp` });
    expect(none.steps[0]!.detail).toBe("Nothing is listening at that address.");
  });
});

describe("built-ins as a map: landlens-gcp (wave 6, D93)", () => {
  /** A stand-in for landlens-gcp: one read-only tool. */
  const gcpServer = () => {
    const s = new McpServer({ name: "landlens-gcp", version: "0.1.0" });
    s.registerTool("gcp_projects", { description: "Chosen projects.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "demo-shop" }] }));
    return s;
  };

  it("serves it at /mcp/landlens-gcp, allowed whole, and runs its calls without a permit", async () => {
    const s = await gateway.open({ label: "agent 9 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [], builtins: [{ name: "landlens-gcp", server: gcpServer }] });
    try {
      s.bind("acp-9");
      expect(s.servers().map((x) => [x.name, x.url])).toEqual([["landlens-kube", gateway.url], ["landlens-gcp", `${gateway.url}/landlens-gcp`]]);
      expect(s.allow).toEqual(["mcp__landlens-kube", "mcp__landlens-gcp"]);
      const c = await connect(`${gateway.url}/landlens-gcp`, s.token);
      const r: any = await c.callTool({ name: "gcp_projects", arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toBe("demo-shop");
      await c.close();
      const call = gateway.log.list().find((x) => x.server === "landlens-gcp" && x.session === "acp-9")!;
      expect(call.status).toBe("ok");
      expect((await gateway.autonomyCheck("acp-9", "mcp__landlens-gcp__gcp_projects", {})).ok).toBe(false);
      // Turned off: it leaves the open session at once.
      gateway.dropBuiltin("landlens-gcp");
      expect(s.allow).toEqual(["mcp__landlens-kube"]);
      const post = await fetch(`${gateway.url}/landlens-gcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(post.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it("isn't served to a session that wasn't given it, and no remote server may take its name", async () => {
    const plain = await gateway.open({ label: "agent 10 · orbstack", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [] });
    try {
      expect(plain.servers().map((x) => x.name)).toEqual(["landlens-kube"]);
      const post = await fetch(`${gateway.url}/landlens-gcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${plain.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(post.status).toBe(404);
    } finally {
      await plain.close();
    }
    for (const name of ["landlens-gcp", "landlens-kube", "landlens-x"]) {
      await expect(gateway.open({ label: "x", context: "orbstack", origin: "agent", cluster: fakeCluster(() => {}), remotes: [{ name, url: remoteUrl }] })).rejects.toThrow(/bad MCP server name/);
    }
  });
});
