# Changelog

All notable changes to Ouija are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org).

## [0.4.1] — Trigger Primitive + Recovery — 2026-05-03

The v0.4.1 release closes Phase 2 of the bridge plan: every orchestrator entry point now routes through one persist-+-side-effect primitive, stuck pipelines have an explicit recovery vocabulary, and the dashboard surfaces the dwell + cost telemetry that operators need to drive the loop without SQL access.

### Added

- **`POST /api/v1/pipelines/dispatch` (first-class).** Admin dispatch route. Bypasses kanban — creates a fresh `idle` pipeline instance with a synthetic `manual/<uuid>` cardId and immediately drives it into `dispatching` via the new `manual_dispatch` trigger. Auth-gated via `requireAuth`, throttled with `apiAdminRateLimit` (30/min/session). Body: `{ agentId, title, description, boardId?, requestedBy? }`. Outcome → status mapping: 202 dispatched, 400 `BOARD_ID_REQUIRED` (with candidate hints when >1 board configured), 409 `NO_BOARD_CONFIGURED` / `DISPATCH_REJECTED`, 500 `PIPELINE_CONFIG_MISSING`. The `taskTitle` field on `AgentDispatchJobData` is now populated from the side-effect payload, and `assembleWorkOrder` short-circuits the kanban `getCardDetails` lookup for synthetic `manual/...` cardIds. Closes friction-log #17 (no path to first agent run when kanban is broken or absent). (#74)
- **`POST /api/v1/pipelines/:id/reset` (admin recovery).** Returns any "stuck-recoverable" pipeline (`provisioning` / `dispatching` / `running` / `awaiting_review` / `stalled`) to `idle`. Cancels in-flight agent + stall check + workspace as applicable; emits a dedicated `pipeline.admin_reset` audit event alongside the routine `pipeline.transitioned`. Auth-gated + rate-limited identically to `/dispatch`. Closes friction-log #16. (#70)
- **Dwell-budget reconciler (`DwellReconciler`).** New 60s loop, complementary to the heartbeat-based `StallMonitor`. Per-state budgets table in `packages/engine/src/dwell-budgets.ts`: `dispatching: 60s`, `provisioning: 120s`, `awaiting_review: 14d`, `running: defaultStallThresholdMs * 4` capped at `RUNNING_HARD_CAP_MS = 6h`. Overstayed instances get a synthesized `timed_out` trigger: live states → `failed (retryable=true, attempt+1)`, `awaiting_review` → `stalled`. Drift-safe: rejects when live state has moved out of `trigger.fromStatus` between query and transaction. (#72)
- **Migration 008 — `state_entered_at TIMESTAMPTZ` on `pipeline_instances`.** NOT NULL after backfill from latest `pipeline.transitioned` event (falling back to `created_at`). Composite index on `(status, state_entered_at)` keeps the reconciler scan sub-100ms. `Orchestrator.applyTrigger` stamps it on every status change. (#72)
- **Dashboard dwell-time badges + Reset button.** New `dwell` column between status dot and id, monospace + tabular-nums, painted red + bold when over budget. Tooltip surfaces full duration + budget + over-budget hint. The `reset` allowedAction renders as a real `<button>` with proper `preventDefault`/`stopPropagation` (row is wrapped in `<Link>`); `useMutation` invalidates `['pipelines', boardId]` on success; failures surface in an inline `role="alert"` banner. Server now ships `stateEnteredAt` + `dwellBudgetMs` per pipeline so the dashboard never duplicates the budget table (Tenet 4). (#73)
- **Dashboard Run Agent button.** Header-mounted button expanding to an inline form (agent picker, title input ≤300, description textarea ≤10k). Targets `POST /api/v1/pipelines/dispatch`. Closes Plan-README definition-of-bridged item: dispatch is reachable from the dashboard without kanban. (#74)
- **Dashboard timeline cost + tokens chips.** Per-iteration chips on every `dispatch.outcome` event: cost (sub-cent → `<$0.01`), tokens (combined in+out, tooltip with split), commits, tools, PR link, red `outcome rejected` chip when the positive-evidence gate refused the run. `pipeline.transitioned` events annotate inline with `from → to via trigger` to disambiguate review-loop iterations. (#75)
- **Audit events.** `pipeline.admin_reset { instanceId, fromStatus, requestedBy, resetAt }`, `pipeline.timed_out { instanceId, fromStatus, budgetMs, observedDwellMs, detectedAt }`, `pipeline.manually_dispatched { instanceId, cardId, agentId, taskTitle, requestedBy, dispatchedAt }`. All instanceId-stamping centralized in `Orchestrator.applyTrigger.stampInstanceId`. (#70, #72, #74)
- **Trigger types.** `admin_reset`, `timed_out`, `manual_dispatch`. (#70, #72, #74)
- **Error codes.** `PIPELINE_NOT_RESETTABLE`, `PIPELINE_CONFIG_MISSING`, `NO_BOARD_CONFIGURED`, `BOARD_ID_REQUIRED`, `DISPATCH_REJECTED`. (#70, #74)

### Changed

- **`Orchestrator.applyTrigger` is now the single persist-+-side-effect primitive across 6 callers** (was 3 before Task 1, then grew to 6: `processTrigger` / `processStallDetected` / `processReviewBundle` / `requestAdminReset` / `requestTimedOut` / `requestManualDispatch`). One implementation of the event append, state save, and side-effect fan-out. Tenet 7 fully realised. (#64, #70, #72, #74)
- **`PipelineInstance.stateEnteredAt: string` (NOT NULL).** New required field; populated by migration 008 on existing rows. (#72)
- **`PipelineSummary` wire shape adds `stateEnteredAt` + `dwellBudgetMs`; `PipelineAction` widened to `'retry' | 'cancel' | 'reset'`.** (#73)
- **`TimelineEvent` wire shape adds `payload?: unknown`.** Defensive structural narrowing per topic. (#75)

### Fixed

- **Vite 8 strict ESM resolution failed on cold checkouts.** Workspace packages whose `exports`/`main` point at `dist/` couldn't be resolved by vitest before `turbo run build`. Fix: vitest-only `resolve.alias` (`@ouija-dev/<pkg>[/sub]` → source TypeScript) so vitest doesn't depend on prior builds; production runtime keeps using each package's `exports` → compiled `dist/`. Replaces an earlier attempt that pointed `default` at `./src/index.ts` and broke production Docker resolution (`fresh-install-smoke` faithfully reported the production crash). (#71)

### Acceptance criteria — all met

- All four orchestrator entry points share `applyTrigger`. ✅ (today's count is 6.)
- Integration test: pipeline wedged in `dispatching` past its budget → reconciler fires `timed_out` → pipeline moves to `failed` or retries. ✅
- Integration test: `POST /api/v1/pipelines/:id/reset` on a stalled pipeline → state returns to `idle` + audit event written. ✅
- Dashboard shows the dwell-time badge on every in-flight pipeline; Reset button is visible and functional. ✅
- Friction-log #16 (stuck-state recovery) ✅. Friction-log #17 (no path to first dispatch) ✅ (bonus).

### Tests

1015 passed / 43 skipped (was 920 passed at v0.4.0 cut). +95 net additions across the phase.

### Migration notes for v0.4.0 → v0.4.1

- **Database:** apply migration 008 before starting v0.4.1. Backfill is idempotent and tolerates instances with no `pipeline.transitioned` events (uses `created_at`).
- **No breaking type changes.** `PipelineInstance.stateEnteredAt` is required after the migration; readers compiled against v0.4.0 keep working because the migration runs before the new code reads the field.
- **Dashboard caches:** the React-Query keys are unchanged — no client-side cache reset needed.

## [0.4.0] — Kill Silent Failures — 2026-04-22

The v0.4.0 release closes eight distinct silent-failure classes the 2026-04-19 smoke uncovered, plus one more found while attempting the phase's live smoke. Headline: a dispatch that reports `succeeded` with no observable evidence is no longer possible.

### Breaking

- **`GitPrOpenedPayload` drops `instanceId`.** The field was fabricated as `github-pr-<N>` and never matched a real pipeline. Consumers must resolve the instance via the webhook URL + `pr_instance_index`. (#56)
- **`GitPrMergedPayload` drops `instanceId`, adds `url` (required).** Same fabrication, same fix. Self-hosters with queued merge events from a prior release must re-trigger via GitHub's "redeliver webhook" button for the orchestrator to match them. (#56)
- **`runner: local` is deprecated.** Emits a Node `DeprecationWarning` at config load (code `OUIJA_LOCAL_RUNNER_DEPRECATED`). Set `OUIJA_ALLOW_LOCAL_RUNNER=1` (strict `=1`, no truthy variants) to suppress during migration. Removal scheduled for v0.5.0. Replacement: `runner: stream-json` — same subscription auth, plus the structured events Tenet 3 needs. (#60)

### Fixed

- **Pipeline status enum drift.** Migration 006 rewires `pipeline_instances.status` check constraint to accept every `PipelineStatus` value (`provisioning` and `awaiting_review` were previously rejected, crashing every review-loop dispatch). The enum is now a typed TypeScript array with a compile-time exhaustiveness assertion; the migration SQL is generated from it (`npm run gen:migrations`) and CI fails on drift. (#54)
- **BullMQ idempotency-key corruption.** `encodeJobId(parts: readonly string[])` — new base64url encoder over null-byte-joined parts — replaces raw string concatenation at **28 call sites** across `transition.ts`. PR URLs, HMAC headers, and any value containing `:`, `#`, `/`, `?`, `&` no longer break queue enqueue. (#55)
- **PR merge silently orphaning the pipeline.** `git.pr.merged` now resolves the originating pipeline via `prInstances.findInstanceByPrUrl` inside the orchestrator. Four distinct log messages discriminate the four failure modes (no index, no URL, no mapping, mapping points to missing pipeline) instead of the single "pipeline instance not found" warning that buried every one of them. E2E "human merge" test rewritten to go through the real webhook POST route. (#56)
- **Zero-progress agent runs reporting success.** `DispatchOutcome` now carries positive-evidence fields (`prUrl?`, `commitsPushed`, `toolCallsMade`, `tokensIn`, `tokensOut`, `sessionLogPath?`) and `hasPositiveEvidence()` gates acceptance. Two-layer defence: `plugin-agent-claude._runAgent` short-circuits zero-progress outcomes to `reportFailed(retryable=false)` BEFORE the server callback; the transition layer re-checks in `handleAgentCompleted` and transitions to `agent_failed { reason: 'no observable progress' }`. (#57)
- **Silent HMAC failure on root-mounted webhook routes.** Raw-body JSON parser hoisted from the `webhookRoutes` encapsulated plugin to `buildApp`. Previously, plugins registered on the root app (notably `fizzyPlugin.registerRoutes(app)`) saw Fastify's default parser; `request.rawBody` was undefined, the fallback `JSON.stringify(request.body)` produced different bytes than the upstream signed, and every Fizzy delivery silently failed HMAC with warn-log-and-200. Regression test guards the fix. (#62)
- **Session logs were unreachable.** `sessionLogPath` now flows from the stream-json runner (captured from the first `system.init` event) through `DispatchOutcome` onto the `PipelineInstance` (migration 007), returned on `GET /api/v1/pipelines/:id`, and rendered in the dashboard as a `view session log` button with clipboard-copy + `window.prompt` fallback for insecure contexts. Closes friction-log #22. (#58)

### Added

- `packages/engine/src/ids.ts` — `encodeJobId` / `decodeJobId` / `isBullMQSafe` / `BULLMQ_FORBIDDEN_CHARS`. (#55)
- `DispatchOutcome` type + `hasPositiveEvidence` predicate in `@ouija-dev/types`. (#57)
- `dispatch.outcome` EventBus topic — Phase 4 `plugin-engram` subscription point for ingesting outcomes as memory episodes without touching engine internals. (#57)
- `DispatchOutcome.sessionLogPath` + `PipelineInstance.sessionLogPath` — absolute path to the agent's NDJSON session log. (#58)
- Dashboard `view session log` button (clipboard copy + prompt fallback). (#58)
- Dashboard "zero-token success" anomaly badge + banner — defence-in-depth for Tenet 3 that surfaces pre-v0.4.0 historical rows where evidence is missing. (#59)
- `taskTitle` field on `AgentDispatchJobData` — overrides `card.title` in the agent prompt when set, future-proofing the manual-dispatch path for Phase 3 `ouija watch`. Empty/whitespace falls back to `card.title` defensively. Closes friction-log #23. (#61)
- `packages/config/src/deprecations.ts` — `collectDeprecationWarnings` (pure) + `emitDeprecationWarnings` over `process.emitWarning`. (#60)
- Migration 006 (status enum, generated) and migration 007 (`session_log_path`). (#54, #58)
- `npm run gen:migrations` + CI drift-check step. (#54)
- Compile-time `_PipelineStatusExhaustive` assertion for readable error messages on future TS↔SQL drift. (#54)

### Internal

- E2E review-loop merge test rewritten to POST through the real webhook route (was synthesising events with hand-set `instanceId`, which would have silently passed the bug). (#56)
- Orchestrator stamps `instance.id` onto `dispatch.outcome` payloads at persistence time (pure transition has no instance context; mirrors `pipeline.transitioned` synthesis). (#57)
- Repository uses `COALESCE(EXCLUDED.session_log_path, pipeline_instances.session_log_path)` on conflict + orchestrator guards with `instance.sessionLogPath === undefined` before stamping — first runner wins, never overwritten. (#58)

### Known deferred work

- The literal "`gh pr merge` end-to-end live smoke" acceptance bullet is deferred to Phase 3. The underlying code path (webhook → normaliser → orchestrator → `pr_instance_index` → `succeeded` transition) is covered by `e2e-review-loop.test.ts` end-to-end through the real HTTP route. Live smoke against a real repo requires kanban-trigger polish tracked on the Phase 3 backlog.

---

## [0.3.3] — 2026-04-20

Previous release. See commit history for details.
