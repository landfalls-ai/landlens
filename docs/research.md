# What we learned

The study in one page. Detail and citations: `research/lens-architecture.md`, `research/lens-features.md`,
`research/acp.md`, `research/land-family.md`; evidence in `../study/`.

## What we studied

- **OpenLens**: lensapp/lens `master` at `f1a960fd` (9 August 2023), the last open-source commit before the repository
  was emptied. MIT.
- **Freelens**: freelensapp/freelens `main` at `2547f555` (13 November 2026), the maintained OpenLens fork, and its
  released 2.0.0 macOS app, studied statically with Craft Anything (never started). MIT.
- **ACP**: the spec (`agentclientprotocol/agent-client-protocol`), the TypeScript SDK 2.7.0 and
  `claude-agent-acp` 0.107.0, plus one live handshake with Claude Code on this machine. Apache-2.0.

## OpenLens, inside

- **One window; each cluster in its own iframe** with its own origin, its own DI container, stores and watches.
  Dependency injection (`@ogre-tools/injectable`, 1,515 `*.injectable.ts` files in core) exists mainly for testing.
- **Credentials never reach the renderer.** The renderer calls LensProxy (HTTPS in main, on loopback), which forwards
  to a per-cluster Go child built on `kubectl proxy` code with the user's kubeconfig, so exec plugins, OIDC and client
  certificates work as in kubectl. kubectl, helm and terminals get a generated kubeconfig that points back at the proxy.
- **But OpenLens's proxy had no authentication**, and cluster ids are `md5(path:context)`: any local process could use
  the user's cluster credentials. Freelens added a 32-byte token per run (a cookie for frames, an exec credential
  plugin for tools) and moved to HTTP/2 because six connections per host starved the watches.
- **The data layer is simple**: one API object per kind, a MobX store per kind, list then `watch=1` from the last
  `resourceVersion`, relist on 410, events applied once a second, ref-counted watches only while a view is mounted.
  No bookmarks, no paginated lists. RBAC is read with access reviews and per-namespace rules reviews; views the user
  can't list are hidden. CRDs become APIs at run time with printer columns.
- **Features** are mostly per-kind UI (69k of 144k non-test lines in OpenLens). Logs poll every 10 s with `sinceTime`
  (no follow); pod shell types `kubectl exec` into node-pty; node shell starts a privileged `nsenter` pod; helm and
  port-forward are spawned binaries; metrics are PromQL through the API server's service proxy.
- **Electron security is weak in both forks.** The main window runs with `nodeIntegration` on (also in iframes),
  `contextIsolation` off, no sandbox, no preload; the CSP allows `unsafe-eval`. The released Freelens 2.0.0 confirms it,
  and its fuses leave `RunAsNode`, `NODE_OPTIONS` and `--inspect` on and ASAR integrity off
  (`../study/freelens-app/app-map-windows.json`, `electron-fuses.json`).
- **Freelens since 2023**: Electron 22 → 44, React 17 → 19, pnpm + turbo + electron-vite + vitest + biome, update
  server and telemetry removed, extensions moved to ESM.

## ACP and Claude Code

- **ACP v1 over stdio** is stable; v2 is a draft that drops the client file system and terminals. SDK 2.x has no
  `ClientSideConnection`; a client is `client().onRequest(...).connect(ndJsonStream(...))`.
- **`claude-agent-acp` runs your Claude Code**: your login (no auth step in the live run), your `~/.claude` settings,
  CLAUDE.md, skills, plugins and hooks (73 slash commands, 43k context tokens for a one-word answer). It ships its own
  CLI unless `CLAUDE_CODE_EXECUTABLE` is set.
- **It does not use the client's terminals or file system.** Claude Code runs its own Bash and edits; edits arrive as
  `diff` content. So the IDE cannot fence `kubectl` through ACP.
- **It asks permission only when its own rules and mode don't decide**, and never in `auto` or bypass mode. The live
  session started in `auto`, from the user's settings.
- **Client MCP servers pass straight through** (`session/new` → `mcpServers`, stdio or http). This is how the IDE gives
  it the cluster.

## The decisions this leads to

1. **Desktop, Electron, TypeScript**, like Lens, because an ACP agent is a local stdio process and the land family is
   TypeScript-first. Secure defaults from day one: sandboxed renderer, typed preload bridge, hardened fuses, strict CSP.
2. **Keep the Go credential sidecar, close the hole**: a token-protected HTTP/2 front door, with a policy per token.
3. **The agent gets the cluster through Landlens only**: an MCP server in main with a read-only session token, and a
   kubeconfig for its Bash that points at the front door with the same read-only token. Writes are MCP tools that
   show a dry-run diff and wait for the person, whatever mode Claude is in.
4. **Redact like landfall-cluster-agent**: no Secret data, no `last-applied-configuration`, no env values, gitleaks
   rules, caps.
5. **Generic, discovery-driven views first**, then per-kind polish; add the bookmarks, paginated lists and followed
   log streams both forks lack.
6. **Leave out** Lens's extension API, update server, telemetry, per-cluster iframes and bundled binary downloads.

The plan: [plan.md](plan.md).
