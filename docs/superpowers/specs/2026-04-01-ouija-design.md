# Ouija — Design Specification

**Product:** Ouija — A modular pipeline engine where kanban board columns are the control plane and AI agents are board members.
**Author:** Muhammad Khan + Claude
**Date:** 2026-04-01
**Status:** Approved after review by 6 specialist agents (Security, Architecture, Performance, DX, API, UI/UX, Deployment)

---

## 1. Product Vision

Ouija is a pipeline engine that turns kanban cards into shipped code. AI agents are literal users on the kanban board. When a card moves to "In Progress," an agent picks it up, reads the description, clones the repo, writes code, opens a PR, and moves the card forward. The human stays in control through board interactions — dragging cards, assigning agents, approving PRs.

**Core value proposition:** "Create a task on your board. It becomes a PR, automatically."

**Product offerings:**
- **Self-hosted (open source):** Docker Compose + CLI. Free forever.
- **Cloud SaaS (ouija.dev):** Hosted Ouija with managed infrastructure. Per-pipeline-run pricing.
- **BYO Kanban:** Ouija-only (customer uses their own Jira/Linear/Trello via plugins).

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
| Database (self-hosted) | SQLite (better-sqlite3, WAL, STRICT) | Zero-ops for single-tenant self-hosters |
| Database (cloud SaaS) | PostgreSQL 15 with Row-Level Security | Multi-tenant isolation, encryption at rest, horizontal scaling |
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

**Decision 3: Postgres for cloud, SQLite option for self-hosted**
Build on Postgres first. Abstract storage behind a repository interface. Ship SQLite as an option for `docker-compose.ouija.yml` (single-tenant self-hosters who want zero-ops). Cloud SaaS is Postgres-only with Row-Level Security for tenant isolation.

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
  name: string;                    // e.g. "@ouija/plugin-plane"
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
- `custom_expression` — extensible for future guards

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

# Health (outside versioned prefix, unauthenticated)
GET    /healthz                       # Liveness probe
GET    /readyz                        # Readiness (DB, Redis, plugins)

# Webhook Ingress (outside versioned prefix)
POST   /hooks/plane/:secret           # HMAC + path secret
POST   /hooks/github/:secret          # HMAC + path secret
POST   /hooks/agent/:instanceToken    # JWT auth
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
3. **Always return 200:** Even on auth failure, to prevent path enumeration. Log failures at high severity.
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
  ouija-migrate:   # Run migrations, exit. ouija depends on it.
  plane-aio:       # Plane all-in-one (:3000, proxied via /board/) — 2GB limit
  postgres:        # Shared, separate databases (ouija_db + plane_db) — 1GB limit
  redis:           # Shared (BullMQ + Plane cache) — 512MB limit, maxmemory configured
  rabbitmq:        # Plane's Celery broker — 512MB limit
  minio:           # Plane file storage — 256MB limit
```

**Total: ~4.5GB RAM on 32GB MacBook Pro.** Plenty of headroom.

All services run as non-root (`user: "1000:1000"`), read-only filesystem (`read_only: true` + tmpfs), no new privileges (`no-new-privileges: true`), all capabilities dropped. Named volumes for all persistent data (bypass Docker Desktop VM filesystem boundary for better I/O).

### 7.2 Docker Compose (Ouija-Only)

For BYO kanban users:
```yaml
services:
  ouija:     # Core + Dashboard (:4000)
  redis:     # BullMQ only
```
SQLite for persistence (no Postgres needed). ~1GB total RAM.

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
  - module: "@ouija/plugin-plane"
    config:
      baseUrl: "https://plane.example.com"
      apiToken: "${PLANE_API_TOKEN}"      # env var interpolation
      workspaceSlug: "my-workspace"
      ingestionMode: webhook

  - module: "@ouija/plugin-github"
    config:
      personalAccessToken: "${GITHUB_PAT}"
      defaultOrg: "myorg"

  - module: "@ouija/plugin-agent-claude"
    config:
      apiKey: "${ANTHROPIC_API_KEY}"
      model: "claude-opus-4-6"

  - module: "@ouija/plugin-notify-telegram"
    config:
      botToken: "${TELEGRAM_BOT_TOKEN}"
      chatId: "${TELEGRAM_CHAT_ID}"
```

`${ENV_VAR}` interpolation in config loader (~10 lines of code). Secrets stay in `.env`, config is commitable.

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
ouija init          # Scaffold ouija.config.yaml + .env + docker-compose.yml
ouija start         # Start the engine (non-Docker mode)
ouija check         # Verify: plugins, DB migrations, env vars, connectivity
ouija plugins list  # Show installed plugins + compatibility
ouija plugins add   # Install + scaffold YAML snippet + show required env vars
ouija migrate       # Run database migrations
ouija demo          # Spin up local instance with fake integrations for demo
```

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
  [PASS] Plugin @ouija/plugin-plane 0.1.0: compatible with core 1.0
  [WARN] Plugin @ouija/plugin-github 0.3.0: requires core >=1.3
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
    "@ouija/plugin-plane": "healthy",
    "@ouija/plugin-github": "degraded"
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
5. Redis `maxmemory 512mb` + `allkeys-lru` eviction
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

`npx ouija init` → edit config → `docker compose up`. MIT or Apache 2.0 license.

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
- Built-in minimal kanban (eliminate Plane dependency) — evaluate after v1
- Multi-language plugin support (WASM/sidecar) — v2
- Visual pipeline builder UI — v2
- Pipeline "replay from stage" — v2
- Agent dry-run / simulate mode — v1.1
- Billing page for cloud tier — v1.1
- Run history page (vs Activity as historical log) — evaluate after v1

---

## 15. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Plane webhook payload changes break plugin | High | High | Pin version, CI tests against payload fixtures |
| Agent runs but produces bad code | High | Medium | Human approval via PR review. Agent does not merge. |
| Tailscale Funnel unreliable for production | Medium | Medium | Document as dev-only. Cloud uses proper infra. |
| SQLite write contention at scale | Low (self-hosted) | Medium | Postgres is primary. SQLite is opt-in for simple setups. |
| Malicious third-party plugin | Medium (cloud) | Critical | Plugin sandboxing in Phase 2. Curated marketplace. |
| MacBook sleep loses in-flight work | Medium | Low | State in DB. Dead man's switch. Caffeinate plist. |
