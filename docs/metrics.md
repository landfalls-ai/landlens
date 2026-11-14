# Metrics and graphs

CPU and memory over time, on the Overview and in the drawer. The owner's choice was **"Clickland, then live"**:
Landlens reads history from Clickland when it is connected and answers; otherwise it samples metrics-server while a
view is open; otherwise the chart says what is missing and how to fix it.

## Sources, in order

| Source | When | What you get |
|---|---|---|
| **Clickland** | A key is stored, Clickland answers, honours metric filters, and has samples for this cluster's name | History for 1h, 6h or 24h: kubelet stats and cluster state every 30s (Clickland `docs/sources.md`), in 30s to 12 min steps |
| **metrics-server** | Clickland isn't connected or fails, and the cluster serves `metrics.k8s.io` | Live samples every 15s from when a view first asks, kept for an hour in a ring buffer; no history before that |
| **none** | Neither | The reasons (one per source) and the fix: "Connect Clickland", or install metrics-server |

Main decides per request (`MetricsService` in `packages/metrics/src/service.ts`) and returns the source and the
reasons with the series, so the page always says where the numbers came from (a small "Clickland orbstack" or "Live
from metrics-server, no history · Connect Clickland" line above each chart).

A failure of Clickland is one of: not connected (no key), unreachable (no answer in 8s), refused key (401/403),
failed (any other answer), no data for this cluster's name, or **ignores filters**. The last guards against a
Clickland older than its `specs/001-metrics-filters`: such a build drops the `where` field without an error and would
answer every pod with the whole cluster's containers. Landlens asks once per five minutes for a cluster name nobody
has (`landlens-filter-probe.invalid`); any series back means filters are ignored, and Landlens refuses that Clickland
rather than draw the wrong pod.

## Setup

1. Clickland running locally (its `README`), API on `http://127.0.0.1:4710`, with metric filters
   (`/api/metrics/query` takes `where`; Clickland commit `67cf74e` on its `metrics-filters` branch).
2. A key with only the `read` scope, made with Clickland's development bootstrap key (`CLICKLAND_BOOTSTRAP_KEY`, an
   `admin` key that exists while the variable is set; Clickland `docs/reference/api.md`, "Authentication" and "API
   keys"):

   ```bash
   curl -s -XPOST http://127.0.0.1:4710/api/keys \
     -H 'authorization: Bearer ck_dev_bootstrap_key_000000000000000' -H 'content-type: application/json' \
     -d '{"name":"landlens-dev","scopes":["read"]}'
   # → { "id": "key_…", "key": "ck_…", … }: the key is shown once. Revoke with DELETE /api/keys/<id>.
   ```

3. In Landlens: the status bar's **Connect Clickland** (or the button in an empty chart). Give the address, the key,
   and the cluster's name in Clickland's data. **Test** checks `/api/health`, that filters are honoured, and one
   query (node CPU for that cluster in the last hour); **Save** stores them; **Forget the key** removes it.

**The cluster's name.** Clickland's collector labels every Kubernetes sample with `k8s.cluster.name`; on OrbStack it
is `orbstack`, which is also the kubeconfig context's name. Landlens uses the context's name unless you set another
one for that context in the dialog (kept per context in the settings file).

## What each chart shows

| Where | Scope | Series | Reference lines |
|---|---|---|---|
| Overview → **Usage**, CPU and Memory | the cluster | stacked per node (`k8s.node.cpu.usage`, `k8s.node.memory.working_set`): the top edge is the cluster | allocatable, summed over nodes |
| Overview → Usage → **Top namespaces** | the cluster | ranked bars of each namespace's mean over the range (`k8s.pod.*`), CPU or memory, top six and "other" | |
| Overview → **Nodes** rows | each node | a sparkline each for CPU and memory over the same range | the node's allocatable when it is the only node |
| Drawer → **Metrics**, Pods | the pod | stacked per container (`container.cpu.usage`, `container.memory.working_set`) | the pod's request (sum over containers) and limit (only when every container sets one) |
| Drawer → **Metrics**, Deployments, StatefulSets, DaemonSets | the workload | a line per pod (`k8s.pod.*`); past four pods the smaller ones are summed as "other" | one pod's request and limit (the template's) |

CPU is in cores, written as Kubernetes does (`120m`, `1.25`); memory is the working set in binary units. Requests
and limits are the latest values Clickland has (from `k8s.container.cpu_request` and friends) or, with
metrics-server, from the pod's or the template's spec; a request set only as a limit counts as both.

Each chart has a range switch (1h, 6h, 24h) above it that also scopes the node sparklines, a crosshair that snaps to
the nearest sample and lists every series with the reference lines (also by keyboard: focus the chart, ←/→, Home,
End, Esc), a legend with the latest values, and a **Table** view of up to twelve evenly spaced samples. Charts refresh
every 30s while the window is visible, and keep the previous frame dimmed while a new range loads.

**Empty and unavailable states** say exactly why:

- no Clickland and no metrics-server: both reasons, "Connect Clickland" or install metrics-server;
- Clickland unreachable, refusing the key, ignoring filters or without this cluster: that reason and "Clickland
  settings" (Landlens falls back to metrics-server first if the cluster has it);
- no samples for this pod yet: Clickland and metrics-server only see running containers, so a crash-looping or
  pending pod has none; the tab says the pod's status and still shows its request and limit from cluster state.

## The look

Hand-rolled SVG (`apps/desktop/src/renderer/src/charts/`), no chart library: the CSP forbids eval and network, and
four small components cover it. Built with the dataviz method: the categorical palette was validated with its
`validate_palette.js` against the card surface in both themes, slot 1 is the Iris accent, then orange, blue and aqua
([design.md](design.md#charts)); status colours never appear in a chart; reference lines are ink with their name and
value where they end; 2px lines, 14% washes, hairline grid.

## Code

| Path | What |
|---|---|
| `packages/contracts/src/index.ts` | `metrics:series` (`MetricsRequest` → `MetricsSeries`), the Clickland settings channels and their URL and key rules |
| `packages/metrics/src/clickland.ts` | `ClicklandClient` (key only to the configured URL, no redirects, 8s timeout), `honoursFilters` |
| `packages/metrics/src/clickland-series.ts` | A scope as Clickland queries, filtered on `k8s.cluster.name` and the scope's attributes |
| `packages/metrics/src/sampler.ts`, `live-series.ts` | The metrics-server sampler and its ring buffer; a scope's series from samples and the cluster's specs |
| `packages/metrics/src/service.ts` | `MetricsService`: the source choice, the Settings test |
| `apps/desktop/src/main/clickland-settings.ts` | The settings file and the key in safeStorage |
| `apps/desktop/src/renderer/src/charts/` | `TimeChart`, `Sparkline`, `Bars`, the pure helpers in `scale.ts` |
| `apps/desktop/src/renderer/src/Usage.tsx`, `MetricsTab.tsx`, `MetricsNotice.tsx`, `ClicklandSettings.tsx`, `metrics.ts` | The Usage card, the drawer's tab, the notices, the dialog, the polling hook |

## Tests

- Unit: `packages/metrics/test` (the Clickland client against a fake HTTP server, the scope mapping, the sampler with
  fake timers and a fake cluster, the source choice, the filter probe), `apps/desktop/test/clickland-settings.test.ts`
  (the key encrypted and never in the view, URL rules) and `chart-scale.test.ts` (scales, ticks, units, folding,
  stacking, gaps).
- Live: `LANDLENS_INTEGRATION=orbstack,clickland pnpm --filter @landlens/metrics test:integration` reads real series
  for `landlens-dev/orders-api` and `catalog-api` and the cluster ([development.md](development.md)).
- e2e: the no-source state on OrbStack always; with `clickland` in `LANDLENS_INTEGRATION`, Connect Clickland through
  the dialog, the Usage card and a pod's Metrics tab in dark and light, a pod with no samples, a deployment.
