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
- [x] Fable's security review of part 1: no High, six Medium, eight Low, all fixed (below)

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

### Security review of part 1, fixed

No High; six Medium and eight Low, all fixed as the review proposed; where a fix goes further or chose differently,
the item says why. Each fix was seen to fail its test with it taken out (36 mutations, one of them on OrbStack, each run
against its own test, then restored; none survived). Layered checks fail with every layer removed: they are said in the item.

- [x] **M1** A private key logged a line at a time is redacted on every line of it. `@landlens/kube`'s `scrubLine`
  keeps a stream's state (`KeyState`): from a line with a key's BEGIN, every line is `<redacted private key>` until the
  line with its END, at most `KEY_LINES` (200) lines, a leading timestamp kept. The front door scrubs a followed text
  stream with one `LineScrubber` per response (so `kubectl logs -f` gets it too), and a log read whole with
  `scrubLines`; the view runtime's `LogFeed` keeps one state per pod (`logLines`, cleaned first). **Beyond the
  proposal**: a read whose window begins inside a key (a tail, a `sinceTime`) never saw the BEGIN, and on OrbStack the
  API server sends that tail a line a chunk, so its body went out before its END (`kubectl logs -f --tail=5`, seen
  live while writing the integration test). Now an END with no key open takes back the base64 lines right before it in
  the same batch (`scrubBatch`, as `redactPart` takes a leading END's text); the front door's `LineScrubber` holds a
  stream's *leading* run of base64-only lines (from a line of 16 or more) until the first other line says what they
  were (an END: redacted; anything else: released; the stream's end: redacted); the runtime asks for `tailLines` +
  200 and keeps its last `tailLines`, so it sees the BEGIN. Tests: `redact.test.ts` (scrubLine, the 200-line cap,
  scrubBatch's lead-in, LineScrubber), `frontdoor.test.ts` (a key split across two chunks at six places, a line a
  chunk, a tail that begins inside the key, in one chunk and a line a chunk, a log read whole), `view-runtime.test.ts`
  (a key logged in chunks split mid-line, and kept lines that begin inside a key; each with the fake's front-door
  scrub and without it, so the runtime's own layer is held), and on OrbStack (below).
- [x] **M2** `$status` is a cell. `statusOf` cleans a Pod's reasons and an Event's type (`cellText`, 64), and `$status`
  goes through `cellText` again. Layered: either alone is enough (every other branch is fixed words or already
  cleaned), so the mutation removes both. Tests: `path.test.ts` (an Event's type and a Pod's `status.reason` and
  waiting reason with a newline, U+200B, U+202E and 3,000 characters: one clean line of at most 64; a property test
  over 300 hostile objects, every kind and group, that every computed name's string is `cellText`'s own).
- [x] **M3** Main's work is bounded. (a) A join has a work budget (`joinWork`, 500,000: right rows indexed, each label
  for a selector join, then every candidate compared, times the join's takes and aggregates), checked as it goes and
  before anything is taken; past it `JoinTooBig`, and the source is `error` with "Joining *x* here is too much work to
  do live: filter or limit either side first." and no rows. A selector join indexes the right side by each `k=v` and
  takes a left row's candidates from its rarest pair. *Chose differently*: a work budget rather than also a 2,000-row
  cap on the right side, since a hash join of 2,000 Deployments against 10,000 pods is cheap and common; the budget is
  what the review's 13 s cost. (b) A feed's change marks its sources dirty and they are computed once, when their push
  is due (one timer per view), off the watch's callback. (c) A source reads at most `sourceObjects` (10,000) over all
  its watches. Tests: `transform.test.ts` (10,000 × 10,000 on one key with eight aggregates and 5,000 × 10,000 by
  selector refused in under 200 ms; 2,000 Services × 10,000 pods by selector worked out in under 500 ms; the budget at
  and one past), `view-runtime.test.ts` (twenty watch batches in one push interval computed at most twice; the join's
  sentence; `sourceObjects`).
- [x] **M4** The refused-tag check is linear: `</?(tags)(?![A-Za-z0-9-])`. *Chose differently*: no whitespace rather
  than bounded whitespace, since HTML takes none between `<` and a name (`< iframe>` is text; the CSP is the wall).
  Test: `schema.test.ts` (`<` and 140,000 spaces, newlines or tabs validate in under 100 ms; `< iframe>` passes;
  `</IFRAME>` past 100,000 characters is refused).
- [x] **M5** A view's memory is bounded by characters, not only objects. Each watched object is trimmed as it arrives
  (`ResourceWatcher`'s `project`) to `projection.ts`'s Keep: the metadata a row and `_ref` need, what every computed
  name reads (each row's `_tone` included) and what each field path of the sources on that watch reads (a path's
  names, `[n]` and `[*]` passed through, its end kept whole); sources on one target share one watch with their Keeps
  merged (the Keep is in the feed's key). The view's watches share a `WatchBudget` (`viewObjects` 20,000, `viewChars`
  32 MiB of JSON, each object measured once as kept): past it a watch stops adding (an object that grows past it is
  dropped) and the source says "This view keeps too many objects in all…" (`viewCut`, not the review's `watchCut`:
  it's the view's budget, not the watch's cap); a stopped watch gives its share back. A source's rows hold at most
  `sourceChars` (8 MiB) after its pipe, else cut and said (`rowsTooBig`). A view stopped while hidden clears its
  sources' rows and joined rows. Tests: `projection.test.ts` (a trimmed object holds no leaf outside its Keep, and
  reads the same as the whole one for every computed name and path), `watch.test.ts` (project and a shared budget:
  4 of 3 + 3 kept, the share given back on stop; characters: an object grown past the budget dropped),
  `view-runtime.test.ts` (`viewObjects`: 4 of 3 + 3 delivered and said; a 200,000-character ConfigMap fits a 2,000
  budget when only `data["small"]` is read, and doesn't when `data["blob"]` is; `sourceChars`; a hidden view keeps no
  rows).
- [x] **M6** Nothing read for an older parameter is delivered. Each source's `sig` is its document, its reads, the
  parameters and the sigs of the sources it joins; kept data is kept only when the sig is unchanged, else the source
  starts empty and `loading`. While a sync waits on discovery (`v.ready` behind `v.gen`) nothing is computed or pushed
  (a feed's change, the compute timer and the push each check; each is enough alone, the mutation removes all three),
  and `data()`, `status()` and `shows()` answer loading, nothing and false. Tests: the existing test now looks at every
  push of any state and at `shows()`; a new one holds discovery after a parameter change and adds a pod to the old
  namespace meanwhile: no push carries `a` or `a2`, `data()` is empty and `shows()` false during the wait.
- [x] **L1** `checkParams` runs before the token is issued, and anything that throws once it exists revokes it. Test:
  three refused opens leave no grant and none issued; a client that throws leaves one issued and none live.
- [x] **L2** kubectl's words for a Pod or a Node only for core's kind (`statusOf(kind, o, group)`, `ReadContext.group`;
  `$ready` and `$restarts` too); `status.ts` reads only lists as lists, `?.` on every element, reasons as strings and
  restart counts as finite numbers; `compute` is wrapped, and a failure is the source's `error`, "Landlens couldn't
  work out this source's rows." (*chose differently*: not `noAnswer`, since the cluster did answer). Tests: a
  Longhorn-shaped `Node` CR (unschedulable: core's words would say SchedulingDisabled; conditions as a map: no
  throw), a malformed doctor report (the sentence, no unhandled rejection), `status.test.ts` (maps, nulls and strings
  where lists belong).
- [x] **L3** Each source is planned into its own list of reads and takes them only if all fit (`overLimit` otherwise).
  Test: `"*"` over 30 namespaces: the sentence, no watch open, no request sent.
- [x] **L4** `plan()` refuses `kube.top` of nodes in a namespace-limited view (`scopeCluster`) before any request;
  `view-fakes.ts` discovers `nodes.metrics.k8s.io` (cluster-scoped) and `pods.metrics.k8s.io` as a cluster with
  metrics-server does, so the token alone would let it through. Test: forbidden, no `metrics.k8s.io` request.
- [x] **L5** `Id` refuses `constructor` and `prototype`; parameters are a null-prototype object; `namespacesOf` reads
  own parameters only. Tests: the schema refuses a parameter and a source named so; `namespacesOf` with an inherited
  name gives the whole limit. (The null prototype is a layer under `Object.hasOwn`, not tested apart.)
- [x] **L6** A view with a `kube.events` source recomputes it every `eventsTick` (60 s), through the same dirty set.
  Test: with an injected clock, an event 59 minutes old leaves the rows two minutes later with no watch event.
- [x] **L7** `narrowLimits` and `checkTimes` take own names only (`Object.hasOwn`). Test: `toString`, `constructor`,
  `hasOwnProperty` refused for both.
- [x] **L8** `view-fakes.ts` scrubs as the front door does for a redacting token (redactObject on JSON and each watch
  event, a LineScrubber per followed log, scrubLines on a whole one); `api.scrubs = false` only to hold the runtime's
  own layer. Test: `spec.containers[0].env[0].value` is `<redacted>` and no push holds `hunter2` (fails with the fake's
  scrub off and with `redact: true` taken out of `agentReadOnlyPolicy`).

On OrbStack (`LANDLENS_INTEGRATION=orbstack`, 8 tests, run five times after the last change): the throwaway
Deployment's container also logs a made-up private key a line a second every ten ticks. A workload's followed log in a
view shows `<redacted private key>` and no line of the body; a followed read through the front door with the view's
token (`kubectl logs -f`'s path) sees two whole keys redacted, one at least logged live a line a chunk; and a follow
whose `tailLines` was chosen (from `kubectl logs` as you) to begin just after a BEGIN starts with `<redacted private
key>` and shows none of the body. With the stream's leading run not held, that last case leaks on OrbStack (the
mutation run).

Left as they are, and why:

- A key longer than 200 lines, or a tail that begins at a key's last body line when it is shorter than 16 characters
  (a few bytes), is not taken whole on a followed stream: the cap keeps a lone BEGIN from hiding the rest of a log,
  and a shorter run start would hold ordinary one-word lines.
- The front door holds a followed log's leading base64-only lines (16 characters or more) until another line comes: a
  container whose first lines are such and then goes quiet shows them late.

## Part 2: the page and Claude, with app blocks

- [ ] As section 13 lists, and e2e 1–4 (without the action intent), 6, 7 and 9
- [ ] From part 1's security review, for part 2 (not part 1 bugs):
  - `open()` takes `namespaces` from its caller. It must come from main's record of the building session, never from
    the page or a tool argument; omitted means the whole cluster.
  - A push carries no version or generation, so the page can't drop a push that belongs to an older document.
  - `VIEW_LIMITS.frameMessage` isn't applied: a source can push 2,000 rows × 24 fields × 2,000 characters a second.
  - Field names `toString` and `valueOf` are allowed, so a row can own a non-function `toString`; `String(row)` or a
    template literal in the renderer would throw.
  - `REFUSED_TAGS` is a courtesy list (no `frame`, `frameset`, `portal`, `script src`); the CSP has to be the wall.

## Part 3: native blocks and actions

- [ ] As section 13 lists, and e2e 2, 4's intent and 5

## Part 4: keeping views and the connections

- [ ] As section 13 lists, and e2e 8 and 10, and the live test
