# Architecture

How Landlens is built today (wave 1). The plan and the waves are in [plan.md](plan.md); why each choice was made is in
[research.md](research.md).

## The processes

| Process | What it does | Code |
|---|---|---|
| Electron main | Owns everything privileged: the clusters, their watches, the front door, IPC | `apps/desktop/src/main/` |
| Renderer | The UI. Sandboxed, no Node, reaches main only through `window.landlens` | `apps/desktop/src/renderer/` |
| Preload | The bridge: `invoke(channel, request)` and `on(pushChannel)` for the listed channels only | `apps/desktop/src/preload/index.ts` |
| `landlens-kube-proxy` (Go), one per connected cluster | Holds that cluster's credentials (client-go reads your kubeconfig, so exec plugins, OIDC and client certificates work as in kubectl) and forwards requests to the API server | `sidecar/kube-proxy/` |

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
  (`packages/kube/src/policy.ts`): `full` (whatever your RBAC allows) or `read` (get, list and watch only; no Secrets;
  no exec, attach, port-forward or proxy; optionally a few namespaces). Paths that could be read two ways (`//`,
  dot segments, percent-encoding) are refused.
- Allowed requests go to the cluster's sidecar; the caller's token never reaches the cluster. Every decision is
  audited (label, method, path, allowed, status, reason).
- Tools get a kubeconfig (`toolKubeconfig`) whose clusters point at the front door with the certificate pinned, and
  whose user is an exec credential plugin that reads the token from `LANDLENS_TOKEN`. No file holds a token. Without
  the variable, kubectl fails to authenticate.

## Code map

| Path | What |
|---|---|
| `packages/contracts/src/index.ts` | IPC channels, their zod schemas and response types; the bridge interface |
| `packages/kube/src/catalog.ts` | Contexts from your kubeconfig files (names and servers only) |
| `packages/kube/src/sidecar.ts` | Start and stop `landlens-kube-proxy`; `loopbackCert` |
| `packages/kube/src/client.ts` | Requests through a sidecar; API paths; `slim`, `withoutSecretValues` |
| `packages/kube/src/discovery.ts` | API discovery (aggregated v2, else per group) |
| `packages/kube/src/watch.ts` | `ResourceWatcher`: paginated list, watch with bookmarks, relist on 410, batches |
| `packages/kube/src/clusters.ts` | `ClusterManager` (connect, discovery, get, events) and `WatchHub` (shared, ref-counted watchers) |
| `packages/kube/src/access.ts` | SelfSubjectAccessReview |
| `packages/kube/src/policy.ts` | Request parsing and token policies |
| `packages/kube/src/frontdoor.ts` | The front door |
| `packages/kube/src/tool-kubeconfig.ts` | The kubeconfig for tools and the agent |
| `apps/desktop/src/main/security.ts` | Sandbox, CSP, navigation and permission guards |
| `apps/desktop/src/main/ipc.ts` | IPC handlers |
| `apps/desktop/scripts/fuses.mjs` | The Electron fuses the packaged app ships with |
| `apps/desktop/src/renderer/src/kinds.ts` | Sidebar sections and table columns per kind; everything else gets a generic table |
| `apps/desktop/src/renderer/src/status.ts` | kubectl-style pod and node status, ages |
