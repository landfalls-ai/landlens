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
- [ ] Fable's security review of part 1

Departures from the spec, and why:

- **`action:apply` carries the review's digest** (`{ handle, id, digest }`): main checks it against the review it
  holds and drops the review on a mismatch, so what is applied is exactly what the card showed (the lesson of
  `landflow.ts`'s prepare/apply).
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
- [ ] Fable's security review of part 2

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
- **Closing the sheet while a drain runs isn't offered**: Stop first (the run is main's and ends with its window).

## Part 3: tables and asks (D155–D160)

- [ ] Multi-select, bulk actions (main's dialog), the column picker, remembered sort, several namespaces, preset asks

## Part 4: Secrets (D161–D168)

- [ ] Reveal per key by the person only, copy through main, the certificate panel
