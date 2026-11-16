// A fake ACP agent for the e2e tests (wave 7 part 5): run by an unpackaged Landlens in place of claude-agent-acp
// (LANDLENS_ACP_AGENT), so a session's turns, tool calls, usage and cost go through main's real AgentService, gateway
// and telemetry without Claude Code. Each prompt calls landlens-kube's api_resources through the session's MCP server
// (a real gateway call, so a real execute_tool span), streams one answer, reports usage_update with a running cost and
// answers with the turn's tokens in `_meta.quota.token_count`, as claude-agent-acp 0.107 does.
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const MODEL = "claude-fake-1";
const sessions = new Map();

async function callKube(servers) {
  const kube = servers.find((s) => s.name === "landlens-kube");
  if (!kube) return "no landlens-kube";
  const headers = Object.fromEntries((kube.headers ?? []).map((h) => [h.name, h.value]));
  const client = new Client({ name: "fake-acp-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(kube.url), { requestInit: { headers } }));
  try {
    const r = await client.callTool({ name: "api_resources", arguments: {} });
    return r.isError ? "error" : "ok";
  } finally {
    await client.close().catch(() => {});
  }
}

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
    agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { servers: ctx.params.mcpServers ?? [], cost: 0, cwd: ctx.params.cwd });
    return { sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Manual" }, { id: "plan", name: "Plan" }] } };
  })
  .onRequest(acp.methods.agent.session.setMode, () => ({}))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    // Every prompt as it arrived, attachments included, beside the session folders (inside Landlens's data folder; a
    // session's own folder goes when it closes), so a test can search all of it (wave 8 part 4: no Secret value
    // reaches the agent).
    try {
      if (s.cwd) appendFileSync(join(s.cwd, "..", "fake-agent-prompts.jsonl"), `${JSON.stringify(ctx.params.prompt)}\n`);
    } catch {
      // a folder that went is no prompt lost to the test: it then finds nothing
    }
    const say = (t) => ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
    if (/^Summarise this session/.test(text)) {
      await say("Checked the cluster's API resources; ");
      await say("nothing was changed.");
    } else {
      const status = await callKube(s.servers).catch(() => "unreachable");
      await say(`I read the cluster's API resources (${status}). `);
      await say("Everything I was asked about looks fine.");
      // What was attached, by its address only (wave 8 part 3's preset asks check the object reached the agent).
      const uris = ctx.params.prompt.filter((b) => b.type === "resource" || b.type === "resource_link").map((b) => b.resource?.uri ?? b.uri).filter(Boolean);
      if (uris.length) await say(` Attached: ${uris.join(", ")}.`);
    }
    s.cost += 0.0125;
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "usage_update", used: 4200, size: 200000, cost: { amount: s.cost, currency: "USD" }, _meta: { "_claude/model": MODEL } },
    });
    return { stopReason: "end_turn", _meta: { quota: { token_count: { inputTokens: 1500, outputTokens: 220, cachedInputTokens: 900, cachedWriteTokens: 100 } } } };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
