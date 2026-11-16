# Landlens: the plan

Status: **approved, 14 November 2026.** Built from `docs/research.md`. Decisions: the waves in this order (the agent before the workbench); the repository is public at `landfalls-ai/landlens`; Landfall war rooms are opened only through Landflow's triage flow.

## What Landlens is

A Kubernetes desktop IDE in the spirit of OpenLens, rebuilt clean-room with one difference that shapes everything:
**the IDE is an ACP client.** It starts your own Claude Code (through the ACP adapter `claude-agent-acp`), gives it
the cluster you are looking at, and shows the conversation beside the cluster view: the agent's messages, each tool
call, permission prompts, YAML diffs, and suggested fixes you can apply after review.

Three rules hold in every wave:

1. **The person stays in charge of the cluster.** The agent reads freely (with secrets redacted). Every change to
   the cluster is a diff the person sees and approves, applied with a server-side dry run first.
2. **The cluster stays visible.** The agent lives in a dock beside the view (canvas-first), never a full-screen
   chat.
3. **Secure by default, unlike the original.** Freelens 2.0 ships its main window with `nodeIntegration` on and
   `contextIsolation` off, and the `RunAsNode` fuse on (`study/freelens-app/`). Landlens runs a sandboxed renderer
   behind a typed preload bridge, with the Electron fuses hardened. An app that runs an AI agent with cluster
   credentials cannot afford less.

## Architecture

```
┌──────────────────────── Electron main (Node) ────────────────────────┐
│ kubeconfig catalog ─► per cluster: Go sidecar (client-go, your creds) │
│                                   ▲                                    │
│  front door (127.0.0.1, TLS, tokens: IDE = full, agent = read-only)    │
│        ▲            ▲                    │                             │
│        │      agent's kubectl       watch hub (list+watch, bookmarks)  │
│        │      (generated kubeconfig)     ▼                             │
│        │                   typed IPC (preload bridge) ──► renderer     │
│        │                                                               │
│  ACP host ──spawn stdio──► claude-agent-acp ──► Claude Code (yours)   │
│   │  handles: request_permission, session updates, cancel, resume     │
│   │  per session: own cwd, one-context KUBECONFIG, kubectl write deny │
│   │  session/new mcpServers (all on the MCP gateway, loopback):        │
│   │    • landlens-kube (per-session token)                             │
│   │    • github • linear (Connections; tokens stay in main)            │
│   │    • landlens-gcp (read-only Google Cloud, when you turn it on)    │
│   │    • landlens-views (a Views page session: build a live view)      │
│   │    • clickland (http, read-only) • landfall (http) — optional      │
│   └─► approval broker: every write waits for the person (dry-run diff) │
└────────────────────────────────────────────────────────────────────────┘
┌──────────────── renderer (sandboxed React, no Node) ──────────────────┐
│ catalog · cluster views (workloads, config, network, storage, RBAC,   │
│ CRDs, events) · logs · terminal (xterm) · YAML editor (CodeMirror 6, diff)  │
│ · agent dock: messages, plan, tool-call cards, permission prompts,    │
│   diffs, "Ask about this" from any object                             │
└───────────────────────────────────────────────────────────────────────┘
```

### Packages (pnpm workspace)

| Package | What |
|---|---|
| `apps/desktop` | Electron main, preload, renderer (React 19, Vite via electron-vite), packaging |
| `packages/kube` | kubeconfig catalog, the front door (TLS, token, verb policy per token), list+watch stores with bookmarks and paginated lists, the resource registry (discovery + CRDs), RBAC checks |
| `sidecar/kube-proxy` (Go) | One child process per connected cluster: client-go with the user's kubeconfig (exec plugins, OIDC, client certs work as in kubectl), loopback only, answers only the front door |
| `packages/kube-mcp` | `landlens-kube`: the cluster MCP server the agent gets. Read tools, write tools that wait for approval, redaction |
| `packages/acp-host` | ACP client over `@agentclientprotocol/sdk`: agent registry, process lifetime, sessions, permissions, fs and terminals |
| `packages/ui` | Shared components: tables with virtual scroll, details drawer, YAML viewer, diff, status badges |
| `packages/contracts` | Typed IPC channels and their zod schemas, shared by main, preload and renderer |

### Credentials and the front door

Taken from OpenLens and Freelens (`research/lens-architecture.md`), with their holes closed:

- **Credentials stay in a Go sidecar**, one per connected cluster, as in OpenLens (`lens-k8s-proxy`). The renderer,
  the agent and every spawned tool never see a token or a client key.
- **A front door in main** on 127.0.0.1 (TLS, since kubectl only sends credentials over TLS) forwards to the
  sidecars. The renderer never uses it: it gets cluster data from main over IPC, so Chromium's six-connections-per-host
  limit, which made Freelens move to HTTP/2, doesn't apply. Every request needs a token: OpenLens had none, and its cluster ids were guessable, so any
  local process could use the user's credentials; Freelens added one per run.
- **Tokens carry a policy.** The IDE's token may do what the user's RBAC allows. Each agent session gets its own token
  that allows only `get`, `list` and `watch` (and never Secrets), for one context and optionally a few namespaces.
- **The agent's kubectl goes through the front door.** Its `KUBECONFIG` points at the front door with its session
  token (passed by an exec credential plugin through the environment, as Freelens does, so no file holds it). So
  `kubectl delete` from the agent's Bash is refused by Landlens, not by a deny rule the agent could route around.
  Deny rules stay as the first, friendlier layer.

### The cluster MCP server (`landlens-kube`)

- An HTTP MCP server inside Electron main, on loopback, handed to the agent in `session/new` → `mcpServers` with a
  bearer token minted for that session and scoped to one context (and optionally a namespace allow-list). The agent
  never sees a kubeconfig or the user's token, and closing the session revokes its access at once
  (`research/acp.md`, "What Landlens takes" 4).
- **Read tools**: `list_resources`, `get_resource`, `describe` (object + events + owner chain), `get_events`,
  `get_logs` (tail, previous, since), `top` (metrics-server), `rollout_history`, `explain` (OpenAPI schema),
  `cluster_overview` (problems first: crashloops, pending, OOMKilled, failing probes, warnings). Marked
  `readOnlyHint`.
- **Write tools**: `apply_manifest`, `patch`, `scale`, `rollout_restart`, `rollout_undo`, `delete`, `exec`. Each
  does a server-side dry run, then **Landlens itself** asks the person (the diff shown; Allow once or Reject), and only
  then calls the API. This gate is required, not a second opinion: Claude Code only sends ACP
  `session/request_permission` when its own rules and mode don't settle a call, and in `auto` or bypass mode it never
  asks (`research/acp.md` §5).
- **Redaction** (from landfall-cluster-agent): no Secret `data`, ever; strip `managedFields`,
  `last-applied-configuration` and `env[].value`; caps on rows, string length and result size; gitleaks rules.
- **The cluster's own RBAC still applies**: calls run as the user's identity.

### The ACP host

- **ACP v1 over stdio** with `@agentclientprotocol/sdk` 2.x (`client().connect(ndJsonStream(...))`); the adapter
  `@agentclientprotocol/claude-agent-acp` ships as a dependency and is spawned from main with
  `CLAUDE_AGENT_ACP_PROTOCOL=v1`. It runs Claude Code with **your own login**. (Built: not your `~/.claude`
  settings, skills, plugins, hooks or MCP servers, which would run outside the sandbox; see docs/agent.md.)
  `CLAUDE_CODE_EXECUTABLE` switches it to your installed `claude`. Login, if ever needed,
  runs in a Landlens terminal pane.
- **Kubectl is fenced.** Claude Code runs its own Bash, file reads and edits; it does not use ACP's client terminals
  or file system. So each session gets, through `_meta.claudeCode.options`: an env whose `KUBECONFIG` points at the
  front door with the session's read-only token (above), deny rules for `kubectl` write verbs, and an option to drop
  Bash altogether. Changes go only through the MCP write tools, so through the gate.
- **A Landlens-owned working folder per session** (`cwd`): manifests the agent writes land there, its Edit/Write
  `diff` content renders in the Monaco diff view, and "always allow" rules and transcripts stay out of your projects.
- **Every new session starts in `default` or `plan` mode**, never `auto` or bypass, whatever your settings say.
- **Context from the IDE**: "Ask about this" on any object sends small, redacted `resource` blocks
  (`k8s://<context>/<ns>/<kind>/<name>`: the YAML and recent events). Standing rules (read-only first, propose diffs,
  cite the objects) go in the system prompt append.
- **The dock maps ACP updates one-to-one**: message and thought chunks, tool-call cards with kind, status and
  locations, the plan panel, pickers from `configOptions` (mode, model, effort), Claude's slash commands
  (`available_commands_update`) apart from Landlens's own, and a usage meter.
- Agents come from a registry: Claude Code by default; any other ACP agent can be added (command, args, env), with
  the same MCP server and gate. One adapter process per window; sessions are listed, resumed, cancelled; the adapter
  is restarted and resumed if it dies, and a closed stream is a normal disconnect.

## Waves

Each wave ends with the app running against the OrbStack cluster, tests green and docs updated.

| Wave | What | Done when |
|---|---|---|
| 0 | **Study** (this commit): upstream pinned, Craft Anything study of Freelens, research, this plan | Approved |
| 1 | **Shell**: pnpm workspace, Electron security baseline (sandbox, preload bridge, fuses, CSP without `unsafe-eval`, navigation guard), kubeconfig catalog, Go sidecar + token front door, discovery and RBAC, namespaces, list+watch stores, generic list/detail driven by discovery (pods, deployments, services, nodes, events first) | Landlens lists and live-updates `landflow-dev` and `clickland-dev` pods |
| 2 | **Agent (ACP)**: `acp-host` with `claude-agent-acp`, the agent dock (messages, plan, tool cards, permission prompts, mode/model pickers, cancel), `landlens-kube` read tools with redaction, the kubectl fence, "Ask about this" | "Why is this pod crashlooping?" on a broken test deployment in `landlens-dev` gets a correct answer with the evidence it read shown as tool cards |
| 3 | **Agent writes**: write tools behind the approval broker, YAML diff review, server-side dry run, apply; session history and resume; slash commands; other ACP agents | The agent proposes a fix as a diff, the person approves, the deployment recovers; a rejected change never reaches the API server, and `kubectl delete` from the agent's Bash is refused, even in bypass mode (tests prove both) |
| 4 | **Workbench**: all built-in kinds and CRDs (printer columns), logs (followed stream, not Lens's 10 s poll; previous; search), pod shell and local terminal (node-pty), port-forward, YAML editor (a merge patch after a dry run; server-side apply was the plan), metrics (metrics-server, Prometheus if found), Helm releases (read), command palette | Feature parity with the OpenLens views listed in `research/lens-features.md` marked "take" |
| 5 | **Cluster doctor**: a problems view (crashloops, pending, OOM, failing probes, warning events, expiring certs) with "Ask the agent" on each | Each broken scenario in `deploy/scenarios/` shows up and gets a sensible suggestion |
| 6 | **Connections**: Landlens signs in to GitHub and Linear and gives their tools to agent sessions through the gateway (reads run, writes ask, an autonomous mode per session); Google Cloud (every resource of your projects, read-only; GKE clusters in the catalog; read tools for the agent); a resizable dock | Against local fakes: a session lists an issue without asking, a write asks, an autonomous write in scope runs and one out of scope asks; a fake project's resources are browsed and a fake GKE cluster opens. The person checks GitHub, Linear and their own Google project once |
| 7 | **Land family** (was 6): Clickland MCP + telemetry (Landlens's own, off until turned on, to your collector only), Landfall war room + MCP, Landflow flows on a resource, a session's summary to the brain (sent on your click, never by itself); Landbright OIDC for clusters later. Built 15 Nov 2026 against local fakes ([family.md](family.md)) | Each link checked live on this machine |
| 8 | **Hands** ([specs/008-hands](specs/008-hands/spec.md)), in progress: part 1, your actions (scale, restart, delete, trigger, suspend and resume from a dry-run card, as you, kept in Recent actions); part 2, nodes (cordon, uncordon, drain with a preview; built); part 3, multi-select, bulk actions and preset asks; part 4, Secrets revealed per key, by you only | Each action works on `landlens-dev` from the menu, the drawer and ⌘K; Apply sends exactly the reviewed requests; no Secret value reaches the agent, logs or telemetry |
| 9 | **Google's view of this cluster** ([specs/009-google-view](specs/009-google-view/spec.md)), built 16 Nov 2026: Cloud Monitoring, GKE recommendations and alerts beside the cluster; part 1 (GKE identity, Google suggests on the Overview), part 2 (Cloud Monitoring as a metrics source) and part 3 (alerts beside the doctor's problems, Ask Claude on an alert or a suggestion) built with their security reviews fixed; part 4 (Claude's tools: `gke_recommendations`, `gcp_alerts`, `gcp_metrics`, the grant asked again) built and its security review fixed 16 Nov 2026 | Against local fakes, then the person's own project once |
| 10 | **Views on demand** ([specs/010-views](specs/010-views/spec.md)), in progress: a blank page with a composer, where your Claude Code builds a live view of the cluster you are connected to from a closed catalog of sources, read with the view's own read-only token, drawn as native blocks or as sandboxed app blocks "like MCP UI". Part 1 (the engine: documents, sources, transforms, the view token) and part 2 (the Views page, `landlens-views`, app blocks) built 16 Nov 2026 | You ask for a view in words and get it live; a follow-up changes it; it can be kept for the cluster |
| 11 | **Delivery** (was 10): Flux and Argo CD through pull requests, Helm writes, Trivy findings, Applications | A change to a Flux-managed object goes out as a PR; a Helm upgrade is reviewed and applied as you |
| 12 | **What happened** (was 11): Cloud Logging, a KHI-style history tab per object | An object's history reads back its changes and the events around them |
| 13 | **Workspace** (was 12): the agent's navigation tools, cluster tabs | Claude opens the object it is talking about; two clusters side by side |
| 14 | **Packaging** (was 8, then 13): an unsigned local `.dmg`, auto-update off, crash reports to Clickland | Installs and runs from `/Applications` on this Mac |

## Not taking

- Lens's extension API (a large surface with security cost; the agent and MCP are our extension story).
- Lens's update server, telemetry, and account features. (Landlens's own telemetry, wave 7, is off by default and goes
  only to the Clickland collector the person sets: [family.md](family.md#what-landlens-reports).)
- Bundled kubectl/helm downloads at start; we use the ones on `PATH` and say clearly when missing.
- Node shell as Lens does it (a privileged `nsenter` pod in `kube-system`); maybe later, behind the write gate.
- One iframe per cluster with its own origin; one renderer with a cluster switcher is enough without extensions.
