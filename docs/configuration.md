# Configuration Reference

Ouija is configured by a single YAML file, `ouija.config.yaml`, loaded on
startup. The file's location can be overridden with the `OUIJA_CONFIG_PATH`
environment variable.

This document is the authoritative reference for every field. The source of
truth is [`packages/config/src/types.ts`](../packages/config/src/types.ts) —
if the docs disagree, the types win.

---

## Top-level shape

```yaml
claudeHome: null                  # string | null
agents:                           # AgentProfileConfig[] — at least one required
  - id: rex-coder
    # ... agent fields ...
boards:                           # BoardConfig[] — optional
  - projectId: "..."
    # ... board fields ...
```

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `claudeHome` | `string \| null` | No | `null` | Override `HOME` for the `claude` subprocess (controls which `~/.claude/` it sees). `null` means inherit the Ouija server's `HOME`. |
| `agents` | `AgentProfileConfig[]` | **Yes** | — | One or more agent profiles. At least one is required. |
| `boards` | `BoardConfig[]` | No | `[]` | Board-to-action mappings. If omitted, you must create board configs via the REST API or accept the auto-generated defaults. |

---

## Agent profile (`AgentProfileConfig`)

```yaml
agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@example.com
    kanbanUserId: "42"              # optional
    avatar: https://.../rex.png     # optional
    triggerMode: auto
    model: claude-sonnet-4-20250514
    systemPrompt: |
      You are an expert software engineer...
    configDir: ./agents/rex-coder   # optional
    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY
    repos:
      - url: https://github.com/org/repo.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 1800000
      stallThresholdMs: 300000
```

### Identity

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `id` | `string` | **Yes** | Stable identifier. Referenced by `boards[].columns[].agentId`. Keep it short and slug-like. |
| `name` | `string` | **Yes** | Human-readable display name. |
| `email` | `string` | **Yes** | The email Ouija uses to match this agent with a kanban user. For Plane, Ouija provisions a workspace member with this email at boot. |
| `kanbanUserId` | `string` | No | Pre-mapped kanban user ID. **Required for Fizzy** (no programmatic user creation). For Plane, omit this — agents are matched by email. |
| `avatar` | `string (URL)` | No | Profile picture URL shown in Plane/Fizzy. |

### Execution mode

| Field | Type | Required | Values | Purpose |
|-------|------|----------|--------|---------|
| `triggerMode` | `string` | **Yes** | `auto`, `manual` | `auto` dispatches immediately when a card is assigned. `manual` stores the assignment and waits for the card to enter a `dispatch_agent` column. |
| `model` | `string` | **Yes** | any Claude model ID | Passed through to the Claude CLI. Example: `claude-sonnet-4-20250514`, `claude-opus-4-20250514`. |

### Prompt and Claude config

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `systemPrompt` | `string` | No* | The system prompt prepended to every dispatch. Supports multiline YAML strings. |
| `configDir` | `string` | No* | Path to a directory containing a `.claude/` folder (settings.json, CLAUDE.md, MCP servers, hooks, skills). At dispatch time, Ouija assembles this into the workspace so the agent inherits your custom tooling. **Test it manually first:** `cd <configDir> && claude`. |

\* Exactly one of `systemPrompt` or `configDir` should be set. If `configDir`
is provided, the `.claude/CLAUDE.md` inside it takes precedence over
`systemPrompt`.

### Auth (`AuthConfig`)

```yaml
auth:
  method: api-key
  secretRef: env:ANTHROPIC_API_KEY
```

| Method | What it does | `secretRef` format |
|--------|--------------|--------------------|
| `api-key` | Sets `ANTHROPIC_API_KEY` from the secret source | `env:VAR_NAME` |
| `bedrock` | Enables `CLAUDE_CODE_USE_BEDROCK=1`; relies on AWS env vars / IAM role | `env:VAR_NAME` (usually unused — AWS SDK picks up credentials automatically) |
| `vertex` | Enables `CLAUDE_CODE_USE_VERTEX=1`; relies on `GOOGLE_APPLICATION_CREDENTIALS` | `env:VAR_NAME` |
| `foundry` | Enables Anthropic Foundry usage-based billing | `env:ANTHROPIC_AUTH_TOKEN` |
| `api-key-helper` | Uses a helper script that prints an API key to stdout | `path:/absolute/path/to/helper.sh` |
| `proxy` | Routes via a custom HTTPS proxy | `env:ANTHROPIC_BASE_URL` |

The `secretRef` uses a prefix-based resolver:

- `env:VAR_NAME` — read from the Ouija server's environment
- `path:/abs/path` — read contents of a file (for api-key-helper)

### Repos

```yaml
repos:
  - url: https://github.com/org/repo.git
    baseBranch: main
    default: true
  - url: https://github.com/org/other-repo.git
    baseBranch: develop
    projectId: "<plane-project-uuid>"     # route cards from this project to this repo
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `url` | `string` | One of `url`/`path` | HTTPS or SSH git URL. Fresh clone each dispatch, destroyed after. |
| `path` | `string` | One of `url`/`path` | Absolute path to an existing local checkout. Ouija creates a git worktree for isolation — much faster than clone. |
| `baseBranch` | `string` | **Yes** | Branch to base feature branches on (e.g. `main`, `develop`). |
| `default` | `boolean` | No | Exactly one repo per agent must be marked `default: true`. Used when the card does not map to a specific repo. |
| `projectId` | `string` | No | Plane project UUID. When set, cards from this project route to this repo. Enables one agent working on multiple repos. |

**URL vs path trade-off:**
- `url`: Isolated per dispatch. Slow for large repos. Always fresh. Use this for SaaS or when multiple dispatches run in parallel.
- `path`: Uses git worktree. Fast. Changes in the checkout are visible (be careful with uncommitted work). Use this for personal dogfooding.

### Limits

```yaml
limits:
  maxDurationMs: 1800000      # 30 minutes
  stallThresholdMs: 300000    # 5 minutes
```

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `maxDurationMs` | `number` | **Yes** | — | Hard wall-clock limit for one dispatch. Subprocess is SIGTERM'd, then SIGKILL'd 5s later. |
| `stallThresholdMs` | `number` | No | 300000 | If no heartbeat is received for this long, the stall monitor marks the pipeline as `stalled` and cleans up. Raise this for slow provisioning paths. |

---

## Board config (`BoardConfig`)

Board configs map kanban columns to pipeline actions. You can set them here
(recommended) or seed them via the REST API.

```yaml
boards:
  - projectId: "plane-project-uuid-here"
    autoStartOnAssign: true
    defaultStallThresholdMs: 600000
    columns:
      - name: In Progress
        action: dispatch_agent
        agentId: rex-coder
      - name: In Review
        action: noop
      - name: Done
        action: close_and_notify
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `projectId` | `string` | One of these | Plane project UUID. Use this for the Plane backend. |
| `boardId` | `string` | One of these | Fizzy board ID. Use this for the Fizzy backend. |
| `autoStartOnAssign` | `boolean` | No | When `true`, assigning a card to an agent is enough to start the pipeline — you don't have to also move it to a dispatch column. Pairs with `triggerMode: auto`. |
| `defaultStallThresholdMs` | `number` | No | Override the agent's stall threshold for this board. |
| `columns` | `BoardColumnConfig[]` | **Yes** | Column-to-action mappings. Columns not listed default to `action: noop`. |

### Columns (`BoardColumnConfig`)

```yaml
columns:
  - name: In Progress
    action: dispatch_agent
    agentId: rex-coder
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | `string` | **Yes** | Column display name. Matched case-insensitively against the kanban state. |
| `action` | `string` | **Yes** | One of `dispatch_agent`, `close_and_notify`, `noop`. |
| `agentId` | `string` | When `action: dispatch_agent` | The `id` of an agent defined in `agents[]`. |

**Actions:**

| Action | What happens |
|--------|--------------|
| `dispatch_agent` | Enqueue a dispatch job for the named agent. Pipeline transitions `idle → dispatching → running → ...`. |
| `close_and_notify` | Mark the pipeline as closed, fire notification plugins (e.g. Telegram), and record the final state. |
| `noop` | Log the transition for observability but take no action. |

---

## Examples

### Minimal — one agent, one repo, auto-trigger

```yaml
claudeHome: null
agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@example.com
    triggerMode: auto
    model: claude-sonnet-4-20250514
    systemPrompt: |
      Implement the task in the issue description. Open a PR when done.
    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY
    repos:
      - url: https://github.com/my-org/my-repo.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 1800000

boards:
  - projectId: "abc-123-plane-project-uuid"
    autoStartOnAssign: true
    columns:
      - name: In Progress
        action: dispatch_agent
        agentId: rex-coder
      - name: Done
        action: close_and_notify
```

### Multi-repo — one agent handling two projects

```yaml
agents:
  - id: rex-coder
    # ... auth, prompt, etc ...
    repos:
      - url: https://github.com/my-org/frontend.git
        baseBranch: main
        default: true
        projectId: "frontend-plane-uuid"
      - url: https://github.com/my-org/backend.git
        baseBranch: main
        projectId: "backend-plane-uuid"

boards:
  - projectId: "frontend-plane-uuid"
    columns:
      - name: In Progress
        action: dispatch_agent
        agentId: rex-coder
  - projectId: "backend-plane-uuid"
    columns:
      - name: In Progress
        action: dispatch_agent
        agentId: rex-coder
```

### Bedrock-backed agent

```yaml
agents:
  - id: bedrock-rex
    name: Rex on Bedrock
    email: rex@example.com
    triggerMode: auto
    model: claude-sonnet-4-20250514
    systemPrompt: |
      ...
    auth:
      method: bedrock
      secretRef: env:AWS_REGION     # Bedrock reads AWS creds from the environment
    repos:
      - url: https://github.com/my-org/my-repo.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 1800000
```

Set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` in `.env`
(or rely on an IAM role if Ouija runs on an EC2/ECS instance).

### Manual trigger with a staging column

```yaml
agents:
  - id: rex-coder
    triggerMode: manual             # assignment alone does nothing
    # ... rest ...

boards:
  - projectId: "..."
    autoStartOnAssign: false
    columns:
      - name: Ready for Agent       # human reviews first, then moves here
        action: dispatch_agent
        agentId: rex-coder
      - name: In Progress           # agent work happens here
        action: noop
      - name: Done
        action: close_and_notify
```

---

## Validation

Ouija validates the config at boot using a JSON Schema. Bad configs fail
fast with a structured error. To validate manually without starting the
server:

```bash
node -e "
const { loadConfig } = require('./packages/config/dist');
loadConfig('./ouija.config.yaml').then(c => console.log('OK:', c.agents.length, 'agents'));
"
```

---

## Changing config at runtime

Ouija does not hot-reload. To apply changes:

```bash
docker compose -f docker/docker-compose.ouija.yml restart ouija
```

The restart is fast (<5 seconds) because migrations are already applied and
Plane member provisioning is idempotent.
