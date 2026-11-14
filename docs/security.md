# Security

Landlens will run an AI agent next to your cluster credentials, so its baseline is stricter than the Lens forks it
was studied from. Each item says how it is checked.

## The renderer

| Rule | How it's checked |
|---|---|
| `sandbox`, `contextIsolation`, no `nodeIntegration` (also not in subframes or workers), `webSecurity`, no `<webview>` | `secureWebPreferences` in `apps/desktop/src/main/security.ts`; the e2e test proves `require` and `process` are undefined in the page |
| The page reaches main only through `window.landlens` (`invoke`, `on`) and only for listed channels | preload; e2e test calls an unlisted channel; unit test keeps the preload list equal to the contract |
| Main answers only our own page, and validates every request with zod | `apps/desktop/src/main/ipc.ts` |
| CSP: `script-src 'self'`, no `unsafe-eval`, `connect-src 'self'`, `object-src 'none'` (dev adds the Vite server) | `CSP_PROD` in `security.ts` |
| No navigation away, no new windows (https links open in your browser), no permissions, no webviews | `hardenContents`, `hardenSession` |
| Secret values never reach the renderer: main replaces them with their size and drops `last-applied-configuration` | `withoutSecretValues`, unit test; e2e test opens a Secret's YAML |

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
| The sidecar listens on 127.0.0.1 and answers only Landlens's per-process secret (constant-time compare); the secret is removed from its environment before client-go can start exec plugins | Go tests |
| The caller's `Authorization`, cookies and the secret are never forwarded to the API server | Go test |
| client-go sends credentials only to TLS servers | Go test (plain HTTP sends none) |
| The sidecar exits when Landlens's end of its stdin closes | checked live |
| Cluster handles are random per connection, not `md5(path:context)` as in OpenLens | `ClusterManager.connect` |

## The front door and tokens

| Rule | How it's checked |
|---|---|
| TLS on 127.0.0.1 with a fresh in-memory certificate, pinned in the tool kubeconfig | Go test (verifies for 127.0.0.1); integration test with real kubectl |
| Every request needs a token Landlens issued; tokens are compared by hash in constant time and revocable | unit tests |
| A read-only token can't write (including dry runs), can't read Secrets, can't exec, attach, port-forward or proxy, and stays in its namespaces | unit tests for the policy and the front door; integration test: the agent-style kubectl's `delete pod` and `get secrets` are refused before the cluster sees them |
| Paths that could be read two ways are refused | unit tests |
| Without `LANDLENS_TOKEN`, tools fail to authenticate | integration test |
