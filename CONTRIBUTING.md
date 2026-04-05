# Contributing to Ouija

Thank you for your interest in contributing to Ouija! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 22+
- npm 11.8.0+
- Git
- Docker & Docker Compose (for integration tests)

### Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/muhammadkh4n/ouija.git
   cd ouija
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build all packages:
   ```bash
   npm run build
   ```

4. Run tests:
   ```bash
   npm run test
   ```

5. Start development with watch mode:
   ```bash
   npm run test:watch
   ```

## Repository Structure

Ouija is a TypeScript monorepo using Turborepo and npm workspaces. Each package in `packages/` is independently publishable but shares the same build, test, and lint tooling.

```
packages/
├── types/                    # Shared types, event schemas
├── engine/                   # State machine + transition logic
├── bus/                      # EventBus + JobQueue abstractions
├── plugin-sdk/               # Plugin base classes and validation
├── plugin-plane/             # Kanban integration: Plane CE
├── plugin-fizzy/             # Kanban integration: Fizzy
├── plugin-github/            # Git integration: GitHub
├── plugin-agent-claude/      # Agent integration: Claude Code
├── plugin-notify-telegram/   # Notifications: Telegram
├── agent-worker/             # Agent subprocess manager
├── workspace-local/          # Workspace (repo clone/worktree)
├── config/                   # Config loading + validation
└── server/                   # HTTP server + API + dashboard
```

### Package Ownership

| Package | Maintains | Tests |
|---------|-----------|-------|
| **types** | Core types shared by all packages | 50+ tests |
| **engine** | Pipeline state machine | 200+ tests (pure logic) |
| **bus** | Job queue and event pub/sub | 100+ tests |
| **plugin-sdk** | Plugin lifecycle and validation | 40+ tests |
| **plugin-*** | Individual integrations | 30+ tests each |
| **server** | HTTP API and webhooks | 80+ tests |

## Working with Packages

### Build a single package:
```bash
npm run build --workspace=@ouija/engine
```

### Test a single package:
```bash
npm run test --workspace=@ouija/engine
```

### Type-check all packages:
```bash
npm run typecheck
```

### Run the linter:
```bash
npm run lint
```

## Adding a New Kanban Plugin

Kanban plugins implement the `KanbanPlugin` interface. Here's how to add support for a new board (e.g., Jira):

### 1. Create the package:
```bash
mkdir packages/plugin-jira
cd packages/plugin-jira
npm init -y
```

### 2. Set up TypeScript:
```bash
npm install --save-dev typescript @types/node
npx tsc --init
```

### 3. Implement the plugin interface:

Create `src/index.ts`:
```typescript
import { KanbanPlugin, KanbanPluginConfig } from '@ouija/types';

export interface JiraConfig extends KanbanPluginConfig {
  baseUrl: string;
  apiKey: string;
  projectKey: string;
}

export class JiraPlugin implements KanbanPlugin {
  constructor(private config: JiraConfig) {}

  async getBoard(boardId: string) {
    // Fetch board from Jira API
    // Return Board type from @ouija/types
  }

  async createCard(board: Board, card: Card) {
    // Create issue in Jira
  }

  async updateCardColumn(card: Card, columnId: string) {
    // Move issue to different status
  }

  async openWebhook(handler: (event: WebhookEvent) => Promise<void>) {
    // Set up webhook listener or polling
  }

  async closeWebhook() {
    // Tear down webhook
  }
}

export default JiraPlugin;
```

### 4. Add tests:

Create `src/index.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import JiraPlugin from './index';

describe('JiraPlugin', () => {
  it('fetches board from Jira', async () => {
    const plugin = new JiraPlugin({
      baseUrl: 'http://jira.local',
      apiKey: 'test-key',
      projectKey: 'TEST',
    });

    const board = await plugin.getBoard('TEST');
    expect(board).toHaveProperty('id');
    expect(board).toHaveProperty('columns');
  });
});
```

### 5. Register the plugin:

Add to `packages/plugin-sdk/src/plugin-loader.ts`:
```typescript
import JiraPlugin from '@ouija/plugin-jira';

const PLUGINS = {
  'jira': JiraPlugin,
  // ... other plugins
};
```

### 6. Update documentation:

Add a section to [README.md](README.md) listing Jira as a supported backend.

## Adding a New Agent Plugin

Agent plugins implement the `AgentPlugin` interface. Here's how to add support for a new agent (e.g., GPT-4):

### 1. Create the package:
```bash
mkdir packages/plugin-agent-gpt
cd packages/plugin-agent-gpt
npm install --save-dev typescript
```

### 2. Implement the agent dispatcher:

Create `src/index.ts`:
```typescript
import { AgentPlugin, WorkOrder, AgentConfig } from '@ouija/types';

export interface GPTConfig extends AgentConfig {
  apiKey: string;
  model: string;
}

export class GPTPlugin implements AgentPlugin {
  constructor(private config: GPTConfig) {}

  async dispatch(workOrder: WorkOrder): Promise<void> {
    // 1. Clone repository (use workspace plugins)
    // 2. Call OpenAI API with work order description
    // 3. Execute returned code
    // 4. Push branch and open PR
    // 5. Update card status
  }

  async cancel(agentId: string, workOrderId: string): Promise<void> {
    // Cancel ongoing work
  }
}

export default GPTPlugin;
```

### 3. Add tests:

Test against real repositories (not mocks). Create a test repo and verify:
- Agent can clone the repo
- Agent can create a branch
- Agent can open a real PR (or test against GitHub API)

### 4. Register the plugin:

Add to `packages/plugin-sdk/src/plugin-loader.ts`:
```typescript
import GPTPlugin from '@ouija/plugin-agent-gpt';

const AGENT_PLUGINS = {
  'gpt': GPTPlugin,
  // ... other agents
};
```

## Testing Guidelines

### Test Philosophy

Ouija's tests are **integration tests, not unit tests**. We test against real databases and external APIs (where safe). Here's why:

- **No mocks for database logic:** Tests run against real PostgreSQL (or SQLite in CI)
- **No mocks for state transitions:** We verify the entire pipeline works end-to-end
- **Real examples:** If we test GitHub integration, we test against a real test repo

This catches issues that mocks would hide (e.g., SQL syntax errors, column name typos, webhook format changes).

### Running Tests

```bash
# Run all tests once
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests for a single package
npm run test --workspace=@ouija/engine

# Run tests matching a pattern
npm run test -- --grep "transition"
```

### Writing Tests

Create a test file next to the code:
```typescript
// src/example.ts
export function parseCard(data: unknown): Card {
  // implementation
}

// src/example.test.ts
import { describe, it, expect } from 'vitest';
import { parseCard } from './example';

describe('parseCard', () => {
  it('parses card data', () => {
    const card = parseCard({
      id: '1',
      title: 'Fix login bug',
    });

    expect(card.id).toBe('1');
    expect(card.title).toBe('Fix login bug');
  });

  it('throws on invalid data', () => {
    expect(() => parseCard(null)).toThrow();
  });
});
```

### Database Tests

For tests that need a real database:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

describe('BoardRepository', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await pool.query('BEGIN');
  });

  afterAll(async () => {
    await pool.query('ROLLBACK');
    await pool.end();
  });

  it('saves and retrieves board', async () => {
    const repo = new BoardRepository(pool);
    const board = await repo.create({ name: 'Test Board' });

    const fetched = await repo.getById(board.id);
    expect(fetched.name).toBe('Test Board');
  });
});
```

## Commit Message Format

Follow conventional commits:

```
type(scope): subject

body (optional)

footer (optional)
```

### Types

- **feat:** New feature
- **fix:** Bug fix
- **test:** Test additions or changes
- **refactor:** Code refactoring without feature changes
- **docs:** Documentation updates
- **chore:** Build, dependency, tooling changes
- **perf:** Performance improvements

### Examples

```
feat(engine): add stall detection for agent timeouts

When an agent subprocess stops sending heartbeats for 5 minutes,
mark the work order as stalled and retry with a fresh dispatch.

Closes #123
```

```
fix(plugin-plane): handle webhook payloads with null assignee

The Plane webhook API can send null for unassigned cards.
Update the parser to handle this gracefully.

Fixes #456
```

```
test(plugin-github): add integration test for PR creation
```

```
docs(README): add quick start section
```

## Pull Request Process

1. **Fork the repository** and create a feature branch:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes** and add tests:
   ```bash
   npm run test              # Verify tests pass
   npm run build             # Verify TypeScript compiles
   npm run typecheck         # Verify no type errors
   npm run lint              # Run linter (if configured)
   ```

3. **Write a clear commit message** following the format above

4. **Push your branch** and open a PR:
   ```bash
   git push origin feat/your-feature-name
   ```

5. **PR template:**
   ```markdown
   ## Description
   Brief summary of changes

   ## Type of Change
   - [ ] New feature
   - [ ] Bug fix
   - [ ] Breaking change
   - [ ] Documentation

   ## How to Test
   Steps to verify the changes work

   ## Checklist
   - [ ] Tests added/updated
   - [ ] Documentation updated
   - [ ] No breaking changes
   ```

6. **CI checks** must pass:
   - All tests pass
   - TypeScript compiles
   - No linting errors

7. **Review:** At least one maintainer must review and approve

8. **Merge:** Squash commits to keep history clean

## Code Style

- **TypeScript:** Strict mode enabled
- **Naming:** camelCase for variables/functions, PascalCase for classes/types
- **Async:** Use async/await, not promise chains
- **Errors:** Use typed errors (don't throw strings)
- **Comments:** Only for complex logic; self-documenting code preferred

## Package Versioning

All packages share the same version (0.x.y during development). Version bumps happen on release:

```bash
npm version minor    # Bump 0.x → 0.(x+1)
git tag -a v0.x.y   # Tag release
git push origin main --tags
```

## Reporting Issues

Found a bug or have a feature request?

1. **Check existing issues** to avoid duplicates
2. **Provide a minimal reproduction** (code example, steps, environment)
3. **Include context:** OS, Node version, Ouija version
4. **Use the issue template** if one exists

## Code of Conduct

Be respectful to contributors, reviewers, and users. Discrimination, harassment, or abuse is not tolerated.

## Questions?

- Open a [GitHub Discussion](https://github.com/muhammadkh4n/ouija/discussions)
- Check existing documentation in `docs/`
- Review integration test examples in `packages/*/src/*.test.ts`

---

Happy coding! We look forward to your contributions.
