# Limitations

What Landlens can't do yet, and why. Each item names the wave that lifts it ([plan.md](plan.md)).

- **The agent changes the cluster only through its six write tools**, each behind your approval: `patch`, `scale`,
  `rollout_restart`, `rollout_undo`, `apply_manifest` (server-side apply only, up to 10 documents) and `delete` (one
  object). No exec, no port-forward, no Helm, never Secrets, and nothing that carries a value it saw redacted, so a
  change to an env value it can't see has to be yours. Its own kubectl stays read-only.
- **Changes aren't kept.** A resumed session shows a write tool call as its row and result, not as a change card, and
  a change waiting when Landlens quits is gone (nothing was applied). The audit trail and History's count of applied
  changes stay.
- **The approval card is the renderer's.** A compromised renderer could approve a change it was shown; the renderer
  is sandboxed with a strict CSP, and main takes an approval only for a change it is holding. Main's own native
  dialog asks only before your widest actions (a delete of several objects, of any cluster-scoped kind, of a claim
  whose volume goes with it or a workload of 10 pods or more; a restart of more than 3; a drain; and any apply once a
  window has had more than 3 objects changed in a minute; wave 8). Below that budget other danger (a cordon
  included), and the agent's changes, keep the card's second click: a taken-over page can still make up to 3
  card-approved changes a minute. The digest Apply names is main's own over the card it answered; it can't prove what
  the window drew.
- **Dry runs trust the API server.** An aggregated API server that ignored `dryRun` would apply at the dry run. The
  agent's commands in the "/" menu are Claude Code's own (with no settings loaded, its built-ins), sent as messages.
- **Claude Code is the only agent.** Its sandbox fences only Claude Code; another ACP agent (Codex, Gemini CLI) would
  need Landlens's own sandbox for its process, with network to its model provider, so cluster data could leave by a
  path Landlens doesn't control. Deferred until that sandbox exists.
- **The agent runs without most of your Claude Code setup.** It uses your login and the skills you turn on (copied
  into its folder; none with links, over 500 files or over 5 MB), but none of your settings, CLAUDE.md, plugins,
  hooks or MCP servers: they would run outside the sandbox, beside a session that can read your cluster. It has no
  web tools and no edits. Your Claude Code routed to Bedrock or Vertex won't start, because Landlens doesn't hand on
  cloud credentials.
- **The agent has no internet**, in its shell or otherwise: the sandbox sends both proxies to the front door, which
  refuses them, and Claude's web tools are off.
- **The agent's reads are scrubbed and capped**: env values, `last-applied-configuration` and credential-shaped text
  show as `<redacted>`, strings over 4 KB are cut, and a response over 64 MB is refused ("narrow the request"). The
  front door refuses agent requests it can't read (protobuf, compressed), so `kubectl` uses JSON. Scrubbing matches
  patterns; an unusual secret format can still get through.
- **The agent's shell sees Claude Code's own session variables** (its messaging socket and token, its session id).
  Those are Claude Code's, not Landlens's; nothing of Landlens's environment reaches it.
- **One agent session per dock, one dock per window.** Closing the dock ends the session.
- **macOS only for the fence**: it relies on Claude Code's Seatbelt sandbox. On Linux it would need bubblewrap; the
  session fails rather than run unsandboxed (`failIfUnavailable`).
- **No `explain` tool yet** (OpenAPI schemas); the agent can run `kubectl explain` instead.
- **Helm is read-only** ([workbench.md](workbench.md#helm-releases)): no install, upgrade, rollback or uninstall,
  and the agent can't read releases (they are Secrets). Only Helm 3's default storage, Secrets, is read: releases
  kept in ConfigMaps or SQL don't show. Which values are secret is decided by their keys (and credential-shaped
  text), so a secret under an innocent name shows. Releases are read every 30 seconds, not watched. Logs, terminals,
  the YAML editor and port-forward are built ([workbench.md](workbench.md)), and graphs ([metrics.md](metrics.md)).
  Kinds without their own columns get name, namespace and age; custom kinds get their CRD's printer columns.
- **⌘K search** ([workbench.md](workbench.md#k-search)) finds objects of the common kinds (workloads, Services,
  Ingresses, ConfigMaps, Secrets, claims, nodes, namespaces) and of the list on screen; other kinds' objects only
  while their list is open. It reads names, not watches: a read serves 15 seconds, at most 2,000 names a kind.
  Matching is by name (prefix, substring, letters in order), not by labels.
- **Custom resources** ([workbench.md](workbench.md#custom-resources)): a definition's "Open certificates" has no
  count (counting would mean listing every object of the kind). Printer columns read a JSONPath subset; a column
  using anything else (`..`, ranges, functions) is empty. Without the right to list CRDs, which kinds are custom is
  guessed from their group. Pins live in the window's storage, so they don't follow you to another Mac.
- **The sidebar is 232px wide, always** ([design.md](design.md#layout)): its sections fold (D139), but it has no drag
  edge, and its folds live in the window's `localStorage` beside the pins until the packaged app (wave 13) moves both
  to a settings file.
- **Jump to (⌘K) is small**: kinds, and objects in the list already loaded. Clusters, actions and a search across
  every kind come with wave 4's command palette.
- **A failing pod's diagnosis** shows its last output line only when the container left a termination message
  (`terminationMessagePolicy: FallbackToLogsOnError`); otherwise open its Logs tab (Previous).
- **The Overview polls** `cluster:health` every 10s while the window is visible; main answers from the doctor's
  shared pod watch and reads workloads, nodes and events only when they are older than 15 or 30 seconds.
- **The doctor** ([doctor.md](doctor.md)) checks certificates only in `kubernetes.io/tls` Secrets (at most 500 per
  scope): not cert-manager `Certificate`s, Opaque Secrets with PEM, webhook CA bundles or the control plane's own.
  The API server can't sort events, so with more than 2,000 warning events the newest of a busy namespace can be left
  out, and past 5,000 pods (or 2,000 of a workload kind) the rest aren't checked (the page says the list is partial). A bare ReplicaSet with a `pod-template-hash` label shows as a Deployment
  that doesn't exist. There is no mute, acknowledge or history of cleared problems, and the thresholds are fixed.
  On the Problems page, **Open full logs** opens the pod's Logs tab on its current run (choose Previous there), ⌘K's
  recent items don't keep problems. The agent sees certificates only for namespaces a Landlens window is showing (the
person's check reads them), and Ask Claude sends one problem at a time.
- **The welcome page doesn't show your kubeconfig's path**, only how many contexts it has (`catalog:list` doesn't
  carry the path).
- **Your actions are one object at a time** (wave 8 part 1): the menu, the drawer and ⌘K act on the object in
  front of you. Bulk actions on a multi-select come in part 3; revealing a Secret's value in part 4. A Secret can be deleted (its review shows keys and sizes) but not otherwise acted on.
  Recent actions keeps no diff and no undo; Rollback, a Helm rollback and an action on several clusters are later
  waves (10, 12). A card's facts are read at review and can be up to 15 minutes old at Apply; lists stop at 500 (the
  card says so). The action log is a convenience record on this computer, not evidence: anything running as you can
  edit `actions.json` (a file over 4 MB is moved aside); a row left *Sent* means Landlens stopped before the answer.
  If the log can't be written, actions are refused. "Ask Claude first" isn't offered differently to a session limited
  to some namespaces: the text from outside them is held back in the dock, not sent.
- **Cordon and drain are preview only in a development build** (wave 8 part 2, D153), on every cluster, OrbStack
  included: nothing is sent to a node unless `LANDLENS_NODE_WRITES` names the context. A packaged app has no such
  guard. **No real drain has run live**: the run is tested against an in-memory API (`fake-api.ts`) and OrbStack sees
  reads and dry-run evictions of the scenario's pods only (its one node is shared with the siblings); a test on a
  throwaway two-node `kind` cluster is the person's call (spec, open question 2). **The agent has no cordon or drain
  tool**: it can explain a plan (Ask Claude), the person runs it. A drain doesn't follow a pod's replacement to see it
  scheduled elsewhere, and doesn't wait for a PodDisruptionBudget whose status is behind its spec (the API answers
  429 and the run retries). Closing the sheet while a drain runs isn't offered (Stop first); the run is main's and
  ends with its window.
- **One cluster at a time** in the window. Connecting to another disconnects the first.
- **Development build only.** No packaged app yet, so the hardened fuses are verified on a clone, not shipped (wave 13).
- **Attach** passes through the front door and the sidecar but has no UI or live test. Exec and port-forward have
  both ([workbench.md](workbench.md)).
- **The audit trail** is shown only through MCP calls: the MCP page's call log shows each `landlens-kube` call's
  front-door requests ([mcp.md](mcp.md)), but the agent's own kubectl requests and the IDE's are still kept in
  memory and not shown, and nothing is kept across restarts (the call log holds the last 500 calls). Your own
  actions (wave 8) are kept: Recent actions lists the newest 500 per machine, but not your YAML edits, shells or
  forwards, and not the agent's applied changes (they stay in its sessions); one audit page for both is a roadmap row.
- **MCP servers** are remote and streamable HTTP only: no stdio servers, no OAuth (a header you paste), and a session
  gets the servers on for its cluster, with their tool lists, when it starts. MCP App views can't write to the
  conversation (`ui/message`), change the model's context, read resources or go fullscreen; they run without Geist
  (fonts only from `data:`), and a view that tries to navigate is left blank.
- **A remote server's tools ask every time** unless you turn on its auto-run switch, and that switch trusts the
  server's own `readOnlyHint` for the listing you tested: it can't tell a tool that changes behaviour without
  changing its listing. Its tool descriptions and results reach the model verbatim ([security.md](security.md)). If a
  server's listing changes, auto-run turns off and you Test and turn it on again; there is no diff of what changed.
- **GitHub and Linear go to every cluster's sessions** (one "Give to Claude sessions" switch, no per-cluster choice),
  and a read's arguments reach the vendor without a question ([connections.md](connections.md)). Writes ask unless
  you turn a connection autonomous for one session.
- **Google Cloud is browse only, and only by project** ([gcp.md](gcp.md)): at most 20 chosen projects and 5,000
  resources each (the rest cut), no folders or organisations, no IAM policies or costs, no writes, one Google account
  (gcloud's current one), and Landlens never runs `gcloud auth login` for you. Nothing was tried against the real
  Google APIs or a real GKE cluster.
- **GKE clusters connect with gcloud's user token only** ([gcp.md](gcp.md#gke-clusters-in-the-catalog)): a cluster
  that doesn't take Google sign-in for users, or whose private endpoint this machine can't reach, won't connect; the
  catalog lists only clusters with an IP endpoint and a valid CA or a `gke.goog` DNS endpoint, and a context your
  kubeconfig already names is yours, not Landlens's. Any other address a chosen project lists (private or public)
  is trusted with gcloud's token, as gcloud trusts it; a loopback HTTPS proxy can't be used for a GKE cluster, and
  through any proxy the sidecar checks the proxy's address, not the cluster's. A development build opens only the
  fake's clusters unless `LANDLENS_GKE_REAL=1`. The list is read when the catalog is (Welcome, the switcher's menu),
  cached 60 s. A `gcp.json` from before this release asks again for each cluster and for Claude's tools.
- **Claude's Google Cloud tools only read, and only the chosen projects** ([gcp.md](gcp.md#claudes-google-cloud-tools-landlens-gcp)):
  no IAM policies, costs or logs; 30 calls a minute a session; a resource's configuration is scrubbed by known
  positions and shapes, so a secret in an unusual field and shape can still reach the model. The switch is one for all
  clusters and sessions; a project granted later is readable only in a new session.
- **Autonomous mode is per session and never remembered**: each session, a resumed one too, starts with every write
  asking, and the scope is typed again each time; there is no default scope per connection. A resumed session is also
  held for good: its routine writes ask even with autonomous on, since Landlens can't see what its transcript read
  (wave 7 review of part 2, M1). Inside the scope, a
  hostile issue or comment can still steer up to 20 writes, wrong or leaking ones
  ([connections.md](connections.md#autonomous-mode)). Google Cloud data holds it (every write asks after), but
  cluster text (logs, events, annotations) doesn't: a hostile log line read in an autonomous session is the same
  residual risk. A write you approve can still carry what the session read.
- **Linear's autonomous updates and comments are held to the team only by the issue's identifier**: `update_issue`
  and `create_comment` run on their own only on an issue named `<KEY>-<number>` with the scope's key; one named by its
  UUID asks, since Landlens can't place it in a team without a read it doesn't make.
- **Autonomous GitHub writes still start CI**: a push to a `landlens/` branch or a pull request can run the
  repository's workflows, and a GitOps tool that deploys branches by pattern could deploy one; a repository in scope
  may be public ([connections.md](connections.md#autonomous-mode)).
- **The routine list is fixed in code**: a tool GitHub or Linear adds or renames asks until a release of Landlens
  names it, and the list matches the hand-made fixtures until the real listings are recorded. The repositories and
  default branch typed in the sheet aren't checked against GitHub.
- **GitHub grants can't be revoked from Landlens**: GitHub needs the OAuth App's secret, which Landlens doesn't have,
  so Disconnect only forgets the token, and a device sign-in cancelled after GitHub gave the token leaves a grant
  that you remove at GitHub's Settings → Applications ([connections.md](connections.md#signing-in-to-github)).
  Linear's are revoked, best effort.
- **Folded views reopen from scratch**: an earlier view in the dock is closed when it folds and opened again (from
  the kept result, the last 50) when you show it, so its own state (a filter, a scroll) is lost.
- **Views get only a few of the app's keys** (Escape, ⌘/Ctrl with K, J, B or a digit); other shortcuts stay in the
  view while it has focus.
- **Secret material outside Secrets** (tokens in CRD specs, passwords in ConfigMaps) shows in the IDE as the
  cluster returns it. Only what the agent reads is scrubbed.
- **A same-user process** can read your kubeconfig and could debug Landlens; Landlens narrows what borrowing its
  connections allows but doesn't defend against a compromised user account ([security.md](security.md)).
- **A local terminal's token is in a file** (0400, in a 0700 folder under Landlens's data) that any process of yours
  outside the agent's sandbox can read, like your kubeconfig, and it is full access to that cluster as you until the
  terminal ends. Each terminal gets its own, revoked when it closes ([security.md](security.md#terminals)). A startup
  file that sets `KUBECONFIG` wins over Landlens's. A pod shell's token is narrower: that pod's exec only.
- **Flow control** covers terminals (paused past 2 MB undrawn) and a log's read rate, not a log view's drawing: a
  container that logs 2 M characters a second still keeps the window busy. Log search's regex guard is a pattern
  check plus a time budget, not a separate thread: a regex it doesn't recognise as risky can still stall one search.
  The transcript shows the chip, not the quoted text that was sent.
- **Logs and terminals** ([workbench.md](workbench.md)): the drawer and a panel tab each open their own stream (the
  design shares one, counted in main); Download saves what is shown, not the whole log from the API; the view draws
  the last 2,000 lines of the 10,000 it keeps, without virtual scrolling; a workload follows its newest ten pods and
  doesn't add pods that start later until you reopen it; pod colours run out after four (the rest share one).
  Shells: no debug containers for images without a shell; the
  shell picker offers a workload's pods, but the palette entry (⌘K "shell …") comes with part 4; "Open shell in the new
  pod" matches pods by labels, so it can offer a pod of a different rollout. Input typed while a new session starts
  is dropped. The panel's height is kept for the window, not across restarts.
- **The YAML editor** ([workbench.md](workbench.md#the-yaml-editor)) sends a JSON merge patch of what you changed,
  pinned to the version you started from, not a server-side apply: Landlens (field manager `landlens`) owns just the
  fields it changed, but a field another manager owns is only warned about, so the design's **Take over** (a forced
  apply) and **Review without line 7** aren't built. A merge patch replaces a list whole, so changing one container
  sends every container. Where you and someone else both changed a field while you edited, yours is kept (the banner
  names it) rather than waiting for you. Secrets can't be edited or created. Create sends its documents in order: if
  one fails at Apply, the ones before it stay created (the error says which). There is no "Show change" on the
  Applied row and no flash of the row. Templates are fixed.
  An edit is one object; a leading-zero number like `0600` is refused rather than guessed (YAML 1.1 and 1.2 differ),
  so such values need `0o600` or quotes. A review lasts 15 minutes and a window keeps at most 20. The Apply guard
  (no card-wide Enter, key presses ignored for half a second, never a repeated key) is renderer behaviour, checked in
  e2e (a fresh card's Enter, and Enter held from the menu with Apply focused).
- **Port-forward** ([workbench.md](workbench.md#port-forward)) is TCP only. A Service forward goes through one pod,
  not spread across them as the Service would. The pod is checked every 5 seconds, so a connection in the seconds
  after its pod goes can fail. A WebSocket can't half-close, so a client that half-closes waits for the pod's answer
  for up to 30 seconds. Any program of any user on this Mac can reach a forward, and so can pages in your browser (a
  cross-site request, or DNS rebinding against an app that doesn't check `Host`), as with `kubectl port-forward`;
  a kept forward is open whenever Landlens is connected. The agent's sandbox can't reach or see one. A bare pod's
  forward fails when the pod goes; a controller's pod forward follows only that controller's pods. Landlens's own
  checks on a forward are reads as you that skip the audit trail. A kept forward made before Landlens noted its
  cluster (before the review fixes) waits for you to start it again. The row menu's F (D6) and the palette's
  forward action aren't built.
- **Graphs are CPU and memory only**, for the cluster, nodes, pods and Deployments, StatefulSets and DaemonSets: no
  network, disk or GPU. Namespaces are a Top namespaces list, not a chart of their own.
- **Prometheus** ([metrics.md](metrics.md#prometheus)) is used only once you choose the one Landlens found, one
  per context; it is found only where OpenLens looks (the Helm chart's and the
  operator's labels, four well-known names), reached only through the API server's service proxy (no direct URL or
  bearer token), and asked only for cAdvisor's CPU and working-set series, which a Prometheus without the kubelet's
  cAdvisor job lacks; there is no setting to pick one. The OrbStack scenario's series are backfilled, not scraped.
- **History needs Clickland** with metric filters (Clickland `specs/001-metrics-filters`); an older Clickland is
  refused. Without it, metrics-server gives live samples from when a view first asks, at most an hour, and only while
  Landlens is open. OrbStack ships no metrics-server, so there it is Clickland or nothing.
- **Requests and limits are drawn at their latest value**, not as they changed over the range (a rollout that changed
  them shows the new values across the whole chart).
- **Clickland keeps the ten largest series per query** and sums the rest as "other": a workload with more than ten
  pods, or a cluster with more than ten nodes, shows the tail summed; the charts fold past four series anyway.
- **One Clickland for all clusters**, with a cluster name per context. Landlens's own telemetry goes to one collector
  you set, off until you turn it on ([family.md](family.md#what-landlens-reports)).
- **The Land family is connections, session tools, Clickland's logs and traces, Landflow on a resource, telemetry and the brain's session summaries** (wave 7 parts 1–5,
  [family.md](family.md)). Landlens signs in to Clickland, Landflow and Landfall, gives Claude sessions their own MCP
  servers (reads by Landlens's list, the server's hint and the accepted listing; every write asks), and shows
  Clickland's stored lines and traces in the drawer ([metrics.md](metrics.md#logs-and-traces-from-clickland)), and
  sends a problem to Landflow's triage or runs a flow tagged `landlens` on an object, on your click
  ([family.md](family.md#landflow-on-a-resource)), and sends its own telemetry and a session's summary to your brain
  when you turn it on or click Send ([family.md](family.md#what-landlens-reports)). Clickland's reads were checked live (:4730, its development bootstrap key, reads only); no other live
  link was checked with a real key: making a key writes to a sibling, so that waits for the person, and so does recording the siblings' real tool
  listings (`scripts/record-provider-tools.mjs --family`); `FAMILY_READS` was compared by hand with the siblings'
  code ([family.md](family.md#what-the-lists-were-checked-against-review-of-part-2-m6)), and the three recorded-listing
  tests show as `todo` until a listing is recorded. Clickland hints a new tool read-only by default: only Landlens's
  list keeps it asking. A server you add at a connected sibling's address stays out of sessions rather than getting the sibling's
  rules. A sibling's writes have no autonomous mode, by design (D113), and the family's tools are on for every
  cluster or none. A Clickland view can call Clickland's writes behind the native dialog, as an added server's view
  can. The local Landfall's connector is off (`MCP_GATEWAY_ENABLED`), so its sign-in and its MCP server were checked
  only against the fake. A Landflow key that can change workflows is kept, with a note. Landbright sign-in for
  Landlens itself is not planned until a sibling accepts Landbright tokens (D104). The Land family cards were checked
  at 1024×700. Below the page's 640px container width they have a rule, but no test is narrow enough to reach it.
  Landfall names no account to Landlens, so every new Landfall sign-in starts with Tools for Claude off, even at the
  same address (wave 7 review, M3).
- **Landflow on a resource** (wave 7 part 4, [family.md](family.md#landflow-on-a-resource)). Checked only against
  the fake Landflow, built from Landflow's code: sending to a real triage flow writes to Landflow and can open a room
  in Landfall, so that live check (D137) waits for the person, behind `LANDLENS_LIVE_WRITES=1`. The room's link needs
  `executions:read` on the key and a walk of the run's node outputs (Landflow has no `landlens` alert format or
  template that answers with the `TriggerResult` yet); without it you get "Sent to triage." and a link to the run.
  Landflow dedups Landlens's alerts by its hash of source, title and service, not by the alert's `fingerprint`.
  Following a run stops after 60 s until **Check again**, and only against the Landflow connected now. The flows
  offered are the ones Landflow lists with the tag `landlens`, at most 50; their input has no declared contract on
  Landflow's side, and a flow's output can say anything (it reaches a prompt only quoted, under the hold). A send Landflow holds (debounced or batched) has no run, so it
  isn't remembered and leaves no chip. A problem's recovery isn't sent. Run a Landflow flow is a button in the object drawer's header (there is no ⋯ menu there).
- **Telemetry and the brain** (wave 7 part 5, [family.md](family.md#what-landlens-reports)). Checked against the fake
  Clickland collector and the fake Landflow, with a fake ACP agent in place of Claude Code; the local Clickland
  collector took a synthetic session's records, but no test reads them back from Clickland (that needs a key) or runs
  a live Claude Code turn with telemetry on, and the brain's live check (`LANDLENS_LIVE_WRITES=1`) waits for the
  person. A turn's model and cost come from ACP's `usage_update`; a turn's span waits 250 ms after the answer for it,
  and a turn with none has neither. Cost is ACP's running total split by turn, so a turn that overlaps the brain's
  draft turn counts both. The cluster's name is the one set for graphs; without one, the context's own name goes only
  when it is plain (one lowercase DNS label with no run of six digits), so a context named plainly after a project
  (`acme-prod`) still goes: set a name for graphs, or choose counts only. With counts only, neither it nor a change's
  kind is sent. "Ask Claude to draft" can't run without tools (ACP sets tools per session, not per prompt), so a tool
  call cancels it rather than being impossible; the agent may still have read the session's folder in that turn. Change verbs are the approval broker's (create, update, patch,
  delete), not the tool's (scale, restart, undo). The events are the ones main sees (sessions, clusters, the sidecar's
  and the adapter's exits, a refused gateway call, drops); there is no `clickland.unreachable` or `cluster.unreachable`.
  The brain's draft counts tool calls, cluster reads and the problem in this launch only, so a session from an earlier
  launch drafts from its history's questions and changes. "Ask Claude to draft" is a turn in the session, so it shows
  in the dock (marked) and in Claude Code's transcript; a session that is answering refuses it, and a question waits
  until the draft is done or cancelled. During a collector outage records wait (up to 2,000) and are tried every 10 s;
  a quit sends for at most 2 s.
  After the security review of part 4: a flow shared from another project is listed (marked "Shared from the project
  …") and can be run; Landlens only shows whose it is and refuses one that changed since the list. A ConfigMap's
  values are sent when its YAML is ticked, scrubbed (the keyed pattern now sees `DB_PASSWORD: …` in the YAML text),
  not hidden as a Secret's are; a value under a key the patterns don't know (`DSN`, `conn`) goes as it is, shown on
  the sheet first. The room's host is shown, and said when it isn't the connected Landfall's, but not checked. Old
  `family-sent.json` entries without the API server's hash are set aside with the file (part 4 isn't released). A send
  the file couldn't keep is followed for this launch only. A flow whose id has characters other than letters, digits,
  `_` and `-` can't be run from Landlens.
- **Clickland's history in the IDE** (wave 7 part 3, [metrics.md](metrics.md#logs-and-traces-from-clickland)).
  Traces are searched by service name only (the pod's `app.kubernetes.io/name` or `app` label, which the workload's
  author writes, else the workload's name). Spans that name another cluster or namespace (`k8s.cluster.name`,
  `k8s.namespace.name`) are dropped, but spans that name neither, as Clickland's local spans do, are listed from any
  cluster and namespace with that service name: the tab says "By service name, in any cluster". A workload's History
  filters on `k8s.deployment.name` (or StatefulSet, DaemonSet),
  which Clickland's collector sets for pods it owns; a bare ReplicaSet, Job or CronJob has no History. **Errors**
  is Clickland's severity (error, fatal or critical), so a workload that logs everything at INFO shows no errors, though the
  failure-line rule still colours its lines. History pages 200 lines and keeps 2,000; the rest is in Clickland's
  console. A private key logged one line per row is blanked only within one page (a key across **Load older** keeps
  the rows of the older page before its head), and Live logs aren't blanked that way: a quote is scrubbed again, and a
  quote that opens or closes a key without its other end is. History needs `get pods/log` in the namespace, though
  Clickland's own console shows the same lines to whoever holds the key (Clickland's keys have no cluster or
  namespace limit). A question holds autonomy for a quoted Clickland line found by its time, or by its body from 16
  characters; a shorter line picked without its time is found only by its quote's head. A trace's span list is a plain list with a duration bar, no waterfall, at most 500 spans. The doctor's
  fallback reads only when the kubelet has neither run, from the last 7 days (from the pod's creation when it still
  exists). Open in Clickland needs the console's
  address typed in **Connect Clickland**; Clickland names no console of its own. The doctor's Clickland fallback is
  checked in unit tests, not on the built app. The live checks run with Clickland's bootstrap key (`admin`), since a
  read key can't be made without writing to Clickland; that `read` is enough is checked against the fake.
- **Clickland's address is an origin now** (wave 7, D102). Before wave 7 a Clickland behind a path prefix
  (`https://host/clickland`) was taken and stored; now **Connect Clickland** and its **Test** refuse an address with a
  path, and a stored one keeps working for graphs only until it is saved again, while the family's who-am-I goes to
  `<origin>/api/auth/me`. Serve Clickland at its own origin (a host name of its own) instead. The dialog shows the
  rule's sentence, not why a stored address that worked before is now refused.
