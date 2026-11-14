// Minimal ACP v1 client probe: initialize + session/new + one trivial prompt.
// Records every raw JSON-RPC line (both directions) to transcript.raw.jsonl.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";

const here = new URL(".", import.meta.url).pathname;
const out = here + "transcript.raw.jsonl";
const workdir = here + "workdir";
mkdirSync(workdir, { recursive: true });
writeFileSync(out, "");
const t0 = Date.now();
const log = (dir, line) =>
  appendFileSync(out, JSON.stringify({ t: Date.now() - t0, dir, msg: JSON.parse(line) }) + "\n");

function tap(dir) {
  let buf = "";
  const dec = new TextDecoder();
  return new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) log(dir, line);
      }
      ctl.enqueue(chunk);
    },
  });
}

const agent = spawn(here + "node_modules/.bin/claude-agent-acp", [], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: workdir,
  env: { ...process.env, CLAUDE_AGENT_ACP_PROTOCOL: "v1" },
});
agent.stderr.on("data", (d) => appendFileSync(here + "agent.stderr.log", d));

const fromAgent = Readable.toWeb(agent.stdout).pipeThrough(tap("agent->client"));
const toClientTap = tap("client->agent");
toClientTap.readable.pipeTo(Writable.toWeb(agent.stdin));
const stream = acp.ndJsonStream(toClientTap.writable, fromAgent);

const calls = [];
const result = await acp
  .client({ name: "landlens-probe" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    calls.push("session/request_permission");
    const reject = ctx.params.options.find((o) => o.kind.startsWith("reject"));
    return { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } };
  })
  .onRequest(acp.methods.client.fs.readTextFile, () => {
    calls.push("fs/read_text_file");
    throw acp.RequestError.invalidRequest(undefined, "probe: refused");
  })
  .onRequest(acp.methods.client.fs.writeTextFile, () => {
    calls.push("fs/write_text_file");
    throw acp.RequestError.invalidRequest(undefined, "probe: refused");
  })
  .onRequest(acp.methods.client.terminal.create, () => {
    calls.push("terminal/create");
    throw acp.RequestError.invalidRequest(undefined, "probe: refused");
  })
  .onNotification("*", () => {})
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "landlens-probe", title: "Landlens probe", version: "0.0.0" },
    });
    return ctx.buildSession(workdir).withSession(async (session) => {
      // Let the post-session notifications (commands, config) land first.
      await new Promise((r) => setTimeout(r, 1500));
      session.prompt("Reply with exactly the word: pong. Do not use any tools.");
      const kinds = {};
      for (;;) {
        const m = await session.nextUpdate();
        if (m.kind === "stop") return { init, stop: m.stopReason, kinds };
        kinds[m.update.sessionUpdate] = (kinds[m.update.sessionUpdate] ?? 0) + 1;
      }
    });
  });
console.log(JSON.stringify({ protocolVersion: result.init.protocolVersion, authMethods: result.init.authMethods, stop: result.stop, updateKinds: result.kinds, clientMethodsCalled: calls }, null, 2));
agent.kill("SIGTERM");
setTimeout(() => process.exit(0), 500);
