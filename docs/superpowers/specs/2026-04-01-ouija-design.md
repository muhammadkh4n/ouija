# Ouija — Design Specification

**Product:** Ouija — A modular pipeline engine where kanban board columns are the control plane and AI agents are board members.
**Author:** Muhammad Khan + Claude
**Date:** 2026-04-01
**Status:** Approved after review by 14 specialist agents across 2 rounds (Security, Architecture, Performance, DX, API, UI/UX, Deployment, CEO/Product, Eng Manager, Pen Testing, Chaos Engineering, TypeScript, CLI, Compliance)
**Revision:** 2 (incorporates all Round 2 critical findings)

---

## 1. Product Vision

Ouija is a pipeline engine that turns kanban cards into shipped code. AI agents are literal users on the kanban board. When a card moves to "In Progress," an agent picks it up, reads the description, clones the repo, writes code, opens a PR, and moves the card forward. The human stays in control through board interactions — dragging cards, assigning agents, approving PRs.

**Core value proposition:** "AI agents can write code, but nobody is managing them. Ouija turns your kanban board into a dispatch center for AI engineers."

**Target customer:** Small engineering teams (3-10 engineers) running multiple AI agents across multiple projects who need governance, cost visibility, and approval flows. Solo devs are better served by Claude Code hooks + GitHub Actions.

**Product offerings:**
- **Self-hosted (open source):** Docker Compose + CLI. Free forever. Apache 2.0 license (see Section 13.1 for AGPL considerations).
- **Cloud SaaS (ouija.dev):** Hosted Ouija with managed infrastructure. Per-merged-PR pricing (aligns incentives — failed runs have zero value).
- **BYO Kanban:** Ouija-only (customer uses their own Jira/Linear/Trello via plugins). This is the primary growth wedge — customers adopt without migrating boards.

**What Ouija is NOT:**
- Not a kanban board (Plane/Jira/Linear are the boards — Ouija automates them)
- Not an AI coding agent (Claude/GPT/Codex are the agents — Ouija dispatches them)
- Not a CI/CD system (GitHub Actions/Jenkins run CI — Ouija triggers the workflow)

---

## 2. Architecture Overview

### 2.1 Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | TypeScript + Node.js | Matches existing ecosystem, plugin extensibility |
| HTTP | Fastify | Schema validation, plugin architecture, OpenAPI generation |
| Job Queue | BullMQ (Redis-backed) | Reliable task execution, retries, delayed jobs |
| Event Bus | Abstract interface, BullMQ impl for v1 | Decoupled from job queue at interface level (swappable to Redis Streams/NATS later) |
| Database | PostgreSQL 15 | Single DB engine for v1. Runs in Docker for self-hosted (zero added ops). RLS for cloud multi-tenancy. SQLite deferred to v1.1 if demand exists. |
| Dashboard | React + Vite + Tailwind + shadcn/ui | SPA served by Fastify on same port |
| Monorepo | Turborepo | Matches openclaw-memory pattern, independent package versioning |
| Containerization | Docker Compose | Sufficient for v1, migrate to k3s when cloud customers exist |

### 2.2 Repository Structure

```
ouija/
  packages/
    types/                    # Shared TypeScript types, event schemas, API contracts
    engine/                   # Pipeline state machine + transition execution
    bus/                      # EventBus + JobQueue abstractions (BullMQ impl)
    plugin-sdk/               # BasePlugin, PluginManifest, config validation, lifecycle
    plugin-plane/             # Kanban plugin: Plane
    plugin-github/            # Git plugin: GitHub
    plugin-agent-claude/      # Agent dispatcher: Claude Code / ACP
    plugin-notify-telegram/   # Notification plugin: Telegram
    dashboard/                # React SPA (dark mode default)
    cli/                      # ouija CLI (init, start, check, plugins)
  docker/
    docker-compose.yml        # Full stack: Ouija + Plane + Postgres + Redis + RabbitMQ + MinIO
    docker-compose.ouija.yml  # Ouija-only: BYO kanban (SQLite + Redis)
  infra/
    setup.sh                  # First-time setup: generate secrets, populate .env
    postgres/init/            # Database initialization scripts
    redis/valkey.conf         # Redis config with memory limits
    rabbitmq/                 # RabbitMQ config for Plane
    plane/plane.env           # Plane configuration
    backup/backup.sh          # Atomic backup with integrity verification
    tailscale/                # Funnel setup + caffeinate plist
  docs/
```

### 2.3 System Architecture

```
                        Tailscale Funnel (personal) / Cloudflare (cloud)
                                        |
                                   [ Ouija Core :4000 ]
                                   /        |         \
                            Dashboard    REST API    Webhook Ingress
                              SPA      + SSE + WS    /hooks/*
                                        |
                    ┌───────────────────┼───────────────────┐
                    |                   |                   |
              [ EventBus ]        [ JobQueue ]        [ Pipeline Engine ]
              (fan-out,           (dispatch,           (pure transition fn
               pub/sub)           retry, stall)        + I/O engine)
                    |                   |                   |
              ┌─────┼─────┐      ┌─────┼─────┐            |
              |     |     |      |     |     |        [ Database ]
           Kanban  Git  Notify  Agent Stall  ...      SQLite or Postgres
           Plugin Plugin Plugin Dispatch Check
```

### 2.4 Key Architecture Decisions

**Decision 1: Pure transition function (PROTECT THIS)**
`transition(state, trigger, config) → { instance, events, sideEffects }` — zero I/O, fully testable without mocks. The engine handles all I/O around it. DB write always precedes BullMQ enqueue. Reversal difficulty: 9/10 if corrupted. Never add I/O inside the transition function. If guards need external data, fetch it before calling transition and pass it in the trigger payload.

**Decision 2: EventBus ≠ JobQueue (separate at interface, unified at impl)**
Both backed by BullMQ for v1. `EventBus` interface: `publish(topic, event)`, `subscribe(pattern, handler)`, `replay(topic, from, to)`. `JobQueue` interface: `enqueue(queue, job, options)`, `process(queue, handler)`. When BullMQ becomes a bottleneck for events, swap EventBus to Redis Streams without touching plugins.

**Decision 3: Postgres only for v1**
Build on Postgres only. Docker Compose already runs Postgres — zero added ops for self-hosters. Abstract storage behind an async repository interface so SQLite can be added in v1.1 if real user demand exists, but do not build or maintain two database backends for v1. SQLite and Postgres have fundamentally different concurrency semantics (database-level vs row-level locking) that a repository abstraction cannot fully hide. Ship one, ship it well.

**Decision 4: Plane is a plugin, not a dependency**
Pin Plane to a specific version in docker-compose. Test webhook payloads in CI. Design `KanbanPlugin` interface so swapping Plane for Linear/Jira takes less than a week. Do not leak Plane-specific concepts (issues vs cards, modules, cycles) into the event bus.

**Decision 5: Agent execution is a plugin, not core**
The product is the brain (orchestration, routing, approval, status tracking), not the hands (code generation). Ship a reference agent plugin for Claude Code / ACP. Customers can plug in whatever agent they use.

---

## 3. Plugin System

### 3.1 Plugin Types

Four plugin types, all extending `BasePlugin<TConfig>`:

```typescript
interface BasePlugin<TConfig = unknown> {
  manifest: PluginManifest;
  init(context: PluginContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<PluginHealth>;
  registerRoutes?(server: FastifyInstance): Promise<void>; // optional
}
```

| Type | Responsibility | Events Produced | Methods |
|------|---------------|-----------------|---------|
| **KanbanPlugin** | Register webhooks/poll, normalize card events, CRUD cards, register agent-users | `kanban.card.moved`, `kanban.card.created`, `kanban.card.assigned` | `getCard`, `moveCard`, `addComment`, `assignUser`, `getColumns` |
| **GitPlugin** | Receive PR/CI webhooks, branch/PR operations | `git.pr.opened`, `git.pr.merged`, `git.pr.review`, `git.check.status` | `createBranch`, `openPR`, `mergePR`, `addPRComment` |
| **AgentPlugin** | Dispatch work orders, report progress via callbacks | `agent.work.progress`, `agent.work.pr_ready`, `agent.work.completed`, `agent.work.failed` | `dispatch(workOrder)`, `cancel(id)`, `getStatus(id)` |
| **NotificationPlugin** | Send templated messages with action buttons/deep links | (none — consumes events) | `send(notification)`, `testConnection()` |

### 3.2 Plugin Manifest

```typescript
interface PluginManifest {
  name: string;                    // e.g. "@ouija-dev/plugin-plane"
  version: string;                 // semver
  type: 'kanban' | 'git' | 'agent' | 'notification';
  coreApiVersion: string;          // e.g. ">=1.0 <2.0" — checked at startup
  configSchema: JSONSchema;        // validated by Ajv before init()
  dependencies?: string[];         // other plugin names (topological sort)
  events?: {
    produces: string[];            // event types this plugin emits
    consumes: string[];            // event types this plugin handles
  };
}
```

### 3.3 Plugin Communication

- **Event bus** for plugin-to-plugin: loose coupling, fan-out, pattern subscriptions (`kanban.card.*`, `git.**`)
- **Direct method calls** for pipeline-to-plugin CRUD: needs return values, no indirection
- **Plugins never call each other directly**

### 3.4 Plugin Isolation

- Each plugin gets its own BullMQ queue (one plugin's backlog doesn't affect others)
- Circuit breaker per event handler (prevents cascading failures)
- Environment variables stripped from plugin context — only declared config passed
- **V1:** In-process with restricted context
- **V2 (cloud):** Child processes or V8 isolates for hard isolation

### 3.5 Plugin Lifecycle

1. **Discovery:** Explicit config only (no magic scanning). `ouija.config.yaml` declares plugins.
2. **Validation:** Config validated against `manifest.configSchema` (Ajv) before `init()`.
3. **Dependency resolution:** Topological sort on `manifest.dependencies`. Circular deps throw at startup.
4. **Init:** Dependencies first, then dependents. `PluginContext` injected.
5. **Route registration:** If plugin implements `registerRoutes()`, called after all plugins init, before server listen.
6. **Start:** All plugins start concurrently. One failing doesn't take down others.
7. **Shutdown:** Reverse dependency order, configurable timeout per plugin.

### 3.6 Event Schema Versioning

Event schemas defined in `packages/types/` as versioned TypeScript types. Plugins declare which event versions they produce and consume in their manifest. Engine validates compatibility at startup. Prevents silent failures when plugins drift.

---

## 4. Pipeline State Machine

### 4.1 States

```
idle → dispatching → running → succeeded
                            → failed
                            → stalled
```

### 4.2 Triggers

| Trigger | Source | Action |
|---------|--------|--------|
| `card_moved` | Kanban webhook | Check column-to-action mapping, evaluate guards, dispatch agent |
| `card_assigned` | Kanban webhook | If auto-start enabled, dispatch immediately |
| `agent_acknowledged` | Agent callback | Move to `running`, start dead man's switch |
| `agent_progress` | Agent heartbeat | Update heartbeat timestamp, reset stall timer |
| `agent_pr_ready` | Agent callback | Store PR link, move card to "Review" column |
| `agent_completed` | Agent callback | Move card to "Done", record cost/tokens |
| `agent_failed` | Agent callback | Move card to "Failed" column, notify human |
| `stall_detected` | Dead man's switch | Notify human, mark stalled |
| `human_retry` | Dashboard/API | Re-evaluate guards, new attempt, re-dispatch |
| `human_cancel` | Dashboard/API | Terminate agent, move card to cancelled state |
| `pr_merged` | Git webhook | Move card to "Done" |

### 4.3 Column-to-Action Mapping

Configurable per project. Each column maps to an action:

```yaml
column_mappings:
  - column: "In Progress"
    action: dispatch_agent
    agent: "rex-coder"
    guards:
      - type: min_description_length
        value: 50
      - type: has_label
        value: "ready"
  - column: "Review"
    action: dispatch_agent
    agent: "rex-reviewer"
  - column: "QA"
    action: dispatch_agent
    agent: "rex-qa"
  - column: "Done"
    action: close_and_notify
```

### 4.4 Guard Conditions

Guards are AND-ed, fail early. `guard_failed` event records exactly which guards failed and why (surfaced in card timeline).

Supported guards:
- `min_description_length` — card description must exceed N characters
- `has_label` — card must have specific label
- `has_assignee` — card must be assigned
~~`custom_expression`~~ — **removed from v1.** Underspecified extension point with code injection risk. Will be replaced by a `GuardPlugin` extension point in v2 with a restricted predicate language (JSON Logic or similar), not arbitrary expressions.

### 4.5 Dead Man's Switch (Two Layers)

**Layer 1 (primary): BullMQ delayed job.** Every dispatch enqueues a `stall_check` job with `delay = stalledThresholdMs`. Each heartbeat cancels the pending job and enqueues a fresh one. Catches stalls precisely.

**Layer 2 (backup): SQLite/Postgres scanner.** Runs every 60 seconds. Queries for instances in `dispatched` or `running` state past their threshold. Catches anything that survives a Redis restart.

Stall threshold is configurable per-column per-board (QA agent gets 30 min, code review agent gets 10 min).

### 4.6 Concurrency and Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Card moved while agent is running | Pipeline tracks new position but does NOT dispatch second agent. `skippedDispatch: true` in event payload. |
| Two triggers race for same card | SQLite/Postgres writer lock serializes them. Second writer sees state committed by first. |
| Agent never responds | Dead man's switch marks stalled, notifies human. |
| Webhook replay/duplicate | Dedup table keyed on external event ID with 7-day TTL. |
| Card assigned to same agent twice | Transition function rejects if already in active state. |
| Engine crashes mid-side-effect | DB write precedes side effects. Recovery scanner re-executes. All side effects must be idempotent (keyed on `idempotency_key` = instanceId + transition sequence number). |

### 4.7 Pipeline State Persistence

**Schema (Postgres for cloud, SQLite for self-hosted):**

- `pipeline_instances` — current state, timestamps, metadata, PR link, cost/tokens
- `pipeline_events` — append-only timeline of all state transitions
- `card_instance_index` — O(1) lookup from card_id to current instance
- `stall_check_jobs` — mirrors BullMQ delayed jobs for crash recovery
- `board_configs` — column mappings, guard configs, stall thresholds

All tables use STRICT mode (SQLite) or appropriate constraints (Postgres). `pipeline_events` is append-only — no UPDATE or DELETE.

**No `updated_at` triggers.** Application layer maintains `updated_at` directly. Triggers cause 2x write amplification with no benefit.

### 4.8 WorkOrder Contract

The WorkOrder is the most critical interface in the system — it defines how the engine communicates with every agent plugin.

```typescript
interface WorkOrder {
  instanceId: string;         // pipeline instance ID
  cardId: string;             // kanban card ID
  title: string;              // card title
  description: string;        // card description (sanitized — see §4.10)
  acceptanceCriteria: string[];// extracted from card if present
  repoUrl: string;            // git clone URL
  branch: string;             // branch naming convention: ouija/<instanceId>
  baseBranch: string;         // e.g. "main"
  agentProfileId: string;     // which agent profile to use
  systemPrompt: string;       // from agent profile
  secretRef: string;          // reference to AI API key (never raw key)
  callbackUrl: string;        // POST /hooks/agent/callback (fixed path)
  callbackToken: string;      // JWT for authenticating callbacks
  filePathHints?: string[];   // optional: files the card references
  languageHints?: string[];   // optional: detected languages in repo
  maxDurationMs: number;      // stall threshold — agent should self-terminate after this
  metadata: Record<string, string>; // pass-through for plugin-specific data
}
```

### 4.9 Orchestrator (Trigger Handler)

The **Orchestrator** is the glue layer between the EventBus and the Pipeline Engine. It is the named component that:

1. Subscribes to pipeline-relevant events (`kanban.card.moved`, `kanban.card.assigned`, `git.pr.merged`, agent callbacks)
2. For each event: loads the pipeline instance from the database
3. Fetches any external context needed for guards (e.g., existing open PRs, agent availability)
4. Calls the pure `transition()` function with the assembled trigger
5. Persists the result in a single transaction (DB write)
6. Enqueues side effects to BullMQ (after DB commit)
7. Handles errors when side effects fail (logs, retries, alerts)

```typescript
// Conceptual — lives in packages/engine/src/orchestrator.ts
class Orchestrator {
  async processTrigger(event: OuijaEvent): Promise<void> {
    const instance = await this.db.pipelines.findByCardId(event.payload.cardId);
    const config = await this.configCache.get(instance.boardId); // 30s TTL cache
    const externalContext = await this.fetchGuardContext(instance, config);
    
    const trigger = this.buildTrigger(event, externalContext);
    const result = transition(instance.state, trigger, config);
    
    if (result.rejected) {
      await this.db.pipelineEvents.append(rejectionEvent(result));
      return;
    }
    
    await this.db.transaction(async (uow) => {
      await uow.pipelines.save(result.nextState);
      for (const evt of result.events) await uow.pipelineEvents.append(evt);
    });
    
    // Side effects AFTER db commit — idempotent, keyed on instanceId + sequence
    await Promise.all(result.sideEffects.map(e => this.executeSideEffect(e)));
  }
}
```

### 4.10 Agent Input Sanitization

Card descriptions are user-controlled input that flows directly into agent work orders. This is a **prompt injection surface**. A malicious card description can instruct the agent to exfiltrate code, create malicious workflow files, or leak secrets.

**Sanitization pipeline (applied before WorkOrder construction):**

1. **Strip HTML comments** — hidden instructions in `<!-- -->` blocks
2. **Detect and flag URLs to non-allowlisted domains** — potential exfiltration targets
3. **Reject or warn on shell metacharacters** — `$(...)`, backticks, `|`, `>`
4. **Flag workflow file references** — `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`
5. **Flag environment file references** — `.env`, `credentials.json`, `secrets.yaml`
6. **Content length sanity check** — reject descriptions over 50KB

**Output validation (after agent creates PR):**
1. Scan PR diff for workflow file additions or modifications
2. Scan for `.env` or secrets file changes
3. Scan for dependency modifications (package.json, requirements.txt, go.mod)
4. Flag any of the above in the pipeline timeline for human review before the card advances

**This is not foolproof** — sophisticated prompt injection can bypass keyword scanning. But it raises the bar from "trivial exploit" to "requires targeted effort" and ensures the most common attack patterns are caught.

### 4.11 Agent JWT Lifecycle

**Initial issuance:** Engine mints a JWT when dispatching the agent. Claims: `instanceId`, `boardId`, `workspaceId`, `aud: "ouija-agent-callback"`, `iss: "ouija"`, `jti`, `exp` (15 min). Signed with RS256/EdDSA.

**Refresh mechanism:** The agent callback endpoint accepts a `refresh: true` flag in heartbeat payloads. If the current JWT has <5 minutes remaining, the response includes a new JWT with a fresh 15-minute expiry. The old JWT is added to the Redis denylist. This allows agents to run for hours without a single long-lived token.

**Revocation:** On pipeline cancel, the JWT's `jti` is added to the Redis denylist with TTL = remaining token lifetime. If Redis is down, the system **fails closed** — callbacks are rejected until Redis recovers.

**Cancel semantics:** `cancel(dispatchId)` does three things:
1. Revokes the JWT (denylist)
2. Calls `AgentPlugin.cancel(dispatchId)` — **best-effort**. External agents (Claude Code, GPT) cannot be forcibly terminated. The agent may continue running and push code.
3. Moves pipeline to `cancelled` state. Any subsequent callbacks from the cancelled agent are rejected (JWT revoked).
4. Dashboard shows "Cancellation requested" (not "Cancelled") until the agent's stall threshold expires or it stops calling back.

**Agent callback endpoint:** `POST /hooks/agent/callback` with JWT in `Authorization: Bearer` header (NOT in URL path — URL tokens leak via logs, proxy headers, and Referer).

---

## 4b. Testing Strategy

### Unit Tests (fast, no I/O, hundreds)

- **Transition function:** 100% transition coverage — every valid state/trigger pair tested, every invalid transition tested for rejection. Pure functions, zero mocks.
- **Guard evaluation logic.**
- **Config validation (Ajv schema tests).**
- **Event schema validation.**
- **Input sanitization pipeline.**

### Integration Tests (require Redis + Postgres, tens)

- **EventBus + JobQueue:** Publish, subscribe, fan-out, replay, failure handling.
- **Repository layer:** CRUD against real Postgres (use testcontainers).
- **Plugin lifecycle:** Init, start, stop, health check sequence.
- **Webhook ingress:** HMAC verification, dedup, rate limiting (Fastify `inject()`).
- **Auth flows:** Cookie issuance, JWT verification/refresh/revocation, session rotation.
- **Orchestrator:** End-to-end from event → transition → DB write → side effect enqueue.

### Contract Tests (webhook payload stability)

- Record real webhook payloads from Plane and GitHub as fixtures.
- Test that each plugin normalizes them correctly to `StandardCard` / `StandardPR`.
- When Plane is upgraded, re-record and verify backward compatibility.
- CI runs contract tests against pinned Plane version.

### Mock Plugin Implementations

Ship a `MockKanbanPlugin`, `MockGitPlugin`, `MockAgentPlugin` in `packages/plugin-sdk/test-utils/`. These satisfy the plugin interfaces with in-memory state, enabling engine integration tests without external services.

```typescript
// packages/plugin-sdk/src/test-utils.ts
export function createMockContext(config: Record<string, unknown>): PluginContext {
  return { config, logger: createMockLogger(), bus: createMockBus(), queue: createMockQueue() };
}
```

---

## 5. API Design

### 5.1 Authentication

| Consumer | Method | Details |
|----------|--------|---------|
| Dashboard | HttpOnly + Secure + SameSite=Strict cookie | XSS-proof. CSRF token via double-submit pattern. Session expiry: 8h absolute, 30min idle. Session rotation after auth. |
| External API | `Authorization: Bearer ouija_<key>` | Keys stored as SHA-256 hash. Prefix `ouija_` for GitHub secret scanning. Scoped per-workspace, per-resource. Support two active keys for rotation. |
| Agent callbacks | JWT in `Authorization: Bearer` | Claims: `instanceId`, `boardId`, `workspaceId`, `aud: "ouija-agent-callback"`, `iss`, `jti`, `exp` (15 min). RS256/EdDSA signing. Redis-backed denylist for revocation. |
| Webhook ingress | HMAC signature + path secret | Primary: HMAC body signature (Plane: `X-Plane-Signature`, GitHub: `X-Hub-Signature-256`). Secondary: path secret. |

**Session management:** Two cookies — short-lived access (15 min, HttpOnly, Secure, SameSite=Strict) and longer-lived refresh (7 days, HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth only).

### 5.2 Routes

```
# Auth
POST   /api/v1/auth/setup            # First-run only (disabled after)
POST   /api/v1/auth/session           # Login
POST   /api/v1/auth/refresh           # Rotate tokens
DELETE /api/v1/auth/session           # Logout

# Projects
GET    /api/v1/projects               # List (offset pagination)
POST   /api/v1/projects               # Create (Idempotency-Key header)
GET    /api/v1/projects/:id           # Get
PATCH  /api/v1/projects/:id           # Update (merge semantics, application/merge-patch+json)
DELETE /api/v1/projects/:id           # Delete (idempotent — 204 even if already deleted)
PUT    /api/v1/projects/:id/column-mappings  # Replace-all column actions
GET    /api/v1/projects/:id/pipelines # List pipelines for project (cursor pagination)
GET    /api/v1/projects/:id/cost-summary     # Cost aggregation with date range

# Agent Profiles
GET    /api/v1/agents                 # List (offset pagination)
POST   /api/v1/agents                 # Create (Idempotency-Key header)
GET    /api/v1/agents/:id             # Get (API key NEVER returned — write-only via serializer)
PATCH  /api/v1/agents/:id             # Update
DELETE /api/v1/agents/:id             # Delete
GET    /api/v1/agents/:id/status      # Agent reachability check
POST   /api/v1/agents/:id/rotate-key  # Generate new key, invalidate old

# Pipelines
GET    /api/v1/pipelines              # List (cursor pagination, filterable)
GET    /api/v1/pipelines/:id          # Get (includes timeline, allowed_actions)
POST   /api/v1/pipelines/:id/retry    # Retry (idempotent — rejects if already retrying)
POST   /api/v1/pipelines/:id/cancel   # Cancel (revokes agent JWT, moves to cancelled)
GET    /api/v1/pipelines/:id/logs     # WebSocket upgrade for log streaming
POST   /api/v1/pipelines/bulk-retry   # Bulk retry (207 Multi-Status, max 50)

# Activity
GET    /api/v1/activity               # SSE stream (real-time, Last-Event-ID reconnection)

# Plugins
GET    /api/v1/plugins                # List installed + status + health (no pagination)
POST   /api/v1/plugins/:id/test       # Test connection (always 200, result in body)
PATCH  /api/v1/plugins/:id/config     # Update config

# Credentials (centralized secret management)
GET    /api/v1/credentials            # List (masked values, last-used timestamps)
POST   /api/v1/credentials            # Store new credential
DELETE /api/v1/credentials/:id        # Remove

# Health (outside versioned prefix)
GET    /healthz                       # Liveness probe (unauthenticated, minimal: {"status":"ok"})
GET    /readyz                        # Readiness — AUTHENTICATED. Returns plugin names, queue depths, version. Unauthenticated returns only {"status":"ready"|"not_ready"} to prevent info disclosure.

# Webhook Ingress (outside versioned prefix)
POST   /hooks/plane/:secret           # HMAC + path secret
POST   /hooks/github/:secret          # HMAC + path secret
POST   /hooks/agent/callback          # JWT in Authorization header (NOT in URL path — tokens in URLs leak via logs)
```

### 5.3 Error Response Contract

Every error from every endpoint uses this shape:

```json
{
  "error": {
    "code": "PIPELINE_NOT_FOUND",
    "message": "Pipeline p_abc123 does not exist.",
    "details": [],
    "requestId": "req_7f3a2b",
    "retryable": false
  }
}
```

- `code` is a machine-readable enum (defined in OpenAPI spec)
- `details` array for validation errors with per-field info
- `requestId` always present, generated at Fastify request hook
- `retryable` boolean tells clients whether retry makes sense
- No stack traces in production responses (logged server-side keyed to requestId)

### 5.4 Rate Limiting

| Tier | Scope | Limits |
|------|-------|--------|
| Webhook ingress | Per source IP | 100 req/min, burst 20/sec |
| Auth endpoint | Per IP | 5 req/min (brute-force protection) |
| Authenticated API (reads) | Per session | 300 req/min |
| Authenticated API (writes) | Per session | 100 req/min |
| Pipeline retry | Per user | 10 req/min |
| Plugin test | Per user | 5 req/min |
| SSE connections | Per session | Max 10 concurrent |
| Agent callbacks | Per JWT (jti) | 60 req/min |

Sliding window counters in Redis. Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` (on 429).

### 5.5 Webhook Security

1. **HMAC signature verification (primary auth):** Verify `X-Plane-Signature` (Plane) and `X-Hub-Signature-256` (GitHub) on every webhook. Reject if signature missing or invalid.
2. **Path secret (secondary auth):** Cheap first-pass filter before HMAC computation.
3. **Always return 200:** Even on auth failure AND rate limit exceeded, to prevent path enumeration. Rate-limited webhook requests are silently dropped (returned 200, not processed). Log failures at high severity.
4. **Timestamp validation:** Reject webhooks older than 5 minutes.
5. **Deduplication:** External event ID with 7-day TTL.
6. **Body size limit:** 1MB max via Fastify `bodyLimit`.
7. **Request timeout:** 30 seconds for webhook endpoints.

### 5.6 Pagination

| Resource | Strategy | Rationale |
|----------|----------|-----------|
| Pipelines | Cursor (opaque base64-encoded) | High volume, append-heavy |
| Activity | Event ID (Last-Event-ID for SSE) | SSE spec built-in reconnection |
| Projects | Offset | Low cardinality |
| Agents | Offset | Low cardinality |
| Plugins | None | Fixed set |

No `total_count` for cursor-paginated resources.

### 5.7 Real-time

- **SSE** for dashboard activity feed + pipeline status updates. Keepalive ping every 30s. Dead connection cleanup on EPIPE/ECONNRESET. Max connection duration: 4h with auto-reconnect.
- **WebSocket** for pipeline log streaming (high frequency, bidirectional for filter commands). Auth via cookie on upgrade handshake (verified before connection established).

### 5.8 Secrets Management

- **Write-only enforcement:** Fastify response serializer strips secret fields. Defense-in-depth: DAL guard + integration tests for leakage.
- **Storage:** API keys stored as SHA-256 hash with first 8 chars as non-secret identifier. Customer AI API keys use envelope encryption (KMS master key → per-workspace DEK → secret).
- **In BullMQ jobs:** Never include raw secrets. Pass `secretId` reference, worker decrypts just-in-time.

---

## 6. Dashboard Design

### 6.1 Stack and Defaults

React + Vite + Tailwind + shadcn/ui. **Dark mode as default.** Both color schemes established in design tokens before first component built. Clean technical sans-serif for wordmark — no occult visual elements.

### 6.2 Navigation (ordered by usage frequency)

1. **Overview** — active pipelines, agent status, recent completions, cost summary
2. **Activity** — filterable real-time event stream (SSE)
3. **Projects** — configure board + repo mapping, column-to-action rules
4. **Agents** — manage agent profiles (team directory feel, not credentials manager)
5. **Settings** — split into Integrations (plugins + health) and Notifications

**Pipeline Detail** is NOT in the nav — it's a drill-down from Overview/Activity.

### 6.3 Pages

**Setup Page (/setup):** Only accessible when no owner account exists. Redirects to Overview permanently after completion. Username, password, instance name. Prevents "why is login failing" confusion.

**Overview:** Active pipeline cards (dominant, above fold). Agent status grid (name, avatar, online/idle/error indicator, current task). Cost stat bar (compact, secondary). "Attention required" section for agents in error state or stalled pipelines.

**Activity:** Filterable real-time event stream. Filters: project, agent, event type, date range. Events: card.moved, agent.dispatched, pr.opened, pr.merged, agent.failed, stall.detected. Click any event → drill to Pipeline Detail.

**Projects:** List/create projects. Each project: board + repo mapping. Column mapping via **table-first interface** (dropdown per row, not drag-and-drop as primary). Guard editor in collapsible secondary panel. "Test connection" gate before save.

**Agents:** Team directory layout. Avatar + presence indicator (live/idle/error). Stats visible in list view: cards completed, success rate, avg time, total cost. API key and system prompt in edit drawer (not primary view). Credentials section in Settings for centralized key audit/rotation.

**Pipeline Detail (/pipelines/:id):** Vertical timeline (completed stages solid, current stage pulsing, failed stages red with expandable error). Duration bars between stages. PR link prominent. Cost in sidebar. Log viewer in separate visual zone below timeline (monospace font, auto-scroll with "jump to live" button).

**Settings > Integrations:** Plugin list with three-state health (healthy/degraded/offline). Config forms generated from plugin JSON Schema. "Test connection" button per plugin. Webhook URL with copy button.

**Settings > Notifications:** Channel setup (Telegram bot token, Slack webhook). Per-event-type routing.

### 6.4 Empty States and Onboarding

**First login → Onboarding checklist** (persistent card on Overview, disappears when complete):
```
Get started with Ouija
  [ ] Configure a board plugin (Settings > Integrations)
  [ ] Configure a git plugin (Settings > Integrations)
  [ ] Create an agent profile (Agents)
  [ ] Create your first project (Projects)
  [ ] Move a card to test the pipeline
```

Each empty page has instructional text + primary action button + link to docs. Tone: direct, instructional, not playful.

### 6.5 Error States

Every page handles three states: healthy, degraded, offline.
- **Overview:** "Attention required" section surfaces agent errors and stalled pipelines prominently.
- **Pipeline Detail:** Error node in timeline is expandable (raw error, agent's last output, retry action).
- **Projects:** Disconnected webhook state with "check connection" action.
- **Agents:** Invalid API key / provider errors reflected immediately in status.
- **Settings:** Plugin health with timestamp, human-readable description, specific remediation action.

### 6.6 Accessibility

WCAG 2.1 AA target. Non-color state indicators (icons, not just colors). Keyboard-navigable column mapping (table-first). Screen reader announcements for SSE activity (announce "new content available", not every event). Clear form validation errors associated with specific fields.

### 6.7 Security Headers

Via `@fastify/helmet`:
- `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`

---

## 7. Deployment

### 7.1 Docker Compose (Full Stack)

```yaml
services:
  ouija:           # Core + Dashboard (:4000) — 512MB limit
  ouija-migrate:   # Run migrations, exit. ouija depends on it (service_completed_successfully).
  plane-aio:       # Plane all-in-one (:3000, proxied via /board/) — 2GB limit, PINNED version
  postgres:        # Shared instance, separate databases (ouija_db + plane_db), separate roles with cross-db denial — 1GB limit
  ouija-redis:     # Ouija's Redis (BullMQ) — 256MB limit, maxmemory-policy: noeviction (BullMQ requirement — never evict jobs)
  plane-redis:     # Plane's Redis (cache) — 256MB limit, maxmemory-policy: allkeys-lru
  rabbitmq:        # Plane's Celery broker — 512MB limit
  minio:           # Plane file storage — 256MB limit
```

**Total: ~4.8GB RAM on 32GB MacBook Pro.** Plenty of headroom. Separate Redis instances prevent Plane cache pressure from evicting BullMQ delayed jobs (dead man's switch). Both Redis instances require AUTH with separate passwords. Postgres uses separate roles with explicit cross-database query denial.

All services run as non-root (`user: "1000:1000"`), read-only filesystem (`read_only: true` + tmpfs), no new privileges (`no-new-privileges: true`), all capabilities dropped. Named volumes for all persistent data (bypass Docker Desktop VM filesystem boundary for better I/O).

### 7.2 Docker Compose (Ouija-Only)

For BYO kanban users (the **default** compose file — making Ouija-only the default reinforces "Plane is a plugin, not a dependency"):
```yaml
services:
  ouija:     # Core + Dashboard (:4000)
  postgres:  # Ouija DB only
  redis:     # BullMQ only (noeviction policy)
```
~1.5GB total RAM. This is the compose file `ouija init` scaffolds by default. The Plane-inclusive variant is an optional "batteries included" add-on.

### 7.3 Tailscale Funnel (Personal/Dev)

Single Funnel endpoint → Ouija on :4000. Ouija proxies `/board/*` to `plane-aio:80` via `@fastify/http-proxy`. All routing logic in one place.

```bash
tailscale serve https:443 / http://127.0.0.1:4000
tailscale funnel 443 on
```

**Tailscale Funnel is for personal use and development only.** Documentation must label it as such. Cloud SaaS uses proper reverse proxy (Caddy/nginx) with WAF and DDoS protection (Cloudflare).

### 7.4 Plane Localhost Webhook Problem

Plane blocks `localhost` and `127.0.0.1` webhook URLs. Solution: configure webhook URL as `http://ouija:4000/hooks/plane/<secret>` (Docker DNS resolves container name). Zero patches needed.

### 7.5 MacBook Sleep

- `caffeinate -s` via launchd plist for AC-power sleep prevention
- Pipeline state in DB (not in-memory) means resume after sleep is deterministic
- In-flight pipelines detected as stale by dead man's switch, can be retried

### 7.6 Backup Strategy

- Postgres: `pg_dump` with integrity verification, 7-day retention
- SQLite: `better-sqlite3` `.backup()` API for consistent backups
- Backups encrypted at rest with separate key from DB encryption

### 7.7 When to Migrate from Docker Compose

Move to k3s/Nomad when:
1. Zero-downtime deploys required (compose has restart gap)
2. Horizontal scaling needed (compose is single-host)
3. Multi-region for SaaS
4. Paying cloud customers exist

Not before.

---

## 8. Configuration

### 8.1 Config File

`ouija.config.yaml` — structure and non-secret config. Safe to commit.

```yaml
instance:
  name: "My Ouija"
  port: 4000

plugins:
  - module: "@ouija-dev/plugin-plane"
    config:
      baseUrl: "https://plane.example.com"
      apiToken: "${PLANE_API_TOKEN}"      # env var interpolation
      workspaceSlug: "my-workspace"
      ingestionMode: webhook

  - module: "@ouija-dev/plugin-github"
    config:
      personalAccessToken: "${GITHUB_PAT}"
      defaultOrg: "myorg"

  - module: "@ouija-dev/plugin-agent-claude"
    config:
      apiKey: "${ANTHROPIC_API_KEY}"
      model: "claude-opus-4-6"

  - module: "@ouija-dev/plugin-notify-telegram"
    config:
      botToken: "${TELEGRAM_BOT_TOKEN}"
      chatId: "${TELEGRAM_CHAT_ID}"
```

`${ENV_VAR}` interpolation in config loader. Secrets stay in `.env`, config is commitable. Undefined env vars fail loudly at startup: `Config error: PLANE_API_TOKEN is referenced in ouija.config.yaml but not set.`

**Source of truth:** The YAML file is the ground truth for plugin configuration. The dashboard Settings page is **read-only for plugin config** — it displays current config and health but does not write back to the YAML file. To change plugin config, edit the file and restart. This prevents config drift between file and database, eliminates merge conflicts, and keeps config git-trackable. Runtime-mutable settings (notification preferences, column mappings) are stored in the database and editable via dashboard.

### 8.2 Environment Variables

`.env` (in .gitignore):
```
OUIJA_SECRET_KEY=<generated by setup.sh>
OUIJA_DATABASE_URL=postgres://...  # or sqlite:///data/ouija.db
OUIJA_REDIS_URL=redis://...
PLANE_API_TOKEN=...
GITHUB_PAT=...
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

---

## 9. CLI

```
ouija init              # Scaffold config + .env + docker-compose. Interactive: variant selection.
ouija start             # Start engine directly (plugin dev / contributor mode, not production)
ouija check             # Verify: plugins, DB, env vars, connectivity. Exit codes: 0=pass, 1=fail, 2=usage
ouija status            # Show engine health, active pipelines, agent status, queue depths (terminal dashboard)
ouija status --watch    # Live-updating terminal view (tmux-friendly)
ouija logs <id>         # Tail pipeline logs from CLI (WebSocket to /api/v1/pipelines/:id/logs)
ouija logs <id> --follow
ouija config validate   # Offline config check — parse YAML, resolve env vars, validate schemas. No network.
ouija plugins list      # Show installed plugins + version + type + health + compatibility
ouija plugins add       # Install + scaffold YAML snippet + show required env vars
ouija plugins create    # Scaffold a new plugin package (name, type, directory)
ouija pipelines list    # List recent pipelines (filterable: --status, --project, --limit)
ouija pipelines retry   # Retry a failed pipeline (or --all-failed)
ouija migrate           # Run database migrations (also runs automatically via ouija-migrate container)
ouija migrate status    # Show current migration version without running anything
ouija demo              # Self-contained demo with fake integrations — no external accounts needed
```

All data-producing commands support `--json` for scripting/CI. All commands support `--help` with flags, examples, and description.

### `ouija init` Output

```
$ npx ouija init
  Creating ouija.config.yaml...
  Creating .env...
  Generating OUIJA_SECRET_KEY...

  Next steps:
    1. docker compose up -d
    2. Visit http://localhost:4000 to complete setup
    3. Run: ouija plugins list  (to verify plugins loaded)

  NOTE: If your Plane instance is cloud-hosted, webhooks cannot
  reach localhost. Use a tunnel: npx ngrok http 4000
```

### `ouija check` Output

```
$ ouija check
  [PASS] Database: migrations up to date
  [PASS] Plugin @ouija-dev/plugin-plane 0.1.0: compatible with core 1.0
  [WARN] Plugin @ouija-dev/plugin-github 0.3.0: requires core >=1.3
  [PASS] OUIJA_SECRET_KEY: set
  [PASS] Plane API: reachable
  [FAIL] GitHub PAT: expired
```

---

## 10. Observability

### 10.1 Day-One Metrics

| Metric | Type | Why |
|--------|------|-----|
| Event loop lag | Gauge (5s interval) | Sync SQLite writes block the loop. Alert at >50ms. |
| DB write duration | Histogram (p50/p95/p99) | Target: p99 <20ms under Docker Desktop. |
| BullMQ queue depths | Gauge | Waiting depth near zero. Growing = consumer falling behind. |
| Redis memory usage | Gauge (60s poll) | Alert at 70% of container limit. |
| SSE connection count | Gauge | Monotonically increasing = cleanup broken. |
| Per-trigger processing latency | Histogram (by trigger type) | `agent_heartbeat` should be 10x faster than `card_moved`. |
| `getCardContext` API latency | Histogram (p50/p95) | Hidden dependency. Slow Plane = slow everything. |
| Stall detection accuracy | Gauge | Delta between `last_heartbeat_at` and `stall_detected` time. |

### 10.2 Health Endpoints

```json
GET /healthz → { "status": "ok" }

GET /readyz → {
  "status": "ready",
  "version": "1.0.0",
  "uptime": 3600,
  "plugins": {
    "@ouija-dev/plugin-plane": "healthy",
    "@ouija-dev/plugin-github": "degraded"
  },
  "queues": {
    "agentDispatch": { "waiting": 0, "active": 2, "failed": 1 }
  }
}
```

### 10.3 Structured Logging

JSON output in production (`NODE_ENV=production`), pretty-printed in development. Consistent fields: `timestamp`, `level`, `message`, `plugin`, `instanceId`, `cardId`, `requestId`.

### 10.4 Audit Logging

Append-only audit log for: auth events, secret access, state transitions, webhook processing, admin actions, config changes. Includes: timestamp, actor, action, resource, outcome, source IP. Minimum 1-year retention for SOC 2.

---

## 11. Performance Characteristics

### 11.1 Throughput Estimates

| Path | Native Linux | Docker Desktop macOS |
|------|-------------|---------------------|
| Webhook → state persisted (excl. external API) | 2-8ms | 8-25ms |
| Pipeline transitions/sec | 400-1,000 | 50-200 |
| Concurrent active pipelines (comfortable) | 500-1,000 | 50-100 |

### 11.2 Performance Optimizations (Built In)

1. Cache `getBoardConfig` in memory (30s TTL)
2. Parallelize side effects (`Promise.all`, not serial)
3. No `updated_at` triggers (application layer maintains timestamps)
4. Named Docker volumes (bypass virtiofs overhead)
5. Ouija Redis: `maxmemory 256mb` + `noeviction` policy (BullMQ requirement — never evict jobs, fail writes instead)
6. Heartbeat events: `removeOnComplete: { count: 0 }` (no accumulation)
7. SSE keepalive pings every 30s + dead connection cleanup

### 11.3 Scaling Triggers

| When | Do |
|------|----|
| Event loop lag >50ms consistently | Move `persistTransitionResult` to worker thread |
| >200 concurrent pipelines on macOS | Increase heartbeat interval to 10-30s |
| >20 event bus subscriptions | Swap EventBus impl to Redis Streams |
| Need multi-process | Add Redis pub/sub for SSE fan-out, cluster Fastify |
| Need multi-node | Already on Postgres; add load balancer + row-level locking |

---

## 12. Security Roadmap

### Phase 1 — Before Any Deployment
- Rate limiting on all endpoints
- HMAC signature verification for all webhooks
- JWT hardening (claims, RS256, denylist, 15-min expiry)
- Cookie hardening (Secure flag, CSRF, session rotation)
- Docker hardening (non-root, resource limits, read-only)
- Security headers via @fastify/helmet
- Body size limits + input validation on all routes

### Phase 2 — Before Cloud SaaS Launch
- PostgreSQL with Row-Level Security
- Plugin sandboxing (child processes / V8 isolates)
- Redis security (AUTH, TLS, ACLs)
- KMS-based envelope encryption for customer secrets
- Proper reverse proxy + WAF (replace Tailscale Funnel)
- Audit logging infrastructure
- API key hashing, scoping, rotation

### Phase 3 — Security Maturity
- Event bus message signing
- Transition-level authorization (which actors can trigger which transitions)
- SSE auth lifecycle (periodic session validation, max connection duration)
- SAST in CI (Semgrep), DAST against staging (ZAP)
- Penetration testing before cloud launch
- security.txt + vulnerability disclosure policy

---

## 13. Product Packaging

### 13.1 Self-Hosted (Free, Open Source)

`npx ouija init` → edit config → `docker compose up`.

**License:** Apache 2.0 for Ouija core.

**AGPL-3.0 Conflict with Plane:** Plane is licensed AGPL-3.0. Enterprise legal teams auto-reject AGPL. Mitigations:
- Ouija's code does NOT link against or incorporate Plane code. Plane is accessed via webhooks and REST API (network boundary).
- The docker-compose file references Plane's image but does not distribute it. Users pull it from Plane's registry.
- For cloud SaaS: if Plane is modified in any way, modifications must be published per AGPL Section 13.
- **Long-term:** Accelerate the "built-in minimal kanban" deferred item (Section 14) to offer a Plane-free experience. The cleanest enterprise story: "Ouija is Apache 2.0. You bring your own kanban board."
- Automated license scanning in CI (FOSSA or license-checker) to catch new AGPL transitive deps.

### 13.2 Cloud SaaS Pricing

| Tier | Price | Includes |
|------|-------|----------|
| Starter | Free | 1 project, 1 agent, 50 pipeline runs/month, 7-day history |
| Builder | $29/month | 5 projects, 3 agents, 1,000 runs/month, 30-day history |
| Team | $99/month | Unlimited projects, 10 agents, 10,000 runs/month, 90-day history, 5 seats |
| Enterprise | Custom | Unlimited everything, SSO, audit logs, SLA, dedicated support |

Charge per pipeline run, not per seat. Token costs from AI providers are pass-through at cost. Do not gate features by tier — gate by usage limits.

### 13.3 BYO Kanban

Same pricing as cloud. Plugin is the entry point; pipeline runs are the ongoing value.

---

## 14. Out of Scope (Deferred)

- Jira mirror plugin (Plane → Jira sync) — later enhancement
- Jira as kanban source plugin — later enhancement
- Built-in minimal kanban (eliminate Plane dependency) — **accelerated priority** due to AGPL concerns. Evaluate immediately after v1.
- SQLite database option for self-hosted — v1.1, only if real user demand exists
- Multi-language plugin support (WASM/sidecar) — v2
- Visual pipeline builder UI — v2
- Pipeline "replay from stage" — v2
- Agent dry-run / simulate mode — v1.1
- Billing page for cloud tier — v1.1
- Run history page (vs Activity as historical log) — evaluate after v1
- Batch dispatch (select N cards, dispatch all) — v1.1
- Task complexity estimation before dispatch — v1.1
- Agent performance leaderboard / analytics — v1.1 (moat-building feature)
- PR quality scoring (second agent reviews before human) — v1.2
- Cost budgets and alerts per project — v1.1
- RBAC (owner/admin/member/viewer roles) — required before cloud SaaS launch
- Cloud SaaS pricing tiers, RLS, KMS — deferred to cloud launch phase
- SOC 2 / GDPR compliance documentation — deferred to cloud launch phase
- Third-party plugin marketplace — v2 (requires plugin sandboxing first)

---

## 15. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Prompt injection via card descriptions** | High | Critical | Input sanitization pipeline (§4.10), output validation on PR diffs, agent does not merge |
| **AGPL license blocks enterprise deals** | High | High | Plane is a plugin, not bundled. Accelerate built-in kanban. Apache 2.0 for Ouija. |
| Plane webhook payload changes break plugin | High | High | Pin version, CI contract tests against payload fixtures |
| Agent runs but produces bad/malicious code | High | Medium | Human approval via PR review. Agent does not merge. Output validation scans PR diffs. |
| **Malicious third-party plugin** | Medium (cloud) | Critical | V1: first-party plugins only. V2: child process sandboxing. No third-party plugins without review. |
| **AI providers eaten this workflow** | Medium | High | Build the intelligent dispatcher (cost budgets, complexity estimation, agent selection, quality gates) — not just a dumb webhook relay |
| Tailscale Funnel unreliable for production | Medium | Medium | Document as dev-only. Cloud uses proper infra. |
| MacBook sleep loses in-flight work | Medium | Low | State in DB. Dead man's switch. Caffeinate plist. |
| **Notification storm on mass stall** | Medium | Medium | Rate-limit notifications: max N per window per channel. Batch stall alerts. |
| **Moat is thin — cloneable in 2-3 weekends** | High | High | Moat comes from accumulated intelligence (agent performance data, cost benchmarks) and protocol adoption, not from the state machine itself. Build agent analytics from day one. |
