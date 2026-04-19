import { describe, it, expect } from 'vitest';
import { agentConfigToProfile } from '../src/work-order-assembler.js';

const SAMPLE_CONFIG = {
  id: 'rex-coder',
  name: 'Rex Coder',
  email: 'rex@ouija.local',
  model: 'claude-sonnet-4-20250514',
  triggerMode: 'auto',
  systemPrompt: 'You are Rex.',
  auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
  repos: [
    { url: 'https://github.com/a/b.git', baseBranch: 'main', default: true },
    { url: 'https://github.com/c/d.git', baseBranch: 'develop', projectId: 'proj-2' },
  ],
  limits: { maxDurationMs: 1_800_000 },
  runner: 'stream-json',
  configDir: '/tmp/rex',
};

describe('agentConfigToProfile', () => {
  it('maps the full canonical agent config', () => {
    const profile = agentConfigToProfile(SAMPLE_CONFIG);
    expect(profile).toEqual({
      id: 'rex-coder',
      name: 'Rex Coder',
      systemPrompt: 'You are Rex.',
      secretRef: 'env:ANTHROPIC_API_KEY',
      model: 'claude-sonnet-4-20250514',
      maxDurationMs: 1_800_000,
      repoUrl: 'https://github.com/a/b.git',
      baseBranch: 'main',
      triggerMode: 'auto',
      runner: 'stream-json',
      configDir: '/tmp/rex',
      authMethod: 'api-key',
      repos: [
        { url: 'https://github.com/a/b.git', baseBranch: 'main', projectId: undefined, default: true, path: undefined },
        { url: 'https://github.com/c/d.git', baseBranch: 'develop', projectId: 'proj-2', default: undefined, path: undefined },
      ],
    });
  });

  it('falls back to first repo when none are marked default', () => {
    const config = {
      ...SAMPLE_CONFIG,
      repos: [{ url: 'https://github.com/a/b.git', baseBranch: 'develop' }],
    };
    const profile = agentConfigToProfile(config);
    expect(profile.baseBranch).toBe('develop');
    expect(profile.repoUrl).toBe('https://github.com/a/b.git');
  });

  it('treats path-based repos equivalently to url-based', () => {
    const config = {
      ...SAMPLE_CONFIG,
      repos: [{ path: '/opt/repo', baseBranch: 'main', default: true }],
    };
    const profile = agentConfigToProfile(config);
    expect(profile.repoPath).toBe('/opt/repo');
    expect(profile.repoUrl).toBeUndefined();
  });

  it('defaults systemPrompt to empty string when omitted', () => {
    const { systemPrompt: _omit, ...withoutPrompt } = SAMPLE_CONFIG;
    void _omit;
    const profile = agentConfigToProfile(withoutPrompt);
    expect(profile.systemPrompt).toBe('');
  });

  it('ignores invalid runner values (schema should have caught them, but defensive)', () => {
    const profile = agentConfigToProfile({ ...SAMPLE_CONFIG, runner: 'bogus' });
    expect(profile.runner).toBeUndefined();
  });

  it('throws on missing required string fields', () => {
    const { name: _omit, ...without } = SAMPLE_CONFIG;
    void _omit;
    expect(() => agentConfigToProfile(without)).toThrow(/name/);
  });
});
