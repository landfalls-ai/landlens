# The workbench

Wave 4 turns Landlens from a viewer into a place to work: logs that follow, a shell in any container, a terminal on
your Mac whose kubectl goes through Landlens, a YAML editor, and, in the parts still to come, port-forward, CRD
columns, Helm releases and a full command palette. This page covers what is built (part 1: logs and terminals; part
2: the YAML editor). The design is Fable's spec for wave 4 (decisions D1–D46, cited below).

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
  searching pauses following (D14).
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
  issued for that terminal alone, labelled `you · <context> · shell <namespace>/<pod>`, so it is in the audit trail
  and the cluster's RBAC for you applies. The token is revoked when the shell ends. If your role can't create
  `pods/exec` in the namespace, the Shell buttons are disabled and say so.
- **Pasting more than one line asks first** (D9): "Paste 14 lines into app? Each line runs in the pod as you."
  Enter pastes, Esc cancels. A local terminal never asks.
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
terminal (`you · <context> · terminal`) in the shell's environment (`LANDLENS_TOKEN`, read by an exec credential
plugin, as the agent's fence does). The file and its cache folder are removed and the token revoked when the shell
exits or the tab closes. The strip says "zsh on this Mac · kubectl points at orbstack through Landlens".

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
  **Apply** (Enter; a danger risk asks a second time), **Back to editing** (Esc) and **Ask Claude to check it**,
  which adds the diff to the dock's composer as a chip.
- **Apply sends exactly the request the review dry-ran**, without `dryRun`. Only the window that reviewed it can
  send it, on the same cluster, within 15 minutes, once. The tab then shows the read-only YAML with "Applied ·
  deployment landlens-dev/shop-web · +1 −1" above it (D31).
- **Refused** (D28): a 422's causes mark their lines red, with the cluster's message beneath ("Invalid value: -1:
  must be greater than or equal to 0"); the foot says "The cluster refused this: 1 problem, on line 12. Nothing has
  changed." Causes without a field go in the foot. A YAML syntax error marks its line the same way, before anything
  is sent; changing `apiVersion`, `kind`, the name or the namespace is refused, as is "Nothing changed".
- **Someone changed it** (D29): when the object's `resourceVersion` moves while you edit, your changes are moved
  onto the new version and a banner says what they changed. Where you both changed a field, yours is kept and the
  banner names it. A review that is already showing goes back to the editor ("review again"); an apply whose version
  moved gets a 409 and does the same.
- **Another owner** (D30): if a field you changed is managed by another field manager (an HPA's replicas, a
  controller's annotations), the review card says "spec.replicas is managed by horizontal-pod-autoscaler. It may set
  it back." `kubectl` and Landlens's own managers aren't counted.
- **Leaving with changes asks first**: Esc, Discard, another row, closing the drawer, another page, a namespace or a
  cluster switch ask "Discard 1 changed line?" in the foot (D31).

Every review and apply runs **as you**: main issues a front-door token for that one call (`you · <context> · edit`,
full access to that cluster), sends through the front door, and revokes the token after, so each request is in the
audit trail under that label and your RBAC applies.

### Create from YAML

The toolbar's **+** opens a wide sheet (D32): an empty editor, a template (Blank, Deployment, Service, ConfigMap,
Job) with the toolbar's namespace filled in, and the same Review and Apply. A document without a namespace goes in
the toolbar's; up to ten documents, split with `---`. The review dry-runs a `POST` per document and shows one
operation each. An object that already exists marks its name ("ConfigMap landlens-dev/x already exists: open it and
edit it instead"); a kind the cluster doesn't serve, a cluster-scoped kind with a namespace, or a Secret is refused
before anything is sent. After Apply the first object opens in the drawer.

Code: `YamlEdit.tsx` (the editor's stages, rebase, the review card), `CodeEditor.tsx` (CodeMirror with line marks
and messages), `CreateSheet.tsx`, `editGuard.ts`, `packages/kube/src/edits.ts` (`EditBroker`: review, create,
apply, conflict and refusal mapping, other owners from `managedFields`) and `edit-yaml.ts` (what the editor shows,
merge patches, rebasing).

## Tests

- `packages/kube`: `edits.test.ts` (merge patches, rebasing, refusals mapped to lines, owners, create checks),
  `workbench.test.ts` (exit statuses, exec and log paths) and, on OrbStack,
  `workbench.integration.test.ts` (a followed log in order; a shell through the front door with the size it was
  given, an exit code and the audit's 101; a missing pod refused with 404; a revoked token refused with 401).
- `apps/desktop`: `workbench.test.ts` (logs go to the window that asked and stop with it or the cluster; each shell's
  token is labelled as you, full access to that one cluster, and revoked when it ends; another window can't type,
  resize or close it; 20 a window; a local terminal's environment), `log-rows.test.ts` (time order, merging pods,
  ANSI, search), `edits.test.ts` (reviews and applies as you with a token per call; only the reviewing window, on
  the same cluster, once).
- `apps/desktop/test/workbench.e2e.test.ts` on OrbStack with `deploy/scenarios/workbench.yaml` (`shop-web`, two
  pods, an `app` container that logs every second and a `sidecar` with no shell): follows a pod's log, searches it,
  opens a shell that runs as you and reconnects after `exit 3`, the no-shell case, a deployment's two pods merged and
  opened in the panel, a local terminal whose `kubectl get deploy` goes through Landlens, hiding and showing the
  panel, and 1024×700. `edit.e2e.test.ts`: edits `shop-web`'s replicas through review and apply (a dry run
  changes nothing; only `spec.replicas` is Landlens's afterwards), a refused edit marks line 12, Esc asks before
  discarding, and creates a ConfigMap from the template, then again ("already exists"). It puts `shop-web` back to
  two replicas and deletes the ConfigMap.

```bash
kubectl --context orbstack apply -f deploy/scenarios/workbench.yaml
LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/kube test:integration
LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/desktop test:e2e
```

## Still to come in wave 4

Part 3, port-forward (D33–D37); part 4, CRD printer columns, Helm releases (read), the full ⌘K palette and
Prometheus (D38–D45). See [limitations.md](limitations.md) for what parts 1 and 2 leave out.
