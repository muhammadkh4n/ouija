# ---- Stage 1: Build ----
# Install all dependencies and compile TypeScript via Turborepo.
FROM node:22-alpine AS build

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
FROM node:22-alpine AS production

WORKDIR /app

# Base tooling the agent subprocess needs at runtime:
#   - git + openssh-client: LocalWorkspaceProvider clones the target repo,
#     over HTTPS or SSH depending on the repo URL.
#   - ca-certificates: HTTPS to github.com / anthropic.com.
#   - github-cli: the agent prompt tells Claude to `gh pr create`, so the
#     binary must be present. GH_TOKEN is injected by plugin-agent-claude.
# Kept before the global npm install so the layer cache stays warm across
# source-only rebuilds.
RUN apk add --no-cache git openssh-client ca-certificates github-cli

# Bundle the Claude Code CLI globally so self-hosters don't have to install
# it separately on the host or mount a binary in. The LocalAgentRunner and
# StreamJsonAgentRunner spawn `claude` at dispatch time; we resolve it
# through $PATH inside the container.
#
# Subscription auth: the CLI reads credentials from $HOME/.claude/ — self-
# hosters who want flat-rate Pro/Max billing must bind-mount their host
# ~/.claude into the container (see docker-compose.yml). API-billed self-
# hosters set ANTHROPIC_API_KEY via .env and don't need the mount.
# shellcheck disable=SC2094
RUN npm install -g @anthropic-ai/claude-code \
 && claude --version

# Use the existing node user (uid 1000) that ships with the node:alpine image.
# This avoids UID conflicts and matches the compose user: "1000:1000" mapping.

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

# Healthcheck — lightweight ping against the /health endpoint.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1

CMD ["node", "packages/server/dist/index.js"]
