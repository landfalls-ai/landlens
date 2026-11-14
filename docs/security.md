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
| CSP: `script-src 'self'`, no `unsafe-eval`, `connect-src 'self'`, `object-src 'none'` (dev adds the Vite server). A page loaded from `file://` gets no response headers, so the build also writes it as a `<meta>` tag | `apps/desktop/src/main/csp.ts`; e2e test: an injected inline script and a string timer are both blocked and reported as violations |
| No navigation away, no new windows (https links open in your browser), no permissions, no webviews | `hardenContents`, `hardenSession` |
| Secret values never reach the renderer: main replaces them with their size and drops `last-applied-configuration`, for a Secret, for every item of a list, and for anything read from the `secrets` resource whatever its `kind` says | `withoutSecretValues`, unit tests; e2e test opens a Secret's YAML |
| Open watches are capped (500), a watcher that failed for good is replaced rather than kept, and a cluster's watches stop when its sidecar exits | `WatchHub`, unit tests |

Freelens 2.0 for comparison: `nodeIntegration` on, `contextIsolation` off, no sandbox, no preload, CSP with
`unsafe-eval` (`study/freelens-app/app-map-windows.json`).

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
| TLS on 127.0.0.1 with a fresh in-memory certificate, pinned in the tool kubeconfig. It is a leaf (not a CA), so it can sign nothing else | Go test (verifies for 127.0.0.1, asserts not a CA); integration test with real kubectl |
| Every request needs a token Landlens issued; tokens are compared by hash in constant time and revocable | unit tests |
| A read-only token can't write (including dry runs), can't read Secrets, can't exec, attach, port-forward or proxy, and stays in its namespaces | unit tests for the policy and the front door; integration test: the agent-style kubectl's `delete pod` and `get secrets` are refused before the cluster sees them |
| Paths that could be read two ways are refused: empty or dot segments, any `%`, backslashes, `#`, spaces, control characters | unit tests |
| Impersonation (`kubectl --as`) is refused for every token, not silently dropped | unit test |
| A read-only token may GET only version, discovery, OpenAPI and health among non-resource paths; never `/metrics`, `/logs` (node log files) or `/debug` | unit tests |
| A namespace-limited token's all-namespace reads use the cluster's discovery for scope; a kind it can't place is refused | unit tests |
| Every request is audited with the cluster's answer, upgrades (exec, attach) included | unit tests |
| Without `LANDLENS_TOKEN`, tools fail to authenticate | integration test |

## What this doesn't stop

Landlens runs as you. Another process running as your user can read your kubeconfig directly, and could read
Landlens's memory with a debugger if macOS lets it. The sidecar secret and the front door keep a same-user process
from borrowing Landlens's open connections without such access; they don't make a compromised user account safe.
The agent (wave 2) runs its tools in the Claude Agent SDK sandbox with your kubeconfig and credential folders
unreadable, so its kubectl can only use the front door.

Secret material outside Secrets (a token in a CRD's spec, a password in a ConfigMap) is shown as the cluster returns
it in the IDE. The agent's tools redact common secret patterns ([redact.ts](../packages/kube-mcp/src/redact.ts)).

The review that drove this list: a Fable security review of wave 1, 14 November 2026 ([history.md](history.md)).
