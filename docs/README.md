# Landlens docs

| Page | What it covers |
|---|---|
| [agent.md](agent.md) | Claude Code in the dock: what you see, the cluster tools, the fence and how it was checked |
| [architecture.md](architecture.md) | The processes, a request end to end, the front door, the code map |
| [mcp.md](mcp.md) | The MCP gateway every agent session's MCP calls go through, the MCP page (servers, call log), MCP App views in the dock, pairing cards with calls, adding a server |
| [workbench.md](workbench.md) | The panel, followed logs, pod shells that run as you, the local terminal, the YAML editor, port-forward, custom resources, Helm releases, ⌘K search (wave 4); your actions (wave 8: scale, restart, delete, trigger, suspend, the object menu, Recent actions) |
| [specs/008-hands/spec.md](specs/008-hands/spec.md) and [tasks.md](specs/008-hands/tasks.md) | Wave 8, Hands: the spec (D140–D172) and where each part stands |
| [specs/009-google-view/spec.md](specs/009-google-view/spec.md) and [tasks.md](specs/009-google-view/tasks.md) | Wave 9, Google's view of this cluster: the spec (D173–D201) and where each part stands |
| [doctor.md](doctor.md) | The cluster doctor (wave 5): the rules, grouping by owner, Landlens's first suggestion, certificates, the broken scenarios |
| [connections.md](connections.md) | GitHub and Linear (wave 6): Landlens's own sign-in (the device flow, Linear's browser sign-in, pasted tokens), what is stored, where a token may go, the OAuth App to register; the Connections page and their tools in Claude sessions; the autonomous mode |
| [gcp.md](gcp.md) | Google Cloud (wave 6): browsing your chosen projects' resources read-only, through gcloud's sign-in; what Google is asked and the limits, the error sentences, the page; GKE clusters in the catalog; Claude's read-only tools (`landlens-gcp`) and Ask Claude on a resource; the development overrides and the fakes |
| [family.md](family.md) | The Land family (wave 7): Landlens's own sign-in to Clickland, Landflow (a pasted key) and Landfall (its connector's OAuth, read only); the address rule, what is stored, the Connections page's Land family cards and the triage webhook; their MCP servers in Claude sessions (which tools read, the pin and Review, the data lines); Landflow on a resource; Landlens's own telemetry (off by default, what is sent) and a session's summary to the brain; the fakes |
| [metrics.md](metrics.md) | Metrics, logs and traces from Clickland. Graphs: Clickland, then the cluster's Prometheus, then metrics-server, else a reason; setup and the key; what each chart shows; Clickland's log lines (the Logs tab's History), traces and Open in Clickland |
| [design.md](design.md) | Iris, the look: direction, tokens, layout and width rules, screens, components, what the tests rely on |
| [security.md](security.md) | Every security rule and how it is checked |
| [development.md](development.md) | Setup, running, every test command |
| [limitations.md](limitations.md) and [roadmap.md](roadmap.md) | What's missing, and the waves |
| [research.md](research.md) | The findings in one page, and the decisions they lead to |
| [research/lens-architecture.md](research/lens-architecture.md) | OpenLens and Freelens inside: processes, DI, cluster auth and the proxy, the Kubernetes data layer, security, size |
| [research/lens-features.md](research/lens-features.md) | Every OpenLens feature: what the user sees, how it works, what Landlens takes |
| [research/acp.md](research/acp.md) | The Agent Client Protocol, the TypeScript SDK, claude-agent-acp, and how Landlens gives the agent a cluster safely |
| [research/land-family.md](research/land-family.md) | How Landlens meets Clickland, Landfall, the cluster agent, Landbright and Landflow |
| [plan.md](plan.md) | The proposed architecture and waves |
| [history.md](history.md) | Every change, in order |
| [../study/README.md](../study/README.md) | The evidence: Craft Anything captures and source graphs |
