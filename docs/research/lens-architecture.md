# Lens architecture: what we learned from OpenLens and Freelens

Research for Landlens. We read the source to learn how it works. We copy no code.

Sources (read-only, under `~/WorkSpace/landlens/upstream/`):

| Name | Repo | Commit | Date |
|---|---|---|---|
| OpenLens | lensapp/lens `master` | `f1a960fd` | 2023-08-09 |
| Freelens | freelensapp/freelens `main` | `2547f555` | 2026-11-13 |

Every citation is `path:line`, relative to `upstream/`. A claim taken only from a README or a code comment is marked [docs]. A claim we inferred and could not see in this source (for example inside a binary that is fetched at build time) is marked [inferred].

Features (logs, shells, port-forward, helm, metrics, editor, hotbar, extensions, binaries) are in `lens-features.md`.

---

## 1. Process model

### 1.1 The processes

| Process | What runs there | Entry |
|---|---|---|
| Electron main (Node) | DI container, cluster manager, LensProxy (HTTPS server), local REST router, kubeconfig sync, shells (node-pty), helm/kubectl spawns, extension main bundles | `openlens/open-lens/src/main/index.ts:21` |
| One `kube-auth-proxy` child process per connected cluster | A Go binary, `lens-k8s-proxy` (Freelens: `freelens-k8s-proxy`). It holds the real cluster credentials and talks to the API server | `openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:77` |
| Renderer, root frame | Catalog, hotbar, welcome, preferences, the cluster frame host | `openlens/open-lens/src/renderer/index.ts:40` |
| Renderer, one `<iframe>` per opened cluster | The whole cluster dashboard: resource lists, details, dock (logs, terminals, editor) | `openlens/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:56` |

There is one `BrowserWindow`. Cluster dashboards are iframes inside it, not separate windows or `BrowserView`s.

- The window loads `https://lens.app:<port>`, served by LensProxy (`openlens/packages/core/src/main/start-main-application/lens-window/application-window/create-application-window.injectable.ts:36`). The static files come from a catch-all route `/{path*}` (`openlens/packages/core/src/main/routes/files/static-file-route.injectable.ts:19`).
- Chromium maps `lens.app` and `*.lens.app` to 127.0.0.1 with the `host-rules` switch (`openlens/packages/core/src/main/start-main-application/runnables/setup-hostnames.injectable.ts:16`).
- Each cluster iframe loads `//<clusterId>.<host>` (`openlens/packages/core/src/common/utils/cluster-id-url-parsing.ts:25`). The cluster ID is parsed back out of the subdomain (`openlens/packages/core/src/common/utils/cluster-id-url-parsing.ts:13`, used by `openlens/packages/core/src/renderer/cluster-frame-context/hosted-cluster-id.injectable.ts:10`).
- Both frames run the same renderer bundle. `bootstrap` picks root or cluster init by `process.isMainFrame` (`openlens/packages/core/src/renderer/bootstrap.tsx:30`). The code itself has a TODO asking for "proper architectural boundaries between root and cluster iframes" (`openlens/packages/core/src/renderer/bootstrap.tsx:29`).
- A frame is created when a cluster is opened and torn down when it disconnects (`openlens/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:78`). Switching clusters hides frames with a CSS class; it does not reload them (`openlens/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:116`).
- Why iframes: each cluster gets its own origin, so its own DI container, MobX stores and watches, and a host header the proxy can route on. Closing a cluster drops everything at once by blanking the frame (`openlens/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:98`).
- Freelens keeps the same model. Only the host names change to `renderer.freelens.app` (`freelens/packages/core/src/main/start-main-application/lens-window/application-window/create-application-window.injectable.ts:38`, `freelens/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:57`).

### 1.2 Startup order

- `startApplication` runs three slots in order: before loading, on load, after loaded (`openlens/packages/technical-features/application/agnostic/src/start-application/start-application.injectable.ts:17`). Each slot is an injection token; any injectable can add a "runnable" to it.
- Before Electron is ready: generate the LensProxy certificate (`openlens/packages/core/src/main/start-main-application/runnables/setup-lens-proxy-certificate.injectable.ts:17`), set host rules (`openlens/packages/core/src/main/start-main-application/runnables/setup-hostnames.injectable.ts:16`).
- Before loading: inject system CAs (`openlens/packages/core/src/main/start-main-application/runnables/setup-system-ca.injectable.ts:12`).
- The full list of main runnables is the directory `openlens/packages/core/src/main/start-main-application/runnables/`.

### 1.3 IPC

There are two layers.

| Layer | How | Where |
|---|---|---|
| Legacy | Raw `ipcMain.handle` / `ipcRenderer.invoke` on string channels. `broadcastMessage` sends to every `webContents` and to every registered cluster subframe with `sendToFrame` | `openlens/packages/core/src/common/ipc/ipc.ts:21`, `openlens/packages/core/src/common/ipc/ipc.ts:31`, `openlens/packages/core/src/common/ipc/ipc.ts:73` |
| `@k8slens/messaging` | Typed message channels and request channels, declared with `getMessageChannel` / `getRequestChannel`, listeners registered as injectables | `openlens/packages/technical-features/messaging/agnostic/src/features/actual/message/get-message-channel.ts`, `openlens/packages/technical-features/messaging/electron/main/src/send-message-to-channel/send-message-to-channel.injectable.ts:24` |

- Main learns which frame is which cluster. The cluster frame calls `cluster:set-frame-id` on start (`openlens/packages/core/src/renderer/frames/cluster-frame/init-cluster-frame/init-cluster-frame.ts:43`). Main stores `{frameId, processId}` per cluster (`openlens/packages/core/src/main/electron-app/runnables/setup-ipc-main-handlers/setup-ipc-main-handlers.ts:40`).
- The catalog is pushed from main to renderer whenever the registry changes, as one serialized list (`openlens/packages/core/src/main/catalog-sync-to-renderer/catalog-sync-to-renderer.injectable.ts:26`).
- Kubernetes data does **not** go over IPC. The renderer calls the API server itself through LensProxy (section 2.4).

### 1.4 Dependency injection: `@ogre-tools/injectable`

What it is:

- Every unit is an "injectable": `getInjectable({ id, instantiate(di), injectionToken?, lifecycle? })`. Example: the pod store (`openlens/packages/core/src/renderer/components/workloads-pods/store.injectable.ts:13`).
- Injection tokens are extension points. `di.injectMany(token)` collects every injectable registered for it. Sidebar items, routes, detail panels, list columns and startup runnables are all tokens.
- `lifecycleEnum.keyedSingleton` gives one instance per key. Lens keys per-cluster services by cluster ID: the auth proxy (`openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:179`), the connection (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:426`).
- `computedInjectMany` (MobX extension) makes the set of injectables reactive. Registering a new injectable at runtime updates the UI. The API manager uses it for CRD APIs (`openlens/packages/core/src/common/k8s-api/api-manager/manager.injectable.ts:23`).

How features are registered:

- OpenLens auto-registers every file named `*.injectable.ts(x)` with webpack `require.context` (`openlens/packages/core/src/main/register-lens-core.ts:15`, `openlens/packages/core/src/renderer/register-lens-core.ts:16`). The file-name matchers are defined in webpack (`openlens/open-lens/webpack/renderer.ts:85`, `openlens/packages/core/webpack/main.ts:69`). Core has 1,515 such files.
- Newer code is grouped as a `Feature` (`{ id, register(di), dependencies }`) (`openlens/packages/technical-features/feature-core/src/feature.ts:3`), registered with `registerFeature` (`openlens/open-lens/src/main/index.ts:30`).
- A resource view is four injectables: a route (path + `isEnabled`), a route component, a sidebar item, a store. For pods: `openlens/packages/core/src/common/front-end-routing/routes/cluster/workloads/pods/pods-route.injectable.ts:12`, `openlens/packages/core/src/renderer/components/workloads-pods/pods-route-component.injectable.ts:13`, `openlens/packages/core/src/renderer/components/workloads-pods/pods-sidebar-items.injectable.ts:16`, `openlens/packages/core/src/renderer/components/workloads-pods/store.injectable.ts:13`.
- Freelens drops `require.context`. A script generates explicit `register-injectables.ts` files (`freelens/scripts/generate-explicit-di-registration.mjs:4`), e.g. `freelens/packages/core/src/main/register-injectables.ts`. This was needed to leave webpack for Vite.

Why they use it (from code, not docs):

- Testability. Unit tests build a container, call `preventSideEffects()`, and override every injectable marked `causesSideEffects` with fakes from `*.global-override-for-injectable.ts` files (`openlens/packages/core/src/main/getDiForUnitTesting.ts:56`, `openlens/packages/core/src/main/getDiForUnitTesting.ts:69`). Core has 91 such override files.
- Open extension points without a central registry file.
- Per-cluster instances without passing the cluster everywhere.

Cost we saw:

- A module-level global container still exists for the extension API (`getLegacyGlobalDiForExtensionApi`, 32 call sites in core), e.g. `openlens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:77`. Two styles live side by side.
- Thousands of tiny files and string IDs. Navigation and "find the implementation" are hard.

---

## 2. Connecting to clusters

### 2.1 Kubeconfig discovery and sync

- Default sync source: `~/.kube` as a folder (`openlens/packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts:25`, `openlens/packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts:117`). Users can add more files or folders in Preferences.
- Lens also always syncs its own folder `<userData>/kubeconfigs`, where pasted kubeconfigs go (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/manager.ts:55`, `openlens/packages/core/src/common/app-paths/directory-for-kube-configs/directory-for-kube-configs.injectable.ts:16`). The add-cluster page writes that file directly from the renderer with `fs` (`openlens/packages/core/src/renderer/components/add-cluster/add-cluster.tsx:101`).
- The `KUBECONFIG` env var is not read for discovery. It is only set for child processes (`openlens/packages/core/src/main/shell-session/shell-session.ts:363`).
- Files are watched with chokidar, folder depth 0, with write-settle and atomic-write handling (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/watch-file-changes.injectable.ts:69`). Some file names are ignored by glob (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/watch-file-changes.injectable.ts:26`). Oversized files are skipped (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/diff-changed-kubeconfig.injectable.ts:36`).
- Each file is split into one entry per context. Removed contexts disconnect; new contexts become clusters (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts:45`).
- Cluster ID = `md5(filePath + ":" + contextName)` (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts:74`; same in Freelens, `freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts:85`). It is stable and predictable.
- Cluster preferences (name, icon, proxy, Prometheus, accessible namespaces) are kept in `lens-cluster-store.json` (`openlens/packages/core/src/features/cluster/storage/common/storage.injectable.ts:29`). Credentials are not copied there; the cluster points at the kubeconfig path and context (`openlens/packages/core/src/common/cluster/cluster.ts:23`, `openlens/packages/core/src/common/cluster/cluster.ts:28`).

### 2.2 The catalog

- Everything listed in the left catalog is a `CatalogEntity` with `apiVersion`, `kind`, `metadata`, `status`, `spec`, like a Kubernetes object (`openlens/packages/core/src/common/catalog/catalog-entity.ts:344`).
- A kubeconfig context becomes a `KubernetesCluster` entity, `entity.k8slens.dev/v1alpha1` (`openlens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:65`). `connect()` asks main to activate it (`openlens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:76`). `onRun` navigates to `/cluster/<id>` (`openlens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:92`).
- Categories (clusters, web links, general) are registered in a category registry (`openlens/packages/core/src/common/catalog/category-registry.ts`). Extensions can add categories and entity sources.
- Main owns the registry (`openlens/packages/core/src/main/catalog/entity-registry.ts`) and pushes it to the renderer (section 1.3).

### 2.3 Auth: the two-proxy chain

The renderer never sees cluster credentials. Every request crosses two local proxies.

```
renderer (cluster iframe)
  │  HTTPS to https://<clusterId>.lens.app:<P>/api-kube/...   (Lens self-signed cert, pinned)
  ▼
LensProxy (main process, 127.0.0.1:<P>)
  │  picks the cluster by Host subdomain, strips Authorization, strips /api-kube
  │  HTTPS to https://127.0.0.1:<Q>/<random prefix>/...       (per-cluster self-signed cert)
  ▼
kube-auth-proxy child (Go binary lens-k8s-proxy, one per cluster)
  │  loads the user's kubeconfig + context, runs exec plugins, client certs, tokens
  ▼
Kubernetes API server (TLS verified against the kubeconfig CA [inferred])
```

**LensProxy** (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts`):

- An HTTPS server on `127.0.0.1`, OS-picked port (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:76`, `openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:111`). It re-picks if the port is one Chromium refuses (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:59`, `openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:149`).
- Cluster lookup: by `Host` subdomain for frames, or by a `/<clusterId>/` path prefix for local tools (kubectl, helm, main) on `127.0.0.1` (`openlens/packages/core/src/main/lens-proxy/get-cluster-for-request.injectable.ts:22`, `openlens/packages/core/src/main/lens-proxy/get-cluster-for-request.injectable.ts:34`).
- `/api-kube/...` goes to the cluster's auth proxy with `http-proxy`. The incoming `Authorization` header is deleted (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:241`).
- Everything else goes to the local router: the renderer bundle and the `/api/...` routes for helm, metrics, port-forward and apply (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:253`, route files under `openlens/packages/core/src/main/routes/`).
- WebSocket / SPDY upgrades (exec, attach, port-forward streams) are piped raw over a TLS socket to the auth proxy (`openlens/packages/core/src/main/lens-proxy/proxy-functions/kube-api-upgrade-request.injectable.ts:26`). Upgrades to `/api?` are local shells instead (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:94`).
- Failed GETs are retried up to 20 times with growing delay (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:206`).

**kube-auth-proxy** (`openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts`):

- Started lazily, one per cluster (`openlens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:34`).
- Spawned with env vars only: `KUBECONFIG`, `KUBECONFIG_CONTEXT`, `API_PREFIX`, `PROXY_KEY`, `PROXY_CERT`; working dir = the kubeconfig's folder so relative paths resolve (`openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:77`). A per-cluster `HTTPS_PROXY` preference is passed through (`openlens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:40`).
- `API_PREFIX` is 8 random bytes in hex (`openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:54`). It works as a weak shared secret between LensProxy and the child.
- The port is read from the child's stdout line `starting to serve on ...` (`openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:31`, `openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:142`). This is the `kubectl proxy` message, so the binary is a thin wrapper around kubectl's proxy code [inferred].
- Its TLS cert is self-signed per API hostname (`openlens/packages/core/src/main/kube-auth-proxy/kube-auth-proxy-certificate.injectable.ts:11`). LensProxy trusts exactly that cert as CA and sends the real API host as `Host` (`openlens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:57`).
- Timeouts: 30 s for normal requests, 4 h for `watch=` or `follow=` requests (`openlens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:22`, `openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:44`).
- The binary is downloaded at build time from `github.com/lensapp/lens-k8s-proxy` releases, version 0.3.0 (`openlens/packages/ensure-binaries/src/index.ts:170`, `openlens/open-lens/package.json:38`). Its source is not in this repo.

**Exec auth plugins** (kubelogin, aws, gcloud, oidc-login):

- Lens itself never runs them. The Go child loads the kubeconfig with client-go, which runs `exec` plugins [inferred from the spawn env above]. This is why Lens uses a Go child and not `@kubernetes/client-node` for the data path.
- Freelens adds a guard: after an auth failure it backs off (1 min, then 5 min) and stops auto-retrying after 3 failures, because exec plugins may open a browser tab every try (`freelens/packages/core/src/main/cluster/cluster-connection.injectable.ts:76`, `freelens/packages/core/src/main/cluster/cluster-connection.injectable.ts:84`).

**Local tools (kubectl, helm, terminals)** get a generated "proxy kubeconfig":

- OpenLens writes `<temp>/kubeconfig-<clusterId>`, mode 0600. Server = `https://127.0.0.1:<P>/<clusterId>` (LensProxy), CA = the LensProxy cert, user = basic auth `lens` / `fake` (`openlens/packages/core/src/main/kubeconfig-manager/kubeconfig-manager.ts:96`, `openlens/packages/core/src/main/cluster/auth-proxy-url.injectable.ts:14`).
- Main's own client-go-style calls (RBAC checks, namespace list) also use this proxy kubeconfig (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:232`). Raw main requests go to `/<clusterId>/...` on LensProxy (`openlens/packages/core/src/main/k8s-request.injectable.ts:41`).

**Where secrets live**

| Secret | Where |
|---|---|
| Cluster credentials, tokens, client keys | The user's kubeconfig on disk (Lens reads, does not copy). Pasted configs: `<userData>/kubeconfigs/` (`openlens/packages/core/src/renderer/components/add-cluster/add-cluster.tsx:101`) |
| Short-lived exec tokens | In the Go child's memory [inferred] |
| LensProxy TLS key | Main memory only, new every launch (`openlens/packages/core/src/main/start-main-application/runnables/setup-lens-proxy-certificate.injectable.ts:17`) |
| Auth-proxy TLS key | Main memory, and passed to the child as an env var (`openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:83`) |
| Proxy kubeconfig | Temp file 0600 with fake creds (`openlens/packages/core/src/main/kubeconfig-manager/kubeconfig-manager.ts:129`) |
| Freelens extension secrets | Electron `safeStorage` (`freelens/packages/core/src/features/extension-credentials/main/extension-credentials-store.injectable.ts:27`) |

### 2.4 TLS and how the renderer reaches the API server

- The renderer trusts LensProxy two ways. Chromium: `setCertificateVerifyProc` accepts only a byte-exact match of the LensProxy cert (`openlens/packages/core/src/main/start-main-application/lens-window/application-window/session-certificate-verifier.injectable.ts:25`). Node: OpenLens renderer requests go through `node-fetch` with an `https.Agent` whose CA is that cert (`openlens/packages/core/src/common/k8s-api/create-kube-json-api.injectable.ts:27`, `openlens/packages/core/src/common/fetch/fetch.injectable.ts:6`).
- The renderer's API base is `https://127.0.0.1:<port>/api-kube` with a `Host` header of the frame's own host (`openlens/packages/core/src/renderer/k8s/api-base-server-address.injectable.ts:14`, `openlens/packages/core/src/renderer/k8s/api-kube.injectable.ts:26`). Setting `Host` by hand only works because the request is made by Node, not by the browser.
- Freelens switches the renderer to Chromium's own `fetch`. Requests go to the frame's own origin, so no `Host` header is needed (`freelens/packages/core/src/renderer/fetch/browser-fetch.injectable.ts:21`, `freelens/packages/core/src/renderer/k8s/api-kube.injectable.ts:26`). The code says undici cannot run in the renderer, and Freelens 1.x used node-fetch there [docs] (`freelens/packages/core/src/renderer/fetch/browser-fetch.injectable.ts:14`).
- Freelens serves LensProxy over HTTP/2 (`http2.createSecureServer`, `allowHTTP1`) because Chromium allows only six HTTP/1.1 connections per host and each open watch holds one (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:168`, `freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:174`). It raises the stream limit to 1000 (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:129`).
- System CAs: OpenLens injects OS CA stores at start (`openlens/packages/core/src/main/start-main-application/runnables/setup-system-ca.injectable.ts:15`). Freelens uses Node's `tls.getCACertificates("system")` (`freelens/packages/core/src/common/certificate/ca-certificates.injectable.ts:12`).

### 2.5 Connection lifecycle and permission detection

`ClusterConnection` (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts`):

- Connection status every 30 s via a version request; accessibility and metadata every 15 min (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:79`, `openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:84`).
- A 4xx on the version probe means "Invalid credentials"; a failed exec means "Failed to fetch credentials" (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:308`, `:336`).
- On accessibility refresh (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:230`):
  1. `isAdmin` = SelfSubjectAccessReview "create `*` in kube-system" (`:237`).
  2. `isGlobalWatchEnabled` = SSAR "watch `*`" cluster-wide (`:242`).
  3. Allowed namespaces = list namespaces; if forbidden, fall back to the context's namespace and tell the UI (`:364`). The user can also type a fixed list ("accessible namespaces").
  4. Known resources = API discovery: `/api` and `/apis`, then each group/version, 5 at a time, with backoff (`openlens/packages/core/src/main/cluster/request-api-resources.injectable.ts:34`, `openlens/packages/core/src/main/cluster/request-non-core-api-versions.injectable.ts:19`).
  5. Resources to show = for each allowed namespace, a SelfSubjectRulesReview; a resource is shown if any namespace grants `list` on it (`openlens/packages/core/src/main/cluster/cluster-connection.injectable.ts:389`, `openlens/packages/core/src/common/cluster/create-request-namespace-list-permissions.injectable.ts:28`). An incomplete review allows everything (`:34`).
- The result is stored on the `Cluster` object as observables (`openlens/packages/core/src/common/cluster/cluster.ts:53`, `:58`, `:73`, `:83`, `:88`) and synced to the frame.
- In the frame, each route's `isEnabled` is `resourcesToShow.has("<group>/<resource>")` (`openlens/packages/core/src/renderer/cluster-frame-context/should-show-resource.injectable.ts:18`). Sidebar items hide with the route (`openlens/packages/core/src/renderer/components/workloads-pods/pods-sidebar-items.injectable.ts:24`).

---

## 3. The Kubernetes data layer

### 3.1 Layers

| Layer | Role | File |
|---|---|---|
| `JsonApi` / `KubeJsonApi` | fetch wrapper, JSON, errors | `openlens/packages/utility-features/json-api/`, `openlens/packages/utility-features/kube-api/src/kube-json-api.ts` |
| `KubeApi<T>` | One resource type: URLs, list/get/create/update/patch/delete, scale, evict, watch | `openlens/packages/utility-features/kube-api/src/kube-api.ts:282` |
| `KubeObject` | Typed wrapper around one object; static `kind`, `namespaced`, `apiBase`; helpers | `openlens/packages/kube-object/src/kube-object.ts:32` |
| 45 kind classes (`Pod`, `Deployment`, ...) | Kind-specific getters | `openlens/packages/kube-object/src/specifics/` |
| `KubeObjectStore<T>` | MobX list of items for one `KubeApi`, load + watch + buffer | `openlens/packages/core/src/common/k8s-api/kube-object.store.ts` |
| `KubeWatchApi` | Ref-counted subscription of stores to watches, namespace-aware | `openlens/packages/core/src/renderer/kube-watch-api/kube-watch-api.ts:93` |
| `ApiManager` | Lookup of APIs and stores by apiBase or kind; CRD stores on demand | `openlens/packages/core/src/common/k8s-api/api-manager/api-manager.ts:35` |

### 3.2 KubeApi

- URLs come from `apiBase` plus namespace and name (`openlens/packages/utility-features/kube-api/src/kube-api.ts:454`, `:468`).
- Optional preferred-version check: before the first call it asks the server which group version is preferred and can fall back to other bases (`openlens/packages/utility-features/kube-api/src/kube-api.ts:371`, `:411`). Used for kinds that moved groups (HPA, Ingress).
- Patch types: merge, JSON patch, strategic merge; strategic is the default (`openlens/packages/utility-features/kube-api/src/kube-api.ts:219`, `:694`).
- The last `resourceVersion` per namespace is kept from list responses and watch events (`openlens/packages/utility-features/kube-api/src/kube-api.ts:306`, `:512`, `:884`).

### 3.3 List + watch

- `watch()` is a plain HTTP GET with `?watch=1&resourceVersion=<last>` (`openlens/packages/utility-features/kube-api/src/kube-api.ts:737`). The body is split by line and each line parsed as JSON (`openlens/packages/utility-features/kube-api/src/kube-api.ts:844`).
- Each watch asks the server for `timeoutSeconds=600` (`openlens/packages/utility-features/kube-api/src/kube-api.ts:752`). If the server has not closed it by 660 s, the client aborts and restarts it, to survive dead load balancers (`openlens/packages/utility-features/kube-api/src/kube-api.ts:805`). On end/close/error it re-watches after 1 s (`:837`).
- In the store: 410 Gone means relist then rewatch; 401/404 stop; other errors retry after 5 s (`openlens/packages/core/src/common/k8s-api/kube-object.store.ts:461`, `:469`).
- Events are buffered and applied at most once a second (`openlens/packages/core/src/common/k8s-api/kube-object.store.ts:408`, `:410`). ADDED/MODIFIED replace by `uid`; DELETED removes (`:494`). The store keeps at most 50,000 items (`:107`, `:541`).
- No watch bookmarks, no `sendInitialEvents`, no paginated lists (`continue`) in either fork. `limit` is a per-store option only (`openlens/packages/core/src/common/k8s-api/kube-object.store.ts:130`; same in Freelens, `freelens/packages/core/src/common/k8s-api/kube-object.store.ts:138`).

### 3.4 How many watches

- One watch per store per namespace, or one cluster-wide watch per store when all namespaces are selected and the user may watch `*` cluster-wide (`openlens/packages/core/src/common/k8s-api/kube-object.store.ts:416`, `:425`).
- Listing follows the same rule: "all selected" lists cluster-wide; otherwise one list per namespace in parallel (`openlens/packages/core/src/common/k8s-api/kube-object.store.ts:186`, `:213`).
- A store is watched only while a view uses it. `KubeWatchApi` counts subscribers per store and stops the watch at zero (`openlens/packages/core/src/renderer/kube-watch-api/kube-watch-api.ts:27`, `:101`, `:154`).
- A list view subscribes its main store plus "dependent stores" when it mounts (`openlens/packages/core/src/renderer/components/kube-object-list-layout/kube-object-list-layout.tsx:110`).
- So with N selected namespaces (not all) and M visible kinds there are N x M open streams. Over HTTP/1.1 that hits Chromium's per-host limit; this is the reason for Freelens's HTTP/2 change (section 2.4).

### 3.5 Namespace selection

- The selected namespaces are stored per cluster (`openlens/packages/core/src/renderer/cluster-frame-context/for-namespaced-resources.injectable.ts:18`).
- "All namespaces" comes from, in order: the user's accessible-namespaces list, the namespace store, the namespaces main resolved (`openlens/packages/core/src/renderer/cluster-frame-context/for-namespaced-resources.injectable.ts:23`).
- An empty selection means all (`openlens/packages/core/src/renderer/cluster-frame-context/for-namespaced-resources.injectable.ts:37`).
- Changing the selection aborts and restarts the watches of every subscribed namespaced store, except when "all" stays "all" (`openlens/packages/core/src/renderer/kube-watch-api/kube-watch-api.ts:130`).

### 3.6 CRDs

- The CRD store is watched in every cluster frame. A reaction turns each CRD into a registered injectable that builds a `KubeApi` around an anonymous `KubeObject` subclass with the CRD's kind, scope and apiBase (`openlens/packages/core/src/renderer/before-frame-starts/runnables/setup-auto-crd-api-creations.injectable.ts:24`, `:38`).
- `ApiManager.getStore` creates a generic `CustomResourceStore` the first time a CRD's list is opened (`openlens/packages/core/src/common/k8s-api/api-manager/api-manager.ts:166`).
- The generic CR list adds a column per `additionalPrinterColumns` entry with priority 0, read by JSONPath; the rest show in details (`openlens/packages/core/src/renderer/components/custom-resources/view.tsx:61`, `openlens/packages/core/src/renderer/components/custom-resources/details.tsx:68`).

### 3.7 Generic list and detail views

- List: `KubeObjectListLayout` wraps `ItemListLayout` (table, search, sort, column toggles, selection, bulk delete). It subscribes stores on mount (`openlens/packages/core/src/renderer/components/kube-object-list-layout/kube-object-list-layout.tsx:110`, `:190`). Extra columns come from a token (`:249`).
- Details: a drawer that injects every `kubeObjectDetailItemInjectionToken` item and shows those whose `enabled` matches the current object's kind and apiVersion (`openlens/packages/core/src/renderer/components/kube-object-details/kube-object-detail-items/kube-object-detail-item-injection-token.ts:16`; example `openlens/packages/core/src/renderer/components/kube-object-details/kube-object-detail-items/implementations/horizontal-pod-autoscaler-detail-item.injectable.ts:20`).
- Context menus per kind are also a token (`openlens/packages/core/src/renderer/components/kube-object-menu/kube-object-menu-item-injection-token.ts`).
- Each built-in kind still has a hand-written list and details component. That is the bulk of the code (section 7).

---

## 5. What Freelens changed since 2023

Freelens history in our clone is shallow (one commit), so this is from the current tree, not from the log.

### 5.1 Runtime and tooling

| Item | OpenLens @ f1a960fd | Freelens @ 2547f555 |
|---|---|---|
| Electron | ^22.3.10 (`openlens/open-lens/package.json:334`) | 44.10.1 (`freelens/pnpm-workspace.yaml:56`) |
| Node (dev) | >=16 <17 (`openlens/open-lens/package.json:46`) | 24.22.1 via mise (`freelens/mise.toml:3`), engines >=24 (`freelens/package.json:86`) |
| React | ^17 (`openlens/open-lens/package.json:269`) | 19.3.1 (`freelens/pnpm-workspace.yaml:11`) |
| MobX | ^6.9 (`openlens/open-lens/package.json:255`) | 7.0.6 (`freelens/pnpm-workspace.yaml:16`) |
| TypeScript | ^4.9.5 (`openlens/open-lens/package.json:353`) | 7.0.2 (`freelens/pnpm-workspace.yaml:19`) |
| ogre-tools DI | ^17.2.0 (`openlens/open-lens/package.json:223`) | 27.0.0 (`freelens/pnpm-workspace.yaml:21`) |
| Bundler | webpack 5 (`openlens/open-lens/package.json:355`) | electron-vite + Vite (`freelens/freelens/package.json:23`, `freelens/pnpm-workspace.yaml:46`) |
| Monorepo | npm workspaces + lerna + nx (`openlens/lerna.json:3`) | pnpm workspaces + catalog, turbo (`freelens/package.json:27`, `freelens/pnpm-workspace.yaml:53`) |
| Tests | jest (`openlens/open-lens/package.json:339`) | vitest (`freelens/package.json:61`, `freelens/vitest.config.ts`) |
| Lint/format | eslint (`openlens/packages/infrastructure/eslint-config`) | biome, trunk, knip (`freelens/package.json:23`, `freelens/package.json:53`, `freelens/package.json:49`) |
| Module format | CommonJS | ESM (`freelens/freelens/package.json:16`) |
| Terminal | xterm 4 (`openlens/open-lens/package.json:297`), node-pty 0.10.1 (`:262`) | @xterm/xterm 6, node-pty 1.2 beta (`freelens/pnpm-workspace.yaml:89`, `:116`) |
| HTTP | node-fetch, http-proxy | undici, http-proxy-3 (`freelens/freelens/package.json:100`, `:87`) |
| Bundled kubectl / helm | 1.23.3 / 3.11.0 (`openlens/open-lens/package.json:39`) | 1.37.2 / 4.3.1 (`freelens/freelens/package.json:57`) |
| k8s proxy binary | lens-k8s-proxy 0.3.0 | freelens-k8s-proxy 2.0.0 (`freelens/freelens/package.json:60`, `freelens/packages/ensure-binaries/src/artifacts.ts:99`) |

- node-pty is now the only native module and ships N-API prebuilds, so no C++ toolchain is needed [docs] (`freelens/DEVELOPMENT.md:9`).

### 5.2 Security fixes that matter

1. **LensProxy had no authentication. Freelens added a token.** In OpenLens, any local process that finds the port and sends `Host: <clusterId>.lens.app` (or uses `/<clusterId>/` on 127.0.0.1) reaches the cluster with the user's credentials, and can call the local `/api` routes (helm install, apply, port-forward). The only checks are cluster lookup and a deleted `Authorization` header (`openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:238`). The cluster ID is an md5 of path and context, so it is guessable (`openlens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts:74`). Freelens:
   - A 32-byte random token per run, in memory only (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy-token.injectable.ts:36`).
   - Required on `/api` and `/api-kube` and on all upgrades (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:89`, `:214`, `:468`). Compared in constant time over SHA-256 hashes (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy-token.ts:79`).
   - Frames carry it as a `Secure; HttpOnly; SameSite=Strict` cookie set on the session before load (`freelens/packages/core/src/main/start-main-application/lens-window/application-window/set-freelens-proxy-token-cookie.injectable.ts:32`).
   - kubectl, helm and terminals carry it as `Authorization: Bearer`. The proxy kubeconfig has no secret: its user is an `exec` plugin, `freelens-k8s-proxy credential`, which reads `FREELENS_PROXY_TOKEN` from the environment Freelens gives the tool (`freelens/packages/core/src/main/kubeconfig-manager/kubeconfig-manager.ts:184`, `freelens/packages/core/src/main/freelens-proxy/with-freelens-proxy-credential-env.injectable.ts:38`).
   - Host and Origin allow-lists sit behind the token (`freelens/packages/core/src/main/freelens-proxy/allowed-request.ts:13`, `:19`).
   - The token and cookie are stripped before forwarding (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy-token.ts:67`, `freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:476`).
2. **No proxy for disconnected clusters.** A request for a cluster the user has not connected gets 503 and starts nothing (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:486`).
3. **API responses are `no-store`** (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:458`).
4. **HTTP/2 rapid-reset (CVE-2023-44487)** limits are tuned in the new HTTP/2 server [docs] (`freelens/packages/core/src/main/freelens-proxy/freelens-proxy.ts:133`).
5. **Exec-plugin retry storm** fixed by the auth backoff (section 2.3).

Not changed: `nodeIntegration: true`, `nodeIntegrationInSubFrames: true`, `contextIsolation: false` (`freelens/packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts:92`).

### 5.3 Features removed or added (by `features/` folder)

| Change | Evidence |
|---|---|
| Removed: in-app auto-update | `openlens/packages/core/src/features/application-update/` has no Freelens counterpart; no `autoUpdater` use in `freelens/packages/core/src` |
| Removed: telemetry | `openlens/packages/core/src/features/telemetry/` gone |
| Moved: tray, certificate authorities | `freelens/packages/core/src/main/tray/`, `freelens/packages/core/src/common/certificate/ca-certificates.injectable.ts:12` |
| Added: favorites | `freelens/packages/core/src/features/favorites/` |
| Added: standalone terminal | `freelens/packages/core/src/features/standalone-terminal/` |
| Added: TLS certificate viewer for Secrets | `freelens/packages/core/src/features/secret-certificates/renderer/secret-certificates.tsx` |
| Added: extension credentials in OS keychain | `freelens/packages/core/src/features/extension-credentials/main/extension-credentials-store.ts:14` |
| Added: licenses page | `freelens/packages/core/src/features/licenses/` |
| Added: newer kinds (e.g. MutatingAdmissionPolicy in the last commit) | `git log -1` of `freelens/` |

### 5.4 Extension system state

- Freelens v2 breaks the v1 extension API on purpose; extensions must declare `engines.freelens: ^2.0.0` or are refused at discovery [docs] (`freelens/docs/extensions/migrating-from-v1.md:3`, `:51`).
- Extensions are ESM. Renderer entries are loaded by URL from a privileged `freelens-extension://extensions/<name>/...` scheme instead of `require()` [docs] (`freelens/docs/extensions/migrating-from-v1.md:57`, `freelens/packages/core/src/features/extensions/loader/common/scheme.ts:13`).
- One origin for all extensions, because with `contextIsolation: false` per-extension isolation is not possible [docs] (`freelens/packages/core/src/features/extensions/loader/common/scheme.ts:16`).
- Calls to `require()` from extension renderer code log a deprecation warning, "so the dependency does not settle in unnoticed before the renderer is isolated". So context isolation is planned, not done [docs] (`freelens/packages/core/src/features/extensions/loader/renderer/require-deprecation-warning.ts:11`, `:15`).
- The extension API package is `@freelensapp/extensions` (`freelens/packages/extensions/`). Details are in `lens-features.md`.

---

## 6. Security posture

### 6.1 What the renderer can do

| Setting | OpenLens | Freelens | Effect |
|---|---|---|---|
| `nodeIntegration` | true | true | Renderer code can `require("fs")`, `child_process` |
| `nodeIntegrationInSubFrames` | true | true | Every cluster iframe has Node too |
| `contextIsolation` | false | false | Page and preload share globals; no boundary |
| `sandbox` | not set (off with Node integration) | same | No OS sandbox for renderers |
| `webSecurity` | not set (default on) | same | Same-origin policy stays on |
| Preload script | none | none | No `contextBridge` API |

Sources: `openlens/packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts:87`, `freelens/packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts:92`.

So the renderer is as privileged as main. Examples in code:

- The renderer writes kubeconfig files with `fs` (`openlens/packages/core/src/renderer/components/add-cluster/add-cluster.tsx:101`).
- The renderer makes Node HTTPS requests with a custom CA (`openlens/packages/core/src/common/k8s-api/create-kube-json-api.injectable.ts:28`).
- Extensions are loaded with plain `require(absolutePath)` in main and in every frame, with full Node access (`openlens/packages/core/src/extensions/extension-loader/extension-loader.ts:371`).

Any XSS in a cluster view (a crafted annotation, a Helm README, a CRD field) is code execution as the user, with their cluster credentials one request away.

### 6.2 Other controls

| Control | Status | Where |
|---|---|---|
| CSP | `script-src 'unsafe-eval' 'self'; frame-src https://*.lens.app:*/; img-src * data:`. Sent on non-API responses only. `unsafe-eval` is on (Monaco/webpack) | `openlens/open-lens/package.json:42`, `openlens/packages/core/src/main/lens-proxy/lens-proxy.ts:253`; Freelens adds `freelens-extension:` (`freelens/freelens/package.json:59`) |
| New windows | Denied; URL opened in the system browser | `openlens/packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts:143` |
| Navigation guard (`will-navigate`) | None found in either fork | grep of `main/` in both |
| Permission handler (`setPermissionRequestHandler`) | None found | same |
| Local TLS pinning | Exact-cert match for LensProxy | `openlens/packages/core/src/main/start-main-application/lens-window/application-window/session-certificate-verifier.injectable.ts:28` |
| Shell WebSocket auth | One-time 128-byte token per tab from IPC, compared in constant time | `openlens/packages/core/src/main/lens-proxy/proxy-functions/shell-request-authenticator/shell-request-authenticator.ts:17`, `:44` |
| Proxy auth | None (OpenLens); token + cookie (Freelens) | section 5.2 |
| Child secrets | Auth-proxy TLS private key passed in env | `openlens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:83` |

### 6.3 Copy or avoid

Copy:

- Keep credentials out of the renderer. Only a local proxy holds them.
- Use client-go (a Go sidecar) for auth, so every kubeconfig auth method works, exec plugins included.
- Local TLS with an in-memory cert, pinned by exact bytes.
- Freelens's per-run proxy token, carried as an HttpOnly SameSite cookie for frames and as an exec-credential env var for CLI tools. No secret in any file.
- One-time tokens for shell sockets.
- Auth backoff for exec plugins.

Avoid:

- `nodeIntegration` / `contextIsolation: false` / no sandbox. Freelens is still trying to get out of it three years later.
- Renderer-side `fs` and `require()` of extensions.
- A guessable cluster ID used as a routing key.
- Secrets in child-process environment where a file descriptor or pipe would do.
- `unsafe-eval` in CSP.
- No `will-navigate` guard.

---

## 7. Size

Counted with `find ... -name '*.ts' -o -name '*.tsx' -o -name '*.scss' -o -name '*.css' | xargs cat | wc -l`, skipping `node_modules`, `dist`, `build`, `static` and snapshots. "Non-test" also drops `*.test.*`, `__tests__`, `test-utils`, `test-env`, integration and fixture code. Lines include comments and blanks.

### 7.1 Totals

| Tree | Files | All lines | Non-test lines |
|---|---|---|---|
| OpenLens `packages/` | 3,454 | 194,048 | 143,912 |
| OpenLens `open-lens/` (app shell) | 17 | 1,259 | 593 |
| Freelens `packages/` | 4,463 | 280,799 | 196,151 |
| Freelens `freelens/` (app shell) | 18 | 1,699 | 802 |

The Go proxy binaries are outside both repos and not counted.

### 7.2 Core package by area

| Area | OpenLens all / non-test | Freelens all / non-test |
|---|---|---|
| `core/src/renderer` | 87,813 / 76,211 | 122,093 / 98,216 |
| of which `renderer/components` | 79,672 / 68,893 | 110,139 / 88,115 |
| `core/src/features` | 33,974 / 14,191 | 43,053 / 21,214 |
| `core/src/main` | 18,652 / 14,724 | 36,848 / 23,306 |
| `core/src/common` | 17,758 / 12,766 | 25,108 / 18,320 |
| `core/src/extensions` | 4,145 / 3,529 | 12,461 / 6,640 |
| **core total** | **163,808 / ~122,880** | **240,582 / ~168,573** |

### 7.3 Other packages (all lines, OpenLens -> Freelens)

| Package | OpenLens | Freelens |
|---|---|---|
| kube-object (45 kind classes) | 7,148 | 8,748 |
| utility-features/kube-api | 3,720 | 4,370 |
| utility-features/kube-api-specifics | 1,348 | 2,217 |
| utility-features/utilities | 3,886 | 5,782 |
| technical-features/messaging | 3,099 | 3,380 |
| technical-features/prometheus | 794 | 924 |
| technical-features/application | 592 | 524 |
| technical-features/feature-core | 591 | 589 |
| routing | 90 | 2,596 |
| ensure-binaries | 328 | 1,665 |
| ui-components (8 packages) | 3,399 | 3,596 |
| all other packages | < 1,200 each | < 1,200 each |

### 7.4 Largest renderer component folders (OpenLens, non-test)

| Folder | Lines |
|---|---|
| `dock/` (terminal, logs, editor, create resource, install chart) | 6,398 |
| `workloads-pods/` | 4,494 |
| `user-management/` (RBAC views) | 3,359 |
| `layout/` | 2,452 |
| `catalog/` | 2,387 |
| `helm-releases/` | 1,927 |
| `kube-object-details/` | 1,926 |
| `namespaces/` | 1,739 |
| `extensions/` | 1,664 |
| `item-object-list/` + `table/` | 2,299 |

There are 116 component folders in `openlens/packages/core/src/renderer/components/`.

### 7.5 What this means for a rebuild

- OpenLens is about 144k non-test lines; Freelens about 196k. Most of it is per-kind UI (lists, details, menus) and DI wiring.
- The hard core is small: the proxy chain (~1.5k lines in OpenLens main), the data layer (KubeApi + store + watch API, ~2.5k), discovery and RBAC detection (~1k). The auth work itself is done by a Go binary built on client-go.
- A generic list/detail driven by discovery and `additionalPrinterColumns`-style column specs could replace much of the 69k lines of per-kind components. Hand-written views are only needed for the high-value kinds (pods, nodes, deployments, events, RBAC).

---

## What Landlens takes

- **Credentials stay in a sidecar.** One Go process (client-go) per connected cluster, or one process serving all clusters, so kubeconfig exec plugins, OIDC, client certs and cloud auth all work. Started lazily; never started for a disconnected cluster.
- **One local HTTPS front door with a per-run token from day one.** Pinned in-memory cert; token as an HttpOnly SameSite=Strict cookie for the UI and as an exec-credential env var for kubectl/helm/terminals; no secret in any generated kubeconfig. Host and Origin checks behind it.
- **HTTP/2 to the UI**, so many watches share one connection.
- **A random, unguessable cluster handle** for routing, not an md5 of path and context.
- **Secure Electron defaults:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a small typed preload bridge, a strict CSP without `unsafe-eval`, `will-navigate` and permission handlers. No Node in the UI. Extensions do not get Node in the UI either.
- **Keep the per-cluster isolation idea, not the iframe hack.** One logical "cluster session" per cluster (own stores, own watches, torn down on close); pick iframes or one SPA with scoped stores on purpose, with a real boundary.
- **Keep the RBAC flow:** SSAR for admin and cluster-wide watch, SSRR per namespace for `list`, discovery for known resources; hide what the user cannot list. Add backoff for exec-plugin failures from the start.
- **Keep the data-layer shape:** typed API per kind, MobX-like store, ref-counted subscriptions, buffered event apply, 410 relist. Add what both forks lack: paginated lists, watch bookmarks, `sendInitialEvents` where supported, and informer-style resync.
- **Generic first:** discovery-driven lists and details for every kind (including CRDs via printer columns); hand-write only the views that earn it.
- **DI without the cost:** if we use a container, register explicitly (as Freelens now does), no `require.context` magic and no global fallback container. Keep the test-override idea for side effects.
- **Modern toolchain:** Vite/electron-vite, ESM, pnpm, vitest, biome. Freelens had to migrate to all of these; we start there.
