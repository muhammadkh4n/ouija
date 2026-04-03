/**
 * workspace-config.test.ts
 *
 * Tests for assembleWorkspaceConfig — verifies CLAUDE.md assembly and
 * settings.json deep merge using real temp directories.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { assembleWorkspaceConfig, type WorkspaceConfigOptions } from '../src/workspace-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(prefix = 'ouija-ws-test-'): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function baseOptions(workspaceDir: string): WorkspaceConfigOptions {
  return {
    workspaceDir,
    title: 'Implement feature X',
    description: 'Add the X feature to the dashboard',
    acceptanceCriteria: ['Unit tests pass', 'No regressions'],
    branch: 'ouija/inst-abc',
    baseBranch: 'main',
  };
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assembleWorkspaceConfig', () => {
  it('appends systemPrompt + task context to empty workspace', async () => {
    const ws = await makeTmpDir();

    await assembleWorkspaceConfig({
      ...baseOptions(ws),
      systemPrompt: 'You are an expert engineer.',
    });

    const md = await readFile(join(ws, '.claude', 'CLAUDE.md'), 'utf-8');

    // systemPrompt is present
    expect(md).toContain('You are an expert engineer.');
    // task context is present
    expect(md).toContain('## Current Task');
    expect(md).toContain('**Implement feature X**');
    expect(md).toContain('Add the X feature to the dashboard');
    expect(md).toContain('- Unit tests pass');
    expect(md).toContain('`ouija/inst-abc`');
  });

  it('preserves existing repo CLAUDE.md', async () => {
    const ws = await makeTmpDir();
    const claudeDir = join(ws, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'CLAUDE.md'), '# Project Rules\n\nNo console.log in prod.\n');

    await assembleWorkspaceConfig({
      ...baseOptions(ws),
      systemPrompt: 'You are an expert engineer.',
    });

    const md = await readFile(join(claudeDir, 'CLAUDE.md'), 'utf-8');

    // Existing content comes first
    expect(md.indexOf('# Project Rules')).toBeLessThan(md.indexOf('You are an expert engineer.'));
    // Both are present
    expect(md).toContain('# Project Rules');
    expect(md).toContain('You are an expert engineer.');
    expect(md).toContain('## Current Task');
  });

  it('merges configDir .claude/settings.json', async () => {
    const ws = await makeTmpDir();
    const wsClaudeDir = join(ws, '.claude');
    await mkdir(wsClaudeDir, { recursive: true });
    await writeFile(
      join(wsClaudeDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] }, theme: 'dark' }),
    );

    const configDir = await makeTmpDir('ouija-cfg-');
    const cfgClaudeDir = join(configDir, '.claude');
    await mkdir(cfgClaudeDir, { recursive: true });
    await writeFile(
      join(cfgClaudeDir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read', 'Edit'] },
        mcpServers: { pg: { command: 'npx' } },
      }),
    );

    await assembleWorkspaceConfig({
      ...baseOptions(ws),
      configDir,
    });

    const merged = JSON.parse(await readFile(join(wsClaudeDir, 'settings.json'), 'utf-8'));

    // Agent arrays replace workspace arrays
    expect(merged.permissions.allow).toEqual(['Read', 'Edit']);
    // Agent adds new keys
    expect(merged.mcpServers).toEqual({ pg: { command: 'npx' } });
    // Workspace-only keys survive
    expect(merged.theme).toBe('dark');
  });

  it('appends configDir CLAUDE.md instead of systemPrompt', async () => {
    const ws = await makeTmpDir();

    const configDir = await makeTmpDir('ouija-cfg-');
    const cfgClaudeDir = join(configDir, '.claude');
    await mkdir(cfgClaudeDir, { recursive: true });
    await writeFile(join(cfgClaudeDir, 'CLAUDE.md'), '# Agent Config\n\nUse TypeScript strict mode.\n');

    await assembleWorkspaceConfig({
      ...baseOptions(ws),
      configDir,
      systemPrompt: 'This should NOT appear.',
    });

    const md = await readFile(join(ws, '.claude', 'CLAUDE.md'), 'utf-8');

    // configDir CLAUDE.md wins
    expect(md).toContain('# Agent Config');
    expect(md).toContain('Use TypeScript strict mode.');
    // systemPrompt is NOT present
    expect(md).not.toContain('This should NOT appear.');
  });

  it('always includes task context', async () => {
    const ws = await makeTmpDir();

    await assembleWorkspaceConfig(baseOptions(ws));

    const md = await readFile(join(ws, '.claude', 'CLAUDE.md'), 'utf-8');

    expect(md).toContain('**Implement feature X**');
    expect(md).toContain('Add the X feature to the dashboard');
    expect(md).toContain('## Acceptance Criteria');
    expect(md).toContain('- Unit tests pass');
    expect(md).toContain('- No regressions');
    expect(md).toContain('## Working Branch');
    expect(md).toContain('`ouija/inst-abc`');
    expect(md).toContain('`main`');
    expect(md).toContain('Push your changes and create a pull request when done.');
  });

  it('creates .claude/ directory if missing', async () => {
    const ws = await makeTmpDir();
    // No .claude/ dir — assembleWorkspaceConfig should create it

    await assembleWorkspaceConfig({
      ...baseOptions(ws),
      systemPrompt: 'Hello agent.',
    });

    const md = await readFile(join(ws, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('Hello agent.');
    expect(md).toContain('## Current Task');
  });
});
