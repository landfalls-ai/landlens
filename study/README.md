# Study: what Craft Anything recorded

Evidence behind `docs/research/`. Every file here was written by a tool, not by hand.

| Path | What | How it was made |
|---|---|---|
| `freelens-app/electron-fuses.json` | The Electron fuse wire of the released Freelens 2.0.0 (macOS arm64) | Craft Anything `js_electron_fuses_show`, Deep mode, nothing run |
| `freelens-app/asar-inventory.json` | `app.asar` by file kind (15,932 entries) | `core_archive_show` |
| `freelens-app/app-map-*.json` | The Electron app graph: windows and their `webPreferences`, IPC channels, routes (120), native modules, bundlers, effects, endpoints, vendors (362) | `js_app_map`, browsed with `core_evidence_browse` |
| `source-graph-summary.md` | File counts per package, and OpenLens core vs Freelens core by area | `app_source_import` |
| `source-graph/` (git-ignored) | Source graphs of OpenLens and Freelens core, kube-object, technical-features, the ACP TypeScript SDK and claude-agent-acp | `scripts/study-source-graph.sh` |
| `acp-handshake/` | A raw ACP JSON-RPC transcript between a minimal client and claude-agent-acp (if present) | the ACP research probe, see `docs/research/acp.md` |

Re-create with `scripts/study-freelens-app.sh` (downloads the release, checks its sha256, mounts it read-only) and
`scripts/study-source-graph.sh`. The Freelens app was never started.
