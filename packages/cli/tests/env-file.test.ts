import { describe, it, expect } from 'vitest';
import { parseEnv, applyEnvUpdates } from '../src/lib/env-file.js';

describe('parseEnv', () => {
  it('parses simple key=value lines', () => {
    const body = 'FOO=bar\nBAZ=qux\n';
    expect(parseEnv(body)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    const body = '# a comment\n\nFOO=bar\n# FOO=ignored\nBAZ=qux\n';
    expect(parseEnv(body)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips surrounding quotes', () => {
    const body = `DOUBLE="hello"\nSINGLE='world'\nPLAIN=raw\n`;
    expect(parseEnv(body)).toEqual({
      DOUBLE: 'hello',
      SINGLE: 'world',
      PLAIN: 'raw',
    });
  });

  it('handles values containing = signs', () => {
    const body = 'URL=postgres://user:pass@host:5432/db?ssl=true\n';
    expect(parseEnv(body)).toEqual({
      URL: 'postgres://user:pass@host:5432/db?ssl=true',
    });
  });

  it('returns empty object for empty body', () => {
    expect(parseEnv('')).toEqual({});
  });
});

describe('applyEnvUpdates', () => {
  it('replaces active key values in place', () => {
    const body = 'FOO=old\nBAR=keep\n';
    const result = applyEnvUpdates(body, { FOO: 'new' });
    expect(result).toContain('FOO=new');
    expect(result).toContain('BAR=keep');
    expect(result).not.toContain('FOO=old');
  });

  it('uncomments and updates commented-out keys', () => {
    const body = '# FOO=placeholder\nBAR=keep\n';
    const result = applyEnvUpdates(body, { FOO: 'real' });
    expect(result).toContain('FOO=real');
    expect(result).not.toContain('# FOO=placeholder');
  });

  it('appends unknown keys at the end', () => {
    const body = 'FOO=bar\n';
    const result = applyEnvUpdates(body, { NEW_KEY: 'value' });
    expect(result).toContain('FOO=bar');
    expect(result).toMatch(/# Added by ouija CLI\nNEW_KEY=value/);
  });

  it('preserves comments and blank lines', () => {
    const body = '# Section: core\n\nFOO=old\n\n# Section: other\nBAR=keep\n';
    const result = applyEnvUpdates(body, { FOO: 'new' });
    expect(result).toContain('# Section: core');
    expect(result).toContain('# Section: other');
    expect(result.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('only updates each key once even if it appears twice', () => {
    const body = 'FOO=first\nFOO=second\n';
    const result = applyEnvUpdates(body, { FOO: 'new' });
    const matches = result.match(/FOO=new/g);
    expect(matches).toHaveLength(1);
    expect(result).toContain('FOO=second');
  });

  it('preserves indentation on replaced lines', () => {
    const body = '  FOO=old\n';
    const result = applyEnvUpdates(body, { FOO: 'new' });
    expect(result).toContain('  FOO=new');
  });
});
