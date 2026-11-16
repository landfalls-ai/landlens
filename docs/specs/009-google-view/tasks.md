# Wave 9: Google's view of this cluster — tasks

The spec is [spec.md](spec.md) (D173–D201). Each part ends running on OrbStack against the loopback fake Google, with
its tests green, its docs moved and a Fable security review. No test reaches Google.

## Part 1: ground and "Google suggests" (D173–D178) — built 16 Nov 2026

- [x] `client.ts`: five origins (`monitoring`, `recommender` added), still GET only; a call's `o` lowers the time and
  size limits, never raises them (D174); `client.test.ts`
- [x] `errors.ts`: Cloud Monitoring and the Recommender in the disabled and denied sentences; a PromQL 400 or 422 is
  "Cloud Monitoring didn't accept Landlens's query."; Prometheus's `errorType` for the log only (D175);
  `errors.test.ts`
- [x] `fake-gcp.ts`: the recommender's two routes, with the cases D197 names and a cross-project one (below);
  `advice`, `ignoreFilter`, `fail` by API
- [x] `recommender.ts` `gkeAdvice`; contracts `GkeRef`, `GkeAdvice` (and `GcpAlert`, `GcpClusterView` for the
  channel) (D176); `recommender.test.ts`
- [x] `GcpService.gkeOf`, `clusterView` (advice only; alerts empty until part 3), `view`; `gcp:cluster-view` and the
  preload list (D173, D177); `gcp-service.test.ts`
- [x] `googleView.ts` (`useGoogleView`), `GoogleSuggests.tsx` (`GoogleSuggests`, `GoogleHint`), `googleRules.ts`,
  styles in `gcp.css`, the Overview (D178); `google-rules.test.ts`
- [x] The e2e `gview.e2e.test.ts`: (a) the Overview case through Landlens's GKE kubeconfig; (b) an own context by the
  listing's address, the hint, and a moved address
- [x] Docs: [gcp.md](../../gcp.md#googles-view-of-a-cluster), [security.md](../../security.md#connections-and-google-cloud),
  [design.md](../../design.md), [architecture.md](../../architecture.md), [development.md](../../development.md),
  [limitations.md](../../limitations.md), [roadmap.md](../../roadmap.md), [plan.md](../../plan.md), this folder,
  [history.md](../../history.md)
- [x] Fable's security review of part 1, and its fixes (below)

### Where part 1 departs from the spec

1. **No Ask on a suggestion yet.** D178 shows **Ask** on a row and **Ask Claude** in the opened row; both need D189's
   brief, quote heads and `GCP_QUOTE`, which the build order puts in part 3. Part 1 shows the rows and their detail
   only.
2. **The project number is read, not only used when already read** (D173). The recommender names clusters by the
   project number (Google's own sample, and the fake), so a `GkeRef` without it would drop every suggestion named
   that way. `gkeOf` asks the project search, which is cached 5 minutes and already read when a project is chosen.
3. **A cluster Landlens connected is also checked against its listed address** (D173 says the `gke` entry for the
   context). The listing already disconnects a cluster whose address changes; the check costs nothing and keeps the
   rule one rule for both kinds.
4. **A failed read is kept a minute, not 10** (D177). Otherwise a turned-on API would show its error for 10 minutes;
   **Check again** still reads at once (at most once in 10 s). At most 50 clusters' views are kept.
5. **`requests` takes Google's int64 encoding** (D176 says "a finite number"). Proto3 JSON writes int64 as a string
   (`"412"`): a string of digits is read as a number; anything else gives no count.
6. **A user agent is also redacted** (`redactText`) after it is cleaned, and every run of whitespace becomes one
   space first, so a newline doesn't glue two words.
7. **The fake's cross-project row.** The Recommender lists per project, so the leak case the fake carries is an
   insight in demo-shop's listing that targets orbit-analytics's own `shop-prod` in `us-central1` by its number,
   beside D197's other cluster (named `shop-prod-canary`, so a prefix match would also fail the test) and dismissed
   rows. Any `filter` other than `stateInfo.state = ACTIVE` is a 400 there.
8. **A pure `googleRules.ts`** holds the badge words, the meta line and the copyable commands, so they are tested
   without the preload bridge; `googleView.ts` holds only the hook.
9. **`gcp:cluster-view` is `.strict()`**: a request with any field beside `handle` and `fresh` is refused.
10. **Space opens a row too**, beside Enter and a click.
11. **The panel sits before Usage**, right after the two columns (D178 says after them and before Nodes; Usage sits
    between).
12. `SENTENCES.tooBig` still says "(8 MB)": no part 1 caller lowers `maxBytes`. Part 2's PromQL call keeps 8 MB, so the
    sentence stays true.

### [check] items settled or moved by part 1

- **e2e (b) and `KUBECONFIG`** (D198): settled. The catalog reads `KUBECONFIG` (`packages/kube/src/catalog.ts`), so (b)
  is an e2e: OrbStack opened as an own `gke_demo-shop_us-central1_shop-prod` from a temporary kubeconfig shows the
  panel, and stops once the fake lists shop-prod at another address.
- **[check 4]** (recommendations' `targetResources`): as specced, a recommendation is matched only through its
  insight; part 1 joins by `associatedInsights[].insight` and, failing that, the insight's
  `associatedRecommendations`.
- **[check 5]** (other subtypes' `content`): as specced, only the API deprecations' content is read.
- **[check 6]** (quotas): advice is kept 10 minutes and read only while an Overview of the cluster is open.
- [check 1–3] are parts 2 and 3; [check 7] is the person's live check.

### Security review of part 1, fixed

No High; two Medium, five Low and seven missing tests, all fixed. Each test was seen to fail with its fix taken out.

- [x] **M1** An own context counted as GKE by address alone. The sidecar's Ready line now carries `tls`: the SHA-256 of
  the DER of the certificates the context trusts (data, else the file; "" for the system roots) and whether
  `insecure-skip-tls-verify`, `tls-server-name` and `proxy-url` are set (`main.go` `readyTLS`, `main_test.go`).
  `sidecar.ts` takes it (`readyTls`; another shape is unknown), `connectedOf` passes it with the handle, and `gkeOf`
  requires, for both kinds, TLS checked (neither of the first two) against the listed CA: `caFingerprint(listed.ca)`
  for an IP endpoint, "" for a `gke.goog` name. A proxy is allowed (TLS still ends at the cluster's CA); no report is
  not GKE. Tests: `gcp-service.test.ts`, `gke.test.ts` (the fingerprint pinned to `main_test.go`'s),
  `sidecar.test.ts`, `gview.e2e` (b) (OrbStack's address with the fake's CA: no panel; OrbStack's CA: back).
- [x] **M2** Rows past page 2 were dropped silently. Ten pages of 100 (`GKE_ADVICE_READ` = 1,000) and `cut` when a
  token is left: `gkeAdvice` returns `{ items, cut }`, the view's advice carries it, and the panel says "Only the first
  1,000 suggestions of <project> in <location> were read; this cluster may have more." in place of the all-clear or
  under the rows, with "3+" as the count (`adviceLine`, `adviceCount`). The test that pinned the silent cut is
  replaced.
- [x] **L1** No project number gave an empty list: the view's advice is now "Landlens couldn't read <project>'s number,
  so it can't tell which suggestions are this cluster's." (`numberUnknown`), kept a minute, with no request.
- [x] **L2** `clean` is `/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu`: the astral tag block and U+2028/U+2029 go too. Its other
  callers (`gke.ts`, `scrub.ts`, `gcp-mcp`'s `v`, `toResource`) only lose more invisible characters; their tests pass.
- [x] **L3** A user agent is cleaned (to 4,096), redacted, and only then cut to 120 (`userAgent`).
- [x] **L4** A call's limit narrows only when it is a finite number above 0 (`lower`).
- [x] **L5** A recommendation joins on the insight's whole name, the project by id or number written one way
  (`canonical`), never on the last segment.
- [x] **T1–T7**: T1 the 10 s page limit (spied `AbortSignal.timeout` under a 60 s client); T2 a JWT in a user agent
  redacted; T3 a read in flight at an account change isn't kept, and its end removes only its own entry (an identity
  check, as the review noted was meant); T4 `MAX_VIEWS`; T5 `connectedOf` (the handler's `viaLandlens`, now a unit);
  T6 `latestOnly` (the hook's sequence guard, now a pure helper); T7 the silent-cut test replaced (M2).

## Part 2: Cloud Monitoring as a metrics source (D179–D184) — built 16 Nov 2026

- [x] `fake-gcp.ts`: the PromQL route with the scope model and the leak (`gke`, `scopes`, `leak`, `PROMQL_MARKER`);
  `monitoring.ts` `promRange`; `monitoring.test.ts`
- [x] `cloud-monitoring.ts` (queries, parse, series, `gkeHasData`); `cloud-monitoring.test.ts`
- [x] `service.ts`'s branch and reasons; contracts (`source: "cloud-monitoring"`, `gke`, five reason codes);
  `service.test.ts`
- [x] Main: `GcpService.promAsk` (its slot of four, the 25 s cache), `gkeOf`'s `unread`, the wiring
  (`metrics-source.ts`); `MetricsNotice.tsx`; `metricsText`; `gcp-service.test.ts`, `metrics-source.test.ts`, the kube
  tool's case in `server.test.ts`
- [x] The e2e's (a) Metrics tab and (b) Overview (`gview.e2e.test.ts`, screenshots `g9-p2-*`); docs
  ([metrics.md](../../metrics.md#cloud-monitoring), [gcp.md](../../gcp.md#googles-view-of-a-cluster),
  [security.md](../../security.md#connections-and-google-cloud), [design.md](../../design.md),
  [architecture.md](../../architecture.md), [development.md](../../development.md),
  [limitations.md](../../limitations.md), [roadmap.md](../../roadmap.md), [plan.md](../../plan.md),
  [history.md](../../history.md))
- [x] Fable's security review of part 2, and its fixes (below)

### Where part 2 departs from the spec

1. **The agent's rule lives in `MetricsService`** (D182/D194 put it in main's `cloudMonitoring`), so it is one tested
   place: a call with `agent` reads Google only for a project in `agent.projects`, and `hold()` runs once, before the
   first query leaves. Main's dep still receives `o.agent`. *Since the review's M1, main's dep decides first too* (as
   D183 says): a project the session may not read never reaches `gkeOf`; the service's check is the second lock.
2. **No session reads Cloud Monitoring in part 2.** The grant that covers metrics (D190) and the session's projects
   and hold (D194) are part 4's, so `sessionSeries` (new `apps/desktop/src/main/metrics-source.ts`) passes every
   session's `metrics` tool `projects: []`: it answers from metrics-server with `cloud-monitoring-not-granted`. That
   sentence's "turn on 'Claude can read these projects'" helps only once part 4 is in.
3. **A failed listing is said, for the graphs.** `gkeOf(c, { unread: true })`: a context of yours with gcloud's name
   for a chosen project whose project's listing failed is `cloud-monitoring-failed` ("Landlens couldn't list
   <project>'s GKE clusters to check that this is one of them: <sentence>"), not silence. The suggestions panel keeps
   part 1's silence. A `cloudMonitoring` lookup that throws is also a reason.
4. **Failures are told apart** (D182 says a 400 from Landlens's name check is thrown, any other failure is a reason).
   Main's `failed()` gives a Google 400 a status of 400 too, so the service marks what `ask` threw (`AskFailed`): every
   ask failure, a Google 400 included, is `cloud-monitoring-failed` with main's sentence; a failed read of the cluster
   (a reader that can't list the scope's pods) is "wasn't asked: reading this scope from the cluster failed (HTTP
   403)" and metrics-server is next, as for Prometheus; a non-matrix answer is its sentence. If asking `gkeHasData`
   fails after an empty answer, that is a failure, not an empty chart.
5. **A fifth reason, `cloud-monitoring-cut`.** The 200-series cap counts only this cluster's series, after the filter
   (so another project's series can't push this cluster's out), and more than 200 is said ("the first 200 are
   drawn").
6. **`only` is applied wherever a scope names its keys**: a workload's pods (also when they fit in the regex) and a
   node, not only the namespace fallback. A workload with no pods asks nothing (Prometheus asks `pod=~"^$"`).
7. **`promAsk(ref)` returns the function** (not a promise of it); its 25 s key is the project, query, step and
   `round(from / step)`; answers asked across an account change, or for a project taken out, are dropped.
   `promRange` also refuses an empty query and a range that isn't one, before a request.
8. **Open Google Cloud and Copy command also sit on the live metrics-server line** (D184 puts them in the no-metrics
   notice): a GKE cluster normally has metrics-server, so the notice would seldom show. They are `.link-btn`s; Open
   Google Cloud is a window event (`landlens:open-gcp`) the workspace answers with the Google Cloud page, as
   Prometheus's choice is. The notice's reasons show a backticked command as code (`sentenceParts`).
9. **`metricsText`** calls Cloud Monitoring's memory "Memory (non-evictable)", and when metrics-server answers it
   passes the Cloud Monitoring reasons as notes, so the model knows why (not-granted, no-data, failed).
10. **`gkeHandles` moved to `index.ts`** and is passed into `registerIpc`, so the metrics source and the IPC handler
    read the same set.
11. **e2e (a) and (b) check more**: (a) the leaked cluster has the same pods with an `intruder` container, never on the
    page; the ServiceAccount's Overview (it can't list every pod) gets "wasn't asked … HTTP 403" and no node or
    namespace query reaches the fake. (b) the unchosen project's Usage says why with Open Google Cloud; a moved address
    draws from Cloud Monitoring no more.

### [check] items settled or moved by part 2

- **[check 1]** (`project_id`, `location`, `cluster_name` in a selector and in `by`): still the person's live check
  (spec section 9, step 5). The fail-closed half is proven: with each matcher taken out of the query, or a label
  missing from an answer, nothing of another cluster is drawn (`cloud-monitoring.test.ts`).
- **[check 6]** (quotas): PromQL answers are kept 25 s, four at once, and nothing is asked unless a chart asks; the
  "is there data" check is kept five minutes per cluster.
- [check 7] is still the person's live check; [check 2] and [check 3] are part 3's.

### Security review of part 2, fixed

No High; one Medium, seven Low and eight missing tests, all fixed. Each test was seen to fail with its fix taken out
(17 mutations, one per fix or rule, each run against its own test, then restored).

- [x] **M1** A session's `metrics` call ran `gkeOf` (gcloud, every chosen project's GKE listing, the project search)
  before the agent rule, so Google was asked as the person with no grant and no hold. `cloudMonitoringSource` now
  decides a call with `agent` first, from what main holds: `GcpService.chosenProjectOf(context)` (Google Cloud on,
  gcloud's `gke_<project>_…` name, the project chosen; no gcloud, no request). Not chosen or not GKE's name: nothing;
  chosen but not in `agent.projects`: `cloud-monitoring-not-granted`; only a project the session may read goes on to
  `gkeOf`. `MetricsService`'s check after the lookup stays as the second lock. `NOT_GRANTED` now says Cloud Monitoring
  "may have" the history, since it is said from the name alone. Tests: `metrics-source.test.ts` (`gkeOf` never called
  for a session without the project); `gcp-service.test.ts` (a real `GcpService` with demo-shop kept from an earlier
  run, the fake and a real `MetricsService`: a session's call records no request at the fake and no gcloud run; the
  IDE's chart of the same cluster does ask, so the test can see one).
- [x] **L1** `only` is passed into the parse and applied before the 200 are counted (`GkeWant`). Test: the namespace
  fallback with 300 other pods first, then the workload's 120: all 120 drawn, no cut.
- [x] **L2** A pod's, a workload's and a namespace's `by` keep `namespace_name` (a pod's `pod_name` too), and the parse
  requires them equal to the request's (`labels`). Test: against the fake, with a pod of orders-api's name and an
  `intruder` container in namespace `payments`, the namespace and pod matchers stripped by the rewrite: the pod, the
  namespace and the workload equal the clean answers.
- [x] **L3** The parse counts `unlabelled` (a label missing, not a string, or `project_id` not a project id, as a
  number is); a query whose answer had series, kept none and lost labels on some throws `LabelsLost`, and the service
  says "Cloud Monitoring (<project>) answered without this cluster's labels, so nothing of it is drawn." and goes on
  to metrics-server, never asking or keeping `gkeHasData`. *Departure:* the review's rule was "every series dropped";
  that would also call an answer holding only another cluster's series (the leak, with this cluster's scope empty) a
  lost-label failure, so another cluster's series (labels present, other values) still count as no data. Tests:
  `cloud-monitoring.test.ts` (rows by number for the series and `gkeHasData`; a pod whose rows lost `namespace_name`;
  another project's rows alone: no data), `service.test.ts` (the sentence, metrics-server, `hasData` empty; also when
  only the container queries lost them).
- [x] **L4** Every ask first drops answers past `PROM_TTL` from the front of the map (it is in insertion order: an
  entry is deleted before it is set again), and `MAX_PROMS` is 40. Test: 50 asks, the clock past 25 s, one more:
  one kept.
- [x] **L5** A 403 or 429 is kept a minute per project (`PROM_FAILED_TTL`) and given again with no request; no other
  status is kept; one read across an account change isn't kept (`gen`). At most four running and 40 waiting
  (`PROMS_WAITING`): past them `PROM_BUSY`, no request. `forget()` and `choose()` clear the failures. Tests: a 403 and
  a 429 refused again within the minute with no request (another query of the project too) and asked after it; a 500
  not kept; a 403 straddling an account change not kept; 60 at once with a slow fake: 44 asked, 16 busy, then asking
  works again. The existing "a failure isn't kept" test now waits out the minute.
- [x] **L6** Top namespaces fail on their own: the node queries' failure still fails the whole, but a namespace query
  failing leaves the nodes drawn, no `namespaces`, and `cloud-monitoring-failed` "Top namespaces couldn't be read:
  <sentence>" (main's sentence, a lost-labels or not-metrics sentence, else "Landlens couldn't read its answer.";
  `failedSentence`). `AskFailed` moved into `cloud-monitoring.ts` so the sentence can be told from another error's text.
  The source line's tooltip now lists Cloud Monitoring's own reasons (the cut and this), which no part of the window
  showed while Cloud Monitoring drew. Test: an `ask` that rejects only the `namespace_name` queries.
- [x] **L7** A kept "no system metrics" lasts a minute (`NO_DATA_TTL`); a yes five. Test: a no, system metrics turned
  on, 59.999 s still no, past a minute asked again and drawn; a yes kept five minutes.
- [x] **T1** 403s on a pod's GET, a Deployment's GET, its pod list, a node's GET and the node list each reject with
  `ask` not called. **T2** The generation check on a finished answer is gone (the review's first option): `forget()`
  clears the map and the identity check keeps a newer entry; the generation now guards the kept 403/429 (tested in L5).
  **T3** `metrics-source.test.ts` reads `index.ts`: `series = sessionSeries(metrics)`, both `McpService` and
  `AgentService` take `metrics: series`, and `metrics.series` appears nowhere. **T4** two clusters, one without data:
  each its own answer. **T5** a workload that fits the regex, answered with another pod of the namespace. **T6** a
  listed pod that isn't a name is left out of the query, not a 400. **T7** `NaN`, `+Inf`, `-Inf`, a string, a short
  and a `null` point dropped. **T8** is M1's tests.

## Part 3: alerts (D185–D189) — built 16 Nov 2026

- [x] `fake-gcp.ts`: alerts and the policy (`demoShopAlerts`, `demoShopPolicies`, `SHOUTY_POLICY`, `POLICY_DOC`;
  `alerts`, `policies`); `monitoring.ts` `openAlerts`, `clusterAlerts`, `alertPolicy`; `monitoring.test.ts`
- [x] `clusterView`'s alerts half, `gcp:cluster-item` (`GcpService.item`, the IPC handler, the preload's list),
  `briefs.ts`; `gcp-service.test.ts`, `briefs.test.ts`
- [x] `problemRules.ts`, `Problems.tsx`, `AlertDrawer.tsx`, the Overview's lines, ⌘K; `problems.test.ts`,
  `google-rules.test.ts`
- [x] `quotes.ts` heads, `GCP_QUOTE`, the questions (and Ask on a suggestion, from part 1); `agent-service.test.ts`;
  the e2e (`gview.e2e.test.ts` (b), screenshots `g9-p3-*`); docs ([gcp.md](../../gcp.md#googles-view-of-a-cluster),
  [doctor.md](../../doctor.md#the-problems-page), [security.md](../../security.md#connections-and-google-cloud),
  [agent.md](../../agent.md), [design.md](../../design.md), [architecture.md](../../architecture.md),
  [development.md](../../development.md), [limitations.md](../../limitations.md), [roadmap.md](../../roadmap.md),
  [plan.md](../../plan.md), [history.md](../../history.md))
- [x] Fable's security review of part 3, and its fixes (below)

Every safety rule's test was seen to fail with the rule taken out (33 mutations, each run against its own test file,
then restored): the project-exact and `OPEN` filters, `cut`, both `unreadable` counts, the 200 cap and `over`,
`policyId` only for this project, unknown severity "none", the metric's shape, the policy's digits before a request,
the documentation's 300, the `\p{Cc}\p{Cf}\p{Zl}\p{Zp}` class, redaction before the cut, the brief's JSON quoting,
its redaction and cap, `item` only for ids in the view, the alerts read failing alone, the 60 s cache, `forget()`
clearing alerts, the policy cap, the view's `unreadable` including the answer's, both `GCP_QUOTE` heads, the alert's
fixed head, the alert's namespaces for a limited session, no badge for "none", the failed-read sentence, the Overview's
and the verdict's partial and failed lines, the namespace rule, Failing and To watch hiding alerts, and the channel's id
shape. One didn't fail, and isn't a rule on its own (departure 14).

### Where part 3 departs from the spec

1. **The alerts view says what it couldn't show.** `GcpClusterView.alerts` is `{ items, others, cut, unreadable, over,
   at }`: `unreadable` counts rows of Google's answer that weren't an alert's shape (whose they are is unknown) plus
   this cluster's with no usable id or opening time; `over` counts this cluster's past the 200 shown. Each puts a
   sentence in the strip and makes the counts "3+", so a list that dropped rows never reads as complete.
2. **`outsideText` (`assets.ts`)**: one helper for outside text: whitespace made one space, control, format and
   line/paragraph-separator characters removed, `redactText`, then cut. Every alert and policy field and every brief
   value goes through it, and the recommender's user agent now does too (the same steps as part 1's L3 fix).
3. **Alerts are kept per project, cut per cluster on use.** `alerts.list` answers for the project, so two GKE clusters
   of a project share one read (60 s); `clusterAlerts` runs on each view. A failed read is kept 60 s too (the spec
   gave the time for alerts only). Policies are kept 10 minutes, a failure a minute, at most 100 (`MAX_POLICIES`).
4. **The policy's `cut`** compares the whole cleaned documentation (up to 16,384 characters) with the 300 kept.
5. **The briefs** JSON-quote free text, so a `"` in a policy name or a sentence can't end the quote, and redact the
   whole again before the 4,000 cap. The alert's documentation line says "its first 300 characters" when cut; a policy
   that failed or isn't the project's leaves its lines out. A suggestion's brief also has its priority, when Google
   refreshed it and each API's callers.
6. **`gcp:cluster-item`'s 404s are fixed sentences** (`ITEM_GONE`: "That alert is no longer open on this cluster.",
   "Google no longer lists that suggestion for this cluster."); the view checked is the one main holds (read again
   only when its time is up), so an id the page saw a moment ago is still answered.
7. **The workspace holds one `useGoogleView`**, active while the Overview or Problems is shown, every 60 s; Google
   suggests reads it too (main still keeps advice 10 minutes, so this asks Google no more often), and ⌘K's command
   shows when the last view was GKE.
8. **The Alerts segment counts the alerts in the chosen namespaces** and goes back to All when it has none; a doctor's
   class chip or In triage hides the section too. The Overview's line opens Problems on Alerts only when there are
   alerts (else on All, where the strip says why).
9. **More words than the spec's**: under the section, how many of this cluster's are outside the chosen namespaces; an
   empty section after a partial read says some weren't read instead of the all-clear; the Overview's line and the
   verdict's sub-line have failed and partial variants ("couldn't be read", "only partly read").
10. **The drawer, when the alert leaves a partly read list**, says "Not among the alerts read since 12:03." (it may
    still be open) rather than "No longer open" (and, since the review's M1 and T2, when the read failed or Google's view
    couldn't be read: `goneNote`). A policy of another project says why it isn't read. The documentation's
    cut note is a small pill.
11. **An alert's context carries `namespaces`**: the subject's (a Prometheus target's Namespace included), or `""` for
    a node, the cluster or no subject, so wave 8's L11 rule keeps it from a limited session. Only a Pod subject goes
    as a reference. Ask in the drawer sends the brief the drawer already read (since the review's L4 only while the alert
    is in the view it was read for); elsewhere `askGoogle` reads it (since T3 the latest Ask wins), and a failure shows
    in the workspace's notice.
12. **The e2e's part 3 cases run in (b)**, OrbStack as your own context with full access, not in (a): (a)'s
    ServiceAccount is limited to `landlens-dev`, where the namespace rule hides the node's and the target's alerts.
    The fake's alerts name `landlens-dev`'s real pod and OrbStack's node, so **Open Pod** opens the real pod. The
    question is sent at once once the played session is up, which clears the chip, so the e2e checks the head in the
    prompt main received rather than the chip's title.
13. **The policy's documentation keeps its Markdown as text**: a link written in it (`[the runbook](https://…)`) is
    shown and quoted as characters inside the well and the fence; only `documentation.links` isn't read.
14. **The generation check in `projectAlerts` and `policy`** (as in `readAdvice`) was belt-and-braces (removed by the
    review's L7, which checks delivery instead): `forget()` and
    `choose()` clear both maps synchronously and each entry is set before any await, so taking the check out changes
    no outcome. The rule it would guard ("a read across an account change isn't kept") holds by the clear, whose
    mutation does fail its test.

### [check] items settled or moved by part 3

- **[check 2]** (severity words): Landlens maps only `CRITICAL`, `ERROR` and `WARNING`; any other word, or none, is
  "none" and shows no badge (tested with the rule removed). Whether real alerts carry those words is the person's live
  check (spec section 9, step 6).
- **[check 3]** (`alerts.list`'s `filter`): none is sent, and the fake refuses one, so nothing depends on its syntax;
  Landlens filters in main. That Google's default order is newest first (so a cut keeps the newest 1,000) is still the
  person's live check.
- [check 1] and [check 7] are still the person's live checks.

### Security review of part 3, fixed

No High; one Medium, seven Low and eight missing tests, all fixed as the review proposed (two places chose a little
differently, said in the item). Each test was seen to fail with its fix taken out (40 mutations, one per fix or rule,
each run against its own test file, then restored).

- [x] **M1** The view no longer vanishes when main can't confirm the cluster. `view()` asks `gkeOf(c, { unread: true })`
  and a failed listing is `{ gke: false, unread: unlisted(…) }`; a GKE-named context of a chosen project while gcloud
  is missing or signed out (or its state can't be read) is `{ gke: false, unread: unchecked(project, sentence) }` with
  `client()`'s own sentences (Google Cloud off still says nothing). `GcpClusterView`'s not-GKE arm has `unread?`.
  `alertNotes` gives "Google's view of this cluster couldn't be read: …", `overviewAlerts` and `verdictAlerts` their
  "couldn't be read" lines; a plain `{ gke: false }`, a hint and no answer still give nothing. `gcp:cluster-item` is a
  503 with the sentence. The hook's failure goes through `viewOnError`: a cluster that was GKE, was unread, or has no
  answer yet and is named as GKE clusters are (`gkeShaped`) becomes `{ gke: false, unread: <main's message> }`, never
  the last answer; one known not to be GKE stays as it was. Before the first answer such a context is `reading`, and the
  verdict says "Reading Cloud Monitoring's alerts…" (only for GKE-named contexts, so OrbStack shows nothing new). An
  open alert drawer stays (the held alert keeps its `project`) and is checked against `alertsForDrawer`: an unread,
  failed or not-GKE view has no list, so the alert is "Not among the alerts read since …". Tests:
  `gcp-service.test.ts` (after a good view, the container listing refused and 60 s on; gcloud signed out, nothing asked;
  gcloud missing; Google Cloud off; the item's 503), `google-rules.test.ts` (each rule with `unread`, and nothing for a
  plain not-GKE, a hint or undefined; `viewOnError` after a good list, a good "none", on and on, from the start;
  `alertsForDrawer` and `goneNote`).
- [x] **L1** `openAlerts` counts what it doesn't show: another project's rows (by id, number or prefix) first, and they
  count nowhere; then CLOSED is dropped; a state that is neither OPEN nor CLOSED (or none) is `unreadable`; an open row
  with no `project_id` is `unplaced`. The view carries `unplaced`; `alertsPartial` includes it (so "0+", no all-clear,
  the drawer's "not among those read"), and the strip says "2 open alerts in Cloud Monitoring's answer don't say which
  project or cluster they are about." Tests: `monitoring.test.ts` (T7's pinned drop now `unplaced: 1`,
  `unreadable: 1`; closed, another project's odd state, a stateless and a resource-less row), `gcp-service.test.ts`
  (the view's `unplaced`), `google-rules.test.ts` (partial, "0+", both sentences, the verdict and Overview lines).
- [x] **L2** `clean`'s class is now `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}`, U+FE00–FE0F, U+E0100–E01EF and the
  blank letters U+115F, U+1160, U+3164, U+FFA0, U+2800 (the review's class, written with escapes). Its other callers
  (projects' names, resources' fields and labels, GKE status and version, the scrubbed configuration's keys and values,
  the recommender's text) behave as before except that an emoji loses its variation selector (`❤️` shows as `❤`) and a
  code point unassigned in Node's Unicode (17.0 here) goes. Tests: `assets.test.ts` (the carriers, a 290-selector run,
  a resource and label still read; the emoji line updated), `monitoring.test.ts` (a policy's name, condition and
  documentation), `briefs.test.ts` (an alert's and a suggestion's values).
- [x] **L3** Main remembers the outside text it serves in Google's view: `GcpService`'s `served` hook gets each alert
  policy's name, each suggestion's description, recommendation, API and callers (from `clusterView`), and each item's
  conditions, documentation and every brief line holding a quoted value (from `item`); `index.ts` puts them in a
  `SiblingText<"gcp">` (the store is now generic over its key), and `AgentService.prompt` calls `gcpQuoted` when
  `gcpText.found(text)` has any, as well as on `GCP_QUOTE`. Matching is the store's (whole values of 16 characters or
  more, after the window's normalisation). Tests: `agent-service.test.ts` (a served documentation pasted with no head
  and no project line holds; a served brief line quoted as terminal output holds; a plain question doesn't),
  `gcp-service.test.ts` (what the view and the item serve, and a question quoting the documentation is found).
- [x] **L4** `briefToSend(held, item, viewAt)` in `googleRules.ts`: the drawer's brief only while the alert isn't gone,
  the read is this alert's, and it was read for the view shown (the drawer records the alerts' read time `at` when it
  reads; the view's `alerts.at` changes when main reads Google again). Otherwise Ask sends no brief and main is asked:
  its 404 "That alert is no longer open on this cluster." when gone, a fresh brief when still open. Ask stays visible
  rather than hidden, so a person who asks about an alert that has gone is told so. Test in `google-rules.test.ts`
  rather than `problems.test.ts` (it is a Google rule); the drawer's call to it is checked in T3's test.
- [x] **L5** `clusterAlerts` marks an alert `policyUnknown` when its policy is named by a number and this project's number
  is unknown (a project id never is all digits); no `policyId`, so nothing is read. `policyNote` gives the drawer
  "Landlens couldn't read demo-shop's number, so it can't tell whether this policy is its own." Tests:
  `monitoring.test.ts` (without the number `policyUnknown`; with it `policyId`, and another number neither),
  `google-rules.test.ts` (both notes).
- [x] **L6** `openAlerts` keeps a slim row (`RawAlert` is now its own type): the name, opening time, resource type, the
  eight labels `onCluster` and `subjectOf` read (strings only), the metric's type and the policy's name, display name
  and severity; the schema no longer passes the rest through. `projectAlerts` drops entries past `ALERTS_TTL` when it
  sets a new one. Tests: `monitoring.test.ts` (a row with `metadata`, `log`, `url`, user labels, metric labels and an
  extra resource label comes back as exactly the slim row), `gcp-service.test.ts` (after 60 s, a view of another project
  leaves only its entry).
- [x] **L7** `clusterView` notes the generation at its start and, after both reads, calls `current(project, gen)`: the
  project still chosen (else the 404 "Choose <project> on the Google Cloud page first.") and the account unchanged (else
  409 `ACCOUNT_CHANGED`). `item` checks again after the policy read. The alerts, advice and policy reads check the same
  inside their slot, before the request. The generation checks on keeping in `projectAlerts` and `policy` are deleted
  (T6, departure 14 settled: `forget()` and `choose()` clear synchronously and the entry is set before any await), with
  a comment saying so; `readAdvice`'s stays (part 1's T3 tests it). Tests: `gcp-service.test.ts` (a view across an
  account change rejected; a project taken out while its two reads wait behind another project's: 404, and no request
  of demo-shop's or its number after the removal; an item's policy read waiting for a slot not sent; an item whose
  policy read straddles an account change rejected). The two existing "in flight across an account change" tests now
  expect the 409 too.
- [x] **T1** `alertPolicy`'s 10 s spied as the alerts' 15 s is, under a 60 s client. **T2** The drawer's two sentences
  are `goneNote(held, view)`: "closed" only after a whole read without the alert; "unread" for a partial, failed,
  unplaced, unread or absent view. The workspace passes it as `note`. **T3** The drawer's item read and Ask's read are
  `latestOnly` (Ask's second click now wins rather than being dropped: the later question is the one the person means);
  a source test in `google-rules.test.ts` checks both, as part 2's T3 checked `index.ts`. **T4** `startViewPoll(active,
  load, visible)`: nothing while inactive, one read now, then every `VIEW_EVERY` only while visible, never `fresh`;
  tested with fake timers, and the hook's use of it checked in the source test. **T5** Two rows with one id: one alert,
  the first, and the second not unreadable. **T6** is L7. **T7** is L1. **T8** is M1's tests.

## Part 4: Claude's tools (D190–D196)

Built 16 Nov 2026; its security review fixed the same day (below).

- [x] The grant's `covers`, the dialog, the card's line
- [x] `GcpReader`'s new methods and `agentReader`; `server.ts`'s three tools; `server.test.ts`
- [x] D194: `mcp.ts`, `index.ts`, `metrics-source.ts` (the session series; `service.ts` already applied `agent`);
  `cluster_overview`'s line; D195
- [x] The prompt's words; the MCP page; the live-session e2e; docs
- [x] Review; fixes (below)

### Departures from the spec in part 4

1. **The readers say what they didn't read.** `advice` returns `{ clusters, more, errors }` rather than an array, so
   the tool can say "N more GKE clusters … not read" and a listing's failure; `alerts` returns the counts (`cut`,
   `unreadable`, `unplaced`) beside the rows, so the list never reads as all clear when it isn't (no silent all-clear,
   as D188). The head counts with "+" then.
2. **`gcp_alerts` reads every resource type through a new pure `alertRows`** (`packages/gcp/src/monitoring.ts`), on the
   same 60 s cache as the view. A non-cluster resource's labels are kept at the read (`RawAlert.resource.other`: up to
   six, keys `^[a-z_]{1,40}$`, never `project_id`, values cleaned, redacted and cut to 120), so main still keeps no
   other field of Google's row (part 3's L6). A Kubernetes row's GKE cluster is named only when its location and
   name are GKE's shapes.
3. **D194's hold is on the gateway session itself** (`GatewaySession.hold(why)`; `McpGateway.hold` is unchanged), not
   `gateway.hold(acpSession, …)`: the session's kube tools are built before Claude Code's session id is bound. The
   session series takes a fourth argument, `google: { projects, hold }`, set once the gateway has answered; before
   that it is `NO_GOOGLE` (no project), so no call can read Google early.
4. **`cluster_overview`'s line** says when Landlens read what it counts ("as Landlens read them at 09:12 UTC"), is
   made from the last view of this very connection (by context, address and trust, as `gkeOf` decided) in the last
   10 minutes, and is absent otherwise. A limited session counts the alerts in its namespaces and says how many more
   there are; a failed or cut read says so ("couldn't be read", "3+").
5. **D195's limit is wider than "the context the session is connected to"**: a listed GKE cluster at the session's
   address (another name for the same cluster) is limited too, a Kubernetes alert whose cluster can't be told counts
   as the session's own, and so does any cluster when the listing can't be read. `limit` is async. A namespace given
   with the cluster or node scope doesn't open them. `gcp_alerts` with an `id` outside the limit answers as not open.
6. **`gcp_metrics`' reference gauges** are read over the last hour (60 s steps) whatever the range: only their latest
   value counts. A reference read that fails leaves its line out with a note; a usage read that fails is the call's
   sentence.
7. **The whole answer is cut at 24,000 characters** after a second redaction, with a note; the spec named per-field
   cuts only.
8. **The grant's dialog** for a dropped yes is titled "Let Claude read these Google Cloud projects again?" and begins
   by saying why; the card's line has its own **Turn it on again…** button.
9. **The dialog itself has no screenshot**: it is a native sheet, which the e2e answers in main; its message and
   detail are asserted there, and the card's line before and after is shot (`g9-p4-01`, `g9-p4-02`).

### [check] items settled or moved by part 4

- **[check 6]** (quotas): the tools read through main's caches (advice 10 minutes, alerts 60 s, policies 10 minutes,
  PromQL 25 s in its slot), 30 calls a minute a session, at most 10 clusters' suggestions and 6 PromQL queries a call.
- **[check 1]** stays the person's live check; `gcp_metrics` uses the same labels and draws nothing (with
  `LabelsLost`'s sentence) if `by` drops them. [check 2], [check 3] and [check 7] are unchanged.

### Security review of part 4, fixed

No High; three Medium, five Low and eight missing tests, all fixed as the review proposed; where a fix goes further or
chose differently, the item says why. Each fix was seen to fail its test with it taken out (43 mutations, one per fix
or rule, each run against its own test files, then restored; none survived).

- [x] **M1** A session's Google projects are live. `SessionGoogle.projects` (and `AgentGoogle.projects` in
  `packages/metrics`) is a function: `mcp.ts`'s `sessionGoogle` returns `gcp.projectsNow(start)`, which is
  `GcpService.agentProjectsNow` = `readable() ∩ start` (the grant on, the project still chosen and still granted, as
  `agentReader`'s `allowed` already was), so turning reading off, another gcloud account or a project taken out (and
  chosen again: it has left the grant) stops the open session's kube `metrics` and `cluster_overview`'s line at the
  next call. Beyond the proposal: `gcpOff()` bumps `gcpEpoch`, and a session begun before it has no projects even after
  the person turns reading on again (a new yes is for new sessions, as D93 says of a project granted later);
  `MetricsService` checks `projects()` before each query and again on delivery, so a wave of queries in flight stops at
  the next one and none is delivered ("not granted"); `agentOnly` checks after its read too, as the item reads do.
  Tests: `gcp-service.test.ts` (off with a read in flight, an account change, a project taken out and chosen again:
  no projects, no line, the read in flight not delivered), `mcp-main.test.ts` (after off the old session's projects
  and line are gone; a new session gets them), `service.test.ts` (withdrawn after the first query: one query asked, not
  five; the "not granted" reason). T3 is these tests.
- [x] **M2** The namespace limit fails closed. `listClusters` keeps a cluster's DNS endpoint beside its IP (`dns`,
  dropped by `publicCluster` before anything leaves main), and `sessionLimit` places the session's cluster by its
  context, either listed address (`endpoint` or `dns`, compared as origins) or the SHA-256 of the CA its sidecar checks
  (`mcp.ts` passes `ca` only when TLS is verified: no `insecure-skip-tls-verify` and no `tls-server-name`, since an
  unchecked CA proves nothing). A session no cluster of the listing matches is limited on every cluster, and so is one
  with no server or whose listing can't be read (gcloud signed out: T4). Another listed cluster has no limit only when
  the session's own cluster was placed and it isn't that one; an unlisted context is limited.
- [x] **M3** Kubernetes is decided from the labels. `slim` marks a row `kube` when its type is `k8s_*`, `gke_*` or
  `gce_instance`, or any label key has a `cluster`, `namespace`, `pod`, `node` or `container` word (so `k8s_service`,
  `istio_*`, `gke_container`'s `namespace_id`, and types Landlens has never seen). `alertRows` gives every Kubernetes
  row its cluster (`cluster_name`, or `cluster` as Prometheus targets name it) and its namespace (the one distinct value
  among `namespace_name`, `namespace` and `namespace_id`, a valid Kubernetes name, else none). `gcp_alerts` shows a
  limited session a Kubernetes alert only when its namespace is told and inside the limit (or its cluster is told and
  isn't the session's); every other is counted in "N alerts outside this session's namespaces aren't shown."
  Departures: a `location` label alone isn't a Kubernetes sign (Cloud Run, Cloud SQL and load balancers have one, and
  would all be hidden); a `gce_instance` alert is treated as Kubernetes with no cluster or namespace, so a limited
  session never sees one, in any project (a GKE node is a Compute Engine VM, and Landlens can't tell which VMs are the
  session's nodes; the review proposed the session's own project only). **[check]** The label keys (`namespace_id`,
  `pod_id`, `gke_container`'s set, `istio_*`'s) are from memory, not checked against the real Monitoring API; the
  key rule covers names Landlens doesn't know, and a row with none of these words and an unknown type stays outside.
- [x] **L1** `GcpReader.alert(project, id, show)` checks `show` before the policy is read, and `gcp_alerts { id }`
  passes the session's own rule; an alert outside the limit is "No open alert <id> in <project> now. gcp_alerts lists
  them.", the same sentence as one not open, with no `alertPolicies` request.
- [x] **L2** `serveTexts` stores each text and its JSON-escaped form (`JSON.stringify(t).slice(1, -1)`) when they
  differ, so a quote copied out of the tool's answer (a `"` printed as `\"`, a `\` as `\\`) is found.
- [x] **L3** A per-session budget: `sessionSeries` keeps 30 calls a minute that would ask Cloud Monitoring for each
  session's `google` (`SESSION_READS`; past it `MetricsService` asks nothing and says "At most 30 Cloud Monitoring
  reads a minute in a session …", and the tool answers from metrics-server). Beyond the proposal, since the budget is
  per session and sessions are many: all sessions' PromQL together (the kube tool and `gcp_metrics`) has at most 12
  places in the waiting line (`AGENT_PROMS`, past it `PROM_BUSY`, nothing asked), leaving the rest of the 4 + 40 to the
  person's charts; and a 403 or 429 a session's query gets isn't kept for the project, so a session can't make the
  person's charts say Google is limiting requests for a minute (their own 403 or 429 is kept as before).
- [x] **L4** `gke_recommendations` and `gcp_alerts` put their notes (hidden, more, cut, couldn't list or read, the
  first 1,000) after the head and before the rows, so the 24,000 cut takes rows, never them.
- [x] **L5** `confirmedRefs` keeps when `gkeOf` said yes; `heldLine` uses it only for `CLUSTERS_TTL` (60 s, the
  listing's own age), and a later answer that isn't a cluster (no, a hint, unread) forgets it.
- [x] **T1** `mcp-main.test.ts`: a session with a GitHub remote, autonomy on, `s.google.hold()`, and `autonomyCheck`
  says `WHY.gcp`. **T2** `packages/acp-host/test/session.test.ts`: a delayed `SessionMcp.open` whose kube `metrics` call
  sees `NO_GOOGLE` (no projects, no line), then the gateway's `google` for later calls and a call's own copy. **T3** is
  M1's. **T4** is M2's: no server and an unreadable listing each limit every cluster. **T5** `server.test.ts`: the three
  new tools count against the 30 a minute, one each per call. **T6** `gcp-service.test.ts`: for advice, alerts, an
  alert and metrics, an account change or the project taken out while the read runs is a 409 or the "Choose …" 404,
  not `agentOnly`'s 403. **T7** `gcp-service.test.ts` drives `landlens-gcp` through the real `GcpService` reader against
  the fake (M2's CA placement, M3's and L1's alerts, L2's quoted text). **T8** `heldLine`'s project check is
  `agentProjectsNow` alone (the separate `kept.projects` check went: `readable()` already holds it), tested with the
  project still held but out of the session's grant.
