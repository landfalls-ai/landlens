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

Built 16 Nov 2026 ([views.md](../../views.md)).

- [x] As section 13 lists, and e2e 1, 3, 4 (without the action intent), 6, 7 and 9 (`apps/desktop/test/views.e2e.test.ts`,
  7 cases with the fake agent on OrbStack, plus D214's undo and redo), and the live case once with the person's Claude
- [x] From part 1's security review, for part 2 (not part 1 bugs):
  - [x] `open()` takes `namespaces` from main's record of the building session (`AgentService.namespacesOf`), never
    the page or a tool argument (`views-main.test.ts`: the page asks for two, the session has one, the token has one).
  - [x] A push carries the version it belongs to (`ViewDataPush.version`, stamped by `ViewService.onPush`); the
    window drops one for another version or another view (`view-store.test.ts`).
  - [x] `VIEW_LIMITS.frameMessage` is applied to every push and to a frame's first data (`fitData`: rows halved then
    grown to fit, `truncated` and a fixed note; log lines cut from the oldest; a series dropped last).
  - [x] Field names `toString`, `valueOf` and every other `Object.prototype` name, and `prototype`, are refused.
  - [x] The CSP is the wall: a block's frame has `connect-src 'none'` whatever it declares; e2e 4 checks that the
    frame's CSP violations name `connect-src` and `img-src` (Chromium's own rule against loopback requests from an
    opaque origin would stop the probes too, so "nothing reached the listener" alone doesn't show the CSP). Part 2's
    review found that too thin, and the probes aimed elsewhere (M4 below): e2e 4 now names every attempt's directive
    and reads a net log.

### Departures

1. **The chat folds to a strip at the bottom edge, not a side strip.** Once a version exists the view has the page and
   the chat is one line under it (Claude's last line, a composer, the button that opens the dock); ⌘J opens the dock
   beside the view. The dock is the view's session (`AgentDock`'s `bound` mode), mounted from the session's start so it
   hears every update and every question, hidden until opened; a question from the session opens it.
2. **One open view per window**, kept in the window's store until **New view**, a reload or a disconnect; going to
   another page and back finds it (its sources stop 30 s after the page leaves, D210).
3. **Native blocks are plain until part 3** (`ViewBuilt.tsx`): a table of text cells, a stat, a list, log lines, the
   doctor's rows, text, a chart's points as a small table. No `ViewHeader.tsx`: the header is part of `ViewsPage.tsx`.
4. **Save, Export, Duplicate, tweaks, example chips and saved views are part 4's**, with the gateway's origin `"view"`
   (only `tool` sources need it). The action and ask intents are refused until part 3.
5. **`view_data` is answered by `ViewService` in main** (the block's frame → `views:app-call`), not through the gateway:
   the gateway's `view_data` handler serves Claude's own session and the tool is app-only there. `mcp:app-call`
   refuses a block's frame outright (403).
6. **Undo and redo are built and unit-tested here** (`ViewHistory`, 20 versions, a patch must name the shown version),
   and checked in the e2e (D214); e2e 2 (a patch's restart of undo and redo across a follow-up) stays part 3's.
7. **View source is a `<pre>`**, not CodeMirror; **Copy document** is the only export.
8. **`view_context`'s usage line names no source**: it says usage over time comes from Clickland, Prometheus or the
   sampler, whichever this cluster has, and never Cloud Monitoring (a view has no Google grant), without probing which.
9. **Opening an object from a view goes to the object's own page** (as from the Agent page), not a drawer over the view.
10. **The fake agent's `view-script:`** reads `test/fixtures/views/<name>.json` (`pods-table`, `app-block`,
    `hostile-block`, `bad-spec`, `configmaps-table`) and writes each answer to `fake-agent-results.jsonl`.
11. **`view-store.test.ts` is typechecked with `tsconfig.web.json`** (it imports the window's store), and excluded from
    `tsconfig.node.json`.

### [check] items settled

- **mcp-ui's older action names** (spec §1): not needed. The installed `@modelcontextprotocol/ext-apps` 1.7.5's README
  says MCP-UI's client SDK "offers a fully-featured MCP Apps framework", so `@mcp-ui/*` speaks MCP Apps' JSON-RPC;
  no host Landlens talks to sends `tool`, `prompt`, `link`, `intent` or `notify`, and a block that does gets
  "Method not found" (`-32601`). No mapping was built.
- **"SEP-1865"**: confirmed. The same README's Resources list "Specification (2026-01-26)" and "SEP-1865 Discussion"
  (`modelcontextprotocol/modelcontextprotocol` pull request 1865). The docs cite the package, its version and the
  protocol date, and the SEP number as the package gives it.

### Checks

`pnpm typecheck` 0; `pnpm -r test` (desktop 50 files, 723 tests; views 78; gateway 101 and 3 skipped; acp-host 35;
the rest as before); `pnpm -s build` 0; `views.e2e.test.ts` 7 of 7 with the fake agent on OrbStack, and the live case
once. Every part 2 rule was taken out once and its test failed: 23 in unit tests, and in the built app e2e 4 fails
without `view.el`'s `on…` rule, its address rule, the block's `connect-src 'none'` and the window's tool filter.

**Live (16 Nov 2026, the person's Claude through `claude-agent-acp`).** Asked "In namespace landlens-dev: how many pods
aren't Running, and a table of the pods with their status, restarts and age, the most restarts first.", Claude
called `view_context` and `render_view` and built "landlens-dev pods" v1 ("Not-Running count and pods table sorted by
restarts"): three `kube.list` sources of pods in `landlens-dev` (the pods; `notrunning`, a filter then a group;
`total`, a group), two stats (11 not Running, 25 pods) and a table "Pods by restarts" (pod, status, ready, restarts,
age; CrashLoopBackOff and Error rows in the bad tone), in about 25 seconds, with no question asked. The view's token
made two `GET /api/v1/namespaces/landlens-dev/pods`, both 200.

### Security review of part 2, fixed

One High, four Medium and eight Low, all fixed as the review proposed; where a fix chose differently, the item says
why. Each fix was seen to fail its test with it taken out (44 mutations, each run against its own test and restored;
three in the built app on OrbStack; none survived; one, a default stored as a pick, survived the first test, which
now checks what the page is told). `pnpm typecheck` 0; `pnpm -r test` (desktop 51 files, 739 tests; views 82;
acp-host 36; the rest as before); `views.e2e.test.ts` 7 of 7 with the fake agent on OrbStack.

- [x] **H1** A block's script could send data out through DNS (`<link rel="dns-prefetch">` is under no CSP directive;
  `X-DNS-Prefetch-Control: off` stops only anchors). `hardenApp()` appends
  `--blink-settings=dnsPrefetchingEnabled=false` before the app is ready (`BLINK_SETTINGS` in `security.ts`).
  Tests: `security-app.test.ts` (the switch and its one working spelling); e2e 4's hostile block adds a parsed and a
  scripted `dns-prefetch` link to `dnsprefetch-*.<run's host>`, and a `session.netLog` of the run must never name the
  host. Mutation: without the switch the net log names both, 24 times, and e2e 4 fails; the unit test fails too.
- [x] **M1** "Ask about this block" could be closed by cluster text (claude-agent-acp writes
  `<context ref=…>text</context>` and escapes nothing). `quotedBlock` writes each row as a JSON array and each log line
  as a JSON string, every `<` as `\u003c`, under the data line and a line saying so, inside a backtick fence longer
  than any run (a run over 16 cut to 16), cut inside the fence; the attached view's JSON escapes `<` too. Beyond the
  proposal for this one site, `resourceBlock` (`@landlens/acp-host`) writes every `</context` as `<\/context`, which
  covers an object's YAML from Ask, the older gap the review named. A log source's lines now count against the 50 as
  rows do (before, a block naming a log source and then a list got 50 lines and 50 rows). Tests: `views-main.test.ts` (an annotation and
  a log line holding `</context>`, `<context ref>` and 40 backticks, for a table and a logs block: no `<`, the fence's
  twin is the last line, every row parses back); `prompt.test.ts`. Mutations: rows unquoted, `<` unescaped, log lines
  unquoted, no fence, a fixed three-backtick fence, `resourceBlock` unescaped: each fails.
- [x] **M2** The link dialog showed 500 of up to 2,000 characters and called a block Landlens's `render_view`.
  `viewLink` refuses an address over `VIEW_LINK_SHOWN` (500) without a dialog, for every view, shows the rest whole,
  says when it carries data after `?`, and names a block "A block Claude built on the Views page (*view* · *block*)"
  from the caption `ViewService.appOpen` gives its frame (the document's checked title and the block's). Chose: a
  limit for all views rather than refusing a block's https links until part 3, so a block's link to the docs still
  works. Tests: `mcp-main.test.ts` (a block's 1,2xx-character link refused with no dialog; a short one's dialog text
  whole, with the caption and the query note; 500 exactly; a remote view's own name), `views-main.test.ts` (the
  caption). Mutations: no limit, the address cut to 100, the old asker, no query note, no caption: each fails.
- [x] **M3** A version refused on parameters was half applied. `ViewRuntime` keeps the person's picks apart from
  defaults (`picked`): `update` checks before it assigns and lets go a pick the new version doesn't take (its default
  is read), `setParams` refuses one, and both answer the picks kept, which `ViewService` holds as the view's `params`.
  `ViewService.version` calls `runtime.update` before `history.show` and pushes the state in a `finally`. Tests:
  `views-main.test.ts` (Undo to a version whose choice doesn't take the pick: `views:get`, the last pushed state and
  the next data push all v1, with v1's rows; a refused update leaves v2 everywhere; Claude's versions replacing the
  options under a default and under a pick are shown, a pick that still fits is kept, an unfit pick is refused).
  Mutations: history moved first, no push on refusal, a strict update, a default stored as a pick: each fails.
- [x] **M4** Caps without a test where they're applied, and an e2e 4 that proved little. `views-main.test.ts`: 2,000
  ConfigMaps with a 2,000-character value (an annotation that long is omitted by the front door): every push, `view_data`'s
  answer and a two-source block's first message under `VIEW_LIMITS.frameMessage` and `truncated`; 50 rows; at most
  20,000 characters and the cut line, inside the fence. The lower-stakes survivors too: `closeAll` closes frames, a
  view closed mid-start and mid-render (`views-main.test.ts`), the host's 1,000,000-character cap and tool-name check
  (`app-host.test.ts`), another view's `views:state` dropped (`view-store.test.ts`). e2e 4 aims every attempt at its
  own name under the run's random `views-e2e-<hex>.test` and asserts each CSP-governed attempt's own violation (18:
  `connect-src` ×5, `img-src` ×2, `font-src` ×2, `media-src` ×2, `style-src-elem` ×2, `script-src-elem` ×2,
  `frame-src`, `object-src` ×2) and a net log with no lookup or request of the host. **Found while fixing**: the fake
  agent gets only Landlens's allowlisted environment (`agentEnv`), so `LANDLENS_FAKE_PROBE` and `LANDLENS_FAKE_STUN`
  never reached it, and the old block aimed at `127.0.0.1:9`; the test now writes `agent-sessions/fake-agent-env.json`
  for the fake agent and checks the block named this run's host, and WebRTC now aims at the test's UDP listener.
  Mutations: each of the three `fitData` sites, the share, the cut, `ASK_ROWS` 5,000, the four survivors above, and in
  the built app a CSP of `script-src 'unsafe-inline'` alone: each fails.
- [x] **L1** `view.el` reads an address with `[\x00-\x20\x7f]` taken out and allows only `https:`, `mailto:`,
  `landlens:` and `#` (on `href`, `src`, `action`, `formaction`, `xlink:href`, `poster`, `data`, `background`, `ping`,
  `cite`, `srcset`, `codebase`, `manifest`); it throws for `script`, `iframe`, `frame`, `frameset`, `object`, `embed`,
  `link`, `meta`, `base` and `portal`, and drops `srcdoc`. A relative address is dropped now too. Tests:
  `packages/views/test/runtime.test.ts` (the runtime in a stand-in document); e2e 4's `el` line (`java\tscript:`,
  `\x01javascript:`, `view.el("script")`: null, null, refused, nothing ran). Mutations: the old address rule, the tag
  rule (unit and e2e), `srcdoc`: each fails.
- [x] **L2** A view's keys reach the app only while its frame has the focus (`AppFrame`: `document.activeElement` is
  the frame and the page has focus) and at most `KEYS_PER_SECOND` (4) a second, for every view. Test:
  `app-host.test.ts` (20 in a row give 4; a second later one more; none unfocused). Mutations: each check.
- [x] **L3** A usage reader's reason goes into the notes only while the read succeeds; a failed later read (`error`,
  whose message Claude hears) carries only the failure sentence. Test: `view-runtime.test.ts`. Mutation: fails.
- [x] **L4** `view_context` lists a kind only when its resource passes `ResourceName` and its group `GroupName`.
  Test: `views-main.test.ts` (a resource with a newline and a sentence, a group with spaces). Mutations: each check.
- [x] **L5** A version's note is the schema's `Text(200)` (`Text` now exported from `schema.ts`). Test:
  `server.test.ts` (U+202E, U+200B, a newline, a bell: refused at `/note`, on render and patch). Mutation: fails.
- [x] **L6** `views:prompt` carries the `version` the block was chosen in; `ViewService.prompt` refuses a block when it
  isn't the shown version (409, "The view changed since you chose that block: ask about it again."); the page keeps
  the version on the chip and drops the chip when the version changes. Tests: `views-main.test.ts`,
  `views-ipc.test.ts`. Mutations: the check in main, the version dropped in IPC: each fails.
- [x] **L7** `ViewService` listens to `clusters.onGone` and closes the cluster's views (frames, session, working
  view). Test: `views-main.test.ts`. Mutation: fails.
- [x] **L8** A new session for an ended one is one promise on the working view (`restart`), shared by follow-ups sent
  meanwhile, and closed again if the view closed while it started. Test: `views-main.test.ts` (two prompts at once,
  one start, one session). Mutation: fails.
- [x] **Noted**: `security.md`'s frame-navigation row now credits the page's `frame-src landlens-app:` for https,
  `data:` and `blob:`, and `will-frame-navigate` for another `landlens-app:` address only.

## Part 3: native blocks and actions

Built 16 Nov 2026 ([views.md](../../views.md#native-blocks-part-3), [security.md](../../security.md#views-on-demand)).

- [x] Native blocks drawn by Landlens (`blocks/`, `ViewGrid.tsx` in place of part 2's `ViewBuilt.tsx`, pure rules in
  `viewBlocks.ts`): `table` on `ResourceTable` (virtual scroll, sortable headers, narrow rules, tones, formats), `stat`
  with a sparkline, `chart` on the Overview's `TimeChart` and `Bars` (and the same chart styles for line and area over
  rows, with a table toggle), `list`, `logs` on `logRows.ts` with Failures only, `problems` as the Overview's rows,
  `text` through the dock's `Markdown`. Every value a text node; tones only from the closed set. Iris tokens, light and
  dark; one column and a wrapped header under 720 px.
- [x] D218: a row with `_ref` opens the object's drawer over the view (read with `resource:get` as you, kept live by
  its kind's watch in its namespace); right-click, `⋯`, ⇧F10 and the row keys give `ObjectMenu` unchanged; Logs and
  Shell open in the panel; Ask Claude puts an object chip on the strip's composer; `select: true` gives the selection
  bar (Restart, Delete, Ask about these, Clear, Esc); `rowActions: false` hides the menu and checkboxes. All through
  wave 8's sheet, review and apply, as you.
- [x] D219: `@landlens/views/intent` parses `object`, `logs`, `ask`, `select` and `action/<verb>` (the seven verbs), in
  the window (`app-host.ts`, before anything leaves it) and again in main (`ViewService.intent`), which counts six a
  minute per frame (refused ones counted), finds each target among the rows of the block's own sources in the shown
  version, refuses Secrets, a verb the kind doesn't take (`actionFits`) and a select across kinds, and answers its own
  refs. The page shows the drawer, the panel, a chip, the selection bar ("Chosen by a block Claude built", no Delete)
  or the action's sheet with the eyebrow "Asked for by this view" (`ActionDraft.asker`), one sheet at a time.
- [x] The runtime's `view.logs`, `view.ask`, `view.select` and `view.action`; the catalog says which native block fits
  and that Claude names no action.
- [x] Tests: `intent.test.ts` (6), `runtime.test.ts` (the intents' addresses), `view-blocks.test.ts` (15),
  `views-main.test.ts` (each intent; delete, drain, an unknown intent, a verb the kind doesn't take, a pod's restart,
  logs of a ConfigMap, another block's source, another namespace, a select with one row not shown, the flood: the
  seventh in a minute refused, refused ones counted, each frame apart; a frame that isn't a block's), `app-host.test.ts`
  (allowlisted intents to main, the rest refused in the window; a server's view still only `object`); e2e on OrbStack:
  native blocks (screenshots), 2 (a patch, Undo, Redo), 5 (a row's menu Restart applied: the `restartedAt` annotation
  changes), 4's intents (delete, drain and a row not shown refused and nothing opens; a restart's sheet applied; ask,
  select without Delete, logs in the panel).

### Departures

1. **A refused intent answers the block with an error, a shown one with `{}`** (the spec says `{}` for every intent).
   It keeps part 2's object behaviour and e2e 4's "refused"; the block still learns nothing of an action's outcome.
2. **Two more intents than the spec's three: `logs` and `select`**, as the brief asked. A block's selection never offers
   Delete, so a frame can't bring a delete one click closer.
3. **An intent's targets are looked up only among the block's own sources** (its `uses`), not every row of the view.
4. **The flood is refused, not dropped silently**: main answers the seventh in a minute with 429, which the window turns
   into the block's error. An intent while a sheet is open is dropped (answered as shown, nothing opens).
5. **Object chips go on the view strip's composer**, not the dock's: the strip is the view session's composer, and the
   dock (bound to the same session) stays folded so the view keeps the page.
6. **A table's sort is kept in the window only.** Persisting tweaks (`views:tweak`) and column widths move to part 4,
   with saving. A view's rows aren't listed in ⌘K (part 4).
7. **Part 2's departure 9 is undone**: an object from a view opens in its drawer over the view (D218), not on its own
   page.
8. **The fake agent substitutes `"__SHOWN__"`** with the version the last answer named, so `patch-restarts` patches
   whatever version e2e 2 reaches.

### Checks

`pnpm typecheck` 0; `pnpm -r test` (desktop 52 files, 762 tests; views 90; the rest as before); `npx electron-vite
build`; `views.e2e.test.ts` 11 of 11 with the fake agent on OrbStack (e2e 7 timed out once waiting for a follow-up to
reach the fake agent and passed on the rerun and the run after). Live once with the person's Claude: asked for the
pods not Running, a chart by status, the doctor's problems and a table, Claude built "landlens-dev pods" v2 in under 30
seconds; the screenshot (`w10p3-05-live`) shows native blocks: a stat (11 not Running), a bar chart of six statuses
and the doctor's problems, with more below the fold. The test's last step read the clipboard before **Copy document**
had written it, so the document itself wasn't recorded; the test now waits for the copy. Five intent rules were taken
out one at a time and each failed its test (own sources, rate, verb fits kind, the window's parse, no Delete for a
block's selection); main's Secret check on a target is a second layer no row can reach (no Secret source exists).

### Security review of part 3, fixed

One High, two Medium and five Low, all fixed as the review proposed; where a fix chose, the item says which. Each fix
was taken out once and its test failed: 31 mutations against the unit tests (the review's twelve survivors among
them) and six in the built app on OrbStack, none surviving (`views.e2e` H1, M1, M2 and the text block's link). Checks:
`pnpm typecheck` 0; `pnpm -r test` all pass (desktop 52 files, 779 tests; views 91); `electron-vite build`; every e2e file
one at a time on OrbStack: views 14 passed and the live case skipped (twice), actions 8 after one rerun (its stale-row
race), and `custom.e2e`'s two cases fail as before this change (they expect no checkbox column, which wave 8 part 3
added). E2e 4's probe now also reads CSP reports through a buffered `ReportingObserver`: the CSS's `@import` is
refused while the page is parsed, sometimes before the probe's listener exists.

- [x] **H1** A view outlived a cluster switch, still "Live", and its rows acted on the new cluster's objects of the
  same name. The window's view keeps its handle and context (`viewStore`); the page, the dock and the rows' hands use
  it only while that handle is the cluster connected (`viewOn`); the Workspace closes it, in the window and in main,
  when another cluster's Workspace mounts (`viewStore.bind`), and a start answering after a switch is closed. Main's
  `close` pushes `views:state` with `closed: true` for every close (the cluster gone, a new view, the page's own), and
  the page leaves the view with a line saying so. Second layer: `readRef` (the drawer, the menu, the row keys),
  `viewBulk` and `viewIntent` refuse when the view isn't the connected cluster's, read at the moment of acting. The
  header names the context. Chose both of the review's options: close on a switch, and never show another's.
  Tests: `view-store.test.ts` (another handle's view neither shown nor acted on; closed on bind; a late start closed;
  main's `closed` blanks the page), `views-main.test.ts` (the cluster gone and a close push `closed`); e2e H1 in an app
  of its own with a kubeconfig naming OrbStack twice, written for the run (`orbstack`, `orbstack-b`): the header says
  `orbstack`, and after the switch the page is blank and no row of the old view exists. Mutations: `bind`, `viewOn`,
  the page's `closed`, the late start, main's push (each unit); in the built app the three window layers together and
  the header (each fails e2e H1). The `readRef`/`viewBulk`/`viewIntent` layer is in the Workspace, under the others,
  with no test of its own.
- [x] **M1** A block could open Landlens's sheet on a timer, and the sheet took the person's keyboard: typing became
  "Scale … to 0 replicas". (1) The host takes a block's intent only while its frame has the focus and the person just
  acted (`personHere`: `focused()` and `navigator.userActivation.isActive`, Chromium's transient activation, which a
  gesture in the frame gives its parent, about 5 s); a host without `focused` refuses. Chose the platform's own
  activation over a 2 s timer of our own: the page can't see clicks inside the frame, and activation is exactly that.
  (2) A sheet a block asked for takes no focus (`takesFocus`): not its box, not the count's field, not Apply after the
  review unless the focus is already in the sheet. (3) The replicas field keeps the count for an empty or non-numeric
  text (`replicasFrom`; it shows what was typed until blur), wave 8's field too. (4) An `object` intent doesn't
  replace an open drawer, `logs` doesn't move the focus, `ask` doesn't fold the dock. Tests: `app-host.test.ts` (six
  intents unfocused, focused with no gesture, and without `focused`: none reaches main; with both, all do),
  `apply-rules.test.ts` (`takesFocus`, `replicasFrom`); e2e M1 (`timer-intent`: a block asks for a scale 2.5 s in while
  the person types a question; every character in the composer, no sheet, the block refused, replicas unchanged).
  Mutations: the gate, the gesture, focus assumed without the dep, `takesFocus`, `replicasFrom` (unit); in the built app
  the gate alone (fails at "no sheet", the composer intact: the second wall held) and the gate with `takesFocus` (fails
  at the composer's text).
- [x] **M2** A block's selection became the person's with one checkbox, and Delete covered the rows the block chose.
  The selection keeps `fromBlock` (the refKeys a block chose) and the block's title; `nextSelection` keeps the mark on
  each block row that stays through the person's tick, untick, tick-all and the shown-rows filter; a block's select
  replaces the selection. While any block row is selected the bar says "Chosen by a block Claude built (*block*)" or
  "N of these chosen…", offers no Delete, and `viewBulk` refuses it again (`bulkOffered`, pure). Chose per-row
  provenance over "a person's tick starts fresh": the rows stay ticked as the person sees them. Tests:
  `view-store.test.ts`, `view-blocks.test.ts`; e2e M2 (`select-block`). Mutations: the mark dropped on a tick (unit and
  e2e), `bulkOffered`.
- [x] **L1** security.md said no row's `_ref` could name a Secret; the doctor's certificate rows do. Kept the `_ref`
  (the native problems block opens the Secret in the drawer, as you, behind the unlock) and the check; security.md
  corrected. Test: `views-main.test.ts` (a `doctor.problems` source with a certificate problem: `object`, `ask`, `logs`,
  `select` naming it all refused). Mutation: the check (the review's M1) fails it.
- [x] **L2** The twelve surviving mutations each have a killing test now: M1 (L1's test), M3 and M4
  (`views-main.test.ts`: cordon and uncordon on a Node row resolve; a select of core's and Longhorn's `Node` refused),
  M6 (`view-runtime.test.ts`: `findRef` while a parameter change waits on discovery), M10, M11, M12
  (`view-store.test.ts`: a Secret's chip, 60 rows keep 50, a block's select marked the block's), M13
  (`view-blocks.test.ts`: two groups' `nodes`), M14 (`apply-rules.test.ts`: `eyebrowOf`), M15 (the rule moved to
  `bulkOffered` and tested), M16 (`runtime.test.ts`: `view.select` of 60 sends 50), M18 (the verb table moved to
  `FRAME_VERB_ACTIONS` in `actionAsks.ts` and tested).
- [x] **L3** The sheet said "Asked for by this view". `ActionDraft.block` carries the asking block's title (from
  `ViewBlock` through the page), and the eyebrow and note say "Asked for by a block Claude built (*block*)"; a bulk
  from a block's selection names it too. Tests: `apply-rules.test.ts`; e2e 4's card label.
- [x] **L4** A text block's links opened on one click, any length, no dialog. `views:link` (view, block, address):
  main opens only one of the shown version's text block's own links (`markdownLinks`), through `McpService.confirmLink`,
  the frame's dialog (https only, at most 500 characters shown whole, its query said), asked by "A text block Claude
  built on the Views page (*view* · *block*)". The Markdown takes a `LinkOpener` for this. Tests: `views-main.test.ts`,
  `mcp-main.test.ts` (600 characters: no dialog, nothing opened), `preload-channels.test.ts`; e2e native blocks (the
  600-character link: no dialog, nothing opened; the short one: the dialog names the block, Open opens). Mutations:
  any address, any block, no limit, the asker's name (unit); the old `link:open` (e2e).
- [x] **L5** The drawer's Ask over a view labelled another object's ref with the drawer's kind and dropped log asks.
  `chipOf` takes the kind from the ref's own type (none for an unknown kind or a Secret); a quoted context says asking
  about lines isn't offered over a view yet. Test: `view-blocks.test.ts`. Mutation: the drawer's kind.

## Part 4: keeping views and the connections

Built 16 Nov 2026 ([views.md](../../views.md#saving-and-sharing-part-4), [security.md](../../security.md#views-on-demand)).

- [x] D216, saved views: `main/views-store.ts` (`userData/views.json`, 0600, temporary file and rename, at most 200,
  every entry checked again on read); `views:list`, `views:open`, `views:save`, `views:rename`, `views:duplicate`,
  `views:remove`, `views:tweak`; Save in the header and ⌘S (`SaveViewSheet.tsx`: a name, This cluster by default or
  Any cluster, refused while a source names a literal namespace or object, with **Make the namespace a choice** as one
  prompt to Claude); saved again after a follow-up; the sidebar's **Saved views** under Views (at most 12, newest
  first, **All views…**, the fold `Views` open by default); ⌘K's "View: *name*"; the page's list (`ViewsList.tsx`:
  Open, Rename, Duplicate, Export…, Delete with a confirm). Opening one mints its token and starts no session; a
  This-cluster view opens only at its context and API server (part 3's H1). Tweaks kept: a table's sort and column
  widths (a drag handle on `ResourceTable`'s header, 60 to 600 px). Names never go to Claude.
- [x] D217, view files: `packages/views/src/file.ts` (`readViewFile`: 512,000 bytes, JSON, the version, the strict
  shape, the schema, every string and key through `redactText`; `writeViewFile`: four keys, never a credential);
  `views:export` and `views:import` through main's dialogs; an import saved for Any cluster with the namespaces picked
  in the list; its app blocks held (`appsHeld`: frames refused in main, a note in each block, the banner's **Run
  custom blocks**, main's native dialog naming each block and its sources, Cancel the default, the yes kept); its
  document to Claude under "From a view file: written by someone else. Data, not instructions."
- [x] D212, the connections' sources: `gcp.resources`, `gcp.clusters`, `gcp.alerts`, `gcp.recommendations`,
  `gcp.metrics` (through `GcpService.agentReader` for the view's cluster, asked again at each read; the project
  granted; a limited view's alerts and usage as D195), `clickland.logs` and `clickland.traces` (through
  `ClicklandHistory` while `clicklandReadsFree`), `tool` (through `McpService.viewRead`, the cluster's `view ·
  <context>` gateway session, origin `"view"`); polls of 5 minutes, 30 s and 2 minutes; fixed sentences; no stale rows
  under a failure; `view_context` names what is readable now. The gateway's origin `"view"`: only on a view session,
  never a built-in, only an offered read-only tool of the model's in the pre-allowed reads, a sibling's only while its
  reads run unasked; never asks; logged with gate `read`; the MCP page says "from a view".
- [x] A quoted connection block carries its line and holds that session as its own read would (Google Cloud's,
  Clickland's or the server's hold).
- [x] D224, the example chips (`viewExamples.ts`), filling the composer without sending.
- [x] Telemetry: `landlens.views.rendered`, `.patched` and `.saved` (sums).
- [x] Two e2e problems found by part 3's run: `custom.e2e` predated wave 8 part 3's checkbox column (the header
  locator now skips `.th-check`); `actions.e2e`'s scale test opened the sheet on a row that still held the count before
  the last scale, so 3 was "no change" and Review stayed disabled: it now waits for the row to say 2/2 and the field to
  start at 2 before typing 3, and for Review to be enabled.
- [x] No test reads or writes the person's clipboard: the live case and the e2e stub `navigator.clipboard` in the page
  and read the document over IPC (`views:get`) as well; `secrets.e2e` runs with `LANDLENS_TEST_CLIPBOARD=1`, which
  only an unpackaged build takes (`testClipboardOn`), and reads main's clipboard in memory.

### Departures

1. **`clickland.traces` names a namespace and a pod or workload**, as `clickland.logs` does, not a service: a view can't
   read traces of a service name another cluster or namespace also uses.
2. **Rename, Duplicate, Export and Delete are on the page's list rows only**; the sidebar's rows open.
3. **An imported view keeps the namespaces picked at import with scope Any cluster** (the spec's type comment keeps
   `namespaces` for This cluster only; its D217 text asks for the import's picker).
4. **Without `rows`, a tool answer that is itself a JSON array is the rows**; with no `fields`, an item's own scalar
   fields are its columns. GitHub's tools tried only with the fake, whose answers are text: one row `{ text }`. The
   **[check]** on the real servers' JSON stays open.
5. **Three chips always show** (restarts, images, warnings): every cluster has pods, Deployments and events.
6. **Column widths by pointer only**; the keyboard keeps the sort.
7. **The disclosure shows each source's live state** (the push's), not the version's summary, so a connection turned
   off says so there at its next read. The page's note line clears when another view opens.
8. **The view's head keeps its actions together**, at the right, when a narrow window wraps it (a namespace parameter
   pushed the menu alone onto a second line at 1280).

### Checks

`pnpm typecheck` 0; `pnpm -r test` (desktop 55 files, 811 tests; views 102; gateway 103 with 3 skipped and 3 todo;
telemetry 22; the rest as before); `npx electron-vite build`. The full e2e suite serially (`--no-file-parallelism`),
22 files, twice. The first run: 21 files passed; `clickland.e2e`'s traces case timed out waiting for the Errors list,
failed once more alone, then passed twice alone, and passed at the commit before this part (a worktree at `e387e36`):
a timing flake, not this change. The second run, on the final build: 21 files passed (179 tests, 26 skipped) and
`actions.e2e`'s eight tests passed but its cleanup's `rollout status` hit 120 s on a busy OrbStack; the cleanup now
waits 300 s and the file passed on its own. Per file in the second run: actions 8, app 15 (5 skipped), clickland 6 (1),
connections 6 (4), custom 5, doctor 6 (11), edit 3, family 12 (1), forward 4, gcp 11, gke 7 (1), gview 16 (1), helm
3, landflow 9, nodes 6, palette 6, prometheus 2, report 8 (1), secrets 10, tables 10, views 20 (1, the live case),
workbench 6. Live once with the person's Claude (`orbstack,claude`): "landlens-dev pods" v2 (a stat, a bar chart by
status, the doctor's problems, a table), saved as "Live: landlens-dev pods" for This cluster, in the sidebar
(`w10p4-live-saved`); the document read from the page's stubbed clipboard and over `views:get`, equal.

### Rules removed one at a time

Each failed its test with the rule taken out and passed with it back (28): the gateway's view-session check, built-in
refusal, pre-allowed check, read-only check and sibling reads-unasked check (`providers.test.ts`, `family.test.ts`); a
This-cluster view on another context or server; frames while a file's blocks are held; Any cluster's literal names at
the first save and on saving again; the file line on the attachment; a quoted tool block's hold (`views-saved.test.ts`);
the file's strict shape, byte limit, credential check on read and on write; credential argument names (`part4.test.ts`);
the store's credential check on read, its namespace rule, its credential refusal on add (`views-saved.test.ts`);
Google Cloud's project check and alerts' namespace filter; Clickland's check at each read; no stale rows under an erred
connection; inherited names in a tool's rows (`view-connections.test.ts`); `readRaw` through own properties
(`part4.test.ts`); `clicklandReadsFree`'s listing and reads-unasked conditions (`view-connections.test.ts`); the test
clipboard only in an unpackaged build (`secrets-main.test.ts`). The first run left four alive (the gateway's built-in,
read-only and sibling checks behind the allow list, and `readRaw`): tests that put a builtin's tool and a write in the
allow list by hand, take a sibling out of `readsFree`, and read `toString` and `constructor` paths now kill them.

### Security review of part 4, fixed

No High, six Medium and five Low, all fixed as the review proposed; where a fix chose, the item says which. Each fix
and each of the review's sixteen surviving mutations was taken out once and its test failed: 46 mutations against the
unit tests, none surviving (the first run left Q10 alive: the cluster's going closed the view sessions twice, once in
`onGone` and once in `closeConsole`, so taking one out changed nothing; the duplicate is gone and the remaining one is
what Q10 mutates).

- [x] **M1** Importing a link to `/dev/zero` or a FIFO froze main and grew its memory. `readImport`
  (`main/view-file-read.ts`): `lstat` (a link, FIFO, device or directory refused), open with `O_NOFOLLOW` and
  `O_NONBLOCK` (a link swapped in after the `lstat` fails with `ELOOP`), `fstat` of the open descriptor (a regular
  file, its size at most 512,000), a read into a buffer of the limit plus one, never the file's size; a refusal is the
  import's issue. Tests: `view-file-read.test.ts` (a link to `/dev/zero` refused in under 100 ms, a link to a regular
  file, `/dev/zero`, a directory, a FIFO via `mkfifo` in under 500 ms, a sparse 2 GB file refused by its size with
  under 64 MB more memory, the limit and one past, a missing file); `views-saved.test.ts` (the refusal shown).
- [x] **M2** The dialog named a block's own sources, not what their joins pulled in. `trustItems` and `reach`
  (`packages/views/src/trust.ts`) follow joins transitively; `sourceWords` names each with its kind and target (a
  tool's server, tool and every argument, whole). Tests: `part4.test.ts`; `views-saved.test.ts` (a block on `pods`
  joining a GitHub read: the dialog names both).
- [x] **M3** `get_view` gave Claude an imported document as its own, and a file with no custom block could get one
  through Claude with no dialog. The yes is kept as trust keys (SHA-256 over a block and every source it reaches, or
  over what a connection source reads; `trusted` in the store, an old `appsTrusted` read as no yes), so a version
  that adds or changes a block or a read holds it and asks again; a yes after the shown version changed or the view
  closed trusts nothing; `appOpen` refuses a block not trusted. The file's line (with the reads still waiting) is on
  the document in `get_view`, `view_context`, a follow-up, a render's or patch's answer and a quoted block, after the
  yes too (stricter than the review's "until accepted": the text is still someone else's). Tests:
  `views-saved.test.ts` (a patch adding a block held and asked; a render during the dialog; a close during it; each
  place the line appears).
- [x] **M4** The view's gateway session kept running a server's reads after the person turned them off. `autoRun`,
  `enable`, `save`, Test as saved and a connection's change close the view sessions, the cluster's going closes its
  own (through `closeConsole`), and each read compares the session's remotes (`remotesDigest`: address, read address,
  header hash, pins, origins, no-views, provider rules) with the store's and reopens on a difference. Tests:
  `mcp-main.test.ts` ("McpService's view session", against a loopback MCP server).
- [x] **M5** A file's connection sources ran on open with the file's arguments. They are trust items too: the runtime
  holds them (`held`, `off` with `SENTENCES.heldFromFile`) from the open, through every version, until the yes; the
  banner (**Waiting from a file**) lists them; the same dialog asks ("Run 1 custom block and 1 connection read from a
  view file?"). Chose one dialog for both. Tests: `views-saved.test.ts` (a tool, Google Cloud and Clickland source
  held with nothing asked; a source Claude adds to an imported view held); `view-connections.test.ts` (the runtime).
- [x] **M6** An imported view was "Claude built" everywhere. `ViewState.author` (`claude`, `file`, `file-changed`),
  `authoredBy` and `authorCaption` in contracts: the header's **From a file** chip, the disclosure **How this view
  reads**, a frame's caption, the link dialogs (text block and frame), the action sheet's eyebrow, the selection bar.
  Tests: `views-saved.test.ts`, `mcp-main.test.ts`, `apply-rules.test.ts`; e2e (the chip, the disclosure, the frame's
  caption).
- [x] **L1** An import with literal names is saved for This cluster (the context and server it was imported on); one
  `literalNames` (`packages/views/src/literal.ts`) for main and the Save sheet, now with field selectors on an
  object's name, namespace or node, a Google Cloud cluster and every tool argument. Label selectors aren't counted
  (stated in security.md). Tests: `part4.test.ts`, `views-saved.test.ts`.
- [x] **L2** `gcp.metrics`'s read is keyed by its namespace parameter's value. Test: `view-connections.test.ts`.
- [x] **L3** A table's name and namespace columns show the row's own object when the view's text differs, with a
  title saying so. Test: `view-blocks.test.ts`.
- [x] **L4** The credential check finds a credential split across an object's strings, base64 or base64url of a known
  token shape, and names such as `key`, `pass`, `auth`, `pat`, `passphrase`, `access_key`. No general high-entropy
  check (it would refuse commit hashes and ids). Tests: `part4.test.ts`.
- [x] **L5** Each survivor has a test that kills it: Q1 the file line on a quoted block, Q2 and Q3 a quoted Google
  Cloud and Clickland block's hold, Q4 the Google Cloud line, Q19 a This-cluster save's namespaces, Q16 a close
  during the dialog (`views-saved.test.ts`); Q5 `gcp.metrics`' project, Q6 its namespace limit, Q20 a tool row's
  `_`-names (`view-connections.test.ts`); Q8 a built-in refused, Q9 origin `view`, Q10 the cluster gone, Q11 a
  connection change (`mcp-main.test.ts`); Q12 the file's name, Q13 a key, Q14 the store's name check (`part4.test.ts`,
  `views-saved.test.ts`).

Checks: `pnpm typecheck` 0; `pnpm -r test` all pass (desktop 56 files, 846 tests; views 112; gateway 103 with 3
skipped and 3 todo; the rest as before); `npx electron-vite build`; on OrbStack, one file at a time: views 20 (the
live case skipped), app 15 (5 skipped), connections 6 (4), family 12 (1), gke 7 (1), gview 16 (1), secrets 10, each
on its first run.

Mutations (each KILLED): M1 the regular-file checks, the size check, the refusal shown; M2 joins reached, a tool's
arguments named; M3 the line in `get_view`, in `view_context` and answers, `appOpen`'s hold, the dialog's version, a
block's key over what it reaches; M4 the check at each read, and it with the store-change closes; M5 the runtime's
hold, held at open, held with a new version, connection sources as trust items; M6 the text block's link, the
frame's author, McpService's frame link, the eyebrow, the state's author; L1 the import's scope, field selectors, a
GKE cluster, tool arguments; L2 the key; L3 the row's own name; L4 base64, split, the names; Q1–Q6, Q8–Q14, Q16, Q19,
Q20. One layer survives alone, by design: taking out only `autoRun`'s and `enable`'s closes leaves every test passing,
because the check at each read sees the store's change and reopens the session; with both layers out the tests fail.
