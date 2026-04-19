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

# Capture stderr so we can inspect it when npm exits non-zero.
stderr_file="$(mktemp)"
trap 'rm -f "$stderr_file"' EXIT

if npm publish --workspace="$WORKSPACE" --provenance 2> >(tee "$stderr_file" >&2); then
  echo "::notice::published $PKG_NAME@$PKG_VERSION"
  echo "::endgroup::"
  exit 0
fi

status=$?

# Tolerate "version already published" only.
if grep -qE "cannot publish over the previously published versions|You cannot publish over the previously published version|code E403.*previous version|code EPUBLISHCONFLICT" "$stderr_file"; then
  echo "::notice::$PKG_NAME@$PKG_VERSION already published — skipping"
  echo "::endgroup::"
  exit 0
fi

echo "::error::$PKG_NAME@$PKG_VERSION publish failed (exit $status)"
echo "::endgroup::"
exit "$status"
