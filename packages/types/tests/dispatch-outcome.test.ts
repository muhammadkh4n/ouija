import { describe, it, expect } from 'vitest';
import type { DispatchOutcome } from '../src/state-machine.js';
import { hasPositiveEvidence } from '../src/state-machine.js';

function make(overrides: Partial<DispatchOutcome> = {}): DispatchOutcome {
  return {
    commitsPushed: 0,
    toolCallsMade: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...overrides,
  };
}

describe('hasPositiveEvidence', () => {
  it('returns false for an empty outcome (the 2026-04-19 smoke class of silent success)', () => {
    expect(hasPositiveEvidence(make())).toBe(false);
  });

  it('returns true when a PR URL is present', () => {
    expect(
      hasPositiveEvidence(make({ prUrl: 'https://github.com/acme/backend/pull/42' })),
    ).toBe(true);
  });

  it('treats an empty-string prUrl as not present', () => {
    expect(hasPositiveEvidence(make({ prUrl: '' }))).toBe(false);
  });

  it('returns true when commitsPushed > 0', () => {
    expect(hasPositiveEvidence(make({ commitsPushed: 1 }))).toBe(true);
  });

  it('returns true when toolCallsMade > 0', () => {
    expect(hasPositiveEvidence(make({ toolCallsMade: 3 }))).toBe(true);
  });

  it('returns false when tokens are reported but no tool/commit/pr artefact exists', () => {
    // Token spend alone doesn't count: a model can deliberate without acting.
    expect(hasPositiveEvidence(make({ tokensIn: 4_000, tokensOut: 1_500 }))).toBe(false);
  });

  it('returns false when cost/duration are reported but no tool/commit/pr artefact exists', () => {
    expect(hasPositiveEvidence(make({ costUsd: 0.12, durationMs: 20_000 }))).toBe(false);
  });

  it('treats mixed-positive (one truthy field) as positive', () => {
    expect(
      hasPositiveEvidence(
        make({
          commitsPushed: 0,
          toolCallsMade: 0,
          prUrl: 'https://github.com/acme/backend/pull/7',
          tokensIn: 0,
        }),
      ),
    ).toBe(true);
  });
});
