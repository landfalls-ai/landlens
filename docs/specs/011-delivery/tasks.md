# Wave 11: Delivery — tasks

The spec is [spec.md](spec.md) (D226–D259). Each part is one build and one review cycle: it ends running on OrbStack,
with its tests green, its docs moved and a security review, as in waves 4–10. No test reaches GitHub, Linear or Google
(the loopback fakes only). Kubernetes writes only in `landlens-dev`, plus what the person approves in the spec's
questions 1 and 2 (the labelled CRDs on OrbStack; the `landlens-delivery` kind cluster). Until they answer, parts 1–3
and 5 use the in-memory API and the fakes, and part 4 uses `landlens-demo` in `landlens-dev`.

Before part 1: settle the [check] items the part relies on (below each part) against the pinned upstream tags, and
write what was found into the spec's text, as wave 10 did.

## Part 1: GitOps awareness (D226–D233, D253's read tools, D256)

- [ ] `packages/kube/src/gitops/detect.ts`: the groups and versions of D227 from discovery; the "older API version"
  line; `detect.test.ts` (Flux at v1 and v1beta2, Argo CD, Trivy, none)
- [ ] `model.ts`: `GitopsObject` from Flux and Argo CD objects (conditions to state and tone, reasons held to one
  token, messages cleaned, redacted, cut); fixtures reduced from the docs' examples; `model.test.ts` (every state,
  suspended over all, a malformed status read as unknown, a hostile message)
- [ ] `owner.ts`: the ladder (Argo tracking id and instance label, Flux labels with inventory proof, HelmRelease via
  `status.history`, Helm annotations with the release's objects, owner references), the chain (6 hops, cycles), hints
  without proof; shared watches of Kustomizations and Applications in `WatchHub`, indexed by object key;
  `owner.test.ts` (forged label: hint; multi-source; app of apps; a Kustomization of Kustomizations)
- [ ] `drift.ts`: Argo's `OutOfSync`, Flux's foreign field managers (your read only), HelmRelease drift mode; "can't
  tell" when there is no signal; `drift.test.ts`
- [ ] Doctor rules of D233 in `doctor.ts`, grouped by owner; `doctor.test.ts` cases; the brief's facts
- [ ] The live-edit warning (D231) computed in main for the YAML editor (`edits.ts`'s caller), actions (`actions.ts`),
  the agent's broker (`changes.ts`'s caller) and views' intents; the exceptions (HPA replicas, `spec.ignore`, kinds not
  applied); the tool result's extra line for Claude; tests in `edits.test.ts`, `actions-main.test.ts`,
  `agent-service.test.ts`
- [ ] Renderer: the GitOps sidebar group, its tables and columns, `DeliveryPanel.tsx`, the **Managed by** column
  (`tableState.ts`), the Overview's line; the buttons of D231 present but **Open a pull request** and **Suspend
  first** disabled with "Part 3" / "Part 2" until those parts
- [ ] `redact.ts`: HelmRelease and Application values scrubbed for agent tokens (D253); `redact.test.ts`
- [ ] `kube-mcp`: `gitops_overview`, `gitops_source`, `gitops_status` (read-only, session token); `prompt.ts`'s
  delivery paragraph (D256); `prompt.test.ts`
- [ ] `view-fakes.ts` serves the GitOps kinds; `deploy/scenarios/delivery/crds.mjs` (pinned CRDs, the label, the
  refusals, `down` deletes only labelled CRDs) and the fixtures' custom resources for `landlens-dev`
- [ ] e2e 1, 2 (Tier 2 if approved, else the in-memory API through a unit-level page test)
- [ ] Docs: new `docs/delivery.md` (awareness), `security.md` rows, `doctor.md`, `agent.md`, `design.md`,
  `architecture.md`, `development.md` (the tiers, the script), `limitations.md`, `roadmap.md`, `plan.md`,
  `README.md`, this folder, `history.md`
- [ ] Security review of part 1, and its fixes

[check] items for part 1: the Flux object labels and kustomize-controller's field manager (kustomize-controller and
helm-controller source at the v2.10.0 tags); Argo CD's `status` field names and where `ignoreDifferences` lives (the
v3.6.1 CRD schema); HelmRelease's default drift detection mode.

## Part 2: GitOps actions, as you (D234, D235)

- [ ] Contracts: `ActionKind` gains `reconcile`, `reconcileWithSource`, `force`, `resetRetries`, `resume` (suspend
  widened to Flux kinds), `refresh`, `sync`, `autoSync`; strict options (refresh `normal|hard`; sync `prune`,
  `resources` ≤ 50); `contracts.test.ts`
- [ ] `action-kinds.ts` and `actions.ts`: the requests and facts of D234, built from main's reads; the refusals
  (running operation, ApplicationSet-owned, no `enabled` field after the dry run); main's dialog cases;
  `actions.test.ts`, `actions-main.test.ts`
- [ ] The object menu, drawer, Delivery panel (**Reconcile** and **Suspend** on the owner, enabling D231's **Suspend
  first**), ⌘K verbs, bulk from GitOps tables (never Sync)
- [ ] The Sync card's line on Kubernetes RBAC, once per cluster (D235)
- [ ] `kube-mcp` `gitops_action` through the broker; the card's facts; `writes.test.ts`, broker tests
- [ ] e2e 5 (Tier 2 if approved, else unit-level against the in-memory API)
- [ ] Docs: `delivery.md` (actions), `workbench.md`, `security.md`, `agent.md`, `limitations.md`, `history.md`
- [ ] Security review of part 2, and its fixes

[check] items for part 2: whether `operation.sync.revision` may be left out; which Argo CD version added
`automated.enabled`; whether the application-controller enforces sync windows on an `operation` set through the CRD.

## Part 3: through pull requests (D236–D242)

- [ ] `packages/gitops` (new): `repo.ts` (URLs to `owner/repo`, userinfo stripped, base branch and revision rules),
  `locate.ts` (tree, parse with limits, identity through `namespace`/`namePrefix`/`nameSuffix`, overrides `images`,
  `replicas`, patches; every "not placed" reason), `edit.ts` (Document API edits, round-trip check, refusals),
  `errors.ts`, `limits.ts`; `fixtures/fleet/` (plain, base and overlay, HelmRelease, Application with `valueFiles`,
  remote base, generator, `${…}`, SOPS, SealedSecret, alias bomb); tests for each
- [ ] `packages/connections/src/github-repo.ts`: the seven calls through `pinnedFetch`, the branch name, the rules;
  `github-repo.test.ts` against the fake (every request recorded: no existing branch written, no `.github/`, drafts
  only, blob sha pinned, 403 sentences)
- [ ] `fake-provider.ts`: GitHub's REST repository over the fixture folder (trees, contents, refs, contents PUT with
  sha checks, pulls), recorded
- [ ] `main/gitops.ts` `GitopsService`: the flow (intended change → locate → edit → card → create), the level rule,
  30 calls a minute per window, the Recent actions row, telemetry by outcome; `gitops-main.test.ts`
- [ ] `PullRequestCard.tsx`: repository and visibility, base and branch, diffs, the source sentence, title, fixed body
  and the editable note, the deliberate press, main's dialog for a public repository with Claude's change, the
  ApplicationSet warning; **Open a pull request instead** enabled in the review sheets
- [ ] **Ask Claude to draft it** (D240): the prompt with the object, source and intended change under the cluster
  data head; Claude's file edits checked as D239
- [ ] `kube-mcp` `propose_gitops_change` (source of truth resolved by main, never from arguments; the card in the dock;
  the outcome sentence under the GitHub line; never autonomous); tests that an autonomous GitHub scope doesn't skip
  the card
- [ ] e2e 3, 4, and 9's PR half with the fake agent
- [ ] Docs: `delivery.md` (pull requests), `connections.md` (Landlens's own pull requests and the level rule),
  `security.md`, `agent.md`, `limitations.md`, `history.md`
- [ ] Security review of part 3, and its fixes

[check] items for part 3: GitHub REST call shapes (D241); the ApplicationSet pull-request generator's fields; Flux's
artifact revision format for OCI and tag sources (the locator's revision).

## Part 4: Helm writes (D243–D249)

- [ ] `sidecar/helm-runner` (new Go module, `helm.sh/helm/v4` pinned): JSON over stdin/stdout (`review`, `apply`,
  `rollback`, `uninstall`, `render`), the token from stdin, a kubeconfig to the front door, environment ignored, empty
  plugin/repository/registry folders, a dialer that reaches only the front door, `MaxHistory`, the render digest; Go
  tests with Helm's fake client; build and signing wiring in `scripts/` beside the sidecar's
- [ ] `policy.ts`: `objects` (the set, a POST's name from the body) and `dryRunOnly`; `frontdoor.ts`; `policy.test.ts`,
  `frontdoor.test.ts` (a write outside the set, a non-dry-run write on a review token, a DELETE whose body lacks dry
  run: each refused before the sidecar)
- [ ] `main/helm.ts` `HelmService`: the helper's lifecycle (5 minutes, killed, token revoked), review (values merge
  with `«hidden»` kept by path, render, per-object dry runs, the card's facts), apply (revision, status and render
  checks), rollback, uninstall with main's dialog; refusals for Flux-owned releases (D248); `helm-main.test.ts`
- [ ] Renderer: **Edit values** (`HelmEdit.tsx`), `HelmCard.tsx` (values diff, per-object diffs, hooks, facts),
  **Roll back to this** in History, **Uninstall** with Keep history
- [ ] The rendered preview in part 3's card for HelmRelease values (render-only, the chart from the release record)
- [ ] `kube-mcp` `helm_release` (main's closed shape, the session's namespaces), `propose_helm_upgrade`,
  `propose_helm_rollback`; tests that no manifest or merged values reach Claude
- [ ] Integration on OrbStack (`landlens-dev` only): `landlens-demo` upgraded, rolled back, uninstalled and
  reinstalled; every request under the helm label and inside the set; a terminal `helm upgrade` between review and
  Apply refused
- [ ] e2e 6, and 9's Helm half with the fake agent
- [ ] Docs: `delivery.md` (Helm), `workbench.md` (Helm writes), `limitations.md` ("Helm is read-only" replaced),
  `security.md`, `development.md` (building the helper), `architecture.md`, `CLAUDE.md`'s layout, `history.md`
- [ ] Security review of part 4, and its fixes

[check] items for part 4: the newest `helm.sh/helm/v4` at build; Helm 3 reading a release Helm 4 wrote; whether
Helm 4's server dry run already dry-runs each object; its wait strategies; the CLI's history default.

## Part 5: Trivy, Applications, views, live (D250–D252, D255, the live test)

- [ ] `packages/kube/src/trivy.ts`: paginated reads as you, reports cut on arrival, owner mapping, ExposedSecretReport
  counts and rule ids only; `trivy.test.ts` (a `match` marker never kept; 5,000 cap; stale report)
- [ ] `policy.ts`: ExposedSecretReport denied for agent and view tokens by group and kind from discovery
- [ ] `SecurityPanel.tsx`, the Security column, the Problems section, the Overview line; the doctor rule (D251)
- [ ] `packages/kube/src/apps.ts` (D252's rules and precedence, health, version), `ApplicationsPage.tsx` and its
  drawer (members, events, logs, the Delivery panel, Ask Claude's brief); `apps.test.ts`
- [ ] `kube-mcp` `security_findings`, `applications`
- [ ] `packages/views`: `gitops.objects`, `apps.list`, `security.findings` sources in the schema and `view-runtime.ts`
  (polls, `_ref`s), the `reconcile` and `refresh` intents, `view_context`, the two example chips; tests as wave 10's
- [ ] e2e 7, 8; the live test with the person's Claude Code (fakes for GitHub)
- [ ] Tier 3 checks if approved: in `kind-landlens-delivery`, Flux reverts a live edit after the warned Apply; a
  pull request "merged" into the in-cluster Git server is applied; Argo CD syncs; the Trivy Operator writes config
  audit reports that show in the panel
- [ ] Docs: `delivery.md` (Trivy, Applications), `views.md`, `doctor.md`, `security.md`, `design.md`, `roadmap.md`
  (the wave's row), `limitations.md`, `history.md`
- [ ] Security review of part 5, and its fixes

[check] items for part 5: the Trivy Operator's CRD names at v0.36.1; whether config audit downloads its checks bundle;
Argo CD core install's contents at v3.6.1; a small image for the in-cluster Git server.
