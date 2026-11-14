# Limitations

What Landlens can't do yet, and why. Each item names the wave that lifts it ([plan.md](plan.md)).

- **No agent yet.** The ACP host, the agent dock and the cluster MCP server are wave 2; agent writes are wave 3.
- **Views are lists and details.** No logs, terminals, port-forward, YAML editing, metrics or Helm yet (wave 4).
  Kinds without their own columns get name, namespace and age; CRDs don't use printer columns yet (wave 4).
- **One cluster at a time** in the window. Connecting to another disconnects the first.
- **Development build only.** No packaged app yet, so the hardened fuses are verified on a clone, not shipped (wave 7).
- **Upgraded connections** (exec, attach, port-forward) pass through the front door and the sidecar but have no UI and
  no live test yet (wave 4).
- **The audit trail** of front-door decisions is kept in memory and not shown yet (wave 2 shows the agent's).
- **Namespace-limited tokens** refuse all-namespace reads only for the common built-in kinds; a namespaced custom
  resource listed across all namespaces is not refused by Landlens (the cluster's RBAC still applies). Wave 2 passes
  discovery's scope to the policy.
