/**
 * Focused tests for the WorkOrder → prompt mapping. The plain (fresh-card)
 * prompt is exercised indirectly by higher-level tests; these tests cover the
 * review-loop branch of the prompt template since it changes meaningfully
 * based on whether `reviewContext` is present.
 */

import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/work-order-builder.js';
import type { WorkOrder } from '@ouija-dev/types';
import { instanceId } from '@ouija-dev/types';

function baseWorkOrder(): WorkOrder {
  return {
    instanceId: instanceId('inst-1'),
    cardId: 'card-1',
    title: 'Add OAuth login',
    description: 'Implements /login endpoint.',
    acceptanceCriteria: ['Endpoint returns 200 on success'],
    repoUrl: 'https://github.com/acme/backend.git',
    branch: 'ouija/inst-1',
    baseBranch: 'main',
    agentProfileId: 'rex-coder',
    systemPrompt: '',
    secretRef: 'env:ANTHROPIC_API_KEY',
    callbackUrl: 'http://ouija:4000/hooks/agent/callback',
    callbackToken: 'jwt-xyz',
    maxDurationMs: 60_000,
    metadata: {},
  };
}

describe('buildPrompt — plain work order', () => {
  it('renders the task title, description, and fresh-branch instructions', () => {
    const prompt = buildPrompt(baseWorkOrder());
    expect(prompt).toContain('# Task: Add OAuth login');
    expect(prompt).toContain('Implements /login endpoint.');
    expect(prompt).toContain('Acceptance Criteria');
    expect(prompt).toContain('Work on branch: ouija/inst-1');
    expect(prompt).toContain('open a pull request');
    expect(prompt).not.toContain('Review feedback');
  });
});

describe('buildPrompt — review loop iteration', () => {
  const withReview: WorkOrder = {
    ...baseWorkOrder(),
    reviewContext: {
      iteration: 2,
      prUrl: 'https://github.com/acme/backend/pull/42',
      prId: 'acme/backend#42',
      reviews: [
        {
          reviewerLogin: 'coderabbitai[bot]',
          state: 'changes_requested',
          body: 'Two things to address:\n- the regex is too permissive\n- missing error handling',
          submittedAt: '2026-04-20T14:32:10Z',
        },
      ],
      comments: [
        {
          reviewerLogin: 'coderabbitai[bot]',
          body: 'Prefer zod here.',
          path: 'src/auth/validator.ts',
          line: 23,
          postedAt: '2026-04-20T14:32:12Z',
        },
        {
          reviewerLogin: 'muhammadkh4n',
          body: '@rex-coder please also cover the refresh-token path.',
          postedAt: '2026-04-20T15:10:00Z',
        },
      ],
    },
  };

  it('includes the PR URL and iteration number in the review heading', () => {
    const prompt = buildPrompt(withReview);
    expect(prompt).toContain('## Review feedback (iteration 2)');
    expect(prompt).toContain('https://github.com/acme/backend/pull/42');
  });

  it('renders the review body with reviewer login and state', () => {
    const prompt = buildPrompt(withReview);
    expect(prompt).toContain('**@coderabbitai[bot]** (changes requested)');
    expect(prompt).toContain('the regex is too permissive');
  });

  it('renders inline comments with path:line location', () => {
    const prompt = buildPrompt(withReview);
    expect(prompt).toContain('**@coderabbitai[bot]** (src/auth/validator.ts:23)');
    expect(prompt).toContain('Prefer zod here.');
  });

  it('renders top-level (non-inline) comments with "conversation" location', () => {
    const prompt = buildPrompt(withReview);
    expect(prompt).toContain('**@muhammadkh4n** (conversation)');
    expect(prompt).toContain('@rex-coder please also cover');
  });

  it('swaps the instructions to reuse the branch + existing PR', () => {
    const prompt = buildPrompt(withReview);
    expect(prompt).toContain('Check out existing branch: ouija/inst-1');
    expect(prompt).toContain('Do NOT open a new PR');
    expect(prompt).not.toContain('open a pull request against the base branch');
  });
});

describe('buildPrompt — CI failures in reviewContext', () => {
  const baseCtx = {
    iteration: 2,
    prUrl: 'https://github.com/acme/backend/pull/42',
    prId: 'acme/backend#42',
    reviews: [],
    comments: [],
  };

  it('renders a CI failures section above reviews when ciFailures is populated', () => {
    const wo: WorkOrder = {
      ...baseWorkOrder(),
      reviewContext: {
        ...baseCtx,
        ciFailures: [
          {
            workflowName: 'CI',
            jobName: 'unit-tests',
            conclusion: 'failure',
            logsUrl: 'https://github.com/acme/backend/actions/runs/9900/job/8800',
            summary: '3 tests failed in auth.test.ts',
            completedAt: '2026-04-21T09:12:34Z',
          },
        ],
      },
    };
    const prompt = buildPrompt(wo);
    expect(prompt).toContain('### ❌ Failing CI (fix these BEFORE re-running)');
    expect(prompt).toContain('**CI / unit-tests** (failure)');
    expect(prompt).toContain('logs: https://github.com/acme/backend/actions');
    expect(prompt).toContain('3 tests failed');
  });

  it('renders multiple CI failures as a bullet list', () => {
    const wo: WorkOrder = {
      ...baseWorkOrder(),
      reviewContext: {
        ...baseCtx,
        ciFailures: [
          { workflowName: 'CI', jobName: 'unit', conclusion: 'failure', completedAt: '2026-04-21T09:00:00Z' },
          { workflowName: 'CI', jobName: 'lint', conclusion: 'timed_out', completedAt: '2026-04-21T09:05:00Z' },
        ],
      },
    };
    const prompt = buildPrompt(wo);
    expect(prompt).toContain('**CI / unit** (failure)');
    expect(prompt).toContain('**CI / lint** (timed out)');
  });

  it('omits the CI section when ciFailures is absent', () => {
    const wo: WorkOrder = {
      ...baseWorkOrder(),
      reviewContext: {
        ...baseCtx,
        reviews: [
          {
            reviewerLogin: 'human',
            state: 'changes_requested',
            body: 'fix',
            submittedAt: '2026-04-21T09:00:00Z',
          },
        ],
      },
    };
    const prompt = buildPrompt(wo);
    expect(prompt).not.toContain('Failing CI');
    expect(prompt).toContain('**@human**');
  });

  it('renders CI failures even when reviews and comments are empty (CI-only re-dispatch)', () => {
    const wo: WorkOrder = {
      ...baseWorkOrder(),
      reviewContext: {
        ...baseCtx,
        ciFailures: [
          { workflowName: 'CI', jobName: 'unit', conclusion: 'failure', completedAt: '2026-04-21T09:00:00Z' },
        ],
      },
    };
    const prompt = buildPrompt(wo);
    expect(prompt).toContain('Failing CI');
    expect(prompt).toContain('Review feedback (iteration 2)');
    expect(prompt).not.toContain('### Reviews');
    expect(prompt).not.toContain('### Inline + conversation comments');
  });
});
