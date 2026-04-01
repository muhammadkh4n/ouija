#!/bin/bash
# infra/setup.sh — First-time Ouija setup.
#
# Generates cryptographic secrets and populates .env from .env.example.
# Safe to re-run: exits early if .env already exists.
#
# Usage:
#   bash infra/setup.sh
#
# Requires: openssl (available on macOS, Linux, and WSL2 by default)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "ERROR: $ENV_EXAMPLE not found. Are you running from the repo root?" >&2
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  echo ".env already exists at $ENV_FILE — skipping. Delete it and re-run to regenerate."
  exit 0
fi

# Generate secrets.
OUIJA_SECRET_KEY=$(openssl rand -hex 32)
PLANE_SECRET_KEY=$(openssl rand -hex 32)
PLANE_WEBHOOK_SECRET=$(openssl rand -hex 16)

# Copy template then substitute placeholders.
cp "$ENV_EXAMPLE" "$ENV_FILE"

# macOS sed requires an explicit backup extension with -i; use '' for in-place.
# Linux sed accepts -i without an argument. Detect platform.
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|OUIJA_SECRET_KEY=.*|OUIJA_SECRET_KEY=$OUIJA_SECRET_KEY|" "$ENV_FILE"
  sed -i '' "s|PLANE_SECRET_KEY=.*|PLANE_SECRET_KEY=$PLANE_SECRET_KEY|" "$ENV_FILE" 2>/dev/null || true
  sed -i '' "s|PLANE_WEBHOOK_SECRET=.*|PLANE_WEBHOOK_SECRET=$PLANE_WEBHOOK_SECRET|" "$ENV_FILE" 2>/dev/null || true
else
  sed -i "s|OUIJA_SECRET_KEY=.*|OUIJA_SECRET_KEY=$OUIJA_SECRET_KEY|" "$ENV_FILE"
  sed -i "s|PLANE_SECRET_KEY=.*|PLANE_SECRET_KEY=$PLANE_SECRET_KEY|" "$ENV_FILE" 2>/dev/null || true
  sed -i "s|PLANE_WEBHOOK_SECRET=.*|PLANE_WEBHOOK_SECRET=$PLANE_WEBHOOK_SECRET|" "$ENV_FILE" 2>/dev/null || true
fi

echo "Created $ENV_FILE with generated secrets:"
echo "  OUIJA_SECRET_KEY     = ${OUIJA_SECRET_KEY:0:8}... (truncated)"
echo "  PLANE_SECRET_KEY     = ${PLANE_SECRET_KEY:0:8}... (truncated)"
echo "  PLANE_WEBHOOK_SECRET = ${PLANE_WEBHOOK_SECRET:0:8}... (truncated)"
echo ""
echo "Next steps:"
echo "  1. Fill in PLANE_API_TOKEN, GITHUB_PAT, ANTHROPIC_API_KEY in .env"
echo "  2. docker compose -f docker/docker-compose.ouija.yml up -d   # Ouija-only"
echo "     -- OR --"
echo "     docker compose -f docker/docker-compose.yml up -d         # Full stack with Plane"
