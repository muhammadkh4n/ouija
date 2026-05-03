import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MATERIALIZED_FILES,
  materializeClaudeHome,
  neutralClaudeJson,
  neutralSettingsJson,
} from '../../src/identity/materialize-home.js';

describe('materializeClaudeHome', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ouija-mat-home-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes credentials, settings, and .claude.json when credentials provided', async () => {
    const targetDir = join(dir, 'home');
    const credentials = { claudeAiOauth: { accessToken: 'at' } };
    const result = await materializeClaudeHome({ targetDir, credentials });

    expect(result.path).toBe(targetDir);
    expect(result.filesWritten).toEqual([
      MATERIALIZED_FILES.credentials,
      MATERIALIZED_FILES.settings,
      MATERIALIZED_FILES.claudeJson,
    ]);

    const credsRaw = await fs.readFile(join(targetDir, MATERIALIZED_FILES.credentials), 'utf8');
    expect(JSON.parse(credsRaw)).toEqual(credentials);

    const settingsRaw = await fs.readFile(join(targetDir, MATERIALIZED_FILES.settings), 'utf8');
    expect(JSON.parse(settingsRaw)).toEqual(neutralSettingsJson());

    const claudeRaw = await fs.readFile(join(targetDir, MATERIALIZED_FILES.claudeJson), 'utf8');
    expect(JSON.parse(claudeRaw)).toEqual(neutralClaudeJson());
  });

  it('skips .credentials.json when credentials is null (EnvProvider path)', async () => {
    const targetDir = join(dir, 'home');
    const result = await materializeClaudeHome({ targetDir, credentials: null });

    expect(result.filesWritten).toEqual([
      MATERIALIZED_FILES.settings,
      MATERIALIZED_FILES.claudeJson,
    ]);

    await expect(
      fs.stat(join(targetDir, MATERIALIZED_FILES.credentials)),
    ).rejects.toThrow();
  });

  it('writes .credentials.json with 0600 permissions', async () => {
    if (process.platform === 'win32') return;
    const targetDir = join(dir, 'home');
    await materializeClaudeHome({
      targetDir,
      credentials: { claudeAiOauth: { accessToken: 'at' } },
    });
    const stat = await fs.stat(join(targetDir, MATERIALIZED_FILES.credentials));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writes settings.json + .claude.json with 0644 permissions', async () => {
    if (process.platform === 'win32') return;
    const targetDir = join(dir, 'home');
    await materializeClaudeHome({ targetDir, credentials: null });
    const settingsStat = await fs.stat(join(targetDir, MATERIALIZED_FILES.settings));
    const claudeStat = await fs.stat(join(targetDir, MATERIALIZED_FILES.claudeJson));
    expect(settingsStat.mode & 0o777).toBe(0o644);
    expect(claudeStat.mode & 0o777).toBe(0o644);
  });

  it('honors a settingsOverride', async () => {
    const targetDir = join(dir, 'home');
    const override = { hooks: {}, mcpServers: {}, hasCompletedOnboarding: true, customField: 'x' };
    await materializeClaudeHome({
      targetDir,
      credentials: null,
      settingsOverride: override,
    });
    const settingsRaw = await fs.readFile(join(targetDir, MATERIALIZED_FILES.settings), 'utf8');
    expect(JSON.parse(settingsRaw)).toEqual(override);
  });

  it('honors a claudeJsonOverride', async () => {
    const targetDir = join(dir, 'home');
    const override = { hasCompletedOnboarding: true, projects: { foo: {} } };
    await materializeClaudeHome({
      targetDir,
      credentials: null,
      claudeJsonOverride: override,
    });
    const claudeRaw = await fs.readFile(join(targetDir, MATERIALIZED_FILES.claudeJson), 'utf8');
    expect(JSON.parse(claudeRaw)).toEqual(override);
  });

  it('creates the target dir recursively when missing', async () => {
    const targetDir = join(dir, 'a', 'b', 'c');
    const result = await materializeClaudeHome({ targetDir, credentials: null });
    const stat = await fs.stat(result.path);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent — re-running with the same dir overwrites cleanly', async () => {
    const targetDir = join(dir, 'home');
    await materializeClaudeHome({
      targetDir,
      credentials: { claudeAiOauth: { accessToken: 'first' } },
    });
    await materializeClaudeHome({
      targetDir,
      credentials: { claudeAiOauth: { accessToken: 'second' } },
    });
    const credsRaw = await fs.readFile(join(targetDir, MATERIALIZED_FILES.credentials), 'utf8');
    expect(JSON.parse(credsRaw)).toEqual({ claudeAiOauth: { accessToken: 'second' } });
  });

  it('atomic rename leaves no .tmp residue on success', async () => {
    const targetDir = join(dir, 'home');
    await materializeClaudeHome({
      targetDir,
      credentials: { claudeAiOauth: { accessToken: 'at' } },
    });
    const entries = await fs.readdir(targetDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

describe('neutralSettingsJson', () => {
  it('produces empty hooks and mcpServers', () => {
    const s = neutralSettingsJson();
    expect(s['hooks']).toEqual({});
    expect(s['mcpServers']).toEqual({});
  });

  it('marks onboarding + data-consent as done so the CLI does not hang on prompts', () => {
    const s = neutralSettingsJson();
    expect(s['hasCompletedOnboarding']).toBe(true);
    expect(s['hasAcknowledgedDataConsent']).toBe(true);
  });

  it('disables telemetry by default', () => {
    const s = neutralSettingsJson() as { telemetry: { enabled: boolean } };
    expect(s.telemetry.enabled).toBe(false);
  });
});

describe('neutralClaudeJson', () => {
  it('produces an empty projects map and onboarding flag', () => {
    const c = neutralClaudeJson();
    expect(c['hasCompletedOnboarding']).toBe(true);
    expect(c['projects']).toEqual({});
  });
});
