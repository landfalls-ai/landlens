# ACP research: running Claude Code inside Landlens

Landlens is an ACP client. It starts the user's Claude Code as an ACP agent, gives it the cluster the user is
looking at, and shows the conversation, tool calls and diffs in the IDE. This page is the protocol research, read
from source on 2026-11-14.

## Sources and citation style

| Source | Version | Path |
| --- | --- | --- |
| ACP spec, schema, docs | `agentclientprotocol/agent-client-protocol` @ `13b76582`, schema v1.32.0 | `upstream/acp-spec` |
| TypeScript SDK | `@agentclientprotocol/sdk` 2.7.0 | `upstream/acp-typescript-sdk` |
| Claude adapter | `@agentclientprotocol/claude-agent-acp` 0.107.0 (Claude Agent SDK 0.3.323, Claude CLI 2.1.323) | `upstream/claude-agent-acp` |
| Live handshake | run on this machine, 2026-11-14 | `study/acp-handshake/` |

- `file:line` paths are relative to `upstream/`, except `study/...`, which is relative to the repo root.
- `[docs]` marks a claim that only the spec's prose supports (an `.mdx` page), not the JSON schema or code.
- Everything here is ACP **v1**. The spec also has a draft v2. See [Which protocol version](#which-protocol-version).

## Which protocol version

- v1 is the stable protocol. The SDK's default import is v1 (`acp-typescript-sdk/README.md:19-24`,
  `acp-typescript-sdk/package.json:32`).
- v2 is a draft. It removes `fs/*`, `terminal/*` and session modes, and the `session/prompt` response no longer
  ends the turn (`acp-spec/docs/protocol/v2/migration.mdx:12-16`, `:57-58` [docs]; `acp-spec/schema/v2/meta.json:1-27`).
- claude-agent-acp serves both. A client that asks for version 2 gets v2, every other client gets v1.
  `CLAUDE_AGENT_ACP_PROTOCOL=v1|v2|auto` pins it (`claude-agent-acp/README.md:56-71`,
  `claude-agent-acp/src/serve.ts:14-25`, `:61-73`).
- Landlens should speak v1 and send `protocolVersion: 1`. v2 can come later behind a flag.

## 1. Transport and lifecycle

### Transport

- The client launches the agent as a subprocess and talks JSON-RPC 2.0 over its stdin and stdout
  (`acp-spec/docs/protocol/v1/transports.mdx:6`, `:16-19` [docs]).
- One JSON message per line. Messages must not contain a raw newline (`transports.mdx:20-21` [docs]).
- The agent may log to stderr. Nothing but ACP goes to stdout (`transports.mdx:22-24` [docs]). claude-agent-acp
  redirects every `console.*` call to stderr for this reason (`claude-agent-acp/src/index.ts:54-59`).
- A remote Streamable HTTP transport is only an RFD so far (`transports.mdx:8` [docs]).
- claude-agent-acp exits when stdin closes, so closing stdin is a clean shutdown (`claude-agent-acp/src/index.ts:98-107`).

### Methods, in call order

| Method | Direction | Kind | Gate | Notes |
| --- | --- | --- | --- | --- |
| `initialize` | client → agent | request | always first | Negotiates version and capabilities |
| `authenticate` | client → agent | request | an `agent`-type `authMethods` entry | Not for `terminal` methods |
| `logout` | client → agent | request | `agentCapabilities.auth.logout` | |
| `session/new` | client → agent | request | baseline | Returns `sessionId`, optional `modes`, `configOptions` |
| `session/load` | client → agent | request | `loadSession: true` | Replays history as `session/update`, then responds |
| `session/resume` | client → agent | request | `sessionCapabilities.resume` | No replay |
| `session/list` | client → agent | request | `sessionCapabilities.list` | Paged by `cursor`, filter by `cwd` |
| `session/close` | client → agent | request | `sessionCapabilities.close` | Cancels work, frees resources, idempotent |
| `session/delete` | client → agent | request | `sessionCapabilities.delete` | |
| `session/set_mode` | client → agent | request | modes were returned | Deprecated in favour of config options |
| `session/set_config_option` | client → agent | request | `configOptions` were returned | |
| `session/prompt` | client → agent | request | baseline | Response carries `stopReason` and ends the turn |
| `session/cancel` | client → agent | notification | baseline | |
| `$/cancel_request` | either | notification | optional | Cancels one request by id |

Sources: method names `acp-spec/schema/v1/meta.json:1-34`; baseline `acp-spec/docs/protocol/v1/initialization.mdx:280`
[docs]; gates `initialization.mdx:223-305` [docs], `session-setup.mdx:91-106`, `:211-228`, `:276-293` [docs],
`session-list.mdx:37-54` [docs]; `$/cancel_request` `cancellation.mdx:10-22` [docs].

### initialize

- The client sends its latest `protocolVersion` (an integer), `clientCapabilities` and `clientInfo`
  (`initialization.mdx:24-55` [docs]; `acp-spec/schema/v1/schema.json:4704`, `:4758`).
- The agent answers with the chosen version, `agentCapabilities`, `agentInfo` and `authMethods`. If the client does
  not support that version it should close the connection (`initialization.mdx:57-101` [docs]; `schema.json:2334`).
- An omitted capability means unsupported (`initialization.mdx:107-109` [docs]).
- Every request except `initialize` fails with `-32600` until `initialize` succeeds. The SDK enforces this on the
  agent side (`acp-typescript-sdk/src/v1/stable/acp.ts:106-150`).

Client capabilities (`schema.json:4758-4825`):

| Capability | Meaning |
| --- | --- |
| `fs.readTextFile`, `fs.writeTextFile` | The agent may call `fs/read_text_file`, `fs/write_text_file` |
| `terminal` | The agent may call all `terminal/*` methods |
| `auth.terminal` | The client can run the agent's login in an interactive terminal |
| `elicitation.form`, `elicitation.url` | The agent may call `elicitation/create` in these modes |
| `session.notices`, `session.compaction`, `session.configOptions.boolean` | Opt-ins for newer `session/update` variants and boolean options |

Agent capabilities (`schema.json:2409-2474`, `:2474-2528`):

| Capability | Meaning |
| --- | --- |
| `loadSession` | `session/load` exists |
| `promptCapabilities.image`, `.audio`, `.embeddedContext` | Prompts may carry `image`, `audio`, `resource` blocks. `text` and `resource_link` are always allowed |
| `mcpCapabilities.http`, `.sse` | The agent can connect to HTTP or SSE MCP servers. stdio is always required |
| `auth.logout` | `logout` exists |
| `sessionCapabilities.list`, `.resume`, `.close`, `.delete`, `.additionalDirectories`, `.systemPrompt` | The matching methods or fields exist |

Sources: `initialization.mdx:237-266` [docs] (text and resource_link are the baseline), `schema.json:2478-2514`.

### Authentication

- Agents list `authMethods` in the `initialize` response. A method without `type` is `agent`: the client calls
  `authenticate` with its `methodId` (`authentication.mdx:44-90`, `:134-167` [docs]; `schema.json:2768-2878`).
- A `terminal` method tells the client to run the same agent program with extra `args` and `env` in a terminal the
  user can see, wait for exit code 0, then reconnect. The client must not call `authenticate` for it
  (`authentication.mdx:92-128`, `:169-188` [docs]).
- An agent may advertise a `terminal` method only if the client sent `clientCapabilities.auth.terminal: true`
  (`authentication.mdx:126-128` [docs]).
- `session/new` can fail with `auth_required` (`-32000`) until the user logs in (`session-setup.mdx:10` [docs];
  `schema.json:3568-3635`).

### session/new

Params (`schema.json:5056-5102`, required: `cwd`, `mcpServers`):

- `cwd`: absolute path. It is the session's working directory, whatever directory the agent process started in
  (`session-setup.mdx:436-445` [docs]).
- `mcpServers`: the MCP servers the agent should connect to for this session. See the table below.
- `additionalDirectories`: more absolute roots, if `sessionCapabilities.additionalDirectories` (`session-setup.mdx:331-362` [docs]).
- `systemPrompt`: `{ mode: "append" | "override", content: [text blocks] }`, if `sessionCapabilities.systemPrompt`
  (`session-setup.mdx:364-422` [docs]; `schema.json:5264-5312`).
- `_meta`: free-form extension data (`acp-spec/docs/protocol/v1/extensibility.mdx:6-10` [docs]).

The result has `sessionId` and may have `modes` and `configOptions` (`schema.json:2932-2976`).

`McpServer` variants (`schema.json:5102-5148`, `:5169-5264`):

| `type` | Fields | Gate |
| --- | --- | --- |
| (absent) = stdio | `name`, `command` (absolute path), `args[]`, `env[]` of `{name, value}` | Every agent must support it |
| `"http"` | `name`, `url`, `headers[]` of `{name, value}` | `mcpCapabilities.http` |
| `"sse"` | `name`, `url`, `headers[]` | `mcpCapabilities.sse` (deprecated by MCP) |

Sources: `session-setup.mdx:455-631` [docs]. Security notes: `env` and `headers` are credentials, agents should launch
stdio servers without a shell, and should not echo `env` or `headers` back (`session-setup.mdx:633-641` [docs]).

### session/load, session/resume, session/list, session/close

- `session/load` takes `sessionId`, `cwd`, `mcpServers`. The agent replays the whole conversation as `session/update`
  notifications, then responds (`session-setup.mdx:108-203` [docs]; `schema.json:5312`).
- `session/resume` takes the same params but must not replay history (`session-setup.mdx:230-268` [docs]; `schema.json:5411`).
- `session/list` returns `SessionInfo` entries, filtered by `cwd`, paged by `cursor` (`session-list.mdx:76-91` [docs];
  `schema.json:3315-3388`, `:5366`).
- `session/close` cancels any work and frees the session. It is idempotent; treat `-32002` as success
  (`session-setup.mdx:270-329` [docs]). The SDK already maps `-32002` on close or delete to success
  (`acp-typescript-sdk/src/v1/stable/acp.ts:470-495`).

### session/prompt

- Params: `sessionId` and `prompt`, an array of content blocks (`prompt-turn.mdx:84-121` [docs]; `schema.json:5583`).
- The client must only send block types the agent's `promptCapabilities` allow (`prompt-turn.mdx:115` [docs]).
- The agent streams `session/update` notifications, may call back into the client, then responds with
  `{ stopReason }` (`prompt-turn.mdx:39-78`, `:450-462` [docs]).
- Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` (`schema.json:3512-3542`).

Content blocks (`schema.json:599-687`, `:734-996`; `content.mdx` [docs]):

| `type` | Fields | Prompt gate |
| --- | --- | --- |
| `text` | `text` (Markdown) | Always |
| `resource_link` | `uri`, `name`, optional `mimeType`, `title`, `description`, `size` | Always |
| `resource` | `resource: { uri, text, mimeType? }` or `{ uri, blob (base64), mimeType? }` | `embeddedContext` |
| `image` | `data` (base64), `mimeType`, optional `uri` | `image` |
| `audio` | `data`, `mimeType` | `audio` |

The spec calls `resource` "the preferred way to include context in prompts" (`content.mdx:119-121` [docs]).

### session/cancel

- A notification with `sessionId` (`prompt-turn.mdx:549-559` [docs]; `schema.json:6194`).
- The client should mark unfinished tool calls as cancelled at once, and must answer every open
  `session/request_permission` with `{ outcome: { outcome: "cancelled" } }` (`prompt-turn.mdx:561-563` [docs]).
- The agent stops, flushes its last updates, then answers the open `session/prompt` with `stopReason: "cancelled"`,
  not an error (`prompt-turn.mdx:565-580` [docs]).

### Modes, config options and models

- Modes: `session/new` may return `modes: { currentModeId, availableModes[] }`. The client changes it with
  `session/set_mode`. The agent reports its own changes with `current_mode_update` (`session-modes.mdx:15-122` [docs];
  `schema.json:2976-3040`, `:5488`).
- Modes are deprecated in favour of config options. When both exist, clients should use `configOptions`
  (`session-modes.mdx:6-11`, `session-config-options.mdx:8-13` [docs]).
- Config options are selectors with `id`, `name`, `category`, `type` (`select`, or `boolean` if the client opted in),
  `currentValue`, `options` (`session-config-options.mdx:87-140` [docs]; `schema.json:3040-3280`).
- Categories: `mode`, `model`, `model_config`, `thought_level`, and `_`-prefixed custom ones
  (`session-config-options.mdx:213-231` [docs]; `schema.json:3123-3153`).
- The client sets a value with `session/set_config_option { sessionId, configId, value }`. The agent reports changes
  with `config_option_update` (`session-config-options.mdx:255-300` [docs]; `schema.json:5519`, `:4263`).
- There is no separate model API in stable v1. The model is a config option with `category: "model"`.

### Slash commands

- The agent sends `available_commands_update` with `availableCommands[]` of `{ name, description, input?: { hint } }`
  (`slash-commands.mdx:8-69` [docs]; `schema.json:4156-4242`).
- The list can change at any time (`slash-commands.mdx:71-73` [docs]).
- A command runs as ordinary prompt text, for example `"/web agent client protocol"` (`slash-commands.mdx:75-96` [docs]).
- Clients should keep agent commands visibly apart from their own (`security.mdx:27` [docs]).

## 2. session/update variants

Every update is `session/update { sessionId, update: { sessionUpdate: <variant>, ... } }`
(`schema.json:3687-3718`). The v1 variants (`schema.json:3718-3950`; `prompt-turn.mdx:14-29` [docs]):

| `sessionUpdate` | Payload | Notes |
| --- | --- | --- |
| `user_message_chunk` | `content` block, `messageId?` | Mostly during `session/load` replay |
| `agent_message_chunk` | `content` block, `messageId?` | Same `messageId` = same message (`prompt-turn.mdx:190-192` [docs]) |
| `agent_thought_chunk` | `content` block, `messageId?` | Reasoning |
| `tool_call` | `toolCallId`, `title`, `name?`, `kind?`, `status?`, `content?`, `locations?`, `rawInput?`, `rawOutput?` | Creates a tool call (`schema.json:3987-4061`) |
| `tool_call_update` | `toolCallId` plus any changed field | Patch. Omitted = unchanged (`tool-calls.mdx:100-134` [docs]) |
| `plan` | `entries[]` of `{ content, priority: high/medium/low, status: pending/in_progress/completed }` | Always the full list. Replace, don't merge (`agent-plan.mdx:75-83` [docs]) |
| `available_commands_update` | `availableCommands[]` | Slash commands |
| `current_mode_update` | `currentModeId` | Deprecated with modes |
| `config_option_update` | `configOptions[]` | Full new list |
| `session_info_update` | `title?`, `updatedAt?`, `_meta?` | |
| `usage_update` | `used`, `size` (tokens), `cost?: { amount, currency }` | (`prompt-turn.mdx:425-448` [docs]) |
| `notice` | `severity`, `title`, `description?` | Only if `session.notices` was advertised |
| `compaction_update`, `compaction_summary_chunk` | `compactionId`, `status`, `summary?` | Only if `session.compaction` was advertised |

Tool call fields:

| Field | Values | Source |
| --- | --- | --- |
| `kind` | `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other` (default) | `schema.json:463-518` |
| `status` | `pending`, `in_progress`, `completed`, `failed` | `schema.json:518-543` |
| `content[]` | `{ type: "content", content: ContentBlock }`, `{ type: "diff", path, oldText (null = new file), newText }`, `{ type: "terminal", terminalId }` | `schema.json:543-599`, `:1017-1068` |
| `locations[]` | `{ path (absolute), line? }` for "follow the agent" | `schema.json:1068-1092`; `tool-calls.mdx:337-358` [docs] |

- A `terminal` content item points at a terminal made with `terminal/create`. The client keeps showing its output
  after release (`tool-calls.mdx:316-331` [docs]).
- Locations are display hints, not access grants (`tool-calls.mdx:358` [docs]).

## 3. Methods the client implements

| Method | Kind | Required when | Params → result |
| --- | --- | --- | --- |
| `session/update` | notification | always | see section 2 |
| `session/request_permission` | request | always (any agent may ask) | `{ sessionId, toolCall: ToolCallUpdate, options[] }` → `{ outcome }` |
| `fs/read_text_file` | request | `fs.readTextFile: true` | `{ sessionId, path, line?, limit? }` → `{ content }` |
| `fs/write_text_file` | request | `fs.writeTextFile: true` | `{ sessionId, path, content }` → `{}`; creates the file |
| `terminal/create` | request | `terminal: true` | `{ sessionId, command, args?, env?, cwd?, outputByteLimit? }` → `{ terminalId }` at once |
| `terminal/output` | request | `terminal: true` | → `{ output, truncated, exitStatus? }` |
| `terminal/wait_for_exit` | request | `terminal: true` | → `{ exitCode?, signal? }` when the command ends |
| `terminal/kill` | request | `terminal: true` | Kills, keeps the terminal readable |
| `terminal/release` | request | `terminal: true` | Kills if running, frees the id |
| `elicitation/create` | request | `elicitation.form` or `.url` | Structured question to the user |

Sources: `acp-spec/schema/v1/meta.json:19-30`; `schema.json:266-340`, `:1154-1352`, `:5754-6002`;
`file-system.mdx:8-119` [docs]; `terminals.mdx:8-282` [docs]; `tool-calls.mdx:136-252` [docs].

### Permission requests

- Options have `optionId`, `name`, `kind`: `allow_once`, `allow_always`, `reject_once`, `reject_always`
  (`schema.json:1092-1154`).
- Outcome is `{ outcome: "selected", optionId }` or `{ outcome: "cancelled" }` (`schema.json:5787-5866`).
- The agent owns remembered choices. `allow_always` tells the agent to store a rule; the option `name` says its
  scope (`tool-calls.mdx:238-242` [docs]).
- The client may auto-answer by its own policy (`tool-calls.mdx:194` [docs]), but should not rely only on `title` or
  `name` to do so (`tool-calls.mdx:244-252` [docs]).
- Permission requests are advisory. The agent runs its own tools and honours the answer itself (`security.mdx:12` [docs]).

### File system and terminal security

- The client does fs and terminal work itself, so it checks paths and commands against the session's roots itself.
  A permission request does not replace that check (`file-system.mdx:121-126`, `terminals.mdx:284-289` [docs]).
- `outputByteLimit` truncates from the start, at a character boundary (`terminals.mdx:79-90` [docs]).
- Show terminal output with control sequences neutralised (`terminals.mdx:289` [docs]).

## 4. The TypeScript SDK (client side)

### API shape in 2.x

- `ClientSideConnection` is gone. SDK 2.0.0 removed `AgentSideConnection`, `ClientSideConnection`, `Agent` and
  `Client` (`acp-typescript-sdk/CHANGELOG.md:98`; mapping table `MIGRATION_STABLE_UNSTABLE.md:191-197`).
- The replacement is a builder: `acp.client({ name }).onRequest(...).onNotification(...).connectWith(stream, op)` or
  `.connect(stream)` (`acp-typescript-sdk/README.md:79`; `src/v1/stable/acp.ts:1907-1966`).
- `connect(stream)` returns a `ClientConnection` with `.agent` (a `ClientContext`), `.signal`, `.closed`, `.close()`.
  Use it for a long-lived connection, as an IDE needs (`acp.ts:234-271`, `:1943-1953`).
- `connectWith(stream, op)` closes the connection when `op` settles. Good for scripts and tests (`acp.ts:1954-1966`).

| Export | Use |
| --- | --- |
| `ndJsonStream(output, input, { maxMessageBytes? })` | Wraps web byte streams as an ACP `Stream`. Default limit 32 MiB per message (`acp.ts:42-55`; `src/core/stream-limits.ts:1`) |
| `client()`, `ClientApp` | Register handlers with `onRequest(method, h)`, `onNotification(method, h)`; `"*"` is a fallback (`acp.ts:1977-2061`) |
| `methods` | Method-name constants: `methods.agent.session.new`, `methods.client.fs.readTextFile`, ... (`acp.ts:183-225`) |
| `ClientContext.request(method, params, { signal? })`, `.notify(...)` | Typed calls to the agent (`acp.ts:464-510`) |
| `ClientContext.buildSession(cwd \| NewSessionRequest)` → `SessionBuilder` | `.withMcpServer()`, `.withAdditionalDirectories()`, `.start()`, `.withSession(op)` (`acp.ts:419-438`, `:704-775`) |
| `ActiveSession` | `.sessionId`, `.modes`, `.prompt(blocks)`, `.nextUpdate()` → `session_update` or `stop`, `.readText()`, `.dispose()` (`acp.ts:660-900`) |
| `PROTOCOL_VERSION`, `RequestError` | (`acp.ts:21-26`, `:56`) |
| Types | `export type *` of the generated schema: `InitializeRequest`, `NewSessionRequest`, `PromptRequest`, `SessionNotification`, `SessionUpdate`, `ToolCall`, `ToolCallUpdate`, `RequestPermissionRequest`, `RequestPermissionResponse`, `McpServer`, `ContentBlock`, `ReadTextFileRequest`, `CreateTerminalRequest`, ... (`acp.ts:7`) |

- `ActiveSession` taps `session/update` and still passes it on, so a global `onNotification("session/update")`
  handler also sees every update (`acp.ts:1529-1553`). Landlens can use one global handler and skip `nextUpdate()`.
- The SDK's example client spawns the agent with `stdio: ["pipe", "pipe", "inherit"]` and converts the Node streams
  with `Writable.toWeb` and `Readable.toWeb` (`src/examples/client.ts:106-119`).
- `@agentclientprotocol/sdk/unstable` adds unstable v1 features, and `/experimental/v2` is the v2 draft
  (`README.md:19-37`). claude-agent-acp itself imports `/unstable` (`claude-agent-acp/src/acp-client.ts:1-11`).

### Minimal client sketch (pseudocode)

This runs in the Electron main process, never in a renderer. Our own words, not SDK sample code.

```text
child = spawn(agentBinary, [], { cwd: sessionWorkspaceDir,
                                 stdio: [pipe, pipe, pipe],
                                 env: { ...env, CLAUDE_AGENT_ACP_PROTOCOL: "v1" } })
child.stderr → Landlens log file
stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))

conn = client({ name: "landlens" })
  .onNotification(session/update,  n  → ui.applyUpdate(n.sessionId, n.update))
  .onRequest(session/request_permission, r → policy.decide(r) ?? ui.askUser(r))   // returns { outcome }
  .onRequest(fs/read_text_file,  r → readInsideRoots(r))        // only if we advertise fs
  .onRequest(fs/write_text_file, r → writeInsideRoots(r))
  .connect(stream)

init = conn.agent.request(initialize, { protocolVersion: 1,
                                        clientCapabilities: { fs: {...}, terminal: false },
                                        clientInfo: { name: "landlens", version } })
check init.protocolVersion == 1, read init.agentCapabilities and init.authMethods

s = conn.agent.request(session/new, { cwd, mcpServers: [landlensMcp(context, namespace)],
                                      systemPrompt?: { mode: "append", content: [...] } })
render s.configOptions (mode, model, effort ...) as pickers
conn.agent.request(session/set_config_option, { sessionId, configId: "mode", value: "default" })

r = conn.agent.request(session/prompt, { sessionId, prompt: [text, resource, ...] })   // resolves at end of turn
on user Stop: conn.agent.notify(session/cancel, { sessionId }); answer open permission requests "cancelled"
on window close: session/close, then close stdin; kill the child if it has not exited after a grace period
```

## 5. claude-agent-acp

### How it starts Claude Code

- `claude-agent-acp` is an npm bin (`claude-agent-acp/package.json:10`). It needs Node 22 or later
  (`package.json:68`). Release archives also ship a standalone binary with the Claude CLI next to it
  (`README.md:39-47`).
- It wraps the Claude Agent SDK `query()` (`package.json:71-72`). Each session gets its own query, which runs the
  Claude CLI as a child process (`src/v1/acp-agent.ts:9966-10031`).
- Which `claude` binary: `CLAUDE_CODE_EXECUTABLE` if set, else the CLI next to a standalone build, else the native
  binary from the SDK's platform package, for example `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
  (`src/claude-cli.ts:19-80`). So by default it does **not** run the user's installed `claude`; it runs the copy that
  ships with the adapter (CLI 2.1.323 in this install).
- `claude-agent-acp --cli <args>` runs that CLI directly, which is how its login methods work (`src/index.ts:14-43`).

### What it loads from the user's setup

- `settingSources: ["user", "project", "local"]` (`src/v1/acp-agent.ts:9968`). It watches `~/.claude/settings.json`
  (or `$CLAUDE_CONFIG_DIR`), `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json` and the managed
  settings file (`src/settings.ts:104-115`, `:25-34`; `src/paths.ts:4-6`).
- The user's permission rules and `permissions.defaultMode` decide the starting mode
  (`src/v1/acp-agent.ts:9843-9852`; `src/permissions/modes.ts:28-60`). In the live run the session started in `auto`
  because of the user's settings (`study/acp-handshake/transcript.jsonl:8`).
- The live run shows the user's whole setup loads: 73 slash commands, including the user's own skills
  (`study/acp-handshake/transcript.jsonl:9`), a user plugin's events on stderr (`study/acp-handshake/agent.stderr.log:11-12`),
  and 42,936 context tokens for a one-word reply (`study/acp-handshake/transcript.jsonl:19`). So user CLAUDE.md,
  skills, plugins and hooks reach the session.
- The system prompt is the `claude_code` preset. A client `systemPrompt` with `append` adds to it; `override` replaces
  it (`src/client-system-prompt.ts:1-101`). It advertises `systemPrompt: { mode: { override: {} } }`
  (`study/acp-handshake/transcript.jsonl:2`).

### Auth

- It reuses the Claude Code login already on the machine. The live run needed no `authenticate` call:
  `authMethods` was `[]` and the agent pushed `auth/status_update` with `state: "authenticated"`
  (`study/acp-handshake/transcript.jsonl:2`, `:5`).
- Login methods are `terminal` type, and only when the client sends `clientCapabilities.auth.terminal: true` (or
  `_meta["terminal-auth"]`): "Claude Subscription" runs `--cli auth login --claudeai`, "Anthropic Console" runs
  `--cli auth login --console`, and a remote machine gets `--cli` (`claude /login`) (`src/auth-methods.ts:22-83`;
  `src/v1/acp-agent.ts:1794-1800`).
- `authenticate` only accepts the gateway method, which a client gets by sending `auth._meta.gateway: true`. Anything
  else is `invalid_params` (`src/v1/acp-agent.ts:1768-1792`, `:2176-2192`).
- `ANTHROPIC_*` and similar env vars pass through, because the query env starts from `process.env`
  (`src/v1/acp-agent.ts:9942-9952`).
- When the account is logged out, turns fail with ACP `auth_required` (`src/v1/acp-agent.ts:1471-1473`, `:4251-4273`).
- Extensions: `_auth/status_update` and the unstable `auth/status` report the account. These carry the user's email
  and organisation (`src/auth-status.ts:1-57`; the live payloads, redacted, are `transcript.jsonl:4-7`).

### Capabilities it advertises (v1)

From `src/v1/acp-agent.ts:1818-1891`, confirmed live (`study/acp-handshake/transcript.jsonl:2`):

| Field | Value |
| --- | --- |
| `promptCapabilities` | `image: true`, `embeddedContext: true` (no audio) |
| `mcpCapabilities` | `http: true`, `sse: true` |
| `loadSession` | `true` |
| `sessionCapabilities` | `additionalDirectories`, `close`, `delete`, `fork`, `list`, `options`, `resume`, `status`, `systemPrompt` (override), `title` |
| `auth` | `logout`, `status` |
| `_meta` | `claudeCode.promptQueueing`, `authStatus`, `steering.supported` |

### Client MCP servers

- ACP `mcpServers` become Claude Agent SDK `mcpServers`: stdio, `http` and `sse` keep command, URL and headers
  (`src/mcp-servers.ts:4-33`). Other transports, such as the unstable MCP-over-ACP `acp` type, are dropped
  (`src/mcp-servers.ts:6-8`; RFD `acp-spec/docs/rfds/mcp-over-acp.mdx` [docs]).
- They merge with any servers the client passes in `_meta.claudeCode.options.mcpServers`, and with the user's own MCP
  config (`src/v1/acp-agent.ts:9999-10002`).
- Claude sees them as tools named `mcp__<server>__<tool>`. They render as `kind: "other"` with the tool name as the
  title and the result text as content (`src/tool-calls/reporters/index.ts:51-54`; `reporters/interaction.ts:194-213`).
- Changing `mcpServers` on `session/load` or `session/resume` of a live session tears it down and recreates it
  (`src/v1/acp-agent.ts:9645-9660`).

### Permission modes

- Modes (`src/session-mode.ts:428-474`):

| id | Name | Behaviour |
| --- | --- | --- |
| `default` | Manual | Always ask before making changes |
| `acceptEdits` | Accept edits | Auto-accept file edits |
| `plan` | Plan | Plan first; ExitPlanMode asks to switch |
| `auto` | Auto | Claude decides; hidden if `disableAutoMode` |
| `bypassPermissions` | Bypass permissions | Accept all; hidden for root outside a sandbox, or if settings disable it |

- They come both as `modes` and as a `mode` config option (`study/acp-handshake/transcript.jsonl:8`). The bypass and
  auto gates are in `src/permissions/modes.ts:7-9`, `:62-67` and `src/v1/acp-agent.ts:9832-9841`.
- A client can drop bypass for a session with `_meta.claudeCode.options.allowDangerouslySkipPermissions: false`
  (`src/new-session-meta.ts:27-28`).
- Claude Code asks only when its own rules and mode do not decide. Then `canUseTool` sends
  `session/request_permission` (`src/v1/acp-agent.ts:8819-8900`, `:10005`).
- Options are `allow-once` (`allow_once`), `allow-with-updates` (`allow_always`), `reject` (`reject_once`); plan exit
  adds mode choices (`src/permissions/options/shared.ts:4-60`; `src/permissions/options.ts:25-100`). MCP tools get
  "Yes, and don't ask again for <tool> commands" (`src/permissions/options/tools.ts:138-157`).
- `allow_always` writes an allow rule to `localSettings`, that is `<cwd>/.claude/settings.local.json`
  (`src/permissions/effects.ts:68-76`; `src/permissions/normalization.ts:20-24`).
- The adapter withdraws an open permission request with `$/cancel_request` when Claude Code drops it
  (`src/acp-client.ts:25-31`).
- `AskUserQuestion` is disabled unless the client supports `elicitation.form` (`src/v1/acp-agent.ts:9872-9875`).

### How Claude tools map to ACP tool calls

| Claude tool | `kind` | Content | Source |
| --- | --- | --- | --- |
| Bash, PowerShell | `execute` | Title is the command. Output as a `terminal` item plus `_meta.terminal_info/terminal_output/terminal_exit` if the client sent `_meta.terminal_output: true`; otherwise a ```` ```console ```` text block | `src/tool-calls/reporters/bash.ts:20-30`; `src/tool-calls/renderer.ts:412-468`; `src/tool-calls/client-capabilities.ts:38-46` |
| Edit, Write | `edit` | `diff` with absolute `path`, `oldText` (null for a new file), `newText` | `src/tool-calls/reporters/file-edit.ts:25-55`, `:95-120`, `:167` |
| Read | `read` | `locations` with path and line | `src/tool-calls/reporters/read.ts:25-35` |
| Glob, Grep | `search` | | `src/tool-calls/reporters/search.ts:13`, `:39` |
| WebFetch, WebSearch | `fetch` | | `src/tool-calls/reporters/web.ts:17`, `:29` |
| Agent / Task | `think` | nested subagent | `src/tool-calls/reporters/agent.ts:16` |
| TodoWrite, Task* | `plan` update, not a tool call | | `src/sdk-to-acp.ts:195-213`; `src/plans.ts:50` |
| EnterPlanMode, ExitPlanMode | `switch_mode` | ExitPlanMode shows the plan text | `src/tool-calls/reporters/interaction.ts:40-46`, `:75-79` |
| MCP and unknown tools | `other` | result text | `src/tool-calls/reporters/interaction.ts:194-213` |

Text arrives as `agent_message_chunk`, thinking as `agent_thought_chunk` (`src/sdk-to-acp.ts:299-365`).

### Does it use the client's fs and terminal?

No. Claude Code runs Read, Write, Edit and Bash itself, inside the CLI process, on the agent's machine.

- The adapter has `readTextFile` and `writeTextFile` wrappers but nothing calls them (`src/v1/acp-agent.ts:8375-8383`;
  a search of `src/` finds no other caller).
- It never sends `terminal/create`. The `terminal` content item it emits reuses the tool-use id as `terminalId`;
  it is display-only, not an ACP terminal (`src/tool-calls/renderer.ts:419-436`).
- Live run: Landlens-probe advertised fs and terminal and refused every call; the agent made none
  (`study/acp-handshake/summary.json`).

### `_meta` extensions worth knowing

| Key | Direction | Effect | Source |
| --- | --- | --- | --- |
| `session/new._meta.claudeCode.options` | client → agent | Any Claude Agent SDK `Options`: `tools`, `disallowedTools`, `env`, `settings`, `hooks`, `mcpServers`, `additionalDirectories`... ACP owns `cwd`, `permissionMode`, `canUseTool` | `src/new-session-meta.ts:9-30`; merge order `src/v1/acp-agent.ts:9966-10031` |
| `session/new._meta.claudeCode.emitRawSDKMessages` | client → agent | Mirrors raw SDK messages as `_claude/sdkMessage` | `src/new-session-meta.ts:31-38` |
| `session/new._meta.disableBuiltInTools` | client → agent | Legacy: no built-in tools | `src/v1/acp-agent.ts:9877-9883` |
| `clientCapabilities._meta.terminal_output` | client → agent | Bash output as terminal `_meta` | `src/tool-calls/client-capabilities.ts:42-46` |
| `_auth/status_update` | agent → client | Account identity | `src/auth-status.ts:53` |
| `usage_update._meta["_claude/model"]`, `promptResponse._meta.quota` | agent → client | Model and per-model token use | `study/acp-handshake/transcript.jsonl:15`, `:19` |
| `_meta.jetbrains.air.*` | both | JetBrains AIR-only extensions | `claude-agent-acp/docs/air-extensions.md` |

Because `...userProvidedOptions` is spread after the adapter's defaults, a client can also override
`settingSources` and `promptSuggestions` (`src/v1/acp-agent.ts:9966-9988`). Not tested.

### Sessions, persistence, models

- One adapter process holds many sessions in a map keyed by session id (`src/v1/acp-agent.ts:9642`, `:2225`).
- Sessions persist as Claude Code transcripts in `~/.claude/projects/<encoded cwd>/` (`src/session-index/project-dirs.ts:1-13`).
  `session/list` reads them (`src/v1/acp-agent.ts:2104-2110`).
- `session/load` replays history; `session/resume` does not; `session/fork` and `session/close` are supported
  (`src/v1/acp-agent.ts:2070-2100`, `:11060-11086`).
- Config options in the live run: `mode`, `model` (`category: model`; values `default`, `opus`, `sonnet`, `haiku`,
  `fable` and pinned ids), `effort` (`thought_level`: low → max), `fast` and `ultracode` (`model_config`), `agent`
  (`study/acp-handshake/transcript.jsonl:8`). Builders: `src/session-model.ts:226-292`, `src/session-effort.ts:141`,
  `src/session-fast-mode.ts:95`, `src/session-ultracode.ts:111`.
- A `/model <name>` prompt is mirrored back into the picker (`src/v1/acp-agent.ts:10072-10090`).

### Known limitations

- No audio prompts (`src/prompt-to-claude.ts:25-32`).
- A `resource_link` becomes only a Markdown link in the prompt. Claude must fetch the URI itself
  (`src/prompt-to-claude.ts:8-23`, `:55-61`).
- An embedded `resource` with text becomes `<context ref="uri">…</context>` after the prompt text
  (`src/prompt-to-claude.ts:63-83`, `:112`).
- Slash commands it hides: `clear`, `cost`, `keybindings-help`, `login`, `logout`, `output-style:new`,
  `release-notes`, `todos`, and commands the CLI marks terminal-only (`src/slash-commands.ts:43-52`, `:66-69`).
- `cwd` must exist and be absolute (`src/v1/acp-agent.ts:9696-9728`).
- No MCP-over-ACP (`src/mcp-servers.ts:6-8`).
- Steering is v1-only and v2 is a moving draft (`README.md:56-75`).
- Debug logs: `CLAUDE_AGENT_LOGS=<dir>` writes `agent.log` (`src/index.ts:65-85`).

### Live handshake (2026-11-14)

- Script: `study/acp-handshake/probe.mjs`. Raw transcript, redacted: `study/acp-handshake/transcript.jsonl`.
  Summary: `study/acp-handshake/summary.json`.
- `initialize` answered in 763 ms, `session/new` in 3.65 s (3.56 s of it is the CLI start, `agent.stderr.log:5`),
  and the "pong" turn in 2.7 s.
- Updates seen: `available_commands_update` (twice, about 25 KB each), `session_info_update` (an auto title),
  `usage_update` (three times), one `agent_message_chunk`, then `stopReason: "end_turn"`.
- Auth: none needed. It used the existing Claude subscription login.
- Killing the agent while the client stream was open threw an `AbortError` from `Readable.toWeb` in the client. Handle
  stdout close as a normal end of connection.

## 6. Design implications for Landlens

### Give Claude the cluster through a Landlens MCP server

- Use an **HTTP MCP server in the Electron main process**, bound to `127.0.0.1` on a random port. Pass it as
  `{ type: "http", name: "landlens", url, headers: [{ name: "Authorization", value: "Bearer <per-session token>" }] }`.
  The agent supports HTTP (`transcript.jsonl:2`). In-process means it reuses Landlens's kube client, cache and
  approval UI.
- A stdio server (`landlens-mcp --context X --namespace Y`) is the fallback. Every agent must support stdio
  (`session-setup.mdx:465-467` [docs]).
- Scope each MCP session to one kube context and a namespace set, fixed by the token. The model cannot widen it.
- Read-only tools by default: `list`, `get` (YAML), `describe`, `events`, `logs` (with `previous`, `tail`, `since`),
  `top`, `rollout_history`.
- Write tools are separate and named as such: `apply_manifest`, `patch`, `scale`, `rollout_restart`, `delete`.
  Landlens runs a server-side dry run, shows the diff in its own dialog, and needs the user's click. Do not rely only
  on `session/request_permission`: in `auto` or `bypassPermissions` mode, or with an `mcp__landlens__*` allow rule,
  Claude Code never asks (`src/v1/acp-agent.ts:8819-8900`; `security.mdx:12` [docs]).
- Still answer `session/request_permission` well: auto-allow the read-only `mcp__landlens__*` tools by Landlens policy,
  and prompt for everything else.
- Set the session mode explicitly after `session/new`. The user's settings may start it in `auto`
  (`transcript.jsonl:8`). Landlens default: `default` (Manual), or `plan` for a "diagnose only" session.

### Bash and kubectl

- Claude's Bash runs `kubectl` itself, with the user's `KUBECONFIG`, so it can reach any context. ACP terminals do
  not help here: this agent never calls `terminal/create` (section 5).
- Options, in order of preference:
  1. Pass `_meta.claudeCode.options.env.KUBECONFIG` pointing at a Landlens-made kubeconfig that holds only the
     current context and namespace (`src/v1/acp-agent.ts:9942-9944`).
  2. Add deny rules through `_meta.claudeCode.options.settings`, for example `Bash(kubectl delete:*)`,
     `Bash(kubectl apply:*)`, `Bash(kubectl get secret:*)` (`src/v1/acp-agent.ts:9928-9941`).
  3. For a locked-down session, drop Bash entirely with `_meta.claudeCode.options.disallowedTools`
     (`src/new-session-meta.ts:25`).
- Advertise `clientCapabilities._meta.terminal_output: true` so Bash output arrives as a terminal stream Landlens can
  render, keyed by the tool-use id (`src/tool-calls/renderer.ts:426-452`).

### Put cluster context in the prompt

- Send what the user is looking at as `resource` blocks (`embeddedContext` is on). Use Landlens URIs such as
  `k8s://<context>/<namespace>/pods/<name>` with `mimeType: "application/yaml"`.
- A crashlooping pod turn could carry: the pod YAML (managedFields dropped), its recent events, the last 200 lines of
  the previous container's log, and the owner Deployment's spec.
- Keep each block small. They become `<context>` text in the user message (`src/prompt-to-claude.ts:63-83`).
- Do not use `resource_link` for cluster objects: Claude gets only a link (`src/prompt-to-claude.ts:55-61`). If we
  link, make the MCP `get` tool accept the same `k8s://` URI.
- Put standing rules in `systemPrompt` with `mode: "append"`: the cluster, the namespace, "use the landlens tools",
  "never print Secret values" (`session-setup.mdx:364-401` [docs]).

### Show YAML diffs

- Claude's Edit and Write tool calls carry `diff` content with absolute paths (`src/tool-calls/reporters/file-edit.ts:25-55`).
- Give each session a Landlens-owned `cwd`, for example `<appData>/Landlens/workspaces/<context>/<session>/`. Ask Claude
  to write proposed manifests there. Landlens renders each `diff` in a Monaco diff view.
- Apply only through the MCP `apply_manifest` tool, which shows the live object versus the proposed one after a
  server-side dry run.
- A Landlens-owned `cwd` also keeps `allow_always` rules (`<cwd>/.claude/settings.local.json`) and transcripts out of
  the user's projects (`src/permissions/effects.ts:68-76`; `src/session-index/project-dirs.ts:1-8`).

### Several sessions

- One adapter process can hold many sessions (`src/v1/acp-agent.ts:9642`). Each session runs its own Claude CLI child
  (`src/v1/acp-agent.ts:10025`), so memory grows per session.
- Plan: one adapter per Landlens window, one ACP session per chat tab, each with its own MCP token and scope. Route
  `session/update` by `sessionId`.
- Changing the MCP scope of a live session recreates it (`src/v1/acp-agent.ts:9645-9660`). Prefer a new session for a
  new context.
- Offer history with `session/list` filtered by the workspace `cwd`, and reopen with `session/load`.

### What to watch for

| Risk | What to do |
| --- | --- |
| Process lifetime | Spawn from main. On quit: `session/close`, close stdin (the adapter exits on EOF, `src/index.ts:98-107`), then kill after a timeout. Handle unexpected exit and stdout close (seen in the probe). Restart and `session/resume`. |
| Startup cost | `session/new` took 3.65 s live. Pre-warm one session per window. |
| Cancellation | `session/cancel`, answer open permission requests with `cancelled`, mark open tool calls cancelled, wait for `stopReason: "cancelled"` (`prompt-turn.mdx:549-580` [docs]). |
| Large outputs | The SDK rejects a message over 32 MiB (`src/core/stream-limits.ts:1`). MCP tools must page and tail logs and lists. Claude Code saves big Bash output to a file and clips it (`src/tool-calls/reporters/bash.ts:76-89`). |
| Secrets | MCP `get` on a Secret returns keys only, never `data` or `stringData`, unless the user reveals one. Strip env values from `valueFrom` fields and tokens from kubeconfigs. Anything Claude sees lands in `~/.claude/projects` transcripts. |
| Credentials in config | MCP `headers` and `env` are secrets; never log them (`session-setup.mdx:633-641` [docs]). Use a per-session token. |
| PII in events | `_auth/status_update` carries the account email. Do not log it (`transcript.jsonl:4-7`). |
| Context cost | The user's full setup loads: 42.9k tokens for "pong" (`transcript.jsonl:19`). Measure before trimming `settingSources`. |
| Untrusted output | Render Agent Markdown without raw HTML, neutralise terminal escapes, no auto-opened links (`security.mdx:17-38` [docs]). |
| Prompt injection | Pod logs and annotations are untrusted data. Writes stay behind Landlens's own confirmation. |

### One turn: "why is my pod crashlooping?"

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as Landlens UI (renderer)
    participant M as Landlens main (ACP client + MCP server)
    participant A as claude-agent-acp
    participant C as Claude Code CLI
    participant K as kube-apiserver

    U->>UI: Right-click pod "api-7f9" > Ask Claude
    UI->>M: ask(context, ns, pod)
    M->>K: get pod, events, previous logs (tail 200)
    K-->>M: YAML, events, logs
    M->>A: session/prompt [text, resource pod.yaml, resource events, resource logs]
    A->>C: user message with <context> blocks
    C-->>A: thinking
    A-->>M: session/update agent_thought_chunk
    A-->>M: session/update plan [check exit reason, check limits, propose fix]
    C->>A: tool use mcp__landlens__describe (Deployment)
    A-->>M: session/update tool_call (kind other, pending)
    A->>M: session/request_permission (allow once / always / reject)
    M-->>A: selected allow-once (read-only tool, Landlens policy)
    C->>M: MCP HTTP tools/call describe (bearer token)
    M->>K: get deployment
    K-->>M: deployment
    M-->>C: tool result
    A-->>M: session/update tool_call_update (completed, content)
    A-->>M: session/update agent_message_chunk "Last state OOMKilled, limit 128Mi ..."
    C->>A: Write deployment.yaml in session workspace
    A-->>M: session/update tool_call (kind edit, diff old/new)
    A->>M: session/request_permission
    M->>UI: show YAML diff + options
    U->>UI: Allow once
    M-->>A: selected allow-once
    A-->>M: session/update tool_call_update (completed)
    C->>M: MCP tools/call apply_manifest (workspace file)
    M->>K: server-side dry run
    M->>UI: Landlens apply dialog (live vs proposed)
    U->>UI: Apply
    M->>K: apply
    M-->>C: tool result (applied, new rollout)
    A-->>M: session/update agent_message_chunk "Raised memory to 256Mi; watch the rollout"
    A-->>M: session/update usage_update
    A-->>M: session/prompt result stopReason end_turn
    M->>UI: turn finished
```

## What Landlens takes

1. **ACP v1, stdio, one adapter per window.** Spawn `claude-agent-acp` from Electron main with
   `CLAUDE_AGENT_ACP_PROTOCOL=v1`. Use `@agentclientprotocol/sdk` 2.x `client().connect(...)`, not
   `ClientSideConnection`, which no longer exists.
2. **The user's own Claude Code.** Ship the adapter as a dependency. It runs its bundled CLI with the user's
   `~/.claude` settings and login. Set `CLAUDE_CODE_EXECUTABLE` only if the user wants their installed `claude`.
3. **Auth by reuse, login by terminal.** Expect no auth step. On `auth_required`, advertise `auth.terminal` and run
   the advertised login args in a Landlens terminal pane, then reconnect.
4. **The cluster comes through a Landlens HTTP MCP server** scoped per session to one context and namespace by a
   bearer token. Read tools by default. Write tools need Landlens's own confirmation with a dry-run diff, whatever the
   ACP mode says.
5. **Kubectl stays fenced.** Give each session a kubeconfig with only the current context through
   `_meta.claudeCode.options.env`, add deny rules through `_meta.claudeCode.options.settings`, and allow dropping Bash.
   ACP terminals do not apply to this agent.
6. **Context arrives as `resource` blocks** with `k8s://` URIs, small and redacted. Standing rules go in
   `systemPrompt` append.
7. **Diffs come from Edit/Write in a Landlens-owned workspace `cwd`.** Render `diff` content in Monaco. Apply only via
   MCP.
8. **UI maps one-to-one to updates**: chat from message and thought chunks, a tool-call list with kinds, status and
   locations, a plan panel that is replaced whole, pickers from `configOptions` (mode, model, effort), slash commands
   from `available_commands_update` kept apart from Landlens commands, and a usage meter.
9. **Set the mode on every new session** (`default` or `plan`), and never auto-switch to `auto` or bypass.
10. **Guard the edges**: cancel cleanly, page large outputs, never send Secret values, never log MCP tokens or the
    account email, and restart and resume the adapter if it dies.
