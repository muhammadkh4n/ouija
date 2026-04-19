# Ouija

**Drag a kanban card. Get a pull request. Then watch the agent iterate on reviewer feedback until it's merged.**

Self-hosted. Runs on your Claude Max subscription. No SaaS middleman.

[![npm version](https://img.shields.io/npm/v/@ouija-dev/cli.svg?label=%40ouija-dev%2Fcli)](https://www.npmjs.com/package/@ouija-dev/cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-840%2B%20passing-green.svg)](#)

---

## What makes Ouija different

Most "AI coding agent" tools stop after the first pull request. A reviewer (CodeRabbit, Copilot, a human) leaves comments, and the loop is over — you have to re-prompt the agent by hand. Ouija keeps iterating:

1. You drag a card to **In Progress**. Agent clones the repo, writes code, opens a PR. Card moves to **Review**.
2. A reviewer drops comments. GitHub Actions runs and fails a test. Both land as webhooks.
3. Ouija **debounces** the bursts (60s window coalesces CodeRabbit's 12 nit-picks + your CI's 3 failures into one bundle), **filters** by per-agent reviewer allowlists, then **re-dispatches** the same agent on the same branch with the feedback rendered as a prioritised TODO list.
4. Agent pushes follow-up commits. The PR auto-updates. Loop continues — up to a configurable cap — until a human merges.

You stay in control (drag cards, assign agents, approve merges). The agent iterates until the PR is mergeable.

## Why self-hosted

- **Your Claude Max subscription does the work** — no per-token API billing. The agent runs as a subprocess against your `~/.claude/` session.
- **Your repo never leaves your network.** Ouija clones, pushes, and dispatches inside your infra.
- **No vendor lock-in.** Swap the Claude runner for Bedrock/Vertex/Foundry/a custom proxy. Swap the kanban backend (Plane, Fizzy, more planned). Swap the storage (Postgres).
- **Self-hoster ToS disclaimer:** running subscription auth against Claude Code is at your own risk per Anthropic's terms. If you're at scale, switch the runner to API-billed (`runner: sdk`).

## How it differs from the alternatives

| Tool | Runs on | Source of truth | Iterates on reviews | Self-hosted | Licence |
|---|---|---|---|---|---|
| **Ouija** | Your Claude Max subscription (or API) | Your kanban board | ✅ (PR 2.5 loop) | ✅ | Apache 2.0 |
| Devin | Cognition SaaS | Chat | Partial | ❌ | Closed |
| Cursor Agents | Cursor SaaS | IDE | ❌ | ❌ | Closed |
| OpenHands | Any LLM | Chat/CLI | ❌ | ✅ | MIT |
| Copilot Workspace | GitHub SaaS | Issue | ❌ | ❌ | Closed |
| Aider | Any LLM | CLI | ❌ | ✅ | Apache 2.0 |

The niche: **kanban-native + self-hosted + iterative review loop.** Nothing else hits all three today.

---

## Quick start — under 15 minutes on a fresh machine

```bash
mkdir my-ouija && cd my-ouija
npx @ouija-dev/cli init --preset self-hosted-plane    # generates secrets, docker-compose, config
npx @ouija-dev/cli up                                  # brings up Plane + Ouija + Postgres + Redis
npx @ouija-dev/cli doctor                              # preflight audit (Claude CLI, webhook, auth)
```

Open [`http://localhost:4000/dashboard`](http://localhost:4000/dashboard), paste the `OUIJA_API_KEY` the CLI printed, and you're in. Create your first agent via the **Agents** form — no YAML editing required.

Point your Plane (or Fizzy) webhook at `http://<ouija-host>:4000/hooks/plane/$PLANE_WEBHOOK_SECRET`. If your kanban is in the cloud, expose with [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or [ngrok](https://ngrok.com/).

Drag a card to **In Progress** — the dashboard's live indicator turns green when the first webhook lands. Card moves to Review when the PR opens. Loop runs until you merge.

### Presets

| Preset | Use when |
|---|---|
| `self-hosted-plane` | You want the bundled Plane kanban (~5 GB RAM). |
| `self-hosted-fizzy` | You prefer Fizzy (Basecamp fork, lighter). |
| `byo-kanban` | You already have Plane/Fizzy running — point Ouija at it. |

CLI reference:

```bash
ouija init [--preset P]      # bootstrap; P = self-hosted-plane | self-hosted-fizzy | byo-kanban
ouija up [--stack S]         # start stack; S = ouija | full | fizzy
ouija down [-v]              # stop; -v also removes volumes
ouija logs [service]         # tail compose logs
ouija status                 # docker compose ps
ouija doctor                 # preflight audit
```

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

---

## The review loop in detail

This is the headline feature. What makes it different from "agent opens a PR and stops":

**Signals it reacts to (all dedupes per GitHub ID, all debounce together):**

- `pull_request_review` with state `changes_requested` | `commented` | `approved` — CodeRabbit, Copilot reviewer, Claude review action, human reviews.
- `pull_request_review_comment` — inline code comments.
- `issue_comment` on a PR — top-level thread replies, including `@agent-name` mentions.
- `check_run` + `workflow_run` failures — GitHub Actions test/lint/build failures (failure / timed_out / action_required).

**Controls, per agent:**

- `enabled` — master switch (opt a single agent out entirely).
- `triggerReviewers` — allowlist (only listed logins trigger the loop; useful to pin to `coderabbitai[bot]` + `copilot-pull-request-reviewer[bot]`).
- `ignoreReviewers` — blocklist (drop dependabot, noisy-reviewer).
- `ignoreWorkflows` — skip CI failures from specific workflow names (flaky nightly runs, perf benchmarks).
- `maxIterations` — cap (default 5) before the pipeline transitions to `stalled` for human attention.

**Safety defaults:**

- The agent's own GitHub login is auto-ignored (prevents self-loops).
- Human merge always ends the loop (`pull_request.closed` with `merged: true`).
- `human_cancel` works from any state as an escape hatch.
- Max-iteration cap guarantees bounded cost even under pathological reviewer behaviour.

All configurable in the dashboard **Agents → Review loop** section. No YAML edits.

---

## Architecture

Ouija is a TypeScript monorepo (Turborepo + npm workspaces).

```
  Card moved         agent.work.*          pull_request_review
  webhook            callback              pull_request_review_comment
     │                   │                 issue_comment
     │                   │                 check_run / workflow_run
     ▼                   ▼                      │
┌─────────────────────────────────────────┐     │
│            Fastify (REST + webhooks)    │     │
│            │              │             │     │
│            ▼              ▼             │     ▼
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  │ Orchestrator │   │ Review loop  │   │ ReviewBundler│
│  │  (pure SM)   │◄──┤  handler     │◄──┤  (60s debounce
│  │              │   │              │   │   + dedupe)  │
│  └──────────────┘   └──────────────┘   └──────────────┘
│        │                                     ▲
│        ▼                                     │
│   state: PipelineState  (Postgres JSONB)     │
│   awaiting_review ──pr_review_received──►    │
│   dispatching  ──► running ──► awaiting_review
└──────────────┬──────────────────────────────┘
               ▼
        BullMQ agent-dispatch queue
               ▼
        Claude Code CLI subprocess
        (stream-json runner, subscription auth)
               ▼
        git push → PR auto-updates
```

The pipeline state machine is a pure function — zero I/O — so the full review-loop logic is unit-testable without mocks.

| Package | Purpose |
|---|---|
| **types** | Shared interfaces, event schemas, API contracts |
| **engine** | Pipeline state machine + review bundler (pure, no I/O) |
| **bus** | EventBus + JobQueue abstractions (BullMQ) |
| **plugin-sdk** | BasePlugin, config validation, lifecycle |
| **plugin-plane** | Plane CE kanban integration |
| **plugin-fizzy** | Fizzy (Basecamp) kanban integration |
| **plugin-github** | GitHub git ops + 6 webhook event types |
| **plugin-agent-claude** | Claude Code dispatcher (local / stream-json / sdk runners) |
| **plugin-notify-telegram** | Telegram notifications |
| **plugin-engram** | Cross-run agent memory via [Engram](https://github.com/muhammadkh4n/engram) |
| **agent-worker** | Agent subprocess driver |
| **workspace-local** | Repo workspace management (clone + worktree + branch reuse) |
| **config** | YAML config loading + ajv validation |
| **server** | Fastify HTTP server, webhooks, REST API |
| **cli** | `@ouija-dev/cli` (init, up, down, doctor, logs) |
| **dashboard** | React SPA at `/dashboard` — pipeline monitoring + agent CRUD |

---

## Supported kanban backends

| Backend | Plugin | Status | Notes |
|---|---|---|---|
| **Plane** | `plugin-plane` | Stable | Self-hosted CE, full webhook support, auto-bootstrap |
| **Fizzy** | `plugin-fizzy` | Stable | Basecamp-powered, REST API based |
| **Jira** | `plugin-jira` | Planned | REST API + webhooks |
| **Linear** | `plugin-linear` | Planned | GraphQL API |

Write your own in ~200 lines implementing `KanbanPlugin`. See `packages/plugin-sdk/README.md`.

---

## Agent configuration

Prefer the dashboard. The YAML form exists for IaC setups:

```yaml
agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@ouija.local
    triggerMode: auto              # auto | manual
    runner: stream-json            # stream-json (default) | local | sdk
    model: claude-sonnet-4-20250514

    systemPrompt: |
      You are an expert software engineer.
      Write clean, well-tested code.

    auth:
      method: api-key              # api-key | bedrock | vertex | foundry | api-key-helper | proxy
      secretRef: env:ANTHROPIC_API_KEY

    repos:
      - url: https://github.com/your-org/your-repo.git
        baseBranch: main
        default: true

    limits:
      maxDurationMs: 1800000       # 30 minutes per dispatch
      stallThresholdMs: 300000     # 5 minutes with no heartbeat = stalled

    reviewLoop:                    # optional; omit for defaults
      enabled: true
      triggerReviewers:
        - coderabbitai[bot]
        - copilot-pull-request-reviewer[bot]
      ignoreWorkflows:
        - nightly-bench
      maxIterations: 5
```

### Trigger modes

| Mode | Behaviour | Use case |
|---|---|---|
| **auto** | Agent dispatches immediately when the card is assigned | High-trust teams, fully autonomous workflows |
| **manual** | Agent waits for card to be moved to a dispatch column | Approval workflows, human-in-the-loop |

### Runner choices

| Runner | Auth | Billing | Structured events |
|---|---|---|---|
| **stream-json** (default) | Claude subscription OR API key | Your subscription | ✅ |
| **local** | Claude subscription | Your subscription | ❌ (text only) |
| **sdk** | API key (Anthropic / Bedrock / Vertex / Foundry) | Per-token API | ✅ |

---

## Security

Ouija treats kanban card descriptions as untrusted input (they flow into the agent's prompt). Defence layers:

- **Sanitizer** blocks cards containing shell metacharacters, secret-file paths, `.github/workflows/` references, or suspicious URLs by default.
- **Minimal `HOME`** synthesised per dispatch — agent subprocess can't read `~/.ssh`, `~/.gitconfig`, or `~/.claude/` unless explicitly bind-mounted.
- **HMAC-verified webhooks** (`X-Plane-Signature`, `X-Hub-Signature-256`).
- **AES-256-GCM vault** for per-agent credentials stored in the DB.
- **JWT callbacks** — agents report back via short-lived JWTs with Redis denylist.

See [SECURITY.md](SECURITY.md) for the full threat model and self-hoster checklist.

---

## Testing

```bash
npm run test            # full suite (no mocks — real Postgres via testcontainers)
npm run test:watch      # dev loop
npm run typecheck       # strict tsc --noEmit
npm run build           # compile all packages
```

840+ tests across unit, integration, and end-to-end (webhook → bundler → dispatch closed-circuit).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Dev setup
- Adding a new kanban / git / agent / notification plugin
- Commit conventions
- PR process

Issues, ideas, and show-us-your-setup posts all welcome in [Discussions](https://github.com/muhammadkh4n/ouija/discussions).

---

## Licence

Apache 2.0. Use, fork, and distribute freely — commercial and non-commercial. See [LICENSE](LICENSE).

---

## Community

- [GitHub Issues](https://github.com/muhammadkh4n/ouija/issues) — bugs, feature requests
- [GitHub Discussions](https://github.com/muhammadkh4n/ouija/discussions) — show us your setup, ask questions
- [Security advisories](https://github.com/muhammadkh4n/ouija/security/advisories/new) — responsible disclosure

Built with TypeScript, Fastify, PostgreSQL, BullMQ, and Claude.
