# The workbench

Wave 4 turns Landlens from a viewer into a place to work: logs that follow, a shell in any container, a terminal on
your Mac whose kubectl goes through Landlens, a YAML editor, port-forward, CRD columns, Helm releases and ⌘K search.
This page covers what is built (part 1: logs and terminals; part 2: the YAML editor; part 3: port-forward; part 4:
custom resources, Helm releases and the search). The design is Fable's spec for wave 4
(decisions D1–D46, cited below).

## The panel

Terminals and bigger log views live in **the panel**, under the table and the drawer and beside the dock (D1). It
spans the list and the drawer, so a terminal gets the width it needs; the dock keeps its full height. The status bar
moved under the panel.

- **⌘`** shows the panel and puts focus in it; from inside, it hides the panel and returns focus where it was.
  **⌃⇧`** opens a local terminal. **⌘W** closes the panel's tab, **⌘⇧[** and **⌘⇧]** step through its tabs, all
  while focus is in the panel. Single-key shortcuts (`/`, `[`, `]`, L, S) and Esc stay with the terminal or log
  there (D22).
- Drag its top edge to resize it (or focus the edge and use ↑ and ↓, 16px a step); double-click it, or the
  Maximise button, to fill the table's space too. The height is kept for the window (D3).
- **Hiding the panel never ends a session.** The status bar says how many are open ("3 sessions") and shows the
  panel again (D2).
- **Closing a tab ends its session.** Switching cluster or quitting with live terminals asks once ("2 sessions will
  end") (D23).
- An ended session's tab dims and its icon becomes a dashed circle (D4).

Code: `apps/desktop/src/renderer/src/Bench.tsx` (the panel), `benchState.ts` (its tabs), `workbench.css`.

## Logs

The drawer's **Logs** tab, for a pod or a workload (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job), is a
followed stream: one long request with `follow=true`, not Lens's poll every ten seconds (D13).

- It starts with the last 500 lines and follows. Scroll up and it pauses ("Paused · End to follow"), with a pill
  counting new lines; the pill or End follows again.
- A dropped stream reconnects by itself (after 1, 2, 5, then every 10 seconds) from the last line's timestamp, drops
  the lines it already has, and leaves a marker line. A pod that is gone says so.
- **Workloads stream all their pods** (the newest ten; the picker says "10 of 23"), merged by the API server's
  timestamps. Each pod's lines carry its name's last five characters in a chart colour, with a legend (D17). The
  picker narrows to one pod.
- **Search** (⌘F or the button): plain text, case-insensitive, or `/…/` as a regex; "3 of 17", Enter and ⇧Enter step;
  searching pauses following (D14). A regex that could backtrack without end is refused ("Can't run this regex"),
  and a search that runs too long stops ("Search stopped: too slow").
- **Previous** shows the run before the last restart, once the container has restarted (D16). For a workload, pick a
  pod first.
- Wrap (on in the drawer, off in the panel), timestamps (your local time, the full time on hover), Download (what is
  shown, as `<object>_<container>_<time>.log`) and **Open in the panel** (D15, D20).
- Lines the failure rule flags (`FAILURE_LINE`, the one `get_logs` cards use) are red; ANSI colours map to the
  terminal tokens, bold and dim are kept, other escape codes are dropped (D18).
- The view keeps the last 10,000 lines and draws the last 2,000, with "Show earlier lines" for the rest.

**Ask Claude about lines** (D19): click a line's time to take it (shift-click for a range), or select text. A bar
offers Copy and **Ask Claude** (⌘⏎), which adds a chip ("4 log lines · shop-web") to the dock's composer and sends
nothing. When you send, the lines go in the prompt, redacted as `get_logs` output is, at most 200 lines or 16 KB.

**Live | History** (wave 7 part 3, D118): while Clickland is connected and ready, a pod's, Deployment's,
StatefulSet's or DaemonSet's Logs tab has a source switch. **History** lists Clickland's stored lines for it, newest
last, with **Load older**, a range (1h, 6h, 24h, 7d), **Errors**, a find box sent to Clickland as one phrase, a pod
column for a workload, picked lines for Ask Claude, and **Open in Clickland** when the console address is set. A pod
that is gone offers **See its history in Clickland** from Live. The same objects get a **Traces** tab. Both are read
in main and scrubbed before they reach the window: [metrics.md](metrics.md#logs-and-traces-from-clickland).

Logs are read through the IDE's own connection (the sidecar), like every other view. Code: `LogsView.tsx`,
`logRows.ts` (ordering, merging, ANSI, search), `packages/kube/src/logs.ts` (`followLogs`, batches every 100ms or
500 lines, lines over 16 KB cut), `apps/desktop/src/main/workbench.ts`.

## Pod shells

Four ways in (D5): the drawer's terminal button (pods, and workloads, which list their pods, ready first), **Shell**
on each container card, a row's menu (right-click or Shift+F10: Logs, Open shell, Copy name, Ask Claude; L and S on
a focused row), and, in part 4, the palette.

- One running container opens at once; otherwise a menu lists the containers (init containers and those not running
  are disabled, with the reason) with **Auto / bash / sh** in its foot (D7). Auto runs bash if the image has it,
  else sh.
- **Every shell runs as you.** A strip above it says which container, pod, namespace and shell, with an amber **Runs
  as you** badge and "Claude Code can't see or type here" (D8). The exec goes through the front door with a token
  issued for that terminal alone, labelled `you · <context> · shell <namespace>/<pod>` and good only for that pod's
  exec, so it is in the audit trail and the cluster's RBAC for you applies. The token is revoked, and anything it
  opened closed, when the shell ends, the tab closes, or the page reloads. If your role can't create
  `pods/exec` in the namespace, the Shell buttons are disabled and say so.
- **A paste that would run something asks first** (D9): any line break (a lone carriage return too) or other control
  character: "Paste 14 lines into app? Each line runs in the pod as you.", with its first three lines shown, control
  characters made visible. Escape characters are removed from every paste into a pod. Enter pastes, Esc cancels. A
  local terminal never asks.
- **When a shell ends,** the output stays, greyed, and a bar says what happened (D10, D11): "The shell exited
  (code 3) at 04:19:37" with **Reconnect**, "Connection lost" with **New session**, or "The pod is gone" with **Open
  shell in the new pod** when one with the same labels runs the same container. A new session keeps the old output
  above a marker line.
- **A container with no shell** (distroless, `pause`) says "No shell in this container", with Open logs and Ask
  Claude.
- ⌘F searches the terminal (xterm's search addon). Selecting text shows Copy and **Ask Claude**, which adds a
  "Terminal selection · n lines" chip (D12). The agent never reads or writes a terminal.

Code: `TerminalView.tsx`, `XTerm.tsx` (xterm.js 6 with fit and search), `ShellMenu.tsx`,
`packages/kube/src/exec.ts` (`openExec`: the `v5.channel.k8s.io` WebSocket protocol, falling back to v4; resize on
channel 4; the exit read from the status channel).

## The local terminal

Your login shell, in your home folder, through node-pty (D21). `KUBECONFIG` points at a file Landlens writes for
this terminal: one cluster (the one you are on), reached through the front door, with a token issued for this
terminal (`you · <context> · terminal`) in a 0400 file beside it, read by an exec credential plugin; it is not in the
shell's environment, where another process of yours could read it. The folder is removed and the token revoked when
the shell exits or the tab closes (and swept when Landlens starts). The shell is your account's login shell, or
`$SHELL`, if `/etc/shells` lists it. The strip says "zsh on this Mac · kubectl points at orbstack through Landlens".

Your shell's startup files run as usual, so one that sets `KUBECONFIG` itself wins; Landlens's own variables
(`ELECTRON_*`, `LANDLENS_*` other than the token, `VITE_*`, `NODE_OPTIONS`, `CHROME_*`) are removed from its
environment.

## The YAML editor

The drawer's YAML tab has **Edit** beside Copy (D24), as do a row's menu (**Edit YAML**) and the E key on a focused
row. Secrets stay locked: their Edit is disabled and says so.

- The editor is CodeMirror 6 with YAML highlighting in the `--code-*` colours, line numbers, folding, search (⌘F)
  and undo. It shows `apiVersion`, `kind`, `metadata` and the rest as you would write them: no `status`, no
  `managedFields`, `uid`, `resourceVersion`, `generation`, `creationTimestamp` or the last-applied annotation.
- Changed lines carry a green edge, and the sticky foot says "1 line changed. Nothing is sent until you review."
  with **Review** (⌘⏎) and **Discard** (D26). The maximise button opens the same editor wide (D25).
- **Review is a dry run** (D27). Landlens sends a JSON merge patch (RFC 7386) of only what you changed, with the
  `resourceVersion` you started from, as `PATCH …?fieldManager=landlens&dryRun=All`. The editor gives way to a card
  of your own ("Your edit", no iris ring: that belongs to the agent's asks): risk badges as wave 3's cards have them,
  the diff of the live object against the dry run's result, warnings, "Dry run passed. Nothing has changed yet.",
  **Apply** (a danger risk asks a second time, with Back focused), **Back to editing** (Esc) and **Ask Claude to
  check it**, which adds the change to the dock's composer as a chip, scrubbed as the agent's reads are. Focus moves
  to Apply only if it was in the editor, and a key press there in the first half second is ignored, so a held ⌘⏎
  can't review and apply at once. A long diff is capped; Apply then reads **Show the whole change** until you have.
- **Apply sends exactly the request the review dry-ran**, without `dryRun`. Only the window that reviewed it can
  send it, on the same cluster, within 15 minutes, once. The tab then shows the read-only YAML with "Applied ·
  deployment landlens-dev/shop-web · +1 −1" above it (D31).
- **Refused** (D28): a 422's causes mark their lines red, with the cluster's message beneath ("Invalid value: -1:
  must be greater than or equal to 0"); the foot says "The cluster refused this: 1 problem, on line 12. Nothing has
  changed." Causes without a field go in the foot. A YAML syntax error marks its line the same way, before anything
  is sent, as does a plain number with a leading zero (`0600`: YAML 1.1 reads it as octal, 1.2 as decimal; write
  `0o600` or `"0600"`); changing `apiVersion`, `kind`, the name or the namespace is refused, as is "Nothing changed".
- **Someone changed it** (D29): when the object's `resourceVersion` moves while you edit, your changes are moved
  onto the new version and a banner says what they changed. Where you both changed a field, yours is kept and the
  banner names it. A review that is already showing goes back to the editor ("review again"); an apply whose version
  moved gets a 409 and does the same.
- **Another owner** (D30): if a field you changed is managed by another field manager (an HPA's replicas, a
  controller's annotations), the review card says "spec.replicas is managed by horizontal-pod-autoscaler. It may set
  it back." `kubectl` and Landlens's own managers aren't counted.
- **Leaving with changes asks first**: Esc, Discard, another row, another drawer tab, closing the drawer, another
  page, a namespace or a cluster switch ask "Discard 1 changed line?" in the foot (D31).

Every review and apply runs **as you**: main issues a front-door token for that one call (`you · <context> · edit`,
full access to that cluster), sends through the front door, and revokes the token after, so each request is in the
audit trail under that label and your RBAC applies.

### Create from YAML

The toolbar's **+** opens a wide sheet (D32): an empty editor, a template (Blank, Deployment, Service, ConfigMap,
Job) with the toolbar's namespace filled in, and the same Review and Apply. A document without a namespace goes in
the toolbar's; up to ten documents, split with `---`. The review dry-runs a `POST` per document and shows one
operation each. An object that already exists marks its name ("ConfigMap landlens-dev/x already exists: open it and
edit it instead"); a kind the cluster doesn't serve, a cluster-scoped kind with a namespace, or a Secret is refused
before anything is created (the kind's path comes from the cluster's discovery). After Apply the first object opens in the drawer.

Code: `YamlEdit.tsx` (the editor's stages, rebase, the review card), `CodeEditor.tsx` (CodeMirror with line marks
and messages), `CreateSheet.tsx`, `editGuard.ts`, `packages/kube/src/edits.ts` (`EditBroker`: review, create,
apply, conflict and refusal mapping, other owners from `managedFields`) and `edit-yaml.ts` (what the editor shows,
merge patches, rebasing).

## Port-forward

A port on 127.0.0.1 (and [::1], so `localhost` works either way) that reaches a pod's port, or a Service's through a
pod behind it (D33–D37).

- **Start from a port** (D33). A pod's container cards list each port ("8080/TCP http"), and a Service's Overview has
  a **Ports** card ("80/TCP → http · http"), each with **Forward**. It opens a popover: `127.0.0.1 :` and a local
  port, prefilled with the same port when it is free (on every address, wildcards included) and 1024 or above, else
  one in the 8000s (80 → 8080, 443 → 8443) or the next free one; **Pick a free port**; "Other machines can't reach it; any program or browser page on this Mac can. It runs as you, through Landlens.";
  **Keep after restart** (on); **Start** (Enter). A taken port says "Port 8080 is in use." and offers **Use 8081**.
  Forward is disabled, with the reason, for a UDP port, a pod that isn't running, a Service without a selector, or
  when a SelfSubjectAccessReview says your role can't create `pods/portforward` there.
- **A running forward shows on its port line** (D34): its address, Open in browser and Stop.
- **The panel's pinned Forwards tab** (D35), after the session tabs, with a count of the running ones; the status
  bar's **2 forwards** opens it. Each row: the state (Running, Starting, Reconnecting, Failed, Stopped), `127.0.0.1:8080
  → service/shop-front:80 · shop-front-…bkz8j`, the namespace (or why it failed, or the last connection's error,
  such as "Nothing is listening on port 9999 in the pod (connection refused)."), its age, then Open, Copy address and
  Stop; a stopped or failed one has Start and Remove.
- **A Service forward goes through one ready pod** (D36), the oldest, and its target port (a number, or a container
  port's name). Landlens reads the Service and its pods every 5 seconds: when the pod goes or stops being ready, or
  the selector or port changes, the forward says Reconnecting and moves to another ready pod; when the Service goes,
  it says "Service web is gone.". A pod forward of a Deployment's (or any controller's) pod moves the same way, but
  only to a pod of the same controller (`pod/web-1:8080 · now web-3`); a bare pod's forward fails when the pod goes.
  At most 20 forwards per cluster, and 64 open connections per forward.
- **Kept forwards come back** (D37): they are saved per context (`forwards.json` in Landlens's data, without tokens)
  and start again when you connect to that cluster, without opening a browser: the same cluster, by its API server
  and kube-system's uid, not just the context's name. One whose context now names another cluster stays Stopped with
  "This context now points at another cluster.". One whose port is taken by then shows
  Failed with the reason. Stopping one keeps it stopped after a restart; Remove forgets it. Forwards stop when you
  switch clusters or quit; the ones not kept are forgotten.

**No kubectl.** The design (D36) ran `kubectl port-forward`; Landlens speaks the Kubernetes port-forward API itself,
over a WebSocket (`v4.channel.k8s.io`) per local connection, through the front door. Each pod a forward reaches gets
a token labelled `you · <context> · forward <namespace>/<pod>:<port>` that may open that pod's port-forward on that
one port, over that WebSocket only (no SPDY), and nothing else (policy `forward`), revoked when the forward stops or moves to another pod, which closes its
connections. So every connection is in the audit trail, your RBAC applies, and nothing depends on a kubectl on your
`PATH`.

Code: `Forwards.tsx` (port lines, the popover, the Forwards tab), `apps/desktop/src/main/forwards.ts`
(`ForwardService`: choosing and following the pod, tokens, saving and restoring), `packages/kube/src/forward.ts`
(the WebSocket bridge, listening on 127.0.0.1, choosing a Service's pod and port).

## Custom resources

Kinds a CustomResourceDefinition defines (D38–D41), from discovery: Landlens reads the CRD list (metadata only)
and marks the kinds it names as custom; if your role can't list CRDs, a kind is custom when its group isn't one
Kubernetes serves.

- **One section** (D38), last in the sidebar and closed at first: **Custom resources** with a count, holding
  **Definitions** (the CRD list, moved from Cluster: Name, Group, Kind, Scope, Age), then each API group as a
  folding sub-heading in mono with its count (`k3s.cattle.io 2`), holding its kinds. The section's fold is
  remembered with the others; the API groups' folds per cluster context (D139,
  [design.md](design.md#layout)), and ⌥-click on one folds or unfolds them all. Past 12 kinds a filter field
  ("Filter 40 kinds") narrows them by kind, group or resource. In the rail the section is one Shapes icon with a
  flyout listing the same.
- **Pinned** (D39): a star on a kind's row (on hover) pins it to a Pinned section under Agent; the star there
  unpins it. Pins are per cluster context, in the window's storage, at most 20.
- **Printer columns** (D40): a custom kind's list uses its CRD's columns for the served version (priority 0),
  between Name/Namespace and Age, without the CRD's own Age: dates as ages (the date in the tooltip), numbers
  right-aligned in mono, booleans as a check or a dash and the word, text cut to 300 characters, a column's
  description in its header's tooltip. When an object has a `Ready` or `Available` condition, a Status column
  shows it the pod way (a quiet dot when True, a red badge with the reason when False, muted when Unknown), unless
  the CRD has a Status or Ready column already. The paths are kubectl's JSONPath, read by a small reader that
  never evaluates anything: `.a.b`, `['a.b']`, `a\.b`, `[0]`, `[-1]`, `[*]` and `[?(@.type=="Ready")]` (`==`,
  `!=` against a string, number or boolean); anything else (`..`, ranges, functions) reads as nothing, at most 50
  values.
- **Drawers** (D41): a custom resource's Overview has its printer columns as facts, then the conditions and labels
  every drawer has; Events; YAML (editable, as for any kind). A definition's Overview: group, kind, scope, short
  names, the versions with served, storage and deprecated badges, the served version's columns with their paths,
  and **Open certificates** (its kind's list).

Code: `apps/desktop/src/renderer/src/printer.ts` (the JSONPath reader, columns, the condition cell), `custom.ts`
(the CRD read, the columns, pins), `Sidebar.tsx` (the section, the flyout, pins), `kinds.ts` (`CUSTOM`),
`packages/kube/src/discovery.ts` (`markCustom`).

## Helm releases

Helm's releases, read-only (D42–D43): **Helm releases** is the last item under Workloads.

- **The list** (D42): Name, Namespace, Chart (`name-version`), App version, Revision, Status and Updated, one row per
  release at its latest revision, in the toolbar's namespace or all of them, filtered by name, namespace or chart.
  Status is quiet when deployed, red when failed, amber while pending, muted when superseded or uninstalled. It is
  read on open, every 30 seconds while open, and on the toolbar's Refresh (Helm's releases are Secrets, so they
  aren't watched). A release Landlens can't decode still lists, without a chart, and the page counts them.
- **The drawer** (D43): **Overview** (chart, app version, revision, last action, updated and installed, the chart's
  description, its objects as links to their drawers, and the notes folded); **Values**, *Yours* (what was set at
  install or upgrade) or *All* (yours over the chart's defaults, merged as Helm does, a `null` removing a default),
  saying how many values that look secret are hidden; **Manifest** (the rendered YAML, each Secret's keys kept and its
  values replaced by their size); **History** (every revision with its status, chart, time and description, and
  *Diff values with current* for the older ones). **Ask Claude** adds the release (chart, revision, status, last
  action, your values with secrets hidden, its objects) to the dock as quoted data. There is no upgrade, rollback or
  uninstall.
- **How it reads them**: main lists Helm's release Secrets (`owner=helm`, type `helm.sh/release.v1`) as you, metadata
  only, then reads just the latest revision of each (and the one a drawer or diff asks for). It decodes them itself
  (base64, gzip, JSON), at most 16 MB unpacked, and hides secret values before anything reaches the window: keys that
  name a secret by their words (`password`, `userPassword`, `DB_PASSWORD`, `apiKeys`, `clientSecret`, `privateKey`,
  `credentials`, `dsn` and their kin, but not pointers or switches like `existingSecret`, `passwordKey` or
  `usePassword`) lose their value and everything under it, an `env`-style `{name: DB_PASSWORD, value}` its value,
  and credential-shaped text anywhere (a URL's password, a bearer token) is scrubbed as in logs. A value hidden there
  is hidden in the notes and the manifest too. If you can't read Secrets, the page says so.

The scenario is a small chart, `deploy/scenarios/helm/landlens-demo` (a ConfigMap, a Secret, a Deployment and
notes, with dummy development values), installed twice in `landlens-dev` ([its README](../deploy/scenarios/helm/README.md)).

Code: `packages/kube/src/helm.ts` (decode, list, get, merge, hide), `apps/desktop/src/main/ipc.ts` (`helm:list`,
`helm:get`), `apps/desktop/src/renderer/src/Helm.tsx` (the page and the drawer).

## ⌘K search

⌘K (or **Jump to…**) is search (D44–D45): "Search objects, kinds, problems and actions…", in groups of six:
**Actions** (the app's commands that match), **Problems** (the doctor's, by title or name: wave 5,
[doctor.md](doctor.md#the-problems-page)), **Objects** (by name, across kinds), **Kinds** (the sidebar's kinds and
pages) and **Clusters** (switch to another context).

- **Empty**, it shows the open object's actions ("Actions for catalog-api": Logs, Open shell, Forward a port, Edit,
  Ask Claude, whichever fit its kind), your recent objects and kinds (per context, at most eight), and the pages.
- **A first word** of `logs`, `shell`, `forward`, `edit` or `ask` turns the matches into that action: `shell
  catalog` lists "Open shell in catalog-api-…" for the pods and workloads that have one. Logs fit pods and
  workloads, a shell the same, a forward pods and Services, editing every kind but Secrets, asking every kind.
- **Tab** on an object lists its actions (the object shows as a crumb; Backspace or Esc goes back to the search);
  Tab on a pod's shell or logs row lists its containers. Enter on a shell row opens the pod's only running
  container, or the first.
- **Open in Clickland** (wave 7 part 3): with Clickland's console address set, Tab on a pod or a workload adds
  "Open in Clickland", which opens its last hour of log lines in Clickland's console after the native dialog
  ([metrics.md](metrics.md#logs-and-traces-from-clickland)).
- **`problems`** as the first word searches only problems (`problems cart`); alone it lists the worst six. Enter
  opens a problem's drawer on the Problems page; Tab lists Open, Ask Claude and Open <Kind>. Problems come from the
  report the window already holds: ⌘K reads nothing more for them.
- **`>`** lists the app's commands: Toggle panel, New local terminal, Create from YAML, Show port forwards, Show
  problems, Ask Claude, Toggle sidebar, Fold all sections, Unfold all sections (the sidebar's, D139), Switch cluster…,
  Read names again, and the pages.
- **Enter** opens an object in its list's drawer (reading it first, so a name that has gone says so), or runs the
  action: a forward opens the drawer with the first port's Forward focused.

The names come from main (D45): on the first ⌘K it lists pods, Deployments, StatefulSets, DaemonSets, Jobs,
CronJobs, Services, Ingresses, ConfigMaps, Secrets (names only), claims, nodes and namespaces as you, metadata only,
at most 2,000 of each, and hands every window the same read for 15 seconds (**Read names again** reads now). The list
on screen is searched too, so a custom kind's objects can be found while its list is open. The foot says how many
objects there are and which kinds were left out (not readable, or past 2,000).

Code: `packages/kube/src/search.ts` (the names), `apps/desktop/src/main/ipc.ts` (`search:index`),
`apps/desktop/src/renderer/src/JumpPalette.tsx` (the palette) and `paletteRules.ts` (verbs, matching, the query's
first word).

## Your actions

Wave 8 part 1 (D140–D148, [specs/008-hands](specs/008-hands/spec.md)). The everyday writes, by you, through the same
dry-run card as the YAML editor: **Scale** (Deployments, StatefulSets, ReplicaSets; 0–1000), **Restart** (Deployments,
StatefulSets, DaemonSets; kubectl's `restartedAt` annotation), **Trigger now** (a CronJob makes the Job
`kubectl create job --from` makes), **Suspend** and **Resume** (CronJobs and Jobs), and **Delete…** (any kind the
cluster deletes; Background propagation, pinned to the object's uid and resourceVersion).

- **Where.** The object menu (`ObjectMenu.tsx`, right-click or Shift+F10 on a row, or **⋯** in the drawer's head
  after Copy name): Open (Logs, Open shell, Edit YAML), Actions, Ask Claude, Copy name, and Delete… last in the bad
  colour. Arrow keys, Home/End, type-ahead, Esc. Each action asks `cluster:access` first (cached a minute): one your
  role can't use is disabled and says so ("Your role can't patch deployments in landlens-dev"). ⌘K has the verbs
  `scale`, `restart`, `trigger` and `delete` (delete is never an object's first row). ⌫ (or Delete) on a focused row
  opens the delete review, only when the row itself has focus and the key isn't held (`rowKeys.ts`); no other key
  writes. A Secret has Delete only, and no Ask Claude.
- **The sheet** (`ActionSheet.tsx`). Scale has a form (a number with − and +; arrows step one, Shift+arrows ten);
  the others open on the review. "Checking with the cluster…" while main reads and dry-runs as you; then the card:
  "Your action", main's title ("Scale deployment landlens-dev/hands-web to 3 replicas"), risk tags, main's facts,
  the diff and the cluster's warnings. Apply sends the review's id and digest (the SHA-256 of the card main answered
  and the requests it keeps); a key held down never presses it. The result is one line per object (applied, already
  gone, changed after your review, a Job of that name already there, failed; a request that got no answer in 30 s is
  "may have been applied"), with **Review again** on a conflict. Nothing is optimistic: the table changes when the
  watch does.
- **Facts** (`actionFacts` in `packages/kube/src/actions.ts`): at most 8 of Landlens's own sentences, the loudest
  first; past 8 the last says how many more and of which tones ("And 23 more: 23 serious."), in the loudest one. An
  autoscaler (autoscaling/v2, or v1 where v2 isn't served) that will set the count back; a Deployment that will set
  its ReplicaSet's count back; a PodDisruptionBudget a scale goes under; one pod with no surge; a rollout already in
  progress; what a deleted object's owner does (a ReplicaSet makes a new pod; a Job only if it hasn't finished; a
  CronJob doesn't make its Job again), or that nothing will recreate it; finalizers; every claim's volume and its
  reclaim policy; a Namespace's contents; Helm's release record; a CronJob that is suspended or Forbid with a run
  going; a list cut at 500. A read that fails says "Landlens couldn't check …" and never blocks the review. Facts
  are read when you review: by Apply they can be up to 15 minutes old.
- **Main's own dialog** (a native dialog after the card's button, Cancel the default). It asks for: a delete of
  more than one object; a delete of any cluster-scoped kind (a Namespace, CRD, Node, PersistentVolume, APIService,
  ClusterRole, ClusterRoleBinding, StorageClass, a cluster-scoped custom resource); a delete with a serious fact (a
  claim whose volume goes with it, a Namespace), of a claim whose volume Landlens couldn't read, or of a workload
  with 10 pods or more; a restart of more than 3 workloads; and any apply after a window has had more than 3 objects
  changed in the last minute ("This window has sent 3 changes in the last minute…"), so a bulk split into singles
  still asks. The dialog names what and where: "Delete 12 ConfigMaps in 2 namespaces on orbstack?", the count by
  namespace, every flagged object (cluster-scoped, in a system namespace like `kube-system`, or outside the
  namespace most are in) by `namespace/name` first, then the rest, ten and "and N more in landlens-dev". The first
  Cancel keeps the review; the second drops it.
- **Recent actions** (`RecentActions.tsx`, `main/action-log.ts`): one row per apply (and per Cancel in main's
  dialog), kept in `userData/actions.json` (0600, the newest 500, a file over 4 MB moved aside), shown newest first
  from the status bar's History item (with the count since start) or ⌘K's "Recent actions", for the connected
  cluster only (its context and its API server). A row is written as *Sent* before the first request and settled
  when they answer; if the log can't take it, nothing is sent. A row is its action, kind (with its group and
  resource, so a click opens that kind), names and a closed detail ("2 → 3 replicas"); no diff, no message and no
  value. It is a convenience record on this computer, not evidence: the front door's audit is.
- **Ask Claude first** puts the review in the dock as quoted data with a fixed question ([agent.md](agent.md#ask-claude-first)).

Code: `packages/kube/src/actions.ts` (builders, the kind table in `action-kinds.ts`, facts), `changes.ts`
(`prepareOp`, shared with the agent's broker), `edits.ts` (`reviewOps`, `apply({ each })`, the digest),
`apps/desktop/src/main/actions.ts` (`ActionService`), `as-you.ts`, `native-confirm.ts`, `action-log.ts`, and the
renderer's `ActionSheet.tsx`, `ReviewCard.tsx`, `ObjectMenu.tsx`, `RecentActions.tsx`, `actionAsks.ts`.

## Tables: selection, columns, namespaces

Wave 8 part 3 (D155–D158). Every resource table can select rows, hide columns, keep its sort and list several
namespaces at once.

- **Selection** (D156). A 28 px checkbox column on the left; the head's checkbox (tri-state, "Select every row
  shown") takes or drops the rows the filter shows. Shift+click on a checkbox takes the range from the last row you
  toggled. On a focused row `x` or Space toggles it, ⌘A (Ctrl+A) takes every row shown; Esc clears the selection
  before it closes the drawer. Rows are selected by uid: a row that leaves the watch leaves the selection, and the
  selection is cleared when you change kind or namespaces. While rows are selected the toolbar's right side is the
  selection bar: "3 selected", the kind's bulk actions (**Restart** for Deployments, StatefulSets and DaemonSets;
  **Delete…** for any kind main deletes in bulk, not the cluster-wide ones such as Namespaces or Nodes), **Ask
  Claude** (not on Secrets) and Clear. In a narrow pane the buttons are their icons. Past 50 the actions are off ("At
  most 50 at once").
- **Bulk actions** go through the same sheet and card as one object ("Delete 3 configmaps in landlens-dev"): one
  review in main, one diff per object (past three, the rest fold to their head lines with "Show N more"), one Apply,
  digest-checked, and main's own dialog by the same rules as any action (a delete of more than one object always
  asks; a restart of more than 3; the window's budget of 3 changed objects a minute). An object the dry run refuses
  is left out of the bulk, and the card says so ("2 of 3 can be deleted. Left out, in the cluster's words:" and the
  cluster's message); main's dialog, title and Recent actions name only the objects Apply sends. When every object is
  refused there is nothing to apply.
- **Columns and sort** (D157). The Columns button (after Refresh) lists the kind's columns as checkboxes; Name is
  always shown; Reset shows them all. A header click sorts, and the sort is kept per kind. Both are stored in
  `localStorage` under `landlens.table.v1` (per kind key `resource` or `resource.group`), with the namespaces chosen
  per context, read through a tolerant parser (`tableState.ts`): at most 200 kinds and contexts, 40 column ids, 50
  namespaces, Kubernetes names only; anything else is dropped and a damaged value is no choices.
- **Several namespaces** (D158). The namespace button opens a popover: a filter, **All namespaces**, a checkbox per
  namespace (the chosen first) and **Only** on hover; Only and All choose and close. The button reads "All
  namespaces", the one name, or "3 namespaces". Two to eight are watched one watch each, merged by uid; more than
  eight use the all-namespaces watch filtered in the window, and if your account can't list across namespaces, the
  first eight (the status bar says how many are left out). Helm releases and the Problems list keep the chosen
  namespaces (problems with no namespace stay); the Overview shows the whole cluster and says so ("3 namespaces
  selected: this page shows the whole cluster"). A link to an object outside the chosen set adds its namespace when
  several are chosen, and moves to it when one is.

Code: `apps/desktop/src/renderer/src/tableState.ts` (the stored state, the parser, the watch plan, the selection's
rules, `bulkActions`), `TablePickers.tsx` (the namespace popover, the column picker, the selection bar),
`ResourceTable.tsx`, `rowKeys.ts`, `api.ts` (`useWatchMany`), `Workspace.tsx`, and main's `keptTargets` in
`apps/desktop/src/main/actions.ts`.

## Nodes: cordon and drain

Wave 8 part 2 (D149–D154). A Node's menu (and the drawer's ⋯, and ⌘K's `cordon`, `uncordon` and `drain` verbs) has
**Cordon** or **Uncordon** by its state, then **Drain…**.

- **Cordon and uncordon** are one merge patch of `spec.unschedulable` (`true`, or `null` to remove it, as kubectl
  does), pinned to the node's resourceVersion, dry-run and shown on the same card as any action, with the
  Cluster-wide tag (so a second click). Facts: how many pods keep running on it, and, when no other Ready, schedulable
  node exists, "This is the only node that takes new pods" (and then new pods "stay Pending"). A node with a
  NoSchedule or NoExecute taint doesn't count as schedulable, and every node is read, in pages. The Nodes table's
  Status already reads `Ready,SchedulingDisabled` for a cordoned node.
- **Drain's preview** (`packages/kube/src/drain.ts`, `DrainPlanView.tsx`) is a plan, not a diff. Main reads the node,
  its pods (all namespaces, `fieldSelector=spec.nodeName`) and the PodDisruptionBudgets as you, then classes each pod
  as kubectl drain would: DaemonSet pods and static pods' mirrors stay; finished pods are evicted without a budget
  check; terminating pods are left; a pod nothing recreates (bare, or one whose DaemonSet is gone: "its DaemonSet is
  gone") is blocked until you tick **Delete pods that nothing will recreate**, one with emptyDir volumes until you tick
  **Lose emptyDir data**; a budget that allows no
  disruption, or two budgets on one pod (which the eviction API refuses), block. Then main asks the API server with
  a **dry-run eviction** of each pod it would move, and where the cluster's answer differs from Landlens's reading,
  the row shows the cluster's (and the sheet says on how many). Past 2,000 pods or budgets, or when a namespace's
  budgets can't be listed (a single namespace past 2,000 included), the plan is partial and can't run. When no other
  node takes new pods, the sheet and main's dialog say "No other node takes new pods: every pod evicted stays
  Pending."
- **The sheet.** "Drain node-2", three counts with icons (to evict, blocked, stay), the two ticks (each re-reviews
  after 300 ms), then one column of rows grouped *Blocked* (a red edge, with what would unblock each), *Will be
  evicted* and *Stay* (folded): the pod in mono, its namespace, its owner as a link, chips (`budget hands-web-pdb · 0
  allowed`, `bare`, `emptyDir cache`, `DaemonSet`). **Drain…** is off while a row waits on a tick, the plan is
  partial, the build is preview only, or the review on screen isn't the one for the boxes as they are: a tick change
  drops the review at once, only the latest review's answer is used, and a newer review of the node in the same
  window replaces the older in main too. A plan blocked only by budgets may run (those pods are retried and
  reported). **Ask Claude** sends the plan as names, classes and counts only, quoted as data, with "Which blockers
  matter, and what is a safe order?".
- **The run.** After main's own dialog ("Drain node-2 on orbstack? 9 pods will be evicted, 1 is blocked by a
  disruption budget and will be retried, 3 DaemonSet pods stay.", then, when the ticks let them go, "2 pods are
  recreated by nothing and deleted for good:" and "1 pod loses emptyDir data:" each with its pods by name, the only-node
  line when it applies, and the pods it evicts counted by namespace, each one in a system namespace by name), main
  writes its Recent actions row and answers with a run at once and works on its own token (`you · <context> · drain
  <node>`). It first reads the node and its pods again: another node under the same name, or a node the preview
  found cordoned and that isn't now, ends the run with nothing evicted ("The node was uncordoned since the preview");
  a reviewed pod no longer on the node is *gone* without a request, and one whose controller went since isn't evicted
  without the bare tick. Then the cordon it kept, pinned to the node's version: on a 409 it reads the node again and,
  if it is the same node and still schedulable, sends the cordon once more pinned to the version just read (the
  kubelet moves a node's version every few minutes); a second 409 stops the run before any eviction ("The node
  changed since the preview"). Then the evictions of exactly the pods the preview listed, by uid, four at a time,
  reading the node before each pass: uncordoned during the run, it stops evicting ("The node was uncordoned during
  the drain"). A 429 from a disruption budget is tried again every 5 s; any other 429 after its Retry-After (at most
  30 s); no eviction is sent after the run's 10 minutes, and then a budget's pod is *blocked*, a busy cluster's
  *failed* ("too busy"), one never reached "not tried". A 404 or a 409 (another pod has its name now) is *gone*
  (after an answer that was lost, *evicted*); anything else *failed* in a fixed sentence. An evicted pod is followed
  with a GET by name until it is gone (past 20, one list of the node's pods from the API server's cache, at most
  every 5 s). **Stop** sends no new eviction; a run also stops when its window navigates or goes or its cluster goes.
  At the end the node and its pods are read once more: the sheet says "The node stays cordoned." only when it read
  so ("The node is no longer cordoned." otherwise), and "N pods arrived after the preview and are still on it. Drain
  again." for pods a drain would evict that weren't in the preview (the row is then *partial*). Landlens never
  uncordons on its own; the end offers **Uncordon…**. Progress comes to the window that started the run, at most
  four times a second, each push numbered; one row goes to Recent actions ("Drained Node node-2 · 9 evicted, 1
  blocked"). One run per node, two per cluster. Landlens never deletes a pod, never sends a grace period of its own,
  and never bypasses a budget (no `--disable-eviction`).
- **A run you can always reach.** The sheet listens for progress from the moment it opens and asks main for the run's
  latest state as it starts, so a drain that ends at once (nothing to evict) still shows its end. The sheet can be
  closed while the run goes on ("Closing this sheet leaves the drain running; the status bar shows it, with Stop.");
  the status bar then shows **Draining node-2**, which opens the sheet again on the run, with Stop. Main keeps each
  window's runs, and an ended one for ten minutes; another window sees none of them. Quitting Landlens with a drain
  running asks first ("1 drain will end"), then stops it and leaves its row as *stopped*; the node stays cordoned.
- **A development build is preview only on every cluster** (D153). An unpackaged Landlens sends no node write, no dry
  run to a node and no eviction, dry run or not, through any path, unless `LANDLENS_NODE_WRITES` names the cluster as
  `<context>@<host>:<port>` (comma-separated; the context and its API server, as `kubectl config view` shows the
  server; read only when the app isn't packaged). The front door refuses such a request for every token, before
  anything is proxied (security review of part 2, M5): your actions, the YAML editor (its foot says "Not sent:
  Landlens: Development build: preview only…"), the agent's change cards and their dry runs, kube-mcp, and `kubectl
  cordon` or `kubectl drain` in Landlens's terminals. `ActionService` keeps its own fence too; cordon's card is then
  Landlens's own reading of the patch and drain's plan has no dry runs, both saying "Development build: preview only.
  Nothing is sent to nodes on this cluster." with Apply off. Nothing sets the variable, and the e2e takes it out of
  its environment: OrbStack's one node is shared with the siblings. A packaged app's rule allows every cluster.

Code: `packages/kube/src/drain.ts` (the plan, the reads, the dry-run evictions, the run), `actions.ts` (`cordonBody`,
cordon's facts, `schedulable`), `frontdoor.ts` (`nodeWrite`, the front door's rule), `apps/desktop/src/main/actions.ts`
(`prepareNode`, the run, `stop`, `runsOf`, `quit`, the fence, `nodeWritesFrom`), the renderer's `DrainPlanView.tsx`
(the drain sheet, `useDrainRuns`), `drainRuns.ts` (the sheet's sequencing), `StatusBar.tsx` (the chip) and
`ActionSheet.tsx` (cordon's card).

## Secrets and certificates

Wave 8 part 4 (D161–D168). A Secret's values stay in main, as before, except one key at a time, on your click, after
main's own dialog; a copy never reaches the window at all. [security.md](security.md#secret-values) has every rule and
its test.

- **Data.** A Secret's drawer Overview lists its keys in mono with their sizes, each with **Copy** and **Reveal**. Your
  role must be able to `get secrets` in the namespace (asked once a minute through `cluster:access`); if not, both are
  off and say why. A Helm release record (`helm.sh/release.v1`) shows "Helm's release record: open it under Helm" and
  no buttons; main refuses it too. The YAML tab stays `••••••`, and there is still no Ask Claude on a Secret.
- **Unlock.** The first press of either asks main, which reads the Secret (as you, one GET) and shows its own dialog on
  your window: "Show values of Secret landlens-dev/hands-secret?", "Values are shown to you only, for 30 seconds at a
  time. Claude never sees them. On orbstack.", **Show values** or **Cancel** (the default). Yes unlocks that Secret,
  by uid, for that window on that cluster, for 5 minutes; a chip in the section's head counts down ("Unlocked ·
  4:12") with **Lock now**. The unlock ends at its time, on Lock now, when the window reloads or goes, when the
  cluster disconnects, and when the window connects another cluster. At most 5 Secrets unlocked a window.
- **Reveal** shows that key's value under its row, in mono, for 30 seconds (a thin countdown line and "Hides in 23 s"),
  then it goes; **Hide** ends it sooner, and so does the window losing focus or being hidden, closing the drawer,
  changing object or tab, the Secret changing (its `resourceVersion`), Lock now and the unlock's end. One value at a
  time: revealing another hides the first. It can't be selected, copied, dragged or right-clicked out; control and
  format characters (a bidi override, zero-width) are drawn as escapes (`\u{202E}`). A value that isn't UTF-8 shows
  only its size ("Not text: copy it as base64"); one over 64 KiB, "copy it instead". If the Secret was replaced under
  the same name since the unlock: "It changed since you unlocked it: unlock again."
- **Copy** puts the value on the system clipboard from main: the window never has it. On macOS the clipboard write
  carries the concealed marker (`org.nspasteboard.ConcealedType`) so clipboard managers that honour it skip it. The
  row says "Copied. Clears in 30 s" and counts down; 30 s later, and when Landlens quits, main clears the clipboard
  if it still holds that value (never something you copied since). A binary value offers **Copy as base64**. While
  the clipboard holds it, a message to Claude (or a change's note, or a brain summary) that contains it is refused:
  "That is a Secret value Landlens copied for you: it isn't sent to Claude."
- **10 values a minute** a window (reveals and copies); each reveal and copy is a row in Recent actions ("Revealed key
  `password` of landlens-dev/hands-secret"): the key's name, never its value or length. Telemetry counts neither.
- **Certificates.** A `kubernetes.io/tls` Secret shows **Certificates** on open; other Secrets have a quiet **Look for
  certificates** link, so main doesn't read every Secret you click. Main reads `tls.crt` and `ca.crt` only (never
  `tls.key`) and gives one card per certificate, the leaf first: the subject's CN, **expires in 12 days** (ok, warn
  under 30 days, bad under 7 or expired, with an icon and words), CA and self-signed badges, issuer, names (SANs,
  folded past 6), valid from–to, key (`EC prime256v1`, `RSA 2048`), serial and SHA-256 with a copy button each, and
  a chain line ("leaf → R11 → ISRG Root X1") when `tls.crt` holds more than one. No unlock: only public halves leave
  main. Everything on a card is the certificate's own text.

Code: `apps/desktop/src/main/secrets.ts` (`SecretService`: unlock, lock, reveal, copy, certs, the clipboard and the
prompt guard), `packages/kube/src/certs.ts` (`certDetails`), `policy.ts` (the `object` policy) and `frontdoor.ts` (its
one use), the renderer's `SecretData.tsx` (the Data section, `SecretValue`), `CertPanel.tsx` and `secretText.ts`.

## Tests

- Secrets and certificates (wave 8 part 4): `packages/kube` `policy.test.ts` and `frontdoor.test.ts` (the `object`
  policy's one GET, used once; no upgrade; the audit without a value), `certs.test.ts` (`certDetails`: public halves,
  never `tls.key`, a spy on `createPrivateKey`, caps); `apps/desktop` `secrets-main.test.ts` (unlock, its endings,
  reveal, copy and the clipboard's clear, the rate, the log rows, fixed sentences, certificates, the prompt guard; a
  marker searched for in errors, rows and every console line), `telemetry-main.test.ts` (no record for a reveal),
  `quotes.test.ts` (no quote about a Secret), `secret-text.test.ts`, and on OrbStack `secrets.e2e.test.ts` (it makes
  throwaway Secrets `hands-reveal-e2e` and `hands-reveal-tls` in landlens-dev and removes them: nothing before a
  reveal, the dialog's words, Reveal and Hide, 30 s, blur, a tab change, a bidi override, Copy with the concealed
  marker and the cleared clipboard, the dock's refusal, the certificate panel, Lock now, and a `grep -rlF` of the
  whole profile, the fake agent's prompts included).
- Nodes (wave 8 part 2): `packages/kube` `drain.test.ts` (every class and block from table-driven pods, the ticks,
  partial past the caps and on a 403; against the in-memory `fake-api.ts`: a review sends only GETs and dry runs and
  spends nothing, a run cordons first, evicts only the reviewed uids, retries a 429 and ends it blocked, treats a
  replaced pod as gone, stops on Stop with the node cordoned, never deletes a pod or sends a grace period), on
  OrbStack `drain.integration.test.ts` (dry-run evictions of the scenario's pods only: hands-web's answers 429 for
  hands-web-pdb with the budget unchanged; under a throwaway budget that allows one, hands-bare's is accepted and the
  budget still allows one, its disruptedPods empty, the pod the same uid; a wrong uid is a 409; the plan of the real
  node agrees with the API server on the scenario's pods); `apps/desktop` `nodes-main.test.ts` (D153 with the fake's
  record: nothing to nodes unless listed, packaged ignores the variable, the fence however a path is spelled; cordon;
  main's dialog and Cancel; the run's token, progress to its window only, Stop from its window only, the window's
  end, one run per node, the digest; then one block for the part's security review: runs read back, the ticks in the
  dialog and digest, a superseded review, the window's own runs, its cluster gone, two per cluster, navigation and
  destroy, Stop mid-pass, quit, the only node), `drain-runs.test.ts` (the sheet's sequencing) and
  `nodes.e2e.test.ts` (reads only: the menu, the drain preview with the scenario's pods where they belong, the ticks,
  cordon's preview, ⌘K, the YAML editor's node change refused by the front door; with main's run channels stubbed, the
  chip, the re-opened sheet, Stop and the ending; the node and every landlens-dev pod's uid as they were). A real
  drain runs only against the fake.
- Tables and asks (wave 8 part 3): `apps/desktop` `table-state.test.ts` (the parser: caps, names, `__proto__`;
  Name never hidden; the watch plan; Shift ranges, pruning, the head's tri-state; the bulk actions per kind),
  `ask-presets.test.ts` (the presets per kind, failing first, none on Secrets, the fixed questions; the selection's
  quote: names and status words only, a marker in labels, annotations, env and a status message never in it, odd
  words read Unknown, 50 lines, never for Secrets; the quote's head), `row-keys.test.ts` (`x`, Space and ⌘A),
  `actions-main.test.ts` (a refused object left out and never named by main's dialog, title or log; every object
  refused; across namespaces) and, on OrbStack, `tables.e2e.test.ts` (it makes ConfigMaps `hands-bulk-1..6` in
  landlens-dev and removes them: three selected by click and Shift+click deleted through one card, main's dialog
  answered Cancel then yes, the other three still there; `x`, ⌘A, Esc; Age hidden and the sort kept across a reload;
  landlens-dev and default together; Summarize from a row's menu reaching the fake agent with the object attached;
  Ask Claude about these 2 leaving its question selected and sending nothing; a Secret's selection with no ask; ⌘K's
  presets).
- Your actions (wave 8): `packages/kube` `actions.test.ts` (each body, kubectl's Job, the kind table and refusals,
  every fact, no copied text), `edits.test.ts` (`reviewOps`, apply each, the digest, a Secret's delete), on OrbStack
  `actions.integration.test.ts` (scale, restart, suspend and trigger hands-* for real and put back; the triggered Job
  equal to `kubectl create job --from`'s; a delete pinned to an old version is a 409; a Secret's review has no value);
  `apps/desktop` `actions-main.test.ts` (as you, owner, digest, main's dialog, discovery, limits; then one block per
  finding of the part's security review: the dialog's list, the window's budget, the row before the request, facts
  past the cut, what asks alone, the named rules), `action-log.test.ts`, `row-keys.test.ts`, `palette.test.ts`,
  `quotes.test.ts`, and `actions.e2e.test.ts` (menu, drawer ⋯, ⌘K, conflict, Enter on a fresh card, Enter held from
  the menu, ⌫, a Secret's review, Recent actions).
- `packages/kube`: `edits.test.ts` (merge patches, rebasing, refusals mapped to lines, owners, create checks),
  `workbench.test.ts` (exit statuses, exec and log paths) and, on OrbStack,
  `workbench.integration.test.ts` (a followed log in order; a shell through the front door with the size it was
  given, an exit code and the audit's 101; a missing pod refused with 404; a revoked token refused with 401).
- `apps/desktop`: `workbench.test.ts` (logs go to the window that asked and stop with it or the cluster; each shell's
  token is labelled as you, full access to that one cluster, and revoked when it ends; another window can't type,
  resize or close it; 20 a window; a local terminal's environment), `log-rows.test.ts` (time order, merging pods,
  ANSI, search), `edits.test.ts` (reviews and applies as you with a token per call; only the reviewing window, on
  the same cluster, once), `forwards.test.ts` (a Service's oldest ready pod with a token for its one port; moving to
  another pod when it goes, revoking the old token; Reconnecting with no pod; a bare pod's forward failing; a taken
  port with a free one offered; kept forwards saved without tokens, mode 0600, restored on reconnect but not the
  stopped ones; forwards end with their cluster; and the security review's cases: nothing runs after a stop, remove
  or cluster loss during a start; the cap after the reads; one check at a time; the connection cap; following only
  the same controller, a changed or deleted Service, never an empty selector; a tampered `forwards.json`; another
  cluster under the same context).
- `packages/kube`: `forward.test.ts` (the bridge against a stand-in kubelet: the port prefix skipped, the token sent,
  a refused connection in words, a refused upgrade's status, a non-text message, capped error text and bodies;
  127.0.0.1 and [::1], a wildcard listener as taken; suggested ports; a Service's target and pod) and, on OrbStack,
  `forward.integration.test.ts` (three requests at once through the front door with the forward token and in the
  audit; nothing listening; another port refused with 403; a revoked token with 401; SPDY, tunnelled SPDY and extra
  query keys refused with 403).
- `packages/kube`: `helm.test.ts` (decoding, gzipped or not, and a decompression bomb refused; the list through
  metadata, latest revision only, counting the unreadable; values, manifest, objects and history with no secret
  value in them; which keys are secrets and which point at one; Helm's merge and `__proto__`; an unreadable manifest
  document dropped) and, on OrbStack, `helm.integration.test.ts` (the demo release listed and read through the front
  door, with none of its dummy secrets in values, manifest or notes). `apps/desktop/test/helm.e2e.test.ts`: the list,
  the drawer's four tabs, the values diff, no dummy secret anywhere in the page, Ask Claude and an object's link.
- `packages/kube/test/search.test.ts` (the palette's names: only searchable kinds that can be listed, metadata only,
  capped; names and namespaces out, never a Secret's data or annotations; unreadable and cut kinds named).
  `apps/desktop/test/palette.test.ts` (a query's first word, ranking, the actions that fit a kind).
  `palette.e2e.test.ts` on OrbStack: the demo chart's objects found across kinds and opened in their drawer, recent
  items and the open object's actions, `logs` as a first word (no Secrets or ConfigMaps), Tab on a Secret (only Ask
  Claude) and back, a pod shell from `shell`, a local terminal from `>`.
- `apps/desktop/test/workbench.e2e.test.ts` on OrbStack with `deploy/scenarios/workbench.yaml` (`shop-web`, two
  pods, an `app` container that logs every second and a `sidecar` with no shell): follows a pod's log, searches it,
  opens a shell that runs as you and reconnects after `exit 3`, the no-shell case, a deployment's two pods merged and
  opened in the panel, a local terminal whose `kubectl get deploy` goes through Landlens, hiding and showing the
  panel, and 1024×700. `edit.e2e.test.ts`: edits `shop-web`'s replicas through review and apply (a dry run
  changes nothing; only `spec.replicas` is Landlens's afterwards), a refused edit marks line 12, Esc asks before
  discarding, and creates a ConfigMap from the template, then again ("already exists"). It puts `shop-web` back to
  two replicas and deletes the ConfigMap. `forward.e2e.test.ts` (`shop-front`, a web server behind a Service):
  forwards the Service from its Ports card and fetches through it, forwards the pod's container port after a taken
  port is offered another, lists both in the Forwards tab, deletes the pod and sees the Service forward move to the
  new one and still serve, stops and removes the pod forward, and gets the kept forward back after a restart.

```bash
kubectl --context orbstack apply -f deploy/scenarios/workbench.yaml
helm --kube-context orbstack -n landlens-dev install landlens-demo deploy/scenarios/helm/landlens-demo
helm --kube-context orbstack -n landlens-dev upgrade landlens-demo deploy/scenarios/helm/landlens-demo --set message=hi --set replicaCount=2
LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/kube test:integration
LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e
```

## Still to come in wave 4

Nothing: part 4 closed with Prometheus as a graphs source ([metrics.md](metrics.md#prometheus)). See
[limitations.md](limitations.md) for what parts 1 to 4 leave out.
