import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  formatNotification,
  formatDispatchStarted,
  formatPrReady,
  formatAgentFailed,
  formatStallDetected,
} from '../src/formatter.js';
import type { Notification } from '@ouija-dev/types';

// ---- escapeHtml ----

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('x > y')).toBe('x &gt; y');
  });

  it('escapes all three in one string', () => {
    expect(escapeHtml('a & <b> > c')).toBe('a &amp; &lt;b&gt; &gt; c');
  });

  it('passes through normal text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('passes through empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

// ---- formatNotification ----

describe('formatNotification', () => {
  const baseNotification: Notification = {
    title: 'Pipeline Dispatched',
    body: 'Agent rex-coder dispatched for card OUIJA-42',
    level: 'info',
    occurredAt: new Date().toISOString(),
    idempotencyKey: 'test-key-1',
  };

  it('includes level icon and bold title', () => {
    const result = formatNotification(baseNotification);
    expect(result).toContain('<b>Pipeline Dispatched</b>');
    expect(result).toContain('\u2139\uFE0F');
  });

  it('includes body text', () => {
    const result = formatNotification(baseNotification);
    expect(result).toContain('Agent rex-coder dispatched for card OUIJA-42');
  });

  it('separates title and body with a blank line', () => {
    const result = formatNotification(baseNotification);
    expect(result).toContain('\n\n');
  });

  it('escapes HTML in title and body', () => {
    const notification: Notification = {
      ...baseNotification,
      title: 'Error in <main>',
      body: 'Failed with code & message',
    };
    const result = formatNotification(notification);
    expect(result).toContain('&lt;main&gt;');
    expect(result).toContain('&amp;');
    expect(result).not.toContain('<main>');
  });

  it('uses correct icon for each level', () => {
    const cases: Array<{ level: Notification['level']; icon: string }> = [
      { level: 'info', icon: '\u2139\uFE0F' },
      { level: 'warning', icon: '\u26A0\uFE0F' },
      { level: 'error', icon: '\u274C' },
      { level: 'success', icon: '\u2705' },
    ];
    for (const { level, icon } of cases) {
      const result = formatNotification({ ...baseNotification, level });
      expect(result, `level=${level} should use icon ${icon}`).toContain(icon);
    }
  });
});

// ---- formatDispatchStarted ----

describe('formatDispatchStarted', () => {
  it('includes agent name and card info', () => {
    const result = formatDispatchStarted({
      agentName: 'rex-coder',
      cardTitle: 'Fix login bug',
      cardId: 'OUIJA-42',
    });
    expect(result).toContain('rex-coder');
    expect(result).toContain('OUIJA-42');
    expect(result).toContain('Fix login bug');
  });

  it('uses the dispatched heading', () => {
    const result = formatDispatchStarted({
      agentName: 'rex-coder',
      cardTitle: 'Fix login bug',
      cardId: 'OUIJA-42',
    });
    expect(result).toContain('Agent dispatched');
  });

  it('escapes HTML in agent name and card title', () => {
    const result = formatDispatchStarted({
      agentName: 'agent<one>',
      cardTitle: 'Fix & improve',
      cardId: 'OUIJA-1',
    });
    expect(result).toContain('agent&lt;one&gt;');
    expect(result).toContain('Fix &amp; improve');
  });
});

// ---- formatPrReady ----

describe('formatPrReady', () => {
  it('includes PR URL as an anchor', () => {
    const result = formatPrReady({
      prUrl: 'https://github.com/org/repo/pull/42',
      prTitle: 'Fix login flow',
      repoName: 'org/repo',
    });
    expect(result).toContain('href="https://github.com/org/repo/pull/42"');
    expect(result).toContain('Fix login flow');
  });

  it('includes repo name', () => {
    const result = formatPrReady({
      prUrl: 'https://github.com/org/repo/pull/42',
      prTitle: 'Fix login flow',
      repoName: 'org/repo',
    });
    expect(result).toContain('org/repo');
  });

  it('uses PR ready heading', () => {
    const result = formatPrReady({
      prUrl: 'https://github.com/org/repo/pull/1',
      prTitle: 'Add feature',
      repoName: 'org/repo',
    });
    expect(result).toContain('PR ready for review');
  });

  it('escapes HTML in PR title', () => {
    const result = formatPrReady({
      prUrl: 'https://github.com/org/repo/pull/1',
      prTitle: 'Fix <script> injection',
      repoName: 'org/repo',
    });
    expect(result).toContain('Fix &lt;script&gt; injection');
  });
});

// ---- formatAgentFailed ----

describe('formatAgentFailed', () => {
  it('includes agent name and error message', () => {
    const result = formatAgentFailed({
      agentName: 'rex-coder',
      errorMessage: 'ECONNREFUSED: connection refused',
    });
    expect(result).toContain('rex-coder');
    expect(result).toContain('ECONNREFUSED: connection refused');
  });

  it('uses the failed heading', () => {
    const result = formatAgentFailed({
      agentName: 'rex-coder',
      errorMessage: 'timeout',
    });
    expect(result).toContain('Agent failed');
  });

  it('wraps error message in a code block', () => {
    const result = formatAgentFailed({
      agentName: 'rex-coder',
      errorMessage: 'exit code 1',
    });
    expect(result).toContain('<code>exit code 1</code>');
  });

  it('escapes HTML in error message', () => {
    const result = formatAgentFailed({
      agentName: 'rex-coder',
      errorMessage: 'Error: <null> pointer',
    });
    expect(result).toContain('&lt;null&gt;');
  });
});

// ---- formatStallDetected ----

describe('formatStallDetected', () => {
  it('includes agent name and stall duration', () => {
    const result = formatStallDetected({
      agentName: 'rex-coder',
      stalledMinutes: 5,
    });
    expect(result).toContain('rex-coder');
    expect(result).toContain('5m');
  });

  it('uses the stalled heading', () => {
    const result = formatStallDetected({
      agentName: 'rex-coder',
      stalledMinutes: 10,
    });
    expect(result).toContain('Agent stalled');
  });

  it('uses the warning icon', () => {
    const result = formatStallDetected({
      agentName: 'rex-coder',
      stalledMinutes: 5,
    });
    expect(result).toContain('\u26A0\uFE0F');
  });

  it('escapes HTML in agent name', () => {
    const result = formatStallDetected({
      agentName: 'agent<x>',
      stalledMinutes: 3,
    });
    expect(result).toContain('agent&lt;x&gt;');
  });
});
