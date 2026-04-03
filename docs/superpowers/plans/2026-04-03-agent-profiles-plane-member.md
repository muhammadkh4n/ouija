# Agent Profiles & Plane Member Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded agent profile with a config-file-driven system where agents are Plane members that can be assigned cards, with configurable trigger modes (auto-dispatch on assign vs wait for column move).

**Architecture:** A new `@ouija/config` package owns parsing/validating `ouija.config.yaml`. It produces typed `AgentProfileConfig` objects consumed by the agent worker (for profile resolution) and the server (for Plane member provisioning + assignee→agent mapping). The orchestrator gains an `AgentMemberRegistry` dependency that maps Plane member IDs to ouija agent IDs, enabling the `card_assigned` trigger to dispatch work.

**Tech Stack:** TypeScript, Vitest, yaml (npm package for YAML parsing), Ajv (already in plugin-sdk for JSON Schema validation), existing monorepo toolchain (Turbo, npm workspaces).

---

## File Map

### New package: `packages/config/`
| File | Responsibility |
|------|---------------|
| `packages/config/package.json` | Package manifest, depends on `yaml`, `ajv` |
| `packages/config/tsconfig.json` | TypeScript config extending root |
| `packages/config/vitest.config.ts` | Vitest config |
| `packages/config/src/index.ts` | Public API re-exports |
| `packages/config/src/schema.ts` | JSON Schema for `ouija.config.yaml` + Ajv validator |
| `packages/config/src/types.ts` | `OuijaConfig`, `AgentProfileConfig`, `RepoConfig`, `AuthConfig` types |
| `packages/config/src/loader.ts` | `loadConfig(path)` — reads YAML, validates, returns typed config |
| `packages/config/src/agent-member-registry.ts` | Maps Plane member ID ↔ ouija agent ID; provisions Plane members on startup |
| `packages/config/tests/schema.test.ts` | Validation tests |
| `packages/config/tests/loader.test.ts` | Loader tests with fixture YAML files |
| `packages/config/tests/agent-member-registry.test.ts` | Registry tests |
| `packages/config/tests/fixtures/valid.yaml` | Valid config fixture |
| `packages/config/tests/fixtures/minimal.yaml` | Minimal valid config |
| `packages/config/tests/fixtures/invalid-no-agents.yaml` | Missing agents array |
| `packages/config/tests/fixtures/invalid-bad-auth.yaml` | Invalid auth method |

### Modified files
| File | Change |
|------|--------|
| `packages/types/src/workspace.ts` | Add `repoPath` to `WorkspaceSpec` as alternative to `repoUrl` |
| `packages/workspace-local/src/local-workspace.ts` | Support `repoPath` — git worktree instead of clone |
| `packages/workspace-local/tests/local-workspace.test.ts` | Tests for worktree provisioning |
| `packages/agent-worker/src/work-order-assembler.ts` | `AgentProfile` gains `repoPath?`, `triggerMode`, `configDir?` fields |
| `packages/agent-worker/src/index.ts` | Replace hardcoded profile with config-driven `getAgentProfile` |
| `packages/agent-worker/tests/work-order-assembler.test.ts` | Update fixtures for new AgentProfile shape |
| `packages/engine/src/orchestrator.ts` | Inject `AgentMemberRegistry`; handle `card_assigned` → dispatch |
| `packages/engine/tests/orchestrator.test.ts` | Tests for assign-to-agent dispatch flow |
| `packages/server/src/index.ts` | Load config, provision Plane members on startup, wire registry |
| `package.json` | Add `packages/config` to workspaces (already covered by `packages/*` glob) |

---

### Task 1: Create `@ouija/config` package scaffold

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/vitest.config.ts`
- Create: `packages/config/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ouija/config",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "echo 'no linter configured'"
  },
  "dependencies": {
    "yaml": "^2.7.0",
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["dist", "tests", "node_modules"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create empty index.ts**

```typescript
export * from './types.js';
export * from './loader.js';
export * from './agent-member-registry.js';
```

- [ ] **Step 5: Run npm install from repo root**

Run: `npm install`
Expected: `packages/config` added to workspace, `yaml` and `ajv` installed.

- [ ] **Step 6: Commit**

```bash
git add packages/config/package.json packages/config/tsconfig.json packages/config/vitest.config.ts packages/config/src/index.ts
git commit -m "feat(config): scaffold @ouija/config package"
```

---

### Task 2: Define config types

**Files:**
- Create: `packages/config/src/types.ts`

- [ ] **Step 1: Write types.ts**

```typescript
/**
 * Typed representation of ouija.config.yaml.
 *
 * This is the single source of truth for agent profiles, auth, repos,
 * and trigger behaviour. Parsed from YAML, validated by JSON Schema.
 */

// ---- Auth methods ----

export type AuthMethod =
  | 'api-key'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'api-key-helper'
  | 'proxy';

export interface AuthConfig {
  method: AuthMethod;
  /** Credential reference — e.g. "env:ANTHROPIC_API_KEY" */
  secretRef: string;
}

// ---- Repo config ----

export interface RepoConfig {
  /** Remote URL — mutually exclusive with `path`. */
  url?: string;
  /** Local filesystem path — mutually exclusive with `url`. */
  path?: string;
  baseBranch: string;
  /** When true, this is the fallback repo for this agent. Exactly one per agent. */
  default?: boolean;
}

// ---- Trigger modes ----

/** "auto" = dispatch immediately on assign. "manual" = wait for column move. */
export type TriggerMode = 'auto' | 'manual';

// ---- Agent profile config ----

export interface AgentProfileConfig {
  id: string;
  name: string;
  /** Email used for Plane member provisioning. Convention: <id>@ouija.local */
  email: string;
  /** Optional URL to an avatar image. */
  avatar?: string;
  systemPrompt?: string;
  /** Path to a directory containing .claude/ config. Overrides systemPrompt. */
  configDir?: string;
  model: string;
  triggerMode: TriggerMode;
  auth: AuthConfig;
  repos: RepoConfig[];
  limits: {
    maxDurationMs: number;
    stallThresholdMs?: number;
  };
}

// ---- Top-level config ----

export interface OuijaConfig {
  /**
   * null = inherit host HOME (agents see ~/.claude/).
   * string = use this path as HOME for agent subprocesses.
   */
  claudeHome: string | null;
  agents: AgentProfileConfig[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/config && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/config/src/types.ts
git commit -m "feat(config): define OuijaConfig and AgentProfileConfig types"
```

---

### Task 3: Write JSON Schema and validator

**Files:**
- Create: `packages/config/src/schema.ts`
- Create: `packages/config/tests/schema.test.ts`
- Create: `packages/config/tests/fixtures/valid.yaml`
- Create: `packages/config/tests/fixtures/minimal.yaml`
- Create: `packages/config/tests/fixtures/invalid-no-agents.yaml`
- Create: `packages/config/tests/fixtures/invalid-bad-auth.yaml`

- [ ] **Step 1: Write the failing test**

Create `packages/config/tests/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateConfig } from '../src/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
  return parse(raw);
}

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    const data = loadFixture('valid.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.agents).toHaveLength(1);
      expect(result.config.agents[0].id).toBe('rex-coder');
    }
  });

  it('accepts a minimal config', () => {
    const data = loadFixture('minimal.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.claudeHome).toBeNull();
    }
  });

  it('rejects config with no agents array', () => {
    const data = loadFixture('invalid-no-agents.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('agents'))).toBe(true);
    }
  });

  it('rejects config with invalid auth method', () => {
    const data = loadFixture('invalid-bad-auth.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('method'))).toBe(true);
    }
  });

  it('rejects agent with both url and path in same repo entry', () => {
    const data = {
      agents: [{
        id: 'test', name: 'Test', email: 'test@ouija.local',
        model: 'claude-sonnet-4-20250514', triggerMode: 'auto',
        auth: { method: 'api-key', secretRef: 'env:KEY' },
        repos: [{ url: 'https://github.com/x/y.git', path: '/local/repo', baseBranch: 'main', default: true }],
        limits: { maxDurationMs: 1800000 },
      }],
    };
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
  });

  it('rejects agent with no default repo', () => {
    const data = {
      agents: [{
        id: 'test', name: 'Test', email: 'test@ouija.local',
        model: 'claude-sonnet-4-20250514', triggerMode: 'auto',
        auth: { method: 'api-key', secretRef: 'env:KEY' },
        repos: [{ url: 'https://github.com/x/y.git', baseBranch: 'main' }],
        limits: { maxDurationMs: 1800000 },
      }],
    };
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
  });

  it('rejects duplicate agent IDs', () => {
    const agent = {
      id: 'dup', name: 'Dup', email: 'dup@ouija.local',
      model: 'claude-sonnet-4-20250514', triggerMode: 'auto',
      auth: { method: 'api-key', secretRef: 'env:KEY' },
      repos: [{ url: 'https://github.com/x/y.git', baseBranch: 'main', default: true }],
      limits: { maxDurationMs: 1800000 },
    };
    const data = { agents: [agent, { ...agent, name: 'Dup2', email: 'dup2@ouija.local' }] };
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Create fixture files**

Create `packages/config/tests/fixtures/valid.yaml`:

```yaml
claudeHome: null

agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@ouija.local
    triggerMode: auto
    model: claude-sonnet-4-20250514
    systemPrompt: |
      You are an expert software engineer.
      Write clean, well-tested code.
    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY
    repos:
      - url: https://github.com/muhammadkh4n/ouija.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 1800000
      stallThresholdMs: 300000
```

Create `packages/config/tests/fixtures/minimal.yaml`:

```yaml
agents:
  - id: bot
    name: Bot
    email: bot@ouija.local
    triggerMode: auto
    model: claude-sonnet-4-20250514
    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY
    repos:
      - url: https://github.com/x/y.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 600000
```

Create `packages/config/tests/fixtures/invalid-no-agents.yaml`:

```yaml
claudeHome: null
```

Create `packages/config/tests/fixtures/invalid-bad-auth.yaml`:

```yaml
agents:
  - id: bad
    name: Bad
    email: bad@ouija.local
    triggerMode: auto
    model: claude-sonnet-4-20250514
    auth:
      method: telepathy
      secretRef: env:KEY
    repos:
      - url: https://github.com/x/y.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 1800000
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/config && npx vitest run tests/schema.test.ts`
Expected: FAIL — `validateConfig` does not exist yet.

- [ ] **Step 4: Write schema.ts**

Create `packages/config/src/schema.ts`:

```typescript
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { OuijaConfig, AgentProfileConfig } from './types.js';

// ---- JSON Schema for ouija.config.yaml ----

const repoSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    path: { type: 'string' },
    baseBranch: { type: 'string', minLength: 1 },
    default: { type: 'boolean' },
  },
  required: ['baseBranch'],
  additionalProperties: false,
  // url and path are mutually exclusive — enforced in post-validation
} as const;

const authSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      enum: ['api-key', 'bedrock', 'vertex', 'foundry', 'api-key-helper', 'proxy'],
    },
    secretRef: { type: 'string', minLength: 1 },
  },
  required: ['method', 'secretRef'],
  additionalProperties: false,
} as const;

const limitsSchema = {
  type: 'object',
  properties: {
    maxDurationMs: { type: 'number', minimum: 60_000, maximum: 7_200_000 },
    stallThresholdMs: { type: 'number', minimum: 30_000 },
  },
  required: ['maxDurationMs'],
  additionalProperties: false,
} as const;

const agentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', minLength: 1 },
    avatar: { type: 'string' },
    systemPrompt: { type: 'string' },
    configDir: { type: 'string' },
    model: { type: 'string', minLength: 1 },
    triggerMode: { type: 'string', enum: ['auto', 'manual'] },
    auth: authSchema,
    repos: { type: 'array', items: repoSchema, minItems: 1 },
    limits: limitsSchema,
  },
  required: ['id', 'name', 'email', 'model', 'triggerMode', 'auth', 'repos', 'limits'],
  additionalProperties: false,
} as const;

const configSchema = {
  type: 'object',
  properties: {
    claudeHome: { type: ['string', 'null'] },
    agents: { type: 'array', items: agentSchema, minItems: 1 },
  },
  required: ['agents'],
  additionalProperties: false,
} as const;

// ---- Validation result ----

export type ValidationResult =
  | { valid: true; config: OuijaConfig }
  | { valid: false; errors: string[] };

// ---- Validator ----

export function validateConfig(data: unknown): ValidationResult {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  const validate = ajv.compile(configSchema);
  const valid = validate(data);

  if (!valid) {
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`,
    );
    return { valid: false, errors };
  }

  // Post-validation semantic checks
  const raw = data as Record<string, unknown>;
  const agents = raw['agents'] as Array<Record<string, unknown>>;
  const errors: string[] = [];

  // Check for duplicate agent IDs
  const ids = new Set<string>();
  for (const agent of agents) {
    const id = agent['id'] as string;
    if (ids.has(id)) {
      errors.push(`Duplicate agent ID: "${id}"`);
    }
    ids.add(id);
  }

  // Per-agent checks
  for (const agent of agents) {
    const id = agent['id'] as string;
    const repos = agent['repos'] as Array<Record<string, unknown>>;

    // Each repo must have url OR path, not both
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      const hasUrl = typeof repo['url'] === 'string' && repo['url'].length > 0;
      const hasPath = typeof repo['path'] === 'string' && repo['path'].length > 0;
      if (hasUrl && hasPath) {
        errors.push(`Agent "${id}" repo[${i}]: cannot set both "url" and "path"`);
      }
      if (!hasUrl && !hasPath) {
        errors.push(`Agent "${id}" repo[${i}]: must set either "url" or "path"`);
      }
    }

    // Exactly one default repo
    const defaultCount = repos.filter((r) => r['default'] === true).length;
    if (defaultCount === 0) {
      errors.push(`Agent "${id}": at least one repo must have "default: true"`);
    }
    if (defaultCount > 1) {
      errors.push(`Agent "${id}": only one repo can have "default: true"`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Cast to typed config — claudeHome defaults to null when absent
  const config: OuijaConfig = {
    claudeHome: (raw['claudeHome'] as string | null | undefined) ?? null,
    agents: agents as unknown as AgentProfileConfig[],
  };

  return { valid: true, config };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/config && npx vitest run tests/schema.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/schema.ts packages/config/tests/schema.test.ts packages/config/tests/fixtures/
git commit -m "feat(config): add JSON Schema validation for ouija.config.yaml"
```

---

### Task 4: Write config loader

**Files:**
- Create: `packages/config/src/loader.ts`
- Create: `packages/config/tests/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/config/tests/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

describe('loadConfig', () => {
  it('loads and parses a valid YAML config', async () => {
    const config = await loadConfig(join(fixturesDir, 'valid.yaml'));
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('rex-coder');
    expect(config.agents[0].triggerMode).toBe('auto');
    expect(config.agents[0].auth.method).toBe('api-key');
    expect(config.agents[0].repos[0].url).toBe('https://github.com/muhammadkh4n/ouija.git');
    expect(config.agents[0].repos[0].default).toBe(true);
    expect(config.claudeHome).toBeNull();
  });

  it('throws on non-existent file', async () => {
    await expect(loadConfig('/does/not/exist.yaml')).rejects.toThrow('ENOENT');
  });

  it('throws on invalid config', async () => {
    await expect(
      loadConfig(join(fixturesDir, 'invalid-no-agents.yaml')),
    ).rejects.toThrow('Invalid ouija config');
  });

  it('defaults claudeHome to null when not set', async () => {
    const config = await loadConfig(join(fixturesDir, 'minimal.yaml'));
    expect(config.claudeHome).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/config && npx vitest run tests/loader.test.ts`
Expected: FAIL — `loadConfig` does not exist yet.

- [ ] **Step 3: Write loader.ts**

Create `packages/config/src/loader.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { validateConfig } from './schema.js';
import type { OuijaConfig } from './types.js';

/**
 * Load and validate ouija.config.yaml from the given path.
 * Throws on file-not-found, YAML parse error, or validation failure.
 */
export async function loadConfig(configPath: string): Promise<OuijaConfig> {
  const raw = await readFile(configPath, 'utf-8');
  const parsed = parse(raw) as unknown;

  const result = validateConfig(parsed);

  if (!result.valid) {
    throw new Error(
      `Invalid ouija config at ${configPath}:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  return result.config;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/config && npx vitest run tests/loader.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/loader.ts packages/config/tests/loader.test.ts
git commit -m "feat(config): add loadConfig YAML loader with validation"
```

---

### Task 5: Build AgentMemberRegistry

**Files:**
- Create: `packages/config/src/agent-member-registry.ts`
- Create: `packages/config/tests/agent-member-registry.test.ts`

This is the critical piece: maps Plane member IDs to ouija agent IDs and provisions Plane members on startup.

- [ ] **Step 1: Write the failing test**

Create `packages/config/tests/agent-member-registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMemberRegistry } from '../src/agent-member-registry.js';
import type { PlaneClient } from '../src/agent-member-registry.js';
import type { AgentProfileConfig } from '../src/types.js';

// ---- Fixtures ----

const rexProfile: AgentProfileConfig = {
  id: 'rex-coder',
  name: 'Rex Coder',
  email: 'rex@ouija.local',
  model: 'claude-sonnet-4-20250514',
  triggerMode: 'auto',
  auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
  repos: [{ url: 'https://github.com/x/y.git', baseBranch: 'main', default: true }],
  limits: { maxDurationMs: 1800000 },
};

const frontendProfile: AgentProfileConfig = {
  id: 'frontend-agent',
  name: 'Frontend Agent',
  email: 'frontend@ouija.local',
  model: 'claude-sonnet-4-20250514',
  triggerMode: 'manual',
  auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
  repos: [{ url: 'https://github.com/x/y.git', baseBranch: 'main', default: true }],
  limits: { maxDurationMs: 1800000 },
};

function makePlaneClient(existingMembers: Array<{ id: string; email: string; display_name: string; role: number }> = []): PlaneClient {
  return {
    getMembers: vi.fn().mockResolvedValue(existingMembers),
    inviteMember: vi.fn().mockImplementation(async (_ws: string, email: string) => ({
      id: `new-member-${email}`,
      email,
      role: 10,
    })),
  };
}

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('AgentMemberRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provisions a new Plane member when none exists', async () => {
    const client = makePlaneClient([]);
    const registry = new AgentMemberRegistry([rexProfile], client, 'my-workspace', noopLogger);
    await registry.provision();

    expect(client.inviteMember).toHaveBeenCalledWith('my-workspace', 'rex@ouija.local', 10);
    expect(registry.getAgentIdByMemberId('new-member-rex@ouija.local')).toBe('rex-coder');
  });

  it('reuses existing Plane member by email match', async () => {
    const client = makePlaneClient([
      { id: 'existing-123', email: 'rex@ouija.local', display_name: 'Rex', role: 10 },
    ]);
    const registry = new AgentMemberRegistry([rexProfile], client, 'my-workspace', noopLogger);
    await registry.provision();

    expect(client.inviteMember).not.toHaveBeenCalled();
    expect(registry.getAgentIdByMemberId('existing-123')).toBe('rex-coder');
  });

  it('returns undefined for unknown member IDs', async () => {
    const client = makePlaneClient([]);
    const registry = new AgentMemberRegistry([rexProfile], client, 'my-workspace', noopLogger);
    await registry.provision();

    expect(registry.getAgentIdByMemberId('unknown-id')).toBeUndefined();
  });

  it('provisions multiple agents', async () => {
    const client = makePlaneClient([]);
    const registry = new AgentMemberRegistry(
      [rexProfile, frontendProfile],
      client, 'my-workspace', noopLogger,
    );
    await registry.provision();

    expect(client.inviteMember).toHaveBeenCalledTimes(2);
    expect(registry.getAgentIdByMemberId('new-member-rex@ouija.local')).toBe('rex-coder');
    expect(registry.getAgentIdByMemberId('new-member-frontend@ouija.local')).toBe('frontend-agent');
  });

  it('isAgentMember returns true for known agent member IDs', async () => {
    const client = makePlaneClient([]);
    const registry = new AgentMemberRegistry([rexProfile], client, 'my-workspace', noopLogger);
    await registry.provision();

    expect(registry.isAgentMember('new-member-rex@ouija.local')).toBe(true);
    expect(registry.isAgentMember('human-user-id')).toBe(false);
  });

  it('getProfile returns the agent profile by ID', async () => {
    const client = makePlaneClient([]);
    const registry = new AgentMemberRegistry([rexProfile], client, 'my-workspace', noopLogger);
    await registry.provision();

    const profile = registry.getProfile('rex-coder');
    expect(profile).toBeDefined();
    expect(profile!.name).toBe('Rex Coder');
    expect(registry.getProfile('nonexistent')).toBeUndefined();
  });

  it('getTriggerMode returns the agent trigger mode', async () => {
    const client = makePlaneClient([]);
    const registry = new AgentMemberRegistry(
      [rexProfile, frontendProfile],
      client, 'my-workspace', noopLogger,
    );
    await registry.provision();

    expect(registry.getTriggerMode('rex-coder')).toBe('auto');
    expect(registry.getTriggerMode('frontend-agent')).toBe('manual');
    expect(registry.getTriggerMode('unknown')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/config && npx vitest run tests/agent-member-registry.test.ts`
Expected: FAIL — `AgentMemberRegistry` does not exist yet.

- [ ] **Step 3: Write agent-member-registry.ts**

Create `packages/config/src/agent-member-registry.ts`:

```typescript
import type { AgentProfileConfig, TriggerMode } from './types.js';

// ---- Minimal Plane client interface (injected, not imported from plugin-plane) ----

export interface PlaneClient {
  getMembers(workspaceSlug: string): Promise<Array<{ id: string; email: string; display_name: string; role: number }>>;
  inviteMember(workspaceSlug: string, email: string, role: number): Promise<{ id: string; email: string; role: number }>;
}

export interface RegistryLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Maps Plane member IDs ↔ ouija agent IDs.
 * Provisions Plane members on startup for each configured agent.
 */
export class AgentMemberRegistry {
  /** Plane member ID → ouija agent ID */
  private readonly memberToAgent = new Map<string, string>();
  /** ouija agent ID → AgentProfileConfig */
  private readonly profiles = new Map<string, AgentProfileConfig>();

  constructor(
    private readonly agents: AgentProfileConfig[],
    private readonly planeClient: PlaneClient,
    private readonly workspaceSlug: string,
    private readonly logger: RegistryLogger,
  ) {
    for (const agent of agents) {
      this.profiles.set(agent.id, agent);
    }
  }

  /**
   * Provision Plane members for all configured agents.
   * For each agent: find existing member by email, or create one.
   * Populates the member→agent mapping.
   */
  async provision(): Promise<void> {
    const existingMembers = await this.planeClient.getMembers(this.workspaceSlug);
    const emailToMemberId = new Map(existingMembers.map((m) => [m.email, m.id]));

    for (const agent of this.agents) {
      const existingId = emailToMemberId.get(agent.email);

      if (existingId !== undefined) {
        this.memberToAgent.set(existingId, agent.id);
        this.logger.info('Agent already exists as Plane member', {
          agentId: agent.id,
          memberId: existingId,
          email: agent.email,
        });
      } else {
        const created = await this.planeClient.inviteMember(this.workspaceSlug, agent.email, 10);
        this.memberToAgent.set(created.id, agent.id);
        this.logger.info('Provisioned new Plane member for agent', {
          agentId: agent.id,
          memberId: created.id,
          email: agent.email,
        });
      }
    }
  }

  /** Resolve a Plane member ID to an ouija agent ID. Returns undefined if not an agent. */
  getAgentIdByMemberId(memberId: string): string | undefined {
    return this.memberToAgent.get(memberId);
  }

  /** Check if a Plane member ID belongs to a registered agent. */
  isAgentMember(memberId: string): boolean {
    return this.memberToAgent.has(memberId);
  }

  /** Get a full agent profile by ouija agent ID. */
  getProfile(agentId: string): AgentProfileConfig | undefined {
    return this.profiles.get(agentId);
  }

  /** Get the trigger mode for an agent. */
  getTriggerMode(agentId: string): TriggerMode | undefined {
    return this.profiles.get(agentId)?.triggerMode;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/config && npx vitest run tests/agent-member-registry.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/agent-member-registry.ts packages/config/tests/agent-member-registry.test.ts
git commit -m "feat(config): add AgentMemberRegistry with Plane member provisioning"
```

---

### Task 6: Add `repoPath` support to WorkspaceSpec and LocalWorkspaceProvider

**Files:**
- Modify: `packages/types/src/workspace.ts`
- Modify: `packages/workspace-local/src/local-workspace.ts`
- Modify: `packages/workspace-local/tests/local-workspace.test.ts`

- [ ] **Step 1: Add `repoPath` to WorkspaceSpec**

In `packages/types/src/workspace.ts`, modify `WorkspaceSpec`:

```typescript
export interface WorkspaceSpec {
  type: WorkspaceType;
  /** Git remote URL — the repo to clone into the workspace. Mutually exclusive with repoPath. */
  repoUrl?: string;
  /** Local filesystem path to an existing repo. Uses git worktree for isolation. Mutually exclusive with repoUrl. */
  repoPath?: string;
  /** Branch to clone from (e.g. "main"). */
  baseBranch: string;
  /** Pre-created feature branch the agent will commit to. */
  featureBranch: string;
  /** Optional resource hints — providers may ignore if unsupported. */
  resources?: {
    cpu?: number;
    memoryMb?: number;
    diskGb?: number;
  };
  /** Container image or VM image identifier, provider-specific. */
  image?: string;
  /** How long to wait for the workspace to become ready before failing. */
  provisionTimeoutMs?: number;
}
```

- [ ] **Step 2: Write the failing test for worktree provisioning**

Add to `packages/workspace-local/tests/local-workspace.test.ts`:

```typescript
describe('LocalWorkspaceProvider (worktree mode)', () => {
  it('provisions via git worktree when repoPath is set', async () => {
    const worktreeFn = vi.fn().mockResolvedValue(undefined);
    const branchFn = vi.fn().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({
      baseDir: tmpBase,
      cloneFn: cloneFn,
      branchFn,
      worktreeFn,
    });

    const spec: WorkspaceSpec = {
      type: 'local',
      repoPath: '/home/mk/Projects/my-app',
      baseBranch: 'main',
      featureBranch: 'ouija/test-wt',
    };

    const ws = await provider.provision(spec);
    expect(ws.type).toBe('local');
    expect(ws.endpoint).toContain('ouija-ws-');
    expect(worktreeFn).toHaveBeenCalledWith(
      '/home/mk/Projects/my-app',
      expect.stringContaining('ouija-ws-'),
      'ouija/test-wt',
    );
    expect(cloneFn).not.toHaveBeenCalled();
    expect(branchFn).not.toHaveBeenCalled();
  });

  it('destroys worktree workspace via git worktree remove', async () => {
    const worktreeFn = vi.fn().mockResolvedValue(undefined);
    const worktreeRemoveFn = vi.fn().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({
      baseDir: tmpBase,
      worktreeFn,
      worktreeRemoveFn,
    });

    const spec: WorkspaceSpec = {
      type: 'local',
      repoPath: '/home/mk/Projects/my-app',
      baseBranch: 'main',
      featureBranch: 'ouija/test-wt-destroy',
    };

    const ws = await provider.provision(spec);
    await provider.destroy(ws.id);
    expect(worktreeRemoveFn).toHaveBeenCalledWith(
      '/home/mk/Projects/my-app',
      ws.endpoint,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/workspace-local && npx vitest run tests/local-workspace.test.ts`
Expected: FAIL — `worktreeFn` and `worktreeRemoveFn` not accepted yet.

- [ ] **Step 4: Add worktree support to LocalWorkspaceProvider**

In `packages/workspace-local/src/local-workspace.ts`, add new injectable functions and update provision/destroy:

Add types:

```typescript
/** Injectable worktree creation function. */
export type WorktreeFn = (repoPath: string, worktreeDir: string, branchName: string) => Promise<void>;

/** Injectable worktree removal function. */
export type WorktreeRemoveFn = (repoPath: string, worktreeDir: string) => Promise<void>;
```

Add to `LocalWorkspaceOptions`:

```typescript
export interface LocalWorkspaceOptions {
  baseDir?: string;
  cloneFn?: CloneFn;
  branchFn?: BranchFn;
  worktreeFn?: WorktreeFn;
  worktreeRemoveFn?: WorktreeRemoveFn;
}
```

Add default implementations:

```typescript
async function defaultWorktreeFn(repoPath: string, worktreeDir: string, branchName: string): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'add', worktreeDir, '-b', branchName],
    { cwd: repoPath, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}

async function defaultWorktreeRemoveFn(repoPath: string, worktreeDir: string): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'remove', worktreeDir, '--force'],
    { cwd: repoPath, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}
```

Add to constructor:

```typescript
private readonly worktreeFn: WorktreeFn;
private readonly worktreeRemoveFn: WorktreeRemoveFn;

// Track which workspaces are worktree-based (need different destroy)
private readonly worktreeSources = new Map<string, string>(); // workspace id → source repo path

constructor(options: LocalWorkspaceOptions = {}) {
  this.baseDir = options.baseDir ?? os.tmpdir();
  this.cloneFn = options.cloneFn ?? defaultCloneFn;
  this.branchFn = options.branchFn ?? defaultBranchFn;
  this.worktreeFn = options.worktreeFn ?? defaultWorktreeFn;
  this.worktreeRemoveFn = options.worktreeRemoveFn ?? defaultWorktreeRemoveFn;
}
```

Update `provision()`:

```typescript
async provision(spec: WorkspaceSpec): Promise<Workspace> {
  const prefix = path.join(this.baseDir, 'ouija-ws-');
  const tempDir = await mkdtemp(prefix);
  const id = path.basename(tempDir);

  try {
    if (spec.repoPath) {
      // Worktree mode: create a git worktree from the existing repo
      await this.worktreeFn(spec.repoPath, tempDir, spec.featureBranch);
      this.worktreeSources.set(id, spec.repoPath);
    } else if (spec.repoUrl) {
      // Clone mode: clone the repo into the temp dir
      await this.cloneFn(spec.repoUrl, tempDir, spec.baseBranch);
      await this.branchFn(tempDir, spec.featureBranch);
    } else {
      throw new Error('WorkspaceSpec must have either repoUrl or repoPath');
    }
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }

  this.workspacePaths.set(id, tempDir);

  return {
    id,
    type: 'local',
    endpoint: tempDir,
  };
}
```

Update `destroy()`:

```typescript
async destroy(workspaceId: string): Promise<void> {
  const dir = this.workspacePaths.get(workspaceId);
  if (dir === undefined) return;

  const sourceRepo = this.worktreeSources.get(workspaceId);
  if (sourceRepo) {
    // Worktree mode: use git worktree remove
    await this.worktreeRemoveFn(sourceRepo, dir);
    this.worktreeSources.delete(workspaceId);
  } else {
    // Clone mode: rm -rf the temp dir
    await rm(dir, { recursive: true, force: true });
  }

  this.workspacePaths.delete(workspaceId);
}
```

- [ ] **Step 5: Run all workspace-local tests**

Run: `cd packages/workspace-local && npx vitest run`
Expected: All tests PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/workspace.ts packages/workspace-local/src/local-workspace.ts packages/workspace-local/tests/local-workspace.test.ts
git commit -m "feat(workspace-local): add worktree-based provisioning for local path repos"
```

---

### Task 7: Update AgentProfile and WorkOrderAssembler for new config shape

**Files:**
- Modify: `packages/agent-worker/src/work-order-assembler.ts`
- Modify: `packages/agent-worker/tests/work-order-assembler.test.ts`

- [ ] **Step 1: Update AgentProfile type**

In `packages/agent-worker/src/work-order-assembler.ts`, update `AgentProfile`:

```typescript
export interface AgentProfile {
  id: string;
  name: string;
  systemPrompt: string;
  secretRef: string;
  model: string;
  maxDurationMs: number;
  /** Remote repo URL — mutually exclusive with repoPath. */
  repoUrl?: string;
  /** Local repo path — mutually exclusive with repoUrl. */
  repoPath?: string;
  baseBranch: string;
  triggerMode: 'auto' | 'manual';
  /** Path to agent's Claude Code config directory. */
  configDir?: string;
  /** Auth method for the Claude subprocess. */
  authMethod?: string;
}
```

- [ ] **Step 2: Update assembleWorkOrder to handle repoPath**

In `assembleWorkOrder`, update the WorkOrder construction:

```typescript
const workOrder: WorkOrder = {
  instanceId: makeInstanceId(jobData.instanceId),
  cardId: jobData.cardId,
  title: card.title,
  description: card.description,
  acceptanceCriteria: card.acceptanceCriteria,
  repoUrl: profile.repoUrl ?? '',
  branch: `ouija/${jobData.instanceId}`,
  baseBranch: profile.baseBranch,
  agentProfileId: jobData.agentId,
  systemPrompt: profile.systemPrompt,
  secretRef: profile.secretRef,
  callbackUrl: `${deps.serverBaseUrl}/hooks/agent/callback`,
  callbackToken: jwt,
  maxDurationMs: profile.maxDurationMs,
  metadata: {
    ...(profile.repoPath ? { repoPath: profile.repoPath } : {}),
    ...(profile.configDir ? { configDir: profile.configDir } : {}),
    ...(profile.authMethod ? { authMethod: profile.authMethod } : {}),
  },
};
```

- [ ] **Step 3: Update test fixtures**

In `packages/agent-worker/tests/work-order-assembler.test.ts`, update `baseProfile`:

```typescript
const baseProfile: AgentProfile = {
  id: 'rex-coder',
  name: 'Rex Coder',
  systemPrompt: 'You are an expert engineer.',
  secretRef: 'cred:anthropic',
  model: 'claude-sonnet-4-20250514',
  maxDurationMs: 1_800_000,
  repoUrl: 'https://github.com/org/repo.git',
  baseBranch: 'main',
  triggerMode: 'auto',
};
```

Add a new test for repoPath metadata:

```typescript
it('includes repoPath in metadata when profile has repoPath', async () => {
  const deps = makeDeps({
    getAgentProfile: vi.fn().mockResolvedValue({
      ...baseProfile,
      repoUrl: undefined,
      repoPath: '/home/mk/Projects/my-app',
    }),
  });
  const wo = await assembleWorkOrder(baseJobData, deps);
  expect(wo.metadata['repoPath']).toBe('/home/mk/Projects/my-app');
  expect(wo.repoUrl).toBe('');
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/agent-worker && npx vitest run tests/work-order-assembler.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-worker/src/work-order-assembler.ts packages/agent-worker/tests/work-order-assembler.test.ts
git commit -m "feat(agent-worker): update AgentProfile for config-driven repos and auth"
```

---

### Task 8: Wire config into agent worker startup

**Files:**
- Modify: `packages/agent-worker/src/index.ts`

- [ ] **Step 1: Replace hardcoded profile with config-driven getAgentProfile**

Update `packages/agent-worker/src/index.ts`. Replace the hardcoded `getAgentProfile` in `startAgentWorker`:

Add config loading to `StartWorkerOptions`:

```typescript
export interface StartWorkerOptions {
  redisUrl?: string;
  serverUrl: string;
  concurrency?: number;
  assemblerDeps?: AssemblerDeps;
  getCardDetails?: (cardId: string) => Promise<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    labels: string[];
  }>;
  /** Agent profiles from ouija.config.yaml — replaces hardcoded profile. */
  agentProfiles?: Map<string, import('./work-order-assembler.js').AgentProfile>;
}
```

Replace the hardcoded `getAgentProfile` in the assemblerDeps construction:

```typescript
const assemblerDeps: AssemblerDeps = options.assemblerDeps ?? {
  getAgentProfile: async (agentId: string) => {
    if (options.agentProfiles) {
      return options.agentProfiles.get(agentId);
    }
    // Fallback: single hardcoded profile for backwards compatibility
    return {
      id: 'rex-coder',
      name: 'Rex Coder',
      systemPrompt: 'You are an expert software engineer. Write clean, well-tested code.',
      secretRef: 'env:ANTHROPIC_API_KEY',
      model: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514',
      maxDurationMs: 1_800_000,
      repoUrl: process.env['DEFAULT_REPO_URL'] ?? '',
      baseBranch: process.env['DEFAULT_BASE_BRANCH'] ?? 'main',
      triggerMode: 'auto' as const,
    };
  },
  getCardDetails: options.getCardDetails ?? (async (cardId: string) => ({
    title: `Card ${cardId}`,
    description: '',
    acceptanceCriteria: [],
    labels: [],
  })),
  serverBaseUrl: options.serverUrl,
  issueJwt: issueAgentJWT,
};
```

- [ ] **Step 2: Verify build**

Run: `cd packages/agent-worker && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run existing tests**

Run: `cd packages/agent-worker && npx vitest run`
Expected: All tests PASS (backwards-compatible — existing tests don't pass `agentProfiles`).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-worker/src/index.ts
git commit -m "feat(agent-worker): accept config-driven agent profiles via StartWorkerOptions"
```

---

### Task 9: Handle `card_assigned` in the orchestrator for agent dispatch

**Files:**
- Modify: `packages/engine/src/orchestrator.ts`
- Modify: `packages/engine/tests/orchestrator.test.ts`

This is the core logic change. When a card is assigned to an agent member:
- Look up the agent by Plane member ID via the registry
- If `triggerMode: auto` → convert to `card_moved` trigger and dispatch immediately
- If `triggerMode: manual` → store the assignment, wait for column move

- [ ] **Step 1: Add AgentMemberLookup interface to orchestrator**

In `packages/engine/src/orchestrator.ts`, add a minimal interface (no dependency on `@ouija/config`):

```typescript
/** Injected by the server — maps Plane member IDs to agent IDs. */
export interface AgentMemberLookup {
  /** Returns ouija agent ID for a Plane member ID, or undefined if not an agent. */
  getAgentIdByMemberId(memberId: string): string | undefined;
  /** Returns 'auto' or 'manual' for the agent's trigger mode. */
  getTriggerMode(agentId: string): 'auto' | 'manual' | undefined;
}

/** Null implementation for backwards compatibility. */
export const nullAgentMemberLookup: AgentMemberLookup = {
  getAgentIdByMemberId: () => undefined,
  getTriggerMode: () => undefined,
};
```

- [ ] **Step 2: Inject AgentMemberLookup into Orchestrator constructor**

Update the constructor:

```typescript
constructor(
  private readonly db: Database,
  private readonly eventBus: EventBus,
  private readonly jobQueue: JobQueue,
  private readonly kanbanPlugin: KanbanPlugin,
  private readonly logger: OrchestratorLogger = noopLogger,
  private readonly agentMemberLookup: AgentMemberLookup = nullAgentMemberLookup,
) {}
```

- [ ] **Step 3: Update `_buildTrigger` for `kanban.card.assigned`**

Replace the `kanban.card.assigned` case in `_buildTrigger`:

```typescript
case 'kanban.card.assigned': {
  const payload = event.payload as { cardId: CardId; assigneeId: string };
  const agentId = this.agentMemberLookup.getAgentIdByMemberId(payload.assigneeId);

  if (agentId === undefined) {
    // Not an agent member — ignore assignment
    this.logger.info('card_assigned: assignee is not an agent, skipping', {
      assigneeId: payload.assigneeId,
    });
    return undefined;
  }

  const triggerMode = this.agentMemberLookup.getTriggerMode(agentId);

  if (triggerMode === 'auto') {
    // Auto mode: convert to card_moved trigger to dispatch immediately.
    // Find the first dispatch_agent column mapping for this agent.
    const mapping = _config.columnMappings.find(
      (m) => m.action === 'dispatch_agent' && String(m.agentId ?? '') === agentId,
    );

    if (mapping === undefined) {
      this.logger.warn('card_assigned auto: no dispatch column mapping for agent', {
        agentId,
        boardId: instance.boardId,
      });
      return undefined;
    }

    const guardContext = await this._fetchGuardContext(payload.cardId);
    return {
      type: 'card_moved',
      cardId: payload.cardId,
      toColumnId: mapping.columnId,
      fromColumnId: makeColumnId(''),
      guardContext,
    };
  }

  // Manual mode: just record the assignment. Dispatch happens on column move.
  // Return card_assigned trigger so the transition function can handle it.
  return {
    type: 'card_assigned',
    cardId: payload.cardId,
    assigneeId: payload.assigneeId,
  };
}
```

- [ ] **Step 4: Write orchestrator test for auto-dispatch on assign**

Add to `packages/engine/tests/orchestrator.test.ts`:

```typescript
describe('card_assigned → auto dispatch', () => {
  it('dispatches agent when assigned to agent member with triggerMode auto', async () => {
    // Set up: board config with a dispatch column mapped to rex-coder
    const config: PipelineConfig = {
      boardId: boardId('board-1'),
      columnMappings: [
        {
          columnId: columnId('col-dispatch'),
          columnName: 'In Progress',
          action: 'dispatch_agent',
          agentId: agentId('rex-coder'),
          guards: [],
        },
      ],
      defaultStallThresholdMs: 300_000,
      autoStartOnAssign: true,
    };

    // Mock the registry
    const lookup: AgentMemberLookup = {
      getAgentIdByMemberId: (id) => id === 'plane-member-rex' ? 'rex-coder' : undefined,
      getTriggerMode: (id) => id === 'rex-coder' ? 'auto' : undefined,
    };

    // Wire orchestrator with lookup
    const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlugin, logger, lookup);

    // Save the config
    await db.boardConfigs.save(config);

    // Fire the card_assigned event
    const event: OuijaEvent<'kanban.card.assigned'> = {
      id: 'evt-1',
      topic: 'kanban.card.assigned',
      payload: {
        cardId: cardId('proj-1/issue-1'),
        assigneeId: 'plane-member-rex',
        assignedBy: 'human@example.com',
      },
      timestamp: new Date().toISOString(),
      sourcePlugin: '@ouija/plugin-plane',
      correlationId: 'corr-1',
    };

    await orchestrator.processTrigger(event);

    // Verify: pipeline created and transitioned to dispatching
    const instance = await db.pipelines.findByCardId(cardId('proj-1/issue-1'));
    expect(instance).toBeDefined();
    expect(instance!.state.status).toBe('dispatching');

    // Verify: agent dispatch job was enqueued
    expect(jobQueue.enqueue).toHaveBeenCalledWith(
      'agentDispatch',
      expect.objectContaining({
        agentId: 'rex-coder',
        cardId: 'proj-1/issue-1',
      }),
      expect.anything(),
    );
  });

  it('ignores assignment to non-agent member', async () => {
    const lookup: AgentMemberLookup = {
      getAgentIdByMemberId: () => undefined,
      getTriggerMode: () => undefined,
    };

    const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlugin, logger, lookup);

    const event: OuijaEvent<'kanban.card.assigned'> = {
      id: 'evt-2',
      topic: 'kanban.card.assigned',
      payload: {
        cardId: cardId('proj-1/issue-2'),
        assigneeId: 'human-user-id',
        assignedBy: 'other-human@example.com',
      },
      timestamp: new Date().toISOString(),
      sourcePlugin: '@ouija/plugin-plane',
      correlationId: 'corr-2',
    };

    await orchestrator.processTrigger(event);

    // Should not create a pipeline instance
    const instance = await db.pipelines.findByCardId(cardId('proj-1/issue-2'));
    expect(instance).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run orchestrator tests**

Run: `cd packages/engine && npx vitest run tests/orchestrator.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/orchestrator.ts packages/engine/tests/orchestrator.test.ts
git commit -m "feat(engine): orchestrator handles card_assigned with agent member lookup"
```

---

### Task 10: Add `getMembers` to PlaneApiClient

**Files:**
- Modify: `packages/plugin-plane/src/api-client.ts`

The `AgentMemberRegistry` needs to list workspace members. The Plane API client needs a `getMembers` method.

- [ ] **Step 1: Add getMembers method**

In `packages/plugin-plane/src/api-client.ts`, add:

```typescript
/**
 * List all members of a workspace.
 * GET /api/v1/workspaces/:workspaceSlug/members/
 */
async getMembers(
  workspaceSlug: string,
): Promise<PlaneMember[]> {
  const response = await this.get<{ results: PlaneMember[] } | PlaneMember[]>(
    `/workspaces/${workspaceSlug}/members/`,
  );
  if (Array.isArray(response)) {
    return response;
  }
  return response.results;
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/plugin-plane && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-plane/src/api-client.ts
git commit -m "feat(plugin-plane): add getMembers to PlaneApiClient"
```

---

### Task 11: Wire everything together in server startup

**Files:**
- Modify: `packages/server/src/index.ts`

This is the integration point. The server loads `ouija.config.yaml`, provisions Plane members, creates the `AgentMemberRegistry`, and passes it to both the orchestrator and agent worker.

- [ ] **Step 1: Add config loading after env validation**

After the existing env validation block in `main()`, add:

```typescript
// ---- Load ouija config (optional — falls back to env-var-driven defaults) ----
const configPath = process.env['OUIJA_CONFIG_PATH'] ?? 'ouija.config.yaml';
let ouijaConfig: import('@ouija/config').OuijaConfig | undefined;

try {
  const { loadConfig } = await import('@ouija/config');
  ouijaConfig = await loadConfig(configPath);
  console.info(`Loaded ouija config from ${configPath} — ${ouijaConfig.agents.length} agent(s) defined`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    console.info(`No ouija config found at ${configPath} — using env-var defaults`);
  } else {
    throw err; // Config exists but is invalid — fail fast
  }
}
```

- [ ] **Step 2: Provision Plane members after Plane plugin starts**

After the `await planePlugin.start()` line, add:

```typescript
// Provision agent Plane members if config is loaded
let agentRegistry: import('@ouija/config').AgentMemberRegistry | undefined;

if (ouijaConfig && planePluginInstance && planeWorkspaceSlug) {
  const { AgentMemberRegistry } = await import('@ouija/config');
  const registryPlaneClient = {
    getMembers: async (ws: string) => {
      const members = await planePluginInstance!.getMembers(ws);
      return members;
    },
    inviteMember: async (ws: string, email: string, role: number) => {
      return planePluginInstance!.inviteMember(ws, email, role);
    },
  };
  agentRegistry = new AgentMemberRegistry(
    ouijaConfig.agents,
    registryPlaneClient,
    planeWorkspaceSlug,
    {
      info: (msg, ctx) => console.info(JSON.stringify({ level: 'info', component: 'agent-registry', msg, ...ctx })),
      warn: (msg, ctx) => console.warn(JSON.stringify({ level: 'warn', component: 'agent-registry', msg, ...ctx })),
      error: (msg, ctx) => console.error(JSON.stringify({ level: 'error', component: 'agent-registry', msg, ...ctx })),
    },
  );
  await agentRegistry.provision();
  console.info('Agent Plane members provisioned');
}
```

Note: `PlanePlugin` does not currently expose `getMembers` and `inviteMember` — we need to add thin pass-through methods. Add to `packages/plugin-plane/src/index.ts`:

```typescript
/** Expose getMembers for agent registry provisioning. */
async getMembers(workspaceSlug?: string): Promise<import('./api-client.js').PlaneMember[]> {
  const slug = workspaceSlug ?? this.config.workspaceSlug;
  return this.client.getMembers(slug);
}

/** Expose inviteMember for agent registry provisioning. */
async inviteMember(
  workspaceSlug: string | undefined,
  email: string,
  role: 5 | 10 | 15 | 20 = 10,
): Promise<{ id: string; email: string; role: number }> {
  const slug = workspaceSlug ?? this.config.workspaceSlug;
  return this.client.createMember(slug, email, role);
}
```

- [ ] **Step 3: Pass agentRegistry to Orchestrator**

Update the orchestrator creation:

```typescript
const orchestrator = new Orchestrator(
  db, eventBus, jobQueue, kanbanPlugin, orchestratorLogger,
  agentRegistry ?? undefined,
);
```

- [ ] **Step 4: Build agent profile map and pass to worker**

Update the agent worker startup section:

```typescript
// Build agent profile map from config
let agentProfiles: Map<string, import('@ouija/agent-worker').AgentProfile> | undefined;

if (ouijaConfig) {
  const { AgentProfile } = await import('@ouija/agent-worker');
  agentProfiles = new Map();
  for (const agent of ouijaConfig.agents) {
    const defaultRepo = agent.repos.find((r) => r.default);
    agentProfiles.set(agent.id, {
      id: agent.id,
      name: agent.name,
      systemPrompt: agent.systemPrompt ?? '',
      secretRef: agent.auth.secretRef,
      model: agent.model,
      maxDurationMs: agent.limits.maxDurationMs,
      repoUrl: defaultRepo?.url,
      repoPath: defaultRepo?.path,
      baseBranch: defaultRepo?.baseBranch ?? 'main',
      triggerMode: agent.triggerMode,
      configDir: agent.configDir,
      authMethod: agent.auth.method,
    });
  }
}

const workerOpts: Parameters<typeof startAgentWorker>[0] = {
  redisUrl,
  serverUrl,
  concurrency: parseInt(process.env['OUIJA_WORKER_CONCURRENCY'] ?? '1', 10),
  agentProfiles,
};
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Full monorepo build succeeds.

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests PASS across all packages.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/index.ts packages/plugin-plane/src/index.ts
git commit -m "feat(server): wire config loading, Plane member provisioning, and agent registry"
```

---

### Task 12: Add example config file

**Files:**
- Create: `ouija.config.example.yaml`

- [ ] **Step 1: Write example config**

```yaml
# ouija.config.yaml — Agent configuration for self-hosted ouija.
#
# Copy this file to ouija.config.yaml and edit to match your setup.
# Set OUIJA_CONFIG_PATH env var to use a different location.

# claudeHome controls what the agent subprocess sees as ~/.claude/
#   null (default): inherit host HOME — agent sees your Claude Code config
#   "/path/to/dir": use as HOME for agent subprocesses
claudeHome: null

agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@ouija.local

    # Trigger mode:
    #   auto:   dispatch immediately when card is assigned to this agent
    #   manual: wait for card to be moved to the dispatch column
    triggerMode: auto

    model: claude-sonnet-4-20250514

    # System prompt — used when configDir is not set.
    # When configDir IS set, the .claude/CLAUDE.md in that dir takes precedence.
    systemPrompt: |
      You are an expert software engineer.
      Write clean, well-tested code. Follow existing project patterns.
      Create a pull request when your work is complete.

    # Optional: path to a directory containing .claude/ config (settings.json, CLAUDE.md).
    # Gives the agent MCP servers, custom tools, hooks, skills.
    # Test manually: cd <configDir> && claude
    # configDir: ./agents/rex-coder

    # Authentication for the Claude API.
    # Methods: api-key, bedrock, vertex, foundry, api-key-helper, proxy
    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY

    # Repos this agent can work on.
    # url: clone from remote (fresh each dispatch, destroyed after)
    # path: use existing local checkout (git worktree for isolation, fast)
    # Exactly one repo must have default: true.
    repos:
      - url: https://github.com/your-org/your-repo.git
        baseBranch: main
        default: true

      # Example: local repo (no clone, uses git worktree)
      # - path: /home/you/Projects/your-repo
      #   baseBranch: main
      #   default: true

    limits:
      maxDurationMs: 1800000     # 30 minutes
      stallThresholdMs: 300000   # 5 minutes
```

- [ ] **Step 2: Commit**

```bash
git add ouija.config.example.yaml
git commit -m "docs: add ouija.config.example.yaml with annotated agent configuration"
```

---

## Summary

| Task | What it builds | Key files |
|------|---------------|-----------|
| 1 | Package scaffold | `packages/config/` |
| 2 | Config types | `types.ts` |
| 3 | JSON Schema + validation | `schema.ts` + tests |
| 4 | YAML loader | `loader.ts` + tests |
| 5 | AgentMemberRegistry | `agent-member-registry.ts` + tests |
| 6 | Worktree workspace provisioning | `local-workspace.ts` |
| 7 | AgentProfile update | `work-order-assembler.ts` |
| 8 | Config-driven worker startup | `agent-worker/index.ts` |
| 9 | Orchestrator assign→dispatch | `orchestrator.ts` |
| 10 | Plane getMembers API | `api-client.ts` |
| 11 | Server wiring | `server/index.ts` |
| 12 | Example config | `ouija.config.example.yaml` |
