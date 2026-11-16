# Wave 8: Hands (the person can do what the agent already can) — spec

Branch `wave8-hands`, cut from `wave7-land-family` once that is merged (read for this spec at `dde8c84`: main plus
wave 7 parts 1–5 and D139). The source is the gap study's wave A
(`scratchpad/wave-next/lens-gap.md` §b): quick actions for the person as change cards, node cordon and drain with a
preview, preset asks and a context menu, table power, and a person-only Secret reveal with a certificate panel. The
collapsible sidebar (item 1 of wave A) is built (D139) and is not in this wave.

Decisions continue wave 7's numbering (last was D139). Paths are relative to `~/WorkSpace/landlens`. OpenLens and
Freelens (`upstream/`, MIT) were read for behaviour only; no code is taken. The roadmap's old row 8 (Packaging)
becomes wave 9 (D172). **Superseded by the person's order (15 Nov 2026):** 8 Hands, 9 Google's view of this cluster,
10 Delivery, 11 What happened, 12 Workspace, 13 Packaging ([plan.md](../../plan.md#waves)). Part 1's departures from
this text are in [tasks.md](tasks.md).

Three claims below come from memory of Kubernetes, kubectl and Electron, not from a file in this tree. Each is marked
**[check]** with the test that settles it before the code that leans on it is written.

## What exists, and what changes

| Area | Today (file) | This wave |
|---|---|---|
| The agent's writes | `packages/kube/src/changes.ts` `ChangeBroker`: check, read, pinned request, dry run, diff, risks, ask, apply; token `<label> · approved`, policy `write`; six tools in `packages/kube-mcp/src/writes.ts` | Rules unchanged. Its private `prepare` becomes an exported `prepareOp` that the person's path also calls (D140) |
| The person's writes | `packages/kube/src/edits.ts` `EditBroker` (`reviewEdit`, `reviewCreate`, `apply` by `ed…` id, 15 min); `main/workbench.ts` `asYou` (token `you · <context> · edit`, policy `full`, revoked per call), reviews owned by a window; `YamlEdit.tsx` `ReviewCard` | A third review, `reviewOps`, for actions; a new `ActionService` in main; `ReviewCard` gains an eyebrow and a facts strip |
| Person actions | None: the drawer has shell, flow, copy, Ask, YAML edit (`Details.tsx:125-161`); the row menu has Logs, Shell, Edit, Copy, Ask (`Workspace.tsx:699` `RowMenu`); ⌘K verbs are logs, shell, forward, edit, ask (`paletteRules.ts`) | Scale, Restart, Delete, Trigger, Suspend/Resume, Cordon/Uncordon, Drain |
| Nodes | Listed and opened; no write, no "cordon" or "drain" anywhere | D149–D154 |
| Tables | `ResourceTable.tsx`: virtual rows, sort in `useState`, columns dropped by width only, `onMenu`, keys L/S/E; `Toolbar.tsx`: one namespace `<select>` | Selection and bulk actions, a column picker, remembered sort, several namespaces |
| Ask Claude | One unnamed ask per object, problem or log selection (`quotes.ts`, `doctorBrief.ts`); not offered on Secrets | Named presets; "Ask about these N"; "Ask Claude first" on an action card |
| Secret values | Never leave main: `withoutSecretValues` (`packages/kube/src/client.ts:113`) on `resource:get` and every watch event; the drawer shows `••••••` (`Details.tsx:531`); edits and creates of Secrets refused (`edits.ts`); the agent's tokens deny `secrets` | A value crosses to the window only on the person's click, one key at a time, after main's own dialog (D161–D168). Everything else stays as it is |
| Certificates | `packages/kube/src/certs.ts` parses `tls.crt` for the doctor (`CertFact`: dates, CN, SANs, self-signed) | A certificate panel in a Secret's drawer, public halves only (D167) |
| Token policies | `packages/kube/src/policy.ts`: `full`, `read`, `write`, `exec` (one pod), `forward` (one pod, one port) | One more: `object` (one GET of one named object), for Secret reads (D162) |
| Audit | `AuditEntry` per front-door request, in memory, fed to the MCP call log and telemetry's counter (`main/index.ts:62`); nothing kept across restarts (`limitations.md`) | One kept row per person action and per reveal: `userData/actions.json` (D147) |

## The scope, in four parts

Each part ends with the app running on OrbStack, its tests green, its docs moved and a Fable security review, as in
waves 4–7. Parts 1 → 2 → 3 → 4 in order; 4 depends only on part 1's action log and could be built second if the
person wants Secrets first.

1. **Your actions**: the shared preparation, the action broker, Scale, Restart, Delete, CronJob Trigger,
   Suspend/Resume, the action sheet, the object menu, ⌘K verbs, the action log, "Ask Claude first".
2. **Nodes**: cordon, uncordon, drain with a preview and a run that can be stopped.
3. **Tables and asks**: multi-select with bulk actions, the column picker, remembered sort, several namespaces, preset
   asks, "Ask Claude about these N".
4. **Secrets**: person-only reveal per key, copy through main, the certificate panel.

## 1. Your actions

**D140. One preparation for the agent's changes and the person's actions.** `ChangeBroker.prepare` (read the object,
build the request pinned to its version, dry-run it, diff before and after, tag risks) moves, unchanged in behaviour,
to an exported function in `changes.ts`:

```ts
export type Prepared = { op: ChangeOp; absent?: boolean; method: string; path: string; contentType?: string; body?: string; shown: ChangeOperation; current: unknown };
export async function prepareOp(send: Send, op: ChangeOp, o: { fieldManager: string; hideSecrets?: boolean }): Promise<Prepared>;
```

`ChangeBroker` calls it with `FIELD_MANAGER` (`landlens-agent`); its checks (`check`, `NEVER`, `HIDDEN`, namespaces,
`MAX_REFUSED`, `agentSafe`) stay in the broker and still run first. `EditBroker` gains

```ts
async reviewOps(send: Send, ops: ChangeOp[], extra?: { agent?: boolean }): Promise<EditReview & { prepared: Prepared[] }>
```

which calls `prepareOp` with `EDIT_FIELD_MANAGER` (`landlens`) for each operation (four at a time, in order of the
list), keeps the exact requests under an `ed…` id for 15 minutes as `keep` does today, and builds `agent` (the diff
scrubbed with `redactObject`, as `reviewEdit` does) unless any operation is on `secrets`. A 409 at the dry run is a
`conflict`; any other refusal is `problems` through `refusal()`. So an action's card and the agent's card for the same
change show the same diff, the same risk tags and the same preconditions (`resourceVersion` in a patch, `uid` and
`resourceVersion` on a delete, `dryRun: ["All"]` in a delete's body).

`hideSecrets` (always set on the person's path): when `op.type` is core `secrets`, the object before and after goes
through `withoutSecretValues(…, true)` before the diff, so deleting a Secret shows its keys and sizes, never a value.
Today no path diffs a Secret; this is the first, and it has its own test (D169).

`EditBroker.apply` gains a mode for several independent objects: `apply(send, id, { each: true })` sends every kept
request and answers one result per request (`applied`, `conflict`, `failed` with the cut message, `gone` for a 404 on
a delete) instead of stopping at the first failure. Edits and creates keep today's stop-at-first behaviour.

**D141. The actions, and exactly what each sends.** New file `packages/kube/src/actions.ts`: pure builders from an
action and the objects main read to `ChangeOp[]`, plus the facts of D142. Kinds are fixed in code; anything else is
refused before a request.

| Action | Kinds | Operation | Notes (upstream behaviour read) |
|---|---|---|---|
| `scale` | `deployments.apps`, `statefulsets.apps`, `replicasets.apps` | merge patch `{ spec: { replicas } }`, 0–1000 | The same body as the agent's `scale` tool (`writes.ts`). Freelens scales through the `/scale` subresource with a slider (`workloads-deployments/scale/dialog.tsx`); the main resource is used here so the card shows the workload's own diff. Custom resources with a scale subresource: later |
| `restart` | `deployments.apps`, `statefulsets.apps`, `daemonsets.apps` | strategic patch setting `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` to now (RFC 3339) | The agent's `rollout_restart` body; kubectl's and Freelens's annotation |
| `delete` | Any kind whose discovery verbs include `delete` | `DELETE`, `propagationPolicy: Background`, `uid` and `resourceVersion` preconditions | One object, or up to 50 of one kind (part 3). Never in bulk: `namespaces`, `customresourcedefinitions.apiextensions.k8s.io`, `nodes`, `persistentvolumes`, `apiservices.apiregistration.k8s.io` (one at a time, behind main's dialog, D143) |
| `trigger` | `cronjobs.batch` | `create` a `batch/v1` Job named `<cronjob, cut to 52>-manual-<5 of [a-z0-9]>` in the CronJob's namespace: `spec` = the CronJob's `spec.jobTemplate.spec`, labels and annotations = the template's, plus annotation `cronjob.kubernetes.io/instantiate: manual`, and one `ownerReference` to the CronJob (`apiVersion`, `kind`, `name`, `uid`, `controller: true`, `blockOwnerDeletion: true`) | Freelens: `workloads-cronjobs/trigger-dialog/view.tsx:52-73` (same name shape, annotation and owner). `controller: true` is what `kubectl create job --from` sets **[check]**: compare with a Job made by `kubectl create job --from=cronjob/hands-report` in the live test. The template is read by main as the person, unscrubbed, so env values survive; the random suffix is main's (`randomBytes`) |
| `suspend` | `cronjobs.batch`, `jobs.batch` | merge patch `{ spec: { suspend: true \| false } }` | Freelens `cron-job-menu.tsx`, `job-menu.tsx` |
| `cordon` | `nodes` | part 2 | |
| `drain` | `nodes` | part 2 | |

```ts
// packages/contracts
export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scale"), target: ResourceRef, replicas: z.number().int().min(0).max(1000) }),
  z.object({ kind: z.literal("restart"), targets: z.array(ResourceRef).min(1).max(50) }),
  z.object({ kind: z.literal("delete"), targets: z.array(ResourceRef).min(1).max(50) }),
  z.object({ kind: z.literal("trigger"), target: ResourceRef }),
  z.object({ kind: z.literal("suspend"), target: ResourceRef, suspend: z.boolean() }),
  z.object({ kind: z.literal("cordon"), node: ObjectName, on: z.boolean() }),
  z.object({ kind: z.literal("drain"), node: ObjectName, bare: z.boolean(), emptyDir: z.boolean() }),
]);
```

Targets in one action are of one kind (main refuses a mix), named by `ResourceRef`, and each type is resolved from
the cluster's discovery in main (as `reviewEdit` does), never taken from the window.

**D142. Facts: what the diff doesn't say.** Beside the diff a card carries up to 8 facts (amended, M4: past 8, the
last says how many more and of which tones, in the loudest; every bound PVC's volume is read), each a fixed sentence built
in main with names only (`ActionFact = { tone: "info" | "warn" | "bad"; code: FactCode; text: string }`; names are
checked as Kubernetes names, numbers as numbers; nothing from a message, label value or annotation is copied in).
Reads are made as the person in the action's own request series; a read that fails gives the fact
`couldnt-check` ("Landlens couldn't check for autoscalers here (HTTP 403)"), never silence.

| Action | Facts |
|---|---|
| scale | An HPA in the namespace whose `scaleTargetRef` names the workload: "HorizontalPodAutoscaler `x` sets replicas between 2 and 10; it will set this back" (warn). To zero: covered by the risk tag `scales-to-zero`. Below a PDB's `minAvailable` when it is a number: "PodDisruptionBudget `y` wants 2 available" (warn) |
| restart | One replica and strategy `RollingUpdate` with `maxUnavailable` resolving to 1, or `Recreate`: "Its only pod restarts: expect a gap" (warn). A rollout in flight (`status.updatedReplicas < spec.replicas` or `observedGeneration < generation`): "A rollout is already in progress" (warn). A DaemonSet: "Restarts a pod on each of N nodes" (info) |
| delete | A controller owner: "ReplicaSet `r` will make a new pod" (info). No controller owner on a Pod: "Nothing will recreate it" (warn). Finalizers present: "It has N finalizers: deletion waits for them" (info). A workload: "Deletes its N pods" (warn). A PVC: "Its volume's reclaim policy is Delete: the data goes with it" (bad) or "…Retain" (info), from the bound PV when readable. A Namespace: "Deletes everything in it" (bad) |
| trigger | "Runs now, once, outside the schedule" (info); suspended CronJob: "The CronJob is suspended; this Job still runs" (info); `concurrencyPolicy: Forbid` with an active Job: "A Job of it is running; Forbid applies to the schedule, not to this one" (warn) |
| suspend | A Job with active pods: "Suspending deletes its running pods" (warn) |

`ChangeRisk` (contracts, `RISK` in `ChangeCard.tsx`) gains two tags for part 2: `evicts-pods` (danger, `LogOut`,
"evicts pods") and `loses-data` (danger, `HardDrive`, "loses data"), placed after
`deletes` in `ORDER`. `risks()` is unchanged for existing verbs.

**D143. `ActionService` in main** (`apps/desktop/src/main/actions.ts`; constructed in `index.ts` with `clusters`,
`frontDoor`, the `EditBroker` instance it shares with nothing else, `dataDir`, the `ActionLog` of D147):

- **As you.** Every review and apply is one request series with a token issued for it: label
  `you · <context> · <action> <target>` (for example `you · orbstack · scale landlens-dev/hands-web`, `… · delete 6
  configmaps`), policy `full`, that one cluster, revoked in `finally` (the `asYou` of `workbench.ts`, lifted to a
  shared helper `main/as-you.ts` that both services use). The cluster's RBAC decides; a 403 at the dry run is shown as
  the API server's reason through `refusal()`.
- **Owned.** A review belongs to the window and cluster it was made for, lives 15 minutes, 20 a window (the oldest
  goes), forgotten when the window goes, reloads or its renderer dies, and when the cluster stops: the rules and the
  code path of edit reviews (`remember`, `own`).
- **Apply sends the kept requests and nothing else**, once. `action:apply` names the review id; nothing in it can
  change a request.
- **Main's own dialog for the widest actions.** Before sending, main asks with `nativeConfirm` (the helper in
  `ipc.ts`, moved to `main/native-confirm.ts`) when the review is: a delete of more than one object; a delete of a
  Namespace, CRD, Node, PersistentVolume or APIService; a drain. The dialog names the action, the count, the first 10
  names and the context ("Delete 12 ConfigMaps in landlens-dev on orbstack?"; detail: the names, "and 2 more"; buttons
  `Delete 12`, `Cancel`, Cancel the default). Cancel answers 409 "Cancelled." and keeps the review. This is the first
  native confirmation of a change (`limitations.md` "The approval card is the renderer's"); other danger keeps the
  card's second click. A page that was taken over still can't press it.

  *Amended after the security review of part 1 (M1, M2, M5, L3).* What asks is decided in main from what main
  resolved and read, never from the window: a delete of more than one object; a delete of **any cluster-scoped
  kind** (`!namespaced` from discovery: the five above, and ClusterRole, ClusterRoleBinding, StorageClass, webhook
  configurations, cluster-scoped custom resources); a delete with a `bad` fact (a PVC whose volume's reclaim policy
  is Delete, a Namespace), of a PVC whose volume Landlens couldn't read, or of a workload with 10 pods or more
  (`asksInMain`); a restart of more than 3 workloads; a drain; and **any apply once its window has had more than 3
  objects changed in the last 60 s** (`CARD_BUDGET`, counted per window in main), so a bulk sent as singles still
  reaches the dialog. The five stay the kinds never deleted in bulk. The dialog's detail lists the reasons in main's
  sentences, the count by namespace, every flagged object by `namespace/name` first (cluster-scoped; in a system
  namespace, `kube-*` or `*-system`; outside the namespace most targets are in), then the rest, the first ten and
  "and N more in <namespace>"; main sorts, so the window's order changes nothing, and nothing flagged is ever behind
  "more". The first Cancel keeps the review; the second drops it (410). A second apply while the dialog is up is 429.
- **Limits.** 50 targets an action, each named once; 8 reviews being prepared per window at once (more is 429); a
  review's reads and dry runs share a 60 s limit; each request of an apply (and of a drain's run) waits at most 30 s,
  and one that didn't answer is reported as "may have been applied"; `current` objects are dropped from memory once
  the review is built, except what the facts used (and the agent's broker never holds them: `prepareOp` returns them
  only with `keepObjects`).
- **The digest** (amended, L2): the SHA-256 of the card main answers (diff, risks, title, facts, plan, `native`)
  with the kept requests. Apply names it; it ties Apply to that review, and can't prove what the window drew.

**D144. IPC** (contracts, `ipc.ts`, the preload list; zod on every request; ids `EditId`):

| Channel | Request → response |
|---|---|
| `action:review` | `{ handle; action: Action }` → `ActionReview` |
| `action:apply` | `{ handle; id: EditId }` → `{ results: ActionResult[] }`, or for a drain `{ run: EditId }` (D152) |
| `action:discard` | `{ id }` → `{ ok: true }` |
| `action:stop` | `{ run: EditId }` → `{ ok: true }` (part 2) |
| `action:log` | `{ handle; limit?: 1–200 }` → `{ entries: ActionLogEntry[] }`: the connected cluster's rows, matched on its context and its API server's hash (amended, L7) |
| push `action:progress` | `DrainProgress` (part 2), only to the window that started the run |

```ts
export type ActionFact = { tone: "info" | "warn" | "bad"; code: string; text: string };
export type ActionReview = EditReview & {
  title?: string;                 // main's words: "Scale deployment landlens-dev/hands-web to 3 replicas"
  facts?: ActionFact[];
  native?: true;                  // Apply will ask in main's dialog
  plan?: DrainPlan;               // part 2
};
export type ActionResult = { target: string; outcome: "applied" | "conflict" | "failed" | "gone"; message?: string };
```

The title is built in main from the action's verb and checked names, so a card never shows a title the window wrote.

**D145. The action sheet** (`ActionSheet.tsx`, new; styles in `workbench.css` beside `.change.mine`). One sheet over
the main pane, in the family of `CreateSheet`/`TriageSheet` (same scrim, `--bg-2`, `--r-3`, 560px, focus trapped, Esc
closes when nothing is applying):

1. **Form**, only for actions with a choice. Scale: the current count, a number field with − and + (0–1000; arrow
   keys step, Shift steps 10), no slider. Drain: two ticks (part 2). Restart, Delete, Trigger, Suspend, Cordon have no
   form: the sheet opens straight on the review.
2. **Review**: `ReviewCard` (moved from `YamlEdit.tsx` to its own `ReviewCard.tsx`, with two new props: `eyebrow`
   ("Your edit" stays the default; actions say "Your action") and `facts`). Facts sit under the risk tags as one quiet
   list (`.change-facts`: 13px icon by tone, `--ink-2` text, `--warn-text`/`--bad-text` only on the icon and first
   word). With several operations each has its head line and folds past three; "Show the whole change" still gates
   Apply. A review with problems shows them in place of the diff, with **Back**.
3. **Result**: one line per `ActionResult` (applied in `--ok-text` with `CircleCheck`, conflict and failed with their
   icon and sentence), then **Done**. A conflict offers **Review again**.

Apply keeps `ReviewCard`'s rules: a press of Apply itself, not Enter anywhere; a key press in the first 500 ms is
ignored, and so is a repeated key (a key held from the menu item that opened the card; amended, L4); danger needs the second click with Back focused; a `native` review's button reads `Delete 12…` and the
dialog is main's. While a dry run is running the sheet shows the skeleton and "Checking with the cluster…"; nothing
is optimistic: the table changes when the watch says so.

**D146. Where actions are offered.**

- **The object menu** (`ObjectMenu.tsx`, replacing `RowMenu` in `Workspace.tsx`): one component for a row's
  right-click and Shift+F10, and for a new **⋯** button in the drawer's head (after Copy name). Sections, each only
  when it has an item: *Open* (Logs `L`, Open shell `S`, Edit YAML `E`, Forward a port), *Actions* (by kind, D141;
  Cordon or Uncordon by the node's state), *Ask Claude* (part 3's presets; until then the single Ask), *Copy name*,
  and last, in `--bad-text`, *Delete…*. Arrow keys, Home/End, type-ahead by first letter, Esc; 240px, `--bg-2`,
  `box-shadow: inset 0 0 0 1px var(--line)`, kept inside the window.
- **RBAC before the click.** Opening a menu asks `cluster:access` once for that object's verbs (`patch`, `delete`,
  `create jobs`, `create pods/eviction`), cached 60 s per namespace and kind as `useCanExec` caches; an item your role
  can't use is disabled and says "Your role can't patch deployments in landlens-dev". The cluster still decides.
- **⌘K** (`paletteRules.ts`): verbs `scale`, `restart`, `delete`, `trigger`, `cordon`, `uncordon`, `drain`, each with
  its kinds, after `edit` in `VERB_ORDER`; picking one opens the sheet. `delete` is never the first row for a query.
- **Keys on a focused row**: `⌫` (Delete on other keyboards) opens the delete sheet; the rest stay in the menu, so a
  stray letter can't start a write.
- Secrets get Delete (keys and sizes in the diff, D140) and no other action; Helm release Secrets are named as such
  in a fact ("This is Helm's record of release `shop`, revision 3").

**D147. The action log: one kept row per action.** `apps/desktop/src/main/action-log.ts`, file
`userData/actions.json` (mode 0600, temp file and rename, a strict zod schema on read, a damaged file moved aside; the
pattern of `family-sent.json`), the newest 500:

```ts
export type ActionLogEntry = {
  id: string; at: string; context: string; server: string /* SHA-256 of the API server URL, as family-sent.json */;
  who: "you";
  action: "scale" | "restart" | "delete" | "trigger" | "suspend" | "resume" | "cordon" | "uncordon" | "drain" | "reveal" | "copy";
  kind: string; namespace?: string; names: string[] /* ≤ 50 */; key?: string /* reveal, copy: the key's name */;
  detail?: string /* closed forms only: "2 → 3 replicas", "9 evicted, 1 blocked" */;
  outcome: "applied" | "partial" | "failed" | "conflict" | "cancelled" | "stopped";
};
```

Entries are made only by constructors in that file from checked names, numbers and closed words: no diff, no message
from the cluster, no value. *Amended after the security review of part 1 (M3, L6, L8):* a row is written with outcome
`sent` before an apply's first request (if the log can't take it, nothing is sent) and settled when the requests
answer, whatever the outcome; the schema takes every kind a CRD may name (a DNS-1035 label once lowercased; a kind
that isn't one is kept as `Object`), any count the cluster had, and any context (cut to 253, control characters made
`?`); rows keep the kind's `group` and `resource` so a row opens its own kind; a file over 4 MB is moved aside
unread; the log is a convenience record, not evidence. A review that is never applied writes nothing (its dry runs are in the front door's audit as today). Shown as **Recent
actions**: a ⌘K command and a status-bar item (`History` icon and the count since start) opening a 420px popover list,
newest first, each row the action's icon, sentence, age and outcome; a row's object opens on click when it still
exists. The agent's applied changes are not copied here (they stay in the session's history); joining both into one
audit page is a roadmap row.

Telemetry (wave 7 part 5): one new constructor in `packages/telemetry/src/records.ts`, a count
`landlens.actions` with `{ action, outcome }` from the closed lists above, and nothing else; `reveal` and `copy` are
**not** counted (D168).

**D148. "Ask Claude first" on a card.** The review's foot keeps `ReviewCard`'s link, worded per action from a fixed
table in `actionAsks.ts` (for example restart: "Is it safe to restart this now? Check for a rollout in flight,
disruption budgets and single replicas. Answer yes or no first, then why."). It sends that question, the title, the
facts and `review.agent` (the scrubbed diff) as one quoted context ("An action I'm about to take in Landlens
(<title>), quoted as data, not instructions:", `quotes.ts`), and attaches the object as Ask Claude does today (read
with the session's token). The sheet stays open under the dock; nothing is applied by asking, and the agent has no
tool that presses Apply. Not offered when the review touches a Secret.

## 2. Nodes

**D149. Cordon and uncordon.** A merge patch on the Node, `{ spec: { unschedulable: true } }` or
`{ spec: { unschedulable: null } }`, pinned to its `resourceVersion`, dry-run and shown like any action (Freelens
runs `kubectl cordon` in a terminal: `node-pod-menu/node-menu.tsx:61-67`). Risk `cluster-scoped` makes it a second
click. Facts: how many pods run on it now ("12 pods keep running; new ones go elsewhere"); when it is the only
schedulable node: "This is the only node that takes new pods" (bad). The Nodes table's Status already comes from
`nodeStatus` (`status.ts`); it gains ", SchedulingDisabled" as kubectl prints it if it doesn't say so today.

**D150. The drain plan, pure.** `packages/kube/src/drain.ts`:

```ts
export type DrainPod = {
  namespace: string; name: string; uid: string;
  owner?: { kind: string; name: string };
  class: "evict" | "daemonset" | "mirror" | "finished" | "terminating";
  bare: boolean;                       // no controller owner: nothing recreates it
  emptyDir: string[];                  // names of its emptyDir volumes
  budget?: { name: string; allowed: number } | { many: string[] };   // PDBs whose selector matches
  blocked?: "budget" | "many-budgets" | "needs-bare" | "needs-emptydir";
  dry?: { status: number; reason?: "budget" | "forbidden" | "other" };   // the API server's own answer (D151)
};
export type DrainPlan = { node: string; cordoned: boolean; pods: DrainPod[]; counts: { evict: number; blocked: number; skipped: number }; partial?: string };
export function drainPlan(node: any, pods: any[], pdbs: any[], opts: { bare: boolean; emptyDir: boolean }): DrainPlan;
```

Rules, each from kubectl drain's behaviour as Freelens invokes it, minus `--force` as a default:

- A pod owned by a DaemonSet is **skipped** (`daemonset`): the controller would put it straight back.
- A static pod's mirror (annotation `kubernetes.io/config.mirror`) is skipped (`mirror`).
- A pod already `Succeeded` or `Failed` is deleted without a budget check (`finished`); one with a
  `deletionTimestamp` is left (`terminating`).
- A pod with no controller owner is `bare`: evicting it deletes it for good. Blocked (`needs-bare`) until the person
  ticks **Delete pods that nothing will recreate** (kubectl's `--force`).
- A pod with an `emptyDir` volume loses that data. Blocked (`needs-emptydir`) until the person ticks **Lose emptyDir
  data** (kubectl's `--delete-emptydir-data`).
- Budgets: every `policy/v1` PodDisruptionBudget in the pod's namespace whose selector matches. One with
  `status.disruptionsAllowed === 0` blocks (`budget`); more than one matching blocks (`many-budgets`: the eviction
  API refuses a pod under several budgets).
- Landlens never bypasses a budget (kubectl's `--disable-eviction` is not offered) and never force-deletes with a
  zero grace period.

Bounds: 2,000 pods on the node and 2,000 budgets read in pages of 500 (`fieldSelector=spec.nodeName=<node>` for pods,
all namespaces); past that, or when a namespace's budgets can't be listed (403), `partial` says so and Apply stays
off: a preview that might be wrong doesn't drain.

**D151. The preview is the plan plus the API server's word.** `action:review` for `drain`: main reads the node, its
pods and the budgets as the person, builds the plan, then for each pod it would evict sends the eviction as a dry run
(`POST /api/v1/namespaces/<ns>/pods/<name>/eviction`, body `{ apiVersion: "policy/v1", kind: "Eviction", metadata,
deleteOptions: { dryRun: ["All"], preconditions: { uid } } }`, four at a time, 60 s in all) and records the answer in
`dry`: 201/200 would go, 429 with a `DisruptionBudget` cause is a budget, 403 is your role. The eviction handler
checks budgets on a dry run without spending them **[check]**: the live test evicts `hands-web`'s pod, held by
`hands-web-pdb`, as a dry run and expects 429, then expects the budget's `status` unchanged. If the cluster answers
otherwise, `dry` is dropped from the design and the plan's own arithmetic stands alone (it is already what blocks).
Where the plan and the dry run disagree the row shows the cluster's answer and the card says "The cluster disagrees
with Landlens's reading on 1 pod".

The cordon is one `prepareOp` (skipped when the node is already cordoned). The review keeps: the cordon request, and
the list of `{ namespace, name, uid }` to evict. Nothing else can be evicted by that review.

**D152. The run.** `action:apply` on a drain review (after main's dialog: "Drain node-2 on orbstack? 9 pods will be
evicted, 1 is blocked by a disruption budget, 3 DaemonSet pods stay.") answers `{ run }` at once and proceeds in main:

1. Cordon (the kept request; a 409 stops the run before any eviction: "The node changed since the preview").
2. Evict the kept pods, four at a time, each with its `uid` precondition (a pod replaced under the same name is not
   evicted: 409 → `gone`). A 429 is retried every 5 s; a pod under a budget that never allows is reported `blocked`
   when the run's time is up. 404 is `gone`. Anything else is `failed` with a fixed sentence per status.
3. A pod counts as `evicted` when the API accepts; the row then follows the pod list until it is gone.
4. The run ends when every pod is settled, at 10 minutes, or on **Stop** (`action:stop`): no new eviction is sent,
   those in flight finish. The node **stays cordoned** in every ending; the result says so and offers **Uncordon**.

`DrainProgress = { run; node; state: "cordoning" | "evicting" | "done" | "stopped" | "timed-out" | "failed"; pods:
{ namespace; name; state: "waiting" | "evicting" | "evicted" | "gone" | "blocked" | "failed"; note? }[]; }`, pushed
at most four times a second to the window that started it. One run per node, two per cluster; a run ends with its
window or its cluster (the node stays cordoned; the action log says `stopped`). The token (`you · <context> · drain
<node>`, `full`) lives for the run and is revoked at its end.

*Amended after the security review of part 2 (M1, M3, M4, L2–L7, L9).* The run first reads the node and its pods
again: another node under the name, or a node cordoned at the preview and not now, ends it with nothing evicted; a
reviewed pod no longer there is `gone` unasked. The cordon's 409 is re-read and re-pinned once for the same,
still-schedulable node. The node is read before each pass of evictions; uncordoned, the run stops. No eviction is
sent after the 10 minutes; a 429's cause (budget or busy) and Retry-After decide its wait and ending. Evicted pods are
followed by name (past 20, a cached list every 5 s). At the end the node and its pods are read: `DrainProgress` gains
`seq`, `cordoned` and `arrived`, and the sheet says only what was read. Main keeps the runs (`action:runs`), the
sheet can close, and the status bar's chip re-opens it with Stop. Quitting asks, then stops and settles the row.

**D153. A development build never cordons or drains a cluster it wasn't told it may.** OrbStack has one node, shared
with the siblings. In an unpackaged build, `ActionService` refuses every node write, its dry runs and the dry-run
evictions of D151 unless the cluster is named in `LANDLENS_NODE_WRITES` (comma-separated `<context>@<host>:<port>`,
read only when `!app.isPackaged`, as `LANDLENS_GKE_REAL` is). *Amended after the security review of part 2 (M5,
L8):* the front door holds the rule, so every path (the YAML editor, the agent's change broker, kube-mcp, the
terminals' kubectl) is refused node writes and evictions, not only `ActionService`. Refused, the drain review is still built from reads (the plan
without `dry`), marked `previewOnly`, and the sheet says "Development build: preview only. Nothing is sent to nodes
on this cluster." with Apply off; cordon's sheet says the same. No test sets the variable to `orbstack`; the e2e
strips it from the environment it inherits. A packaged app has no such guard.

**D154. The drain sheet** (in `ActionSheet.tsx`; the plan as `DrainPlanView.tsx`). Head: "Drain node-2" and three
counts (`9 to evict`, `1 blocked`, `3 stay`), each with its icon, never colour alone. The two ticks sit above the
list and re-review on change (debounced 300 ms). The list is one column of cards-as-rows grouped *Blocked* (first,
`--bad-soft` edge), *Will be evicted*, *Stay* (folded): the pod's name in mono, `namespace`, its owner as a link, and
chips: `budget hands-web-pdb · 0 allowed`, `bare`, `emptyDir cache`, `DaemonSet`. Blocked rows say what would unblock
them ("Tick 'Lose emptyDir data'", "Wait for hands-web-pdb to allow a disruption, or scale hands-web up"). **Ask
Claude** sends the plan as names, classes and counts only (no dry-run text), quoted as data, with the fixed question
"Which blockers matter, and what is a safe order?". Apply reads `Drain…` (danger), disabled while anything is
`needs-*`, `partial` or `previewOnly`; a plan with only budget blocks may run (those pods are retried and reported).
During the run the same list shows each pod's state with a spinner, check or block icon, a **Stop** button, and the
elapsed time; at the end, the summary and **Uncordon**.

Agent write tools for cordon and drain are not built in this wave (the gap study's "later"): the agent can explain a
plan, the person runs it.

## 3. Tables and asks

**D155. What the tables remember.** `tableState.ts` (pure rules, as `navState.ts`; `test/table-state.test.ts`),
stored in `localStorage` under `landlens.table.v1`: `{ hidden: Record<kindKey, string[]>; sort: Record<kindKey,
{ id: string; dir: 1 | -1 }>; ns: Record<context, string[]> }`. `kindKey` is `resource` or `resource.group`. Read
through a tolerant parser: at most 200 kinds, 40 column ids of at most 64 characters each, 50 namespaces a context
(Kubernetes names only), anything else dropped; an unreadable value is ignored. It moves to the settings file with
pins and folds when the app is packaged (`limitations.md`).

*Amended by the security review of part 3 (L1, L8):* `ns` is keyed by cluster, `nsKey(context, server)` (the API
server, a space, the context's name), not by context alone. Every lookup reads the map's own keys only (`own`). Each
choice is applied to the value read again from storage just before (`updateTableState`), and a value written is held
under the 512 KB a read takes, dropping the oldest entries of the largest map first.

**D156. Selection and bulk actions.** `ResourceTable` gains an optional `selection` prop (`{ uids: Set<string>;
onChange }`); without it the table is as today (Problems, Helm).

- A 28px checkbox column at the left (a real `role="checkbox"` per row, a tri-state one in the head for "all rows
  the filter shows"). Click toggles; Shift+click takes the range from the last toggled row (in the sorted order);
  `x` or Space toggles the focused row; ⌘A/Ctrl+A selects the filtered rows while focus is in the table; Esc clears
  a selection before it closes the drawer. Selected rows get `--sel` and keep their tone edge.
- The selection lives in `Workspace` by uid for the current list only: it empties on a change of kind, namespaces or
  cluster, and a uid that leaves the watch leaves the selection.
  *Amended by the security review of part 3 (M2, M4):* the selection holds only rows the table **shows**. A row that
  leaves the filter, the Pods status segment (switched, or the pod's state changed) or the watch leaves the
  selection; the bar's count and a bulk's targets are of shown rows only. (Chosen over keeping hidden rows selected
  with "N not shown": the head checkbox already promises "every row shown", a count that can't be seen is a trap,
  and the filter field is hidden while a selection exists, so the segment and the watch are the only ways a row
  leaves.) The selection is stored with its list's key (kind and namespaces) and reads empty for another list, so
  it never outlives a change even for one render. A row's menu is tied to its list in the same way and closes on a
  change of page, kind or namespaces (L2). ⌘A acts only with the row itself focused (L7). The card's first press of
  Apply on a folded bulk unfolds it; its left-out note lists 20 refusals and counts the rest; the sheet's heading is
  main's title once there is a review (L3, L4).
- With a selection the toolbar's right side becomes the **selection bar** (`.sel-bar`, `aria-live="polite"`):
  "3 selected", then the actions the kind has in bulk (**Restart** for the three workload kinds, **Delete** for any
  kind not on D141's never-in-bulk list), **Ask Claude**, **Clear**. More than 50 selected disables the actions with
  "At most 50 at once".
- A bulk action is one `action:review` with `targets`: one card, an operation per object, dry-run four at a time; an
  object refused at the dry run is shown as a problem on its own line and left out, and the card says "5 of 6 can be
  deleted". Apply goes through main's dialog (D143) and `apply({ each: true })`: each object stands alone, and the
  result lists what happened to each. One action-log row with the names and `partial` when outcomes differ.
- Freelens's bulk remove (`item-object-list/content.tsx`) confirms once and deletes without a dry run or
  preconditions; here each delete is pinned to the version reviewed.

**D157. The column picker and remembered sort.** A **Columns** button in the toolbar (`Columns3`, before Create)
opens a 220px menu of the kind's columns as checkboxes (Name is fixed), a custom resource's printer columns included,
and **Reset**. Hidden ids go to `tableState.hidden[kindKey]`; the width rules of `ResourceTable.tsx:53-63` still
apply to what is left. Sort (`useState` today) starts from `tableState.sort[kindKey]` and is written back on change.
Column resize is not in this wave.

**D158. Several namespaces.** `Workspace`'s `namespace: string` becomes `namespaces: string[]` (empty = all). The
toolbar's `<select>` becomes a button (`Folder`, "All namespaces" / the name / "3 namespaces") opening a 260px
popover: a filter field, **All namespaces**, a checkbox per namespace, **Only** on hover of a row; arrow keys and
Space; kept per context in `tableState.ns`.

- Tables: one selected → the namespaced watch of today. Two to eight → one watch per namespace, merged by uid in a
  new `useWatchMany` (`api.ts`), which also works for a role that can't list across namespaces. More than eight → the
  all-namespaces watch, filtered in the window; if that is 403, the first eight are watched and the bar says so.
  *Amended by the security review of part 3 (L5, L6):* the namespaces not watched (past the eighth, or whose own
  watch was refused) are named in the status bar's title, the namespace button's title and a "not watched" mark in
  the popover; with one watch per namespace, rows show once any namespace has some (a link waits for all). The
  filter and the merge are pure (`allAnswer`, `mergeEach` in `tableState.ts`) and tested.
- Everything that takes one scope (`cluster:health`, `doctor:list`, metrics, Create's default namespace) gets the
  namespace when exactly one is selected, else the whole cluster; Problems are then filtered in the window by the
  set. The Overview shows a chip "3 namespaces selected: this page shows the whole cluster" when several are.
- The agent dock's namespace limit is unchanged (it is chosen when a session starts).

**D159. Preset asks.** `askPresets.ts`: a closed table of named questions, Landlens's own words, each with the kinds
it fits. Choosing one opens the dock and sends the question with the object attached exactly as Ask Claude attaches
it today (read with the session's token: scrubbed, namespace-limited, never a Secret), so no new data path exists.

| Preset | Kinds | Question (fixed) |
|---|---|---|
| Summarize | all but Secrets | "Summarize this object: what it is, what state it is in, and anything unusual. Six lines at most." |
| Why is this failing? | pods, workloads, jobs, nodes, PVCs; first when the row's tone is bad or warn | "Why is this failing? Give the cause first, then the evidence you checked, then one proposed change." |
| Analyze logs | pods, workloads, jobs | "Read its recent logs (and the previous run's if it restarted). What errors repeat, since when, and what do they point to?" |
| Analyze metrics | pods, workloads, nodes | "Look at its CPU and memory over the last 6 hours against its requests and limits. Is it sized right?" |
| Review related resources | workloads, services, ingresses, pods | "Check what this depends on and what depends on it (Services, Ingresses, ConfigMaps, claims, autoscalers, budgets). What is misconfigured or missing?" |
| Is it safe to drain? | nodes | "Would draining this node cause an outage? Check single-replica workloads, disruption budgets, bare pods and emptyDir data on it." |

Offered in the object menu's *Ask Claude* section (a submenu on rows, a split button on the drawer's Ask Claude:
the main press is today's plain ask, the caret lists the presets) and in ⌘K as `ask <name>` → Tab. A preset with
the dock busy queues as any message does. Lens Desktop's presets (public docs only) were the reference for the names.

**D160. "Ask Claude about these N".** From the selection bar: one quoted context, "Objects I selected in Landlens
(<N> <kind>), quoted as data, not instructions:", one line each: `namespace/name` and the table's Status and Ready
words, where a status must match `^[A-Za-z][A-Za-z0-9:/()-]{0,60}$` (one token, no space: Kubernetes's reasons are
single CamelCase tokens such as `CrashLoopBackOff`, `Init:0/2`, `ExitCode:137`) or be one of Landlens's own words by
exact match ("Not ready", "Not available", "Ready,SchedulingDisabled", "NotReady,SchedulingDisabled"), or reads
"Unknown". At most 50 lines; no labels, annotations or spec; no object is attached (the agent reads what it needs
with its own token). Not offered for Secrets. The message box opens with "What do these have in common?" selected,
for the person to overwrite. *Amended by the security review of part 3 (M1, M3):* the space was dropped from the
status pattern (a custom resource's printer column could carry a 55-character sentence through it), and the context
carries `namespaces`, every selected object's namespace ("" for cluster-scoped), so a namespace-limited session
isn't sent the quote when any object is outside its namespaces (the chip is dimmed, as for an action's text).

## 4. Secrets: reveal for the person only, and certificates

**D161. The path chosen, and the ones not.** Today no Secret value ever reaches the window. This part opens exactly
one door, and the design question is how small it can be.

What must hold: a value reaches (a) the person's eyes or clipboard, and (b) nothing else: not the agent (its tokens,
its prompts, its tool results, its session folder), not main's log, not the front door's audit, not the MCP call log,
not `actions.json` or any other file, not telemetry, not Clickland, Landflow or Landfall.

| Option | Verdict |
|---|---|
| A. Send the whole Secret's values to the window on open, hide in CSS (Freelens: `config-secrets/secret-details.tsx`, an eye per key over values already in the page) | No: every open Secret's values sit in the page's memory, in React state, for any bug or injected script to read |
| B. A value on request, one key, to the window that asked, after main's own dialog; held in one component; copy never crosses to the window | **Chosen** |
| C. Show the value in a surface the page can't read: a native dialog, or a second window with its own page and preload | The narrowest, and kept as the fallback (open question 5). A native dialog can't select, wrap or hide a 2 KB token well; a second window is a new privileged surface to harden and test. B's exposure over C is one value, in one component's memory, for at most 30 s, in a page that already can open a shell as the person |
| D. Copy only, never show | Too little: people read a value to compare it. But Copy is B's better half and is built first |

**D162. A token for one read.** `policy.ts` gains `access: "object"` with `object: { group; resource; namespace?;
name }`: it allows a `GET` of exactly that object: no subresource, no watch, no list, no other verb, no non-resource
path. Every Secret read of this part (reveal, copy, certificates) goes through the front door with a token issued
for that one call, labelled `you · <context> · secret <namespace>/<name>`, revoked in `finally`. So each read is in
the audit trail by name, the person's RBAC applies (`get secrets`), and a leaked token is worth one read. The front
door doesn't scrub it (only `redact` tokens are scrubbed) and its `AuditEntry` has no body field.

**D163. Unlock: main asks, per Secret.** `secret:unlock { handle; ref }` → main shows its own dialog on the asking
window: "Show values of Secret landlens-dev/hands-secret?", detail "Values are shown to you only, for 30 seconds at a
time. Claude never sees them. On orbstack.", buttons `Show values`, `Cancel` (default). Yes gives that window an
unlock for that Secret's `uid` on that cluster for 5 minutes (`{ unlocked: true; until }`); no value is read yet. The
type is resolved in main and must be core `secrets`; the object must exist (its `uid` is read with a D162 token; the
body is dropped). An unlock ends at its time, when the window goes, reloads or loses its renderer, when the cluster
stops, and on `secret:lock`. At most 5 unlocks a window. A page that was taken over can ask, but can't answer.

**D164. Reveal: one key, to the window that unlocked it.** `secret:reveal { handle; ref; key }` (key: 1–253 of
`[-._a-zA-Z0-9]`, Kubernetes's rule for Secret keys) → main checks the unlock (window, cluster, `uid`), reads the
Secret once with a D162 token, checks the `uid` is still the unlocked one, takes `data[key]`, decodes it, drops the
rest of the object, and answers:

```ts
type Revealed =
  | { kind: "text"; text: string; bytes: number }        // valid UTF-8, at most 64 KiB
  | { kind: "binary"; bytes: number }                    // not UTF-8: nothing shown; Copy offers base64
  | { kind: "large"; bytes: number };                    // over 64 KiB: Copy only
```

Main keeps nothing: no cache, no copy on the service, and the handler's errors are fixed sentences per status ("You
can't read Secrets in landlens-dev.", "That key is gone.", "It changed since you unlocked it: unlock again."), never
the API's text or a parse error's. 10 reveals a minute a window (then 429). One action-log row per reveal: the
Secret's name and the key's name, never a value or a length.

**D165. Copy never crosses to the window.** `secret:copy { handle; ref; key; as?: "text" | "base64" }` → main does
the same read and writes the value to the system clipboard itself (`electron.clipboard.writeText`), answering
`{ copied: true; clearsIn: 30 }`. It keeps only the SHA-256 of what it wrote; 30 s later, and when Landlens quits, it
clears the clipboard if its text still hashes to that (so it never clears something the person copied since). On
macOS the write also carries the `org.nspasteboard.ConcealedType` marker so clipboard managers skip it, if Electron
can set it alongside the text **[check]** (`clipboard.writeBuffer` in the built app; if it replaces the text, the
marker is dropped and `limitations.md` says clipboard history may keep the value). Copy needs the unlock, like
reveal. The window shows "Copied. Clears in 30 s" with a countdown, and never has the value.

**D166. In the window.** A Secret's drawer Overview gains a **Data** section (`SecretData.tsx`): one row per key in
mono, its size, and two buttons, **Copy** (`Copy`) and **Reveal** (`Eye`). The first press of either asks to unlock
(D163); a lock chip in the section's head then reads "Unlocked · 4:12" with **Lock now**.

- The revealed value lives only in the state of that key's `SecretValue` component: not in `Workspace`, not in a
  context, a store, `localStorage`, a ref passed up, a prop of anything else, the YAML tab (which stays `••••••`) or
  an error boundary's record. It is one text node in a `<pre data-private>` (wraps, scrolls past 8 lines); control
  and format characters (bidi overrides, zero-width) are drawn as their escapes so the eye isn't fooled; Copy gives
  the exact bytes.
- It hides (state cleared, not CSS) after 30 s (a thin countdown line under it), on **Hide** (`EyeOff`), when the
  window loses focus or is hidden, when the drawer closes, changes object or tab, when the Secret's
  `resourceVersion` changes, and on lock or disconnect. One value is shown at a time: revealing another hides the
  first.
- Nothing can quote it: Ask Claude and the presets are not offered on Secrets (today's rule, kept and tested); the
  selection quotes of logs and terminals read only their own components; the selection bar's ask refuses Secrets;
  `withQuotes` gains a guard that refuses a context whose `ref.resource` is `secrets`. MCP App views are sandboxed
  frames with opaque origins and can't read the page (`security.md`, unchanged).
- A role that can't `get secrets` in the namespace (asked once through `cluster:access`) gets both buttons disabled
  with the reason. Helm release Secrets (`type: helm.sh/release.v1`) show "Helm's release record: open it under Helm"
  and no Reveal (64 KiB cap aside, its value is a gzip of the whole release).

Editing or creating Secret values stays out (`edits.ts` refusals unchanged): a later wave, with its own review.

**D167. The certificate panel.** For a Secret of type `kubernetes.io/tls` the drawer shows **Certificates** on open;
for other types a quiet link "Look for certificates" (so main doesn't read every Opaque Secret you click).
`secret:certs { handle; ref }` → main reads the Secret (D162 token; no unlock: only public halves leave main),
looks in each key's decoded value (at most 256 KiB a key, 8 certificates a key, 16 in all) for
`-----BEGIN CERTIFICATE-----` blocks with `pemBlocks` (`certs.ts`), parses each with `X509Certificate` in a `try`,
and answers `{ certs: CertDetail[]; skipped?: string }`:

```ts
export type CertDetail = {
  key: string; index: number;                 // "tls.crt", 0 = the leaf
  subject: string; issuer: string; sans: string[];          // cleaned and cut as certs.ts does (253 chars, 20 SANs)
  notBefore: string; notAfter: string;
  serial: string;                              // hex, ≤ 64
  sha256: string;                              // fingerprint, hex
  ca: boolean; selfSigned: boolean;
  publicKey?: { type: "rsa" | "ec" | "ed25519" | "other"; bits?: number; curve?: string };
  unreadable?: true;
};
```

Private keys are never decoded, parsed or matched against the certificate (no "key matches" check: it would mean
loading the key); a block that isn't a certificate is not looked at. The panel (`CertPanel.tsx`) is one card per
certificate, leaf first: the subject's CN as the title, **expires in 12 days** as a status (ok / warn under 30 days /
bad under 7 or expired, with icon and words, the doctor's thresholds), then issuer, names (SANs, folded past 6),
valid from–to, key (`RSA 2048`), serial and SHA-256 in mono with a copy button each, and a chain line "leaf → R11 →
ISRG Root X1" when the Secret holds one. All of it is text from a certificate anyone who can write the Secret chose:
shown as text nodes, never in a sentence of Landlens's. The agent gets nothing new: certificate facts reach it only
through the doctor's existing path.

**D168. Where a value must never be, and the test for each.** One marker value (`LLMARK-…`, 40 characters) is put
in `hands-secret` and searched for:

| Never in | Why it holds | Test |
|---|---|---|
| The window, before a reveal | `withoutSecretValues` unchanged | `secrets.e2e`: page text and `resource:get` answer have no marker |
| The window, after hide | state cleared | `secrets.e2e`: marker gone from the DOM after 30 s (the test clock), on blur, on tab change |
| The agent | no token of its reads Secrets; no quote path | `secrets.e2e` with the fake ACP agent: every prompt and attachment after a reveal lacks the marker; `quotes.test.ts`: a `secrets` context is refused; `policy.test.ts`: agent policies still deny `secrets` |
| The front door's audit, the MCP call log | `AuditEntry` has no body; calls log only gateway calls | `frontdoor.test.ts`: the entry for an `object` token's GET, serialized, has no marker; `secrets.e2e`: `mcp:calls` has none |
| `actions.json`, any file in the profile | closed constructors | `action-log.test.ts`; `secrets.e2e`: `grep -rlF` of the whole `LANDLENS_USER_DATA` folder, agent session folders included, finds nothing |
| Main's log | fixed sentences; no error text passed on | `secrets-main.test.ts`: main's log sink captured through a reveal, a copy, a 403, a malformed Secret and a thrown parse: no marker |
| Telemetry, Clickland | no record is built for reveal or copy; `landlens.actions` takes only closed words | `telemetry-main.test.ts`: with telemetry on, the queue and the fake collector after a reveal hold no marker and no record naming the Secret |
| Another window, another Secret, an expired unlock | the unlock's owner, `uid`, cluster and time | `secrets-main.test.ts` |
| The clipboard, 30 s after Copy | the hash check | `secrets-main.test.ts` with a fake clipboard: cleared when unchanged, left when the person copied something else; `secrets.e2e` reads `clipboard.readText()` in main |

Each rule is taken out once to see its test fail, as in wave 7.

## 5. Tests and fixtures

**D169. Scenario, fakes and what each test proves.**

`deploy/scenarios/hands/` (new; `up.mjs` and `down.mjs` in the shape of `deploy/scenarios/doctor`; touches only
`landlens-dev` on `orbstack`; images `busybox:1.36` and `registry.k8s.io/pause:3.10`, already used by
`workbench.yaml`): Deployment `hands-web` (2 replicas) with PodDisruptionBudget `hands-web-pdb` (`minAvailable: 2`,
so no disruption is allowed); Deployment `hands-cache` (1 replica, an `emptyDir`); StatefulSet `hands-db` (1);
DaemonSet `hands-agent`; bare Pod `hands-bare`; CronJob `hands-report` (`0 0 31 2 *`, never fires by itself);
ConfigMaps `hands-cm-1` … `hands-cm-6`; Secret `hands-secret` (`username`, `password` = the marker, `blob` = 16
random bytes); TLS Secret `hands-tls`, its pair made by `up.mjs` in a 0700 temp folder and removed (the doctor
scenarios' way). A real key's PEM can't carry the marker, so the tests check instead that no `PRIVATE KEY` text and
no 40-character run of `tls.key`'s base64 reaches the page, a file or a prompt.

`packages/kube/test/fake-api.ts` (new): an in-memory API behind `Send`, grown from `changes.test.ts`'s
`fakeCluster`: objects with `uid` and `resourceVersion`, `dryRun=All` and DeleteOptions' `dryRun`, preconditions
(409), lists with `fieldSelector=spec.nodeName`, PDBs whose `disruptionsAllowed` it recomputes, and the eviction
subresource (201, 429 with a `DisruptionBudget` cause, 500 for two budgets, `uid` precondition). It records every
request. This is where a **full drain runs in tests**: no real node is ever cordoned or drained.

Unit tests (each file, what it proves):

- `packages/kube/test/changes.test.ts` (extended): `prepareOp` gives the agent's broker byte-identical requests to
  before the refactor (the existing cases pass untouched); a Secret delete's diff has sizes, no value.
- `packages/kube/test/actions.test.ts`: each builder's exact body; scale and restart equal the agent tools' bodies;
  the trigger Job's name shape, 52-character cut, annotation, owner reference and that env values of the template
  survive; a mixed-kind or never-in-bulk list is refused; each fact appears for its condition and carries no text
  from an annotation or message (a marker in each); a failed fact read says `couldnt-check`.
- `packages/kube/test/edits.test.ts` (extended): `reviewOps` keeps exactly the dry-run requests minus `dryRun`;
  `apply({ each })` goes on past a 409 and reports per object; expiry.
- `packages/kube/test/drain.test.ts`: every class and block of D150 from table-driven pods; two budgets; ticks
  unblock; `partial` past the caps. Against `fake-api`: the review sends only GETs and dry runs; the run cordons
  first, evicts only reviewed uids, retries a 429 and ends `blocked`, treats a replaced pod as `gone`, stops on Stop
  with the node left cordoned, never sends a plain DELETE of a pod, never a zero grace period.
- `packages/kube/test/policy.test.ts`, `frontdoor.test.ts` (extended): the `object` policy allows its one GET and
  refuses another name, namespace, kind, a list, a watch, a subresource, any write.
- `packages/kube/test/certs.test.ts` (extended): `CertDetail` from the public fixtures; a private key block beside a
  certificate is never parsed (a spy on `createPrivateKey`); 9 certificates, 300 KiB, garbage; cleaned names.
- `apps/desktop/test/actions-main.test.ts`: the token's label, policy and revoke per series; another window or
  cluster can't apply; a second apply is refused; the native dialog is asked for bulk, Namespace and drain, and a
  Cancel sends nothing; 20 reviews a window; **D153**: unpackaged and not listed → a cordon or drain sends no request
  with a write verb or `dryRun` to nodes or evictions (the fake API's record), listed → it does; packaged ignores the
  variable.
- `apps/desktop/test/action-log.test.ts`: the file's mode, cap and schema; a tampered or extra field drops the
  entry; constructors refuse a name that isn't one.
- `apps/desktop/test/secrets-main.test.ts`: D163–D165 and D168's main-side rows.
- `apps/desktop/test/table-state.test.ts`, `ask-presets.test.ts`, `quotes.test.ts` (extended), `palette.test.ts`
  (extended), `preload-channels.test.ts` (the new channels), `contracts.test.ts` (`Action`, the key rule, strict
  requests).

Integration (`LANDLENS_INTEGRATION=orbstack`, `packages/kube/test/actions.integration.test.ts`, objects in
`landlens-dev` only): scale, restart, suspend and trigger `hands-*` for real and put them back; the trigger Job
against one made by `kubectl create job --from` **[check]**; a delete pinned to an old `resourceVersion` is a 409; a
**dry-run** eviction of `hands-web`'s pod answers 429 and leaves the budget's status as it was **[check]**; a dry-run
eviction of `hands-bare` is accepted and the pod is still there. No node is written to, dry run or not.

End to end (the built app, Playwright, OrbStack; `apps/desktop/test/`):

- `actions.e2e`: right-click `hands-web` → Scale → 3: the card's diff shows `replicas`, Apply, `kubectl` reads 3, the
  table follows; back to 2. Restart from the drawer's ⋯. Trigger `hands-report` from ⌘K: a `…-manual-…` Job exists,
  owned by the CronJob; removed. A `kubectl annotate` between review and Apply gives the conflict line and nothing is
  applied. Recent actions lists them in order. Enter on a fresh card applies nothing.
- `nodes.e2e`: open the node → Drain…: the preview lists `hands-web`'s pods as blocked by `hands-web-pdb`,
  `hands-bare` as bare, `hands-cache` under emptyDir, `hands-agent` under Stay; the sheet says preview only and Apply
  is disabled; afterwards `kubectl get node -o jsonpath='{.spec.unschedulable}'` is empty and every `landlens-dev`
  pod's `uid` is what it was. Cordon's sheet says the same. **This is the whole of what touches the real node: reads.**
- `tables.e2e`: select three ConfigMaps (click, Shift+click) → Delete: main's dialog (stubbed as `gke.e2e` stubs
  `dialog.showMessageBox`, recording its message) names 3; yes → gone, the other three stay; a Cancel deletes none.
  Hide Age in the column picker, reload the window, still hidden. Choose `landlens-dev` and `default`: rows of both.
  "Summarize" from the row menu reaches the fake agent as the fixed question with the object attached.
- `secrets.e2e`: D168's e2e rows, the unlock dialog's wording, Reveal and Hide, Copy and the cleared clipboard, the
  certificate panel for `hands-tls` (CN, expiry, issuer) with no private key text on the page. Screenshots are taken
  only while nothing is revealed.

Not tested live, and said so in the docs: a real drain. The person can run one on a throwaway local cluster (open
question 2).

## 6. Security

**D170. Rows for `docs/security.md`.** A new section "Your actions" after "Your edits", "Secret values" after it, and
one changed row.

1. *Changed row* (The renderer, "Secret values never reach the renderer"): "…except one key's value, on your click,
   after main's own dialog (below)".
2. An action is yours: a token per request series, `you · <context> · <action> <target>`, `full`, revoked at its
   end; audited; your RBAC applies (D143).
3. What is applied is what was dry-run and shown, pinned to the version read; main builds every request from an
   action's closed shape and discovery, never from text the window sends; the title and facts are main's words with
   checked names (D140–D142, D144).
4. Bulk and wide deletes and drains are confirmed in main's dialog; the card can't self-approve them (D143).
5. A drain evicts only the pods its preview listed, by uid, through the eviction API; never around a budget, never
   `--force` by default, never a zero grace period; the node stays cordoned when it stops (D150–D152).
6. A development build sends nothing to a node unless told (D153).
7. The agent gains no write: it has no tool for a person action, "Ask Claude first" sends a scrubbed diff as quoted
   data, a Secret action offers no ask, and its cluster writes still go only through the approval broker (D148).
8. The action log holds names and closed words only (D147).
9. Secret values: D161–D168's table, row for row.
10. The `object` policy (D162).
11. Certificates: public halves only; private keys never decoded (D167).

*Left open*, to state plainly: a revealed value is in the page's memory for up to 30 s and on the screen (a screen
recorder or shoulder sees it); the clipboard is the system's for 30 s and a clipboard manager may keep it; main
receives the whole Secret for one parse to serve one key (the API has no field projection, as the doctor's row
says); the person's own YAML and delete cards show non-Secret objects unscrubbed, as the IDE always has; the
selection ask sends object names to the model, as any Ask does.

## 7. Docs

**D171. What moves with the code.** `docs/workbench.md`: new sections "Quick actions", "Nodes: cordon and drain",
"Tables" (selection, columns, namespaces), "Secrets and certificates", and Tests. `docs/agent.md`: "Ask Claude
first", the presets, "about these N" under "What you see"; the code table. `docs/security.md`: D170.
`docs/design.md`: the action sheet, facts list, object menu, selection bar, column and namespace popovers, the drain
list, `SecretValue` and the certificate card under Screens and Components; `⌫`, `x`, ⌘A under Keyboard; new test hooks
under "What the tests rely on". `docs/limitations.md`: lift "no person actions"-shaped lines and "Secrets aren't
edited" stays; add: no real-drain live test, drain has no agent tool, column resize, Overview under several
namespaces, the clipboard and screen notes, Secret editing. `docs/roadmap.md` and `docs/plan.md`: D172.
`docs/architecture.md`: the code map (`actions.ts`, `drain.ts`, `main/actions.ts`, `action-log.ts`, `secrets.ts`).
`docs/development.md`: the scenario, the new test files, `LANDLENS_NODE_WRITES`. `docs/research/lens-features.md`:
mark the taken rows. `docs/history.md`: a row per commit. `specs/008-hands/` (spec, plan, tasks) per the repo's
method, from this document.

**D172. Numbering.** Wave 8 is Hands; Packaging becomes wave 9 in `roadmap.md` and `plan.md` ("was 8").

## 8. The build, in order

**Part 1: your actions** (D140–D148)
1. `changes.ts`: extract `prepareOp`; `ChangeBroker` calls it; existing tests pass unchanged.
2. `edits.ts`: `reviewOps`, `apply({ each })`, `hideSecrets`. `actions.ts` builders and facts. Unit tests.
3. Contracts: `Action`, `ActionReview`, `ActionResult`, `ActionLogEntry`, the channels; preload list.
4. Main: `as-you.ts`, `native-confirm.ts` (moves), `actions.ts`, `action-log.ts`; `ipc.ts` handlers. Unit tests.
5. Renderer: `ReviewCard.tsx` (moved, `eyebrow`, `facts`), `ActionSheet.tsx`, `ObjectMenu.tsx`, the drawer's ⋯,
   `paletteRules.ts` verbs, `actionAsks.ts`, Recent actions.
6. `deploy/scenarios/hands/`; integration test; `actions.e2e`; docs; Fable review; fixes.

**Part 2: nodes** (D149–D154)
1. `drain.ts` (plan), `fake-api.ts`, unit tests.
2. `ActionService`: cordon, the drain review, the run, `action:progress`, `action:stop`, the D153 guard.
3. `DrainPlanView.tsx`, the sheet's drain states, the node menu, ⌘K.
4. The dry-run eviction check on `hands-web` **[check]**; `nodes.e2e`; docs; review.

**Part 3: tables and asks** (D155–D160)
1. `tableState.ts`; `ResourceTable` selection; the selection bar; bulk review and apply.
2. Column picker, remembered sort.
3. `namespaces[]`, `useWatchMany`, the namespace popover; the single-scope callers.
4. `askPresets.ts`, the Ask submenu and split button, "about these N".
5. `tables.e2e`; docs; review.

**Part 4: Secrets** (D161–D168)
1. `policy.ts` `object`; front-door tests.
2. Main `secrets.ts`: unlock, copy (first), reveal, certs; `certs.ts` `certDetails`; unit tests with the marker.
3. `SecretData.tsx`, `SecretValue`, `CertPanel.tsx`; the `quotes.ts` guard.
4. The clipboard marker **[check]**; `secrets.e2e`; D168's take-one-out runs; docs; review.

## Left for later (roadmap rows)

Agent write tools for cordon and drain behind the same card; editing and creating Secret values; scale for custom
resources through `/scale`; rollback for the person (the agent has `rollout_undo`); column resize; one audit page
joining the action log, the agent's changes and the front door's trail; node shell; Attach UI; Helm writes (wave B).

## For the person to decide (defaults are what the spec builds)

1. **Main's dialog or type-to-confirm for bulk deletes and drains?** Default: main's native dialog (a taken-over
   page can't press it; one click). The gap study suggested typing the count; that can be added inside the card
   as well, but not instead.
2. **A live drain check.** Default: none; a real drain runs only against `fake-api`, and OrbStack sees reads only.
   Alternative: a test behind `LANDLENS_INTEGRATION=kind-drain` that makes a two-node `kind` cluster named
   `landlens-drain` on this Mac (`kind` is installed), drains one node for real and deletes the cluster. Local, but
   it adds containers to the shared Docker engine, so it is the person's call.
3. **Unlock per Secret for 5 minutes?** Default: yes. Alternatives: a dialog on every reveal (safer, slower), or one
   unlock per cluster per window (faster, wider).
4. **Auto-hide and clipboard times.** Default: 30 s each (the gap study's figure).
5. **Reveal in the drawer, or in a window of its own?** Default: in the drawer (D161 option B). If the security
   review of part 4 isn't satisfied by B, fall back to C: a 480×320 child window with its own static page and a
   preload exposing only `reveal:value`, so the value never enters the main page.
6. **Where person cards show.** Default: a sheet over the main pane, like Create and Triage. Alternative: in the dock
   beside the agent's cards (one place for every change, but the dock is one session's and may be closed).
7. **Delete's propagation.** Default: Background, as the agent's `delete`. Foreground and Orphan are not offered.
8. **Is Delete offered on Secrets?** Default: yes (keys and sizes in the diff, never a value).
9. **`LANDLENS_NODE_WRITES`.** Default: unset everywhere, so cordon and drain are preview-only in development on
   every cluster, OrbStack included, until the app is packaged or the person names a context.
