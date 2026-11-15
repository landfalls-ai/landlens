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

Graphs: `LANDLENS_INTEGRATION=orbstack,clickland` adds the live Clickland tests: `pnpm --filter @landlens/metrics
test:integration` reads real series for `landlens-dev`, and the e2e test connects Clickland through its dialog and
screenshots the Usage card and a pod's Metrics tab in dark and light. They need Clickland's API with metric filters at
`LANDLENS_CLICKLAND_URL` (default `http://127.0.0.1:4710`) and its development bootstrap key (`CLICKLAND_BOOTSTRAP_KEY`,
default the dev one), which they use only to make a read-scoped key and revoke it afterwards; and
`deploy/scenarios/metrics.yaml` running for a few minutes, so `catalog-api` has samples. For the app itself, make a
read key once and paste it into Connect Clickland ([metrics.md](metrics.md), "Setup"). The e2e test runs the app with
its own profile (`LANDLENS_USER_DATA`, development only), so it never touches your settings.

The doctor ([doctor.md](doctor.md)): `node deploy/scenarios/doctor/up.mjs` starts one broken workload per problem
class in `landlens-dev` (and `--down` removes them); `LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/kube
test:integration` starts them itself and waits up to 4 minutes for each problem, since pending and not-ready count
only after 2.

The agent tests need the scenario workload: `kubectl --context orbstack apply -f deploy/scenarios/crashloop.yaml`
(namespace `landlens-dev`; delete the namespace to remove it). The graphs use `deploy/scenarios/metrics.yaml` too: a
healthy two-replica `catalog-api` with requests, limits and an uneven load.

MCP ([mcp.md](mcp.md)): `pnpm test` runs `@landlens/mcp-gateway`'s unit tests (a fake remote server over HTTP, the
built-in server in memory). The e2e test opens the MCP page, previews `cluster_overview`'s view and probes its sandbox
(with `orbstack`); adds Clickland's MCP server with its own read key and shows Clickland's view (with `clickland`); and
asks the agent to call `cluster_overview` and `describe` and checks both views inline in the dock (with `claude`).

Connections ([connections.md](connections.md)): `pnpm test` runs `@landlens/connections`'s unit tests against
`packages/connections/test/fake-provider.ts`, a loopback server that plays GitHub or Linear (MCP, OAuth, the device
flow, `/user`, `/graphql`) and records every request; no test reaches GitHub or Linear. An unpackaged build reads:

| Variable | What |
|---|---|
| `LANDLENS_GITHUB_ENDPOINT` | `http://127.0.0.1:<port>`: every GitHub origin (github.com, api.github.com, api.githubcopilot.com) becomes this fake |
| `LANDLENS_LINEAR_ENDPOINT` | `http://127.0.0.1:<port>`: every Linear origin (mcp.linear.app, api.linear.app) becomes this fake |
| `LANDLENS_GITHUB_CLIENT_ID` | A GitHub OAuth App's client id for the device flow, until one is built in |

A packaged app reads none of them, and anything but a loopback address is ignored. The fake's tool listings
(`packages/connections/test/fixtures/*-tools.json`) are hand-made until recorded: `node
scripts/record-provider-tools.mjs github` (or `linear`) asks for your token without echo, lists the full and the
read-only endpoint (two `tools/list` calls, nothing written to the provider) and writes the fixture. Only the person
runs it, with their own token; no test or agent does. For the Land family (wave 7, [family.md](family.md)): `node
scripts/record-provider-tools.mjs --family clickland|landflow|landfall <address>` asks for your key (or Landfall
access token) the same way, makes one `tools/list` call to the sibling's own MCP server (`/api/mcp`, Landfall's
`/mcp`; https, or plain http only on this machine) and writes `fixtures/<sibling>-tools.json`;
`packages/mcp-gateway/test/family.test.ts` then checks `FAMILY_READS` against it (skipped while none is recorded).

Google Cloud ([gcp.md](gcp.md)): `pnpm test` runs `@landlens/gcp`'s unit tests against
`packages/gcp/test/fake-gcp.ts` (a loopback server for Resource Manager, Cloud Asset and Kubernetes Engine that
records every request) and `fake-gcloud.sh`; no test reaches Google, and gcloud needn't be installed. An unpackaged
build has Google Cloud off unless it reads one of:

| Variable | What |
|---|---|
| `LANDLENS_GCP_ENDPOINT` | `http://127.0.0.1:<port>`: the three Google origins become this fake |
| `LANDLENS_GCLOUD` | an absolute path to the gcloud to run (the fake); otherwise it is looked up on the login PATH |
| `LANDLENS_GCP_REAL=1` | an unpackaged build may reach the real Google Cloud with your gcloud; only the person sets it |
| `LANDLENS_GKE_REAL=1` | with `LANDLENS_GCP_REAL=1` and no fake endpoint, an unpackaged build may also connect a real GKE cluster; without it, it opens only the fake's clusters on `127.x`. Only the person sets it, and never against a cluster during development (CLAUDE.md) |

A packaged app reads none of them. `pnpm test` also runs `@landlens/gcp-mcp`'s tests (`landlens-gcp` against the
fake). The e2e: `pnpm -s build`, then in `apps/desktop` `LANDLENS_INTEGRATION=orbstack npx vitest run
test/gcp.e2e.test.ts test/gke.e2e.test.ts` (screenshots `g4-*`, `g5-*` and `f5-*` with `LANDLENS_SHOTS`). Main's
native questions (connect a cloud cluster, let Claude read projects) are answered by a stub the test installs in main. `gke.e2e` makes a
throwaway ServiceAccount, Role and RoleBinding in `landlens-dev` (read-only, deleted after) and points the fake's
GKE cluster at OrbStack's API server; it never writes `~/.kube/config`. With `orbstack,claude` it also asks a live
session one question about the fake Google Cloud, on your own Claude Code subscription.

Land family ([family.md](family.md)): `pnpm test` runs the family's unit tests in `@landlens/connections` against
`packages/connections/test/fake-family.ts`, one loopback fake each of Clickland, Landflow and Landfall that records
every request (`/_fake/state`). The fake Landfall records any trigger, timeline or artifact request in `forbidden`.
`apps/desktop/test/family-main.test.ts` runs `FamilyService` against the same fakes. No test reaches a sibling. An
unpackaged build reads:

| Variable | What |
|---|---|
| `LANDLENS_FAMILY_HTTP_HOSTS` | comma-separated host names (each `^[a-z0-9.-]{1,253}$`, at most 20) a sibling's address may reach over plain http, such as `landflow-host.landflow-dev.svc.cluster.local` for the local Landflow. Without it, plain http goes only to `127.0.0.1`, `localhost` and `[::1]` |

A packaged app reads none: forward the service in Landlens and use `http://127.0.0.1:<port>`. The e2e: `pnpm -s
build`, then in `apps/desktop` `LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism
test/family.e2e.test.ts` (screenshots `w7-*` with `LANDLENS_SHOTS`). It starts the three fakes, plays the browser
for Landfall's sign-in with a stub of `shell.openExternal` that fetches only loopback addresses, and uses its own
profile. The live checks of the spec's D137 (`orbstack,clickland`, `orbstack,landflow,claude`, `landfall,claude`,
and the writing ones behind `LANDLENS_LIVE_WRITES=1`) are not written yet. They come with the parts that use each
link, and the ones that write are run only by the person.

## Where things start

See [architecture.md](architecture.md), "Code map". New IPC: add the channel and its schema to
`packages/contracts/src/index.ts`, the handler to `apps/desktop/src/main/ipc.ts`, and the name to the preload's list
(a unit test keeps them equal).
