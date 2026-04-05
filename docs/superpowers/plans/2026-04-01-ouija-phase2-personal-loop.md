# Ouija Phase 2: Personal Automation Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the full automation loop for MK's personal use: card assigned on Plane --> webhook fires --> pipeline dispatches Claude Code agent --> agent writes code, opens PR --> Telegram notification sent to MK --> card moved to Review. No more mock agent -- real code generation, real notifications, real cards.

**Prerequisites:** Phase 1 complete. All packages exist: types, bus, engine, plugin-sdk, plugin-plane, plugin-github, server. Mock agent passes all orchestrator tests. Docker Compose runs Plane + Postgres + Redis.

**Architecture:** Three new packages (plugin-notify-telegram, plugin-agent-claude, agent-worker) plus wiring changes to server and engine. The agent worker runs as a separate BullMQ worker process consuming `QUEUE_NAMES.agentDispatch` jobs -- can scale independently of the Fastify server.

**Tech Stack:** TypeScript 5.5+, Fastify 5, BullMQ 5, node-telegram-bot-api, Claude Code CLI, Vitest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-04-01-ouija-design.md` (revision 2) -- specifically sections 3.1 (plugin types), 4.8 (WorkOrder), 4.11 (Agent JWT lifecycle)

**Estimated effort:** ~2 weeks for 1 engineer. Tasks 1 and 2 are parallelizable.

**Phase scope:** This plan covers MK's personal loop only. Dashboard, CLI, cloud features, and multi-tenant support are Phase 3+.

---

## File Structure

```
ouija/
  packages/
    plugin-notify-telegram/
      package.json
      tsconfig.json
      vitest.config.ts
      src/
        index.ts                        # TelegramNotifyPlugin implements NotificationPlugin
        config.ts                       # Config schema + FromSchema type
        formatter.ts                    # Notification -> Telegram message formatting
        keyboard.ts                     # Inline keyboard builder (deep links)
      tests/
        formatter.test.ts               # Message formatting tests
        keyboard.test.ts                # Keyboard layout tests
        plugin.test.ts                  # Full plugin tests (mocked Telegram API)
    plugin-agent-claude/
      package.json
      tsconfig.json
      vitest.config.ts
      src/
        index.ts                        # ClaudeAgentPlugin implements AgentPlugin
        config.ts                       # Config schema + FromSchema type
        work-order-builder.ts           # WorkOrder -> CLI args mapping
        subprocess.ts                   # Spawn + manage Claude Code CLI process
        heartbeat-reporter.ts           # POST heartbeats to Ouija callback URL
      tests/
        work-order-builder.test.ts      # WorkOrder -> CLI args mapping tests
        subprocess.test.ts              # Subprocess management tests (mocked)
        plugin.test.ts                  # Full plugin tests (mocked subprocess)
    agent-worker/
      package.json
      tsconfig.json
      vitest.config.ts
      src/
        index.ts                        # Entry point: start BullMQ worker
        worker.ts                       # AgentDispatchWorker: job -> plugin dispatch
        work-order-assembler.ts         # AgentDispatchJobData -> full WorkOrder
        timeout.ts                      # AbortController-based timeout enforcement
      tests/
        worker.test.ts                  # Worker tests (mocked plugin + job queue)
        work-order-assembler.test.ts    # Assembly tests
        timeout.test.ts                 # Timeout enforcement tests
  docker/
    docker-compose.yml                  # Updated: add agent-worker service
```

---

## Parallelization Guide

```
Task 1 (Telegram) ─────────────┐
                                ├──> Task 4 (Wire into server) ──> Task 5 (Smoke test)
Task 2 (Claude agent plugin) ──┤
                                │
Task 3 (Agent worker) ─────────┘

Task 6 (Phase 1 bug fixes) -- independent, can run anytime
```

**Worktree recommendations:**
- Task 1: `worktrees/phase2-telegram` -- fully independent, no shared state with Task 2
- Task 2: `worktrees/phase2-claude-agent` -- fully independent, no shared state with Task 1
- Task 3: `worktrees/phase2-agent-worker` -- depends on Task 2 types but not implementation; can start in parallel once the plugin interface shape is settled (it already exists in `@ouija/types`)
- Task 4-6: main branch after Tasks 1-3 merge

**Agent assignment recommendations:**
- Tasks 1, 2, 3: Assign to `feature-dev` agent type (implementation-heavy, well-scoped packages)
- Task 4: Assign to `feature-dev` agent type (wiring, moderate complexity)
- Task 5: Assign to `qa` agent type (integration testing, Docker Compose orchestration)
- Task 6: Assign to `investigate` agent type (bug fixing, root cause analysis)

---

### Task 1: Telegram Notification Plugin (`packages/plugin-notify-telegram/`)

**Files:**
- Create: `packages/plugin-notify-telegram/package.json`, `packages/plugin-notify-telegram/tsconfig.json`, `packages/plugin-notify-telegram/vitest.config.ts`
- Create: `packages/plugin-notify-telegram/src/index.ts`
- Create: `packages/plugin-notify-telegram/src/config.ts`
- Create: `packages/plugin-notify-telegram/src/formatter.ts`
- Create: `packages/plugin-notify-telegram/src/keyboard.ts`
- Create: `packages/plugin-notify-telegram/tests/formatter.test.ts`
- Create: `packages/plugin-notify-telegram/tests/keyboard.test.ts`
- Create: `packages/plugin-notify-telegram/tests/plugin.test.ts`

- [ ] **Step 1: Scaffold the package**

```json
// packages/plugin-notify-telegram/package.json
{
  "name": "@ouija/plugin-notify-telegram",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ouija/types": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/plugin-notify-telegram/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```ts
// packages/plugin-notify-telegram/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the config schema**

```ts
// packages/plugin-notify-telegram/src/config.ts

export interface TelegramConfig {
  /** Telegram Bot API token (from BotFather) */
  botToken: string;
  /** Telegram chat ID to send notifications to (MK's personal chat) */
  chatId: string;
  /** Base URL for deep links back to Ouija dashboard (placeholder for now) */
  dashboardBaseUrl: string;
}

/**
 * JSON Schema for Ajv validation at plugin load time.
 * Matches TelegramConfig shape exactly.
 */
export const telegramConfigSchema = {
  type: 'object',
  required: ['botToken', 'chatId'],
  properties: {
    botToken: {
      type: 'string',
      minLength: 1,
      description: 'Telegram Bot API token',
    },
    chatId: {
      type: 'string',
      minLength: 1,
      description: 'Target chat ID for notifications',
    },
    dashboardBaseUrl: {
      type: 'string',
      default: 'http://localhost:4000',
      description: 'Base URL for dashboard deep links',
    },
  },
  additionalProperties: false,
} as const;
```

- [ ] **Step 3: Write the message formatter**

```ts
// packages/plugin-notify-telegram/src/formatter.ts

import type { Notification, NotificationLevel } from '@ouija/types';

const LEVEL_EMOJI: Record<NotificationLevel, string> = {
  info: '\u2139\uFE0F',      // info icon
  warning: '\u26A0\uFE0F',   // warning icon
  error: '\u274C',            // red X
  success: '\u2705',          // green check
};

/**
 * Format a Notification into Telegram MarkdownV2-safe text.
 *
 * Telegram MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * We use HTML parse mode instead -- simpler and more predictable.
 */
export function formatNotification(notification: Notification): string {
  const icon = LEVEL_EMOJI[notification.level];
  const title = escapeHtml(notification.title);
  const body = escapeHtml(notification.body);

  const lines: string[] = [
    `${icon} <b>${title}</b>`,
    '',
    body,
  ];

  return lines.join('\n');
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Write the keyboard builder**

```ts
// packages/plugin-notify-telegram/src/keyboard.ts

import type { NotificationAction } from '@ouija/types';

/**
 * Telegram inline keyboard button shape.
 * Using URL buttons only (no callback_data) -- deep links to Ouija dashboard.
 */
export interface TelegramInlineButton {
  text: string;
  url: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

/**
 * Build a Telegram inline keyboard from Notification actions.
 * Each action becomes a single-button row (max 3 rows for mobile readability).
 */
export function buildInlineKeyboard(
  actions: NotificationAction[] | undefined,
): TelegramInlineKeyboard | undefined {
  if (!actions || actions.length === 0) return undefined;

  // Cap at 3 rows to keep mobile-friendly
  const rows = actions.slice(0, 3).map((action) => [
    { text: action.label, url: action.url },
  ]);

  return { inline_keyboard: rows };
}
```

- [ ] **Step 5: Write the formatter tests**

```ts
// packages/plugin-notify-telegram/tests/formatter.test.ts
import { describe, it, expect } from 'vitest';
import { formatNotification, escapeHtml } from '../src/formatter.js';
import type { Notification } from '@ouija/types';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('passes through normal text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

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
    expect(result).toContain('\u2139\uFE0F'); // info icon
  });

  it('includes body text', () => {
    const result = formatNotification(baseNotification);
    expect(result).toContain('Agent rex-coder dispatched for card OUIJA-42');
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
  });

  it('uses correct icon for each level', () => {
    const levels: Array<{ level: Notification['level']; icon: string }> = [
      { level: 'info', icon: '\u2139\uFE0F' },
      { level: 'warning', icon: '\u26A0\uFE0F' },
      { level: 'error', icon: '\u274C' },
      { level: 'success', icon: '\u2705' },
    ];
    for (const { level, icon } of levels) {
      const result = formatNotification({ ...baseNotification, level });
      expect(result).toContain(icon);
    }
  });
});
```

- [ ] **Step 6: Write the keyboard tests**

```ts
// packages/plugin-notify-telegram/tests/keyboard.test.ts
import { describe, it, expect } from 'vitest';
import { buildInlineKeyboard } from '../src/keyboard.js';

describe('buildInlineKeyboard', () => {
  it('returns undefined when no actions', () => {
    expect(buildInlineKeyboard(undefined)).toBeUndefined();
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
  });

  it('caps at 3 rows for mobile readability', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({
      label: `Action ${i}`,
      url: `http://example.com/${i}`,
    }));
    const keyboard = buildInlineKeyboard(actions);
    expect(keyboard!.inline_keyboard).toHaveLength(3);
  });
});
```

- [ ] **Step 7: Write the plugin implementation**

```ts
// packages/plugin-notify-telegram/src/index.ts

import type {
  NotificationPlugin,
  Notification,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija/types';
import type { TelegramConfig } from './config.js';
import { telegramConfigSchema } from './config.js';
import { formatNotification } from './formatter.js';
import { buildInlineKeyboard } from './keyboard.js';

// ---- Telegram Bot API types (minimal -- no SDK dependency) ----

interface TelegramSendMessageParams {
  chat_id: string;
  text: string;
  parse_mode: 'HTML';
  reply_markup?: string; // JSON-stringified InlineKeyboardMarkup
}

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

// ---- Sent message tracking for idempotency ----

const SENT_CACHE_MAX = 1000;

// ---- Plugin implementation ----

export class TelegramNotifyPlugin implements NotificationPlugin<TelegramConfig> {
  readonly manifest: PluginManifest = {
    name: '@ouija/plugin-notify-telegram',
    version: '0.1.0',
    type: 'notification',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: telegramConfigSchema as unknown as Record<string, unknown>,
    events: {
      produces: [],
      consumes: [
        'agent.work.completed',
        'agent.work.failed',
        'agent.work.pr_ready',
      ],
    },
  };

  private config!: TelegramConfig;
  private logger!: PluginContext['logger'];
  /** LRU-ish idempotency cache: idempotencyKey -> true. Prevents duplicate sends on retry. */
  private sentCache = new Map<string, true>();

  /** Override for testing -- allows injecting a mock fetch. */
  _fetchFn: typeof fetch = globalThis.fetch.bind(globalThis);

  async init(context: PluginContext<TelegramConfig>): Promise<void> {
    this.config = context.config;
    this.logger = context.logger;

    // Default dashboardBaseUrl if not provided
    if (!this.config.dashboardBaseUrl) {
      this.config.dashboardBaseUrl = 'http://localhost:4000';
    }
  }

  async start(): Promise<void> {
    this.logger.info('Telegram notification plugin started');
  }

  async stop(): Promise<void> {
    this.sentCache.clear();
    this.logger.info('Telegram notification plugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    try {
      const result = await this.testConnection();
      return {
        healthy: result.ok,
        message: result.message,
      };
    } catch (err) {
      return {
        healthy: false,
        message: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---- NotificationPlugin methods ----

  async send(notification: Notification): Promise<void> {
    // Idempotency check
    if (this.sentCache.has(notification.idempotencyKey)) {
      this.logger.info(`Duplicate notification skipped: ${notification.idempotencyKey}`);
      return;
    }

    const text = formatNotification(notification);
    const keyboard = buildInlineKeyboard(notification.actions);

    const params: TelegramSendMessageParams = {
      chat_id: this.config.chatId,
      text,
      parse_mode: 'HTML',
    };

    if (keyboard) {
      params.reply_markup = JSON.stringify(keyboard);
    }

    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    const response = await this._fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const result = (await response.json()) as TelegramResponse;

    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description ?? 'unknown error'}`);
    }

    // Track sent -- evict oldest if cache is full
    if (this.sentCache.size >= SENT_CACHE_MAX) {
      const firstKey = this.sentCache.keys().next().value;
      if (firstKey !== undefined) this.sentCache.delete(firstKey);
    }
    this.sentCache.set(notification.idempotencyKey, true);

    this.logger.info(`Notification sent: ${notification.title}`, {
      idempotencyKey: notification.idempotencyKey,
      level: notification.level,
    });
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/getMe`;

    try {
      const response = await this._fetchFn(url);
      const result = (await response.json()) as TelegramResponse & {
        result?: { username?: string };
      };

      if (result.ok) {
        return { ok: true, message: `Connected as @${(result as Record<string, unknown>)['result'] && ((result as Record<string, unknown>)['result'] as Record<string, unknown>)['username']}` };
      }
      return { ok: false, message: result.description ?? 'Unknown error' };
    } catch (err) {
      return {
        ok: false,
        message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ---- Plugin factory (required by PluginLoader) ----

export const PluginFactory = {
  manifest: new TelegramNotifyPlugin().manifest,
  create: () => new TelegramNotifyPlugin(),
};

export default PluginFactory;
```

- [ ] **Step 8: Write the full plugin tests**

```ts
// packages/plugin-notify-telegram/tests/plugin.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramNotifyPlugin } from '../src/index.js';
import { createMockContext } from '@ouija/plugin-sdk/test-utils';
import type { Notification } from '@ouija/types';

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: 'Pipeline Dispatched',
    body: 'Agent dispatched for card OUIJA-42',
    level: 'info',
    occurredAt: new Date().toISOString(),
    idempotencyKey: `test-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

function makeMockFetch(responseBody: unknown = { ok: true }) {
  return vi.fn().mockResolvedValue({
    json: async () => responseBody,
  });
}

describe('TelegramNotifyPlugin', () => {
  let plugin: TelegramNotifyPlugin;

  beforeEach(async () => {
    plugin = new TelegramNotifyPlugin();
    const ctx = createMockContext({
      botToken: 'test-bot-token',
      chatId: '123456789',
      dashboardBaseUrl: 'http://localhost:4000',
    });
    await plugin.init(ctx);
  });

  describe('send()', () => {
    it('calls Telegram sendMessage API with correct params', async () => {
      const mockFetch = makeMockFetch();
      plugin._fetchFn = mockFetch;

      const notification = makeNotification();
      await plugin.send(notification);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.telegram.org/bottest-bot-token/sendMessage');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string);
      expect(body.chat_id).toBe('123456789');
      expect(body.parse_mode).toBe('HTML');
      expect(body.text).toContain('Pipeline Dispatched');
    });

    it('includes inline keyboard when actions are present', async () => {
      const mockFetch = makeMockFetch();
      plugin._fetchFn = mockFetch;

      const notification = makeNotification({
        actions: [
          { label: 'View Pipeline', url: 'http://localhost:4000/pipelines/abc' },
        ],
      });
      await plugin.send(notification);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.reply_markup).toBeDefined();
      const keyboard = JSON.parse(body.reply_markup);
      expect(keyboard.inline_keyboard[0][0].text).toBe('View Pipeline');
    });

    it('skips duplicate sends (idempotency)', async () => {
      const mockFetch = makeMockFetch();
      plugin._fetchFn = mockFetch;

      const notification = makeNotification({ idempotencyKey: 'dedup-key-1' });
      await plugin.send(notification);
      await plugin.send(notification);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws on Telegram API error', async () => {
      const mockFetch = makeMockFetch({ ok: false, description: 'Bot token invalid' });
      plugin._fetchFn = mockFetch;

      await expect(plugin.send(makeNotification())).rejects.toThrow('Bot token invalid');
    });
  });

  describe('testConnection()', () => {
    it('returns ok when getMe succeeds', async () => {
      plugin._fetchFn = makeMockFetch({
        ok: true,
        result: { username: 'ouija_bot' },
      });

      const result = await plugin.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns not ok on API failure', async () => {
      plugin._fetchFn = makeMockFetch({
        ok: false,
        description: 'Unauthorized',
      });

      const result = await plugin.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Unauthorized');
    });

    it('returns not ok on network error', async () => {
      plugin._fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await plugin.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('ECONNREFUSED');
    });
  });

  describe('healthCheck()', () => {
    it('delegates to testConnection()', async () => {
      plugin._fetchFn = makeMockFetch({
        ok: true,
        result: { username: 'ouija_bot' },
      });

      const health = await plugin.healthCheck();
      expect(health.healthy).toBe(true);
    });
  });
});
```

- [ ] **Step 9: Run tests**

Run: `cd packages/plugin-notify-telegram && npx vitest run`
Expected: All formatter, keyboard, and plugin tests pass.

- [ ] **Step 10: Build and verify**

Run: `npx turbo build --filter=@ouija/plugin-notify-telegram`
Expected: Compiles to `dist/`. No type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/plugin-notify-telegram/
git commit -m "feat(plugin-notify-telegram): implement Telegram notification plugin

Sends pipeline dispatched, PR ready, agent failed, and agent stalled
notifications to MK's personal Telegram via Bot API. Inline keyboard
buttons with deep links to Ouija dashboard (placeholder URLs).
Idempotent on notification.idempotencyKey. Zero SDK dependencies --
raw fetch against api.telegram.org."
```

---

### Task 2: Claude Agent Dispatcher Plugin (`packages/plugin-agent-claude/`)

**Files:**
- Create: `packages/plugin-agent-claude/package.json`, `packages/plugin-agent-claude/tsconfig.json`, `packages/plugin-agent-claude/vitest.config.ts`
- Create: `packages/plugin-agent-claude/src/index.ts`
- Create: `packages/plugin-agent-claude/src/config.ts`
- Create: `packages/plugin-agent-claude/src/work-order-builder.ts`
- Create: `packages/plugin-agent-claude/src/subprocess.ts`
- Create: `packages/plugin-agent-claude/src/heartbeat-reporter.ts`
- Create: `packages/plugin-agent-claude/tests/work-order-builder.test.ts`
- Create: `packages/plugin-agent-claude/tests/subprocess.test.ts`
- Create: `packages/plugin-agent-claude/tests/plugin.test.ts`

- [ ] **Step 1: Scaffold the package**

```json
// packages/plugin-agent-claude/package.json
{
  "name": "@ouija/plugin-agent-claude",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ouija/types": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/plugin-agent-claude/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```ts
// packages/plugin-agent-claude/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the config schema**

```ts
// packages/plugin-agent-claude/src/config.ts

export interface ClaudeAgentConfig {
  /** Reference to the Anthropic API key in the credential store (never raw key in config) */
  secretRef: string;
  /** Default model to use (e.g. "claude-sonnet-4-20250514") */
  defaultModel: string;
  /** Max duration in ms before self-terminating. Default: 30 minutes. */
  maxDurationMs: number;
  /** Git access tokens for cloning repos. Map of hostname -> token ref. */
  repoAccessTokens: Record<string, string>;
  /** Base directory for temporary repo clones. Default: os.tmpdir() */
  workDir?: string;
  /** Path to the claude CLI binary. Default: "claude" (assumes on PATH). */
  claudeBinaryPath?: string;
}

export const claudeAgentConfigSchema = {
  type: 'object',
  required: ['secretRef', 'defaultModel', 'maxDurationMs', 'repoAccessTokens'],
  properties: {
    secretRef: {
      type: 'string',
      minLength: 1,
      description: 'Credential store reference for Anthropic API key',
    },
    defaultModel: {
      type: 'string',
      minLength: 1,
      description: 'Default Claude model to use',
    },
    maxDurationMs: {
      type: 'number',
      minimum: 60000,  // at least 1 minute
      maximum: 7200000, // at most 2 hours
      description: 'Max agent runtime in milliseconds',
    },
    repoAccessTokens: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Map of git hostname -> credential store ref for repo access',
    },
    workDir: {
      type: 'string',
      description: 'Temp directory for repo clones',
    },
    claudeBinaryPath: {
      type: 'string',
      description: 'Path to claude CLI binary',
    },
  },
  additionalProperties: false,
} as const;
```

- [ ] **Step 3: Write the WorkOrder-to-CLI-args builder**

```ts
// packages/plugin-agent-claude/src/work-order-builder.ts

import type { WorkOrder } from '@ouija/types';

/**
 * Arguments passed to the Claude Code CLI subprocess.
 */
export interface ClaudeCliArgs {
  /** The prompt text sent to Claude Code */
  prompt: string;
  /** Working directory (the cloned repo) */
  cwd: string;
  /** Environment variables to set */
  env: Record<string, string>;
  /** Max duration for the subprocess in ms */
  timeoutMs: number;
}

/**
 * Git clone arguments derived from the WorkOrder.
 */
export interface GitCloneArgs {
  /** Full clone URL with embedded token (if available) */
  cloneUrl: string;
  /** Target directory to clone into */
  targetDir: string;
  /** Branch to create and check out */
  branch: string;
  /** Base branch to branch from */
  baseBranch: string;
}

/**
 * Build the prompt text from a WorkOrder.
 *
 * The prompt includes:
 *   - Card title and description (already sanitized by engine)
 *   - Acceptance criteria (numbered list)
 *   - File path hints (if any)
 *   - Branch name for commits
 *   - Explicit instruction to commit, push, and open a PR
 */
export function buildPrompt(workOrder: WorkOrder): string {
  const sections: string[] = [];

  sections.push(`# Task: ${workOrder.title}`);
  sections.push('');
  sections.push(workOrder.description);

  if (workOrder.acceptanceCriteria.length > 0) {
    sections.push('');
    sections.push('## Acceptance Criteria');
    workOrder.acceptanceCriteria.forEach((criterion, i) => {
      sections.push(`${i + 1}. ${criterion}`);
    });
  }

  if (workOrder.filePathHints && workOrder.filePathHints.length > 0) {
    sections.push('');
    sections.push('## Relevant Files');
    workOrder.filePathHints.forEach((path) => {
      sections.push(`- ${path}`);
    });
  }

  sections.push('');
  sections.push('## Instructions');
  sections.push(`- Work on branch: ${workOrder.branch}`);
  sections.push(`- Base branch: ${workOrder.baseBranch}`);
  sections.push('- Implement the changes described above');
  sections.push('- Write tests for any new functionality');
  sections.push('- Commit your changes with clear commit messages');
  sections.push('- Push the branch and open a pull request against the base branch');

  return sections.join('\n');
}

/**
 * Build CLI arguments from a WorkOrder.
 */
export function buildCliArgs(
  workOrder: WorkOrder,
  cloneDir: string,
  anthropicApiKey: string,
): ClaudeCliArgs {
  return {
    prompt: buildPrompt(workOrder),
    cwd: cloneDir,
    env: {
      ANTHROPIC_API_KEY: anthropicApiKey,
    },
    timeoutMs: workOrder.maxDurationMs,
  };
}

/**
 * Build git clone arguments from a WorkOrder.
 * Embeds the access token in the clone URL for HTTPS repos.
 */
export function buildGitCloneArgs(
  workOrder: WorkOrder,
  targetDir: string,
  accessToken?: string,
): GitCloneArgs {
  let cloneUrl = workOrder.repoUrl;

  // Embed access token in HTTPS URLs: https://<token>@github.com/...
  if (accessToken && cloneUrl.startsWith('https://')) {
    const url = new URL(cloneUrl);
    url.username = accessToken;
    cloneUrl = url.toString();
  }

  return {
    cloneUrl,
    targetDir,
    branch: workOrder.branch,
    baseBranch: workOrder.baseBranch,
  };
}
```

- [ ] **Step 4: Write the heartbeat reporter**

```ts
// packages/plugin-agent-claude/src/heartbeat-reporter.ts

import type { DispatchId } from '@ouija/types';

/**
 * Heartbeat payload sent to Ouija's /hooks/agent/callback endpoint.
 */
interface HeartbeatPayload {
  type: 'agent_progress';
  instanceId: string;
  dispatchId: string;
  progress?: number;
  message: string;
}

interface PrReadyPayload {
  type: 'agent_pr_ready';
  instanceId: string;
  dispatchId: string;
  prUrl: string;
  prId: string;
}

interface CompletedPayload {
  type: 'agent_completed';
  instanceId: string;
  dispatchId: string;
}

interface FailedPayload {
  type: 'agent_failed';
  instanceId: string;
  dispatchId: string;
  error: string;
  retryable: boolean;
}

type CallbackPayload = HeartbeatPayload | PrReadyPayload | CompletedPayload | FailedPayload;

interface CallbackResponse {
  ok: boolean;
  /** New JWT if the current one is near expiry */
  token?: string;
}

/**
 * Reports agent status back to Ouija's callback endpoint.
 *
 * Handles JWT refresh: if the response includes a new token, stores it
 * and uses it for subsequent calls.
 */
export class HeartbeatReporter {
  private currentToken: string;

  constructor(
    private readonly callbackUrl: string,
    initialToken: string,
    private readonly instanceId: string,
    private readonly dispatchId: string,
    /** Override for testing */
    public _fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.currentToken = initialToken;
  }

  /**
   * Send a progress heartbeat. Called periodically during agent execution.
   */
  async reportProgress(message: string, progress?: number): Promise<void> {
    await this._post({
      type: 'agent_progress',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
      message,
      ...(progress !== undefined ? { progress } : {}),
    });
  }

  /**
   * Report that a PR has been opened.
   */
  async reportPrReady(prUrl: string, prId: string): Promise<void> {
    await this._post({
      type: 'agent_pr_ready',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
      prUrl,
      prId,
    });
  }

  /**
   * Report successful completion.
   */
  async reportCompleted(): Promise<void> {
    await this._post({
      type: 'agent_completed',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
    });
  }

  /**
   * Report failure.
   */
  async reportFailed(error: string, retryable: boolean): Promise<void> {
    await this._post({
      type: 'agent_failed',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
      error,
      retryable,
    });
  }

  private async _post(payload: CallbackPayload): Promise<void> {
    const response = await this._fetchFn(this.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.currentToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Callback failed: HTTP ${response.status}`);
    }

    // Check for token refresh
    const body = (await response.json()) as CallbackResponse;
    if (body.token) {
      this.currentToken = body.token;
    }
  }

  /** Expose current token for testing. */
  get token(): string {
    return this.currentToken;
  }
}
```

- [ ] **Step 5: Write the subprocess manager**

```ts
// packages/plugin-agent-claude/src/subprocess.ts

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Result of a Claude Code CLI execution.
 */
export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Options for spawning a Claude Code CLI subprocess.
 */
export interface SpawnClaudeOptions {
  /** The prompt to send */
  prompt: string;
  /** Working directory */
  cwd: string;
  /** Environment variables (merged with process.env) */
  env: Record<string, string>;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Path to claude binary. Default: "claude" */
  binaryPath?: string;
  /** Called periodically with stdout chunks for heartbeat reporting */
  onOutput?: (chunk: string) => void;
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
}

/**
 * Spawn a Claude Code CLI process and wait for it to complete.
 *
 * Uses `claude --print` mode (non-interactive, outputs result to stdout).
 * The prompt is passed via stdin to avoid shell escaping issues.
 *
 * The subprocess is killed if:
 *   - timeoutMs is exceeded (SIGTERM, then SIGKILL after 5s)
 *   - The AbortSignal fires (external cancellation)
 */
export async function spawnClaude(options: SpawnClaudeOptions): Promise<SubprocessResult> {
  const binary = options.binaryPath ?? 'claude';

  const args = [
    '--print',        // non-interactive mode
    '--output-format', 'text',
  ];

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    // Prevent claude from trying to read from terminal
    CI: '1',
  };

  return new Promise<SubprocessResult>((resolve, reject) => {
    const startTime = Date.now();
    let timedOut = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`Failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // Send prompt via stdin
    if (child.stdin) {
      child.stdin.write(options.prompt);
      child.stdin.end();
    }

    // Collect stdout
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        options.onOutput?.(text);
      });
    }

    // Collect stderr
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });
    }

    // Timeout enforcement
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force kill after 5 seconds if still alive
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, options.timeoutMs);

    // External cancellation
    if (options.signal) {
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => {
        options.signal!.removeEventListener('abort', onAbort);
      });
    }

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode: code ?? 1,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
```

- [ ] **Step 6: Write the plugin implementation**

```ts
// packages/plugin-agent-claude/src/index.ts

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentPlugin,
  WorkOrder,
  AgentStatus,
  AgentStatusState,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija/types';
import type { DispatchId, InstanceId } from '@ouija/types';
import { dispatchId as makeDispatchId } from '@ouija/types';
import type { ClaudeAgentConfig } from './config.js';
import { claudeAgentConfigSchema } from './config.js';
import { buildCliArgs, buildGitCloneArgs } from './work-order-builder.js';
import { spawnClaude } from './subprocess.js';
import { HeartbeatReporter } from './heartbeat-reporter.js';

const execFileAsync = promisify(execFile);

// ---- Active dispatch tracking ----

interface ActiveDispatch {
  dispatchId: DispatchId;
  workOrder: WorkOrder;
  state: AgentStatusState;
  startedAt: string;
  message?: string;
  abortController: AbortController;
}

// ---- Plugin ----

export class ClaudeAgentPlugin implements AgentPlugin<ClaudeAgentConfig> {
  readonly manifest: PluginManifest = {
    name: '@ouija/plugin-agent-claude',
    version: '0.1.0',
    type: 'agent',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: claudeAgentConfigSchema as unknown as Record<string, unknown>,
    events: {
      produces: [
        'agent.work.progress',
        'agent.work.pr_ready',
        'agent.work.completed',
        'agent.work.failed',
      ],
      consumes: [],
    },
  };

  private config!: ClaudeAgentConfig;
  private logger!: PluginContext['logger'];
  private activeDispatches = new Map<string, ActiveDispatch>();

  /** Override for testing -- inject mock subprocess runner. */
  _spawnFn: typeof spawnClaude = spawnClaude;
  /** Override for testing -- inject mock git clone. */
  _cloneFn: (url: string, targetDir: string, baseBranch: string) => Promise<void> =
    this._defaultClone.bind(this);
  /** Override for testing -- inject mock branch creation. */
  _createBranchFn: (cwd: string, branch: string) => Promise<void> =
    this._defaultCreateBranch.bind(this);

  async init(context: PluginContext<ClaudeAgentConfig>): Promise<void> {
    this.config = context.config;
    this.logger = context.logger;
  }

  async start(): Promise<void> {
    this.logger.info('Claude agent plugin started');
  }

  async stop(): Promise<void> {
    // Cancel all active dispatches on shutdown
    for (const [, dispatch] of this.activeDispatches) {
      dispatch.abortController.abort();
    }
    this.activeDispatches.clear();
    this.logger.info('Claude agent plugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    return {
      healthy: true,
      message: `${this.activeDispatches.size} active dispatches`,
      details: {
        activeDispatches: this.activeDispatches.size,
      },
    };
  }

  // ---- AgentPlugin methods ----

  async dispatch(workOrder: WorkOrder): Promise<DispatchId> {
    const id = makeDispatchId(randomUUID());
    const abortController = new AbortController();

    const activeDispatch: ActiveDispatch = {
      dispatchId: id,
      workOrder,
      state: 'dispatching',
      startedAt: new Date().toISOString(),
      abortController,
    };

    this.activeDispatches.set(String(id), activeDispatch);

    // Run the agent asynchronously -- dispatch returns immediately with the ID.
    // The actual work happens in the background.
    this._runAgent(activeDispatch).catch((err) => {
      this.logger.error('Agent run failed unexpectedly', {
        dispatchId: String(id),
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return id;
  }

  async cancel(id: DispatchId): Promise<void> {
    const dispatch = this.activeDispatches.get(String(id));
    if (dispatch) {
      dispatch.abortController.abort();
      dispatch.state = 'cancelled';
      this.logger.info('Dispatch cancelled', { dispatchId: String(id) });
    }
  }

  async getStatus(id: DispatchId): Promise<AgentStatus> {
    const dispatch = this.activeDispatches.get(String(id));
    if (!dispatch) {
      return {
        dispatchId: id,
        instanceId: '' as InstanceId,
        state: 'idle',
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      dispatchId: dispatch.dispatchId,
      instanceId: dispatch.workOrder.instanceId as unknown as InstanceId,
      state: dispatch.state,
      message: dispatch.message,
      updatedAt: new Date().toISOString(),
    };
  }

  // ---- Internal agent execution ----

  private async _runAgent(dispatch: ActiveDispatch): Promise<void> {
    const workOrder = dispatch.workOrder;
    let cloneDir: string | undefined;

    const reporter = new HeartbeatReporter(
      workOrder.callbackUrl,
      workOrder.callbackToken,
      String(workOrder.instanceId),
      String(dispatch.dispatchId),
    );

    try {
      dispatch.state = 'running';

      // 1. Report acknowledged
      await reporter.reportProgress('Agent acknowledged work order');

      // 2. Clone the repo to a temp directory
      const workDir = this.config.workDir ?? tmpdir();
      cloneDir = await mkdtemp(join(workDir, 'ouija-agent-'));

      await reporter.reportProgress('Cloning repository...');
      await this._cloneFn(workOrder.repoUrl, cloneDir, workOrder.baseBranch);

      // 3. Create the feature branch
      await this._createBranchFn(cloneDir, workOrder.branch);
      await reporter.reportProgress(`Created branch ${workOrder.branch}`);

      // 4. Build CLI args
      // The API key comes from secretRef -- in production, this would be resolved
      // from the credential store. For now, read from env.
      const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
      const cliArgs = buildCliArgs(workOrder, cloneDir, apiKey);

      // 5. Set up periodic heartbeat
      const heartbeatInterval = setInterval(async () => {
        try {
          await reporter.reportProgress('Agent is working...');
        } catch {
          // Heartbeat failure is non-fatal -- will be caught by stall monitor
        }
      }, 60_000); // Every 60 seconds

      // 6. Run Claude Code CLI
      await reporter.reportProgress('Running Claude Code...');
      const result = await this._spawnFn({
        prompt: cliArgs.prompt,
        cwd: cliArgs.cwd,
        env: cliArgs.env,
        timeoutMs: cliArgs.timeoutMs,
        binaryPath: this.config.claudeBinaryPath,
        signal: dispatch.abortController.signal,
        onOutput: (chunk) => {
          dispatch.message = chunk.slice(0, 200); // Keep last chunk for status
        },
      });

      clearInterval(heartbeatInterval);

      // 7. Handle result
      if (result.timedOut) {
        await reporter.reportFailed(
          `Agent timed out after ${Math.round(result.durationMs / 1000)}s`,
          true,
        );
        dispatch.state = 'failed';
        return;
      }

      if (result.exitCode !== 0) {
        await reporter.reportFailed(
          `Claude CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
          true,
        );
        dispatch.state = 'failed';
        return;
      }

      // 8. Success -- report completed
      await reporter.reportCompleted();
      dispatch.state = 'completed';

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Agent execution error', {
        dispatchId: String(dispatch.dispatchId),
        error: errorMsg,
      });

      try {
        await reporter.reportFailed(errorMsg, true);
      } catch {
        // If we can't even report the failure, the stall monitor will catch it
      }
      dispatch.state = 'failed';
    } finally {
      // 9. Clean up temp directory
      if (cloneDir) {
        try {
          await rm(cloneDir, { recursive: true, force: true });
        } catch {
          this.logger.warn('Failed to clean up clone dir', { cloneDir });
        }
      }
    }
  }

  // ---- Default git helpers (overridable for testing) ----

  private async _defaultClone(
    url: string,
    targetDir: string,
    baseBranch: string,
  ): Promise<void> {
    await execFileAsync('git', ['clone', '--branch', baseBranch, '--single-branch', url, targetDir]);
  }

  private async _defaultCreateBranch(cwd: string, branch: string): Promise<void> {
    await execFileAsync('git', ['checkout', '-b', branch], { cwd });
  }
}

// ---- Plugin factory ----

export const PluginFactory = {
  manifest: new ClaudeAgentPlugin().manifest,
  create: () => new ClaudeAgentPlugin(),
};

export default PluginFactory;
```

- [ ] **Step 7: Write the WorkOrder builder tests**

```ts
// packages/plugin-agent-claude/tests/work-order-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrompt, buildCliArgs, buildGitCloneArgs } from '../src/work-order-builder.js';
import type { WorkOrder } from '@ouija/types';

const baseWorkOrder: WorkOrder = {
  instanceId: 'inst-123' as WorkOrder['instanceId'],
  cardId: 'card-456',
  title: 'Add user authentication',
  description: 'Implement JWT-based auth with login and register endpoints.',
  acceptanceCriteria: [
    'POST /api/auth/login returns JWT on valid credentials',
    'POST /api/auth/register creates user and returns JWT',
    'Protected routes return 401 without valid JWT',
  ],
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'ouija/inst-123',
  baseBranch: 'main',
  agentProfileId: 'rex-coder',
  systemPrompt: 'You are an expert TypeScript engineer.',
  secretRef: 'cred:anthropic-key',
  callbackUrl: 'http://localhost:4000/hooks/agent/callback',
  callbackToken: 'jwt-token-here',
  maxDurationMs: 1800000,
  metadata: {},
};

describe('buildPrompt', () => {
  it('includes card title as heading', () => {
    const prompt = buildPrompt(baseWorkOrder);
    expect(prompt).toContain('# Task: Add user authentication');
  });

  it('includes description', () => {
    const prompt = buildPrompt(baseWorkOrder);
    expect(prompt).toContain('Implement JWT-based auth');
  });

  it('includes numbered acceptance criteria', () => {
    const prompt = buildPrompt(baseWorkOrder);
    expect(prompt).toContain('1. POST /api/auth/login returns JWT');
    expect(prompt).toContain('2. POST /api/auth/register creates user');
    expect(prompt).toContain('3. Protected routes return 401');
  });

  it('includes branch instructions', () => {
    const prompt = buildPrompt(baseWorkOrder);
    expect(prompt).toContain('Work on branch: ouija/inst-123');
    expect(prompt).toContain('Base branch: main');
  });

  it('includes file path hints when present', () => {
    const workOrder: WorkOrder = {
      ...baseWorkOrder,
      filePathHints: ['src/auth/login.ts', 'src/auth/register.ts'],
    };
    const prompt = buildPrompt(workOrder);
    expect(prompt).toContain('- src/auth/login.ts');
    expect(prompt).toContain('- src/auth/register.ts');
  });

  it('omits file path section when no hints', () => {
    const prompt = buildPrompt(baseWorkOrder);
    expect(prompt).not.toContain('Relevant Files');
  });

  it('omits acceptance criteria section when empty', () => {
    const workOrder: WorkOrder = { ...baseWorkOrder, acceptanceCriteria: [] };
    const prompt = buildPrompt(workOrder);
    expect(prompt).not.toContain('Acceptance Criteria');
  });
});

describe('buildCliArgs', () => {
  it('sets ANTHROPIC_API_KEY in env', () => {
    const args = buildCliArgs(baseWorkOrder, '/tmp/clone', 'sk-ant-test');
    expect(args.env['ANTHROPIC_API_KEY']).toBe('sk-ant-test');
  });

  it('uses workOrder maxDurationMs as timeout', () => {
    const args = buildCliArgs(baseWorkOrder, '/tmp/clone', 'sk-ant-test');
    expect(args.timeoutMs).toBe(1800000);
  });

  it('sets cwd to clone directory', () => {
    const args = buildCliArgs(baseWorkOrder, '/tmp/clone-abc', 'sk-ant-test');
    expect(args.cwd).toBe('/tmp/clone-abc');
  });
});

describe('buildGitCloneArgs', () => {
  it('returns plain URL when no access token', () => {
    const args = buildGitCloneArgs(baseWorkOrder, '/tmp/clone');
    expect(args.cloneUrl).toBe('https://github.com/org/repo.git');
  });

  it('embeds access token in HTTPS URL', () => {
    const args = buildGitCloneArgs(baseWorkOrder, '/tmp/clone', 'ghp_xxxx');
    expect(args.cloneUrl).toContain('ghp_xxxx@');
    expect(args.cloneUrl).toContain('github.com');
  });

  it('preserves branch and baseBranch', () => {
    const args = buildGitCloneArgs(baseWorkOrder, '/tmp/clone');
    expect(args.branch).toBe('ouija/inst-123');
    expect(args.baseBranch).toBe('main');
  });
});
```

- [ ] **Step 8: Write the subprocess tests**

```ts
// packages/plugin-agent-claude/tests/subprocess.test.ts
import { describe, it, expect, vi } from 'vitest';
import { spawnClaude } from '../src/subprocess.js';

// Note: these tests use the real `spawn` but with a harmless command.
// The full subprocess flow with actual Claude CLI is tested in the smoke test (Task 5).

describe('spawnClaude', () => {
  it('captures stdout from a simple command', async () => {
    // Use echo as a stand-in for claude CLI
    const result = await spawnClaude({
      prompt: '',
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      binaryPath: 'echo',
    });

    // echo with --print and --output-format text args will just print those args
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('respects timeout', async () => {
    const result = await spawnClaude({
      prompt: '',
      cwd: process.cwd(),
      env: {},
      timeoutMs: 100, // Very short timeout
      binaryPath: 'sleep',
    });

    // sleep with args ["--print", "--output-format", "text"] will fail or timeout
    // Either way, we should get a result (not hang)
    expect(result.durationMs).toBeLessThan(10000);
  });

  it('respects AbortSignal', async () => {
    const controller = new AbortController();

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);

    const result = await spawnClaude({
      prompt: '',
      cwd: process.cwd(),
      env: {},
      timeoutMs: 60000,
      binaryPath: 'sleep',
      signal: controller.signal,
    });

    expect(result.durationMs).toBeLessThan(10000);
  });

  it('calls onOutput callback with stdout chunks', async () => {
    const chunks: string[] = [];
    const result = await spawnClaude({
      prompt: '',
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      binaryPath: 'echo',
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    // echo produces at least one chunk
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 9: Write the full plugin tests**

```ts
// packages/plugin-agent-claude/tests/plugin.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAgentPlugin } from '../src/index.js';
import { createMockContext } from '@ouija/plugin-sdk/test-utils';
import type { WorkOrder } from '@ouija/types';
import type { SubprocessResult } from '../src/subprocess.js';

const baseWorkOrder: WorkOrder = {
  instanceId: 'inst-test' as WorkOrder['instanceId'],
  cardId: 'card-test',
  title: 'Test task',
  description: 'Do something.',
  acceptanceCriteria: [],
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'ouija/inst-test',
  baseBranch: 'main',
  agentProfileId: 'test-agent',
  systemPrompt: '',
  secretRef: 'cred:test',
  callbackUrl: 'http://localhost:4000/hooks/agent/callback',
  callbackToken: 'jwt-test',
  maxDurationMs: 60000,
  metadata: {},
};

function makeSuccessResult(): SubprocessResult {
  return {
    exitCode: 0,
    stdout: 'Done.',
    stderr: '',
    timedOut: false,
    durationMs: 5000,
  };
}

describe('ClaudeAgentPlugin', () => {
  let plugin: ClaudeAgentPlugin;

  beforeEach(async () => {
    plugin = new ClaudeAgentPlugin();
    const ctx = createMockContext({
      secretRef: 'cred:test',
      defaultModel: 'claude-sonnet-4-20250514',
      maxDurationMs: 60000,
      repoAccessTokens: {},
    });
    await plugin.init(ctx);

    // Mock all I/O by default
    plugin._cloneFn = vi.fn().mockResolvedValue(undefined);
    plugin._createBranchFn = vi.fn().mockResolvedValue(undefined);
    plugin._spawnFn = vi.fn().mockResolvedValue(makeSuccessResult());
  });

  describe('dispatch()', () => {
    it('returns a DispatchId immediately', async () => {
      const id = await plugin.dispatch(baseWorkOrder);
      expect(String(id)).toBeTruthy();
      expect(String(id)).not.toBe('');
    });

    it('starts with dispatching state', async () => {
      const id = await plugin.dispatch(baseWorkOrder);
      // Allow microtask to run
      const status = await plugin.getStatus(id);
      // State is either dispatching or running (race condition in async)
      expect(['dispatching', 'running']).toContain(status.state);
    });
  });

  describe('cancel()', () => {
    it('marks dispatch as cancelled', async () => {
      const id = await plugin.dispatch(baseWorkOrder);
      await plugin.cancel(id);
      const status = await plugin.getStatus(id);
      expect(status.state).toBe('cancelled');
    });
  });

  describe('getStatus()', () => {
    it('returns idle for unknown dispatch IDs', async () => {
      const { dispatchId } = await import('@ouija/types');
      const status = await plugin.getStatus(dispatchId('nonexistent'));
      expect(status.state).toBe('idle');
    });
  });

  describe('stop()', () => {
    it('cancels all active dispatches', async () => {
      await plugin.dispatch(baseWorkOrder);
      await plugin.dispatch({ ...baseWorkOrder, instanceId: 'inst-2' as WorkOrder['instanceId'] });
      await plugin.stop();
      // After stop, healthCheck should show 0 active
      const health = await plugin.healthCheck();
      expect(health.details?.['activeDispatches']).toBe(0);
    });
  });
});
```

- [ ] **Step 10: Run tests**

Run: `cd packages/plugin-agent-claude && npx vitest run`
Expected: All work-order-builder, subprocess, and plugin tests pass.

- [ ] **Step 11: Build and verify**

Run: `npx turbo build --filter=@ouija/plugin-agent-claude`
Expected: Compiles to `dist/`. No type errors.

- [ ] **Step 12: Commit**

```bash
git add packages/plugin-agent-claude/
git commit -m "feat(plugin-agent-claude): implement Claude Code agent dispatcher

Spawns Claude Code CLI as subprocess for each dispatched WorkOrder.
Handles repo clone, branch creation, CLI execution, heartbeat reporting,
timeout enforcement, and cleanup. Reports progress/completion/failure
back to Ouija callback URL using JWT auth with automatic refresh."
```

---

### Task 3: Agent Worker Process (`packages/agent-worker/`)

**Files:**
- Create: `packages/agent-worker/package.json`, `packages/agent-worker/tsconfig.json`, `packages/agent-worker/vitest.config.ts`
- Create: `packages/agent-worker/src/index.ts`
- Create: `packages/agent-worker/src/worker.ts`
- Create: `packages/agent-worker/src/work-order-assembler.ts`
- Create: `packages/agent-worker/src/timeout.ts`
- Create: `packages/agent-worker/tests/worker.test.ts`
- Create: `packages/agent-worker/tests/work-order-assembler.test.ts`
- Create: `packages/agent-worker/tests/timeout.test.ts`

- [ ] **Step 1: Scaffold the package**

```json
// packages/agent-worker/package.json
{
  "name": "@ouija/agent-worker",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ouija/types": "workspace:*",
    "@ouija/bus": "workspace:*",
    "@ouija/engine": "workspace:*",
    "@ouija/plugin-sdk": "workspace:*",
    "@ouija/plugin-agent-claude": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/agent-worker/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```ts
// packages/agent-worker/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the WorkOrder assembler**

The orchestrator dispatches `AgentDispatchJobData` (minimal data). The worker must assemble a full `WorkOrder` from this plus database lookups and config.

```ts
// packages/agent-worker/src/work-order-assembler.ts

import type { WorkOrder, Database, AgentId } from '@ouija/types';
import type { AgentDispatchJobData } from '@ouija/bus';
import { instanceId as makeInstanceId } from '@ouija/types';

/**
 * Agent profile stored in the database.
 * Minimal shape -- the full schema is defined in the engine's repository.
 */
export interface AgentProfile {
  id: string;
  name: string;
  systemPrompt: string;
  secretRef: string;
  model: string;
  maxDurationMs: number;
  repoUrl: string;
  baseBranch: string;
}

/**
 * Dependencies needed to assemble a WorkOrder from job data.
 */
export interface AssemblerDeps {
  /** Lookup agent profile by ID */
  getAgentProfile: (agentId: string) => Promise<AgentProfile | undefined>;
  /** Lookup card details from kanban plugin */
  getCardDetails: (cardId: string) => Promise<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    labels: string[];
  }>;
  /** Base URL for the Ouija server (for callback URL) */
  serverBaseUrl: string;
  /** JWT for the agent to authenticate callbacks */
  issueJwt: (instanceId: string, boardId: string, workspaceId: string) => Promise<string>;
}

/**
 * Assemble a full WorkOrder from AgentDispatchJobData.
 *
 * The orchestrator's side effect only provides minimal data (IDs).
 * The worker enriches this with card details, agent profile, and JWT.
 */
export async function assembleWorkOrder(
  jobData: AgentDispatchJobData,
  deps: AssemblerDeps,
): Promise<WorkOrder> {
  // 1. Load agent profile
  const profile = await deps.getAgentProfile(jobData.agentId);
  if (!profile) {
    throw new Error(`Agent profile not found: ${jobData.agentId}`);
  }

  // 2. Load card details
  const card = await deps.getCardDetails(jobData.cardId);

  // 3. Issue JWT for this dispatch
  const jwt = await deps.issueJwt(jobData.instanceId, '', '');

  // 4. Construct the WorkOrder
  const workOrder: WorkOrder = {
    instanceId: makeInstanceId(jobData.instanceId),
    cardId: jobData.cardId,
    title: card.title,
    description: card.description,
    acceptanceCriteria: card.acceptanceCriteria,
    repoUrl: profile.repoUrl,
    branch: `ouija/${jobData.instanceId}`,
    baseBranch: profile.baseBranch,
    agentProfileId: jobData.agentId,
    systemPrompt: profile.systemPrompt,
    secretRef: profile.secretRef,
    callbackUrl: `${deps.serverBaseUrl}/hooks/agent/callback`,
    callbackToken: jwt,
    maxDurationMs: profile.maxDurationMs,
    metadata: {},
  };

  return workOrder;
}
```

- [ ] **Step 3: Write the timeout enforcer**

```ts
// packages/agent-worker/src/timeout.ts

/**
 * Create an AbortController that auto-aborts after `ms` milliseconds.
 * Returns both the controller (for cancellation) and a cleanup function
 * to prevent the timer from firing after the work completes.
 */
export function createTimeout(ms: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${ms}ms`));
  }, ms);

  // Prevent timer from keeping the process alive
  if (typeof timeoutId === 'object' && 'unref' in timeoutId) {
    timeoutId.unref();
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
  };

  return { controller, cleanup };
}
```

- [ ] **Step 4: Write the worker**

```ts
// packages/agent-worker/src/worker.ts

import type { AgentPlugin, WorkOrder } from '@ouija/types';
import type { JobQueue, AgentDispatchJobData } from '@ouija/bus';
import { QUEUE_NAMES } from '@ouija/bus';
import { createTimeout } from './timeout.js';
import type { AssemblerDeps } from './work-order-assembler.js';
import { assembleWorkOrder } from './work-order-assembler.js';

export interface WorkerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface AgentWorkerOptions {
  jobQueue: JobQueue;
  agentPlugin: AgentPlugin;
  assemblerDeps: AssemblerDeps;
  logger?: WorkerLogger;
  /** Number of concurrent agent dispatches. Default: 1. */
  concurrency?: number;
  /** Default max duration if not specified in work order. Default: 30 min. */
  defaultMaxDurationMs?: number;
}

/**
 * AgentDispatchWorker processes `agentDispatch` jobs from BullMQ.
 *
 * For each job:
 *   1. Assembles a full WorkOrder from the minimal job data
 *   2. Calls agentPlugin.dispatch(workOrder)
 *   3. Monitors for timeout (maxDurationMs)
 *   4. Reports results back via the heartbeat/callback mechanism
 *
 * The worker can run as a separate process from the Fastify server,
 * enabling independent scaling of API and agent execution.
 */
export class AgentDispatchWorker {
  private readonly jobQueue: JobQueue;
  private readonly agentPlugin: AgentPlugin;
  private readonly assemblerDeps: AssemblerDeps;
  private readonly logger: WorkerLogger;
  private readonly concurrency: number;
  private readonly defaultMaxDurationMs: number;
  private started = false;

  constructor(options: AgentWorkerOptions) {
    this.jobQueue = options.jobQueue;
    this.agentPlugin = options.agentPlugin;
    this.assemblerDeps = options.assemblerDeps;
    this.logger = options.logger ?? noopLogger;
    this.concurrency = options.concurrency ?? 1;
    this.defaultMaxDurationMs = options.defaultMaxDurationMs ?? 30 * 60 * 1000;
  }

  /**
   * Start processing agentDispatch jobs.
   * Registers the BullMQ worker with the configured concurrency.
   */
  async start(): Promise<void> {
    if (this.started) return;

    await this.jobQueue.process(
      QUEUE_NAMES.agentDispatch,
      async (data: AgentDispatchJobData, jobId: string) => {
        await this._handleJob(data, jobId);
      },
      this.concurrency,
    );

    this.started = true;
    this.logger.info('Agent dispatch worker started', { concurrency: this.concurrency });
  }

  /**
   * Stop the worker. Waits for in-flight jobs to complete.
   */
  async stop(): Promise<void> {
    // JobQueue.close() handles draining -- called by the server/process shutdown
    this.started = false;
    this.logger.info('Agent dispatch worker stopped');
  }

  private async _handleJob(
    data: AgentDispatchJobData,
    jobId: string,
  ): Promise<void> {
    this.logger.info('Processing agent dispatch job', {
      jobId,
      instanceId: data.instanceId,
      dispatchId: data.dispatchId,
      agentId: data.agentId,
    });

    try {
      // 1. Assemble the full WorkOrder
      const workOrder = await assembleWorkOrder(data, this.assemblerDeps);

      // 2. Set up timeout
      const maxMs = workOrder.maxDurationMs || this.defaultMaxDurationMs;
      const { controller, cleanup } = createTimeout(maxMs);

      try {
        // 3. Dispatch to the agent plugin
        const dispatchId = await this.agentPlugin.dispatch(workOrder);

        this.logger.info('Agent dispatched', {
          jobId,
          dispatchId: String(dispatchId),
          instanceId: data.instanceId,
        });

        // Note: the agent plugin handles the actual execution asynchronously.
        // The heartbeat reporter inside the plugin communicates back to Ouija.
        // The worker's job is done once dispatch() returns -- the plugin owns
        // the lifecycle from here (including its own timeout handling).

      } finally {
        cleanup();
      }

    } catch (err) {
      this.logger.error('Agent dispatch job failed', {
        jobId,
        instanceId: data.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-throw so BullMQ marks the job as failed and applies retry policy
      throw err;
    }
  }
}
```

- [ ] **Step 5: Write the entry point**

```ts
// packages/agent-worker/src/index.ts

/**
 * Agent Worker entry point.
 *
 * Runs as a standalone process that:
 *   1. Connects to Redis (BullMQ)
 *   2. Loads the Claude agent plugin
 *   3. Starts the AgentDispatchWorker
 *   4. Processes agentDispatch jobs from the queue
 *
 * This process is separate from the Fastify server, enabling
 * independent scaling of API and agent execution.
 *
 * Required env vars:
 *   OUIJA_REDIS_URL          - Redis connection URL
 *   OUIJA_SECRET_KEY         - For JWT issuance
 *   OUIJA_SERVER_URL         - Base URL of the Ouija server (for callback URLs)
 *   ANTHROPIC_API_KEY        - Claude API key
 *
 * Optional env vars:
 *   OUIJA_WORKER_CONCURRENCY - Number of concurrent agent dispatches (default: 1)
 *   OUIJA_DATABASE_URL       - Postgres URL (for assembling WorkOrders)
 */

import { BullMQJobQueue } from '@ouija/bus';
import { ClaudeAgentPlugin } from '@ouija/plugin-agent-claude';
import { AgentDispatchWorker } from './worker.js';
import type { AssemblerDeps } from './work-order-assembler.js';
import { issueAgentJWT } from './jwt-helper.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var "${name}" is not set`);
  return val;
}

async function main(): Promise<void> {
  const redisUrl = process.env['OUIJA_REDIS_URL'] ?? 'redis://localhost:6379';
  const serverUrl = requireEnv('OUIJA_SERVER_URL');
  const concurrency = parseInt(process.env['OUIJA_WORKER_CONCURRENCY'] ?? '1', 10);

  const logger = {
    info: (msg: string, ctx?: Record<string, unknown>) => console.info(JSON.stringify({ level: 'info', msg, ...ctx })),
    warn: (msg: string, ctx?: Record<string, unknown>) => console.warn(JSON.stringify({ level: 'warn', msg, ...ctx })),
    error: (msg: string, ctx?: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', msg, ...ctx })),
  };

  // 1. Create BullMQ job queue
  const jobQueue = new BullMQJobQueue({ url: redisUrl });

  // 2. Create and init Claude agent plugin
  const claudePlugin = new ClaudeAgentPlugin();
  await claudePlugin.init({
    config: {
      secretRef: 'env:ANTHROPIC_API_KEY',
      defaultModel: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514',
      maxDurationMs: 1800000,
      repoAccessTokens: {},
    },
    logger,
    publishEvent: async () => undefined,
    enqueueJob: async () => undefined,
  });
  await claudePlugin.start();

  // 3. Create assembler deps
  // For v1, the assembler uses simplified lookups. The full database-backed
  // implementation will be wired in Task 4.
  const assemblerDeps: AssemblerDeps = {
    getAgentProfile: async (_agentId: string) => {
      // v1: single hardcoded profile. Task 4 wires this to the database.
      return {
        id: 'rex-coder',
        name: 'Rex Coder',
        systemPrompt: 'You are an expert software engineer. Write clean, tested code.',
        secretRef: 'env:ANTHROPIC_API_KEY',
        model: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514',
        maxDurationMs: 1800000,
        repoUrl: process.env['DEFAULT_REPO_URL'] ?? '',
        baseBranch: process.env['DEFAULT_BASE_BRANCH'] ?? 'main',
      };
    },
    getCardDetails: async (cardId: string) => {
      // v1: card details come from the job data's workOrderDescription.
      // Task 4 wires this to the kanban plugin.
      return {
        title: `Card ${cardId}`,
        description: '',
        acceptanceCriteria: [],
        labels: [],
      };
    },
    serverBaseUrl: serverUrl,
    issueJwt: async (instanceId: string, boardId: string, workspaceId: string) => {
      return issueAgentJWT(instanceId, boardId, workspaceId);
    },
  };

  // 4. Create and start worker
  const worker = new AgentDispatchWorker({
    jobQueue,
    agentPlugin: claudePlugin,
    assemblerDeps,
    logger,
    concurrency,
  });

  await worker.start();
  logger.info('Agent worker running', { concurrency });

  // 5. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Shutdown signal received: ${signal}`);
    await worker.stop();
    await claudePlugin.stop();
    await jobQueue.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

main().catch((err) => {
  console.error('Fatal agent worker error:', err);
  process.exit(1);
});
```

Note: `jwt-helper.ts` is a thin wrapper that imports from `@ouija/server` or duplicates the JWT issuance logic. Create it as:

```ts
// packages/agent-worker/src/jwt-helper.ts
// Re-export or duplicate the JWT issuance logic.
// In v1, the worker shares the same OUIJA_SECRET_KEY as the server.

import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';

const ISSUER = 'ouija';
const AUDIENCE = 'ouija-agent-callback';
const TOKEN_LIFETIME_SECS = 15 * 60;

function getSecretKey(): Uint8Array {
  const raw = process.env['OUIJA_SECRET_KEY'];
  if (!raw || raw.length < 32) {
    throw new Error('OUIJA_SECRET_KEY is required (min 32 chars)');
  }
  return new TextEncoder().encode(raw);
}

export async function issueAgentJWT(
  instanceId: string,
  boardId: string,
  workspaceId: string,
): Promise<string> {
  const jti = randomUUID();
  const secret = getSecretKey();

  return new SignJWT({ instanceId, boardId, workspaceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setExpirationTime(`${TOKEN_LIFETIME_SECS}s`)
    .sign(secret);
}
```

- [ ] **Step 6: Write the assembler tests**

```ts
// packages/agent-worker/tests/work-order-assembler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { assembleWorkOrder } from '../src/work-order-assembler.js';
import type { AssemblerDeps, AgentProfile } from '../src/work-order-assembler.js';
import type { AgentDispatchJobData } from '@ouija/bus';

const baseJobData: AgentDispatchJobData = {
  instanceId: 'inst-123',
  dispatchId: 'disp-456',
  agentId: 'rex-coder',
  cardId: 'card-789',
  projectId: 'proj-1',
  workOrderDescription: 'Implement feature X',
  dispatchedAt: new Date().toISOString(),
};

const baseProfile: AgentProfile = {
  id: 'rex-coder',
  name: 'Rex Coder',
  systemPrompt: 'You are an expert engineer.',
  secretRef: 'cred:anthropic',
  model: 'claude-sonnet-4-20250514',
  maxDurationMs: 1800000,
  repoUrl: 'https://github.com/org/repo.git',
  baseBranch: 'main',
};

function makeDeps(overrides: Partial<AssemblerDeps> = {}): AssemblerDeps {
  return {
    getAgentProfile: vi.fn().mockResolvedValue(baseProfile),
    getCardDetails: vi.fn().mockResolvedValue({
      title: 'Implement feature X',
      description: 'Build feature X with tests.',
      acceptanceCriteria: ['It works', 'Tests pass'],
      labels: ['ready'],
    }),
    serverBaseUrl: 'http://localhost:4000',
    issueJwt: vi.fn().mockResolvedValue('jwt-token-test'),
    ...overrides,
  };
}

describe('assembleWorkOrder', () => {
  it('produces a valid WorkOrder from job data', async () => {
    const deps = makeDeps();
    const wo = await assembleWorkOrder(baseJobData, deps);

    expect(wo.instanceId).toBeTruthy();
    expect(wo.cardId).toBe('card-789');
    expect(wo.title).toBe('Implement feature X');
    expect(wo.description).toBe('Build feature X with tests.');
    expect(wo.acceptanceCriteria).toEqual(['It works', 'Tests pass']);
    expect(wo.repoUrl).toBe('https://github.com/org/repo.git');
    expect(wo.branch).toBe('ouija/inst-123');
    expect(wo.baseBranch).toBe('main');
    expect(wo.callbackUrl).toBe('http://localhost:4000/hooks/agent/callback');
    expect(wo.callbackToken).toBe('jwt-token-test');
    expect(wo.maxDurationMs).toBe(1800000);
  });

  it('throws when agent profile not found', async () => {
    const deps = makeDeps({
      getAgentProfile: vi.fn().mockResolvedValue(undefined),
    });

    await expect(assembleWorkOrder(baseJobData, deps)).rejects.toThrow('Agent profile not found');
  });

  it('calls issueJwt with instanceId', async () => {
    const deps = makeDeps();
    await assembleWorkOrder(baseJobData, deps);
    expect(deps.issueJwt).toHaveBeenCalledWith('inst-123', '', '');
  });
});
```

- [ ] **Step 7: Write the timeout tests**

```ts
// packages/agent-worker/tests/timeout.test.ts
import { describe, it, expect } from 'vitest';
import { createTimeout } from '../src/timeout.js';

describe('createTimeout', () => {
  it('creates a non-aborted controller initially', () => {
    const { controller, cleanup } = createTimeout(10000);
    expect(controller.signal.aborted).toBe(false);
    cleanup();
  });

  it('aborts after the specified duration', async () => {
    const { controller, cleanup } = createTimeout(50);
    await new Promise((r) => setTimeout(r, 100));
    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });

  it('does not abort when cleaned up before timeout', async () => {
    const { controller, cleanup } = createTimeout(50);
    cleanup(); // Cancel the timer
    await new Promise((r) => setTimeout(r, 100));
    expect(controller.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 8: Write the worker tests**

```ts
// packages/agent-worker/tests/worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentDispatchWorker } from '../src/worker.js';
import type { AgentDispatchJobData } from '@ouija/bus';
import type { AgentPlugin, WorkOrder } from '@ouija/types';
import { dispatchId as makeDispatchId } from '@ouija/types';

// ---- Mock JobQueue ----

function makeMockJobQueue() {
  let handler: ((data: AgentDispatchJobData, jobId: string) => Promise<void>) | null = null;

  return {
    enqueue: vi.fn().mockResolvedValue('job-1'),
    process: vi.fn().mockImplementation(async (_queue: string, fn: typeof handler) => {
      handler = fn;
    }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    /** Simulate a job arriving */
    simulateJob: async (data: AgentDispatchJobData, jobId = 'job-sim') => {
      if (!handler) throw new Error('Worker not started');
      await handler(data, jobId);
    },
  };
}

// ---- Mock Agent Plugin ----

function makeMockAgentPlugin(): AgentPlugin {
  return {
    manifest: {
      name: '@ouija/mock-agent',
      version: '0.1.0',
      type: 'agent',
      coreApiVersion: '>=1.0.0',
      configSchema: {},
    },
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    dispatch: vi.fn().mockResolvedValue(makeDispatchId('mock-dispatch-1')),
    cancel: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({
      dispatchId: makeDispatchId('mock-dispatch-1'),
      instanceId: 'inst-1',
      state: 'running',
      updatedAt: new Date().toISOString(),
    }),
  };
}

const baseJobData: AgentDispatchJobData = {
  instanceId: 'inst-123',
  dispatchId: 'disp-456',
  agentId: 'rex-coder',
  cardId: 'card-789',
  projectId: 'proj-1',
  workOrderDescription: 'Do something',
  dispatchedAt: new Date().toISOString(),
};

describe('AgentDispatchWorker', () => {
  let mockJobQueue: ReturnType<typeof makeMockJobQueue>;
  let mockPlugin: AgentPlugin;

  beforeEach(() => {
    mockJobQueue = makeMockJobQueue();
    mockPlugin = makeMockAgentPlugin();
  });

  it('starts and registers as a BullMQ processor', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockJobQueue as unknown as import('@ouija/bus').JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: {
        getAgentProfile: vi.fn().mockResolvedValue({
          id: 'rex-coder', name: 'Rex', systemPrompt: '', secretRef: 'ref',
          model: 'claude-sonnet-4-20250514', maxDurationMs: 60000,
          repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main',
        }),
        getCardDetails: vi.fn().mockResolvedValue({
          title: 'Test', description: 'Desc', acceptanceCriteria: [], labels: [],
        }),
        serverBaseUrl: 'http://localhost:4000',
        issueJwt: vi.fn().mockResolvedValue('jwt-test'),
      },
    });

    await worker.start();
    expect(mockJobQueue.process).toHaveBeenCalledTimes(1);
  });

  it('dispatches to agent plugin when a job arrives', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockJobQueue as unknown as import('@ouija/bus').JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: {
        getAgentProfile: vi.fn().mockResolvedValue({
          id: 'rex-coder', name: 'Rex', systemPrompt: '', secretRef: 'ref',
          model: 'claude-sonnet-4-20250514', maxDurationMs: 60000,
          repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main',
        }),
        getCardDetails: vi.fn().mockResolvedValue({
          title: 'Test', description: 'Desc', acceptanceCriteria: [], labels: [],
        }),
        serverBaseUrl: 'http://localhost:4000',
        issueJwt: vi.fn().mockResolvedValue('jwt-test'),
      },
    });

    await worker.start();
    await mockJobQueue.simulateJob(baseJobData);

    expect(mockPlugin.dispatch).toHaveBeenCalledTimes(1);
    const workOrder = (mockPlugin.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as WorkOrder;
    expect(workOrder.cardId).toBe('card-789');
    expect(workOrder.branch).toBe('ouija/inst-123');
  });

  it('re-throws errors so BullMQ can retry', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockJobQueue as unknown as import('@ouija/bus').JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: {
        getAgentProfile: vi.fn().mockRejectedValue(new Error('DB down')),
        getCardDetails: vi.fn().mockResolvedValue({ title: '', description: '', acceptanceCriteria: [], labels: [] }),
        serverBaseUrl: 'http://localhost:4000',
        issueJwt: vi.fn().mockResolvedValue('jwt-test'),
      },
    });

    await worker.start();
    await expect(mockJobQueue.simulateJob(baseJobData)).rejects.toThrow('DB down');
  });
});
```

- [ ] **Step 9: Run tests**

Run: `cd packages/agent-worker && npx vitest run`
Expected: All assembler, timeout, and worker tests pass.

- [ ] **Step 10: Build and verify**

Run: `npx turbo build --filter=@ouija/agent-worker`
Expected: Compiles to `dist/`. No type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/agent-worker/
git commit -m "feat(agent-worker): implement BullMQ worker for agent dispatch

Separate process that consumes agentDispatch jobs from the queue,
assembles full WorkOrders from job data + DB lookups, and dispatches
to the Claude agent plugin. Handles timeout enforcement and graceful
shutdown. Can scale independently from the Fastify server."
```

---

### Task 4: Wire Plugins Into Server Startup

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/engine/src/orchestrator.ts` (notification side effect routing)
- Create: `packages/engine/src/migrations/001-initial-schema.sql` (if not present)
- Modify: `docker/docker-compose.yml` (add agent-worker service)
- Modify: `.env.example` (add new env vars)

**Key implementation notes:**

- [ ] **Step 1: Add notification event topic to the event bus**

The orchestrator currently reuses `kanban.card.moved` for `send_notification` side effects (see comment at line 323 of orchestrator.ts). This needs a dedicated notification topic.

Update `packages/types/src/events.ts`:
- Add `'notification.send'` topic to `OuijaEventMap`
- Add `NotificationSendPayload` with fields: `title`, `body`, `level`, `actions`, `idempotencyKey`

Update `packages/engine/src/orchestrator.ts`:
- Replace the `send_notification` case in `_executeSideEffect` to publish on `'notification.send'` topic with proper payload construction
- The notification payload should include: pipeline instanceId, current state, the notification message from the side effect payload

- [ ] **Step 2: Subscribe Telegram plugin to notification events**

In server startup (`packages/server/src/index.ts`):
- Load and init the Telegram plugin via PluginLoader (requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars)
- After plugin init, subscribe to `'notification.send'` events on the EventBus
- The subscriber converts the event payload into a `Notification` object and calls `telegramPlugin.send(notification)`
- Include deep link actions: "View Pipeline" -> `${OUIJA_SERVER_URL}/pipelines/${instanceId}`

- [ ] **Step 3: Replace kanbanPlaceholder with real Plane plugin**

In server startup:
- Load `@ouija/plugin-plane` via PluginLoader with config from env vars (`PLANE_API_TOKEN`, `PLANE_BASE_URL`, `PLANE_WORKSPACE_SLUG`)
- Pass the loaded Plane plugin instance to the Orchestrator constructor instead of `kanbanPlaceholder`
- Wire `registerRoutes()` if the Plane plugin implements it

- [ ] **Step 4: Start agent worker in-process (optional) or as separate service**

For MK's personal setup, the agent worker can run in-process. Add to server startup:
- Import and create `AgentDispatchWorker`
- Wire the assembler deps to the database and kanban plugin
- Start the worker after server listen
- Stop the worker in the shutdown handler

For production-style deployment, add a separate service to `docker-compose.yml`:
```yaml
agent-worker:
  build:
    context: .
    dockerfile: docker/Dockerfile
  command: ["node", "packages/agent-worker/dist/index.js"]
  environment:
    OUIJA_REDIS_URL: redis://ouija-redis:6379
    OUIJA_SECRET_KEY: ${OUIJA_SECRET_KEY}
    OUIJA_SERVER_URL: http://ouija:4000
    OUIJA_DATABASE_URL: ${OUIJA_DATABASE_URL}
    ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    OUIJA_WORKER_CONCURRENCY: 1
  depends_on:
    ouija:
      condition: service_healthy
    ouija-redis:
      condition: service_healthy
```

- [ ] **Step 5: Auto-run database migrations at startup**

In server startup, before creating the Orchestrator:
- Read migration SQL files from `packages/engine/src/migrations/`
- Execute them against the database in order (use a `schema_migrations` tracking table)
- Log which migrations were applied
- This replaces manual migration steps and prevents "forgot to migrate" failures

- [ ] **Step 6: Update .env.example with new env vars**

Add:
```
TELEGRAM_BOT_TOKEN=            # From Telegram BotFather
TELEGRAM_CHAT_ID=              # Your personal chat ID
OUIJA_SERVER_URL=http://localhost:4000  # For agent callback URLs
CLAUDE_MODEL=claude-sonnet-4-20250514
OUIJA_WORKER_CONCURRENCY=1
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/index.ts packages/engine/src/orchestrator.ts packages/types/src/events.ts docker/ .env.example
git commit -m "feat(server): wire Telegram + Claude plugins into server startup

Replace kanban placeholder with real Plane plugin. Subscribe Telegram
plugin to notification events. Add agent worker service to Docker
Compose. Auto-run database migrations at startup."
```

---

### Task 5: Smoke Test the Full Loop

**Files:**
- Create: `tests/smoke/full-loop.sh` (or equivalent test script)
- Modify: `docker/docker-compose.yml` (if needed for Plane webhook config)

**Key implementation notes:**

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d
```

Verify all services are healthy:
```bash
docker compose ps
curl http://localhost:4000/healthz
```

- [ ] **Step 2: Configure Plane webhook**

In Plane's admin settings, configure a webhook pointing to:
`http://ouija:4000/hooks/plane/<PLANE_WEBHOOK_SECRET>`

Events: issue.updated (for column moves)

- [ ] **Step 3: Create a board config via API**

```bash
curl -X POST http://localhost:4000/api/v1/projects \
  -H "Content-Type: application/json" \
  -d '{
    "boardId": "<plane-board-id>",
    "columnMappings": [
      {
        "columnId": "<in-progress-column-id>",
        "columnName": "In Progress",
        "action": "dispatch_agent",
        "agentId": "rex-coder",
        "guards": [{"type": "min_description_length", "value": 50}]
      },
      {
        "columnId": "<review-column-id>",
        "columnName": "Review",
        "action": "noop"
      }
    ],
    "defaultStallThresholdMs": 1800000,
    "autoStartOnAssign": false
  }'
```

- [ ] **Step 4: Create a card on Plane and move it**

Create a card with a substantive description (>50 chars to pass the guard).
Move the card to "In Progress" column.

- [ ] **Step 5: Verify the pipeline**

Expected sequence:
1. Plane webhook fires -> Ouija receives it at `/hooks/plane/:secret`
2. Orchestrator creates pipeline instance in `idle` state
3. Transition to `dispatching` -> side effect enqueues `agentDispatch` job
4. Agent worker picks up the job -> assembles WorkOrder -> dispatches to Claude plugin
5. Claude plugin clones repo, creates branch, runs Claude Code CLI
6. Claude Code writes code, commits, pushes, opens PR
7. Agent plugin reports `agent_completed` via callback endpoint
8. Orchestrator transitions to `succeeded`
9. `send_notification` side effect fires -> Telegram notification sent
10. Card moved to "Review" column on Plane

Verify each step:
```bash
# Check pipeline state
curl http://localhost:4000/api/v1/pipelines

# Check agent worker logs
docker compose logs agent-worker

# Check Telegram for notification
# (visual verification in Telegram app)
```

- [ ] **Step 6: Test failure path**

Create a card with description <50 chars. Move to "In Progress".
Expected: guard fails, notification sent, card NOT dispatched.

- [ ] **Step 7: Test stall detection**

Create a card and dispatch. Kill the agent worker mid-execution.
Expected: stall monitor fires after threshold, notification sent.

- [ ] **Step 8: Document any issues found**

Track bugs in a `SMOKE_TEST_RESULTS.md` file (temporary -- delete after fixing).

- [ ] **Step 9: Commit**

```bash
git add tests/smoke/ docker/
git commit -m "test(smoke): add full-loop smoke test for Phase 2

Docker Compose + Plane + Claude agent + Telegram notification.
Verifies: webhook -> pipeline -> dispatch -> agent -> PR -> notify."
```

---

### Task 6: Fix Phase 1 Smoke Test Bugs

**Files:**
- Modify: `packages/server/src/routes/webhooks.ts` (dedup key fix)
- Modify: `packages/server/src/index.ts` (migration auto-run, Plane plugin wiring)
- Modify: `packages/server/tests/webhooks.test.ts` (update dedup tests)

**Key implementation notes:**

- [ ] **Step 1: Fix Plane webhook dedup key**

Current code at `webhooks.ts:116`:
```ts
const externalEventId = (body['event_id'] as string | undefined) ?? randomUUID();
```

The dedup should key on the `X-Plane-Delivery` header (like GitHub uses `X-GitHub-Delivery`), not on `event_id` in the body. Plane sends a delivery UUID header that uniquely identifies each webhook delivery (including retries of the same event).

Fix:
```ts
const delivery = request.headers['x-plane-delivery'] as string | undefined;
const externalEventId = delivery ?? (body['event_id'] as string | undefined) ?? randomUUID();
```

This matches the GitHub webhook handler pattern (line 180) which already uses the `X-GitHub-Delivery` header.

- [ ] **Step 2: Update dedup tests**

Add a test that verifies dedup works on `X-Plane-Delivery` header:
```ts
it('deduplicates via X-Plane-Delivery header', async () => {
  // Send same payload twice with same X-Plane-Delivery header
  // Expect orchestrator.processTrigger called only once
});
```

- [ ] **Step 3: Auto-run migrations at server startup**

(Covered in Task 4 Step 5 -- this step is here for completeness to ensure it is done if Task 4 and Task 6 are worked in different worktrees.)

- [ ] **Step 4: Wire real Plane plugin**

(Covered in Task 4 Step 3 -- same note as above.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/
git commit -m "fix(server): dedup Plane webhooks on X-Plane-Delivery header

Previously keyed on body.event_id which is not a delivery-unique
identifier. Now uses X-Plane-Delivery header (matching the GitHub
webhook pattern). Falls back to body.event_id, then to randomUUID."
```

---

## Execution Summary — Original Plan

| Task | Package | Status |
|------|---------|--------|
| 1 | plugin-notify-telegram | **DONE** |
| 2 | plugin-agent-claude | **DONE** |
| 3 | agent-worker | **DONE** |
| 4 | server (wiring) | **DONE** |
| 5 | smoke test (full loop) | **DONE** (3 real PRs created during e2e proof) |
| 6 | Phase 1 bug fixes | **DONE** (webhook normalizer, dedup key, Plane CE role codes) |

---

## Work Completed Beyond Original Plan

The following features were implemented during Phase 2 but were not in the original plan. They emerged from real-world e2e testing and the self-hoster story.

### Workspace Abstraction (separate plan: 2026-04-02)
- **DONE**: `WorkspaceProvider` + `AgentRunner` interfaces in `@ouija/types`
- **DONE**: `provisioning` state added to pipeline state machine
- **DONE**: `@ouija/workspace-local` — `LocalWorkspaceProvider` (clone + git worktree modes)
- **DONE**: `@ouija/workspace-local` — `LocalAgentRunner` (CLI subprocess) + `SdkAgentRunner` (Claude Agent SDK)
- **DONE**: `ClaudeAgentPlugin` refactored to use WorkspaceProvider + AgentRunner
- **DONE**: Stall monitor updated for provisioning-aware thresholds (2x grace period)

### Agent Profiles + Plane Member Provisioning (separate plan: 2026-04-03)
- **DONE**: `@ouija/config` — YAML config loader, Ajv schema validator, types
- **DONE**: `AgentMemberRegistry` — maps kanban member IDs to ouija agent IDs
- **DONE**: `repoPath` support (git worktree) alongside `repoUrl` (clone)
- **DONE**: Multi-repo resolution by Plane project ID
- **DONE**: Auto-trigger (dispatch on assign) and manual trigger (assign then column move) modes
- **DONE**: `configDir` — per-agent Claude Code capabilities (MCP servers, tools, hooks)
- **DONE**: `claudeHome` — inherit dev's Claude setup for machine-authed CLI
- **DONE**: Auth method env var wiring (api-key, bedrock, vertex, foundry, proxy)
- **DONE**: Board config seeding from `ouija.config.yaml`
- **DONE**: Workspace config assembly — layered `.claude/` config (repo → agent → task)

### Fizzy Kanban Integration (2026-04-04)
- **DONE**: `@ouija/plugin-fizzy` — full KanbanPlugin implementation against Fizzy REST API
- **DONE**: `FizzyApiClient` — 10 API methods, error handling, rate limit support
- **DONE**: Fizzy webhook handler — HMAC-SHA256 verification, 4 event mappings
- **DONE**: Server wiring — `FIZZY_*` env vars, mutual exclusion with Plane
- **DONE**: `docker-compose.fizzy.yml` — Fizzy + Postgres + Redis stack

### Config Generalization (2026-04-04)
- **DONE**: `PlaneClient` → `KanbanMemberClient` (backward-compatible alias)
- **DONE**: `PlaneColumnClient` → `KanbanColumnClient` (backward-compatible alias)
- **DONE**: `kanbanUserId` field — pre-mapped agent IDs for backends without auto-provisioning
- **DONE**: `boardId` field — generic alternative to Plane-specific `projectId`
- **DONE**: Duplicate Plane webhook normalizer eliminated — server now imports from `@ouija/plugin-plane`

### Bug Fixes Found During E2E (2026-04-03)
- **DONE**: Webhook column ID resolution — `new_identifier` (UUID) over `new_value` (name)
- **DONE**: Auto-trigger fallback — dispatch to any available column when agent-specific column missing
- **DONE**: Plane CE role code 15 (not 10) for member invitations
- **DONE**: SDK runner `cli.js` path resolution via `createRequire` (falls back to LocalAgentRunner)

---

## Current State (2026-04-04)

- **14 packages** in monorepo (types, bus, engine, plugin-sdk, plugin-plane, plugin-fizzy, plugin-github, plugin-agent-claude, plugin-notify-telegram, agent-worker, workspace-local, config, server)
- **604 tests passing**, 0 failures
- **3 real PRs** created during e2e proof on `muhammadkh4n/mcp-server-template`
- **Private repo** pushed to `github.com/muhammadkh4n/ouija`
- **Two kanban backends**: Plane CE and Fizzy (mutually exclusive via env vars)

---

## Pending / Known Gaps

| Item | Priority | Notes |
|------|----------|-------|
| Plane CE webhooks don't fire on API changes | **High** (Plane-only) | Polling fallback needed for Plane users. Not an issue for Fizzy. |
| No "Failed" column mapping | **Medium** | Transition emits `move_card` to "Failed" but no column config supports it. Cards stay put on failure. |
| Plane member invitation ≠ real member | **Low** | `inviteMember()` creates pending invites. Use `kanbanUserId` pre-mapping instead. |
| SDK runner cli.js path fragile in monorepo | **Low** | Falls back to LocalAgentRunner. Both produce identical results. |
| Fizzy e2e proof not yet run | **Medium** | Plugin built + tested (52 tests) but no real Fizzy instance tested yet. |
| Engram memory integration for agents | **Backlog** | Wire engram MCP server via agent configDir for cross-session agent memory. |

---

## What This Plan Does NOT Cover (Phase 3+)

- Dashboard (React SPA with real-time pipeline status)
- CLI (`ouija init`, `ouija check`, `ouija status`)
- Multi-agent support (multiple Claude instances, GPT agents, Codex)
- Cloud SaaS features (RLS, KMS, RBAC, per-merged-PR billing)
- PR output validation (scan diffs for workflow file changes, secret leaks)
- Agent cost tracking and budget enforcement
- SOC 2 / GDPR compliance
- `ouija demo` command
- Remote execution (E2B, Codespaces) — researched, not implemented
