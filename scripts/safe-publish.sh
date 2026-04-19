#!/usr/bin/env bash
# safe-publish.sh — publish a workspace to npm, tolerating only the "version
# already published" case. Every other failure is surfaced.
#
# Usage:
#   ./scripts/safe-publish.sh packages/types
#
# Exit codes:
#   0 — published successfully, OR the exact version was already on npm
#   non-zero — real failure (auth, network, test, bad manifest, etc.)
#
# Environment:
#   NODE_AUTH_TOKEN — npm token (required for private registries and for 2FA/OTP)

set -euo pipefail

WORKSPACE="${1:?workspace path required, e.g. packages/types}"

PKG_NAME=$(node -e "console.log(require('./$WORKSPACE/package.json').name)")
PKG_VERSION=$(node -e "console.log(require('./$WORKSPACE/package.json').version)")
IS_PRIVATE=$(node -e "const p = require('./$WORKSPACE/package.json'); console.log(p.private === true ? 'true' : 'false')")

if [ "$IS_PRIVATE" = "true" ]; then
  echo "::notice::skipping $PKG_NAME@$PKG_VERSION (private: true)"
  exit 0
fi

echo "::group::publish $PKG_NAME@$PKG_VERSION"

# Capture stderr to a file and check npm's exit code explicitly. The previous
# approach used `if npm publish ... 2> >(tee ...)` which silently swallowed
# failures: the if-statement captures the exit of the pipeline including the
# `tee` in the process substitution, which always exits 0. Both v0.2.0 and
# v0.3.0 ghost-published (all 15 packages 404'd with auth errors) because the
# real npm exit code never reached the caller. Never use process-substitution
# inside an `if` when you need the left-hand exit code.
stderr_file="$(mktemp)"
trap 'rm -f "$stderr_file"' EXIT

set +e
npm publish --workspace="$WORKSPACE" --provenance 2> "$stderr_file"
status=$?
set -e

# Always surface npm's own stderr to the workflow log — callers want to see
# the full npm output on both success and failure.
cat "$stderr_file" >&2

if [ "$status" -eq 0 ]; then
  echo "::notice::published $PKG_NAME@$PKG_VERSION"
  echo "::endgroup::"
  exit 0
fi

# Tolerate "version already published" only.
if grep -qE "cannot publish over the previously published versions|You cannot publish over the previously published version|code E403.*previous version|code EPUBLISHCONFLICT" "$stderr_file"; then
  echo "::notice::$PKG_NAME@$PKG_VERSION already published — skipping"
  echo "::endgroup::"
  exit 0
fi

echo "::error::$PKG_NAME@$PKG_VERSION publish failed (exit $status)"
echo "::endgroup::"
exit "$status"
