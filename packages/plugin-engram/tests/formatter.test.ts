import { describe, it, expect } from 'vitest';
import { formatMemory } from '../src/formatter.js';
import type { Notification } from '@ouija-dev/types';

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: 'Pipeline succeeded',
    body: 'Agent opened PR #42 on frontend repo.',
    level: 'success',
    occurredAt: '2026-04-16T10:30:00.000Z',
    idempotencyKey: 'inst_abc_succeeded',
    ...overrides,
  };
}

describe('formatMemory', () => {
  it('produces a markdown heading with the title', () => {
    const md = formatMemory(makeNotification());
    expect(md.split('\n')[0]).toBe('# Ouija: Pipeline succeeded');
  });

  it('includes level and timestamp metadata', () => {
    const md = formatMemory(makeNotification());
    expect(md).toContain('**Level:** success');
    expect(md).toContain('**When:** 2026-04-16T10:30:00.000Z');
  });

  it('preserves the body verbatim', () => {
    const body = 'Line one\n\nLine two with **bold**';
    const md = formatMemory(makeNotification({ body }));
    expect(md).toContain(body);
  });

  it('renders actions as markdown links when present', () => {
    const md = formatMemory(
      makeNotification({
        actions: [
          { label: 'PR', url: 'https://github.com/org/repo/pull/42' },
          { label: 'Card', url: 'https://plane.so/foo/issues/1' },
        ],
      }),
    );
    expect(md).toContain('- [PR](https://github.com/org/repo/pull/42)');
    expect(md).toContain('- [Card](https://plane.so/foo/issues/1)');
  });

  it('omits the Links section when actions is undefined', () => {
    const md = formatMemory(makeNotification());
    expect(md).not.toContain('**Links:**');
  });

  it('emits a trailing idempotency comment for dedup', () => {
    const md = formatMemory(makeNotification());
    expect(md).toMatch(/<!-- ouija:inst_abc_succeeded -->$/);
  });
});
