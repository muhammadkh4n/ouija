import { describe, it, expect } from 'vitest';
import { buildInlineKeyboard } from '../src/keyboard.js';

describe('buildInlineKeyboard', () => {
  it('returns undefined when actions is undefined', () => {
    expect(buildInlineKeyboard(undefined)).toBeUndefined();
  });

  it('returns undefined when actions is empty array', () => {
    expect(buildInlineKeyboard([])).toBeUndefined();
  });

  it('creates one row per action', () => {
    const actions = [
      { label: 'View Pipeline', url: 'http://localhost:4000/pipelines/123' },
      { label: 'View PR', url: 'https://github.com/org/repo/pull/42' },
    ];
    const keyboard = buildInlineKeyboard(actions);
    expect(keyboard).toBeDefined();
    expect(keyboard!.inline_keyboard).toHaveLength(2);
    expect(keyboard!.inline_keyboard[0]![0]!.text).toBe('View Pipeline');
    expect(keyboard!.inline_keyboard[0]![0]!.url).toBe('http://localhost:4000/pipelines/123');
    expect(keyboard!.inline_keyboard[1]![0]!.text).toBe('View PR');
  });

  it('caps at 3 rows for mobile readability', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({
      label: `Action ${i}`,
      url: `http://example.com/${i}`,
    }));
    const keyboard = buildInlineKeyboard(actions);
    expect(keyboard!.inline_keyboard).toHaveLength(3);
  });

  it('each row contains exactly one button', () => {
    const actions = [
      { label: 'Retry', url: 'http://localhost:4000/retry/1' },
      { label: 'Cancel', url: 'http://localhost:4000/cancel/1' },
    ];
    const keyboard = buildInlineKeyboard(actions);
    for (const row of keyboard!.inline_keyboard) {
      expect(row).toHaveLength(1);
    }
  });

  it('maps label and url correctly', () => {
    const keyboard = buildInlineKeyboard([
      { label: 'View Details', url: 'https://example.com/details' },
    ]);
    expect(keyboard!.inline_keyboard[0]![0]!.text).toBe('View Details');
    expect(keyboard!.inline_keyboard[0]![0]!.url).toBe('https://example.com/details');
  });
});
