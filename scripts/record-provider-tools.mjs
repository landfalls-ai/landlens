#!/usr/bin/env node
// Record GitHub's or Linear's real tool listings for the tests (spec D97): two tools/list calls, one to the full MCP
// endpoint and one to the read-only endpoint, with your own token. Nothing is written to the provider. The token is
// read from the terminal without echo (or from stdin), used for these two listings only, and never written anywhere.
//
//   node scripts/record-provider-tools.mjs github     # a GitHub token (a PAT, or `gh auth token` if you choose to)
//   node scripts/record-provider-tools.mjs linear     # a Linear API key (Read is enough)
//
// Writes packages/connections/test/fixtures/<provider>-tools.json. Then run `pnpm --filter @landlens/connections test`.
//
// The Land family (wave 7, D110): one tools/list call to a sibling's own MCP server, with your own key or token.
//
//   node scripts/record-provider-tools.mjs --family clickland http://localhost:4000   # a Clickland key (ck_…, read)
//   node scripts/record-provider-tools.mjs --family landflow http://localhost:3000    # a Landflow API key (lf_…)
//   node scripts/record-provider-tools.mjs --family landfall http://localhost:8080    # a Landfall access token (mcp:read)
//
// Writes packages/connections/test/fixtures/<sibling>-tools.json; then `pnpm --filter @landlens/mcp-gateway test`
// checks Landlens's list of each sibling's reads against it.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENDPOINTS = {
  github: { full: "https://api.githubcopilot.com/mcp/", readonly: "https://api.githubcopilot.com/mcp/readonly", headers: { "X-MCP-Toolsets": "repos,issues,pull_requests,actions", "X-MCP-Lockdown": "true" } },
  linear: { full: "https://mcp.linear.app/mcp", readonly: "https://mcp.linear.app/mcp/readonly", headers: {} },
};
const SHAPES = { github: /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/, linear: /^lin_(api|oauth)_[A-Za-z0-9]{20,255}$/ };

// A sibling's MCP endpoint on the address you give: http only on this machine.
const FAMILY = { clickland: { path: "/api/mcp", shape: /^ck_[A-Za-z0-9_-]{16,255}$/ }, landflow: { path: "/api/mcp", shape: /^lf_[A-Za-z0-9_-]{16,255}$/ }, landfall: { path: "/mcp", shape: /^[A-Za-z0-9._~+/=-]{16,4096}$/ } };
const family = process.argv[2] === "--family";
const provider = family ? process.argv[3] : process.argv[2];
let familyOrigin;
if (family) {
  let u;
  try {
    u = new URL(process.argv[4] ?? "");
  } catch {}
  const local = u && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!FAMILY[provider] || !u || !(u.protocol === "https:" || (u.protocol === "http:" && local))) {
    console.error("usage: node scripts/record-provider-tools.mjs --family clickland|landflow|landfall <https address, or http on this machine>");
    process.exit(2);
  }
  familyOrigin = u.origin;
} else if (!ENDPOINTS[provider]) {
  console.error("usage: node scripts/record-provider-tools.mjs github|linear  |  --family clickland|landflow|landfall <address>");
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
if (!(family ? FAMILY[provider].shape : SHAPES[provider]).test(token)) {
  console.error(`That isn't shaped like a ${provider} token.`);
  process.exit(2);
}

async function list(url) {
  const headers = { Authorization: `Bearer ${token}`, ...(family ? {} : ENDPOINTS[provider].headers) };
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

if (family) {
  try {
    const tools = await list(`${familyOrigin}${FAMILY[provider].path}`);
    const out = join(root, "packages/connections/test/fixtures", `${provider}-tools.json`);
    const doc = { recorded: true, note: `Recorded ${new Date().toISOString().slice(0, 10)} with scripts/record-provider-tools.mjs --family.`, tools };
    const text = JSON.stringify(doc, null, 1);
    if (text.includes(token)) throw new Error("the listing contains the token; not written");
    writeFileSync(out, text + "\n");
    console.log(`${provider}: ${tools.length} tools, ${tools.filter((t) => t.annotations?.readOnlyHint === true).length} marked read-only → ${out}`);
  } catch (err) {
    console.error(`Recording failed: ${String(err?.message ?? err).replaceAll(token, "…")}`);
    process.exit(1);
  }
  process.exit(0);
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
