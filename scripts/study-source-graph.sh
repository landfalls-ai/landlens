#!/usr/bin/env bash
# Build Craft Anything source graphs (every file with its sha256 and language; for TypeScript its exports, imports and
# functions) into study/source-graph/ (git-ignored: they copy string literals out of upstream).
set -euo pipefail
cd "$(dirname "$0")/.."
CLI=$(ls -d tools/craft-anything/craft-anything-cli-*/craft-anything-cli | tail -1)
mkdir -p study/source-graph
for p in openlens/packages/core openlens/packages/kube-object openlens/packages/technical-features \
         freelens/packages/core freelens/packages/kube-object acp-typescript-sdk claude-agent-acp; do
  out="study/source-graph/$(echo "$p" | tr / -).json"
  "$CLI" --deep app-source-import --path "$PWD/upstream/$p" --respect-gitignore true > "$out"
  echo "$out $(du -h "$out" | cut -f1)"
done
