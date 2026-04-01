import { describe, it, expect } from 'vitest';
import { evaluateGuards } from '../src/guards.js';
import type { Guard, GuardContext } from '@ouija/types';

// Representative base context — description is long enough, has labels, has assignees
const baseContext: GuardContext = {
  cardDescription: 'Implement the login page with full OAuth 2.0 support and error handling',
  cardLabels: ['ready', 'frontend'],
  cardAssignees: ['agent-rex'],
};

describe('evaluateGuards — min_description_length', () => {
  it('passes when description exactly meets minimum length', () => {
    const desc = 'a'.repeat(10);
    const ctx: GuardContext = { ...baseContext, cardDescription: desc };
    const guards: Guard[] = [{ type: 'min_description_length', value: 10 }];
    const [result] = evaluateGuards(guards, ctx);
    expect(result?.passed).toBe(true);
    expect(result?.reason).toBeUndefined();
  });

  it('passes when description exceeds minimum length', () => {
    const guards: Guard[] = [{ type: 'min_description_length', value: 10 }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
  });

  it('fails when description is shorter than minimum', () => {
    const guards: Guard[] = [{ type: 'min_description_length', value: 1000 }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.reason).toContain('chars');
    expect(results[0]?.reason).toContain('1000');
  });

  it('fails when description is empty', () => {
    const ctx: GuardContext = { ...baseContext, cardDescription: '' };
    const guards: Guard[] = [{ type: 'min_description_length', value: 1 }];
    const results = evaluateGuards(guards, ctx);
    expect(results[0]?.passed).toBe(false);
  });

  it('accepts string-encoded numeric value', () => {
    const guards: Guard[] = [{ type: 'min_description_length', value: '10' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
  });
});

describe('evaluateGuards — has_label', () => {
  it('passes when card has the required label', () => {
    const guards: Guard[] = [{ type: 'has_label', value: 'ready' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.reason).toBeUndefined();
  });

  it('fails when required label is absent', () => {
    const guards: Guard[] = [{ type: 'has_label', value: 'approved' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.reason).toContain('approved');
  });

  it('fails on empty label list', () => {
    const ctx: GuardContext = { ...baseContext, cardLabels: [] };
    const guards: Guard[] = [{ type: 'has_label', value: 'ready' }];
    const results = evaluateGuards(guards, ctx);
    expect(results[0]?.passed).toBe(false);
  });

  it('is case-sensitive', () => {
    const guards: Guard[] = [{ type: 'has_label', value: 'Ready' }];
    const results = evaluateGuards(guards, baseContext); // has 'ready', not 'Ready'
    expect(results[0]?.passed).toBe(false);
  });
});

describe('evaluateGuards — has_assignee', () => {
  it('passes when card has at least one assignee', () => {
    const guards: Guard[] = [{ type: 'has_assignee', value: '' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.reason).toBeUndefined();
  });

  it('fails when card has no assignees', () => {
    const ctx: GuardContext = { ...baseContext, cardAssignees: [] };
    const guards: Guard[] = [{ type: 'has_assignee', value: '' }];
    const results = evaluateGuards(guards, ctx);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.reason).toContain('assignee');
  });

  it('passes with multiple assignees', () => {
    const ctx: GuardContext = { ...baseContext, cardAssignees: ['alice', 'bob'] };
    const guards: Guard[] = [{ type: 'has_assignee', value: '' }];
    const results = evaluateGuards(guards, ctx);
    expect(results[0]?.passed).toBe(true);
  });
});

describe('evaluateGuards — AND-gate semantics', () => {
  it('returns one result per guard', () => {
    const guards: Guard[] = [
      { type: 'min_description_length', value: 10 },
      { type: 'has_label', value: 'ready' },
      { type: 'has_assignee', value: '' },
    ];
    const results = evaluateGuards(guards, baseContext);
    expect(results).toHaveLength(3);
  });

  it('all pass when context satisfies every guard', () => {
    const guards: Guard[] = [
      { type: 'min_description_length', value: 10 },
      { type: 'has_label', value: 'ready' },
      { type: 'has_assignee', value: '' },
    ];
    const results = evaluateGuards(guards, baseContext);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('all guards evaluated even when first fails (no short-circuit)', () => {
    const guards: Guard[] = [
      { type: 'has_label', value: 'nonexistent-label' },
      { type: 'min_description_length', value: 10 },
    ];
    const results = evaluateGuards(guards, baseContext);
    expect(results).toHaveLength(2);
    expect(results[0]?.passed).toBe(false);
    expect(results[1]?.passed).toBe(true);
  });

  it('returns empty array for empty guards list', () => {
    const results = evaluateGuards([], baseContext);
    expect(results).toHaveLength(0);
  });

  it('fails fast is visible — caller sees which guards failed', () => {
    const guards: Guard[] = [
      { type: 'has_label', value: 'missing-label' },
      { type: 'min_description_length', value: 999_999 },
    ];
    const results = evaluateGuards(guards, baseContext);
    const failedReasons = results.filter((r) => !r.passed).map((r) => r.reason);
    expect(failedReasons).toHaveLength(2);
    expect(failedReasons[0]).toContain('missing-label');
    expect(failedReasons[1]).toContain('chars');
  });
});

describe('evaluateGuards — guardType field', () => {
  it('sets guardType to the guard type string', () => {
    const guards: Guard[] = [
      { type: 'min_description_length', value: 1 },
      { type: 'has_label', value: 'ready' },
      { type: 'has_assignee', value: '' },
    ];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.guardType).toBe('min_description_length');
    expect(results[1]?.guardType).toBe('has_label');
    expect(results[2]?.guardType).toBe('has_assignee');
  });
});
