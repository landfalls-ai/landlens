// A fake ACP agent for the e2e tests (wave 7 part 5): run by an unpackaged Landlens in place of claude-agent-acp
// (LANDLENS_ACP_AGENT), so a session's turns, tool calls, usage and cost go through main's real AgentService, gateway
// and telemetry without Claude Code. Each prompt calls landlens-kube's api_resources through the session's MCP server
// (a real gateway call, so a real execute_tool span), streams one answer, reports usage_update with a running cost and
// answers with the turn's tokens in `_meta.quota.token_count`, as claude-agent-acp 0.107 does.
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Wave 10: a prompt whose first line is `view-script: <name>` runs fixtures/views/<name>.json, an array of
 * `{ tool, arguments }` for landlens-views, through the session's server (the real gateway), each as a tool card, and
 * says each result. `__PROBE__`, `__WSPROBE__` and `__STUNPROBE__` in the arguments become the test's own listeners,
 * so a hostile block can aim at them; `__NETHOST__` the test's own unique host name, which its net log must never show.
 * They come from fake-agent-env.json beside the session folders, written by the test: Landlens hands the agent only
 * its allowlisted environment (agentEnv), so a LANDLENS_FAKE_* variable never reaches this process. Results go to
 * fake-agent-results.jsonl, in the same folder, for the test.
 */
const VIEWS = join(dirname(fileURLToPath(import.meta.url)), "views");
async function viewScript(name, s, sessionId, notify, say) {
  const views = s.servers.find((x) => x.name === "landlens-views");
  if (!views) return say("This session has no landlens-views.");
  let given = {};
  try {
    if (s.cwd) given = JSON.parse(readFileSync(join(s.cwd, "..", "fake-agent-env.json"), "utf8"));
  } catch {
    // none written: the defaults below
  }
  const probe = given.probe ?? "http://127.0.0.1:9";
  const u = new URL(probe);
  let raw = readFileSync(join(VIEWS, `${name}.json`), "utf8");
  raw = raw.replaceAll("__NETHOST__", given.nethost ?? "views-e2e.invalid").replaceAll("__PROBE__", probe).replaceAll("__WSPROBE__", `ws://${u.host}`).replaceAll("__STUNPROBE__", `stun:${u.hostname}:${given.stun ?? "9"}`);
  const steps = JSON.parse(raw);
  const headers = Object.fromEntries((views.headers ?? []).map((h) => [h.name, h.value]));
  const client = new Client({ name: "fake-acp-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(views.url), { requestInit: { headers } }));
  try {
    for (const step of steps) {
      const toolCallId = randomUUID();
      const title = `mcp__landlens-views__${step.tool}`;
      await notify({ sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress", rawInput: step.arguments, _meta: { claudeCode: { toolName: title } } });
      const r = await client.callTool({ name: step.tool, arguments: step.arguments });
      const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
      await notify({ sessionUpdate: "tool_call_update", toolCallId, status: r.isError ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text } }] });
      try {
        if (s.cwd) appendFileSync(join(s.cwd, "..", "fake-agent-results.jsonl"), `${JSON.stringify({ tool: step.tool, text, isError: !!r.isError })}\n`);
      } catch {
        // as for prompts
      }
      await say(`${step.tool}: ${text.split("\n")[0]}\n`);
    }
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
    const script = /^view-script: ([a-z0-9-]{1,40})$/m.exec(text.split("\n")[0] ?? "");
    if (script) {
      const notify = (update) => ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
      await viewScript(script[1], s, ctx.params.sessionId, notify, say).catch((e) => say(`The script failed: ${e.message}`));
    } else if (/^Summarise this session/.test(text)) {
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
