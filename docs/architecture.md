# Architecture

How Landlens is built today (waves 1 and 2, the graphs and MCP). The plan and the waves are in [plan.md](plan.md); why each choice was made is in
[research.md](research.md).

## The processes

| Process | What it does | Code |
|---|---|---|
| Electron main | Owns everything privileged: the clusters, their watches, the front door, IPC | `apps/desktop/src/main/` |
| Renderer | The UI. Sandboxed, no Node, reaches main only through `window.landlens` | `apps/desktop/src/renderer/` |
| Preload | The bridge: `invoke(channel, request)` and `on(pushChannel)` for the listed channels only | `apps/desktop/src/preload/index.ts` |
| `landlens-kube-proxy` (Go), one per connected cluster | Holds that cluster's credentials (client-go reads your kubeconfig, so exec plugins, OIDC and client certificates work as in kubectl) and forwards requests to the API server | `sidecar/kube-proxy/` |
| `claude-agent-acp` (Node), one per window, started when the dock first opens | Runs your Claude Code; Landlens speaks ACP v1 to it over stdio. Its shell commands run in Claude Code's sandbox | `packages/acp-host/` |
| Clickland (another project, optional) | Metrics history, logs and traces; main alone calls it over HTTP at the configured address with a read-scoped key ([metrics.md](metrics.md)). With telemetry on, main also sends Landlens's own spans, counts and events to its OpenTelemetry collector (OTLP/HTTP JSON, [family.md](family.md#what-landlens-reports)); the sidecar sends nothing | `packages/metrics/`, `packages/telemetry/` |
| Landflow and Landfall (other projects, optional) | The Land family ([family.md](family.md)): main signs in to each, serves their MCP servers to sessions, sends a problem to Landflow's triage or a flow, and a session's summary to the brain, each on the person's click | `packages/connections/`, `apps/desktop/src/main/family.ts`, `landflow.ts`, `brain.ts` |
| The MCP gateway (in main) | The agent's one MCP endpoint, on a loopback port with one bearer token per session: Landlens's read-only cluster tools (`landlens-kube`, in memory per session) and the remote MCP servers you turned on for the cluster, every call logged and checked ([mcp.md](mcp.md)) | `packages/mcp-gateway/`, `packages/kube-mcp/` |
| MCP App views (in the renderer, sandboxed frames) | HTML from an MCP server, served by main on `landlens-app:` with its own CSP, framed with `sandbox="allow-scripts"` | `apps/desktop/src/main/app-views.ts`, `renderer/src/AppFrame.tsx` |

## A request, end to end

1. The renderer asks main over IPC, for example `watch:subscribe` for pods in `kube-system`. Main checks the sender is
   our own page and validates the request with the zod schema in `@landlens/contracts`.
2. The watch hub shares one `ResourceWatcher` per (cluster, kind, namespace) between every view that shows it. The
   watcher lists in pages of 500, then watches from the list's `resourceVersion` with bookmarks, restarts the watch
   every 10 minutes, relists on 410 Gone, and sends changes to the renderer in batches every 250 ms.
3. The watcher's requests go to the cluster's sidecar on 127.0.0.1 with the sidecar's per-process secret. The sidecar
   adds the user's credentials and forwards to the API server.
4. Before anything crosses IPC, main drops `managedFields` and replaces every Secret value with its size.

The renderer never talks HTTP to a cluster. That keeps credentials and tokens out of the page, and avoids the
six-connections-per-host limit that made Freelens move its proxy to HTTP/2.

## The front door

The one local entry for tools and, from wave 2, the agent: `https://127.0.0.1:<port>/c/<cluster handle>/<API path>`.

- TLS with a certificate made fresh each run by the sidecar binary (`--loopback-cert`) and kept in memory. kubectl
  and client-go only send credentials over TLS.
- Every request needs a bearer token Landlens issued. A token names the clusters it may reach and carries a policy
  (`packages/kube/src/policy.ts`): `full` (whatever your RBAC allows), `read` (get, list and watch only; no Secrets;
  no exec, attach, port-forward or proxy; optionally a few namespaces), `write` (only the approval broker's requests),
  `exec` (one pod's shell) or `forward` (one pod's port-forward on one port). Paths that could be read two ways (`//`,
  dot segments, percent-encoding) are refused.
- Allowed requests go to the cluster's sidecar; the caller's token never reaches the cluster. Every decision is
  audited (label, method, path, allowed, status, reason).
- Tools get a kubeconfig (`toolKubeconfig`) whose clusters point at the front door with the certificate pinned, and
  whose user is an exec credential plugin that reads the token from `LANDLENS_TOKEN`, or, for a local terminal,
  from a 0400 file in that terminal's own folder. Without
  the variable, kubectl fails to authenticate.

## Code map

| Path | What |
|---|---|
| `packages/contracts/src/index.ts` | IPC channels, their zod schemas and response types; the bridge interface |
| `packages/kube/src/catalog.ts` | Contexts from your kubeconfig files (names and servers only) |
| `packages/kube/src/sidecar.ts` | Start and stop `landlens-kube-proxy`; `loopbackCert` |
| `packages/kube/src/client.ts` | Requests through a sidecar; API paths; `slim`, `withoutSecretValues` |
| `packages/kube/src/discovery.ts` | API discovery (aggregated v2, else per group), with each kind a CRD defines marked `custom` |
| `packages/kube/src/search.ts` | The ⌘K palette's names: metadata-only lists of the common kinds, kind, name and namespace out |
| `packages/kube/src/checks.ts` | The sentence for each check the doctor couldn't make (the page's strip and the agent's overview) |
| `packages/kube/src/doctor.ts`, `doctor-hints.ts` | The cluster doctor's rules: problems grouped by owner, worst first, with Landlens's first suggestion |
| `packages/kube/src/certs.ts` | TLS Secrets' certificates as dates and names (`tls.crt` only) |
| `packages/kube/src/helm.ts` | Helm releases, read-only: lists and decodes Helm's release Secrets as you, merges values as Helm does, hides secret values and Secret data before the window sees them |
| `packages/kube/src/watch.ts` | `ResourceWatcher`: paginated list, watch with bookmarks, relist on 410, batches |
| `packages/kube/src/clusters.ts` | `ClusterManager` (connect, discovery, get, events) and `WatchHub` (shared, ref-counted watchers) |
| `packages/kube/src/access.ts` | SelfSubjectAccessReview |
| `packages/kube/src/policy.ts` | Request parsing and token policies |
| `packages/kube/src/frontdoor.ts` | The front door |
| `packages/kube/src/tool-kubeconfig.ts` | The kubeconfig for tools and the agent |
| `apps/desktop/src/main/security.ts` | Sandbox, CSP, navigation and permission guards |
| `packages/acp-host/src/` | The ACP host, a cluster session, the fence, the standing rules ([agent.md](agent.md)) |
| `packages/kube-mcp/src/` | The built-in MCP server, its tools and their App views (`apps/`), the front-door client (redaction lives in `packages/kube/src/redact.ts`, applied by the front door) |
| `packages/mcp-gateway/src/` | The MCP gateway: endpoint, upstreams (in memory, streamable HTTP), approval rules, call log, card pairing ([mcp.md](mcp.md)) |
| `apps/desktop/src/main/mcp.ts`, `mcp-store.ts`, `app-views.ts` | `McpService` (servers, Test, Preview, views, links), the server store (headers in safeStorage), the `landlens-app:` scheme |
| `apps/desktop/src/renderer/src/McpPage.tsx`, `AppFrame.tsx`, `app-host.ts`, `mcpStore.ts` | The MCP page and call drawer, a view's frame, the MCP Apps host, the live call log |
| `packages/connections/src/` | GitHub and Linear sign-in: provider origins (`providers.ts`), the encrypted store, the device flow, Linear's MCP OAuth and the loopback redirect ([connections.md](connections.md)) |
| `apps/desktop/src/main/connections.ts` | `ConnectionsService`: sign-in flows per window, pasted tokens, test and pin, disconnect, the connections as gateway upstreams (`remotes()`); the development overrides |
| `packages/mcp-gateway/src/providers/` | Connections' servers on the gateway: reads by the vendor's read-only listing, what the model gets from them |
| `apps/desktop/src/renderer/src/ConnectionsPage.tsx` | The Connections page: a card per provider (sign-in, level, switches, tools, drift review) |
| `packages/gcp/src/` | Google Cloud, read-only: gcloud's account and token (`auth.ts`), the pinned GET client (`client.ts`), projects and Cloud Asset search (`assets.ts`), GKE clusters and Landlens's GKE kubeconfig with its exec plugin (`gke.ts`), what Claude may see of a resource (`scrub.ts`), the error sentences (`errors.ts`) ([gcp.md](gcp.md)) |
| `packages/gcp-mcp/src/` | `landlens-gcp`: the agent's five read-only Google Cloud tools, over a `GcpReader` main gives it |
| `apps/desktop/src/main/gcp.ts` | `GcpService`: on or off (`gcpMode`, the development overrides), the chosen projects, Claude's switch and the GKE yeses (`gcp.json`), the caches and read limits, the `gcp:*` answers, the GKE catalog entries and how to connect one, the agent's reader, Ask Claude's brief |
| `apps/desktop/src/renderer/src/GcpPage.tsx` | The Google Cloud page (projects, types, resources), its drawer (Open in Landlens, Ask Claude), the chooser, the Connections card and its switch for Claude |
| `apps/desktop/src/main/agent.ts` | `AgentService`: the agent in main |
| `apps/desktop/src/renderer/src/AgentDock.tsx` | The dock: session, transcript, composer |
| `apps/desktop/src/renderer/src/DockParts.tsx` | The dock's tool groups, wells, plan and permission ask |
| `apps/desktop/src/renderer/src/App.tsx` | The catalog and connecting; Welcome or Workspace |
| `apps/desktop/src/renderer/src/Workspace.tsx` | A connected window: what is open, the width rules, the health poll, keyboard |
| `apps/desktop/src/renderer/src/Sidebar.tsx`, `Toolbar.tsx`, `StatusBar.tsx` | The cluster switcher and nav (or rail), the main toolbar, the status bar |
| `apps/desktop/src/renderer/src/Overview.tsx` | The landing page: verdict, tiles, the worst five problems, warnings, nodes |
| `apps/desktop/src/renderer/src/Problems.tsx`, `problemRules.ts` | The Problems page and its drawer: filters, sections, facts, events, log evidence; ⌘K's problem matching |
| `apps/desktop/src/renderer/src/health.ts` | `useHealth`: `cluster:health` every 10s while visible; sidebar badges |
| `apps/desktop/src/renderer/src/ResourceTable.tsx`, `Details.tsx`, `Yaml.tsx` | Lists, the drawer with its diagnosis, the YAML well |
| `apps/desktop/src/renderer/src/Welcome.tsx`, `JumpPalette.tsx` | Pick a cluster; ⌘K Jump to |
| `apps/desktop/src/renderer/src/icons.tsx`, `Mark.tsx`, `present.ts`, `styles.css` | Icons per kind, the brand mark, name splitting and tones, the tokens and styles ([design.md](design.md)) |
| `packages/kube/src/health.ts` | `clusterHealth`: one health computation for the Overview and the agent's `cluster_overview` |
| `apps/desktop/src/main/ipc.ts` | IPC handlers |
| `apps/desktop/src/main/doctor.ts` | `DoctorService`: the doctor per cluster and scope, from the shared pod watch and timed reads; the Overview's health, evidence for a problem, certificate facts for the agent |
| `packages/metrics/src/` | Graphs: the Clickland client and scope queries, the cluster's Prometheus (found, asked through the service proxy), the metrics-server sampler (ring buffer), `MetricsService` (which source answers) ([metrics.md](metrics.md)) |
| `apps/desktop/src/main/clickland-settings.ts` | Clickland's address, cluster names, the console, telemetry's switches (in clear) and the key encrypted with safeStorage |
| `packages/telemetry/src/` | Landlens's own telemetry: the closed record constructors, OTLP/HTTP JSON, the queue, what a question was about ([family.md](family.md#what-landlens-reports)) |
| `apps/desktop/src/main/telemetry.ts`, `brain.ts` | `TelemetryService` (fed by the agent's observers, the gateway's call log, changes, clusters, the front door's audit and the doctor) and `BrainService` (a session's facts, the brain sheet, send and remove) |
| `apps/desktop/src/renderer/src/charts/` | `TimeChart`, `Sparkline`, `Bars` and the pure `scale.ts` helpers |
| `apps/desktop/src/renderer/src/Usage.tsx`, `MetricsTab.tsx`, `MetricsNotice.tsx`, `ClicklandSettings.tsx`, `metrics.ts` | The Overview's Usage card, the drawer's Metrics tab, source and empty-state notices, Connect Clickland, the polling hook |
| `apps/desktop/scripts/fuses.mjs` | The Electron fuses the packaged app ships with |
| `apps/desktop/src/renderer/src/kinds.ts` | Sidebar sections and table columns per kind; everything else gets a generic table |
| `packages/kube/src/status.ts` (`@landlens/kube/status`) | kubectl-style pod and node status, ages; shared by the UI and the agent's tools |
