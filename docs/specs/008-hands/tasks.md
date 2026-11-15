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

## Part 2: nodes (D149–D153)

- [ ] Cordon, uncordon; drain with a preview and a run that can be stopped

## Part 3: tables and asks (D154–D160)

- [ ] Multi-select, bulk actions (main's dialog), the column picker, remembered sort, several namespaces, preset asks

## Part 4: Secrets (D161–D168)

- [ ] Reveal per key by the person only, copy through main, the certificate panel
