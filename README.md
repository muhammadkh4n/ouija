# Ouija

Your kanban board is the control plane. AI agents are the engineers.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Tests Passing](https://img.shields.io/badge/Tests-604%20passing-green.svg)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)](https://www.typescriptlang.org/)

## What is Ouija?

Ouija is a pipeline automation engine that bridges AI agents and kanban boards. When a card is assigned to an agent and moved to "In Progress," the agent automatically clones your repo, writes code, opens a pull request, and advances the card through your workflow. The human stays in control—dragging cards, assigning agents, reviewing PRs—while AI handles the execution.

Unlike generic CI/CD systems or coding assistants, Ouija treats your kanban board as the source of truth for work dispatch. Cards are workflows. Columns are actions. Agents are team members.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      Kanban Board (Plane / Fizzy)              │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐ │
│  │   Backlog    │  In Progress │  In Review   │     Done     │ │
│  │              │              │              │              │ │
│  │  [Card #42]  │  [Card #42]  │              │              │ │
│  │  "Add login" │ ➔ Assigned   │              │              │ │
│  │              │   to Rex     │              │              │ │
│  └──────────────┴──────────────┴──────────────┴──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
           ▲                          │
           │                          │ Webhook: Card moved
           │                          ▼
           │              ┌──────────────────────┐
           │              │  Ouija Pipeline      │
           │              │  Engine              │
           │              │                      │
           │              │  1. Parse trigger    │
           │              │  2. Load config      │
           │              │  3. Route to agent   │
           └──────────────┤  4. Dispatch work    │
                          │                      │
                          └──────────────────────┘
                                   │
                                   ▼
                          ┌──────────────────────┐
                          │  Agent Subprocess    │
                          │  (Claude Code)       │
                          │                      │
                          │  1. Clone repo       │
                          │  2. Write code       │
                          │  3. Push branch      │
                          │  4. Open PR          │
                          │  5. Update card      │
                          └──────────────────────┘
```

## Quick Start

### Prerequisites

- Docker & Docker Compose (24+)
- Node.js 20+ (only for running the CLI — the server itself builds inside Docker)
- An Anthropic API key, or the `claude` CLI with an active session

### 30-second install (recommended)

Use [`@ouija-dev/cli`](packages/cli/README.md) — no need to clone the repo.

```bash
mkdir my-ouija && cd my-ouija
npx @ouija-dev/cli init      # generates secrets, copies docker/ + config
$EDITOR ouija.config.yaml    # set your repo URL and prompt
npx @ouija-dev/cli up        # starts Ouija + Postgres + Redis
npx @ouija-dev/cli doctor    # preflight audit
```

Ouija now listens on `http://localhost:4000`. Point your Plane/Fizzy webhook
at `http://<ouija-host>:4000/hooks/plane/$PLANE_WEBHOOK_SECRET` (use
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or
[ngrok](https://ngrok.com/) to expose it if your kanban board lives in the cloud).

CLI command reference:

```bash
ouija init [-y]               # bootstrap a project
ouija up [--stack S]          # start stack (S = ouija|full|fizzy)
ouija down [-v]               # stop stack (-v also removes volumes)
ouija logs [service]          # tail compose logs
ouija status                  # docker compose ps
ouija doctor                  # preflight audit
```

### Alternative: Full stack with self-hosted Plane

If you don't already have a Plane workspace, start the bundled Plane.
**Requires ~5GB RAM.**

```bash
npx @ouija-dev/cli init
npx @ouija-dev/cli up --stack full
# Then open http://localhost:80, sign up, create a workspace,
# generate an API token, paste it into .env, and:
npx @ouija-dev/cli up --stack full    # restart picks up new .env
```

### Alternative: Clone for hacking

If you want to contribute, modify the engine, or run without Docker:

```bash
git clone https://github.com/muhammadkh4n/ouija.git
cd ouija
npm install
npm run build
bash infra/setup.sh
# Bring your own Postgres + Redis (update OUIJA_DATABASE_URL / OUIJA_REDIS_URL in .env)
node packages/server/dist/index.js
```

See [docs/getting-started.md](docs/getting-started.md) for a full walkthrough
from first clone to first dispatched PR, and
[packages/cli/README.md](packages/cli/README.md) for the full CLI reference.

## Supported Kanban Backends

Ouija supports any kanban board via plugins:

| Backend | Plugin | Status | Notes |
|---------|--------|--------|-------|
| **Plane** | `plugin-plane` | Stable | Self-hosted CE, full webhook support |
| **Fizzy** | `plugin-fizzy` | Stable | Basecamp-powered, REST API based |
| **Jira** | `plugin-jira` | Planned | REST API + webhooks |
| **Linear** | `plugin-linear` | Planned | GraphQL API |

### Environment Variables

```bash
# Plane
PLANE_BASE_URL=http://plane-aio:80
PLANE_API_TOKEN=<your-token>
PLANE_WORKSPACE_SLUG=my-workspace

# Fizzy
FIZZY_BASE_URL=http://fizzy.local:3000
FIZZY_API_KEY=<your-key>

# Ouija Core
OUIJA_SECRET_KEY=<32+ chars>
OUIJA_DATABASE_URL=postgres://user:pass@host:5432/ouija_db
OUIJA_REDIS_URL=redis://host:6379
```

## Architecture

Ouija is built as a TypeScript monorepo (Turborepo + npm workspaces):

| Package | Purpose |
|---------|---------|
| **types** | Shared TypeScript interfaces, event schemas, API contracts |
| **engine** | Pipeline state machine + transition execution (pure, no I/O) |
| **bus** | EventBus + JobQueue abstractions (BullMQ implementation) |
| **plugin-sdk** | BasePlugin, config validation, plugin lifecycle management |
| **plugin-plane** | Kanban plugin for Plane CE |
| **plugin-fizzy** | Kanban plugin for Fizzy |
| **plugin-github** | Git plugin for GitHub (clone, push, PR creation) |
| **plugin-agent-claude** | Agent dispatcher for Claude Code / Claude API |
| **plugin-notify-telegram** | Notifications via Telegram |
| **agent-worker** | Agent subprocess driver (spawns Claude Code CLI) |
| **workspace-local** | Repo workspace management (git clone + worktree) |
| **config** | Configuration loading + validation (ouija.config.yaml) |
| **server** | HTTP server (Fastify), REST API, webhooks |
| **cli** | `@ouija-dev/cli` — init, up, down, logs, doctor |

### Core Design Principles

**Pure Transition Function:** The pipeline engine has a zero-I/O core:
```typescript
transition(state, trigger, config) → { instance, events, sideEffects }
```

All I/O (database writes, API calls, git operations) happens outside the transition. This makes the state machine fully testable without mocks and easy to reason about.

**Plugin System:** Kanban, Git, Agent, and Notification backends are swappable plugins. Add support for a new board or agent with a simple interface.

**Configuration-Driven:** Agents, repos, and board rules are defined in a single YAML file. No database migrations needed for basic setup.

## Agent Configuration

Agents are configured in `ouija.config.yaml`:

```yaml
agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@ouija.local
    triggerMode: auto              # auto or manual
    model: claude-sonnet-4-20250514

    systemPrompt: |
      You are an expert software engineer.
      Write clean, well-tested code.
      Create a pull request when done.

    auth:
      method: api-key              # api-key, bedrock, vertex, foundry, proxy
      secretRef: env:ANTHROPIC_API_KEY

    repos:
      - url: https://github.com/your-org/your-repo.git
        baseBranch: main
        default: true

    limits:
      maxDurationMs: 1800000         # 30 minutes
      stallThresholdMs: 300000       # 5 minutes
```

## Trigger Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **auto** | Agent dispatches immediately when card is assigned | High-trust teams, fully autonomous workflows |
| **manual** | Agent waits for card to be moved to a dispatch column | Approval workflows, human-in-the-loop |

## Authentication Methods

Ouija supports multiple Claude API authentication methods:

- **api-key:** Direct API key (set `ANTHROPIC_API_KEY` env var)
- **bedrock:** AWS Bedrock via IAM role (for AWS environments)
- **vertex:** Google Vertex AI via service account (for GCP environments)
- **foundry:** Anthropic Foundry (enterprise usage-based billing)
- **proxy:** Custom proxy (for air-gapped or regulated environments)

See [docs/configuration.md](docs/configuration.md#auth-authconfig) for setup details.

## Testing

Ouija includes 604 integration and unit tests covering the engine, plugins, and API:

```bash
npm run test              # Run all tests once
npm run test:watch       # Watch mode for development
npm run build            # Compile TypeScript
npm run lint             # Run linter
npm run typecheck        # Type check without build
```

Tests use Vitest and run against real PostgreSQL (not mocks). This ensures the pipeline works with actual data.

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Package structure overview
- How to add a new kanban plugin
- How to add a new agent plugin
- Testing guidelines
- Commit conventions
- PR process

## License

Ouija is licensed under the **Apache License 2.0**. You can use, modify, and distribute it freely in open-source and commercial projects.

See [LICENSE](LICENSE) for full terms.

## Community & Support

- **Issues:** [GitHub Issues](https://github.com/muhammadkh4n/ouija/issues)
- **Discussions:** [GitHub Discussions](https://github.com/muhammadkh4n/ouija/discussions)
- **Security:** Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/muhammadkh4n/ouija/security/advisories/new)

---

Built with TypeScript, Fastify, PostgreSQL, BullMQ, and Claude AI.
