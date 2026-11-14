# Landlens

The land family's Kubernetes IDE, designed from a reverse-engineering study of
[OpenLens](https://github.com/lensapp/lens) and [Freelens](https://github.com/freelensapp/freelens), done with
[Craft Anything](https://github.com/storytold/craft-anything). Its headline feature: Landlens is an
[ACP](https://agentclientprotocol.com) client, so your own Claude Code runs inside the IDE, sees the cluster you are
looking at, and helps you debug it and suggests what to do.

Status: **study done, plan proposed.** Start at [docs/research.md](docs/research.md), then [docs/plan.md](docs/plan.md).

```bash
scripts/fetch-upstream.sh       # OpenLens, Freelens, ACP spec, ACP TypeScript SDK, claude-agent-acp into upstream/ (pinned)
scripts/fetch-tools.sh          # the Craft Anything CLI, checksum and signature checked
scripts/study-freelens-app.sh   # static Craft Anything study of the released Freelens app into study/freelens-app/
scripts/study-source-graph.sh   # Craft Anything source graphs into study/source-graph/ (git-ignored)
```

Landlens is not affiliated with Mirantis, Lens or Freelens.
