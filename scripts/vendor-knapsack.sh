#!/bin/sh
# Sync the vendored @connectotron/knapsack from the pinned tag.
#
# The library is a private org repo; bun's github:/git+https dependency
# forms normalize to the credential-less tarball API (404 on private
# repos), and CI's GITHUB_TOKEN is repo-scoped (cannot read siblings).
# Until P2 (publishing, owner-gated), the pinned tag is vendored.
#
# Usage:  sh scripts/vendor-knapsack.sh <tag>     # e.g. v0.1.1
# Requires the knapsack repo cloned at ../knapsack with the tag fetched.

set -e
TAG="${1:?usage: vendor-knapsack.sh <tag> (e.g. v0.1.1)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../knapsack"

if [ ! -d "$SRC/.git" ]; then
  echo "error: $SRC is not a git clone of Connectotron/knapsack" >&2
  exit 1
fi

cd "$SRC"
git fetch origin --tags --quiet
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: tag $TAG not found in $SRC" >&2
  exit 1
fi

cd "$ROOT"
rm -rf vendor
mkdir -p vendor/knapsack
git -C "$SRC" archive "$TAG" | tar -x -C vendor/knapsack

# Update package.json pin + reinstall.
bun remove @connectotron/knapsack >/dev/null 2>&1 || true
bun add "file:vendor/knapsack" >/dev/null

echo "vendored $TAG -> vendor/knapsack ($(git -C "$SRC" rev-parse "$TAG" | head -c 7))"
echo "package.json now pins file:vendor/knapsack"
