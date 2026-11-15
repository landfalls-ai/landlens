# Roadmap

The approved waves ([plan.md](plan.md)) and where each stands.

| Wave | What | Status |
|---|---|---|
| 0 | Study: upstream pinned, Craft Anything study of Freelens, research, plan | Done (14 Nov 2026) |
| 1 | Shell: security baseline, kubeconfig catalog, Go sidecar, TLS front door with token policies, discovery, RBAC checks, live lists and details | Done (14 Nov 2026) |
| 2 | The agent (ACP): Claude Code in the dock, read-only cluster MCP server, the kubectl fence, "Ask about this" | Done (14 Nov 2026) |
| UI | Iris redesign: one sidebar with a cluster switcher, the Overview landing page, status at a glance, the drawer's diagnosis, the dock's tool groups and composer, dark and light, 1024×700 ([design.md](design.md)) | Done (14 Nov 2026) |
| Graphs | Pulled forward from wave 4 (metrics) and wave 6 (Clickland): CPU and memory on the Overview (Usage, node sparklines) and the drawer's Metrics tab for pods and workloads; Clickland history, else metrics-server sampled live, else the reason ([metrics.md](metrics.md)) | Done (14 Nov 2026) |
| MCP | Pulled forward from wave 3 (the audit trail) and wave 6 (Clickland): the MCP gateway (every session's MCP calls proxied, logged and approval-gated; remote servers per cluster), the MCP page (servers and the call log with front-door requests), MCP App views inline in the dock for `cluster_overview`, `describe`, `get_logs` and a new `metrics` tool, and remote servers' views such as Clickland's ([mcp.md](mcp.md)) | Done (14 Nov 2026) |
| 3 | Agent writes behind your approval (the approval broker: dry run, diff, preconditions, apply), session history and resume, slash commands, chosen skills in agent sessions ([agent.md](agent.md)). Other ACP agents deferred until Landlens has its own sandbox ([limitations.md](limitations.md)) | Done (15 Nov 2026) |
| 4 | Workbench ([workbench.md](workbench.md)): part 1, the panel, followed logs (pods and workloads, search, previous, Ask Claude about lines), pod shells that run as you, the local terminal; part 2, the YAML editor (CodeMirror 6; a dry-run review, then apply as you) and Create from YAML; part 3, port-forward; part 4, CRD printer columns, Helm (read), the full command palette, Prometheus if found | Built and reviewed (15 Nov 2026): parts 1–4, each with Fable's security review fixed; on branch `wave4-workbench` until merged |
| 5 | Cluster doctor | |
| 6 | Land family: Clickland (metrics history is built; Landlens's own telemetry, logs and traces from Clickland remain), Landfall (through Landflow), Landflow flows, brain, Landbright OIDC | |
| 7 | Packaging: local `.dmg` with hardened fuses | |
