# Landlens

The land family's Kubernetes IDE: a desktop app, designed by reverse-engineering OpenLens and its maintained fork
Freelens, whose headline feature is an ACP (Agent Client Protocol) client. Landlens runs the user's Claude Code as an
ACP agent, hands it the cluster the user is looking at (through a Landlens MCP server, read-only unless the user
approves a write), and shows the session inside the IDE: messages, tool calls, permission prompts, YAML diffs and
suggestions. The study and the approved plan are in `docs/`; the code is being built in waves (`docs/plan.md`).

## Read first

- `docs/README.md`: the docs index.
- `docs/research.md`: what we learned and what Landlens takes from it. The detail is in `docs/research/`
  (`lens-architecture.md`, `lens-features.md`, `acp.md`, `land-family.md`).
- `docs/plan.md`: the approved architecture and waves.
- `study/README.md`: the evidence the research cites (Craft Anything captures, source graphs, the ACP handshake).

## Layout

- `upstream/` (git-ignored): the open-source projects we study, pinned by `scripts/fetch-upstream.sh`: OpenLens
  (lensapp/lens, MIT, last open-source commit), Freelens (MIT), the ACP spec, the ACP TypeScript SDK and
  claude-agent-acp (all Apache-2.0). Read them freely; never edit them. Learn from them; don't copy their code.
- `tools/craft-anything/`: the Craft Anything CLI (`scripts/fetch-tools.sh` downloads and verifies it) and
  `mcp_session.py`, which runs several of its tools in one MCP session.
- `study/`: tool output only. `study/downloads/` (git-ignored) holds the Freelens release under study.

## Method (from the land family)

- Spec-driven, as in Landbright: a feature starts as `specs/NNN-name/` (spec, plan, tasks); the plan's claims are
  checked against the source before tasks are written.
- Research claims cite a file and line in `upstream/` or a file in `study/`; a claim from docs only is marked [docs].
- Docs move with the code: each change updates its page, `docs/limitations.md` and `docs/roadmap.md` when it adds or
  closes something, and gets a row in `docs/history.md`.
- Mobile-first artifacts: the user reviews on a phone; one column, cards not wide tables.

## Local only

- Run only on this machine. Clusters: the OrbStack Kubernetes cluster (`--context orbstack`); Landlens's own test
  workloads go in namespace `landlens-dev`. Never point Landlens or its agent at a cloud cluster during development,
  never deploy to a cloud, never push images.
- Other projects share the OrbStack cluster and Docker engine (`landflow-dev`, `clickland-dev`, …): read them, but
  write only in `landlens-dev`, and don't prune.
- AWS calls, if any, go only to LocalStack at `http://127.0.0.1:54566` with dummy keys and
  `AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null`.
- Landflow, Landbright, Landfall and Clickland are separate repositories next to this one. Read them freely; change
  them only when asked.
- Craft Anything: Deep mode only on open-source code, released open-source builds, or our own stack.
