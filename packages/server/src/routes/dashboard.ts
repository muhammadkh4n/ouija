/**
 * Dashboard static serving.
 *
 * Serves the compiled `@ouija-dev/dashboard` SPA at /dashboard/* so operators
 * can reach it at http://localhost:4000/dashboard without running a separate
 * Vite dev server.
 *
 * Asset resolution:
 *   1. Prefer the built output in the dashboard workspace (`packages/dashboard/dist`)
 *      resolved via `import.meta.resolve` so this works from both the monorepo
 *      and a published npm install.
 *   2. Fallback to `process.env.OUIJA_DASHBOARD_DIR` for custom deployments.
 *   3. If neither is present, register a minimal placeholder route that tells
 *      the operator how to build the dashboard. This keeps the server usable
 *      even when dashboard assets haven't been built yet.
 *
 * SPA routing:
 *   React Router uses history-mode routing (e.g. /dashboard/pipelines/abc).
 *   A catch-all handler serves index.html so client-side routes don't 404.
 */

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveDashboardDir(): string | null {
  // 1. Env var override (ops use).
  const envDir = process.env['OUIJA_DASHBOARD_DIR'];
  if (envDir !== undefined && existsSync(join(envDir, 'index.html'))) {
    return envDir;
  }

  // 2. Walk up from this file to find the dashboard workspace dist dir.
  //    In the monorepo: .../packages/server/dist/routes → ../../../dashboard/dist
  //    In a published install: same shape under node_modules.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const candidates = [
    resolve(__dirname, '..', '..', '..', 'dashboard', 'dist'),      // monorepo build
    resolve(__dirname, '..', '..', 'dashboard', 'dist'),             // relative alt
    resolve(__dirname, '..', '..', '..', '@ouija-dev', 'dashboard', 'dist'), // node_modules install
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate;
    }
  }

  return null;
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  const dashboardDir = resolveDashboardDir();

  if (dashboardDir === null) {
    // Placeholder — tells the operator how to fix it.
    app.get('/dashboard', async (_req, reply) => {
      reply.type('text/html').send(
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Ouija dashboard — not built</title></head><body style="background:#0f1720;color:#e6edf3;font-family:monospace;padding:3rem;line-height:1.6"><h1 style="color:#2ec4b6">Dashboard not built</h1><p>The dashboard SPA is registered but no built assets were found.</p><p>To enable it:</p><pre style="background:#111;padding:1rem;border-radius:6px">npm run build --workspace=@ouija-dev/dashboard</pre><p>Or set <code>OUIJA_DASHBOARD_DIR</code> to a pre-built dashboard directory.</p></body></html>`,
      );
    });
    app.log.info('Dashboard assets not found — served placeholder at /dashboard');
    return;
  }

  await app.register(fastifyStatic, {
    root: dashboardDir,
    prefix: '/dashboard/',
    // decorateReply: true (default) adds reply.sendFile() which we use below.
    cacheControl: true,
    maxAge: '1h',
  });

  // Redirect /dashboard (no trailing slash) so the SPA base path works.
  app.get('/dashboard', async (_req, reply) => reply.redirect('/dashboard/', 301));

  // SPA fallback: any /dashboard/* path that isn't a real asset serves
  // index.html so React Router can take over client-side routing.
  //
  // We refuse to serve index.html for paths that look like asset requests
  // (under /dashboard/assets/ or ending in a known static extension).
  // Browsers choke on text/html being returned for a <script> or <link>
  // tag, so a broken asset must 404 normally instead of silently
  // returning HTML.
  const ASSET_EXTENSIONS = /\.(js|css|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|json)$/;

  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url;
    if (!url.startsWith('/dashboard')) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Route ${url} not found.` },
      });
    }
    const isAssetRequest =
      url.startsWith('/dashboard/assets/') || ASSET_EXTENSIONS.test(url);
    if (isAssetRequest) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Asset ${url} not found.` },
      });
    }
    return reply.sendFile('index.html');
  });

  app.log.info(`Dashboard served from ${dashboardDir} at /dashboard`);
}
