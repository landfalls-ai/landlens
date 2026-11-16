# Wave 10: Views on demand — tasks

The spec is [spec.md](spec.md) (D202–D225). Each part ends running on OrbStack, with its tests green, its docs moved
and a Fable security review. No test reaches Google, GitHub or Linear; Kubernetes writes only in `landlens-dev`.

## Part 1: the engine (D202, D206–D211, D214, D222, D225) — built 16 Nov 2026

- [x] `packages/views` (new): `limits.ts` (D225's numbers in `VIEW_LIMITS` and `VIEW_TIMES`; `narrowLimits` and
  `checkTimes` refuse a raise, 0, NaN, Infinity and an unknown name), `errors.ts` (D222's sentences, a pointer and
  one sentence per zod issue, at most 20), `text.ts` (`cellText`: one line, cleaned, redacted, then cut;
  `docText`: a document's text refused when it carries an invisible character), `path.ts` (D207's field paths:
  names, quoted keys, `[n]`, `[*]`; own properties only; never `__proto__`, `constructor`, `prototype`),
  `computed.ts` (the `$` names, `statusOf`, the owner index for `$workload`), `rows.ts` (rows and `_ref`, the default
  list and event fields), `transform.ts` (D208's eight steps, joins by value and by selector), `schema.ts` (D206,
  every object strict, the part-1 sources and every block), `patch.ts` (D214: add, remove, replace, move, stale
  `base` refused first, the document unchanged on any failure); `schema.test.ts` 22, `path.test.ts` 14,
  `transform.test.ts` 12 (a seeded property test over 400 pipelines), `patch.test.ts` 7
- [x] `@landlens/contracts`: `ViewId`, `RowRef`, `ViewCell`, `ViewRow`, `ViewSourceState`, `ViewLogLine`, `SourceData`
- [x] `@landlens/kube`: `ResourceWatcher` takes `labelSelector`, `fieldSelector` and `maxItems` (with `truncated`);
  `frontDoorFetch`, a `fetch` for `KubeClient` that reaches only the front door, with one token and its CA pinned;
  `watch.test.ts` (+4), `frontdoor-fetch.test.ts` 6 (against a real front door and a fake sidecar)
- [x] `apps/desktop/src/main/view-runtime.ts` `ViewRuntime`: a token per view, `view · <context>`,
  `agentReadOnlyPolicy(namespaces)`, revoked on close, when the cluster goes and on reload, crash or quit; feeds
  shared by target; `kube.list` and `kube.events` as watches (1 s batches, 10,000 objects, hidden ReplicaSet and Job
  watches for `$workload`), `kube.logs` followed, `kube.top` every 15 s, `metrics.series` every 60 s, `doctor.problems`
  every 15 s, `helm.releases` every 60 s; joins; pushes at most one a second per source; Refresh at most once in 5 s;
  hidden 30 s, its reads stop; nothing read for an older version, parameter or a closed view is delivered;
  `view-runtime.test.ts` 26 against `view-fakes.ts` (an in-memory front door and API that apply the real token policy)
- [x] `main/index.ts`: the runtime made (doctor, Helm and usage wired), closed with the agent sessions on reload,
  crash and window close, and at quit
- [x] Integration on OrbStack, `apps/desktop/test/view-runtime.integration.test.ts` 7 (below)
- [x] Docs: [security.md](../../security.md#views-on-demand), [architecture.md](../../architecture.md),
  [development.md](../../development.md), [limitations.md](../../limitations.md), [roadmap.md](../../roadmap.md),
  [plan.md](../../plan.md), this folder, [history.md](../../history.md), `CLAUDE.md`'s layout
- [ ] Fable's security review of part 1

### Where part 1 departs from the spec

1. **The document's type stays in `@landlens/views`.** Section 13 has contracts re-export it; contracts can't import
   views (views imports contracts), so contracts holds what crosses IPC (`RowRef`, `ViewId`, `SourceData` and the cell
   and row types) and the schema lives with its package.
2. **`@landlens/views` uses `@landlens/gcp`'s `clean`** (the one cleaner that also takes private-use, unassigned,
   lone surrogates, variation selectors and blank letters, after wave 9's review), `@landlens/kube`'s `scrubCut`
   (redact before cutting) and `@landlens/metrics`'s container resources. No second copy of any of them.
3. **Part 4's source kinds aren't in part 1's schema.** `gcp.*`, `clickland.*` and `tool` are refused as unknown
   kinds until part 4 adds them with their runtime.
4. **Drift since wave 8: `metrics.series` takes contracts' `MetricsScope`** (`cluster`, `namespace`, `node`,
   `deployment`, `statefulset`, `daemonset`, `pod`), not a single `workload` scope. **Drift from wave 9:** a series
   can now come from Cloud Monitoring; a view's usage is read as a Claude session's with **no Google grant**
   (`sessionSeries` with no grant takes no Cloud Monitoring read), so a GKE cluster's view shows Clickland's,
   Prometheus's or the sampler's numbers only. Part 2's `view_context` must say so.
5. **Three more computed names**: `$selector` (a workload's selector, for selector joins), `$object` (an event's
   involved object's key) and `$last` (an event's last time). An event row's `_ref` is the Event itself; a bare pod's
   `$workload` is its own key.
6. **More limits, each only narrowable**: 24 fields a source, 24 distinct reads (feeds) a view, 5 pods a workload's
   log follows, 4 open views. The runtime's limits and times go through `narrowLimits` and `checkTimes`.
7. **More fixed sentences**: usage of the whole cluster or a node in a namespace-limited view (`scopeCluster`); a
   source whose reader isn't wired (`doctorOff`, `helmOff`, `metricsOff`); a join whose other side isn't read whole
   (`joinMissing`, `joinCut`); the hidden owner watches unread ("a pod's workload may stop at them").
8. **The doctor is polled every 15 s**, since `DoctorService` has no push, and always for every namespace (the
   Overview's scope), so a view never takes one of the doctor's two scopes a cluster; main keeps only the view's
   namespaces' problems, in D211's closed shape, and says which checks were skipped.
9. **`"*"` in a namespace-limited view is one watch per namespace of the limit**, never an all-namespaces list the
   token would refuse.
10. **A workload's log follows started pods only**, the running and newest first: a Pending pod has no log and is
    looked for again every 30 s; one pod's log that can't be read (starting, gone) doesn't fail the source, a 401 or
    403 does. Lines from several pods are merged by time; the last `tailLines` (at most 500) are kept.
11. **The integration test is in `apps/desktop/test/view-runtime.integration.test.ts`** (the runtime is in desktop's
    main), not `packages/views/test/orbstack.test.ts`; desktop's `test:integration` now runs it and its `test`
    excludes integration files.
12. **No window, no IPC.** The runtime exists in main and closes its views with the agent's sessions, but nothing
    opens a view until part 2 gives the page its channels; its pushes go nowhere. Its public methods validate their
    arguments with zod (handle, at most 50 namespace names, parameter names and values, view ids) as a channel would.
13. **Text in a document with an invisible character is refused**, with a pointer, rather than cleaned silently
    (variation selectors are stripped first; tabs and newlines are allowed where a field has lines). Refused tags are
    checked in a fragment's `html`, `css` and `js` alike.
14. **A path whose value is an object or a list gives no value** (`null`): a cell never carries JSON.
15. **Defence in depth, by mutation.** Nothing read for a closed view reaching the page is held three times (a poll's
    own run number, the runtime's current-feed check, the push's generation check); the test fails only with all
    three removed. `frontDoorFetch`'s dropping of the caller's sidecar header and its pinned CA are likewise held by
    the front door (which sets the header itself) and by Node (which refuses an unknown CA): their tests pass with
    either removed.

### [check] items settled or moved by part 1

- **`metrics.k8s.io` and `pods/log` for a view's token: settled, both allowed.** On OrbStack the front door let every
  `GET /apis/metrics.k8s.io/v1beta1/namespaces/landlens-dev/pods` and every `…/pods/<name>/log` through under
  `view · orbstack` (`allowed: true` in its audit). The logs answered 200 and arrived scrubbed (a `ghp_` token in the
  line became `<redacted github token>`). OrbStack has no metrics-server, so `metrics.k8s.io` answered 404 from the
  API server and `kube.top` said "This cluster has no metrics-server…" with state `unavailable`; the test asserts
  `ok` instead where one is installed.
- mcp-ui's `notify`, "SEP-1865" (D204) and GitHub's and Linear's read tools answering JSON as text (D212) are parts 2
  and 4's.

### Integration on OrbStack (`LANDLENS_INTEGRATION=orbstack`)

A real front door and sidecar, the view's own token, a throwaway Deployment (busybox, a ticking log line with a
`ghp_` token, an env value) and ConfigMap made with `kubectl apply` in `landlens-dev`, deleted at the end: the pod list
goes live when the test scales the Deployment to 2, with `$workload` naming the Deployment and the env value
`<redacted>`; every request of the view's in the audit is a GET by a read token; the ConfigMap's last-applied
annotation is gone and `password=…` is `password=<redacted>`; the token's policy refuses Secrets (namespaced and
cluster-wide), a DELETE and `kube-system`; a workload's log followed and scrubbed; `kube.top` as above; Helm's
`landlens-demo` with exactly the eight fields; after close, no request of the view's is let through. 7 tests, run twice
after the last change.

### Safety rules removed one at a time

42 mutations of the runtime, `frontDoorFetch`, `ResourceWatcher` and `@landlens/views` (the token's namespaces,
revoke on close and when the cluster goes, the namespace refusal, `"*"` as the limit, the push rate, the hidden stop,
the watch and row cuts, the owner and join sentences, no all-clear over a failed read, the doctor's namespaces, text
and skipped checks, log cleaning, tail and pod cap, Helm's shape and unreadable count, the open-view and Refresh caps,
strict arguments, parameter checks, limits only narrowing, cluster usage in a limited view, a read keyed by its whole
target, the front-door-only URL, abort, the watch cap on lists and adds and its validation, selectors, no Secrets,
refused tags, `__proto__` in paths and pointers, own properties only, finite limits, cells scrubbed and cleaned first):
each failed its test. Four survived at first: two led to tests (a single page over the cap; an invisible character
splitting a credential before the scrub), and two were layered checks (departure 15): the closed-view case now fails
with every layer removed, and the parameter-change case is proved through a read keyed by its whole target.

## Part 2: the page and Claude, with app blocks

- [ ] As section 13 lists, and e2e 1–4 (without the action intent), 6, 7 and 9

## Part 3: native blocks and actions

- [ ] As section 13 lists, and e2e 2, 4's intent and 5

## Part 4: keeping views and the connections

- [ ] As section 13 lists, and e2e 8 and 10, and the live test
