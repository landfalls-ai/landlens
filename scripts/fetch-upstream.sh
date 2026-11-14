#!/usr/bin/env bash
# Fetch the open-source projects Landlens studies into upstream/ (git-ignored).
# Pin to the commits the research was written against; pass --latest to take each default branch.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p upstream
OPENLENS_COMMIT=f1a960fd785b62a118acd8b1525d879f39917e21     # 2023-08-09, lensapp/lens master: the last open-source OpenLens (MIT)
FREELENS_COMMIT=2547f555b8286f515f443d6f29580597093365ae     # 2026-11-13, freelensapp/freelens main: the maintained OpenLens fork (MIT)
ACP_COMMIT=13b765828f961812f0c78ae577220e994209fa2f                                           # agentclientprotocol/agent-client-protocol: the ACP spec and schema (Apache-2.0)
ACP_TS_COMMIT=b93e77b1de8f6a94475215b3f4d57c30ecaa42f5                                           # agentclientprotocol/typescript-sdk: @agentclientprotocol/sdk (Apache-2.0)
CLAUDE_ACP_COMMIT=7e857d59ec777356969ab615af83eef02ac43e59                                       # agentclientprotocol/claude-agent-acp: Claude Code as an ACP agent (Apache-2.0)
fetch() { # dir url commit
  if [ ! -d "upstream/$1/.git" ]; then
    git init -q "upstream/$1" && git -C "upstream/$1" remote add origin "$2"
  fi
  if [ "${LATEST:-}" = 1 ]; then git -C "upstream/$1" fetch -q --depth 1 --filter=blob:limit=5m origin HEAD
  else git -C "upstream/$1" fetch -q --depth 1 --filter=blob:limit=5m origin "$3"; fi
  git -C "upstream/$1" checkout -q FETCH_HEAD
  echo "$1 at $(git -C "upstream/$1" rev-parse HEAD)"
}
[ "${1:-}" = --latest ] && LATEST=1
fetch openlens https://github.com/lensapp/lens.git "$OPENLENS_COMMIT"
fetch freelens https://github.com/freelensapp/freelens.git "$FREELENS_COMMIT"
fetch acp-spec https://github.com/agentclientprotocol/agent-client-protocol.git "$ACP_COMMIT"
fetch acp-typescript-sdk https://github.com/agentclientprotocol/typescript-sdk.git "$ACP_TS_COMMIT"
fetch claude-agent-acp https://github.com/agentclientprotocol/claude-agent-acp.git "$CLAUDE_ACP_COMMIT"
