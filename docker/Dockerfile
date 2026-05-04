# ---- Stage 1: Build ----
# Install all dependencies and compile TypeScript via Turborepo.
#
# Phase 3 Task 9: swapped from `node:22-alpine` to `node:22-bookworm-slim`.
# Build stage is matched to runtime so any node-gyp / native-binding deltas
# between musl and glibc don't surface only at runtime.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy package manifests first for layer-cache efficiency.
# npm workspaces requires the root manifest + all package manifests before install.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
# Every package manifest must be copied for `npm ci` to resolve the
# workspace. Missing entries silently break the build with cryptic tsc
# errors. Keep this list in sync with `ls packages/`.
COPY packages/agent-worker/package.json         packages/agent-worker/
COPY packages/bus/package.json                  packages/bus/
COPY packages/cli/package.json                  packages/cli/
COPY packages/config/package.json               packages/config/
COPY packages/dashboard/package.json            packages/dashboard/
COPY packages/engine/package.json               packages/engine/
COPY packages/plugin-agent-claude/package.json  packages/plugin-agent-claude/
COPY packages/plugin-engram/package.json        packages/plugin-engram/
COPY packages/plugin-fizzy/package.json         packages/plugin-fizzy/
COPY packages/plugin-github/package.json        packages/plugin-github/
COPY packages/plugin-notify-telegram/package.json packages/plugin-notify-telegram/
COPY packages/plugin-plane/package.json         packages/plugin-plane/
COPY packages/plugin-sdk/package.json           packages/plugin-sdk/
COPY packages/server/package.json               packages/server/
COPY packages/types/package.json                packages/types/
COPY packages/workspace-local/package.json      packages/workspace-local/

# Install all dependencies (including devDependencies needed for the build).
RUN npm ci

# Copy all source files.
COPY packages/ packages/

# Build every package in dependency order via Turborepo.
RUN npx turbo build

# ---- Stage 2: Production ----
# Minimal runtime image — no dev dependencies, no build tools.
#
# Phase 3 Task 9: swapped from `node:22-alpine` to `node:22-bookworm-slim`
# (glibc, real bash, real `/bin/sh`). Closes friction-log #10 — Alpine's
# busybox `sh` rejected Claude CLI's Bash tool with "No suitable shell
# found" so commit-push-PR sequences silently aborted mid-run. Image grows
# from ~150MB to ~250MB; cost we accept for shell correctness + the
# bundled `gh` CLI from cli.github.com.
FROM node:22-bookworm-slim AS production

WORKDIR /app

# Base tooling the agent subprocess needs at runtime:
#   - git + openssh-client: LocalWorkspaceProvider clones the target repo,
#     over HTTPS or SSH depending on the repo URL.
#   - ca-certificates: HTTPS to github.com / anthropic.com.
#   - gh (from cli.github.com APT repo): the agent prompt tells Claude to
#     `gh pr create`, so the binary must be present. GH_TOKEN is injected
#     by plugin-agent-claude.
#   - curl + gnupg: required to add the gh APT repo. curl stays on the
#     final image because the healthcheck below uses it (replacing the
#     Alpine wget that no longer ships).
#
# `--no-install-recommends` keeps the layer lean by skipping suggested
# packages. Trailing `apt-get clean + rm -rf /var/lib/apt/lists/*` strips
# package metadata so the layer doesn't carry ~30MB of stale lists into
# the published image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        openssh-client \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Bundle the Claude Code CLI globally so self-hosters don't have to install
# it separately on the host or mount a binary in. The LocalAgentRunner and
# StreamJsonAgentRunner spawn `claude` at dispatch time; we resolve it
# through $PATH inside the container.
#
# Subscription auth (Phase 3 Task 8): credentials no longer come from a
# `${HOME}/.claude` bind mount. The agent-worker resolves an `AuthProvider`
# (env / Keychain / credential-file / helper-command) per worker, then
# materialises a private home under `/run/ouija/claude-home/<dispatchId>/`
# per dispatch. The plugin sets HOME to that path so `claude` reads its
# config there. API-billed self-hosters set ANTHROPIC_API_KEY in `.env`
# and skip the credential-file path entirely.
RUN npm install -g @anthropic-ai/claude-code \
 && claude --version

# Force `bash` as the default shell for the runtime user. Phase 3 Task 9:
# Claude CLI's Bash tool reads $SHELL when picking which shell to spawn
# subcommands through. Setting it explicitly is the belt-and-braces fix
# alongside the bookworm-slim base — closes friction-log #10 and #11
# together.
ENV SHELL=/bin/bash

# Use the existing node user (uid 1000) that ships with node:22-bookworm-slim.
# Same UID as the previous Alpine image, so the compose `user: "1000:1000"`
# mapping keeps working without churn for self-hosters who already pulled
# v0.4.x.

# Copy only what is needed to run the server:
#   - Root package.json so Node can resolve workspace symlinks.
#   - Each package's dist/ and package.json (for module resolution).
#   - node_modules (hoisted by npm workspaces at root).
COPY --from=build --chown=node:node /app/package.json         ./
COPY --from=build --chown=node:node /app/node_modules         ./node_modules/
COPY --from=build --chown=node:node /app/packages/types/dist  ./packages/types/dist/
COPY --from=build --chown=node:node /app/packages/types/package.json ./packages/types/package.json
COPY --from=build --chown=node:node /app/packages/bus/dist    ./packages/bus/dist/
COPY --from=build --chown=node:node /app/packages/bus/package.json ./packages/bus/package.json
COPY --from=build --chown=node:node /app/packages/engine/dist ./packages/engine/dist/
COPY --from=build --chown=node:node /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build --chown=node:node /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist/
COPY --from=build --chown=node:node /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=build --chown=node:node /app/packages/plugin-plane/dist ./packages/plugin-plane/dist/
COPY --from=build --chown=node:node /app/packages/plugin-plane/package.json ./packages/plugin-plane/package.json
COPY --from=build --chown=node:node /app/packages/plugin-github/dist ./packages/plugin-github/dist/
COPY --from=build --chown=node:node /app/packages/plugin-github/package.json ./packages/plugin-github/package.json
COPY --from=build --chown=node:node /app/packages/agent-worker/dist ./packages/agent-worker/dist/
COPY --from=build --chown=node:node /app/packages/agent-worker/package.json ./packages/agent-worker/package.json
COPY --from=build --chown=node:node /app/packages/workspace-local/dist ./packages/workspace-local/dist/
COPY --from=build --chown=node:node /app/packages/workspace-local/package.json ./packages/workspace-local/package.json
COPY --from=build --chown=node:node /app/packages/plugin-agent-claude/dist ./packages/plugin-agent-claude/dist/
COPY --from=build --chown=node:node /app/packages/plugin-agent-claude/package.json ./packages/plugin-agent-claude/package.json
COPY --from=build --chown=node:node /app/packages/plugin-notify-telegram/dist ./packages/plugin-notify-telegram/dist/
COPY --from=build --chown=node:node /app/packages/plugin-notify-telegram/package.json ./packages/plugin-notify-telegram/package.json
# @ouija-dev/config is an import target of the server (validateAgentProfile,
# loadConfig, resolveRepo). Without it, the server crashes on boot with
# ERR_MODULE_NOT_FOUND from packages/server/dist/routes/agents.js.
COPY --from=build --chown=node:node /app/packages/config/dist ./packages/config/dist/
COPY --from=build --chown=node:node /app/packages/config/package.json ./packages/config/package.json
# plugin-fizzy + plugin-engram are loaded dynamically at runtime when the
# corresponding env vars are set. Missing = silent "plugin unavailable" path.
COPY --from=build --chown=node:node /app/packages/plugin-fizzy/dist ./packages/plugin-fizzy/dist/
COPY --from=build --chown=node:node /app/packages/plugin-fizzy/package.json ./packages/plugin-fizzy/package.json
COPY --from=build --chown=node:node /app/packages/plugin-engram/dist ./packages/plugin-engram/dist/
COPY --from=build --chown=node:node /app/packages/plugin-engram/package.json ./packages/plugin-engram/package.json
COPY --from=build --chown=node:node /app/packages/server/dist  ./packages/server/dist/
COPY --from=build --chown=node:node /app/packages/server/package.json ./packages/server/package.json

# Copy SQL migrations so the server can run them at startup.
COPY --from=build --chown=node:node /app/packages/engine/src/migrations ./packages/engine/src/migrations/

USER node

EXPOSE 4000

# Healthcheck — lightweight ping against /healthz.
# Phase 3 Task 9: bookworm-slim doesn't ship `wget` by default (Alpine did
# via busybox). Use `curl` instead — it's installed in the apt-get block
# above and is the conventional Debian choice.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:4000/healthz || exit 1

CMD ["node", "packages/server/dist/index.js"]
