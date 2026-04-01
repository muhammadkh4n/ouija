# ---- Stage 1: Build ----
# Install all dependencies and compile TypeScript via Turborepo.
FROM node:22-alpine AS build

WORKDIR /app

# Copy package manifests first for layer-cache efficiency.
# npm workspaces requires the root manifest + all package manifests before install.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/types/package.json       packages/types/
COPY packages/bus/package.json         packages/bus/
COPY packages/engine/package.json      packages/engine/
COPY packages/plugin-sdk/package.json  packages/plugin-sdk/
COPY packages/plugin-plane/package.json packages/plugin-plane/
COPY packages/plugin-github/package.json packages/plugin-github/
COPY packages/server/package.json      packages/server/

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
