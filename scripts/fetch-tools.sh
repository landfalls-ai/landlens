#!/usr/bin/env bash
# Download the Craft Anything CLI (signed, notarized macOS build) and check its checksum and signature.
set -euo pipefail
VER=${CRAFT_ANYTHING_VERSION:-0.6.1}
cd "$(dirname "$0")/../tools/craft-anything"
zip="craft-anything-cli-$VER-macos-universal.zip"
gh release download "v$VER" -R storytold/craft-anything -p "$zip" -p SHA256SUMS.txt --clobber
grep " $zip\$" SHA256SUMS.txt | shasum -a 256 -c -
ditto -x -k "$zip" .
cli="craft-anything-cli-$VER-macos-universal/craft-anything-cli"
codesign --verify --strict "$cli"
"$cli" --version
