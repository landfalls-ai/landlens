# Security

Landlens will run an AI agent next to your cluster credentials, so its baseline is stricter than the Lens forks it
was studied from. Each item says how it is checked.

## The renderer

| Rule | How it's checked |
|---|---|
| `sandbox`, `contextIsolation`, no `nodeIntegration` (also not in subframes or workers), `webSecurity`, no `<webview>` | `secureWebPreferences` in `apps/desktop/src/main/security.ts`; the e2e test proves `require` and `process` are undefined in the page |
| The page reaches main only through `window.landlens` (`invoke`, `on`) and only for listed channels | preload; e2e test calls an unlisted channel; unit test keeps the preload list equal to the contract |
| Main answers only our own page: the exact `index.html` file in a build, the dev server only when not packaged | `isAppUrl` in `security.ts`; `DEV_URL` is ignored when `app.isPackaged` |
| Every request is validated with zod, and every group, version, resource, namespace and name must meet Kubernetes's naming rules, so no `/`, `%`, `?`, `#`, `\`, dot segment, space or control character can reach an API path | `packages/contracts`; `apiPath` checks again; unit tests; e2e test sends `../secrets`, `a/b`, `secrets?x=` and `kube%2fsystem` |
| Requests may only name kinds the cluster's discovery lists, and contexts from the user's kubeconfig | `ClusterManager.typeOf`, `ipc.ts` |
| CSP: `script-src 'self'`, no `unsafe-eval`, `connect-src 'self'`, `object-src 'none'` (dev adds the Vite server). A page loaded from `file://` gets no response headers, so the build also writes it as a `<meta>` tag. Its one frame source is `landlens-app:`, the scheme main serves MCP App views on (below); nothing else changed | `apps/desktop/src/main/csp.ts`; e2e test: an injected inline script and a string timer are both blocked and reported as violations; unit test on `CSP_PROD` |
| The renderer learns the platform only as data: preload writes `process.platform` to `data-platform` on `<html>`, for the macOS title-bar inset; the bridge gains no channel and the page no power. Fonts and icons are bundled, so `font-src 'self'` and the CSP are unchanged; copy uses the clipboard API or `execCommand`, with no permission granted | `apps/desktop/src/preload/index.ts`; the e2e test still finds `require` and `process` undefined |
| No navigation away, no new windows, no permissions, no webviews. `setWindowOpenHandler` denies every window, whoever asks (a view's frame sends no referrer, so a rule keyed on the opener's address never applied to views). A link in the page (Claude's answer) goes to main on `link:open`, which opens https only, in your browser | `hardenContents`, `hardenSession`; e2e test: a link click reaches `link:open` and `shell.openExternal` with the https address, `window.open` from a view returns null |
| WebRTC can't leave by UDP: every web contents gets `setWebRTCIPHandlingPolicy("disable_non_proxied_udp")`, and views' CSP adds `webrtc 'block'` | `hardenContents`; e2e probe in a live view: an `RTCPeerConnection` with a STUN server at the test's own UDP listener gathers no candidates and the listener sees no packet. Which of the two layers stops it isn't separated by the test |
| Secret values never reach the renderer: main replaces them with their size and drops `last-applied-configuration`, for a Secret, for every item of a list, and for anything read from the `secrets` resource whatever its `kind` says | `withoutSecretValues`, unit tests; e2e test opens a Secret's YAML |
| Open watches are capped (500), a watcher that failed for good is replaced rather than kept, and a cluster's watches stop when its sidecar exits | `WatchHub`, unit tests |

Freelens 2.0 for comparison: `nodeIntegration` on, `contextIsolation` off, no sandbox, no preload, CSP with
`unsafe-eval` (`study/freelens-app/app-map-windows.json`).

## Metrics and the Clickland key

| Rule | How it's checked |
|---|---|
| The Clickland API key is stored only encrypted, with Electron's `safeStorage` (the macOS Keychain holds the encryption key), in `userData/clickland.json` with mode 0600; if `safeStorage` can't encrypt, Landlens refuses to store it | `ClicklandSettingsStore`; unit test reads the file and its mode |
| The key never reaches the renderer: the page sends it once (Save or Test) and no channel returns it; `metrics:settings` says only whether one is stored | unit test on the view; e2e test reads `metrics:settings` after saving and finds no key |
| Only main talks to Clickland, and only to the configured address: the renderer's CSP (`connect-src 'self'`) is unchanged; redirects are refused, so the key can't be carried to another host; error messages never repeat it | `ClicklandClient`; unit tests (key only on the query route, `redirect: "error"`, scrubbed errors) |
| The key is bound to the origin it was saved for: saving another address without typing a key drops the stored one, and Test against another address won't send it ("type the key for that address") | `ClicklandSettingsStore.set`, `MetricsService.test`; unit tests |
| Clickland's answers are validated before use (zod): series keys must be Kubernetes names, values finite, at most 200 series and 4,000 points; anything else is refused with "Clickland's answer didn't look like metrics". They reach the model through the `metrics` tool only as checked numbers and names, at most 40 series lines, an unnamed key as "(unnamed)" | `parseSeries`; unit tests in `packages/metrics` and `kube-mcp` (a key that isn't a name never reaches the text) |
| Main is no relay: Test and errors say fixed sentences ("Clickland answered HTTP 502.", "Nothing is listening at that address."), never what the other end sent, so the page can't use main to read an arbitrary address. The raw error goes only to main's log | `describeError`, `ClicklandClient`; unit tests against a server that answers with a body |
| The address is https, or plain http only to this machine (`127.0.0.1`, `localhost`, `[::1]`), with no user info, query or fragment, so a key never crosses a network in the clear | `ClicklandUrl` in the contract; unit test |
| The key needs only Clickland's `read` scope; the dev key is made with Clickland's bootstrap admin key outside Landlens ([metrics.md](metrics.md)) | docs; the integration and e2e tests make and revoke their own read key |
| Clickland filter values (cluster, namespace, pod, workload names) go as JSON to Clickland, which passes them to ClickHouse as query parameters (Clickland `specs/001-metrics-filters`); a Clickland that ignores filters is refused, not trusted | Clickland's own tests; `honoursFilters` unit test |
| The metrics-server sampler reads only `metrics.k8s.io` and, for requests and limits, the objects the scope names, through the cluster's sidecar like any IDE read | `liveSeries`, unit tests |
| Development and tests may point `userData` elsewhere (`LANDLENS_USER_DATA`), never a packaged app | `index.ts` checks `app.isPackaged` |

## The packaged app's fuses

`apps/desktop/scripts/fuses.mjs`: `RunAsNode`, `NODE_OPTIONS` and `--inspect` off; cookie encryption, embedded ASAR
integrity and app-from-ASAR-only on; no extra file-protocol privileges. `pnpm --filter @landlens/desktop check:fuses`
applies them to a clone of the Electron app and reads the wire back. On 14 November 2026 Craft Anything's
`js_electron_fuses_show` reported every security fuse of that clone as hardened. Freelens 2.0 ships with `RunAsNode`,
`NODE_OPTIONS` and `--inspect` on and ASAR integrity off (`study/freelens-app/electron-fuses.json`).

## Credentials

| Rule | How it's checked |
|---|---|
| Credentials stay in one Go process per cluster; nothing else reads them | `sidecar/kube-proxy`; `catalog.ts` reads only names and servers (unit test) |
| The sidecar listens on 127.0.0.1 and answers only Landlens's per-process secret (constant-time compare). The secret goes over the first line of its stdin, never the environment, which any process of the same user can read with `ps eww` | Go test; unit test reads the running sidecar's `ps eww` |
| Child processes never inherit Landlens's own secrets | `withoutLandlensSecrets`, unit test |
| The caller's `Authorization`, cookies, the secret and every `Impersonate-*` header are never forwarded to the API server | Go test |
| A failed cluster request answers a generic 502; the detail (which may hold exec-plugin output) goes to the log | `ErrorHandler` in `main.go` |
| A packaged app runs only the sidecar in its own Resources; the `LANDLENS_SIDECAR` override and the repo build are development only | `sidecarBinary` in `apps/desktop/src/main/index.ts` |
| client-go sends credentials only to TLS servers | Go test (plain HTTP sends none) |
| The sidecar exits when Landlens's end of its stdin closes | checked live |
| Cluster handles are random per connection, not `md5(path:context)` as in OpenLens | `ClusterManager.connect` |

## The front door and tokens

| Rule | How it's checked |
|---|---|
| TLS on 127.0.0.1 with a fresh in-memory certificate. It is a leaf (it can sign nothing), signed by a CA made for this run alone, name-constrained to `localhost`, whose key is discarded once it has signed; that CA is what clients pin. (A self-signed leaf as its own anchor works for Go and Node but not for Electron's BoringSSL, which also rejects IP name constraints) | Go test (verifies for 127.0.0.1, leaf not a CA, CA path length 0 and constrained); integration test with real kubectl; desktop e2e (main's MCP client) |
| Every request needs a token Landlens issued; tokens are compared by hash in constant time and revocable | unit tests |
| A read-only token can't write (including dry runs), can't read Secrets, can't exec, attach, port-forward or proxy, and stays in its namespaces | unit tests for the policy and the front door; integration test: the agent-style kubectl's `delete pod` and `get secrets` are refused before the cluster sees them |
| Paths that could be read two ways are refused: empty or dot segments, any `%`, backslashes, `#`, spaces, control characters | unit tests |
| Impersonation (`kubectl --as`) is refused for every token, not silently dropped | unit test |
| A read-only token may GET only version, discovery, OpenAPI and health among non-resource paths; never `/metrics`, `/logs` (node log files) or `/debug` | unit tests |
| A write token (the approval broker's, below) may make only the requests the broker makes: get, patch or delete one object, create into a collection, list ReplicaSets in a namespace. No subresource (status, scale, token, ephemeral containers, exec, attach, port-forward, proxy), no watch, update or deletecollection, never Secrets, no non-resource writes; with namespaces, nothing cluster-scoped | unit tests |
| Dry runs are audited as such (`dryRun` from the request's `dryRun=All`) | unit test; live test reads the audit |
| A namespace-limited token's all-namespace reads use the cluster's discovery for scope; a kind it can't place is refused | unit tests |
| Every request is audited with the cluster's answer, upgrades (exec, attach) included | unit tests |
| Without `LANDLENS_TOKEN`, tools fail to authenticate | integration test |

## The agent

Claude Code runs as you, and Landlens can't see inside its shell. So the rules are made to hold whatever the model
does; the live test asks it to try each way around them ([agent.md](agent.md#the-fence)).

| Rule | How it's checked |
|---|---|
| None of your Claude Code setup loads: no settings files, CLAUDE.md, hooks, plugins or MCP servers (`settingSources: []`, `strictMcpConfig`). Those would run outside the sandbox with your full environment | unit test; live test |
| The skills you turn on are the one exception: copied (regular files only; none with links, over 500 files or over 5 MB; names `[a-z0-9-]`) into `.landlens/landlens-skills` in the session folder as a local plugin with no hooks or MCP servers, rebuilt from scratch for each session, each SKILL.md's frontmatter cut to its name and description (no `hooks`, `allowed-tools` or `model` of its own), and loaded only from inside that folder. The sandbox denies the agent's shell writing to `.landlens`, so it can't add hooks or servers to the plugin. They run in the session's sandbox | `skills.ts` and fence unit tests; live test: `mkdir .landlens/…` from the agent's shell is refused |
| Built-in tools are only Bash, Read, Grep, Glob, TodoWrite and ExitPlanMode (and Skill with chosen skills); WebFetch, WebSearch, Edit and Write are also named as disallowed | unit test; live test asks for WebFetch and gets "no such tool" |
| The Claude Code process gets an allowlisted environment (who you are, locale, proxies, how Claude Code reaches Anthropic), not Landlens's; its Anthropic credentials are hidden from its shell by the sandbox | `agentEnv`, unit test; live test plants a canary cloud key in Landlens's environment and checks the shell's `env` |
| Its shell reads nothing in your home folder but the session's folder and the tool folders on PATH (not ones holding credentials, like `~/.orbstack/bin`), and none of your kubeconfig files wherever `$KUBECONFIG` puts them; it writes only to the session folder, never its kubeconfig; it can't run unsandboxed, and the session fails if the sandbox can't start | unit test; live test: `~/.kube/config` and `ls ~` are refused |
| Its file tools can't read outside the session folder (`blockReadsOutsideWorkingDirectories`), and permission rules deny the credential folders and your kubeconfig files besides | unit test |
| Its shell's network is one local port: the front door's, as both its HTTP and its SOCKS proxy, with `strictAllowlist`. The front door refuses proxy requests, so there is no internet, and the cluster's own API port is unreachable | live test: `curl` to the API port, to example.com, and through `$ALL_PROXY` all fail |
| Its kubectl reaches only the front door, with a per-session read-only token that is revoked when the session ends, Claude Code exits, the cluster disconnects (also mid-start) or the window reloads | unit tests; live test (delete refused by rule, Secrets 403) |
| Everything the front door returns to an agent token is scrubbed: objects, lists, tables and watch events as objects (no env values, no `last-applied-configuration`, no `managedFields`, credential-shaped strings replaced), logs as text. It asks the cluster for uncompressed JSON and refuses any body it can't scrub | unit tests (lists, watch streams split mid-event, logs, protobuf and gzip refused, the IDE's token untouched); live test: the agent's `kubectl get configmap -o yaml` has no last-applied |
| "Ask Claude" context is read with the session's token, so the session's namespace limit, Secrets refusal and scrubbing apply to it as well | desktop e2e |
| The cluster's version string goes into the standing rules only if it looks like a version | unit test |
| Resuming a session reuses its folder path only if it is directly in Landlens's sessions folder and named as Landlens names them, empties it first (nothing a session left after a crash is loaded again), and needs the same context and API server it ran against. Folders left by a crash are removed when Claude Code starts. The folder and kubeconfig are written before any token is issued, so a failure there leaks none | `resumeDir`; `AgentService.resume`, `sweep`; history unit test |
| Main accepts only Manual and Plan modes and only offered model choices, and an answer only to an open question with one of the options it offered; closing a session withdraws its questions | `AgentService` |
| Links in answers show their host beside the text, and the full address on hover | `Markdown.tsx` |

## Changes: the approval broker

Every change the agent proposes goes through the approval broker in main (`packages/kube/src/changes.ts`). The rules
hold whatever the model asks for, and whatever mode Claude Code is in.

| Rule | How it's checked |
|---|---|
| The agent never holds a token that can write: its own token, its kubectl and the MCP gateway stay read-only. Each session's broker has a second token (`<label> · approved`, the write policy) that only main holds, revoked with the session | unit tests (policy); live test: the agent's `kubectl delete` is refused; audit shows writes only under the approved label |
| Nothing is sent without your Approve on the card, for that exact change id; a rejected, expired (15 minutes) or withdrawn change sends nothing beyond its dry run. Stop, closing the dock, ending the session, a disconnect or Claude Code exiting withdraws what's waiting | broker unit tests; live tests (reject: only the dry run reaches the API server); desktop e2e |
| What is applied is exactly what was dry-run and shown: the same requests, pinned to the object's version with `resourceVersion` (patch, apply), a JSON patch `test` operation, or `uid` and `resourceVersion` preconditions (delete). If the object changed in between, the API server refuses with 409 and nothing is applied | broker unit tests; live test changes the object while the question is open and gets 409 |
| A delete's dry run carries `dryRun: ["All"]` in its DeleteOptions body: the API server ignores the query string when a DELETE has a body, so a query-only dry run would delete | unit test (the fake API server behaves the same); live test: a rejected delete leaves the ConfigMap |
| Refused before anything is sent: Secrets (any operation); anything carrying `<redacted…>` or a cut-short marker, which would overwrite the real value with the marker; namespaces outside the session's; more than 10 operations; an unnamed object; whole-object updates; a manifest whose kind, name, namespace or API version (discovery's preferred one) don't match the call; JSON patch operations other than add, replace and remove (copy, move and test read values the agent can't see) | broker unit tests; live test |
| The broker reads and dry-runs unscrubbed, so nothing it answers without asking you may carry a value: a change that would change nothing still goes to you (answering at once would confirm a guessed hidden value), an API server's error reaches the agent with quoted values and "Invalid value: …" cut and credential-shaped text scrubbed, and after 20 refused proposals a session gets no more | broker unit tests |
| A create by server-side apply has no version to pin, so just before applying the broker checks the object still doesn't exist; if it does, nothing is sent | broker unit test |
| Danger (deletes, RBAC, cluster-scoped objects, a pod spec that gains a Secret, privilege or host access, in any kind that holds one) needs a second click; Enter never approves it; for other changes Enter approves only once the card has been on screen for 600 ms, so a keystroke meant for the composer can't. While an operation is closed or a diff capped, neither Approve nor Enter approves: they show the rest first | `ChangeCard` |
| The diff you see is of the object before and after the dry run, with `managedFields`, `resourceVersion` and status left out. It is shown only to you; the agent hears only what was applied ("deployment landlens-dev/orders-api patched (generation 4)") or why not | broker unit tests; `outcomeText` |
| A write tool's call may take the broker's 15 minutes and one more, not the gateway's usual 2 minutes, so a slow answer isn't cut off (which would withdraw the card, or apply while the agent is told it failed) | `upstream.ts` |
| `rollout_undo` reads the earlier ReplicaSet with the broker's token, so the template it restores has its real env values, which the agent never sees | live test |

## MCP: the gateway and app views

Every MCP call of an agent session goes through Landlens's gateway in main ([mcp.md](mcp.md)), and some tools come
with an MCP App: HTML from an MCP server that Landlens shows in the dock. The gateway keeps the agent's MCP inside the
fence; the views are treated as untrusted pages from the server that sent them.

| Rule | How it's checked |
|---|---|
| A session's only MCP endpoint is the gateway on 127.0.0.1: every server it gets (`landlens-kube` and the remote ones turned on for its cluster) is a gateway path, with the session's bearer token only. Requests with an `Origin`, another `Host`, an unknown or revoked token, an unknown server, or a server not turned on for that session are refused; tokens are kept as SHA-256 and compared in constant time; the token is revoked with the session | gateway unit tests (401, 403, 404 cases; the server list carries no remote address or header) |
| Remote servers only over streamable HTTP, https or http on this machine; never stdio, so nothing a server ships runs here. Redirects are refused (`redirect: "error"`), so a stored header can't follow one to another host; errors never echo a bearer value | contracts schema test; gateway unit test (a 307 is refused with the reason) |
| A remote server's header value is encrypted with `safeStorage` in `userData/mcp-servers.json` (0600), decrypted only in main when the gateway connects or tests; no channel returns it; it is never in Claude Code's environment or session config; header names that would change the request (`Host`, `Cookie`, `Origin`, `Mcp-Session-Id`, `X-Landlens-*`, …) are refused | `McpServerStore` unit tests (file, mode, views); e2e test reads `mcp:servers` after saving and finds no key |
| The header value is bound to the origin and header name it was saved with: change either without typing a new value and the stored one is dropped; Test with another address or header name refuses to send it (step "header") | `McpServerStore.save`, `McpService.test`; unit tests |
| A remote server's tools all ask by default, read-only or not: a server's own `readOnlyHint` is its word, and a "read-only" search tool called with cluster data is a way out. **Run read-only tools without asking** is a per-server switch, off when added, that you can turn on only after a Test; it pins the tool listing that Test saw (SHA-256 over each tool's name, title, description, annotations, schemas and view). When a session opens and the server lists anything else, its tools ask again, the switch turns off and the server says why. `landlens-kube` stays allowed whole: its read tools read through the front door with the session's read-only token, and its write tools only propose to the approval broker, which asks you itself. The rules the fence accepts name one tool on one server, never a whole server or a `landlens` name | `listingHash`, `preAllowed`, `drifted` and store unit tests; e2e test turns the switch on for Clickland |
| The gateway enforces the ask too: an agent's call to a remote tool that isn't pre-allowed runs only if you allowed that exact call in the dock (main hands the gateway the tool call id you answered, once or for the session); otherwise it's refused and logged, whatever Claude Code's own settings say | gateway unit tests (refused without a permit, run with one, "always" kept for the session) |
| App-only tools (`visibility: ["app"]`) never reach the model's tool list and are refused if called by the agent; a view may call only tools offered to apps, on its own server, at most 60 a minute; one that doesn't say it only reads needs your yes in a native dialog. From the MCP page (Preview) only read-only tools run, with a read-only front-door token labelled `you · <context>` | gateway unit tests; `AppViews` unit test |
| Every call is logged with scrubbed arguments and a scrubbed 2,000-character preview; the full result of a tool with a view is kept in main (the last 50) for its view only. `landlens-kube`'s front-door requests are filed under their call by an `X-Landlens-Call` id, which the front door accepts only in its own format and never forwards. Call ids are random (20 base-36 characters), and a request is filed under a call only if that call is running, is `landlens-kube`'s, and the request's token label is the call's session, so another token holder (the agent's shell with its own token) can't plant or flood rows | gateway and front-door unit tests (wrong label, finished call, other server); e2e test opens a call's front-door requests |
| A remote server's errors reach the page as fixed sentences, never its body | `describeError` unit tests |
| A view is served by main on its own scheme, `landlens-app://view/<128-bit id>`, only while it's open, only by GET, with `nosniff`, `no-store`, `no-referrer`, a Permissions-Policy that grants nothing, and its own CSP: `default-src 'none'`; inline script and style only; images, fonts and media from `data:` only; `connect-src 'none'` unless its resource declares connect domains that you also listed for its server (https origins only); `frame-src`, `child-src`, `worker-src`, `object-src`, `base-uri`, `form-action` all `'none'`. The renderer's CSP rewrite skips this scheme | `AppViews` unit tests (addresses, headers, CSP); e2e probes |
| A view's CSP also has `webrtc 'block'`, and its responses `X-DNS-Prefetch-Control: off` | `AppViews` unit test |
| The frame is `<iframe sandbox="allow-scripts">` and nothing more: no `allow-same-origin` (its origin is opaque), `allow-popups`, `allow-forms`, `allow-top-navigation` or `allow-modals`. No preload runs in subframes, so `window.landlens` doesn't exist there, and main answers IPC only from our own page | e2e test in a live view, against the test's own HTTP and UDP listener on 127.0.0.1: `window.landlens` undefined, `parent.document` and `parent.landlens` blocked, `origin` is `"null"`, `localStorage` blocked; a CORS fetch, a no-cors fetch, an image and a WebRTC candidate aimed at the listener: the listener records **zero** hits, and each probe reports its own CSP violation; `window.open` returns null |
| A frame may load only a live view's own address: main cancels any other frame navigation (`will-frame-navigate`), and a window a view asks for is denied without opening anything | e2e test, each from a fresh view: a view that sets `location` to another `landlens-app://view/…` address, to a `data:` page, or to https never shows that address (it stays or ends on Chromium's error page) |
| Links a view asks for: one native dialog at a time, at most 3 a minute per view; the rest are refused without a dialog, so a view can't bury you in prompts | `AppViews.allowLink` and `McpService` unit tests |
| A view's HTML is cached by the server's address and the resource's URI, not by the server's name, so a server removed and re-added under the same name at another address never serves the old one's HTML | gateway unit test |
| The `metrics` tool reads with the session's own front-door token (its audit label, its namespace limit), like the other tools; Clickland's answer comes from main's Clickland client, keyed to the cluster | kube-mcp unit test; `frontDoorCluster` |
| The page takes messages only from its own frame's window (`event.source`), drops non-JSON-RPC and messages over 1 MB, and answers a fixed set of methods: no `ui/message` (a view can't write to the agent's conversation), no `ui/update-model-context`, no resources. `ui/open-link` opens only https, after a native dialog that names the host; `landlens://object/…` only moves the main view | app-host unit tests against the SDK's `App` |

**Threat model for views.** A view is code from an MCP server: Landlens's own, or a remote one you added, which may be
compromised or hostile. Assume it runs arbitrary script. What it gets: the tool's input and result (it already sent
the result), the theme, and a channel to its own server's app-visible tools under the session's rules. What it must
not get, and why it can't:

- *Your cluster, credentials or other servers.* It has no network (CSP), no Node, no preload, no IPC, and an opaque
  origin; its tool calls go to its own server only, through the gateway, logged and rate-limited.
- *The agent.* It can't post into the conversation or the model's context (refused methods), and it never sees the
  model's other tools. What it returns from its own tools reaches the model only if the model calls them itself.
- *The page.* It can't read or script the page (cross-origin), navigate it (no top navigation; frame navigation
  cancelled), open windows or popups, submit forms, or frame anything.
- *Your data leaving.* With no network and no navigation, the only ways out are a link you approve (https, host
  shown) and its own server's tools, which the server could be called with anyway.
- *Your attention.* It can draw anything inside its frame, so a view could imitate Landlens; the frame sits under its
  tool's card, named for its server and tool, and anything that acts outside the frame (links, writing tools) goes
  through a native dialog the view can't draw.

Left open:

- A remote server's tool **descriptions** and **results** reach the model verbatim, like any MCP tool's: an injected
  instruction there is the server's to answer for. What limits the damage: its tools ask unless you turned on
  auto-run, the gateway refuses an agent call you didn't allow, and the agent has no other way out.
- The auto-run pin covers what a server **says** (its listing), not what it **does**: a server that keeps its listing
  and changes a "read-only" tool's behaviour still runs without asking. Turn auto-run on only for servers you run or
  trust.
- A view can show misleading content within its frame. The frame sits under its tool's card, and a view from an
  added server sits in a quieter ring captioned "View from <server>", drawn by the page outside the frame.
- A link dialog names the host; a look-alike host is yours to spot.
- Timing and size of a view's tool calls are visible to its own server.

## What this doesn't stop

Landlens runs as you. Another process running as your user can read your kubeconfig directly, and could read
Landlens's memory with a debugger if macOS lets it. The sidecar secret and the front door keep a same-user process
from borrowing Landlens's open connections without such access; they don't make a compromised user account safe.
Secret material outside Secrets (a token in a CRD's spec, a password in a ConfigMap) is shown as the cluster returns
it in the IDE. What the agent reads is scrubbed by pattern ([redact.ts](../packages/kube/src/redact.ts)); a secret in
an unusual format can still reach it. The kubectl permission rules match command prefixes (`kubectl -n x delete`
isn't matched); the front door is what refuses the write.

The reviews that drove this list: Fable security reviews of wave 1, wave 2 and of the graphs and MCP work, 14 November
2026 ([history.md](history.md)). That last review found two claims here that said more than the tests showed: the
view probes' "fetch to 127.0.0.1 blocked" was checked against a port with nothing listening, and the navigation probe
went to an https address the CSP already stops; the probes now run against the test's own listener and navigate to
another view and to `data:`. It also found the `metrics` tool reading through the IDE's connection rather than the
session's token, which mcp.md didn't say; it now uses the session's.
