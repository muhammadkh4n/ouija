<!--
Ouija PR template — driven by Ouija/Operating Manual.md § Git conventions.

Every PR in the spine (v0.4.0 → v0.7.0) fills in Phase, Tenets, and a
Build Log link. Housekeeping PRs can leave Phase blank but MUST explain
why they are housekeeping rather than phase work.
-->

## Phase + task

- **Phase:** <!-- e.g. [[Phase 1 — Kill Silent Failures (v0.4.0)]] — or "housekeeping (pre-Phase-1)" -->
- **Task:** <!-- copy the task title from the phase note -->
- **Acceptance criteria:**
  - [ ] <!-- copy from the phase note; tick as each one is verified -->

## What this does

<!-- 1–3 sentences. Plain language. -->

## Why (the tenet-check)

<!--
Which of the 7 architectural tenets in Ouija/Details — Architectural Tenets.md
does this touch? Any violated? Justify if so.

  1. Typed materialised agent identity (no $HOME/.claude bind-mount).
  2. TriggerSource as first-class component (not kanban-coupled).
  3. Positive evidence of success (not subprocess exit codes).
  4. One source of truth for the state enum (TS generates SQL).
  5. Encoded idempotency keys (dedicated encoder; never raw strings).
  6. Per-state dwell budgets + explicit recovery triggers.
  7. One applyTrigger primitive shared by every trigger source.
-->

## Test plan

- [ ] Unit: <!-- what was covered — passing -->
- [ ] Integration: <!-- what was covered — passing -->
- [ ] Full monorepo `npm run test` green

## Build Log entry

<!-- Link to the Ouija/Build Log.md session entry where this work is recorded. -->
