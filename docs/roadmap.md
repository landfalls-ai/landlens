# Roadmap

The approved waves ([plan.md](plan.md)) and where each stands.

| Wave | What | Status |
|---|---|---|
| 0 | Study: upstream pinned, Craft Anything study of Freelens, research, plan | Done (14 Nov 2026) |
| 1 | Shell: security baseline, kubeconfig catalog, Go sidecar, TLS front door with token policies, discovery, RBAC checks, live lists and details | Done (14 Nov 2026) |
| 2 | The agent (ACP): Claude Code in the dock, read-only cluster MCP server, the kubectl fence, "Ask about this" | Done (14 Nov 2026) |
| UI | Iris redesign: one sidebar with a cluster switcher, the Overview landing page, status at a glance, the drawer's diagnosis, the dock's tool groups and composer, dark and light, 1024×700 ([design.md](design.md)) | Done (14 Nov 2026) |
| Graphs | Pulled forward from wave 4 (metrics) and wave 6 (Clickland): CPU and memory on the Overview (Usage, node sparklines) and the drawer's Metrics tab for pods and workloads; Clickland history, else metrics-server sampled live, else the reason ([metrics.md](metrics.md)) | Done (14 Nov 2026) |
| 3 | Agent writes behind your approval; session history; other ACP agents; chosen skills in agent sessions | Next |
| 4 | Workbench: logs, terminals, port-forward, YAML editor, metrics beyond CPU and memory (Prometheus if found; graphs are built), the drawer's disabled Logs tab, Helm, CRD printer columns, the full command palette (⌘K Jump to covers kinds and loaded objects) | |
| 5 | Cluster doctor | |
| 6 | Land family: Clickland (metrics history is built; Landlens's own telemetry, logs and traces from Clickland remain), Landfall (through Landflow), Landflow flows, brain, Landbright OIDC | |
| 7 | Packaging: local `.dmg` with hardened fuses | |
