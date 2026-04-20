#!/usr/bin/env node
/**
 * Generates packages/engine/src/migrations/006-status-enum.sql from the
 * PIPELINE_STATUSES constant in packages/types/src/state-machine.ts.
 *
 * Tenet 4: TypeScript is the source of truth for the state enum; SQL is
 * derived from it. Hand-editing migration 006 is forbidden.
 *
 * Usage:
 *   node scripts/gen-status-migration.mjs      # write the migration
 *   node scripts/gen-status-migration.mjs --check   # exit 1 if drifted
 *
 * CI invokes --check after npm run gen:migrations so any uncommitted drift
 * blocks the PR.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

export const SOURCE_PATH = join(repoRoot, 'packages/types/src/state-machine.ts');
export const TARGET_PATH = join(
  repoRoot,
  'packages/engine/src/migrations/006-status-enum.sql',
);

/**
 * Extract the string literals inside `export const PIPELINE_STATUSES = [...] as const;`.
 *
 * The parser is intentionally tiny — a full TS AST parse would drag in
 * typescript as a runtime dep just for a build-time codegen script. The
 * const declaration is a stable shape in state-machine.ts and its format
 * is covered by the vitest for this generator.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractStatuses(source) {
  const declMatch = source.match(
    /export\s+const\s+PIPELINE_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/,
  );
  if (!declMatch) {
    throw new Error(
      'PIPELINE_STATUSES declaration not found in packages/types/src/state-machine.ts',
    );
  }
  const body = declMatch[1];
  const literals = [...body.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);
  if (literals.length === 0) {
    throw new Error('PIPELINE_STATUSES is empty — the state machine needs at least one status');
  }
  const duplicates = literals.filter((s, i) => literals.indexOf(s) !== i);
  if (duplicates.length > 0) {
    throw new Error(`PIPELINE_STATUSES contains duplicates: ${duplicates.join(', ')}`);
  }
  return literals;
}

/**
 * Render the SQL migration body. Statuses are sorted so the output is stable
 * regardless of the declaration order in state-machine.ts — developers can
 * group statuses logically in TS while the SQL stays canonical.
 *
 * @param {string[]} statuses
 * @returns {string}
 */
export function renderMigration(statuses) {
  const sorted = [...statuses].sort();
  const quoted = sorted.map((s) => `    '${s}'`).join(',\n');
  return `-- 006-status-enum.sql
-- GENERATED FILE — do not edit by hand.
--
-- Source of truth: packages/types/src/state-machine.ts (PIPELINE_STATUSES).
-- Regenerate with: npm run gen:migrations
-- CI enforces no drift (.github/workflows/ci.yml → "check migration drift").
--
-- Tenet 4: one source of truth for the state enum (TypeScript generates SQL).
-- See Ouija/Details — Architectural Tenets.md.
--
-- This migration replaces the check constraint from 001-initial-schema.sql
-- with one that covers every current PipelineStatus tag. Drop-if-exists +
-- add is used (not alter) because check constraints don't support ALTER.

ALTER TABLE pipeline_instances
  DROP CONSTRAINT IF EXISTS pipeline_instances_status_check;

ALTER TABLE pipeline_instances
  ADD CONSTRAINT pipeline_instances_status_check
    CHECK (status IN (
${quoted}
    ));
`;
}

export function generate() {
  const source = readFileSync(SOURCE_PATH, 'utf-8');
  const statuses = extractStatuses(source);
  const migration = renderMigration(statuses);
  return { statuses, migration };
}

function isDirectInvocation() {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  return import.meta.url === `file://${invokedPath}`;
}

if (isDirectInvocation()) {
  const check = process.argv.includes('--check');
  const { statuses, migration } = generate();
  if (check) {
    const existing = (() => {
      try {
        return readFileSync(TARGET_PATH, 'utf-8');
      } catch {
        return '';
      }
    })();
    if (existing !== migration) {
      process.stderr.write(
        `drift detected: ${TARGET_PATH} is out of sync with PIPELINE_STATUSES.\n` +
          `Run 'npm run gen:migrations' and commit the updated file.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`ok: ${statuses.length} statuses, no drift.\n`);
  } else {
    writeFileSync(TARGET_PATH, migration, 'utf-8');
    process.stdout.write(`wrote ${TARGET_PATH} (${statuses.length} statuses)\n`);
  }
}
