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

## Part 2: Cloud Monitoring as a metrics source (D179–D184)

- [ ] `fake-gcp.ts`: the PromQL route with the scope model and the leak; `monitoring.ts` `promRange`
- [ ] `cloud-monitoring.ts` (queries, parse, series, `gkeHasData`); `cloud-monitoring.test.ts`
- [ ] `service.ts`'s branch and reasons; contracts; `service.test.ts`
- [ ] Main: `promAsk`, the wiring, the cache; `MetricsNotice.tsx`; `metricsText`
- [ ] The e2e's (a) Metrics tab and (b) Overview; docs; review; fixes

## Part 3: alerts (D185–D189)

- [ ] `fake-gcp.ts`: alerts and the policy; `monitoring.ts` `openAlerts`, `clusterAlerts`, the policy read; tests
- [ ] `clusterView`'s alerts half, `gcp:cluster-item`, `briefs.ts`; `gcp-service.test.ts`
- [ ] `problemRules.ts`, `Problems.tsx`, `AlertDrawer.tsx`, the Overview's lines, ⌘K
- [ ] `quotes.ts` heads, `GCP_QUOTE`, the questions (and Ask on a suggestion, from part 1); the e2e; docs; review;
  fixes

## Part 4: Claude's tools (D190–D196)

- [ ] The grant's `covers`, the dialog, the card's line
- [ ] `GcpReader`'s new methods and `agentReader`; `server.ts`'s three tools; `server.test.ts`
- [ ] D194: `mcp.ts`, `index.ts`, `service.ts`; `cluster_overview`'s line; D195
- [ ] The prompt's words; the MCP page; the live-session e2e; docs; review; fixes
