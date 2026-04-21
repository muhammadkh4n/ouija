# Changelog

All notable changes to Ouija are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org).

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
