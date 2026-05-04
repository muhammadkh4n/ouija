#!/usr/bin/env node
// Copies runtime assets (compose files, example config, .env template) from
// the repo root into packages/cli/assets/ so they ship with the published
// npm package. Runs at build time; idempotent.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const ASSETS_DIR = join(PKG_ROOT, 'assets');

const files = [
  { src: '.env.example', dest: '.env.example' },
  { src: 'ouija.config.example.yaml', dest: 'ouija.config.example.yaml' },
  { src: 'infra/setup.sh', dest: 'infra/setup.sh' },
  // Phase 3 Task 10: docker-compose.yml (the legacy Plane-AIO bundle) is
  // no longer shipped. Self-hosters pick `--stack ouija` (BYO kanban or
  // `ouija watch`) or `--stack fizzy` (bundled 37signals Fizzy).
  { src: 'docker/docker-compose.ouija.yml', dest: 'docker/docker-compose.ouija.yml' },
  { src: 'docker/docker-compose.fizzy.yml', dest: 'docker/docker-compose.fizzy.yml' },
  { src: 'docker/Dockerfile', dest: 'docker/Dockerfile' },
];

await mkdir(ASSETS_DIR, { recursive: true });
await mkdir(join(ASSETS_DIR, 'docker'), { recursive: true });
await mkdir(join(ASSETS_DIR, 'infra'), { recursive: true });

for (const f of files) {
  const src = join(REPO_ROOT, f.src);
  const dest = join(ASSETS_DIR, f.dest);
  if (!existsSync(src)) {
    console.warn(`[copy-assets] skipping missing: ${f.src}`);
    continue;
  }
  await cp(src, dest);
  console.log(`[copy-assets] ${f.src} → assets/${f.dest}`);
}

// Write a manifest so runtime code can enumerate assets without hardcoding.
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  files: files.map((f) => f.dest),
};
await writeFile(
  join(ASSETS_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8',
);
console.log('[copy-assets] wrote manifest.json');
