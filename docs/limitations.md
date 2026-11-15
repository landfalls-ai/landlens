# Limitations

What Landlens can't do yet, and why. Each item names the wave that lifts it ([plan.md](plan.md)).

- **The agent changes the cluster only through its six write tools**, each behind your approval: `patch`, `scale`,
  `rollout_restart`, `rollout_undo`, `apply_manifest` (server-side apply only, up to 10 documents) and `delete` (one
  object). No exec, no port-forward, no Helm, never Secrets, and nothing that carries a value it saw redacted, so a
  change to an env value it can't see has to be yours. Its own kubectl stays read-only.
- **Changes aren't kept.** A resumed session shows a write tool call as its row and result, not as a change card, and
  a change waiting when Landlens quits is gone (nothing was applied). The audit trail and History's count of applied
  changes stay.
- **The approval card is the renderer's.** A compromised renderer could approve a change it was shown; the renderer
  is sandboxed with a strict CSP, and main takes an approval only for a change it is holding. A native confirmation
  for danger changes is not built.
- **Dry runs trust the API server.** An aggregated API server that ignored `dryRun` would apply at the dry run. The
  agent's commands in the "/" menu are Claude Code's own (with no settings loaded, its built-ins), sent as messages.
- **Claude Code is the only agent.** Its sandbox fences only Claude Code; another ACP agent (Codex, Gemini CLI) would
  need Landlens's own sandbox for its process, with network to its model provider, so cluster data could leave by a
  path Landlens doesn't control. Deferred until that sandbox exists.
- **The agent runs without most of your Claude Code setup.** It uses your login and the skills you turn on (copied
  into its folder; none with links, over 500 files or over 5 MB), but none of your settings, CLAUDE.md, plugins,
  hooks or MCP servers: they would run outside the sandbox, beside a session that can read your cluster. It has no
  web tools and no edits. Your Claude Code routed to Bedrock or Vertex won't start, because Landlens doesn't hand on
  cloud credentials.
- **The agent has no internet**, in its shell or otherwise: the sandbox sends both proxies to the front door, which
  refuses them, and Claude's web tools are off.
- **The agent's reads are scrubbed and capped**: env values, `last-applied-configuration` and credential-shaped text
  show as `<redacted>`, strings over 4 KB are cut, and a response over 64 MB is refused ("narrow the request"). The
  front door refuses agent requests it can't read (protobuf, compressed), so `kubectl` uses JSON. Scrubbing matches
  patterns; an unusual secret format can still get through.
- **The agent's shell sees Claude Code's own session variables** (its messaging socket and token, its session id).
  Those are Claude Code's, not Landlens's; nothing of Landlens's environment reaches it.
- **One agent session per dock, one dock per window.** Closing the dock ends the session.
- **macOS only for the fence**: it relies on Claude Code's Seatbelt sandbox. On Linux it would need bubblewrap; the
  session fails rather than run unsandboxed (`failIfUnavailable`).
- **No `explain` tool yet** (OpenAPI schemas); the agent can run `kubectl explain` instead.
- **No port-forward or Helm yet** (wave 4, parts 3–4). Logs, terminals and the YAML editor are built
  ([workbench.md](workbench.md)), and graphs ([metrics.md](metrics.md)).
  Kinds without their own columns get name, namespace and age; CRDs don't use printer columns yet (wave 4).
- **Jump to (⌘K) is small**: kinds, and objects in the list already loaded. Clusters, actions and a search across
  every kind come with wave 4's command palette.
- **A failing pod's diagnosis** shows its last output line only when the container left a termination message
  (`terminationMessagePolicy: FallbackToLogsOnError`); otherwise open its Logs tab (Previous).
- **The Overview polls** `cluster:health` every 10s while the window is visible, rather than following the watches.
- **The welcome page doesn't show your kubeconfig's path**, only how many contexts it has (`catalog:list` doesn't
  carry the path).
- **One cluster at a time** in the window. Connecting to another disconnects the first.
- **Development build only.** No packaged app yet, so the hardened fuses are verified on a clone, not shipped (wave 7).
- **Port-forward and attach** pass through the front door and the sidecar but have no UI or live test yet (wave 4,
  part 3). Exec has both ([workbench.md](workbench.md)).
- **The audit trail** is shown only through MCP calls: the MCP page's call log shows each `landlens-kube` call's
  front-door requests ([mcp.md](mcp.md)), but the agent's own kubectl requests and the IDE's are still kept in
  memory and not shown, and nothing is kept across restarts (the call log holds the last 500 calls).
- **MCP servers** are remote and streamable HTTP only: no stdio servers, no OAuth (a header you paste), and a session
  gets the servers on for its cluster, with their tool lists, when it starts. MCP App views can't write to the
  conversation (`ui/message`), change the model's context, read resources or go fullscreen; they run without Geist
  (fonts only from `data:`), and a view that tries to navigate is left blank.
- **A remote server's tools ask every time** unless you turn on its auto-run switch, and that switch trusts the
  server's own `readOnlyHint` for the listing you tested: it can't tell a tool that changes behaviour without
  changing its listing. Its tool descriptions and results reach the model verbatim ([security.md](security.md)). If a
  server's listing changes, auto-run turns off and you Test and turn it on again; there is no diff of what changed.
- **Folded views reopen from scratch**: an earlier view in the dock is closed when it folds and opened again (from
  the kept result, the last 50) when you show it, so its own state (a filter, a scroll) is lost.
- **Views get only a few of the app's keys** (Escape, ⌘/Ctrl with K, J, B or a digit); other shortcuts stay in the
  view while it has focus.
- **Secret material outside Secrets** (tokens in CRD specs, passwords in ConfigMaps) shows in the IDE as the
  cluster returns it. Only what the agent reads is scrubbed.
- **A same-user process** can read your kubeconfig and could debug Landlens; Landlens narrows what borrowing its
  connections allows but doesn't defend against a compromised user account ([security.md](security.md)).
- **A local terminal's token is in its shell's environment** (`LANDLENS_TOKEN`), readable by anything that shell
  runs, and it is full access to that cluster as you, until the terminal ends. Each terminal gets its own, revoked
  when it closes ([security.md](security.md#terminals)). A startup file that sets `KUBECONFIG` wins over Landlens's.
- **Logs and terminals** ([workbench.md](workbench.md)): the drawer and a panel tab each open their own stream (the
  design shares one, counted in main); Download saves what is shown, not the whole log from the API; the view draws
  the last 2,000 lines of the 10,000 it keeps, without virtual scrolling; a workload follows its newest ten pods and
  doesn't add pods that start later until you reopen it; pod colours run out after four (the rest share one).
  Shells: no debug containers for images without a shell; paste into a pod asks only for more than one line; the
  shell picker offers a workload's pods, but the palette entry (⌘K "shell …") comes with part 4; "Open shell in the new
  pod" matches pods by labels, so it can offer a pod of a different rollout. Input typed while a new session starts
  is dropped. The panel's height is kept for the window, not across restarts.
- **The YAML editor** ([workbench.md](workbench.md#the-yaml-editor)) sends a JSON merge patch of what you changed,
  pinned to the version you started from, not a server-side apply: Landlens (field manager `landlens`) owns just the
  fields it changed, but a field another manager owns is only warned about, so the design's **Take over** (a forced
  apply) and **Review without line 7** aren't built. A merge patch replaces a list whole, so changing one container
  sends every container. Where you and someone else both changed a field while you edited, yours is kept (the banner
  names it) rather than waiting for you. Secrets can't be edited or created. Create sends its documents in order: if
  one fails at Apply, the ones before it stay created (the error says which). There is no "Show change" on the
  Applied row, no flash of the row, and the create sheet isn't in the palette yet (part 4). Templates are fixed.
- **Graphs are CPU and memory only**, for the cluster, nodes, pods and Deployments, StatefulSets and DaemonSets: no
  network, disk, GPU, or Prometheus. Namespaces are a Top namespaces list, not a chart of their own.
- **History needs Clickland** with metric filters (Clickland `specs/001-metrics-filters`); an older Clickland is
  refused. Without it, metrics-server gives live samples from when a view first asks, at most an hour, and only while
  Landlens is open. OrbStack ships no metrics-server, so there it is Clickland or nothing.
- **Requests and limits are drawn at their latest value**, not as they changed over the range (a rollout that changed
  them shows the new values across the whole chart).
- **Clickland keeps the ten largest series per query** and sums the rest as "other": a workload with more than ten
  pods, or a cluster with more than ten nodes, shows the tail summed; the charts fold past four series anyway.
- **One Clickland for all clusters**, with a cluster name per context. Landlens doesn't yet send its own telemetry to
  Clickland (wave 6).
