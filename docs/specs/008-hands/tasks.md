# Wave 8: Hands — tasks

The spec is [spec.md](spec.md) (D140–D172). Each part ends running on OrbStack with its tests green, its docs moved
and a Fable security review.

## Part 1: your actions (D140–D148) — built 16 Nov 2026

- [x] `prepareOp` out of `ChangeBroker.prepare`; `EditBroker.reviewOps` (four at a time, `hideSecrets`), `apply({ each })`, the digest (D140)
- [x] `actions.ts`: the kind table (`action-kinds.ts`), builders, kubectl's triggered Job, facts (D141, D142)
- [x] `ActionService`, `as-you.ts`, `native-confirm.ts`, limits (D143); IPC `action:review|apply|discard|log` (D144)
- [x] `ActionSheet.tsx`, `ReviewCard.tsx` with `eyebrow`, `facts` and main's dialog label (D145)
- [x] `ObjectMenu.tsx` (replaces `RowMenu`), the drawer's ⋯, ⌘K verbs, ⌫ on a row, RBAC per item (D146)
- [x] `action-log.ts`, Recent actions, `landlens.actions` telemetry (D147)
- [x] Ask Claude first (`actionAsks.ts`, the quote head) (D148)
- [x] Tests (D169), the hands scenario, docs (D171)
- [x] Fable's security review of part 1 (no High, 6 Medium, 13 Low), every finding fixed with a test that fails
  without its fix (checked by reverting each, 36 unit cases and the e2e of L4):
  - M1: main's dialog lists `namespace/name`, sorted in main, the flagged first (cluster-scoped, system namespaces,
    another namespace), with counts by namespace; nothing flagged behind "and N more". A drain's dialog counts the
    evicted pods by namespace and names each in a system namespace.
  - M2: a window's budget of 3 card-approved objects a minute; past it, main's dialog. A restart of more than 3 asks.
  - M3: the log row is written as `sent` before the first request and settled after; a log that can't take it
    refuses the apply; the schema takes any CRD kind, any count, any context. The drain's row too.
  - M4: "And N more" with the loudest tone; every PVC's volume read; main decides from the uncut facts.
  - M5: every cluster-scoped kind, a PVC on a Delete or unread volume, and 10 pods or more ask (`asksInMain`).
  - M6: tests for the 429 while asking, a review gone during the dialog (three ways), the minute, the facts'
    fallback, each wide kind, a cluster-scoped kind with a namespace.
  - L1 `keepObjects`; L2 the digest covers the card (and a drain's plan); L3 two Cancels drop the review; L4 a
    repeated key never presses Apply; L5 row keys only on the row, never on a repeat; L6 4 MB; L7 rows by context
    and server (`action:log` takes the handle); L8 group and resource on a row; L9 the trimmed Job name and a 409 on a
    create worded as a name taken; L10 owner sentences, a ReplicaSet's Deployment, autoscaling/v1, lists cut; L11 an
    action's text held back from a namespace-limited session; L12 30 s per apply request, duplicates refused; L13
    the 429 isn't shown as a conflict, and the docs say which errors carry the cluster's text.

Departures from the spec, and why:

- **`action:apply` carries the review's digest** (`{ handle, id, digest }`): main checks it against the review it
  holds and drops the review on a mismatch (the lesson of `landflow.ts`'s prepare/apply). Since the review, the
  digest is over the card main answered and the kept requests: it names the review; it can't prove what the window
  drew.
- **A triggered Job's name cuts the CronJob's to 50, not 52**: 52 + `-manual-` (8) + 5 is 65, over the 63 a label
  value allows (a Job's name is also its `job-name` label).
- **No `blockOwnerDeletion`** on the triggered Job's owner reference: `kubectl create job --from` sets
  `controller: true` only, checked live against OrbStack's API server (`actions.integration.test.ts` compares the
  two Jobs field by field).
- **The `Action` contract has no cordon or drain yet**: they come with part 2, as new members of the union.
- **The kind table lives in `action-kinds.ts`** (no Node imports) so the window's menu and main build from one list.
- **A review's `prepared` objects stay in the broker's result for main's facts**, then are dropped: main returns the
  review without them.

## Part 2: nodes (D149–D154) — built 16 Nov 2026

- [x] `drain.ts` (the plan, the reads, the dry-run evictions, the run), `fake-api.ts`, unit tests (D150–D152)
- [x] `ActionService`: cordon, the drain review, the run, `action:progress`, `action:stop`, the D153 fence
- [x] `DrainPlanView.tsx` (the drain sheet), cordon on the action card, the node menu, ⌘K verbs (D149, D154)
- [x] The [check]: a dry-run eviction reports a budget's block without spending it, live (`drain.integration.test.ts`)
- [x] `nodes.e2e` (reads only), docs
- [x] Fable's security review of part 2 (no High, 6 Medium, 12 Low), every finding fixed with a test that fails
  without its fix (checked by reverting each, 40 cases):
  - M1: main keeps each run's latest state, numbered (`seq`), and answers `action:runs`; the sheet listens from its
    first moment, so a run that ends before Apply answers ends the sheet; Close is always there.
  - M2: the ticks are in the review, its digest and main's dialog, which names bare pods ("deleted for good") and
    emptyDir losses; the sheet drops a review when a tick changes and uses only the latest review's answer.
  - M3: the run reads the node first (another node, or uncordoned since a cordoned preview: nothing evicted), reads
    it before each pass (uncordoned: stop), and at the end says whether it is cordoned and how many pods arrived.
  - M4: the status bar's **Draining node** chip re-opens the sheet on the run, with Stop; closing the sheet leaves
    the run going; ended runs are kept ten minutes.
  - M5: the D153 guard is in the front door, for every token and path (YAML editor, the agent's patch and its dry
    run, kube-mcp, terminals' kubectl), before the policy.
  - M6: tests for the cluster gone, two per cluster, navigation and destroy, Stop mid-pass, a bare pod unticked.
  - L1 a namespace's budgets past 2,000 make the plan partial; L2 no eviction after the deadline; L3 evicted pods
    followed by name (past 20, a cached list every 5 s); L4 a 429's cause and Retry-After; L5 the cordon re-pinned
    once on a 409; L6 lost answers; L7 the pods read again at the start; L8 `context@host:port`; L9 quit asks, stops
    and settles; L10 taints and paged nodes for "the only node", said in the drain's sheet and dialog; L11 one drain
    review per window and node; L12 a pod whose DaemonSet is gone is bare.

The [check] (D151), settled: the source (kubernetes v1.36.0, `pkg/registry/core/pod/storage/eviction.go`:
`checkAndDecrement` decrements a copy and returns before `UpdateStatus` on a dry run; `addConditionAndDeletePod`
skips the DisruptionTarget condition and the store's delete is a dry run) and the live test agree. On OrbStack
(1.36.5): hands-web's dry-run eviction answers 429 with a `DisruptionBudget` cause and hands-web-pdb's status is
unchanged; under a throwaway budget that allows one, hands-bare's dry-run eviction is accepted (201) and the budget
still allows one with no disruptedPods, the pod the same uid with no deletionTimestamp. So `dry` stays in the design.

Departures from the spec, and why:

- **A StatusCause's type is read from `reason`**: the API serializes `metav1.StatusCause.Type` as `reason`; the live
  test caught the first reading (`type`), which would have marked every budget 429 as `other`.
- **A dry-run eviction says dry run twice**, `?dryRun=All` in the query as well as `deleteOptions.dryRun`, so
  admission (webhooks with side effects) treats the request as a dry run too; the API server requires the two to
  match.
- **The fence covers every series of `ActionService`**, not only cordon and drain: a Node's delete (D141 offers it,
  behind main's dialog) is a node write as well, and is refused the same way in a development build.
- **A preview-only cordon shows Landlens's own reading of the patch** (a local merge of `spec.unschedulable`) in the
  card, marked so, since no dry run may be sent; a preview-only drain has its plan without `dry`.
- **The drain review is main's own**, not an `EditBroker` review: its id and the SHA-256 over the kept cordon
  request and pod list; Apply names both, as part 1's actions do. A review waiting on a tick, partial or preview
  only has no id.
- **`DrainProgress` carries `startedAt` and a `note`** (the elapsed time, and why a run ended before evicting).
- **The live test is its own file** (`drain.integration.test.ts`) so it runs without part 1's writes; besides the
  spec's two dry runs it makes one throwaway budget that allows a disruption, the case that shows a budget isn't
  spent, and checks a wrong uid answers 409.
- **Pending pods**: the eviction API lets a Pending pod go without a budget check; the plan still shows its budget
  (if any) as Landlens reads it, and the dry run's answer corrects the row.
- **Closing the sheet while a drain runs** was not offered at first (Stop first); since the security review the
  sheet closes and the status bar's chip re-opens it (M4).

## Part 3: tables and asks (D155–D160)

- [x] Multi-select, bulk actions (main's dialog), the column picker, remembered sort, several namespaces, preset asks
  (16 Nov 2026; [workbench.md](../../workbench.md#tables-selection-columns-namespaces),
  [agent.md](../../agent.md#preset-asks)). Departures:
- **A dry run's refusal in a bulk** leaves that object out (the card lists it with the cluster's words) instead of
  failing the review; main's dialog, title, facts and log name only the objects kept.
- **The selection bar** is `.selection-bar` (`.sel-bar` was taken by the logs' selection) and replaces the toolbar's
  whole right side; in a narrow pane its buttons are icons.
- **Ask Claude's submenu** starts with "Attach to a question" (the plain ask) so the menu's Ask still attaches
  without a question.
- **Only and All namespaces** choose and close the popover; a checkbox keeps it open.
- **A link to an object** outside several chosen namespaces adds its namespace (one chosen: moves to it); the
  Problems list keeps problems with no namespace when several are chosen.
- [x] Fable's security review of part 3 fixed (no High, 4 Medium, 9 Low; 16 Nov 2026;
  [security.md](../../security.md#your-actions)): D155, D156, D158 and D160 amended in [spec.md](spec.md). M1 the
  selection's ask carries its namespaces; M2 the selection is of shown rows; M3 one-token Status words; M4 a test per
  named rule (`apply-rules.test.ts` new); L1–L9 as listed in [history.md](../../history.md).

## Part 4: Secrets (D161–D168)

- [x] Reveal per key by the person only, copy through main, the certificate panel (16 Nov 2026;
  [workbench.md](../../workbench.md#secrets-and-certificates), [security.md](../../security.md#secret-values)).
- **[check] settled**: Electron 45's clipboard is async and W3C-like (no `writeText`/`writeBuffer` on the main
  module's sync API as in older Electron). `clipboard.write([new ClipboardItem({ "text/plain": value,
  'electron application/osclipboard;format="org.nspasteboard.ConcealedType"': "" })])` writes the text and the
  marker in one change, and `has(marker)` is then true; writing the marker separately after the text replaces the
  text. Main uses the one write on macOS (checked with a dummy value in a scratch Electron app, and in `secrets.e2e`).
Departures:
- **`secret:*` take a namespace and a name** (`SecretRef`), not a `ResourceRef`: the kind is always core v1
  `secrets`, decided in main, so the window can't name another resource.
- **The certificate panel reads `tls.crt` and `ca.crt` only**, not every key: a PEM pasted under another key isn't
  shown (the brief's narrower rule).
- **The value lives in a ref and one text node**, not component state: React keeps old state in its alternate fibers,
  so state would hold the value past Hide.
- **The `object` token is single-use**: the front door forgets it after its one GET, and main revokes it as well.
- **Helm release records are refused** in main (they hold a whole release, base64 and gzip), with a pointer to Helm.
- **Main guards prompts**: while the clipboard holds a value main copied, a dock message, a change's note or a brain
  summary containing it is refused; a prompt that attaches a Secret is refused too.
- **Reveal and copy share one budget** (10 a minute a window); a window holds at most 5 unlocks and one dialog at a time.
- **The unlock answer carries `left`** (milliseconds), and the window remembers each unlock's end by
  handle/namespace/name (a time only) so the chip survives the drawer closing; a reveal main refuses as locked asks
  main's dialog again.
