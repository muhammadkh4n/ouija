/**
 * `ouija init` — bootstrap a new Ouija project in the current directory.
 *
 * Copies assets (docker/, infra/, .env.example, ouija.config.example.yaml),
 * generates fresh secrets, and interactively collects credentials. Safe to
 * re-run: exits early if .env already exists unless --force is passed.
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import prompts from 'prompts';
import { ASSETS_DIR, projectPath } from '../lib/paths.js';
import { generateHexSecret } from '../lib/secrets.js';
import { applyEnvUpdates, type EnvUpdates } from '../lib/env-file.js';
import { log, die } from '../lib/logger.js';

export interface InitOptions {
  force: boolean;
  nonInteractive: boolean;
}

export function parseInitArgs(argv: readonly string[]): InitOptions {
  return {
    force: argv.includes('--force') || argv.includes('-f'),
    nonInteractive: argv.includes('--non-interactive') || argv.includes('-y'),
  };
}

export async function runInit(options: InitOptions): Promise<number> {
  log.step('Initializing Ouija project');

  const envPath = projectPath('.env');
  if (existsSync(envPath) && !options.force) {
    log.warn(`.env already exists at ${envPath}`);
    log.dim('Pass --force to overwrite, or delete .env and re-run.');
    return 1;
  }

  // 1. Copy bundled assets into the project directory.
  await copyAssets();

  // 2. Generate secrets and write .env.
  const generated: EnvUpdates = {
    OUIJA_SECRET_KEY: generateHexSecret(32),
    PLANE_SECRET_KEY: generateHexSecret(32),
    PLANE_WEBHOOK_SECRET: generateHexSecret(16),
  };

  // 3. Collect credentials interactively (or use placeholders).
  const userCreds = options.nonInteractive
    ? {}
    : await collectCredentials();

  // 4. Merge generated + user credentials into .env.
  const envTemplate = await readFile(join(ASSETS_DIR, '.env.example'), 'utf8');
  const merged = applyEnvUpdates(envTemplate, { ...generated, ...userCreds });
  await writeFile(envPath, merged, 'utf8');

  // 5. Copy ouija.config.example.yaml → ouija.config.yaml (if not present).
  const configPath = projectPath('ouija.config.yaml');
  if (!existsSync(configPath) || options.force) {
    await cp(join(ASSETS_DIR, 'ouija.config.example.yaml'), configPath);
    log.success('ouija.config.yaml created (copy of example)');
  } else {
    log.dim('ouija.config.yaml already exists — leaving untouched');
  }

  log.success(`.env written to ${envPath}`);
  log.dim(
    `  OUIJA_SECRET_KEY     = ${generated['OUIJA_SECRET_KEY']?.slice(0, 8)}... (truncated)`,
  );
  log.dim(
    `  PLANE_WEBHOOK_SECRET = ${generated['PLANE_WEBHOOK_SECRET']?.slice(0, 8)}... (truncated)`,
  );

  log.step('Next steps');
  console.log('  1. Edit ouija.config.yaml — set your repo URL and prompt');
  console.log(`  2. Run ${log.code('ouija up')} to start the stack`);
  console.log(`  3. Run ${log.code('ouija doctor')} to verify your setup`);
  console.log(`  4. See ${log.code('docs/getting-started.md')} for the full walkthrough`);
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function copyAssets(): Promise<void> {
  const entries: Array<{ src: string; dest: string; mode?: number }> = [
    { src: 'docker/docker-compose.yml', dest: 'docker/docker-compose.yml' },
    { src: 'docker/docker-compose.ouija.yml', dest: 'docker/docker-compose.ouija.yml' },
    { src: 'docker/docker-compose.fizzy.yml', dest: 'docker/docker-compose.fizzy.yml' },
    { src: 'docker/Dockerfile', dest: 'docker/Dockerfile' },
    { src: 'infra/setup.sh', dest: 'infra/setup.sh', mode: 0o755 },
  ];

  for (const entry of entries) {
    const srcAbs = join(ASSETS_DIR, entry.src);
    const destAbs = projectPath(entry.dest);
    if (!existsSync(srcAbs)) {
      log.warn(`skipping missing asset: ${entry.src}`);
      continue;
    }
    await mkdir(dirname(destAbs), { recursive: true });
    if (existsSync(destAbs)) {
      log.dim(`  skip ${entry.dest} (already exists)`);
      continue;
    }
    await cp(srcAbs, destAbs);
    log.dim(`  wrote ${entry.dest}`);
  }
  log.success('Assets copied');
}

async function collectCredentials(): Promise<EnvUpdates> {
  console.log('');
  log.info('Enter credentials (leave blank to skip — fill in .env later):');
  console.log('');

  const answers = await prompts(
    [
      {
        type: 'select',
        name: 'kanban',
        message: 'Which kanban backend?',
        choices: [
          { title: 'Plane (Cloud or self-hosted)', value: 'plane' },
          { title: 'Fizzy', value: 'fizzy' },
          { title: 'Skip for now', value: 'skip' },
        ],
        initial: 0,
      },
      {
        type: (_, values) => (values['kanban'] === 'plane' ? 'text' : null),
        name: 'PLANE_BASE_URL',
        message: 'Plane base URL',
        initial: 'https://api.plane.so',
      },
      {
        type: (_, values) => (values['kanban'] === 'plane' ? 'password' : null),
        name: 'PLANE_API_TOKEN',
        message: 'Plane API token',
      },
      {
        type: (_, values) => (values['kanban'] === 'plane' ? 'text' : null),
        name: 'PLANE_WORKSPACE_SLUG',
        message: 'Plane workspace slug',
      },
      {
        type: (_, values) => (values['kanban'] === 'fizzy' ? 'text' : null),
        name: 'FIZZY_BASE_URL',
        message: 'Fizzy base URL',
      },
      {
        type: (_, values) => (values['kanban'] === 'fizzy' ? 'password' : null),
        name: 'FIZZY_ACCESS_TOKEN',
        message: 'Fizzy access token',
      },
      {
        type: 'password',
        name: 'ANTHROPIC_API_KEY',
        message: 'Anthropic API key (leave blank to use Claude CLI session auth)',
      },
      {
        type: 'password',
        name: 'GITHUB_PAT',
        message: 'GitHub personal access token (repo scope)',
      },
    ],
    {
      onCancel: () => {
        log.warn('Interrupted — partial config written');
        return false;
      },
    },
  );

  const { kanban, ...rest } = answers;
  void kanban;

  const cleaned: EnvUpdates = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'string' && value.trim() !== '') {
      cleaned[key] = value.trim();
    }
  }
  return cleaned;
}

