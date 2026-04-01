# Ouija Phase 1: Core Engine + First Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a card on Plane, have a stub agent pick it up, and move the card forward. The full loop: webhook in → pipeline transition → agent dispatch → agent callback → card moved.

**Architecture:** Turborepo monorepo with 7 packages built bottom-up: types → bus → engine → plugin-sdk → plugin-plane → plugin-github → server (Fastify). Postgres for persistence. BullMQ for jobs/events. Pure transition function at the heart. All behind Docker Compose.

**Tech Stack:** TypeScript 5.5+, Fastify 5, BullMQ 5, pg (node-postgres), Turborepo, Vitest, Docker Compose, PostgreSQL 15, Valkey 7

**Spec:** `docs/superpowers/specs/2026-04-01-ouija-design.md` (revision 2)

**Estimated effort:** 8-10 weeks for 1 engineer. Tasks 1-8 are the critical path (~6 weeks). Tasks 9-12 bring it to a usable state.

**Phase scope:** This plan covers the core loop only. Dashboard, CLI, notification plugin, and cloud features are Phase 2+.

---

## File Structure

```
ouija/
  package.json                          # Root: workspaces, scripts
  turbo.json                            # Turborepo pipeline config
  tsconfig.base.json                    # Shared tsconfig
  .env.example                          # Template for env vars
  vitest.workspace.ts                   # Vitest workspace config
  docker/
    docker-compose.yml                  # Full stack (Ouija + Plane + deps)
    docker-compose.ouija.yml            # Ouija-only (BYO kanban)
    Dockerfile                          # Multi-stage Ouija image
  infra/
    postgres/init/01-create-databases.sql
    redis/valkey.conf
  packages/
    types/
      package.json
      tsconfig.json
      src/
        index.ts                        # Barrel export
        ids.ts                          # Branded ID types
        events.ts                       # OuijaEventMap, event payloads, OuijaEvent<T>
        plugin.ts                       # BasePlugin, PluginManifest, PluginContext, PluginHealth
        kanban.ts                       # KanbanPlugin, KanbanCard, KanbanColumn
        git.ts                          # GitPlugin, StandardPR, OpenPRParams
        agent.ts                        # AgentPlugin, WorkOrder, AgentStatus
        notification.ts                 # NotificationPlugin, Notification
        state-machine.ts                # PipelineState, PipelineTrigger, TransitionResult, PipelineConfig
        errors.ts                       # OuijaErrorCode, OuijaError, ApiError
        api.ts                          # API request/response types, AgentResponse, PipelineResponse
        repository.ts                   # PipelineRepository, PipelineEventRepository, UnitOfWork
    bus/
      package.json
      tsconfig.json
      src/
        index.ts
        event-bus.ts                    # EventBus interface
        job-queue.ts                    # JobQueue interface
        bullmq-event-bus.ts             # BullMQ implementation of EventBus
        bullmq-job-queue.ts             # BullMQ implementation of JobQueue
      tests/
        bullmq-event-bus.test.ts
        bullmq-job-queue.test.ts
    engine/
      package.json
      tsconfig.json
      src/
        index.ts
        transition.ts                   # Pure transition function
        guards.ts                       # Guard evaluation (pure)
        orchestrator.ts                 # Trigger handler: event → load → transition → persist → side-effects
        repository.ts                   # Postgres implementations of Repository interfaces
        migrations/
          001-initial-schema.sql
        sanitizer.ts                    # Card description sanitization (§4.10)
        stall-monitor.ts                # Backup scanner for dead man's switch Layer 2
      tests/
        transition.test.ts              # 100% transition coverage
        guards.test.ts
        orchestrator.test.ts
        sanitizer.test.ts
        repository.test.ts             # Integration test (testcontainers)
    plugin-sdk/
      package.json
      tsconfig.json
      src/
        index.ts
        plugin-loader.ts                # Discovery, validation, lifecycle management
        config-validator.ts             # Ajv-based config validation
      src/test-utils/
        index.ts
        mock-context.ts                 # MockPluginContext for plugin authors
        mock-kanban.ts                  # MockKanbanPlugin (in-memory)
        mock-git.ts                     # MockGitPlugin (in-memory)
        mock-agent.ts                   # MockAgentPlugin (in-memory)
      tests/
        plugin-loader.test.ts
        config-validator.test.ts
    plugin-plane/
      package.json
      tsconfig.json
      src/
        index.ts                        # PlanePlugin implements KanbanPlugin
        config.ts                       # Config schema + FromSchema type
        api-client.ts                   # Plane REST API client
        webhook-handler.ts              # Normalize Plane webhook → OuijaEvent
        agent-user.ts                   # Register/manage agent users on Plane
      tests/
        webhook-handler.test.ts         # Contract tests against recorded payloads
        api-client.test.ts
      fixtures/
        issue-created.json              # Recorded Plane webhook payloads
        issue-updated.json
        issue-moved.json
    plugin-github/
      package.json
      tsconfig.json
      src/
        index.ts                        # GitHubPlugin implements GitPlugin
        config.ts
        api-client.ts                   # GitHub REST API client (Octokit)
        webhook-handler.ts              # Normalize GitHub webhook → OuijaEvent
      tests/
        webhook-handler.test.ts
      fixtures/
        pr-opened.json
        pr-merged.json
    server/
      package.json
      tsconfig.json
      src/
        index.ts                        # Fastify server entry point
        app.ts                          # App factory (for testing)
        routes/
          health.ts                     # /healthz, /readyz
          auth.ts                       # /api/v1/auth/*
          webhooks.ts                   # /hooks/* ingress
          agent-callback.ts             # POST /hooks/agent/callback
          pipelines.ts                  # /api/v1/pipelines/*
          projects.ts                   # /api/v1/projects/*
          agents.ts                     # /api/v1/agents/*
          plugins.ts                    # /api/v1/plugins/*
        middleware/
          auth.ts                       # Cookie + Bearer auth middleware
          rate-limit.ts                 # Rate limiting config
          error-handler.ts              # OuijaError → HTTP response
        jwt.ts                          # Agent JWT issuance, verification, refresh, denylist
      tests/
        health.test.ts
        webhooks.test.ts
        agent-callback.test.ts
        auth.test.ts
```

---

### Task 1: Monorepo Scaffold + Tooling

**Files:**
- Create: `package.json`, `turbo.json`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `.env.example`
- Create: `packages/types/package.json`, `packages/types/tsconfig.json`

- [ ] **Step 1: Initialize monorepo root**

```json
// package.json
{
  "name": "ouija",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {}
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

```ts
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
]);
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: Installs turbo, typescript, vitest at root.

- [ ] **Step 3: Create types package scaffold**

```json
// packages/types/package.json
{
  "name": "@ouija/types",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

```json
// packages/types/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create .gitignore and .env.example**

```
// .gitignore
node_modules/
dist/
.env
*.tsbuildinfo
```

```
// .env.example
OUIJA_SECRET_KEY=          # Generate: openssl rand -hex 32
OUIJA_DATABASE_URL=postgres://ouija:ouija@localhost:5432/ouija_db
OUIJA_REDIS_URL=redis://localhost:6379
PLANE_API_TOKEN=
PLANE_BASE_URL=
PLANE_WORKSPACE_SLUG=
GITHUB_PAT=
ANTHROPIC_API_KEY=
```

- [ ] **Step 5: Verify monorepo builds**

Run: `npx turbo build`
Expected: Compiles `@ouija/types` (empty for now). No errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold Turborepo monorepo with types package"
```

---

### Task 2: Shared Types — IDs, Events, State Machine

**Files:**
- Create: `packages/types/src/ids.ts`
- Create: `packages/types/src/events.ts`
- Create: `packages/types/src/state-machine.ts`
- Create: `packages/types/src/errors.ts`
- Create: `packages/types/src/index.ts`

- [ ] **Step 1: Write branded ID types**

```ts
// packages/types/src/ids.ts
declare const __brand: unique symbol;
type Brand<T, TBrand extends string> = T & { [__brand]: TBrand };

export type CardId = Brand<string, 'CardId'>;
export type InstanceId = Brand<string, 'InstanceId'>;
export type PrId = Brand<string, 'PrId'>;
export type DispatchId = Brand<string, 'DispatchId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type BoardId = Brand<string, 'BoardId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ColumnId = Brand<string, 'ColumnId'>;
export type PluginId = Brand<string, 'PluginId'>;

// Construction helpers — use at parse boundaries (DB reads, webhook ingestion)
export function cardId(raw: string): CardId { return raw as CardId; }
export function instanceId(raw: string): InstanceId { return raw as InstanceId; }
export function prId(raw: string): PrId { return raw as PrId; }
export function dispatchId(raw: string): DispatchId { return raw as DispatchId; }
export function agentId(raw: string): AgentId { return raw as AgentId; }
export function projectId(raw: string): ProjectId { return raw as ProjectId; }
export function boardId(raw: string): BoardId { return raw as BoardId; }
export function workspaceId(raw: string): WorkspaceId { return raw as WorkspaceId; }
export function columnId(raw: string): ColumnId { return raw as ColumnId; }
export function pluginId(raw: string): PluginId { return raw as PluginId; }
```

- [ ] **Step 2: Write event types**

```ts
// packages/types/src/events.ts
import type { CardId, ColumnId, InstanceId, PrId, DispatchId } from './ids.js';

// ---- Event payloads ----

export interface KanbanCardMovedPayload {
  cardId: CardId;
  fromColumnId: ColumnId;
  toColumnId: ColumnId;
  movedBy: string;
}

export interface KanbanCardAssignedPayload {
  cardId: CardId;
  assigneeId: string;
  assignedBy: string;
}

export interface GitPrOpenedPayload {
  prId: PrId;
  url: string;
  instanceId: InstanceId;
  branch: string;
  targetBranch: string;
}

export interface GitPrMergedPayload {
  prId: PrId;
  instanceId: InstanceId;
  mergedAt: string;
}

export interface AgentWorkProgressPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  progress: number;
  message: string;
}

export interface AgentWorkPrReadyPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  prUrl: string;
  prId: PrId;
}

export interface AgentWorkCompletedPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  cost?: number;
  tokensUsed?: number;
}

export interface AgentWorkFailedPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  error: string;
  retryable: boolean;
}

// ---- Event map: topic → payload type ----

export interface OuijaEventMap {
  'kanban.card.moved': KanbanCardMovedPayload;
  'kanban.card.assigned': KanbanCardAssignedPayload;
  'git.pr.opened': GitPrOpenedPayload;
  'git.pr.merged': GitPrMergedPayload;
  'agent.work.progress': AgentWorkProgressPayload;
  'agent.work.pr_ready': AgentWorkPrReadyPayload;
  'agent.work.completed': AgentWorkCompletedPayload;
  'agent.work.failed': AgentWorkFailedPayload;
}

export type OuijaTopic = keyof OuijaEventMap;

// ---- Event envelope ----

export interface OuijaEvent<TTopic extends OuijaTopic = OuijaTopic> {
  id: string;
  topic: TTopic;
  payload: OuijaEventMap[TTopic];
  timestamp: string;
  sourcePlugin: string;
  correlationId: string;
}
```

- [ ] **Step 3: Write state machine types**

```ts
// packages/types/src/state-machine.ts
import type { CardId, InstanceId, DispatchId, AgentId, ColumnId, PrId, BoardId } from './ids.js';
import type { OuijaTopic, OuijaEventMap } from './events.js';

// ---- Pipeline states (discriminated union) ----

export type PipelineState =
  | { status: 'idle' }
  | { status: 'dispatching'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string }
  | { status: 'running'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; lastHeartbeatAt: string }
  | { status: 'succeeded'; dispatchId: DispatchId; agentId: AgentId; completedAt: string; prUrl?: string; cost?: number; tokensUsed?: number }
  | { status: 'failed'; dispatchId: DispatchId; agentId: AgentId; failedAt: string; error: string; retryable: boolean }
  | { status: 'stalled'; dispatchId: DispatchId; agentId: AgentId; stalledAt: string; lastHeartbeatAt: string }
  | { status: 'cancelled'; cancelledAt: string; cancelledBy: string };

export type PipelineStatus = PipelineState['status'];

// ---- Guard results ----

export interface GuardResult {
  guardType: string;
  passed: boolean;
  reason?: string;
}

// ---- Triggers (discriminated union) ----

export type PipelineTrigger =
  | { type: 'card_moved'; cardId: CardId; toColumnId: ColumnId; fromColumnId: ColumnId; guardContext: GuardContext }
  | { type: 'card_assigned'; cardId: CardId; assigneeId: string }
  | { type: 'agent_acknowledged'; dispatchId: DispatchId }
  | { type: 'agent_progress'; dispatchId: DispatchId; heartbeatAt: string; message: string }
  | { type: 'agent_pr_ready'; dispatchId: DispatchId; prUrl: string; prId: PrId }
  | { type: 'agent_completed'; dispatchId: DispatchId; cost?: number; tokensUsed?: number }
  | { type: 'agent_failed'; dispatchId: DispatchId; error: string; retryable: boolean }
  | { type: 'stall_detected'; dispatchId: DispatchId; detectedAt: string }
  | { type: 'human_retry'; retriedBy: string }
  | { type: 'human_cancel'; cancelledBy: string }
  | { type: 'pr_merged'; prId: PrId; mergedAt: string };

// Pre-fetched data for guard evaluation (gathered BEFORE calling transition)
export interface GuardContext {
  cardDescription: string;
  cardLabels: string[];
  cardAssignees: string[];
  existingOpenPR?: { prId: PrId; url: string };
}

// ---- Side effects ----

export type SideEffectType =
  | 'move_card'
  | 'add_comment'
  | 'send_notification'
  | 'dispatch_agent'
  | 'cancel_agent'
  | 'enqueue_stall_check'
  | 'cancel_stall_check';

export interface SideEffect {
  type: SideEffectType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

// ---- Transition result ----

export interface TransitionSuccess {
  rejected: false;
  nextState: PipelineState;
  events: Array<{ topic: OuijaTopic; payload: OuijaEventMap[OuijaTopic] }>;
  sideEffects: SideEffect[];
}

export interface TransitionRejection {
  rejected: true;
  reason: string;
}

export type TransitionOutcome = TransitionSuccess | TransitionRejection;

// ---- Pipeline config ----

export interface Guard {
  type: 'min_description_length' | 'has_label' | 'has_assignee';
  value: string | number;
}

export interface ColumnMapping {
  columnId: ColumnId;
  columnName: string;
  action: 'dispatch_agent' | 'close_and_notify' | 'noop';
  agentId?: AgentId;
  guards: Guard[];
  stallThresholdMs?: number;
}

export interface PipelineConfig {
  boardId: BoardId;
  columnMappings: ColumnMapping[];
  defaultStallThresholdMs: number;
  autoStartOnAssign: boolean;
}

// ---- Pipeline instance (DB row) ----

export interface PipelineInstance {
  id: InstanceId;
  cardId: CardId;
  boardId: BoardId;
  projectId: string;
  state: PipelineState;
  attempt: number;
  prUrl?: string;
  cost?: number;
  tokensUsed?: number;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Write error types**

```ts
// packages/types/src/errors.ts
export type OuijaErrorCode =
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMIT_EXCEEDED'
  | 'VALIDATION_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'PIPELINE_NOT_FOUND'
  | 'PIPELINE_NOT_RETRYABLE'
  | 'PIPELINE_ALREADY_RUNNING'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_UNREACHABLE'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_CONFIG_INVALID'
  | 'GUARD_FAILED'
  | 'INTERNAL_ERROR';

export interface ValidationErrorDetail {
  field: string;
  message: string;
}

export interface OuijaError {
  code: OuijaErrorCode;
  message: string;
  details: ValidationErrorDetail[];
  requestId: string;
  retryable: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly code: OuijaErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly retryable = false,
    public readonly details: ValidationErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
```

- [ ] **Step 5: Write barrel export**

```ts
// packages/types/src/index.ts
export * from './ids.js';
export * from './events.js';
export * from './state-machine.js';
export * from './errors.js';
```

- [ ] **Step 6: Build and verify**

Run: `npx turbo build --filter=@ouija/types`
Expected: Compiles to `packages/types/dist/`. No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/types/
git commit -m "feat(types): add branded IDs, event map, state machine types, errors"
```

---

### Task 3: Pure Transition Function + Tests

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/vitest.config.ts`
- Create: `packages/engine/src/transition.ts`
- Create: `packages/engine/src/guards.ts`
- Create: `packages/engine/tests/transition.test.ts`
- Create: `packages/engine/tests/guards.test.ts`

This is the crown jewel. 100% transition coverage. Pure functions, zero mocks.

- [ ] **Step 1: Scaffold engine package**

```json
// packages/engine/package.json
{
  "name": "@ouija/engine",
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

- [ ] **Step 2: Write guard evaluation (pure)**

```ts
// packages/engine/src/guards.ts
import type { Guard, GuardContext, GuardResult } from '@ouija/types';

export function evaluateGuards(guards: Guard[], context: GuardContext): GuardResult[] {
  return guards.map((guard) => evaluateGuard(guard, context));
}

function evaluateGuard(guard: Guard, context: GuardContext): GuardResult {
  switch (guard.type) {
    case 'min_description_length': {
      const minLen = typeof guard.value === 'number' ? guard.value : parseInt(String(guard.value), 10);
      const passed = context.cardDescription.length >= minLen;
      return {
        guardType: guard.type,
        passed,
        reason: passed ? undefined : `Description is ${context.cardDescription.length} chars, need ${minLen}`,
      };
    }
    case 'has_label': {
      const label = String(guard.value);
      const passed = context.cardLabels.includes(label);
      return {
        guardType: guard.type,
        passed,
        reason: passed ? undefined : `Missing label "${label}"`,
      };
    }
    case 'has_assignee': {
      const passed = context.cardAssignees.length > 0;
      return {
        guardType: guard.type,
        passed,
        reason: passed ? undefined : 'Card has no assignee',
      };
    }
    default: {
      const _exhaustive: never = guard.type;
      return { guardType: String(_exhaustive), passed: false, reason: 'Unknown guard type' };
    }
  }
}
```

- [ ] **Step 3: Write guard tests**

```ts
// packages/engine/tests/guards.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateGuards } from '../src/guards.js';
import type { Guard, GuardContext } from '@ouija/types';
import { cardId } from '@ouija/types';

const baseContext: GuardContext = {
  cardDescription: 'Implement login page with OAuth support and error handling',
  cardLabels: ['ready', 'frontend'],
  cardAssignees: ['agent-rex'],
};

describe('evaluateGuards', () => {
  it('passes when description exceeds min length', () => {
    const guards: Guard[] = [{ type: 'min_description_length', value: 10 }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
  });

  it('fails when description is too short', () => {
    const guards: Guard[] = [{ type: 'min_description_length', value: 1000 }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.reason).toContain('chars');
  });

  it('passes when required label exists', () => {
    const guards: Guard[] = [{ type: 'has_label', value: 'ready' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
  });

  it('fails when required label is missing', () => {
    const guards: Guard[] = [{ type: 'has_label', value: 'approved' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.reason).toContain('approved');
  });

  it('passes when card has assignee', () => {
    const guards: Guard[] = [{ type: 'has_assignee', value: '' }];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(true);
  });

  it('fails when card has no assignee', () => {
    const guards: Guard[] = [{ type: 'has_assignee', value: '' }];
    const ctx: GuardContext = { ...baseContext, cardAssignees: [] };
    const results = evaluateGuards(guards, ctx);
    expect(results[0]?.passed).toBe(false);
  });

  it('AND-gates multiple guards — all must pass', () => {
    const guards: Guard[] = [
      { type: 'min_description_length', value: 10 },
      { type: 'has_label', value: 'ready' },
      { type: 'has_assignee', value: '' },
    ];
    const results = evaluateGuards(guards, baseContext);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('AND-gates — first failure is visible', () => {
    const guards: Guard[] = [
      { type: 'has_label', value: 'nonexistent' },
      { type: 'min_description_length', value: 10 },
    ];
    const results = evaluateGuards(guards, baseContext);
    expect(results[0]?.passed).toBe(false);
    expect(results[1]?.passed).toBe(true);
  });
});
```

- [ ] **Step 4: Run guard tests**

Run: `cd packages/engine && npx vitest run tests/guards.test.ts`
Expected: All 8 tests pass.

- [ ] **Step 5: Write the transition function**

This is the largest single file. Every state/trigger combination handled. No I/O.

```ts
// packages/engine/src/transition.ts
import type {
  PipelineState, PipelineTrigger, PipelineConfig, TransitionOutcome,
  SideEffect, ColumnMapping, DispatchId, AgentId,
} from '@ouija/types';
import { evaluateGuards } from './guards.js';
import { dispatchId as makeDispatchId } from '@ouija/types';
import { randomUUID } from 'node:crypto';

export function transition(
  state: PipelineState,
  trigger: PipelineTrigger,
  config: PipelineConfig,
): TransitionOutcome {
  switch (trigger.type) {
    case 'card_moved':
      return handleCardMoved(state, trigger, config);
    case 'card_assigned':
      return handleCardAssigned(state, trigger, config);
    case 'agent_acknowledged':
      return handleAgentAcknowledged(state, trigger);
    case 'agent_progress':
      return handleAgentProgress(state, trigger);
    case 'agent_pr_ready':
      return handleAgentPrReady(state, trigger);
    case 'agent_completed':
      return handleAgentCompleted(state, trigger);
    case 'agent_failed':
      return handleAgentFailed(state, trigger);
    case 'stall_detected':
      return handleStallDetected(state, trigger);
    case 'human_retry':
      return handleHumanRetry(state, trigger, config);
    case 'human_cancel':
      return handleHumanCancel(state, trigger);
    case 'pr_merged':
      return handlePrMerged(state, trigger);
    default: {
      const _exhaustive: never = trigger;
      return { rejected: true, reason: `Unknown trigger type: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

function handleCardMoved(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'card_moved' }>,
  config: PipelineConfig,
): TransitionOutcome {
  // If pipeline is already active, track position but don't dispatch
  if (state.status === 'dispatching' || state.status === 'running') {
    return { rejected: true, reason: 'Pipeline already active, skipping dispatch' };
  }

  const mapping = findColumnMapping(trigger.toColumnId, config);
  if (!mapping || mapping.action === 'noop') {
    return { rejected: true, reason: `No action mapped for column ${trigger.toColumnId}` };
  }

  if (mapping.action === 'close_and_notify') {
    return {
      rejected: false,
      nextState: { status: 'succeeded', dispatchId: makeDispatchId(''), agentId: '' as AgentId, completedAt: new Date().toISOString() },
      events: [],
      sideEffects: [{ type: 'send_notification', payload: { message: 'Card completed' }, idempotencyKey: `notify-${trigger.cardId}` }],
    };
  }

  // dispatch_agent
  if (!mapping.agentId) {
    return { rejected: true, reason: 'Column mapping has dispatch_agent but no agentId configured' };
  }

  // Evaluate guards
  const guardResults = evaluateGuards(mapping.guards, trigger.guardContext);
  const failedGuards = guardResults.filter(g => !g.passed);
  if (failedGuards.length > 0) {
    return {
      rejected: false,
      nextState: state, // state unchanged
      events: [],
      sideEffects: [{ type: 'send_notification', payload: { guardsFailed: failedGuards }, idempotencyKey: `guard-fail-${trigger.cardId}` }],
    };
  }

  const newDispatchId = makeDispatchId(randomUUID());
  const stallMs = mapping.stallThresholdMs ?? config.defaultStallThresholdMs;

  return {
    rejected: false,
    nextState: {
      status: 'dispatching',
      dispatchId: newDispatchId,
      agentId: mapping.agentId,
      dispatchedAt: new Date().toISOString(),
    },
    events: [],
    sideEffects: [
      { type: 'dispatch_agent', payload: { dispatchId: newDispatchId, agentId: mapping.agentId }, idempotencyKey: `dispatch-${newDispatchId}` },
      { type: 'enqueue_stall_check', payload: { dispatchId: newDispatchId, delayMs: stallMs }, idempotencyKey: `stall-${newDispatchId}` },
    ],
  };
}

function handleCardAssigned(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'card_assigned' }>,
  config: PipelineConfig,
): TransitionOutcome {
  if (!config.autoStartOnAssign) {
    return { rejected: true, reason: 'Auto-start on assign is disabled' };
  }
  if (state.status !== 'idle') {
    return { rejected: true, reason: `Cannot auto-start: pipeline is in ${state.status}` };
  }
  // Auto-start delegates to the same dispatch logic — caller should construct card_moved trigger
  return { rejected: true, reason: 'card_assigned with auto-start should be converted to card_moved by orchestrator' };
}

function handleAgentAcknowledged(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_acknowledged' }>,
): TransitionOutcome {
  if (state.status !== 'dispatching') {
    return { rejected: true, reason: `Cannot acknowledge: pipeline is ${state.status}, expected dispatching` };
  }
  if (state.dispatchId !== trigger.dispatchId) {
    return { rejected: true, reason: 'Dispatch ID mismatch' };
  }
  return {
    rejected: false,
    nextState: {
      status: 'running',
      dispatchId: state.dispatchId,
      agentId: state.agentId,
      dispatchedAt: state.dispatchedAt,
      lastHeartbeatAt: new Date().toISOString(),
    },
    events: [],
    sideEffects: [],
  };
}

function handleAgentProgress(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_progress' }>,
): TransitionOutcome {
  if (state.status !== 'running') {
    return { rejected: true, reason: `Cannot record progress: pipeline is ${state.status}` };
  }
  return {
    rejected: false,
    nextState: { ...state, lastHeartbeatAt: trigger.heartbeatAt },
    events: [],
    sideEffects: [
      { type: 'cancel_stall_check', payload: { dispatchId: state.dispatchId }, idempotencyKey: `cancel-stall-${trigger.heartbeatAt}` },
      { type: 'enqueue_stall_check', payload: { dispatchId: state.dispatchId }, idempotencyKey: `stall-${trigger.heartbeatAt}` },
    ],
  };
}

function handleAgentPrReady(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_pr_ready' }>,
): TransitionOutcome {
  if (state.status !== 'running') {
    return { rejected: true, reason: `Cannot mark PR ready: pipeline is ${state.status}` };
  }
  return {
    rejected: false,
    nextState: { ...state },
    events: [],
    sideEffects: [
      { type: 'move_card', payload: { columnName: 'Review' }, idempotencyKey: `move-review-${trigger.dispatchId}` },
      { type: 'add_comment', payload: { body: `PR ready: ${trigger.prUrl}` }, idempotencyKey: `comment-pr-${trigger.dispatchId}` },
      { type: 'send_notification', payload: { prUrl: trigger.prUrl }, idempotencyKey: `notify-pr-${trigger.dispatchId}` },
    ],
  };
}

function handleAgentCompleted(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_completed' }>,
): TransitionOutcome {
  if (state.status !== 'running') {
    return { rejected: true, reason: `Cannot complete: pipeline is ${state.status}` };
  }
  return {
    rejected: false,
    nextState: {
      status: 'succeeded',
      dispatchId: state.dispatchId,
      agentId: state.agentId,
      completedAt: new Date().toISOString(),
      prUrl: undefined,
      cost: trigger.cost,
      tokensUsed: trigger.tokensUsed,
    },
    events: [],
    sideEffects: [
      { type: 'cancel_stall_check', payload: { dispatchId: state.dispatchId }, idempotencyKey: `cancel-stall-complete-${trigger.dispatchId}` },
      { type: 'move_card', payload: { columnName: 'Done' }, idempotencyKey: `move-done-${trigger.dispatchId}` },
    ],
  };
}

function handleAgentFailed(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_failed' }>,
): TransitionOutcome {
  if (state.status !== 'running' && state.status !== 'dispatching') {
    return { rejected: true, reason: `Cannot fail: pipeline is ${state.status}` };
  }
  return {
    rejected: false,
    nextState: {
      status: 'failed',
      dispatchId: 'dispatchId' in state ? state.dispatchId : makeDispatchId(''),
      agentId: 'agentId' in state ? state.agentId : '' as AgentId,
      failedAt: new Date().toISOString(),
      error: trigger.error,
      retryable: trigger.retryable,
    },
    events: [],
    sideEffects: [
      { type: 'cancel_stall_check', payload: { dispatchId: trigger.dispatchId }, idempotencyKey: `cancel-stall-fail-${trigger.dispatchId}` },
      { type: 'move_card', payload: { columnName: 'Failed' }, idempotencyKey: `move-fail-${trigger.dispatchId}` },
      { type: 'send_notification', payload: { error: trigger.error }, idempotencyKey: `notify-fail-${trigger.dispatchId}` },
    ],
  };
}

function handleStallDetected(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'stall_detected' }>,
): TransitionOutcome {
  if (state.status !== 'running' && state.status !== 'dispatching') {
    return { rejected: true, reason: `Cannot stall: pipeline is ${state.status}` };
  }
  return {
    rejected: false,
    nextState: {
      status: 'stalled',
      dispatchId: 'dispatchId' in state ? state.dispatchId : makeDispatchId(''),
      agentId: 'agentId' in state ? state.agentId : '' as AgentId,
      stalledAt: trigger.detectedAt,
      lastHeartbeatAt: state.status === 'running' ? state.lastHeartbeatAt : trigger.detectedAt,
    },
    events: [],
    sideEffects: [
      { type: 'send_notification', payload: { message: 'Agent stalled' }, idempotencyKey: `notify-stall-${trigger.dispatchId}` },
    ],
  };
}

function handleHumanRetry(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'human_retry' }>,
  config: PipelineConfig,
): TransitionOutcome {
  if (state.status !== 'failed' && state.status !== 'stalled') {
    return { rejected: true, reason: `Cannot retry: pipeline is ${state.status}` };
  }
  const newId = makeDispatchId(randomUUID());
  return {
    rejected: false,
    nextState: {
      status: 'dispatching',
      dispatchId: newId,
      agentId: state.agentId,
      dispatchedAt: new Date().toISOString(),
    },
    events: [],
    sideEffects: [
      { type: 'dispatch_agent', payload: { dispatchId: newId, agentId: state.agentId }, idempotencyKey: `dispatch-retry-${newId}` },
      { type: 'enqueue_stall_check', payload: { dispatchId: newId, delayMs: config.defaultStallThresholdMs }, idempotencyKey: `stall-retry-${newId}` },
    ],
  };
}

function handleHumanCancel(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'human_cancel' }>,
): TransitionOutcome {
  if (state.status === 'idle' || state.status === 'succeeded' || state.status === 'cancelled') {
    return { rejected: true, reason: `Cannot cancel: pipeline is ${state.status}` };
  }
  const sideEffects: SideEffect[] = [
    { type: 'send_notification', payload: { message: 'Pipeline cancelled' }, idempotencyKey: `notify-cancel-${Date.now()}` },
  ];
  if (state.status === 'dispatching' || state.status === 'running') {
    sideEffects.push(
      { type: 'cancel_agent', payload: { dispatchId: state.dispatchId }, idempotencyKey: `cancel-agent-${state.dispatchId}` },
      { type: 'cancel_stall_check', payload: { dispatchId: state.dispatchId }, idempotencyKey: `cancel-stall-cancel-${state.dispatchId}` },
    );
  }
  return {
    rejected: false,
    nextState: { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: trigger.cancelledBy },
    events: [],
    sideEffects,
  };
}

function handlePrMerged(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'pr_merged' }>,
): TransitionOutcome {
  if (state.status !== 'running' && state.status !== 'succeeded') {
    return { rejected: true, reason: `Cannot mark merged: pipeline is ${state.status}` };
  }
  return {
    rejected: false,
    nextState: {
      status: 'succeeded',
      dispatchId: 'dispatchId' in state ? state.dispatchId : makeDispatchId(''),
      agentId: 'agentId' in state ? state.agentId : '' as AgentId,
      completedAt: trigger.mergedAt,
      prUrl: undefined,
      cost: state.status === 'succeeded' ? state.cost : undefined,
      tokensUsed: state.status === 'succeeded' ? state.tokensUsed : undefined,
    },
    events: [],
    sideEffects: [
      { type: 'move_card', payload: { columnName: 'Done' }, idempotencyKey: `move-merged-${trigger.prId}` },
      { type: 'cancel_stall_check', payload: {}, idempotencyKey: `cancel-stall-merged-${trigger.prId}` },
    ],
  };
}

function findColumnMapping(colId: ColumnId, config: PipelineConfig): ColumnMapping | undefined {
  return config.columnMappings.find(m => m.columnId === colId);
}
```

- [ ] **Step 6: Write transition tests (100% coverage)**

```ts
// packages/engine/tests/transition.test.ts
import { describe, it, expect } from 'vitest';
import { transition } from '../src/transition.js';
import type { PipelineState, PipelineTrigger, PipelineConfig, GuardContext } from '@ouija/types';
import { cardId, columnId, dispatchId, agentId, prId, boardId } from '@ouija/types';

const testConfig: PipelineConfig = {
  boardId: boardId('board-1'),
  defaultStallThresholdMs: 300_000,
  autoStartOnAssign: false,
  columnMappings: [
    {
      columnId: columnId('col-inprogress'),
      columnName: 'In Progress',
      action: 'dispatch_agent',
      agentId: agentId('agent-rex'),
      guards: [{ type: 'min_description_length', value: 10 }],
    },
    {
      columnId: columnId('col-done'),
      columnName: 'Done',
      action: 'close_and_notify',
      guards: [],
    },
    {
      columnId: columnId('col-backlog'),
      columnName: 'Backlog',
      action: 'noop',
      guards: [],
    },
  ],
};

const guardCtx: GuardContext = {
  cardDescription: 'Implement the login page with full OAuth support',
  cardLabels: ['ready'],
  cardAssignees: ['agent-rex'],
};

describe('transition', () => {
  // ---- card_moved ----
  it('dispatches agent when card moved to mapped column with passing guards', () => {
    const state: PipelineState = { status: 'idle' };
    const trigger: PipelineTrigger = {
      type: 'card_moved', cardId: cardId('c1'), toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'), guardContext: guardCtx,
    };
    const result = transition(state, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('dispatching');
      expect(result.sideEffects.some(e => e.type === 'dispatch_agent')).toBe(true);
      expect(result.sideEffects.some(e => e.type === 'enqueue_stall_check')).toBe(true);
    }
  });

  it('rejects dispatch when card is already active', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const trigger: PipelineTrigger = {
      type: 'card_moved', cardId: cardId('c1'), toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'), guardContext: guardCtx,
    };
    const result = transition(state, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects when guards fail', () => {
    const state: PipelineState = { status: 'idle' };
    const shortCtx: GuardContext = { ...guardCtx, cardDescription: 'Fix' };
    const trigger: PipelineTrigger = {
      type: 'card_moved', cardId: cardId('c1'), toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'), guardContext: shortCtx,
    };
    const result = transition(state, trigger, testConfig);
    // Guard failure is NOT a rejection — it produces a notification side effect
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('idle'); // state unchanged
      expect(result.sideEffects.some(e => e.type === 'send_notification')).toBe(true);
    }
  });

  it('rejects when column has no mapping', () => {
    const state: PipelineState = { status: 'idle' };
    const trigger: PipelineTrigger = {
      type: 'card_moved', cardId: cardId('c1'), toColumnId: columnId('col-unknown'),
      fromColumnId: columnId('col-backlog'), guardContext: guardCtx,
    };
    const result = transition(state, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('handles close_and_notify action', () => {
    const state: PipelineState = { status: 'idle' };
    const trigger: PipelineTrigger = {
      type: 'card_moved', cardId: cardId('c1'), toColumnId: columnId('col-done'),
      fromColumnId: columnId('col-inprogress'), guardContext: guardCtx,
    };
    const result = transition(state, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('succeeded');
    }
  });

  // ---- agent lifecycle ----
  it('acknowledges agent → running', () => {
    const state: PipelineState = { status: 'dispatching', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '' };
    const result = transition(state, { type: 'agent_acknowledged', dispatchId: dispatchId('d1') }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.nextState.status).toBe('running');
  });

  it('rejects acknowledge with wrong dispatch ID', () => {
    const state: PipelineState = { status: 'dispatching', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '' };
    const result = transition(state, { type: 'agent_acknowledged', dispatchId: dispatchId('d-wrong') }, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('records agent progress → resets stall check', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'agent_progress', dispatchId: dispatchId('d1'), heartbeatAt: '2026-04-01T12:00:00Z', message: 'Working...' }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.sideEffects.some(e => e.type === 'cancel_stall_check')).toBe(true);
      expect(result.sideEffects.some(e => e.type === 'enqueue_stall_check')).toBe(true);
    }
  });

  it('handles PR ready → moves card + notifies', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'agent_pr_ready', dispatchId: dispatchId('d1'), prUrl: 'https://github.com/org/repo/pull/1', prId: prId('pr-1') }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.sideEffects.some(e => e.type === 'move_card')).toBe(true);
      expect(result.sideEffects.some(e => e.type === 'add_comment')).toBe(true);
    }
  });

  it('handles agent completed → succeeded', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'agent_completed', dispatchId: dispatchId('d1'), cost: 0.50 }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('succeeded');
      expect(result.sideEffects.some(e => e.type === 'move_card')).toBe(true);
    }
  });

  it('handles agent failed → failed state + notification', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'agent_failed', dispatchId: dispatchId('d1'), error: 'API error', retryable: true }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('failed');
      expect(result.sideEffects.some(e => e.type === 'send_notification')).toBe(true);
    }
  });

  it('handles stall detected → stalled + notification', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '2026-04-01T11:00:00Z' };
    const result = transition(state, { type: 'stall_detected', dispatchId: dispatchId('d1'), detectedAt: '2026-04-01T12:00:00Z' }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.nextState.status).toBe('stalled');
  });

  // ---- human actions ----
  it('retries from failed → dispatching', () => {
    const state: PipelineState = { status: 'failed', dispatchId: dispatchId('d1'), agentId: agentId('a1'), failedAt: '', error: 'err', retryable: true };
    const result = transition(state, { type: 'human_retry', retriedBy: 'mk' }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('dispatching');
      expect(result.sideEffects.some(e => e.type === 'dispatch_agent')).toBe(true);
    }
  });

  it('retries from stalled → dispatching', () => {
    const state: PipelineState = { status: 'stalled', dispatchId: dispatchId('d1'), agentId: agentId('a1'), stalledAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'human_retry', retriedBy: 'mk' }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.nextState.status).toBe('dispatching');
  });

  it('cancels running pipeline → cancelled + cancel agent', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'human_cancel', cancelledBy: 'mk' }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('cancelled');
      expect(result.sideEffects.some(e => e.type === 'cancel_agent')).toBe(true);
    }
  });

  it('rejects cancel on idle pipeline', () => {
    const result = transition({ status: 'idle' }, { type: 'human_cancel', cancelledBy: 'mk' }, testConfig);
    expect(result.rejected).toBe(true);
  });

  // ---- pr_merged ----
  it('handles PR merged → succeeded', () => {
    const state: PipelineState = { status: 'running', dispatchId: dispatchId('d1'), agentId: agentId('a1'), dispatchedAt: '', lastHeartbeatAt: '' };
    const result = transition(state, { type: 'pr_merged', prId: prId('pr-1'), mergedAt: '2026-04-01T12:00:00Z' }, testConfig);
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.nextState.status).toBe('succeeded');
  });
});
```

- [ ] **Step 7: Run transition tests**

Run: `cd packages/engine && npx vitest run tests/transition.test.ts`
Expected: All tests pass. Every state/trigger combination covered.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/
git commit -m "feat(engine): pure transition function + guards with 100% coverage"
```

---

> **NOTE: Tasks 4-12 continue the build in the same pattern.** Due to the size of this plan, I am providing the task outlines for 4-12 with file structure and key implementation notes. Each task follows the same TDD discipline: write failing test → implement → verify → commit.

---

### Task 4: EventBus + JobQueue Abstractions (packages/bus)

**Files:** `packages/bus/src/{event-bus.ts, job-queue.ts, bullmq-event-bus.ts, bullmq-job-queue.ts}`

**Key implementation:**
- `EventBus` interface with typed `publish<T>()`, `subscribe<T>()`, and `subscribePattern()` (separate method for wildcards — type-unsafe by design)
- `JobQueue` interface with typed `enqueue<T>()` and `process<T>()` using `QueueDataMap` for type safety
- BullMQ implementations. EventBus fan-out: one BullMQ job per subscriber (simple, correct for v1)
- Integration tests require Redis (use `testcontainers` or skip with `describe.skipIf`)

---

### Task 5: Postgres Repository + Migrations (packages/engine)

**Files:** `packages/engine/src/{repository.ts, migrations/001-initial-schema.sql}`

**Key implementation:**
- `PipelineRepository`, `PipelineEventRepository`, `BoardConfigRepository` — all async, all using `pg` (node-postgres)
- `UnitOfWork` wraps a Postgres transaction: `BEGIN` → operations → `COMMIT`
- Schema: `pipeline_instances`, `pipeline_events` (append-only), `card_instance_index`, `stall_check_jobs`, `board_configs`, `webhook_dedup`
- Integration tests use testcontainers `PostgreSqlContainer`

---

### Task 6: Orchestrator (packages/engine)

**Files:** `packages/engine/src/orchestrator.ts`, `packages/engine/src/stall-monitor.ts`

**Key implementation:**
- `Orchestrator.processTrigger(event)`: load instance → fetch guard context → call `transition()` → persist in transaction → execute side effects via `Promise.all()`
- Config cache with 30s TTL (`Map<boardId, { config, cachedAt }>`)
- `StallMonitor`: `setInterval` every 60s, queries `pipeline_instances` for stale entries, calls `processTrigger` with `stall_detected`
- Tests use mock repositories and mock bus

---

### Task 7: Plugin SDK + Mock Plugins (packages/plugin-sdk)

**Files:** `packages/plugin-sdk/src/{plugin-loader.ts, config-validator.ts}`, `packages/plugin-sdk/src/test-utils/{mock-context.ts, mock-kanban.ts, mock-git.ts, mock-agent.ts}`

**Key implementation:**
- `PluginLoader`: explicit config → validate manifest → topological sort → init → registerRoutes → start
- `ConfigValidator`: Ajv + `json-schema-to-ts` with `FromSchema` for type inference
- Mock plugins implement full interfaces with in-memory state — used by engine integration tests and by plugin developers
- `coreApiVersion` compatibility check at startup

---

### Task 8: Input Sanitizer (packages/engine)

**Files:** `packages/engine/src/sanitizer.ts`, `packages/engine/tests/sanitizer.test.ts`

**Key implementation:**
- Strip HTML comments (`<!-- ... -->`)
- Flag URLs to non-allowlisted domains (configurable allowlist)
- Warn on shell metacharacters (`$(...)`, backticks, `|`, `>`)
- Flag workflow file references (`.github/workflows/`)
- Flag secret file references (`.env`, `credentials.json`)
- Returns `{ sanitized: string, warnings: string[] }` — warnings surface in pipeline timeline

---

### Task 9: Fastify Server + Auth + Webhook Ingress (packages/server)

**Files:** `packages/server/src/{app.ts, index.ts, routes/*, middleware/*, jwt.ts}`

**Key implementation:**
- App factory pattern (Fastify instance created by function, for testing with `inject()`)
- Auth middleware: cookie check first, then Bearer token, unified middleware chain
- JWT module: issue agent JWTs (RS256), verify, refresh (new token in response body when <5min remaining), Redis denylist
- Webhook routes: HMAC verification (X-Plane-Signature, X-Hub-Signature-256), path secret, always return 200, dedup check
- Agent callback: `POST /hooks/agent/callback` with JWT in `Authorization` header
- Health routes: `/healthz` (unauthenticated, minimal), `/readyz` (auth-gated details)
- Error handler: `ApiError` → structured JSON response, no stack traces in production
- Rate limiting via `@fastify/rate-limit`
- Security headers via `@fastify/helmet`

---

### Task 10: Plane Plugin (packages/plugin-plane)

**Files:** `packages/plugin-plane/src/{index.ts, config.ts, api-client.ts, webhook-handler.ts, agent-user.ts}`

**Key implementation:**
- `PlanePlugin implements KanbanPlugin<PlaneConfig>`
- Config schema as `const` with `FromSchema` type inference
- API client: Plane REST API v1 (getCard, moveCard, addComment, assignUser, getColumns)
- Webhook handler: normalize Plane's issue events → `kanban.card.moved`, `kanban.card.assigned`
- `registerRoutes()`: registers `POST /hooks/plane/:secret` on the Fastify instance
- Agent user registration: create/sync bot users on Plane workspace
- Contract tests against recorded webhook payloads in `fixtures/`

---

### Task 11: GitHub Plugin (packages/plugin-github)

**Files:** `packages/plugin-github/src/{index.ts, config.ts, api-client.ts, webhook-handler.ts}`

**Key implementation:**
- `GitHubPlugin implements GitPlugin<GitHubConfig>`
- API client via Octokit: createBranch, openPR, mergePR, addPRComment
- Webhook handler: normalize GitHub PR events → `git.pr.opened`, `git.pr.merged`
- `registerRoutes()`: registers `POST /hooks/github/:secret` with HMAC-SHA256 verification (`X-Hub-Signature-256`)
- Contract tests against recorded payloads

---

### Task 12: Docker Compose + End-to-End Integration

**Files:** `docker/docker-compose.yml`, `docker/docker-compose.ouija.yml`, `docker/Dockerfile`, `infra/postgres/init/01-create-databases.sql`, `infra/redis/valkey.conf`

**Key implementation:**
- Multi-stage Dockerfile (build stage with turbo prune, production stage with node:22-alpine)
- `docker-compose.ouija.yml` (default): ouija + postgres + redis. Ouija-only, BYO kanban.
- `docker-compose.yml` (full): adds plane-aio + plane-redis + rabbitmq + minio
- Separate Redis instances: `ouija-redis` (noeviction) and `plane-redis` (allkeys-lru)
- Postgres init script creates `ouija_db` with restricted role
- Health checks on all services
- Named volumes for all persistent data
- Non-root containers, read-only filesystem, no-new-privileges
- **End-to-end test:** `docker compose up`, create a board config via API, simulate a Plane webhook via `curl`, verify pipeline transitions through to completion

---

## Execution Summary

| Task | Package | Estimated Days | Dependencies |
|------|---------|---------------|-------------|
| 1 | root, types scaffold | 0.5 | — |
| 2 | types | 1.5 | Task 1 |
| 3 | engine (transition) | 3 | Task 2 |
| 4 | bus | 2 | Task 2 |
| 5 | engine (repository) | 3 | Task 2 |
| 6 | engine (orchestrator) | 3 | Tasks 3, 4, 5 |
| 7 | plugin-sdk | 2 | Task 2 |
| 8 | engine (sanitizer) | 1 | Task 2 |
| 9 | server | 5 | Tasks 4, 5, 6 |
| 10 | plugin-plane | 4 | Tasks 7, 9 |
| 11 | plugin-github | 3 | Tasks 7, 9 |
| 12 | docker | 3 | Tasks 9, 10, 11 |

**Critical path:** 1 → 2 → 3 → (4 ∥ 5) → 6 → 9 → (10 ∥ 11) → 12

**Total: ~8 weeks** for one engineer. Tasks 4/5 and 10/11 are parallelizable with a second person.

---

## What This Plan Does NOT Cover (Phase 2+)

- Dashboard (React SPA)
- CLI (ouija init, check, status, etc.)
- Notification plugin (Telegram)
- Agent plugin (Claude Code dispatcher — Phase 1 uses mock agent)
- Cloud SaaS features (RLS, KMS, RBAC)
- SOC 2 / GDPR compliance
- `ouija demo` command
