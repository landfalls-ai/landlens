# History

Every change, in order, with the decisions along the way.

| Date | Change | Notes |
|---|---|---|
| 2026-11-14 | The study: project skeleton; OpenLens (`f1a960f`, its last open-source commit), Freelens (`2547f55`), the ACP spec (`13b7658`), the ACP TypeScript SDK (`b93e77b`) and claude-agent-acp (`7e857d5`) pinned in `scripts/fetch-upstream.sh`; Craft Anything 0.6.1 fetched and verified; the released Freelens 2.0.0 studied statically (fuses, asar inventory, app graph) and source graphs built; a live ACP handshake with Claude Code; four research reports, `research.md`; `plan.md` proposed | The user asked for an OpenLens-like IDE whose headline is an ACP client that runs their own Claude Code against the cluster they are looking at. Decisions proposed: Electron, a Go credential sidecar behind a token front door with a read-only policy for the agent, Landlens-owned approval for every write. Found: OpenLens's local proxy had no auth (Freelens added a token); both forks run the renderer with Node integration and no context isolation; Claude Code via ACP never uses client terminals and never asks in auto mode |
