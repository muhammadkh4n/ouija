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
| `runner` | `string` | No | `local` *(deprecated)*, `stream-json`, `sdk` | Which runner implementation to use. Defaults to `stream-json` when unset. `local` is deprecated in v0.4.0 and will be removed in v0.5.0 — migrate to `stream-json`. See [Runners](#runners) below. |

### Runners

Ouija ships three agent runners. Each one controls **how** the `claude`
binary is invoked for a dispatch, which determines whether you get
structured events back and whether you bill against a subscription or
API tokens.

| Runner | What it spawns | Structured events | Auth source | Cost model |
|---|---|---|---|---|
| `local` *(deprecated v0.4.0 — removal in v0.5.0)* | `claude -p <prompt> --output-format text` | ❌ text only | `~/.claude/` session *(no `ANTHROPIC_API_KEY` in env)* or API key *(when set)* | **Subscription** by default — flat-rate Pro/Max. |
| `stream-json` *(default)* | `claude -p --input-format stream-json --output-format stream-json --verbose` with the prompt on stdin | ✅ assistant text, tool calls, cost, turn count | Same as `local` — it's the same binary | **Subscription** by default — same as `local`, plus dashboard visibility. |
| `sdk` | `@anthropic-ai/claude-agent-sdk`'s `query()` | ✅ via the SDK's message protocol | **API key only** — the SDK does NOT read `~/.claude/` session credentials | **Per-token API billing**. Use this for Bedrock, Vertex, Foundry, Proxy, or when you want metered Anthropic usage. |

**Default:** `stream-json`. Subscription billing *and* structured events
out of the box.

### Deprecation: `runner: local` (removal in v0.5.0)

`runner: local` is deprecated as of **v0.4.0** and will be **removed in
v0.5.0**. The text-mode runner cannot emit the structured events Ouija
needs to enforce Tenet 3 (positive evidence of work) — a zero-progress
dispatch under `local` looks identical to a successful one, which is the
exact silent-failure class v0.4.0 was built to eliminate.

**Why you see this warning:**
```
(node:XXX) [OUIJA_LOCAL_RUNNER_DEPRECATED] DeprecationWarning: Agent "<id>":
runner: 'local' is deprecated and will be removed in v0.5.0...
```

**Migration path:**
- Change `runner: local` → `runner: stream-json` in your
  `ouija.config.yaml`. **No other change is required.** Subscription auth
  (your Claude Pro/Max session) still works unchanged — `stream-json`
  invokes the same `claude` binary, just with structured I/O.
- You gain structured events in the dashboard (assistant text, tool calls,
  cost per turn, `DispatchOutcome` positive-evidence checks).
- If you were running `local` because `stream-json` regressed at some point,
  please open an issue — it's been the default since v0.3.0 and is the
  primary tested path.

**Suppressing the warning during migration:**

If you need to run on `local` while you plan the swap, set the env var:

```
OUIJA_ALLOW_LOCAL_RUNNER=1
```

This suppresses the startup deprecation warning but does **not** extend
support — `runner: local` will still stop working when v0.5.0 lands.

**When to pick `sdk`:**
- You want to bill against the Anthropic API, Bedrock, Vertex, Foundry, or a proxy
- You're running Ouija as a shared service where session auth doesn't apply
  (SaaS deployments, multi-tenant setups)
- You need the SDK's specific cost tracking and conversation-shape guarantees

**Cannot have:** structured events with `local`, or subscription billing with `sdk`. The first requires stream-json mode; the second requires the interactive binary.

### Billing and auth

Ouija's self-hosted billing story is **built on the Claude CLI's session auth**.
When the `local` or `stream-json` runner dispatches and `ANTHROPIC_API_KEY`
is **not** set in the environment, the subprocess reads
`~/.claude/.credentials.json` just like a normal `claude` command would —
which means every dispatch bills against your Claude Pro or Max
subscription. **Flat rate. No per-dispatch API spend.**

This is intentional. It's the single biggest cost advantage Ouija has
over every other AI-in-CI tool, all of which are API-billed.

To use API billing instead:

1. Set `auth.method: api-key` (or `bedrock`, `vertex`, `foundry`, `proxy`) in the agent profile.
2. Provide the secret via `auth.secretRef` (e.g. `env:ANTHROPIC_API_KEY`).
3. The plugin injects the key into the subprocess env, which overrides session auth inside the `claude` binary.

Alternatively, set `runner: sdk` — the SDK *only* supports API-key billing
and will fail fast if no key is present, so there's no risk of silently
falling back to session auth.

**SaaS deployments must use API billing.** Anthropic's Pro/Max
subscriptions are per-user and non-transferable. If you operate Ouija
for customers other than yourself, you cannot share your subscription
across tenants — use `runner: sdk` with a BYOK (bring-your-own-key) or
pooled API-billing model.

**How to tell which mode you're in:**
- Look at the logs. The plugin emits `Runner constructed: <type>` on first use.
- Check `~/.claude/.credentials.json` — if it exists and you haven't set `ANTHROPIC_API_KEY`, you're on subscription.
- After a dispatch, query the pipeline detail view: the `cost` field reflects what Claude charged. For subscription runs this comes out of your flat-rate allowance; for API runs it comes out of your Anthropic balance.

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
npx @ouija-dev/cli down && npx @ouija-dev/cli up
```

The restart is fast (<5 seconds) because migrations are already applied and
Plane member provisioning is idempotent.
