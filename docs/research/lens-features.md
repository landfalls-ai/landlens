# Lens features: how each one works

This page covers the user-facing features of OpenLens and Freelens and how each one is built. The process model, cluster
auth, the proxy and the data layer are in [lens-architecture.md](lens-architecture.md); this page points there when a
feature leans on them.

Sources, both MIT and read-only under `upstream/`:

- `openlens/`: lensapp/lens master at `f1a960fd` (2023-08-09), the last open-source OpenLens.
- `freelens/`: freelensapp/freelens main at `2547f555` (2026-11-13), the maintained fork.

Every citation is `path:line` relative to `upstream/`. `OL` means OpenLens, `FL` means Freelens. A `.../` in a
citation repeats the folder of the full path just before it. A claim from docs only is marked [docs]. No code is copied here; short identifiers are named so the reader can find
them.

Two terms used throughout:

- **LensProxy**: a local HTTP server in the Electron main process. The renderer talks to it. Paths under `/api-kube`
  are forwarded to the cluster; paths under `/api` are Lens's own routes (helm, metrics, port-forward, apply)
  (`openlens/packages/core/src/common/vars.ts:15-16`).
- **Proxy kubeconfig**: a kubeconfig Lens writes per cluster that points at its local auth proxy, so `kubectl` and
  `helm` child processes reach the cluster through Lens's proxy, not with the user's own credentials directly.

## Index

| Feature | Where it runs | Mechanism | OL in-tree? | FL change |
| --- | --- | --- | --- | --- |
| [Resource views](#1-resource-views-workloads-config-network-storage-rbac-crds) | renderer | generic list/detail over KubeObjectStore | yes | + admission policies, EndpointSlices, favorites |
| [Events](#2-events) | renderer | `/api/v1/events` store, limit 1000 | yes | same |
| [Logs](#3-logs) | renderer | polls `pods/log` every 10 s with `sinceTime` | store yes, menu no | combined workload logs, abortable requests |
| [Pod shell and attach](#4-pod-shell-and-attach) | main (pty) | types `kubectl exec` into a local pty | no (extension) | in core |
| [Node shell](#5-node-shell) | main (pty) | privileged `nsenter` pod in `kube-system` | session yes, menu no | `attach`, Windows, Bottlerocket |
| [Local terminal](#6-local-terminal) | main (pty) | node-pty + xterm over a WebSocket | yes | + standalone terminal |
| [Port-forward](#7-port-forward) | main | spawns `kubectl port-forward` | yes | `--address`, cache dir |
| [Helm](#8-helm-charts-and-releases) | main | bundled `helm` binary via `execFile` | yes | helm 4, no default bitnami repo |
| [Metrics](#9-metrics) | main | PromQL through the API server service proxy | yes | OpenShift, direct URL + bearer |
| [Resource editor](#10-resource-editor) | renderer | Monaco YAML, RFC 6902 JSON Patch | yes | managedFields toggle, pod resize |
| [Create resource](#11-create-resource) | main | `kubectl apply -f` on a temp file | yes | templates in `~/.freelens` |
| [Hotbar](#12-hotbar) | renderer | persisted list of catalog entity uids | yes | + favorites |
| [Command palette](#13-command-palette) | renderer | registered command list, Shift+Cmd+P | yes | sidebar-derived commands |
| [Extension API](#14-extension-api) | both | `LensMainExtension` / `LensRendererExtension` | yes | custom scheme, ESM, checksums |
| [kubectl download](#15-kubectl-and-binary-download) | main | version map + download per cluster minor | yes | pinned sha256, signature checks |

A note on OL at `f1a960fd`: the pod menu (Shell, Attach, Logs) and the node menu (Shell, Cordon, Drain) are not in this
tree. The core keeps the pieces (`createTerminalTab`, `sendCommand`, `logTabStore.createPodTab`) and exposes them
through the extension API (`openlens/packages/core/src/extensions/renderer-api/components.ts:133-148`); the menus came from bundled
extensions that are not part of this snapshot. Freelens moved them into core as `node-pod-menu`
(`freelens/packages/core/src/renderer/components/node-pod-menu/`). Landlens took Cordon and Drain in wave 8 part 2
(D149–D154), not as Freelens runs them (`kubectl cordon` and `kubectl drain` in a terminal tab,
`node-pod-menu/node-menu.tsx:61-67`) but as a reviewed patch and a previewed plan run in main
([workbench.md](../workbench.md#nodes-cordon-and-drain)). Wave 8 part 3 took the tables' multi-select with bulk
Restart and Delete (one reviewed card, main's dialog), the column picker, a kept sort and several namespaces at once
(D155–D158) ([workbench.md](../workbench.md#tables-selection-columns-namespaces)).

---

## 1. Resource views: workloads, config, network, storage, RBAC, CRDs

**What the user sees.** A cluster sidebar with groups (Workloads, Config, Network, Storage, Namespaces, Events, Helm,
Access Control, Custom Resources). Each leaf opens a table with search, sort, a namespace filter and a column picker.
Clicking a row opens a detail drawer with metadata, kind-specific panels, events and a menu (Edit, Delete, plus extras).

**How it works.** Each kind is a directory under `openlens/packages/core/src/renderer/components/` with the same parts: a sidebar item, a
route, a list view built on `KubeObjectListLayout`, and a details component. The sidebar item and the route are DI
injectables. A route is enabled only if the resource is allowed for the user, via `shouldShowResourceInjectionToken`
(`openlens/packages/core/src/common/front-end-routing/routes/cluster/workloads/pods/pods-route.injectable.ts:14-15`), and the sidebar item
hides with it (`openlens/packages/core/src/renderer/components/workloads-pods/pods-sidebar-items.injectable.ts:24`). The list view only
hands a store and filters to the layout (`openlens/packages/core/src/renderer/components/workloads-pods/pods.tsx:36-50`). The store,
list+watch and allowed-resources check are in the architecture page.

| Group | Kinds | OL directory (under `openlens/packages/core/src/renderer/components/`) |
| --- | --- | --- |
| Workloads | Overview, Pods, Deployments, DaemonSets, StatefulSets, ReplicaSets, ReplicationControllers, Jobs, CronJobs | `workloads-overview`, `workloads-pods`, `workloads-deployments`, `workloads-daemonsets`, `workloads-statefulsets`, `workloads-replicasets`, `workloads-replication-controllers`, `workloads-jobs`, `workloads-cronjobs` |
| Config | ConfigMaps, Secrets, ResourceQuotas, LimitRanges, HPA, VPA, PDB, PriorityClasses, RuntimeClasses, Leases, Mutating/Validating webhooks | `config-maps`, `config-secrets`, `config-resource-quotas`, `config-limit-ranges`, `config-horizontal-pod-autoscalers`, `config-vertical-pod-autoscalers`, `config-pod-disruption-budgets`, `config-priority-classes`, `config-runtime-classes`, `config-leases`, `config-mutating-webhook-configurations`, `config-validating-webhook-configurations` |
| Network | Services, Endpoints, Ingresses, IngressClasses, NetworkPolicies, Port Forwarding | `network-services`, `network-endpoints`, `network-ingresses`, `network-policies`, `network-port-forwards` |
| Storage | PVCs, PVs, StorageClasses | `storage-volume-claims`, `storage-volumes`, `storage-classes` |
| Cluster | Overview, Nodes, Namespaces, Events | `cluster`, `nodes`, `namespaces`, `events` |
| Access Control | ServiceAccounts, ClusterRoles, Roles, ClusterRoleBindings, RoleBindings, PodSecurityPolicies | `user-management/*`, `pod-security-policies` |
| Custom Resources | CRD list, one view per CRD grouped by API group | `custom-resource-definitions`, `custom-resources` |

**CRDs.** When the CRD store changes, the cluster frame creates a `KubeApi` per CRD on the fly, with a generated
`KubeObject` subclass carrying kind, namespaced flag and apiBase
(`openlens/packages/core/src/renderer/before-frame-starts/runnables/setup-auto-crd-api-creations.injectable.ts:24-54`). The custom
resource list gets its store from the API manager by apiBase (`openlens/packages/core/src/renderer/components/custom-resources/view.tsx:50`)
and turns the CRD's `additionalPrinterColumns` into table columns by evaluating each JSONPath
(`openlens/packages/core/src/renderer/components/custom-resources/view.tsx:61-78`); columns with priority above 0 go to the detail drawer
(`openlens/packages/core/src/renderer/components/custom-resources/details.tsx:131`).

**Freelens changes.**
- New kinds: Validating and Mutating AdmissionPolicies and their bindings, EndpointSlices
  (`freelens/packages/kube-object/src/specifics/validating-admission-policy.ts`,
  `.../mutating-admission-policy.ts`, `.../endpoint-slice.ts`; views in
  `freelens/packages/core/src/renderer/components/config-validating-admission-policies/`, `.../network-endpoint-slices/`).
- Node metrics from metrics-server (`/apis/metrics.k8s.io/v1beta1/nodes`,
  `freelens/packages/kube-object/src/specifics/node-metrics.ts:26`), loaded by the node store
  (`freelens/packages/core/src/renderer/components/nodes/store.ts:35-37`). OL only had pod metrics this way
  (`openlens/packages/kube-object/src/specifics/pod-metrics.ts:30`, `openlens/packages/core/src/renderer/components/workloads-pods/store.ts:29-33`).
- Favorites: pinned sidebar entries (see Hotbar).

**What Landlens should do.** Keep the "one directory per kind, generic list/detail" shape, but make it data-driven: a
kind descriptor (group, version, columns, detail panels) instead of ~15 files per kind. Treat built-in kinds and CRDs
the same way, with printer columns as the default. Gate on SelfSubjectAccessReview results, as Lens does.

## 2. Events

**What the user sees.** A cluster-wide Events table, sorted by age, plus a compact list of events in every object's
detail drawer, and a warnings count on the cluster overview.

**How it works.** A normal `KubeObjectStore` over core `v1` events (`openlens/packages/kube-object/src/specifics/events.ts:43`),
created with `limit: 1000` (`openlens/packages/core/src/renderer/components/events/store.ts:28`). Events for one object are a client-side
filter on `involvedObject.uid` (`openlens/packages/core/src/renderer/components/events/store.ts:42-49`). Warnings are grouped by involved
object, keeping the newest (`openlens/packages/core/src/renderer/components/events/store.ts:52-70`). The table defaults to sort by age and has
a compact mode capped at 10 rows (`openlens/packages/core/src/renderer/components/events/events.tsx:50-69`).

**Freelens.** Same design, same limit (`freelens/packages/core/src/renderer/components/events/store.ts:32`).

**What Landlens should do.** Use `events.k8s.io/v1` where available. Filter per object on the server
(`fieldSelector=involvedObject.uid=...`) rather than keep 1000 events in memory and filter on the client.

## 3. Logs

**What the user sees.** A "Logs" tab in the bottom dock: container picker, previous-container toggle, timestamps
toggle, search, wrap, "to bottom", download. New lines appear while the tab is open.

**How it works.** It is **not streaming**. `LogStore.load` fetches the last `N + 500` lines with `tailLines`
(`openlens/packages/core/src/renderer/components/dock/logs/store.ts:17`, `:52`), then starts a refresher that runs every 10 seconds
(`:64`; the interval helper takes seconds, `openlens/packages/utility-features/utilities/src/interval.ts:15-25`). Each
tick asks for lines `sinceTime` the last timestamp received (`:95`). Every request sets `timestamps: true` so old and
new lines can be told apart (`:134`). The request is a plain GET of `.../pods/{name}/log`
(`openlens/packages/utility-features/kube-api/src/endpoints/pod.api.ts:57-58`) issued from the renderer, so it goes
through LensProxy `/api-kube` and the auth proxy like every other API call. No `follow=true`, no chunked reading.

**Freelens changes.**
- Combined workload logs: a tab can hold the logs of every pod of a workload, re-reading the pod list on each refresh so
  it follows a rollout (`freelens/packages/core/src/renderer/components/dock/logs/logs-view-model.ts:113`,
  `freelens/packages/core/src/renderer/components/dock/logs/create-workload-logs-tab.injectable.ts:42`). Each pod keeps its own cursor and
  pods are asked a few at a time (`freelens/packages/core/src/renderer/components/dock/logs/store.ts:161`, `:235`). A combined tab keeps at
  most 100,000 lines (`freelens/packages/core/src/renderer/components/dock/logs/merge-pod-logs.ts:19`).
- Requests are abortable with an `AbortController`, and stopping a tab aborts the request in flight
  (`freelens/packages/core/src/renderer/components/dock/logs/store.ts:54`, `:155`, `:211`;
  `freelens/packages/utility-features/kube-api/src/endpoints/pod.api.ts:91-94`).
- Still polling every 10 seconds (`freelens/packages/core/src/renderer/components/dock/logs/store.ts:140`).

**What Landlens should do.** Stream with `follow=true` and read the chunked body incrementally (in main, or in the
renderer with `fetch` + `ReadableStream`), with `sinceSeconds`/`tailLines` for the backfill. Keep Freelens's per-pod
cursors and the line cap for multi-pod views. Keep timestamps on the wire and strip them in the view.

## 4. Pod shell and attach

**What the user sees.** "Shell" on a pod's menu picks a container and opens a terminal tab running bash, ash or sh in
it. Freelens also has "Attach".

**How it works.** There is no in-process exec over the Kubernetes WebSocket API. The renderer opens an ordinary
**local** terminal tab and types a `kubectl exec` command into it. In Freelens: build
`kubectl exec -i -t -n <ns> <pod> -c <container> -- sh -c "clear; (bash || ash || sh)"` (PowerShell on Windows
nodes), prefixed with the shell's own `exec` on non-Windows so the shell is replaced
(`freelens/packages/core/src/renderer/components/node-pod-menu/pod-shell-menu.tsx:50-68`); create a terminal tab
(`:73`); send the command with Enter (`:78`). Attach is the same with `kubectl attach`
(`freelens/packages/core/src/renderer/components/node-pod-menu/pod-attach-menu.tsx:50-53`). The local shell already has `KUBECONFIG` set
to the proxy kubeconfig (see Local terminal), so `kubectl` goes through Lens's proxy.

In OL this menu lived in a bundled extension, not in this tree; core only exposes `createTerminalTab` and `sendCommand`
to extensions (`openlens/packages/core/src/extensions/renderer-api/components.ts:133-138`).

**What Landlens should do.** Typing a command into a user shell is fragile (shell startup scripts, aliases, prompt
timing) and leaks the command into shell history. Landlens should exec directly: either spawn `kubectl exec` as the pty
process itself (no user shell in between), or implement the `v5.channel.k8s.io` exec WebSocket in main and bridge it
to xterm. Keep the `bash || ash || sh` fallback and the container picker.

## 5. Node shell

**What the user sees.** "Shell" on a node opens a root shell on that host.

**How it works (OL).** `NodeShellSession` in main (`openlens/packages/core/src/main/shell-session/node-shell-session/node-shell-session.ts`):

| Step | Detail | Citation |
| --- | --- | --- |
| Pod name | `node-shell-<uuid>` | `:33` |
| Pod spec | namespace `kube-system`, `nodeName` pinned, `restartPolicy: Never`, grace 0, `hostPID`, `hostIPC`, `hostNetwork`, tolerate everything, `priorityClassName: system-node-critical` | `:113-129` |
| Container | `privileged: true`; command `nsenter -t 1 -m -u -i -n sleep 14000` | `:130-138` |
| Image | cluster preference `nodeShellImage`, default `docker.io/alpine:3.13`; optional `imagePullSecret` | `:102-111`, `openlens/packages/core/src/common/cluster-types.ts:180` |
| Wait | a watch on `kube-system` pods until phase `Running`, 2-minute timeout | `:144-181` |
| Shell | `kubectl exec -i -t -n kube-system <pod> -- sh -c "(bash) or (ash) or (sh)"`, PowerShell for Windows nodes, in a node-pty | `:74-98` |
| Cleanup | delete the pod when the WebSocket closes, or on any create error | `:46-57` |

The pod is created with the proxy kubeconfig, i.e. with the user's own RBAC (`:43-44`). The user needs rights to create
privileged pods in `kube-system`.

**Freelens changes** (`freelens/packages/core/src/main/shell-session/node-shell-session/node-shell-session.ts`):
- The container runs the shell itself: `nsenter -t 1 -m -u -i -n -p -- bash -l`, with `stdin`, `stdinOnce`, `tty`, and
  Lens connects with `kubectl attach` instead of exec into a sleeping pod (`:172-181`, `:233-238`, `:127`).
  So the pod ends when the shell ends.
- Bottlerocket nodes run `apiclient exec admin bash -l` (`:174-175`).
- Windows nodes get a HostProcess container running PowerShell as SYSTEM, image `mcr.microsoft.com/powershell`
  (`:184-200`, `freelens/packages/core/src/common/cluster-types.ts:197`).
- Default Linux image is `docker.io/library/alpine` with no tag (`freelens/packages/core/src/common/cluster-types.ts:192`).
- Cleanup waits for an in-flight create before deleting, so a fast close does not leak a pod (`:79-84`).

**What Landlens should do.** Take Freelens's version (attach to a pod whose PID 1 is the shell). Pin the image by
digest, not a floating tag. Label the pod so leftovers can be found and garbage-collected at startup. Show the user
what will be created (privileged, host namespaces) the first time. Offer `kubectl debug node/<name>` as an alternative
where the cluster allows it.

## 6. Local terminal

**What the user sees.** A terminal tab in the dock, scoped to the active cluster: `kubectl` works against that cluster
with no setup. Tabs survive a reload.

**How it works.**
- Renderer: xterm.js with the fit addon (`openlens/packages/core/src/renderer/components/dock/terminal/terminal.ts:9-10`). To connect, it
  asks main for a one-time token over IPC (`cluster:shell-api`) and opens a WebSocket to LensProxy at `/api` with the
  tab id, optional node name and the token in the query (`openlens/packages/core/src/renderer/api/terminal-api.ts:69-86`).
- LensProxy: an `upgrade` on `/api?` is a shell request; anything else is forwarded to the cluster
  (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:87-99`). The handler checks the token and opens a local or node session
  (`openlens/packages/core/src/main/lens-proxy/proxy-functions/shell-api-request.injectable.ts:23-36`,
  `openlens/packages/core/src/main/shell-session/create-shell-session.injectable.ts:27-31`).
- Token: 128 random bytes per (cluster, tab), compared with `timingSafeEqual`, deleted after one use
  (`openlens/packages/core/src/main/lens-proxy/proxy-functions/shell-request-authenticator/shell-request-authenticator.ts:17-49`).
- Main: node-pty spawns the user's shell (`openlens/packages/core/src/main/shell-session/spawn-pty.injectable.ts:6-17`). The pty is kept in
  a map by tab id, so a reconnect resumes the same process (`openlens/packages/core/src/main/shell-session/shell-session.ts:142-155`).
  Messages are JSON frames: stdin, resize, ping (`:240-262`). On non-zero exit the tab closes after 15 seconds (`:232`).
- Environment: the user's login-shell environment, with Lens's kubectl directory first on `PATH`, `KUBECONFIG` set to
  the proxy kubeconfig, `HTTPS_PROXY` from cluster settings, `NO_PROXY` including localhost
  (`openlens/packages/core/src/main/shell-session/shell-session.ts:323-378`). For zsh, `ZDOTDIR` points at a Lens directory holding init
  scripts; bash gets `--init-file`, fish an `--init-command` (`:356-360`,
  `openlens/packages/core/src/main/shell-session/local-shell-session/local-shell-session.ts:52-70`). Extensions can modify the env
  (`:40`).

**Freelens changes.**
- A standalone terminal that belongs to no cluster and uses the user's own kubeconfig
  (`freelens/packages/core/src/main/shell-session/standalone-shell-session/open.injectable.ts:40`,
  `freelens/packages/core/src/features/standalone-terminal/renderer/terminal-page.tsx`), routed by `type=standalone`
  (`freelens/packages/core/src/main/freelens-proxy/proxy-functions/shell-api-request.injectable.ts:35-38`).
- Tool paths and env are computed in one place, `KubeTools`: kubectl path, helm path, `KUBECACHEDIR`, and a
  `FREELENS_PROXY_TOKEN` that the proxy kubeconfig's credential plugin reads
  (`freelens/packages/core/src/main/kube-tools/kube-tools.ts:28-56`). See the architecture page for the token.
- xterm moved to the scoped `@xterm/*` packages; node-pty stays (`freelens/packages/core/package.json:97-123`); ConPTY
  on Windows (`freelens/packages/core/src/main/shell-session/shell-session.ts:223`).

**What Landlens should do.** Keep node-pty + xterm + resume-by-tab-id and the one-time token. Do not hijack `ZDOTDIR`
or init files: set `KUBECONFIG` and `PATH` in the spawn env only. Use a binary WebSocket protocol, not JSON per
keystroke.

## 7. Port-forward

**What the user sees.** "Forward" on a service or pod port, a dialog for the local port (random by default) and
"open in browser", and a Port Forwarding page listing active forwards with stop/restart. Forwards come back after a
restart.

**How it works.** Main spawns **`kubectl port-forward` as a child process**, one per forward. Arguments:
`--kubeconfig <proxy kubeconfig> port-forward -n <ns> <kind>/<name> <local>:<remote>`
(`openlens/packages/core/src/main/routes/port-forward/functionality/port-forward.ts:62-74`). It uses the bundled kubectl, not the
version-matched one (`openlens/packages/core/src/main/routes/port-forward/functionality/create-port-forward.injectable.ts:19`). The local
port is parsed from kubectl's "Forwarding from ..." line, then confirmed with a TCP check (`:12-14`, `:88-96`). The
renderer drives it over LensProxy routes `POST/GET/DELETE /api/pods/port-forward/{namespace}/{resourceType}/{resourceName}`
(`openlens/packages/core/src/main/routes/port-forward/start-port-forward-route.injectable.ts:21-22`, `:48-50`). The renderer persists the
list and restarts them on load (`openlens/packages/core/src/renderer/port-forward/port-forward-store/port-forward-store.ts:38`, `:72`). The
browser URL is `http(s)://localhost:<port>` (`openlens/packages/core/src/renderer/port-forward/port-forward-utils.ts:9`).

**Freelens changes.** Adds `--address` (default `localhost`) and `--cache-dir`, and passes the proxy credential in the
env (`freelens/packages/core/src/main/routes/port-forward/functionality/port-forward.ts:74-92`).

**What Landlens should do.** One kubectl process per forward is simple and robust; keep it for v1. A later version can
do it in-process (SPDY/WebSocket portforward subresource) to drop the kubectl dependency and get per-connection errors.
Bind to `127.0.0.1` by default and warn before binding to other addresses.

## 8. Helm: charts and releases

**What the user sees.** A Helm section with Charts (search across repos, readme, versions, install with a values
editor) and Releases (list per namespace, details with resources and values, upgrade, rollback, history, delete).
Repositories are managed in Preferences.

**How it works.** Main runs the **bundled `helm` binary** with `execFile` (`openlens/packages/core/src/main/helm/exec-helm/exec-helm.injectable.ts:22-25`,
binary path `openlens/packages/core/src/main/helm/helm-binary-path.injectable.ts:10`). Every cluster command passes
`--kubeconfig <proxy kubeconfig>`. The renderer reaches it through LensProxy routes under `/api/v2/charts` and
`/api/v2/releases` (`openlens/packages/core/src/main/routes/helm/`).

| Action | Helm call | Citation |
| --- | --- | --- |
| List releases | `helm ls --all --max 9999 --output json`, `-n` or `--all-namespaces` | `openlens/packages/core/src/main/helm/list-helm-releases.injectable.ts:19-33` |
| Install | `helm install ...` with a values file | `openlens/packages/core/src/main/helm/install-helm-chart.injectable.ts:51-62` |
| Upgrade | values written to a temp file, `helm upgrade <rel> <chart> --version --values --namespace` | `openlens/packages/core/src/main/helm/helm-service/update-helm-release.injectable.ts:39-48` |
| Rollback, history, delete | `helm rollback`, `helm history --output json`, `helm delete` | `openlens/packages/core/src/main/helm/rollback-helm-release.injectable.ts:23-27`, `.../get-helm-release-history.injectable.ts:23-27`, `.../delete-helm-release.injectable.ts:22-25` |
| Release resources | `helm get manifest`, then pipe the manifests to `kubectl get -f - -o json` for live state | `openlens/packages/core/src/main/helm/helm-service/get-helm-release-resources/call-for-helm-manifest/call-for-helm-manifest.injectable.ts:23-29`, `.../call-for-kube-resources-by-manifest.injectable.ts:39-54` |
| Chart list | read each repo's `<name>-index.yaml` from `HELM_REPOSITORY_CACHE`, cached by mtime | `openlens/packages/core/src/main/helm/helm-chart-manager.ts:70-103`, `openlens/packages/core/src/main/helm/repositories/get-active-helm-repositories/get-active-helm-repositories.injectable.ts:127` |
| Readme, values | `helm show readme`, `helm show values` | `openlens/packages/core/src/main/helm/helm-chart-manager.ts:62-66` |
| Repos | `helm repo add/remove/update`; adds `bitnami` when there are no repos | `openlens/packages/core/src/main/helm/repositories/add-helm-repository/add-helm-repository.injectable.ts:31`, `.../get-active-helm-repositories.injectable.ts:78-87` |

Small bug: `maxBuffer` is commented as 32 MiB but set to 32 GiB (`openlens/packages/core/src/main/helm/exec-helm/exec-helm.injectable.ts:23`).

**Freelens changes.** Bundled helm 4.3.1 (`freelens/freelens/package.json:57`). No default bitnami repo; the
"no repositories found" error is handled instead
(`freelens/packages/core/src/main/helm/repositories/get-active-helm-repositories/get-active-helm-repositories.injectable.ts:82`, `:125`).
Release resources come straight from the manifest, without the `kubectl get -f -` round trip
(`freelens/packages/core/src/main/helm/helm-service/get-helm-release-resources/get-helm-release-resources.injectable.ts:28-38`).
helm path comes from `KubeTools` (`freelens/packages/core/src/main/kube-tools/kube-tools.ts:30`).

**What Landlens should do.** Shelling out to helm is the right call; reimplementing Helm is not. Bundle a pinned,
checksummed helm, run it in main only, always with an explicit kubeconfig and namespace. Read release state from the
release Secret where possible to avoid a process per list. Do not add third-party repos by default.

## 9. Metrics

**What the user sees.** CPU, memory, network and filesystem charts on the cluster overview, nodes, pods, workloads,
PVCs and ingresses. Cluster settings let the user pick a Prometheus provider or keep auto-detect, and set
`namespace/service:port` and a path prefix.

**How it works.**
- Providers are injectables, each with a service locator and a PromQL template per metric
  (`openlens/packages/technical-features/prometheus/src/`):

| Provider kind | Detection | Citation |
| --- | --- | --- |
| `lens` | service `prometheus` in namespace `lens-metrics` | `.../lens-provider.injectable.ts:144-149` |
| `helm` | label `app=prometheus,component=server,heritage=Helm`, all namespaces | `.../helm-provider.injectable.ts:145-149` |
| `helm14` | same label | `.../helm-14-provider.injectable.ts:14-18` |
| `operator` | label `operated-prometheus=true` | `.../operator-provider.injectable.ts.ts:145-148` |
| `stacklight` | service `prometheus-server` in `stacklight` | `.../stacklight-provider.injectable.ts:145-148` |

- Auto-detect asks every provider in parallel and takes the first hit
  (`openlens/packages/core/src/main/cluster/prometheus-handler/prometheus-handler.ts:91-112`); lookups use
  `listServiceForAllNamespaces` with a label selector and take the first port
  (`openlens/packages/technical-features/prometheus/src/provider.ts:55-72`).
- Queries go **through the API server's service proxy**:
  `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy<prefix>/api/v1/query_range`
  (`openlens/packages/core/src/main/cluster/prometheus-handler/prometheus-handler.ts:39`, `openlens/packages/core/src/main/get-metrics.injectable.ts:26-33`).
  So the user needs `services/proxy` rights, and no extra port-forward is needed.
- The renderer posts named metrics to `POST /api/metrics` (default range 1 h, step 60 s)
  (`openlens/packages/core/src/common/k8s-api/endpoints/metrics.api/request-metrics.injectable.ts:50-60`); main maps each name to PromQL for
  the chosen provider, dedupes identical queries and retries up to five times with backoff, giving up on 4xx
  (`openlens/packages/core/src/main/routes/metrics/add-metrics-route.injectable.ts:21-48`, `:67-110`).
- Pod usage numbers in lists come from metrics-server, not Prometheus
  (`openlens/packages/core/src/renderer/components/workloads-pods/store.ts:29-33`).
- The `lens-metrics` stack itself (the "Lens Metrics" cluster feature) is not in this tree.

**Freelens changes.**
- An `openshift` provider: `prometheus-k8s` in `openshift-monitoring`
  (`freelens/packages/technical-features/prometheus/src/openshift-provider.injectable.ts:14-19`).
- A direct Prometheus URL with an optional bearer token, bypassing the service proxy, for setups behind
  kube-rbac-proxy (`freelens/packages/core/src/main/get-metrics.injectable.ts:22-41`, `:79-85`). The token sits in cluster preferences
  (`freelens/packages/core/src/common/cluster-types.ts:127-129`), which are stored in the plain JSON `lens-cluster-store`
  (`freelens/packages/core/src/features/cluster/storage/common/storage.injectable.ts:32`).
- Node metrics from metrics-server (see Resource views).

**What Landlens should do.** Keep the provider-plus-query-template model and the service-proxy path. Make metrics-server
the baseline (works on every cluster) and Prometheus an upgrade. Store any bearer token in the OS keychain
(`safeStorage`), not in a JSON preference file. Batch queries per view.

## 10. Resource editor

**What the user sees.** "Edit" on any object opens a dock tab with a YAML editor; Save or Save & Close.

**How it works.** The object is dumped to YAML in Monaco (`openlens/packages/core/src/renderer/components/dock/edit-resource/edit-resource-model/edit-resource-model.injectable.tsx:169`,
`openlens/packages/core/src/renderer/components/dock/editor-panel.tsx:13`). On save, the first draft and the edited text are both
parsed, an **RFC 6902 JSON Patch** is computed between them with `rfc6902.createPatch` (`:185-194`), and sent as a
PATCH with `application/json-patch+json` from the renderer through `/api-kube`
(`.../request-patch-kube-resource.injectable.ts:19-23`). The diff has no `test` ops and no resourceVersion
precondition, so concurrent edits are last-writer-wins on the changed paths. The patch header types available are
json, merge and strategic (`openlens/packages/utility-features/kube-api/src/kube-api.ts:221-224`); there is no
server-side apply.

**Freelens changes.**
- A toggle to hide or show `metadata.managedFields`; hidden fields are restored before the diff
  (`freelens/packages/core/src/renderer/components/dock/edit-resource/edit-resource-model/edit-resource-model.injectable.tsx:201`, `:278-284`).
- Pod resource changes go to the `resize` subresource as a strategic merge patch, and must be saved apart from other
  pod changes (`:148-156`), for in-place pod resize.
- The patch strategy is a parameter (`.../request-patch-kube-resource.injectable.ts:33-43`).

**What Landlens should do.** Keep "diff the draft against the original", but add a resourceVersion precondition (a
JSON Patch `test` op on `/metadata/resourceVersion`) to catch conflicts, and show a three-way diff on conflict. Offer
server-side apply (`application/apply-patch+yaml`, a Landlens field manager) as the save mode for whole-object edits.
Hide managedFields by default.

## 11. Create resource

**What the user sees.** A "+" in the dock opens a YAML editor with a template picker (Deployment, Service, Secret,
...); Create applies it and links to the new objects.

**How it works.** The renderer splits multi-document YAML and posts each document to `POST /api/stack`
(`openlens/packages/core/src/renderer/components/dock/create-resource/view.tsx:77-96`,
`openlens/packages/core/src/common/k8s-api/endpoints/resource-applier.api/request-update.injectable.ts:18`). Main strips `status`,
`resourceVersion` and the last-applied annotation, writes a temp file, and runs
`kubectl apply --kubeconfig <proxy> -o json -f <file>` (`openlens/packages/core/src/main/resource-applier/resource-applier.ts:90-115`,
`:170-177`). Built-in templates are 21 YAML files bundled with webpack `require.context`
(`openlens/packages/resource-templates/templates/create-resource/`,
`openlens/packages/core/src/renderer/components/dock/create-resource/lens-templates.injectable.ts:14`). User templates are watched in
`~/.k8slens/templates` (`openlens/packages/core/src/renderer/components/dock/create-resource/user-templates.injectable.ts:31`).

**Freelens.** Same path through kubectl apply (`freelens/packages/core/src/main/resource-applier/resource-applier.ts:104`); templates live in
`~/.freelens/templates` (`freelens/packages/core/src/renderer/components/dock/create-resource/user-templates.injectable.ts:34`).

**What Landlens should do.** Use server-side apply over HTTP from main instead of a kubectl process and a temp file:
fewer moving parts and structured errors. Keep a user template folder.

## 12. Hotbar

**What the user sees.** A vertical bar on the left with pinned items (clusters and other catalog entities), several
named hotbars to switch between, 12 cells each.

**How it works.** A persisted store, `lens-hotbar-store`, synced between main and renderers
(`openlens/packages/core/src/features/hotbar/storage/common/storage.injectable.ts:33-34`). Each cell holds an entity uid, name and source
(`openlens/packages/core/src/features/hotbar/storage/common/types.ts:5-12`); 12 cells "to hit any item with the keyboard" (`:28`). Store
migrations run in main (`openlens/packages/core/src/features/hotbar/storage/main/`).

**Freelens changes.** Hotbar kept (`freelens/packages/core/src/features/hotbar/storage/common/storage.injectable.ts:39`). Adds Favorites:
pinned sidebar entries (built-in kinds or CRDs) with order and a short-names option, stored in
`freelens-favorites-store` (`freelens/packages/core/src/features/favorites/common/storage.injectable.ts:14-34`,
`freelens/packages/core/src/renderer/components/favorites/sidebar-item.injectable.tsx:16`).

**What Landlens should do.** Favorites (pinned resource kinds) are more useful day to day than a hotbar of clusters.
Start with a cluster switcher plus favorites; skip multi-hotbar.

## 13. Command palette

**What the user sees.** Shift+Cmd+P (Shift+Ctrl+P) opens a palette of commands: go to a resource list, open a
terminal, open settings, switch hotbar, search the catalog.

**How it works.** A dialog bound to the shortcut in both the root frame and each cluster frame. When the root frame
has a cluster frame showing, it forwards the open to that frame over an IPC broadcast
(`openlens/packages/core/src/renderer/components/command-palette/command-container.tsx:40-62`). Commands are a computed list of internal
commands (30 of them, `openlens/packages/core/src/renderer/components/command-palette/registered-commands/internal-commands.injectable.tsx:81-246`),
extension commands and one per CRD, each with an optional `isActive`
(`.../registered-commands.injectable.ts:22-39`).

**Freelens changes.** The hand-written "view X" commands are replaced by commands derived from the sidebar tree, so
every navigable leaf is a command with a breadcrumb title
(`freelens/packages/core/src/renderer/components/command-palette/registered-commands/sidebar-navigation-commands.injectable.ts`); 11
internal commands remain.

**What Landlens should do.** Derive commands from the navigation and kind registry, as Freelens does, and add
object-level search (jump to a named pod) and actions on the selected object.

## 14. Extension API

**What the user sees.** Preferences > Extensions: install from npm name, URL or `.tgz`, enable or disable. Extensions
add pages, menus, detail panels, status bar items and more.

**How it works.** An extension is an npm package with `main` and/or `renderer` entry points. Classes:
- `LensExtension` base: enable, disable, `onActivate`, `onDeactivate`, a per-extension storage folder
  (`openlens/packages/core/src/extensions/lens-extension.ts:81-121`).
- `LensMainExtension`: `appMenus`, `trayMenus`, `terminalShellEnvModifier`, `addCatalogSource`
  (`openlens/packages/core/src/extensions/lens-main-extension.ts:29-30`, `:62`, `:68`).
- `LensRendererExtension`: `globalPages`, `clusterPages`, `clusterPageMenus`, `clusterFrameComponents`,
  `kubeObjectStatusTexts`, `appPreferences`, `appPreferenceTabs`, `entitySettings`, `statusBarItems`,
  `kubeObjectDetailItems`, `kubeObjectMenuItems`, `kubeWorkloadsOverviewItems`, `commands`, `welcomeMenus`,
  `welcomeBanners`, `catalogEntityDetailItems`, `topBarItems`, `additionalCategoryColumns`, `customCategoryViews`,
  `kubeObjectHandlers`, plus catalog filters (`openlens/packages/core/src/extensions/lens-renderer-extension.ts:57-76`, `:151-164`).
- API surface: `Common`, `Main`, `Renderer` namespaces with catalog, k8s-api, navigation, components and theming
  (`openlens/packages/core/src/extensions/common-api/`, `main-api/`, `renderer-api/`). The legacy API is a facade over the DI container
  (`openlens/packages/core/src/extensions/lens-renderer-extension.ts:84`).
- Install: copied under `~/.k8slens/extensions`, dependencies installed by forking the bundled npm CLI
  (`openlens/packages/core/src/extensions/extension-discovery/extension-discovery.ts:111`,
  `openlens/packages/core/src/extensions/install-extension/install-extension.injectable.ts:27-28`).
- Load: plain `require()` of the entry point in the same process (`openlens/packages/core/src/extensions/extension-loader/extension-loader.ts:361-371`).
  Renderer extensions run with the renderer's full Node privileges. No sandbox, no permission model.

**Freelens changes.**
- A published `@freelensapp/extensions` package that is only a runtime shim over a global the app sets, plus types;
  React, MobX and Monaco are provided by the host (`freelens/packages/extensions/README.md` [docs]).
- Extension files are served over a privileged `freelens-extension://extensions/<name>/<build>/` scheme and loaded with
  ESM `import()` (`freelens/packages/core/src/features/extensions/loader/common/scheme.ts:13-34`,
  `freelens/packages/core/src/extensions/extension-loader/extension-loader.ts:910`). The file says plainly that with
  `contextIsolation: false` this is not an isolation boundary (`scheme.ts:17-19`).
- Installs are managed copies under `<userData>/extensions`, versioned by the tarball sha256, with an optional
  `.tgz.sha256` sidecar for URL and file installs
  (`freelens/packages/core/src/extensions/extension-discovery/extension-discovery.ts:151`,
  `freelens/packages/core/src/features/extensions/installer/common/checksums.ts:13-29`,
  `freelens/packages/core/src/renderer/components/extensions/attempt-install/install-from-url.injectable.tsx:24`).
- A `customResources` registration point (`freelens/packages/core/src/extensions/lens-renderer-extension.ts:85`).

**What Landlens should do.** Do not ship an extension API in v1. When it comes, design for isolation from the start:
extensions in a sandboxed iframe or utility process with a typed message API and declared permissions (which clusters,
which verbs), not code in the privileged renderer. Keep Freelens's checksum-pinned installs and host-provided UI libs.

## 15. kubectl and binary download

**What the user sees.** Terminals and port-forwards just work. Preferences let the user turn off kubectl download, set
a kubectl path, and pick a download mirror.

**How it works.**
- Build time: the `ensure-binaries` package downloads `lens-k8s-proxy`, `kubectl` and `helm` for each platform into
  `binaries/client` (`openlens/packages/ensure-binaries/src/index.ts:163-192`); versions come from the app's
  `package.json` config: k8s proxy 0.3.0, kubectl 1.23.3, helm 3.11.0 (`openlens/open-lens/package.json:37-40`). No
  checksum or signature check.
- `kubectl-versions` is a generated map from each Kubernetes minor to its latest patch, built by fetching
  `https://dl.k8s.io/release/stable-<minor>.txt` (`openlens/packages/kubectl-versions/build/compute-versions.ts:17`,
  data in `.../build/versions.json`). The bundled version is added to the map
  (`openlens/packages/core/src/main/kubectl/version-map.injectable.ts:10-20`).
- Run time, per cluster: `Kubectl` takes the cluster's server version, looks up `major.minor` in the map, else falls
  back to the exact server version (`openlens/packages/core/src/main/kubectl/kubectl.ts:57-87`). If that version is the bundled one, the
  bundled binary is copied into place; otherwise it is downloaded from the mirror (default
  `storage.googleapis.com/kubernetes-release/release`, or an Azure China mirror) to
  `<userData>/binaries/kubectl/<version>/` (`:84-86`, `:212-264`, `:370-377`,
  `openlens/packages/core/src/features/user-preferences/common/preferences-helpers.ts:63-71`). The download is a plain stream to disk with
  no checksum (`:285-300`), guarded by a file lock (`:8`). It then checks `kubectl version` output and deletes the
  binary if it looks wrong (`:149-190`). Any failure falls back to the bundled kubectl (`:105-134`).
- The chosen kubectl's directory goes first on the terminal `PATH` and into bash/zsh init scripts (`:304-368`).

**Freelens changes.**
- Bundled kubectl 1.37.2, helm 4.3.1, `freelens-k8s-proxy` 2.0.0 (`freelens/freelens/package.json:56-61`).
- Build-time binaries are pinned in a committed lock file of exact bytes (`freelens/packages/ensure-binaries/src/lock.ts:13`,
  `:51`) and verified at bump time against publisher signatures: GitHub build provenance for the proxy, PGP for helm,
  keyless cosign for kubectl (`freelens/packages/ensure-binaries/src/verify.ts:25-46`). Default download host is
  `dl.k8s.io` (`freelens/packages/ensure-binaries/src/artifacts.ts:114`).
- Runtime kubectl downloads need a pinned sha256 from a shipped `checksums.json`; with no pin, there is no download
  (`freelens/packages/core/src/main/kubectl/kubectl.ts:598-606`, sha256 compare at `:645-651`;
  `freelens/packages/kubectl-versions/build/checksums.json`). The version map starts at 1.22
  (`freelens/packages/kubectl-versions/build/compute-versions.mts:24`).
- Mirrors are now Default (`https://dl.k8s.io/release`) or Custom; the Azure China mirror is gone
  (`freelens/packages/core/src/features/user-preferences/common/preferences-helpers.ts:101-118`).
- Same major.minor matching (`freelens/packages/core/src/main/kubectl/kubectl.ts:206`, URL at `:225`).

**What Landlens should do.** Take the Freelens model whole: a lock file of pinned digests for bundled binaries,
signature checks at bump time, and runtime downloads only for versions with a shipped sha256. Match kubectl to the
server minor (kubectl supports +/-1 minor skew, so one binary often covers several clusters). Store under the app data
dir, never on the user's `PATH` globally.

---

## What Landlens takes

- **Generic resource views.** One kind registry drives sidebar, routes, list columns, detail panels and commands.
  CRDs use the same path with printer columns. Hide what RBAC disallows.
- **Real log streaming.** `follow=true` with a chunked reader, not 10-second polling. Keep Freelens's multi-pod
  workload logs, per-pod cursors and a line cap.
- **Direct exec.** Pod shell and attach spawn `kubectl exec/attach` as the pty process (or use the exec WebSocket),
  not text typed into a user shell.
- **Node shell the Freelens way.** A labelled, digest-pinned, privileged pod whose PID 1 is `nsenter ... bash -l`,
  joined with `attach`, deleted on close, with leftovers swept at startup.
- **Terminal plumbing.** node-pty + xterm, one-time token per tab over a local WebSocket, resume by tab id, env
  (`KUBECONFIG`, `PATH`) set at spawn, no `ZDOTDIR` tricks.
- **Port-forward via kubectl** for v1, bound to `127.0.0.1`, persisted and restored.
- **Helm via a bundled, pinned helm binary** in main, explicit kubeconfig and namespace, no default third-party repo.
- **Metrics.** metrics-server as the baseline; Prometheus providers with query templates through the service proxy;
  secrets for direct Prometheus in the OS keychain.
- **Editing.** JSON Patch with a resourceVersion `test` op, or server-side apply; managedFields hidden by default; pod
  resize via the `resize` subresource.
- **Create via server-side apply over HTTP**, not kubectl and temp files; keep user templates.
- **Favorites over hotbar**, and a command palette derived from the navigation tree.
- **No extension API in v1.** When added, sandboxed with declared permissions, never in a privileged renderer.
- **Supply chain.** Pinned digests and signature checks for every bundled or downloaded binary, as Freelens does.
