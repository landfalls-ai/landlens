# Development

## Setup

Node 22.12 or later, pnpm 10, Go 1.24 or later, kubectl, and the OrbStack Kubernetes cluster (`--context orbstack`).
The agent needs Claude Code logged in on this machine (`claude` once in a terminal) and `node` on your login shell's
PATH.

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
pnpm test:integration                         # LANDLENS_INTEGRATION=orbstack: sidecar, discovery, watches, the front door with real kubectl, the MCP tools
pnpm --filter @landlens/desktop test:e2e      # builds the app, launches it with Playwright, walks the wave-1 path on OrbStack

# With your own Claude Code (uses your login and usage):
LANDLENS_INTEGRATION=orbstack,claude pnpm --filter @landlens/acp-host test:integration   # the fence, live
LANDLENS_INTEGRATION=orbstack,claude pnpm --filter @landlens/desktop test:e2e            # plus "why is this pod crashlooping?" in the dock
pnpm --filter @landlens/desktop check:fuses   # the packaged app's Electron fuses take
```

`LANDLENS_SHOTS=<folder>` makes the e2e test save screenshots (every screen in dark, the Overview and a failing pod in light, and at 1024×700); `LANDLENS_LOGS=<folder>` makes the fence test save the
session's updates and the front door's audit. Tests against a cluster skip unless `LANDLENS_INTEGRATION` names it:
`orbstack` for the cluster, `claude` as well for tests that run Claude Code. They read every namespace and write
nothing: the only writes they try (deleting a pod in `landlens-dev`) must be refused.

The agent tests need the scenario workload: `kubectl --context orbstack apply -f deploy/scenarios/crashloop.yaml`
(namespace `landlens-dev`; delete the namespace to remove it).

## Where things start

See [architecture.md](architecture.md), "Code map". New IPC: add the channel and its schema to
`packages/contracts/src/index.ts`, the handler to `apps/desktop/src/main/ipc.ts`, and the name to the preload's list
(a unit test keeps them equal).
