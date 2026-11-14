# Limitations

What Landlens can't do yet, and why. Each item names the wave that lifts it ([plan.md](plan.md)).

- **The agent only reads.** It proposes changes as commands or YAML; you apply them. Writes behind your approval,
  with a diff and a server-side dry run, are wave 3. So are session history and resume, Claude's slash commands in the
  dock, and other ACP agents.
- **The agent runs without your Claude Code setup.** It uses your login, but none of your settings, CLAUDE.md, skills,
  plugins, hooks or MCP servers: they would run outside the sandbox, beside a session that can read your cluster. It
  has no web tools and no edits. Your Claude Code routed to Bedrock or Vertex won't start, because Landlens doesn't
  hand on cloud credentials. A way to bring in chosen skills is wave 3.
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
- **Views are lists and details.** No logs, terminals, port-forward, YAML editing or Helm yet (wave 4). Graphs are
  built ([metrics.md](metrics.md)).
  Kinds without their own columns get name, namespace and age; CRDs don't use printer columns yet (wave 4).
- **Jump to (⌘K) is small**: kinds, and objects in the list already loaded. Clusters, actions and a search across
  every kind come with wave 4's command palette.
- **The Logs tab is a placeholder**: shown disabled on the drawer until wave 4 builds it. For the same reason a failing pod's diagnosis shows its last output line only when the container left a termination message
  (`terminationMessagePolicy: FallbackToLogsOnError`); otherwise that line waits for the logs call.
- **The Overview polls** `cluster:health` every 10s while the window is visible, rather than following the watches.
- **The welcome page doesn't show your kubeconfig's path**, only how many contexts it has (`catalog:list` doesn't
  carry the path).
- **One cluster at a time** in the window. Connecting to another disconnects the first.
- **Development build only.** No packaged app yet, so the hardened fuses are verified on a clone, not shipped (wave 7).
- **Upgraded connections** (exec, attach, port-forward) pass through the front door and the sidecar but have no UI and
  no live test yet (wave 4).
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
- **Integrated terminals** (wave 4) will put a front-door token in the shell's environment, readable by anything that
  shell runs; each terminal gets its own revocable token for that reason.
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
