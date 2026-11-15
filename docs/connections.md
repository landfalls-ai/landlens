# Connections: GitHub and Linear

Landlens signs in to GitHub and Linear itself and, from wave 6 part 2, gives their tools to agent sessions through
the MCP gateway. Nothing comes from your Claude Code: sessions load none of your settings, servers, plugins or
keychain tokens (the fence, [agent.md](agent.md)), so a connection is Landlens's own sign-in, held in main.

Wave 6 is built in parts (the spec's section 8). **Part 1, built 15 November 2026:** signing in and the store
(`packages/connections`, `apps/desktop/src/main/connections.ts`, the `conn:*` channels). Not yet built: the
Connections page and the tools in sessions (part 2), the autonomous mode (part 3), Google Cloud (parts 4 and 5).
The security rules are in [security.md](security.md#connections-and-google-cloud).

## Signing in to GitHub

Two ways in:

- **Device flow** (method `device`). Landlens asks GitHub for a code (`POST github.com/login/device/code`, scope
  `repo read:org read:user`), shows it with **Copy** and **Open github.com/login/device**, and polls
  `github.com/login/oauth/access_token` at the interval GitHub gives, five seconds slower after each `slow_down`,
  until you enter the code, GitHub says no, the code expires, or 15 minutes pass. No client secret is needed or
  shipped. The token (`gho_…`) doesn't expire and has no refresh token.
- **A pasted token** (method `token`). A fine-grained personal access token is the one to choose: Metadata read,
  Contents, Issues and Pull requests read and write, on the repositories you pick. A classic token (`repo`,
  `read:org`) works too, but reaches every repository you can. Accepted shapes: `ghp_`, `gho_`, `ghu_`, `ghs_`,
  `ghr_` and `github_pat_` tokens.

Either way Landlens checks the token once with `GET api.github.com/user`: your login and name, and for a classic or
OAuth token its scopes (the `X-OAuth-Scopes` header; a fine-grained token sends none). A token GitHub refuses is not
stored, and the card says "GitHub didn't accept the token."

**Disconnect** deletes the stored token. Revoking an OAuth app's grant at GitHub needs the app's client secret,
which Landlens doesn't have, so the page points you to GitHub: Settings → Applications → Authorized OAuth Apps
(`https://github.com/settings/applications`).

### The OAuth App to register

The device flow needs an OAuth App, because GitHub's MCP server has no dynamic client registration. Until one is
registered, `GITHUB_CLIENT_ID` in `packages/connections/src/providers.ts` is empty, `canDevice` is false, and the page
offers only a pasted token.

To register it (once, by an owner of `landfalls-ai`): GitHub → `landfalls-ai` → Settings → Developer settings →
OAuth Apps → New OAuth App. Name **Landlens**, homepage `https://github.com/landfalls-ai/landlens`, any callback URL
(it isn't used), and tick **Enable Device Flow**. Copy the **client id** into `GITHUB_CLIENT_ID`. Don't make a client
secret: Landlens doesn't use one. A client id is public, so it can sit in the source. To try a client id without
editing the source, an unpackaged build reads `LANDLENS_GITHUB_CLIENT_ID`.

## Signing in to Linear

- **In your browser** (method `oauth`): Linear's MCP server is its own authorization server, with dynamic client
  registration, so there is no app to register. Landlens uses the MCP SDK's own client flow (`auth()`) against
  `https://mcp.linear.app/mcp`: discovery, registration of a public client named "Landlens" (no secret), PKCE S256,
  `state` and the `resource` parameter. It asks for scope `read` at the Read only level and `read write` otherwise.
  The redirect is a one-shot listener on `127.0.0.1` at a port the system picks (`loopback.ts`), registered with the
  client at each sign-in. The browser opens only an https address on `mcp.linear.app`.
- **A pasted API key** (method `token`): `lin_api_…`, sent as the bearer. A key made with only **Read** is the
  read-only choice.

Who you are: for a pasted key, `viewer { name email organization { name } }` on `api.linear.app/graphql`. Whether
Linear's API takes a token issued by its MCP server isn't documented, so Landlens tries the same query once; if it is
refused the card says "Connected" without a name, and the tools still work.

Linear's OAuth tokens expire. Landlens refreshes them with the stored client and refresh token (the SDK's `auth()`
again); in a session it never opens a browser, so a refused refresh marks the connection **expired** ("Linear's
sign-in ran out. Connect again."). Switching a sign-in made at Read only to Ask for writes says it needs signing in
again, since its token can't write.

**Disconnect** revokes the grant at the revocation endpoint Linear's metadata names (on `mcp.linear.app` only, best
effort, 5 seconds), then deletes what is stored. A pasted key can't be revoked from Landlens: delete it in Linear's
settings.

## What is stored

`userData/connections.json`, mode 0600, written through a temp file and a rename. Per provider:

| Field | Kept as |
|---|---|
| `method`, `account` (login, name, org; one line each, at most 100 characters), `scopes`, `mode`, `readsAuto` | clear |
| `pin` (the accepted listings, part 2) and the tool counts | clear |
| `access`, `refresh`, `client` (Linear's `client_id`, `issuer`, `redirect_uri`) | encrypted with Electron's `safeStorage` |
| `expiresAt` | clear |

If `safeStorage` can't encrypt on this machine, connecting is refused: "This machine can't encrypt the token, so
Landlens won't store it." Disconnecting forgets the tokens, account, scopes and pin; the level and switches stay.

## Where a token goes

Only to its provider's own origins, which are constants in `providers.ts`; no channel takes an address:

- GitHub: `api.githubcopilot.com` (the MCP server) and `api.github.com` (`GET /user` only). `github.com` gets the
  device flow's requests, which carry the client id and device code, not a token.
- Linear: `mcp.linear.app` (the MCP server, token, registration, revocation) and `api.linear.app/graphql` (`viewer`
  only).

Every request goes through `pinnedFetch`: another origin is refused before it is asked, a redirect is an error, and
each has a time limit. A token never reaches the renderer, Claude Code's environment, `session/new`, a session's
folder, a log line or an error message: main's log lines go through `rawError`, which cuts bearers and every token
shape in `packages/kube/src/redact.ts` (`gh?_…`, `github_pat_…`, `lin_api_…`, `lin_oauth_…`).

## The channels

| Channel | Request → answer |
|---|---|
| `conn:list` | `{}` → `{ canStore, github: ConnInfo, linear: ConnInfo }` |
| `conn:github-device` | `{}` → `{ flow, userCode, verificationUri: "https://github.com/login/device", expiresIn }` |
| `conn:linear-signin` | `{ mode }` → `{ flow }` once the browser is asked to open |
| `conn:token` | `{ provider, token }` → `ConnInfo` (the token: at most 400 printable characters, the provider's shape) |
| `conn:cancel` | `{ flow }` → `{ ok: true }` (only the window that started it) |
| `conn:set` | `{ provider, mode?, readsAuto? }` → `ConnInfo` |
| `conn:test` | `{ provider }` → `McpTest`: lists the full and the read-only endpoint, marks reads by the read-only listing |
| `conn:repin` | `{ provider }` → `ConnInfo`: accepts the listing the last test showed |
| `conn:disconnect` | `{ provider }` → `ConnInfo` |
| push `conn:update` | `ConnInfo`, when a sign-in ends, a token expires or a listing changed |

`ConnInfo` is everything the page may know: state (`off`, `connecting`, `ready`, `expired`, `failed`), method,
account, scopes, level, whether reads run without asking, tool counts, a note from a fixed set of sentences
(`CONN_NOTES`), and for GitHub whether the device flow is offered. A flow id is `fl` and 16 base64url characters; one
flow per provider at a time; a flow belongs to the window that started it and stops when that window goes.

A test lists both endpoints with the connection's headers (GitHub also gets `X-MCP-Toolsets:
repos,issues,pull_requests,actions` and `X-MCP-Lockdown: true`). A read is a tool the read-only endpoint lists with
the same input schema as the full one; a tool's own `readOnlyHint` plays no part. The page shows the counts; using
them in sessions is part 2.

## Development and tests

No test reaches GitHub or Linear. `packages/connections/test/fake-provider.ts` is one loopback server that plays
either vendor (MCP, OAuth, the device flow, `/user`, `/graphql`) and records every request, so the tests say where a
token went. Its tool listings are `test/fixtures/github-tools.json` and `linear-tools.json`: **hand-made** from the
vendors' documented tool names until recorded (`"recorded": false`).

An unpackaged build reads `LANDLENS_GITHUB_ENDPOINT` and `LANDLENS_LINEAR_ENDPOINT` (`http://127.0.0.1:<port>`
only; every origin of the provider becomes that one) and `LANDLENS_GITHUB_CLIENT_ID`. A packaged app reads none of
them ([development.md](development.md)).

To record the real listings, once, with your own token: `node scripts/record-provider-tools.mjs github` (then
`linear`). It reads the token without echo, makes two `tools/list` calls (full and read-only), writes nothing to the
provider and writes the fixture.

## Left for you to check

- Register the OAuth App (above) and put its client id in `GITHUB_CLIENT_ID`.
- Record the two tool listings with the script.
- Check once that GitHub's MCP server takes a device-flow token: connect with the device flow, then **Test** (or
  `conn:test` for `github`) should list tools from both endpoints. The docs say it takes any OAuth app token; a
  device-flow token is one, but that isn't stated anywhere.
