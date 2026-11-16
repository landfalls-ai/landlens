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

Clickland's logs and traces (wave 7 part 3): the same flags also run `clickland-search.integration.test.ts` in
`packages/metrics` and the live half of `apps/desktop/test/clickland.e2e.test.ts`. These only read (`POST
/api/search`, `GET /api/traces/:id`) and make no key: they use `LANDLENS_CLICKLAND_URL` (default here
`http://127.0.0.1:4730`, a Clickland with search and traces) and `LANDLENS_CLICKLAND_KEY` (default Clickland's
development bootstrap key, which a development Clickland takes for reads), and expect ledger-worker's crash line
("cannot parse LEDGER_SHARDS", `deploy/scenarios/doctor`) and `landflow-host`'s traces in that Clickland. Without
`clickland`, `clickland.e2e` runs on OrbStack against the fake Clickland only: `pnpm -s build`, then in
`apps/desktop` `LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/clickland.e2e.test.ts`
(screenshots `w7p3-*` with `LANDLENS_SHOTS`).

Landflow on a resource (wave 7 part 4): `landflow.e2e` runs on OrbStack against the doctor scenario (it runs
`up.mjs`) and the fake Landflow and Landfall only: `pnpm -s build`, then in `apps/desktop`
`LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/landflow.e2e.test.ts` (screenshots `w7p4-*`
with `LANDLENS_SHOTS`). Its unit tests are `packages/kube/test/triage-alert.test.ts`,
`packages/connections/test/landflow.test.ts` and `apps/desktop/test/landflow-main.test.ts`. A send to a real triage
flow writes, so it is not written as a live check; that waits for the person (D137, `LANDLENS_LIVE_WRITES=1`).

The doctor ([doctor.md](doctor.md)): `node deploy/scenarios/doctor/up.mjs` starts one broken workload per problem
class in `landlens-dev` (and `--down` removes them); `LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/kube
test:integration` starts them itself and waits up to 4 minutes for each problem, since pending and not-ready count
only after 2.

Your actions ([workbench.md](workbench.md#your-actions)): `node deploy/scenarios/hands/up.mjs` makes the `hands-*`
objects in `landlens-dev` (a Deployment with a PodDisruptionBudget, a StatefulSet, a DaemonSet, a bare Pod, a CronJob
that never fires, six ConfigMaps, and two Secrets made locally: one holding a random `LLMARK-` marker, one a fresh
self-signed certificate); `node deploy/scenarios/hands/down.mjs` removes everything labelled `scenario=hands`. Then
`LANDLENS_INTEGRATION=orbstack npx vitest run test/actions.integration.test.ts` in `packages/kube` (scales,
restarts, suspends and triggers them and puts each back) and, after `pnpm -s build`, in `apps/desktop`
`LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/actions.e2e.test.ts` (screenshots `w8p1-*`
with `LANDLENS_SHOTS`). The unit tests: `packages/kube/test/actions.test.ts`, `edits.test.ts`, and in `apps/desktop`
`actions-main.test.ts`, `action-log.test.ts`.

Nodes ([workbench.md](workbench.md#nodes-cordon-and-drain)), with the same scenario: a full drain runs only in unit
tests, against the in-memory API in `packages/kube/test/fake-api.ts` (`drain.test.ts`, and `apps/desktop`'s
`nodes-main.test.ts`). On OrbStack, `LANDLENS_INTEGRATION=orbstack npx vitest run test/drain.integration.test.ts` in
`packages/kube` sends reads and dry-run evictions of the scenario's own pods only (a test-local fence refuses
anything else) and makes and deletes one throwaway PodDisruptionBudget; `test/nodes.e2e.test.ts` in `apps/desktop`
is reads only (screenshots `w8p2-*`). An unpackaged build sends no node write and no dry-run eviction unless
`LANDLENS_NODE_WRITES` names the cluster as `<context>@<host>:<port>` (comma-separated; the front door refuses
every other node write and eviction): leave it unset. OrbStack's one node runs the siblings
(landflow-dev, clickland-dev, kube-system); never cordon or drain it.

Tables and asks ([workbench.md](workbench.md#tables-selection-columns-namespaces)): unit tests `table-state.test.ts`,
`ask-presets.test.ts`, `row-keys.test.ts`, `apply-rules.test.ts` and the part 3 block of `actions-main.test.ts`; after `pnpm -s build`, in
`apps/desktop` `LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism test/tables.e2e.test.ts`
(screenshots `w8p3-*`). It makes ConfigMaps `hands-bulk-1..6` in landlens-dev and deletes them, and uses the fake ACP
agent (it says "Attached: <uris>." for what a prompt attached). The namespace control is a popover now: e2e tests
choose one with `chooseNamespace(page, ns)` from `test/e2e-helpers.ts` ("" for all).

Secrets and certificates ([workbench.md](workbench.md#secrets-and-certificates)): unit tests `secrets-main.test.ts`,
`secret-text.test.ts`, `quotes.test.ts`, `telemetry-main.test.ts`, and in `packages/kube` `policy.test.ts`,
`frontdoor.test.ts`, `certs.test.ts`; after `pnpm -s build`, in `apps/desktop` `LANDLENS_INTEGRATION=orbstack npx
vitest run --no-file-parallelism test/secrets.e2e.test.ts` (screenshots `w8p4-*`, dummy values only). It makes
throwaway Secrets `hands-reveal-e2e` (a random marker per run) and `hands-reveal-tls` (a fresh self-signed EC
certificate) in landlens-dev and deletes them, stubs main's dialog, saves and restores your clipboard (it writes to
it), and reads the fake ACP agent's `agent-sessions/fake-agent-prompts.jsonl` (every prompt it got, kept beside the
session folders).

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
| `LANDLENS_GCP_ENDPOINT` | `http://127.0.0.1:<port>`: the five Google origins become this fake |
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

Wave 9 ([specs/009-google-view](specs/009-google-view/tasks.md)): `packages/gcp/test/client.test.ts` (five origins,
GET only, a call's limits) and `recommender.test.ts` (GKE's suggestions for one cluster: ACTIVE, this cluster's only,
the join, the cuts), more cases in `errors.test.ts`, the fake's recommender routes (`fake-gcp.ts`), and in
`apps/desktop/test` the `gkeOf` and `clusterView` cases of `gcp-service.test.ts` and `google-rules.test.ts` (the
panel's words, the cut line, the latest-only loader). The CA a context trusts is reported by the sidecar
(`sidecar/kube-proxy/main_test.go`, `packages/kube/test/sidecar.test.ts`), and `gke.test.ts` pins the fingerprint both
sides compute for the fake's CA. The e2e `test/gview.e2e.test.ts` (`LANDLENS_INTEGRATION=orbstack`, after `pnpm -s build`; screenshots
`g9-*`, also at 1024×700) makes its own throwaway ServiceAccount, Role and RoleBinding in `landlens-dev` (deleted
after) for case (a), and for case (b) writes a temporary kubeconfig (0600, in its own folder, removed after) that
names OrbStack `gke_demo-shop_us-central1_shop-prod` and `gke_orbit-analytics_us-central1_shop-prod`, passed to the
app as `KUBECONFIG`; it reads `~/.kube/config` only through `kubectl config view` and never writes it.
Part 2 (Cloud Monitoring as a metrics source) adds `packages/gcp/test/monitoring.test.ts` (`promRange` and the fake as
a metrics scope), `packages/metrics/test/cloud-monitoring.test.ts` (the queries and the leak filter against the fake,
which `packages/metrics` imports from `packages/gcp/test`), Cloud Monitoring cases in `service.test.ts` and
`gcp-service.test.ts`, `apps/desktop/test/metrics-source.test.ts`, a case in `packages/kube-mcp/test/server.test.ts`
(the tool's words), and four cases in `gview.e2e.test.ts` (screenshots `g9-p2-*`), which read `landlens-dev`'s pods and
OrbStack's nodes with `kubectl get` for the fake's model and write nothing more. Its security review's fixes add a
"Fable's security review of part 2, fixed" block to `cloud-monitoring.test.ts`, `service.test.ts`,
`metrics-source.test.ts` (T3 reads `src/main/index.ts` to check both wiring sites) and `gcp-service.test.ts` (M1 runs
a real `GcpService` against the fake with a `kept` file, so nothing has read gcloud or Google before the session's
call; the fake gcloud's `calls` file shows whether gcloud ran).
Part 3 (Cloud Monitoring's alerts) adds `openAlerts`, `clusterAlerts` and `alertPolicy` cases to
`packages/gcp/test/monitoring.test.ts`, `packages/gcp/test/briefs.test.ts` (the briefs Ask Claude quotes), the alerts
half and `gcp:cluster-item` in `gcp-service.test.ts`, the alerts' words and Ask's contexts in `google-rules.test.ts`,
the third section's rules in `problems.test.ts`, a `GCP_QUOTE` case in `agent-service.test.ts`, and three cases in
`gview.e2e.test.ts` (b) (screenshots `g9-p3-*`), whose fake alerts name `landlens-dev`'s real pod and OrbStack's node
and whose agent is played in main (`agent:start` and `agent:prompt` replaced, as in `landflow.e2e`). Its security
review's fixes add a "Fable's security review of part 3, fixed" block to `gcp-service.test.ts` (M1's unread views, L1,
L3's served text, L6's sweep, L7's undelivered reads with a slow fake) and one to `google-rules.test.ts` (the rules,
`startViewPoll` with fake timers, and a source check that the drawer and Ask read through `latestOnly`), an L3 case in
`agent-service.test.ts`, and L1, L2, L5, L6, T1 and T5 cases in `packages/gcp`'s `monitoring`, `assets` and `briefs`
tests.
Part 4 (Claude's tools) adds the three tools' cases to `packages/gcp-mcp/test/server.test.ts` (its reader runs
`gkeAdvice`, `openAlerts`/`alertRows`, `alertPolicy` and `gkeProjectSeries` straight against the fake; a `limits`
argument plays D195), `gkeProjectSeries` cases to `packages/metrics/test/cloud-monitoring.test.ts`, `alertRows` cases
to `monitoring.test.ts`, a "Claude's Google tools" block to `gcp-service.test.ts` (D190's grant, the reader's new
reads, D195's limit, D194's line), the session series with and without the grant to `metrics-source.test.ts`, the
session's `google` to `mcp-main.test.ts`, the session hold to `mcp-gateway`'s `autonomy.test.ts`, the overview's line
to `kube-mcp`'s `server.test.ts`, the prompt's words to `prompt.test.ts`, and case (c) to `gview.e2e.test.ts`
(screenshots `g9-p4-*`): a kept pre-wave grant, the card's line, the dialog's words, the MCP page's eight tools,
Preview of `cluster_overview`, and with `LANDLENS_INTEGRATION=orbstack,claude` a live session answering from
`gcp_alerts`.

Views on demand (wave 10, [spec](specs/010-views/spec.md)): part 1's unit tests are `packages/views/test`
(`schema`, `path`, `transform` with a seeded property test, `patch` and the limits), `packages/kube/test/watch.test.ts`
(selectors and the cap) and `frontdoor-fetch.test.ts` (a real front door before a fake sidecar), and
`apps/desktop/test/view-runtime.test.ts`, which runs `ViewRuntime` against `test/view-fakes.ts`: an in-memory API
and front door that apply the real token policy (`authorize`), record every request with the token's label, stream
watches and followed logs, and can hold or refuse a path. On OrbStack, `LANDLENS_INTEGRATION=orbstack pnpm --filter
@landlens/desktop test:integration` runs `view-runtime.integration.test.ts` through a real front door and sidecar: it
applies a throwaway Deployment (busybox, `IfNotPresent`) and ConfigMap named `view-check-*` (labelled
`scenario=view-check`) in `landlens-dev`, scales the Deployment once, reads Helm's `landlens-demo`, and deletes both by
label at the end. Desktop's `pnpm test` skips `*.integration.test.ts`.

Land family ([family.md](family.md)): `pnpm test` runs the family's unit tests in `@landlens/connections` against
`packages/connections/test/fake-family.ts`, one loopback fake each of Clickland, Landflow and Landfall that records
every request (`/_fake/state`). The fake Landfall records any trigger, timeline or artifact request in `forbidden`.
`apps/desktop/test/family-main.test.ts` runs `FamilyService` against the same fakes. No test reaches a sibling. An
unpackaged build reads:

| Variable | What |
|---|---|
| `LANDLENS_FAMILY_HTTP_HOSTS` | comma-separated host names (each `^[a-z0-9.-]{1,253}$`, at most 20) a sibling's address may reach over plain http, such as `landflow-host.landflow-dev.svc.cluster.local` for the local Landflow. Without it, plain http goes only to `127.0.0.1`, `localhost` and `[::1]` |
| `LANDLENS_ACP_AGENT` | an ACP agent's `.js` or `.mjs` script run in place of claude-agent-acp (wave 7 part 5's e2e uses `test/fixtures/fake-acp-agent.mjs`: no Claude Code runs) |

A packaged app reads none: forward the service in Landlens and use `http://127.0.0.1:<port>`. The e2e: `pnpm -s
build`, then in `apps/desktop` `LANDLENS_INTEGRATION=orbstack npx vitest run --no-file-parallelism
test/family.e2e.test.ts` (screenshots `w7-*` with `LANDLENS_SHOTS`). It starts the three fakes, plays the browser
for Landfall's sign-in with a stub of `shell.openExternal` that fetches only loopback addresses, and uses its own
profile. Of the live checks of the spec's D137, Clickland's logs and traces (`orbstack,clickland`) are written
(above); the rest (`orbstack,landflow,claude`, `landfall,claude`, and the writing ones behind `LANDLENS_LIVE_WRITES=1`)
are not written yet. They come with the parts that use each
link, and the ones that write are run only by the person.

Telemetry and the brain (wave 7 part 5): `pnpm test` runs `@landlens/telemetry` (the record property test, the OTLP
bodies, the queue); `apps/desktop/test/telemetry-main.test.ts`, `brain-main.test.ts` and `report-hooks.test.ts` run
main's services against the fakes. The e2e: `pnpm -s build`, then in `apps/desktop` `LANDLENS_INTEGRATION=orbstack
npx vitest run --no-file-parallelism test/report.e2e.test.ts` (screenshots `w7p5-*`), with the fake ACP agent, the
fake Clickland's OTLP sink and the fake Landflow's brain. With `orbstack,clickland` it also sends a synthetic
session's records to your local collector (`LANDLENS_CLICKLAND_COLLECTOR`, default `http://127.0.0.1:4318`, team
`landlens-live-check`) and checks the collector took them; it reads nothing back.

## Where things start

See [architecture.md](architecture.md), "Code map". New IPC: add the channel and its schema to
`packages/contracts/src/index.ts`, the handler to `apps/desktop/src/main/ipc.ts`, and the name to the preload's list
(a unit test keeps them equal).
