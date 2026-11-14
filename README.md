# Landlens

The land family's Kubernetes IDE, designed from a reverse-engineering study of
[OpenLens](https://github.com/lensapp/lens) and [Freelens](https://github.com/freelensapp/freelens), done with
[Craft Anything](https://github.com/storytold/craft-anything). Its headline feature: Landlens is an
[ACP](https://agentclientprotocol.com) client, so your own Claude Code runs inside the IDE, sees the cluster you are
looking at, and helps you debug it and suggests what to do.

Status: **waves 1 (the shell) and 2 (the agent) done; wave 3 (agent writes behind your approval) next.** Connect to
a cluster from your kubeconfig, browse live workloads, network, config, storage, access and cluster objects, and ask
Claude Code about any of it: it reads the cluster through Landlens, read-only, and shows what it read
([docs/agent.md](docs/agent.md)). Start at [docs/research.md](docs/research.md), then [docs/plan.md](docs/plan.md).

```bash
pnpm install && pnpm dev        # run Landlens (needs Go for the credential sidecar)

scripts/fetch-upstream.sh       # OpenLens, Freelens, ACP spec, ACP TypeScript SDK, claude-agent-acp into upstream/ (pinned)
scripts/fetch-tools.sh          # the Craft Anything CLI, checksum and signature checked
scripts/study-freelens-app.sh   # static Craft Anything study of the released Freelens app into study/freelens-app/
scripts/study-source-graph.sh   # Craft Anything source graphs into study/source-graph/ (git-ignored)
```

Landlens is not affiliated with Mirantis, Lens or Freelens.
