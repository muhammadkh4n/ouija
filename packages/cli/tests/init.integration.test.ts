/**
 * Integration test for `ouija init --non-interactive`.
 *
 * Runs the compiled CLI in a temp directory and asserts it produces the
 * expected files. Requires `npm run build` to have run beforehand — the
 * workspace build orchestration handles that.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ENTRY = resolve(__dirname, '..', 'dist', 'index.js');

describe('ouija init --non-interactive', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ouija-cli-init-'));
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('is skipped when dist/ has not been built', () => {
    if (!existsSync(CLI_ENTRY)) {
      console.warn(`[init.integration] skipping — run 'npm run build' in packages/cli first`);
    }
  });

  it('creates .env, ouija.config.yaml, and docker/ files', async () => {
    if (!existsSync(CLI_ENTRY)) return;

    const result = spawnSync(process.execPath, [CLI_ENTRY, 'init', '--non-interactive'], {
      cwd: workDir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Assets copied');
    expect(result.stdout).toContain('.env written');

    // .env exists and has a 64-char OUIJA_SECRET_KEY
    const envBody = await readFile(join(workDir, '.env'), 'utf8');
    const secretMatch = envBody.match(/^OUIJA_SECRET_KEY=([0-9a-f]+)$/m);
    expect(secretMatch).not.toBeNull();
    expect(secretMatch?.[1]).toHaveLength(64);

    // ouija.config.yaml copied
    const configStat = await stat(join(workDir, 'ouija.config.yaml'));
    expect(configStat.isFile()).toBe(true);

    // docker compose files copied
    expect(existsSync(join(workDir, 'docker/docker-compose.ouija.yml'))).toBe(true);
    expect(existsSync(join(workDir, 'docker/docker-compose.yml'))).toBe(true);
    expect(existsSync(join(workDir, 'docker/Dockerfile'))).toBe(true);

    // infra/setup.sh copied
    expect(existsSync(join(workDir, 'infra/setup.sh'))).toBe(true);
  });

  it('refuses to overwrite .env without --force', async () => {
    if (!existsSync(CLI_ENTRY)) return;

    // First init already wrote .env in the previous test case.
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'init', '--non-interactive'], {
      cwd: workDir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('.env already exists');
  });
});

describe('ouija init --preset', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ouija-cli-preset-'));
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('rejects an unknown preset name', async () => {
    if (!existsSync(CLI_ENTRY)) return;

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'init', '--preset', 'bogus'],
      { cwd: workDir, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Unknown preset: bogus/);
  });

  it('scaffolds a self-hosted-plane project with the demo repo wired', async () => {
    if (!existsSync(CLI_ENTRY)) return;

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'init', '--preset', 'self-hosted-plane'],
      { cwd: workDir, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('preset self-hosted-plane');

    const configBody = await readFile(join(workDir, 'ouija.config.yaml'), 'utf8');
    expect(configBody).toContain('muhammadkh4n/ouija-demo-template');
    expect(configBody).toContain('runner: stream-json');
    // The preset config must have a boards block so Plane auto-bootstrap fires.
    expect(configBody).toMatch(/boards:\s*\n/);
  });

  it('scaffolds a self-hosted-fizzy project with ULID placeholders', async () => {
    if (!existsSync(CLI_ENTRY)) return;

    const fizzyDir = await mkdtemp(join(tmpdir(), 'ouija-cli-fizzy-'));
    try {
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'init', '--preset', 'self-hosted-fizzy'],
        { cwd: fizzyDir, encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('preset self-hosted-fizzy');

      const configBody = await readFile(
        join(fizzyDir, 'ouija.config.yaml'),
        'utf8',
      );
      expect(configBody).toContain('REPLACE_WITH_FIZZY_USER_ULID');
      expect(configBody).toContain('REPLACE_WITH_FIZZY_BOARD_ULID');
    } finally {
      await rm(fizzyDir, { recursive: true, force: true });
    }
  });
});
