# Development

## Setup

Node 22.12 or later, pnpm 10, Go 1.24 or later, kubectl, and the OrbStack Kubernetes cluster (`--context orbstack`).

```bash
pnpm install
pnpm build:sidecar   # sidecar/kube-proxy/bin/landlens-kube-proxy
pnpm dev             # builds the sidecar, then runs the app with electron-vite (hot reload)
```

Landlens reads your kubeconfig (`KUBECONFIG`, else `~/.kube/config`). During development point it only at the local
OrbStack cluster (`CLAUDE.md`, "Local only").

## Tests

```bash
pnpm typecheck
pnpm test                                     # unit tests: contracts, kube, desktop, and the Go sidecar
pnpm test:integration                         # LANDLENS_INTEGRATION=orbstack: sidecar, discovery, watches, the front door with real kubectl
pnpm --filter @landlens/desktop test:e2e      # builds the app, launches it with Playwright, walks the wave-1 path on OrbStack
pnpm --filter @landlens/desktop check:fuses   # the packaged app's Electron fuses take
```

`LANDLENS_SHOTS=<folder>` makes the e2e test save screenshots. Tests against a cluster skip unless
`LANDLENS_INTEGRATION` names it (`orbstack`). They read every namespace and write nothing: the only write they try
is deleting a pod that doesn't exist in `landlens-dev`.

## Where things start

See [architecture.md](architecture.md), "Code map". New IPC: add the channel and its schema to
`packages/contracts/src/index.ts`, the handler to `apps/desktop/src/main/ipc.ts`, and the name to the preload's list
(a unit test keeps them equal).
