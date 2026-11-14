# Landlens and the land family: integrations

Status: **proposed, 14 November 2026.** A design, not a build. No sibling repository was changed.

Paths are relative to `~/WorkSpace`. The surfaces below come from each project's docs and from Clickland's survey
`clickland/docs/research/land-family-integrations.md`, which was checked against the code on the same day.

## The short version

- **Clickland gives the agent evidence.** Its MCP server (`/api/mcp`, 13 read tools) can be handed to the Claude
  session next to Landlens's own cluster MCP server, so "why is this pod crashlooping" can read the pod *and* its
  logs, traces and metrics. Landlens also sends its own telemetry to Clickland's collector, like every land app.
- **Landfall gets rooms from Landlens.** "Open a war room" on a failing workload posts a remote trigger with entity
  hints; a session's findings can go to the room's timeline. Landfall's MCP connector can be handed to the session
  so the agent sees the incident.
- **landfall-cluster-agent already solved redaction.** Its strip-and-redact rules are the rules Landlens's MCP server
  should apply before any object reaches the model.
- **Landbright is the cluster's identity provider.** A cluster can trust Landbright as its OIDC issuer; Landlens runs
  the login for kubeconfig `exec` users. Optional, later.
- **Landflow runs flows from the IDE.** Workflows (triage, runbooks) can be started on a selected resource, and a
  session's summary can go to the company brain (person in the loop first).

## Clickland (observability)

- **MCP server**: `http://127.0.0.1:4710/api/mcp`, bearer `ck_` key with `read` scope. Read tools: `search_logs`,
  `search_traces`, `histogram`, `count`, `get_trace`, `list_services`, `query_metric`, `list_metrics`,
  `event_patterns`, `list_alerts`, `search_knowledge`, `list_dashboards`, `get_view`
  (`clickland/docs/reference/api.md`, `clickland/apps/api/src/mcp.ts`).
- **What it already has about Kubernetes**: every pod's log with namespace, pod, container and workload attributes,
  kubelet stats and cluster state as metrics, and every Kubernetes event as a log (`clickland/docs/sources.md`). So a
  Landlens pod view can link to the same pod in Clickland by `k8s.namespace.name` + `k8s.pod.name`.
- **Integration**:
  1. ACP `session/new` passes Clickland's MCP server (type `http`) to the agent when the user has a Clickland key in
     Landlens settings. Read-only tools only.
  2. "Open in Clickland" on pods and workloads (a link to the search with the pod's attributes).
  3. Landlens's main process sends OTel traces, metrics and logs to `http://127.0.0.1:4318` (service `landlens`),
     with ACP session spans (prompt → tool calls → outcome), never prompt text.

## Landfall (incident war room)

- **Open a room**: `POST /triggers` with the org's ingest token and a `remote` `SourceTriggerPayload` (title,
  severity, `entityHints`, `dedupKey`, `summary`, `url`). It needs a healthy remote-source connection, so the
  default route is through Landflow's triage flow, as Clickland's survey decided.
- **Timeline and artifacts**: `POST /o/:slug/incidents/:id/events` (`chat.message`) and `…/artifacts` with an
  `lf_key_` API key. A Landlens session can post "what the agent found" to the room, after the person approves.
- **Hosted MCP connector** (`landfall/libs/mcp-gateway/src/tools.ts`): handed to the ACP session when the user is
  working an incident, so the agent reads the room.
- **Rule kept**: Landfall stays agnostic; Landlens speaks its generic interfaces. Landlens never closes a room.

## landfall-cluster-agent (read-only Kubernetes agent)

- A closed list of 7 `k8s.*` operations (`landfall-cluster-agent/internal/k8sops/`): workloads, events, rollouts,
  pods, topology, resources, logs.
- Before anything leaves, it strips `metadata.managedFields`, every annotation except the rollout revision and
  change cause (so `last-applied-configuration` never leaves), and `env[].value`; caps rows, strings (4 KiB) and the
  result (3 MiB); then redacts with Landfall's redactors and gitleaks' rules
  (`landfall-agent-kit/redact/rules/gitleaks.toml`) (`landfall-cluster-agent/README.md`).
- **Integration**: Landlens's cluster MCP server takes the same rules (the strip list, the caps, and the same
  gitleaks rule file, loaded from a pinned copy), and never returns a Secret's `data`. Its read operations are a
  superset of the agent's seven, so a later Landfall connection to the same cluster gives the same answers.

## Landbright (identity)

- OIDC provider at `http://localhost:4402/oidc`, an applications API, signed event subscriptions; SCIM is planned
  (`clickland/docs/research/land-family-integrations.md` §1).
- **Integration (later)**: a dev cluster configured with Landbright as its OIDC issuer; Landlens registers as a
  public client (PKCE, loopback redirect) and acts as the kubeconfig `exec` credential plugin for such users. Also
  the sign-in for Landlens's optional team features (shared cluster bookmarks), if they are ever built.

## Landflow (workflows, agents, brain)

- **Run a flow on a resource**: Landflow flows with a webhook trigger, called with the resource reference. Example:
  "triage this workload" (the triage flow), "run this runbook".
- **Brain offload**: a session's summary (question, findings, actions taken) can be sent to the company brain as a
  daily offload, person in the loop (`landflow/docs/README.md`, the brain pages). This follows the north star of
  everyone working through MCP and offloading daily.
- **Agents**: Landflow's agents run on kagent over A2A. ACP and A2A are different protocols; Landlens speaks ACP to
  local agents. A Landflow agent could be offered through an ACP adapter later. Not in the first plan.
- **The cluster itself**: Landflow runs in `landflow-dev` on the same OrbStack cluster, so it is a real workload
  to debug with Landlens (read-only, per the local-only rules).

## Questions for the user

1. Should Landlens send Landfall rooms directly (needs a remote-source connection) or only through Landflow's
   triage flow (the family default)?
2. Should session summaries go to the brain automatically (after a confirm) or only when asked?
