/**
 * Covers the runtime shape of PIPELINE_STATUSES and the drift-check surface
 * of scripts/gen-status-migration.mjs.
 *
 * Phase 1 Task 1 (v0.4.0): Tenet 4 enforcement — TS is the source of truth for
 * the state enum; SQL is generated; drift is impossible at PR-review time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PIPELINE_STATUSES } from '../src/state-machine.js';
// @ts-expect-error -- .mjs import with no declared types; we only exercise runtime
import {
  extractStatuses,
  renderMigration,
  generate,
  TARGET_PATH,
} from '../../../scripts/gen-status-migration.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

describe('PIPELINE_STATUSES (runtime)', () => {
  it('contains every status the DB check constraint must accept', () => {
    const expected = [
      'awaiting_review',
      'cancelled',
      'dispatching',
      'failed',
      'idle',
      'provisioning',
      'running',
      'stalled',
      'succeeded',
    ];
    expect([...PIPELINE_STATUSES].sort()).toEqual(expected);
  });

  it('is readonly — as const is enforced', () => {
    // Mutating a readonly tuple throws in strict mode even though TS doesn't
    // block the cast. Guards against accidental `.push`.
    expect(() => {
      const mutable = PIPELINE_STATUSES as unknown as string[];
      Object.freeze(mutable);
      mutable.push('bogus');
    }).toThrow();
  });
});

describe('gen-status-migration extraction', () => {
  it('parses PIPELINE_STATUSES out of state-machine.ts', () => {
    const src = readFileSync(join(repoRoot, 'packages/types/src/state-machine.ts'), 'utf-8');
    const extracted = extractStatuses(src) as string[];
    expect(extracted.sort()).toEqual([...PIPELINE_STATUSES].sort());
  });

  it('rejects a missing PIPELINE_STATUSES declaration', () => {
    expect(() => extractStatuses('// no declaration here')).toThrow(
      /PIPELINE_STATUSES declaration not found/,
    );
  });

  it('rejects duplicates', () => {
    const bad = `
      export const PIPELINE_STATUSES = [
        'a',
        'a',
      ] as const;
    `;
    expect(() => extractStatuses(bad)).toThrow(/duplicates/);
  });

  it('rejects an empty array', () => {
    const bad = `export const PIPELINE_STATUSES = [] as const;`;
    expect(() => extractStatuses(bad)).toThrow(/empty/);
  });
});

describe('gen-status-migration rendering', () => {
  it('produces deterministic output for the same inputs', () => {
    const a = renderMigration(['idle', 'running', 'succeeded']);
    const b = renderMigration(['idle', 'running', 'succeeded']);
    expect(a).toBe(b);
  });

  it('sorts statuses alphabetically regardless of input order', () => {
    const a = renderMigration(['idle', 'running', 'succeeded']);
    const b = renderMigration(['succeeded', 'idle', 'running']);
    expect(a).toBe(b);
  });

  it('emits the drop-then-add idempotent pattern', () => {
    const sql = renderMigration(['idle', 'running']) as string;
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS pipeline_instances_status_check/);
    expect(sql).toMatch(/ADD CONSTRAINT\s+pipeline_instances_status_check/);
    expect(sql).toMatch(/CHECK \(status IN \(\n\s+'idle',\n\s+'running'\n\s+\)\);/);
  });
});

describe('generated migration file matches the generator', () => {
  it('006-status-enum.sql is byte-identical to a fresh generation', () => {
    const committed = readFileSync(TARGET_PATH as string, 'utf-8');
    const { migration } = generate() as { migration: string };
    expect(committed).toBe(migration);
  });
});
