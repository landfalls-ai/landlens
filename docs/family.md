# The Land family: Clickland, Landflow and Landfall

Landlens signs in to the land family services you run: **Clickland** (observability), **Landflow** (workflows and
the brain) and **Landfall** (incident war rooms). A family connection is Landlens's own sign-in, held in Electron
main like GitHub's and Linear's ([connections.md](connections.md)). Its key, webhook secret or tokens are stored
encrypted and never reach the window. The design is in wave 7's spec (D100–D138), and how Landlens meets each sibling
is in [research/land-family.md](research/land-family.md).

Wave 7 is built in five parts. **Part 1, built 15 November 2026:** the connections themselves, described on this
page: the store, the sign-ins, the clients that ask each sibling who you are, and the **Land family** section of the
Connections page. Still to come: part 2, the family's tools in Claude sessions; part 3, Clickland's logs and traces
in the IDE; part 4, Landflow on a resource (triage, the war room, flows); part 5, Landlens's telemetry and the brain.
See [roadmap.md](roadmap.md).

## How Landlens signs in

| Sibling | How | What it asks to know who you are |
|---|---|---|
| Clickland | The read key Landlens already used for graphs (`ck_…`), set in **Connect Clickland** ([metrics.md](metrics.md)). It stays in `userData/clickland.json`, so nothing moved | `GET /api/auth/me` with the key: the role and the key's scopes. A key that can do more than `read` and `usage:read` is kept, and the card says "This key can also write. A key with only read is enough." |
| Landflow | An API key you paste: `lf_` and 20–128 letters, digits, `_` or `-`, but never `lf_mcp_` (an instance MCP token acts for nobody), `lf_key_` (Landfall's) or `lf_dbg_` | `GET /api/health`, then `GET /api/auth/me`, which must answer `via: "api-key"` with the key's scopes. The card works out what the key can do: **Brain** needs `brain:write`, **Flows** need `workflows:read` and `run` (and `executions:read` to see what a run did). A key with `admin` or `workflows:write` is kept, with "This key can also change workflows. Landlens doesn't need that." |
| Landfall | Its MCP connector's own OAuth in your browser: discovery, dynamic registration as a public client named "Landlens", PKCE S256, a one-shot loopback redirect. Landfall's page signs you in through Landbright | Landlens asks for `mcp:read` **only**, never `mcp:ack`. A Landfall whose connector is off (its metadata answers 404, as the local one does today) gets "This Landfall doesn't offer its MCP connector (MCP_GATEWAY_ENABLED is off)." |

Make the Landflow key in Landflow: user menu, **Connect your harness**, **Any MCP client**, with **Brain** ticked and,
for part 4, **Read workflows** and **Run**. Add `executions:read` from Settings, API keys. Revoke it there too:
**Disconnect** in Landlens forgets the key, but only Landflow can revoke it.

Landfall's sign-in is the flow Linear uses (wave 6, D74). `LinearAuth` became `McpOAuth`
(`packages/connections/src/mcp-oauth.ts`), with the resource URL, the one origin every endpoint must be on, the
client name and the scopes as its target. Linear is now one caller of it and Landfall another. Linear's 39 tests
are unchanged and pass. Every endpoint the metadata names must be on Landfall's own origin, or the sign-in stops
before registering: "Landfall's sign-in named another server, so Landlens stopped." **Sign out** first revokes both
tokens at the metadata's `revocation_endpoint` (best effort, 5 s), then forgets them. A refresh that Landfall refuses
leaves the card at **Sign-in ran out**, with **Sign in again**.

Landlens never opens a war room itself. It never calls Landfall's `POST /triggers` (nor its timeline or artifact
routes). Rooms open only through Landflow's triage flow, from part 4. The Landfall card carries that sentence as its
one fixed row.

Landbright sign-in for Landlens itself is not built (D104). A Landbright token opens nothing today: Clickland and
Landflow take keys, and Landfall's connector issues its own tokens.

## A sibling's address

One rule for all three (`FamilyUrl` in the contracts; `ClicklandUrl` is now the same rule):

- An origin only: `scheme://host[:port]`, with at most a trailing `/`. No user info, path, query or fragment.
- https anywhere, or plain http only to this machine (`127.0.0.1`, `localhost`, `[::1]`).
- In an **unpackaged** build only, plain http also goes to the exact host names listed in
  `LANDLENS_FAMILY_HTTP_HOSTS` (comma-separated, each `^[a-z0-9.-]{1,253}$`, at most 20). The local Landflow
  answers at `http://landflow-host.landflow-dev.svc.cluster.local:3000`, a plain-http name. A packaged app reads
  no override: forward `landflow-host` port 3000 in Landlens (Forwards) and type `http://127.0.0.1:<port>`. The
  card's help says so.

Main checks the rule again on every request; the window's check is only for the help text. Every request goes only
to the stored origin, refuses redirects, and has a time limit: 8 s for health and who-am-I. A failure is a fixed
sentence, never what the other end sent: "Landflow answered HTTP 502.", "Nothing is listening at that address.",
"Landflow refused the key.", "Landflow didn't answer in time." The raw error goes only to main's log, with every held
secret cut out. The sentences are `FAMILY_NOTES` in `packages/contracts/src/index.ts`.

## What is stored

`userData/family.json`, mode 0600, written to a temp file and renamed. A damaged file is moved aside, not read.
For each sibling it holds the origin, the account (name, email, role; each at most 100 characters on one line), the
scopes as the sibling reported them, the two switches for part 2 (`toSessions` off, `readsAuto` on), and these
`safeStorage` blobs:

- Landflow: `key`, and the triage webhook's `triageSecret`.
- Landfall: `access`, `refresh` and the registered `client`.

Clickland's key stays in `clickland.json` (`ClicklandSettingsStore`), which also gains the console address for
part 3's links. What Clickland's who-am-I said is kept in `family.json` with the origin it was asked at. It is
forgotten when the key or address changes in **Connect Clickland**, and asked again in the background.

A secret is bound to the origin it was saved for. Connecting Landflow at another address without pasting the key
again is refused: "Paste the key again: a stored key never follows a new address." Moving the address also drops the
webhook secret. If `safeStorage` can't encrypt, nothing is stored: "This machine can't encrypt the token, so Landlens
won't store it." **Disconnect** drops the secrets, the account and the scopes. It keeps the address, the switches and
the webhook's path and header name, so connecting again is quick.

## The Connections page

A **Land family** section under Google Cloud, with one card per sibling (`FamilyCards.tsx`). Each card shows its
sibling's mark, the name and a state badge (**Ready**, **Off**, **Signing in…**, **Sign-in ran out**, **Failed**).
When connected, it also shows the address, who you are there, and rows that each keep their state on the line's
right.

- **Clickland**: **Connect…** opens the Connect Clickland dialog (from the Connections page it asks for no cluster
  name, which stays per context in the cluster's own dialog). Connected: **Settings…**, **Disconnect**, the
  account and role, and a **Graphs** row (**In use**).
- **Landflow**: the address and the API key (its shape is checked as you type), the help on where to make the key,
  and **Connect**. Connected: who you are, rows for **Brain** ("Can record your work" or the missing scope),
  **Flows** ("Can list and run", or which scope is missing) and **Triage webhook** (**Set up** or **Edit**).
- **Landfall**: the address and **Sign in**, which opens Landfall's page in your browser. While signing in, the card
  shows **Cancel**; when the sign-in runs out, **Sign in again**; when connected, **Sign out**. Its one fixed row:
  "War rooms open through Landflow's triage flow. Landlens never opens one itself."

Every card has **Check**. It asks the sibling's health and who-am-I again, and for Landfall it checks the connector
and starts an MCP session. The result shows as a list of steps.

### The triage webhook (stored now, used in part 4)

Part 4 sends a problem to Landflow's triage flow through a webhook trigger. The Landflow card stores where it is:

- **Path**: the webhook's path under `/api/webhook/` (default `alerts`).
- **Header name**: the header that carries the secret (default `X-Webhook-Secret`).
- **Secret**: stored with `safeStorage`, and shown afterwards only as "Secret stored".

The header name can't be `Authorization`, `Cookie`, `Host`, `Proxy-Authorization`, `Connection`, a `Content-*`
header, `Transfer-Encoding`, `Idempotency-Key` or an `X-Landlens-*` header. Landlens sets those itself. Landflow's own
example uses `Authorization`: give the webhook trigger another header name there.

**Remove** forgets the webhook and its secret.

## IPC

| Channel | Request → answer |
|---|---|
| `family:list` | `{ context? }` → `{ canStore, clickland, landflow, landfall }`, each a `FamilyInfo` |
| `family:connect` | `{ sibling: "landflow", url, key? }` → `FamilyInfo`. Without `key`, the stored one is used only for the same origin |
| `family:signin` | `{ sibling: "landfall", url }` → `{ flow }`. The browser opens. `conn:cancel` ends the flow, and the flow belongs to the window that started it |
| `family:set` | `{ sibling, toSessions?, readsAuto?, console?, triage? }` → `FamilyInfo`. `console` is Clickland's only and `triage` is Landflow's only; `triage: null` removes the webhook |
| `family:test` | `{ sibling }` → the check's steps |
| `family:disconnect` | `{ sibling }` → `FamilyInfo` |
| push `family:update` | `FamilyInfo` |

`FamilyInfo` carries no secret: the state, the origin, the method, the account, the scopes, the switches, a note (a
fixed sentence), what a Landflow key can do, the webhook's path and header with `hasSecret`, and Clickland's console
address. Clickland still connects through `metrics:configure` and `metrics:test`, and both now tell the family
service, so the card follows. `family:repin` (part 2) and the telemetry fields (part 5) come with their parts.

## Code

- `packages/connections/src/family.ts`: the sibling clients (health, who-am-I, Landfall's connector check and its
  OAuth target) and the sentences.
- `packages/connections/src/family-store.ts`: `FamilyStore`.
- `packages/connections/src/mcp-oauth.ts`: `McpOAuth`, `mcpSignIn`, `mcpRefresh` and `mcpRevoke`, shared with
  `linear.ts`.
- `apps/desktop/src/main/family.ts`: `FamilyService`, `familyOverrides`.
- `ipc.ts`, `index.ts` and the preload list.
- `apps/desktop/src/renderer/src/FamilyCards.tsx`, the marks in `icons.tsx`, and the styles in `connections.css`.
- `packages/kube/src/redact.ts` scrubs `lf_…` and `ck_…` shaped keys from what the agent reads.

## Tests

No test reaches a sibling. `packages/connections/test/fake-family.ts` (D136) has one loopback server for each
sibling, built from the sibling's docs and code. Each records every request and has `/_fake/state`:

- **Fake Clickland**: health, `auth/me` by key, MCP with 23 tools, and an OTLP sink.
- **Fake Landflow**: health, `auth/me` with scopes by key, the webhook, workflows, execute, executions, `brain/work`,
  and MCP tools by scope.
- **Fake Landfall**: the connector's metadata, register, authorize (it approves at once), token, revoke, and `/mcp`.
  It can play a connector that is off, a sign-in that is turned down, short-lived tokens and a refused refresh. Any
  request for a trigger, timeline or artifact route is recorded in `forbidden`, which the tests expect to be empty.

Clickland's `/api/search` and traces come with part 3.

- `family.test.ts`: the address rule and its overrides, the key shapes, who-am-I for each sibling, every sentence, a
  redirect and a timeout.
- `mcp-oauth.test.ts`: Landfall's sign-in asks for `mcp:read` only, the origin pin, a turned-down sign-in, refresh
  and expiry, and revoke.
- `family-store.test.ts`: encryption and the file's mode, origin binding, no secret in `FamilyInfo`, the webhook,
  disconnect, damaged files.
- `apps/desktop/test/family-main.test.ts`: `FamilyService` end to end against the fakes.
- `apps/desktop/test/family.e2e.test.ts`, on the built app: it connects all three against the fakes. A plain-http
  name is refused before any request and `Authorization` is refused as the webhook header. Afterwards, neither
  `family:list` nor the profile folder holds a secret, and the fake Landfall saw no trigger. The cards are checked
  at 1024×700. Sign-out revokes both tokens.

The commands are in [development.md](development.md). The live checks against your own siblings (D137) are not run
yet.

## Left for later

See [limitations.md](limitations.md):

- The family's tools in sessions, and the **Tools for Claude** and **Reads run without asking** rows (part 2). The
  switches are stored already.
- Clickland's console address in its dialog (part 3).
- Sending to triage and running flows (part 4).
- Telemetry and the brain (part 5).
- Checking each link live with a real key.
