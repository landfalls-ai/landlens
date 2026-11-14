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
- **Views are lists and details.** No logs, terminals, port-forward, YAML editing, metrics or Helm yet (wave 4).
  Kinds without their own columns get name, namespace and age; CRDs don't use printer columns yet (wave 4).
- **One cluster at a time** in the window. Connecting to another disconnects the first.
- **Development build only.** No packaged app yet, so the hardened fuses are verified on a clone, not shipped (wave 7).
- **Upgraded connections** (exec, attach, port-forward) pass through the front door and the sidecar but have no UI and
  no live test yet (wave 4).
- **The audit trail** of front-door decisions is kept in memory and not shown. The dock shows each agent tool call
  and what it returned, but not the front door's own log of the requests behind them (wave 3).
- **Secret material outside Secrets** (tokens in CRD specs, passwords in ConfigMaps) shows in the IDE as the
  cluster returns it. Only what the agent reads is scrubbed.
- **A same-user process** can read your kubeconfig and could debug Landlens; Landlens narrows what borrowing its
  connections allows but doesn't defend against a compromised user account ([security.md](security.md)).
- **Integrated terminals** (wave 4) will put a front-door token in the shell's environment, readable by anything that
  shell runs; each terminal gets its own revocable token for that reason.
