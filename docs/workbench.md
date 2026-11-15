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
  folding sub-heading in mono with its count (`k3s.cattle.io 2`), holding its kinds. Past 12 kinds a filter field
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
- **`problems`** as the first word searches only problems (`problems cart`); alone it lists the worst six. Enter
  opens a problem's drawer on the Problems page; Tab lists Open, Ask Claude and Open <Kind>. Problems come from the
  report the window already holds: ⌘K reads nothing more for them.
- **`>`** lists the app's commands: Toggle panel, New local terminal, Create from YAML, Show port forwards, Show
  problems, Ask Claude, Toggle sidebar, Switch cluster…, Read names again, and the pages.
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

## Tests

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
