#!/usr/bin/env node
// Record GitHub's or Linear's real tool listings for the tests (spec D97): two tools/list calls, one to the full MCP
// endpoint and one to the read-only endpoint, with your own token. Nothing is written to the provider. The token is
// read from the terminal without echo (or from stdin), used for these two listings only, and never written anywhere.
//
//   node scripts/record-provider-tools.mjs github     # a GitHub token (a PAT, or `gh auth token` if you choose to)
//   node scripts/record-provider-tools.mjs linear     # a Linear API key (Read is enough)
//
// Writes packages/connections/test/fixtures/<provider>-tools.json. Then run `pnpm --filter @landlens/connections test`.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENDPOINTS = {
  github: { full: "https://api.githubcopilot.com/mcp/", readonly: "https://api.githubcopilot.com/mcp/readonly", headers: { "X-MCP-Toolsets": "repos,issues,pull_requests,actions", "X-MCP-Lockdown": "true" } },
  linear: { full: "https://mcp.linear.app/mcp", readonly: "https://mcp.linear.app/mcp/readonly", headers: {} },
};
const SHAPES = { github: /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/, linear: /^lin_(api|oauth)_[A-Za-z0-9]{20,255}$/ };

const provider = process.argv[2];
if (!ENDPOINTS[provider]) {
  console.error("usage: node scripts/record-provider-tools.mjs github|linear");
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "packages/connections/package.json"));
const load = (p) => import(pathToFileURL(require.resolve(p)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await load("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function readToken() {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s.trim();
  }
  process.stdout.write(`${provider} token (not shown): `);
  process.stdin.setRawMode(true);
  let s = "";
  for await (const c of process.stdin) {
    for (const ch of c.toString("utf8")) {
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return s.trim();
      }
      if (ch === "\u0003") process.exit(130);
      s = ch === "\u007f" ? s.slice(0, -1) : s + ch;
    }
  }
  return s.trim();
}

const token = await readToken();
if (!SHAPES[provider].test(token)) {
  console.error(`That isn't shaped like a ${provider} token.`);
  process.exit(2);
}

async function list(url) {
  const headers = { Authorization: `Bearer ${token}`, ...ENDPOINTS[provider].headers };
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: (i, init) => fetch(i, { ...init, redirect: "error" }) });
  const client = new Client({ name: "landlens-record", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await client.listTools(cursor ? { cursor } : {});
      tools.push(...r.tools);
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools.sort((a, b) => (a.name < b.name ? -1 : 1));
  } finally {
    await client.close();
  }
}

try {
  const full = await list(ENDPOINTS[provider].full);
  const readonly = await list(ENDPOINTS[provider].readonly);
  const out = join(root, "packages/connections/test/fixtures", `${provider}-tools.json`);
  const doc = { recorded: true, note: `Recorded ${new Date().toISOString().slice(0, 10)} with scripts/record-provider-tools.mjs.`, full, readonly };
  const text = JSON.stringify(doc, null, 1);
  if (text.includes(token)) throw new Error("the listing contains the token; not written");
  writeFileSync(out, text + "\n");
  console.log(`${provider}: ${full.length} tools, ${readonly.length} read-only → ${out}`);
} catch (err) {
  console.error(`Recording failed: ${String(err?.message ?? err).replaceAll(token, "…")}`);
  process.exit(1);
}
