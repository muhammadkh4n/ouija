# Ouija Remote Execution Research

**Author:** Muhammad Khan + Claude
**Date:** 2026-04-02
**Status:** Research complete, pending design review
**Context:** Evolving Ouija from local-only agent execution to remote sandboxed execution for cloud SaaS

---

## 1. Current State

Ouija Phase 1 is complete (316 tests, 14,138 lines, 7 packages). Phase 2 (Telegram + Claude agent dispatcher) is done. The current agent execution model:

1. `AgentDispatchWorker` dequeues a job from BullMQ
2. `ClaudeAgentPlugin.dispatch()` fires-and-forgets `_runAgent()`
3. `_runAgent()`: tmpdir -> git clone -> create branch -> spawn `claude --print` as local child process -> heartbeat loop -> callback -> cleanup
4. Everything runs on the same machine as the Ouija server

This works for self-hosted deployments. For cloud SaaS, users cannot and should not provide compute. Ouija must provision sandboxed execution environments.

---

## 2. Problem Statement

For Ouija Cloud (ouija.dev), we need:
- Users connect their GitHub repos without providing infrastructure
- Agents execute in isolated, ephemeral environments
- Secrets (API keys, git tokens) are injected securely
- Ouija controls the sandbox lifecycle (provision, run, teardown)
- Cost attribution per user/org
- Security isolation between tenants

---

## 3. Competitive Landscape

### How Others Solve This

| Product | Execution Model | Sandbox | Compute | Open Source |
|---------|----------------|---------|---------|-------------|
| **Devin** | Cloud VM per task | Full VM isolation | Hosted only | No |
| **SWE-agent** | Docker container | Docker + constrained shell | BYOC | Yes |
| **OpenHands** | Docker + HTTP runtime server | Docker + HTTP boundary | BYOC + hosted | Yes |
| **Cursor/Windsurf** | Local process (IDE) | None (user shell) | Local only | No |
| **Copilot Coding Agent** | GitHub Actions/Codespaces | VM-level (Actions infra) | Hosted (GitHub) | No |
| **Codex (OpenAI)** | MicroVM (cloud) or local CLI | Firecracker-level | Both | CLI only |
| **Claude Code** | Local process (CLI) | None (permission prompts) | Local only | Yes (CLI) |

### Key Architectural Patterns From Competitors

1. **Brain/Hands Split** (SWE-agent): Orchestration loop runs host-side; code execution runs in container. Minimizes sandbox cost.

2. **HTTP Runtime Server in Container** (OpenHands): The sandbox runs an HTTP server. Controller communicates via structured HTTP requests, not `docker exec`. This is the most portable pattern -- sandbox can run locally or remotely.

3. **Network-Disabled by Default** (Codex): Sandboxed agents have no outbound network except explicitly allowlisted endpoints (package registries, callback URL). Prevents code exfiltration.

4. **Platform-Native Auth** (Copilot Agent): GitHub's agent has zero auth friction because it IS GitHub. For Ouija, we need GitHub App OAuth flow.

---

## 4. Sandbox Platform Evaluation

### 4.1 Comparison Table

| Dimension | E2B | Fly.io | Modal | Firecracker | Docker/Sysbox | Daytona | GitHub Codespaces | GitHub Actions |
|---|---|---|---|---|---|---|---|---|
| **Isolation** | Firecracker microVM | Full VM (KVM) | gVisor | Firecracker | User-namespace | Container + hardening | Full VM | VM per job |
| **Cold start** | ~150ms | <1s restart, ~12s create | Sub-second | 125ms | Milliseconds | 27-90ms | 30s-5min | 10-30s |
| **TS/JS SDK** | First-class | REST only | Beta | None | Docker API | First-class | REST + `gh` CLI | REST API |
| **Claude template** | Yes (pre-built) | No | No | No | No | Guides available | No | No |
| **Cost/agent-hour** | ~$0.10 | ~$0.045 | ~$0.12 | Infra only | Infra only | ~$0.17 | $0.36 (4-core) | $0.008/min |
| **Max session** | 24h (Pro) | Unlimited | 24h | Unlimited | Unlimited | Unlimited | Configurable | 6h hosted |
| **Free tier** | $100 credit | Legacy only | $30/mo | N/A | N/A | $200 credit | 120 core-hr/mo | 2000 min/mo |
| **Secret injection** | envs on create | config.env + vault | modal.Secret | Manual | Docker env | envVars on create | Secrets API | Repo secrets |
| **Ops overhead** | Minimal | Medium | Minimal | Very high | Medium | Minimal | Low | Low |
| **Multi-tenant ready** | Yes | Yes | Yes | Yes (build yourself) | Weak | Yes | Via user billing | Via repo owner |

### 4.2 Platform Deep Dives

#### E2B (Recommended Primary)

Purpose-built for AI agent sandboxing. Firecracker microVMs with ~150ms cold start.

```typescript
import { Sandbox } from 'e2b'

const sandbox = await Sandbox.create('claude', {
  envs: { ANTHROPIC_API_KEY: '...' },
  timeoutMs: 600_000,
})

// Clone and run agent
await sandbox.commands.run('git clone --depth 1 --branch main https://...')
await sandbox.commands.run('git checkout -b ouija/inst_abc123')

const result = await sandbox.commands.run(
  'claude --dangerously-skip-permissions -p "implement the feature..."',
  { onStdout: (data) => { /* heartbeat / stream */ } }
)

await sandbox.kill()
```

**Why E2B wins for Phase 2:**
- Pre-built `claude` template (Claude Code CLI already installed)
- API maps 1:1 to the current `_runAgent()` flow
- Hardware-level isolation (Firecracker) -- appropriate for multi-tenant
- TypeScript SDK is production-quality
- ~2-3 day implementation effort for a `RemoteClaudeAgentPlugin`

#### Daytona (Strong Alternative)

Fastest cold start (27-90ms), TypeScript-native SDK, official Claude Code integration guides.

```typescript
import { Daytona } from '@daytonaio/sdk'

const daytona = new Daytona({ apiKey: '...' })
const sandbox = await daytona.create({
  snapshot: 'ouija-agent',
  language: 'typescript',
  envVars: { ANTHROPIC_API_KEY: '...' },
  resources: { cpu: 2, memory: 4 },
})

const result = await sandbox.process.executeCommand('claude -p "..."')
await sandbox.delete()
```

**Advantages over E2B:** Faster cold start, unlimited sessions, $50k startup credit program.
**Disadvantages:** Newer/smaller company, less battle-tested API.

#### GitHub Codespaces (User-Billed Option)

Unique value: bills to the user's GitHub account (they bring their own compute).

**API flow:**
1. User authorizes Ouija GitHub App (OAuth)
2. Ouija creates codespace via `POST /repos/{owner}/{repo}/codespaces`
3. Execute via `gh codespace ssh` or devcontainer `postCreateCommand`
4. Destroy after completion

**Limitations:** No REST API for command execution (SSH only), 30s-5min cold start, user spending limits can block creation.

**Best for:** "Bring your own compute" tier where users pay GitHub directly.

#### GitHub Actions (Lowest Friction)

Deploy a reusable workflow, trigger via `workflow_dispatch`.

```yaml
# .github/workflows/ouija-agent.yml
name: ouija-agent
on:
  workflow_dispatch:
    inputs:
      instance_id: { required: true, type: string }
      branch: { required: true, type: string }
      prompt: { required: true, type: string }
      callback_url: { required: true, type: string }
      callback_token: { required: true, type: string }
jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code
      - run: echo "${{ inputs.prompt }}" | claude --print
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - run: git push origin ${{ inputs.branch }}
```

**Limitations:** 6-hour max (hosted), no run ID on dispatch (must poll), 25 input limit, workflow YAML must exist in target repo.

---

## 5. Architectural Gap Analysis

### 5.1 AgentPlugin Interface Gaps

The `AgentPlugin` interface (types/src/agent.ts) is well-abstracted at the contract level. The gaps are in what it doesn't express:

| Gap | Current | Needed |
|-----|---------|--------|
| Workspace lifecycle | Baked into `_runAgent()` | Separate `WorkspaceProvider` interface |
| Status states | `idle\|dispatching\|running\|completed\|failed\|cancelled` | Add `provisioning` and `teardown` |
| Environment metadata | None | Workspace ID, type, endpoint on `AgentStatus` |
| Execution environment spec | None | `workspaceSpec` on `WorkOrder` |
| Multiple secrets | Single `secretRef: string` | `secrets: Record<string, string>` map |
| Callback connectivity | Fixed `callbackUrl` (HTTP assumed) | Transport abstraction (HTTP/WS/queue) |

### 5.2 WorkOrder Type Gaps

```typescript
// Current WorkOrder -- local execution assumptions
interface WorkOrder {
  instanceId: string;
  repoUrl: string;        // Assumes agent can clone
  branch: string;         // Assumes agent can create branches
  secretRef: string;      // Single secret, unscoped
  callbackUrl: string;    // Assumes HTTP reachability
  maxDurationMs: number;  // No provisioning timeout
  // ...
}

// Extended for remote execution
interface WorkOrder {
  // ... existing fields ...
  workspaceSpec?: WorkspaceSpec;      // WHERE to run
  secrets: Record<string, string>;    // Multiple secret refs, scoped
  callbackTransport: CallbackTransportSpec; // HOW to report back
  provisionTimeoutMs?: number;        // Separate from agent timeout
  artifacts?: ArtifactSpec;           // Where to upload results
}
```

### 5.3 Heartbeat/Callback Gaps

| Gap | Impact | Fix |
|-----|--------|-----|
| HTTP-only callback | Remote agents behind NATs can't reach server | Transport abstraction (HTTP/WS/queue) |
| 30s hardcoded heartbeat | False stalls on remote agents with cold-start latency | Configurable per environment type |
| JWT refresh coupled to HTTP response | Breaks with non-HTTP transport | Decouple refresh channel |
| No log streaming for remote | Blind debugging | Separate log channel per workspace type |

### 5.4 Stall Monitor Gaps

| Gap | Impact | Fix |
|-----|--------|-----|
| Fixed threshold ignores provisioning | False stalls during VM boot | Start clock after `provisioning` -> `running` |
| Single missed heartbeat = stall | Network jitter triggers false alarm | Grace count (N consecutive misses) |
| No workspace cleanup on stall | Orphaned VMs/containers leak money | `destroy_workspace` side effect |
| Cancel doesn't destroy workspace | Same orphan problem | Wire workspace teardown into cancel path |

### 5.5 Security Gaps for Remote

| Gap | Current Code | Risk | Fix |
|-----|-------------|------|-----|
| API key from process.env | `process.env['ANTHROPIC_API_KEY']` (index.ts:236) | Server's key leaked to all tenants | `CredentialStore` with tenant-scoped resolution |
| No per-tenant credential scoping | Single `secretRef` | Tenant A uses Tenant B's key | Namespace-scoped credential resolution |
| No credential rotation mid-run | JWT refresh only for callbacks | Long runs with expired git tokens | Vault agent or credential proxy |
| JWT not bound to workspace | Claims: instanceId, boardId | Callback from destroyed workspace accepted | Add workspaceId to JWT claims |

---

## 6. New Abstractions Required

### 6.1 WorkspaceProvider (architectural keystone)

```typescript
interface WorkspaceProvider {
  readonly type: string; // 'local' | 'e2b' | 'codespace' | 'fly' | 'actions'

  /** Provision an execution environment. */
  provision(spec: WorkspaceSpec): Promise<Workspace>;

  /** Tear down. Must be idempotent. */
  destroy(workspaceId: string): Promise<void>;

  /** Check if workspace is alive. */
  healthCheck(workspaceId: string): Promise<WorkspaceHealth>;
}

interface WorkspaceSpec {
  repoUrl: string;
  branch: string;
  baseBranch: string;
  resources: { cpu?: number; memoryMb?: number; diskGb?: number };
  image?: string;             // Docker image or devcontainer ref
  secretRefs: Record<string, string>;
  provisionTimeoutMs: number;
}

interface Workspace {
  id: string;
  type: string;
  endpoint: string;           // Local path, SSH target, or API endpoint
  expiresAt?: string;
}
```

**Implementations:**
- `LocalWorkspaceProvider` -- wraps current tmpdir/clone/branch logic (refactor, not rewrite)
- `E2BWorkspaceProvider` -- provisions Firecracker microVMs via E2B SDK
- `CodespaceWorkspaceProvider` -- provisions GitHub Codespaces via REST API
- `ActionsWorkspaceProvider` -- triggers GitHub Actions workflow_dispatch

### 6.2 AgentRunner (decouples WHERE from HOW)

```typescript
interface AgentRunner {
  run(workspace: Workspace, workOrder: WorkOrder, options: RunOptions): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
}

interface AgentRunResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  logs?: string;
}
```

**Implementations:**
- `LocalCliRunner` -- wraps current `spawnClaude()` (subprocess.ts)
- `RemoteCliRunner` -- runs commands via E2B SDK / SSH / workspace API

### 6.3 CallbackTransport

```typescript
interface CallbackTransport {
  send(payload: CallbackPayload): Promise<void>;
  startHeartbeat(intervalMs: number): void;
  stopHeartbeat(): void;
  close(): Promise<void>;
}
```

**Implementations:**
- `HttpCallbackTransport` -- current HeartbeatReporter
- `WebSocketCallbackTransport` -- for persistent connections
- `QueueCallbackTransport` -- publishes to Redis/NATS (for agents that can't reach HTTP)

### 6.4 CredentialStore

```typescript
interface CredentialStore {
  /** Resolve a secret ref for a specific tenant. */
  resolve(tenantId: string, secretRef: string): Promise<string>;

  /** Issue short-lived credentials that expire with the workspace. */
  issueEphemeral(tenantId: string, secretRef: string, ttlMs: number): Promise<string>;

  /** Revoke credentials issued for a workspace. */
  revoke(workspaceId: string): Promise<void>;
}
```

---

## 7. Recommended Implementation Strategy

### Phase 2a: Refactor for Extensibility (1-2 weeks)

**Goal:** Introduce `WorkspaceProvider` and `AgentRunner` abstractions without changing behavior. Current local execution wrapped in new interfaces.

1. Add `provisioning` and `teardown` to `AgentStatusState`
2. Define `WorkspaceProvider`, `AgentRunner`, `CallbackTransport` interfaces in `packages/types`
3. Implement `LocalWorkspaceProvider` (extract from `_runAgent`)
4. Implement `LocalCliRunner` (extract from `spawnClaude` + `_runAgent`)
5. Refactor `ClaudeAgentPlugin._runAgent()` to use the new abstractions
6. Existing tests pass with zero behavior change

### Phase 2b: E2B Remote Execution (1-2 weeks)

**Goal:** First remote agent execution via E2B Firecracker sandboxes.

1. Create `packages/workspace-e2b` with `E2BWorkspaceProvider`
2. Create `RemoteCliRunner` that uses E2B SDK's `sandbox.commands.run()`
3. Create `plugin-agent-claude-remote` (or extend `plugin-agent-claude` with strategy pattern)
4. Configure via `ouija.config.yaml`:
   ```yaml
   plugins:
     - module: "@ouija-dev/plugin-agent-claude"
       config:
         executionMode: remote       # 'local' | 'remote'
         remoteProvider: e2b
         e2b:
           apiKey: "${E2B_API_KEY}"
           template: claude
           resources:
             cpu: 2
             memoryMb: 4096
   ```
5. Integration tests against E2B (requires API key)
6. Stall monitor adapts thresholds for remote provisioning time

### Phase 2c: GitHub Codespaces (1-2 weeks)

**Goal:** "Bring your own compute" option where users bill GitHub directly.

1. Implement GitHub App OAuth flow in `packages/server`
2. Create `CodespaceWorkspaceProvider` using GitHub REST API
3. Handle Codespace lifecycle: create -> SSH exec -> stop -> delete
4. User token storage with refresh mechanism
5. Configure per-project (some repos use E2B, some use user's Codespaces)

### Phase 2d: GitHub Actions (1 week)

**Goal:** Lowest-friction option for GitHub-centric users.

1. Create reusable workflow YAML in an Ouija-owned repo
2. `ActionsWorkspaceProvider` triggers `workflow_dispatch`
3. Handle the "no run ID on dispatch" problem (poll with dedup)
4. Agent reports back via callback URL from within the action

### Phase 3: CredentialStore + Multi-Tenant (2-3 weeks)

**Goal:** Tenant-scoped credential management for SaaS.

1. Build `CredentialStore` with envelope encryption (KMS)
2. Tenant-scoped secret resolution
3. Ephemeral credential issuance tied to workspace lifetime
4. Credential cleanup on workspace destroy
5. Audit logging for all credential access

---

## 8. Architecture Diagram (Target State)

```
                    [ Ouija Server ]
                    /       |       \
              Dashboard   API    Webhook Ingress
                          |
                    [ Orchestrator ]
                    /       |       \
             [ EventBus ] [ Engine ] [ CredentialStore ]
                            |               |
                    [ AgentDispatchWorker ]  |
                            |               |
                    [ AgentPlugin ]         |
                      dispatch(workOrder)   |
                            |               |
                    ┌───────┴────────┐      |
                    |                |      |
            [ WorkspaceProvider ]   [ AgentRunner ]
            /       |       \            |
         Local    E2B    Codespace   LocalCLI / RemoteCLI
         (tmpdir) (Firecracker)  (GitHub API)    |
                    |                            |
              ┌─────┴─────┐                      |
              |           |                      |
         [ Sandbox ]  [ Sandbox ]         [ claude --print ]
         (tenant A)   (tenant B)          (inside sandbox)
              |           |                      |
              └─────┬─────┘                      |
                    |                            |
              [ CallbackTransport ] ←────────────┘
              /         |         \
           HTTP      WebSocket    Queue
```

---

## 9. Cost Projections

### Per-Agent-Run Cost (assuming 30-minute average run)

| Provider | Cost/Run | 1000 runs/mo | Notes |
|----------|----------|-------------|-------|
| **Local (self-hosted)** | $0 | $0 | User provides compute |
| **E2B** | ~$0.05 | ~$50 | 2 vCPU, Firecracker |
| **Fly.io** | ~$0.023 | ~$23 | 1 perf CPU, need own image |
| **Daytona** | ~$0.085 | ~$85 | 2 vCPU, fastest cold start |
| **GitHub Actions** | ~$0.24 | ~$240 | ubuntu-latest, per-minute |
| **GitHub Codespaces** | ~$0.18 | ~$180 | 4-core, user-billed option |

### Pricing Implications for Ouija SaaS

At $0.05/run (E2B), with Builder tier at $29/mo for 1,000 runs:
- Infrastructure cost: ~$50
- Per-run margin at $29: negative (-$21)
- Per-run margin at $99 (Team): positive (+$49)

**Conclusion:** E2B pricing works for Team/Enterprise tiers. For Builder tier, either absorb the loss as user acquisition cost, or use a cheaper provider (Fly.io) and accept higher ops overhead.

---

## 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| E2B service outage blocks all remote execution | Medium | High | Implement fallback to Fly.io or local Docker |
| Sandbox escape (agent breaks out of Firecracker) | Very Low | Critical | E2B/Fly handle this; not our responsibility for managed platforms |
| Network partition: agent can't reach callback | Medium | Medium | Grace count on stall detection, workspace healthCheck as secondary signal |
| Cost overrun from orphaned sandboxes | Medium | High | Aggressive TTL, periodic orphan scanner, workspace spend alerts |
| GitHub API rate limits block Codespace creation | Low | Medium | Token bucket with backoff, multiple GitHub App installations |
| User's Codespace spending limit reached | Medium | Low | Graceful error, suggest E2B fallback |
| Prompt injection from inside sandbox | High | Medium | Network egress restriction, output validation on PR diffs (already in design spec) |

---

## 11. Decision Log

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Primary remote platform | E2B | Fly.io, Modal, Daytona, Firecracker | Pre-built Claude template, best DX, hardware isolation, competitive cost |
| Secondary platform | GitHub Codespaces | GitHub Actions | "Bring your own compute" tier, user-billed |
| Fallback platform | GitHub Actions | Fly.io | Lowest friction, no custom images needed |
| Abstraction approach | WorkspaceProvider + AgentRunner | Extend `_spawnFn` pattern | Clean separation of WHERE and HOW, testable, composable |
| Credential management | Tenant-scoped CredentialStore | Process env (current) | Required for multi-tenant SaaS, audit compliance |
| Callback mechanism | Transport abstraction | HTTP-only (current) | Remote agents may not have HTTP egress |

---

## 12. Open Questions

1. **Should self-hosted users get remote execution?** If a user self-hosts Ouija but wants sandboxed execution, should they provide their own E2B API key? Or is remote execution SaaS-only?

2. **Agent model flexibility:** The current `plugin-agent-claude` is Claude-specific. For remote sandboxes, should we support other agents (GPT-4, Codex, open-source models) via the same workspace infrastructure?

3. **Workspace pooling:** For cold-start optimization, should we maintain a pool of pre-provisioned sandboxes? This burns money on idle resources but reduces dispatch latency from seconds to milliseconds.

4. **PR creation from sandbox:** Currently the design spec says agents create PRs. In a remote sandbox, should the agent push and create the PR, or should it push to the branch and let Ouija's server create the PR (keeping GitHub App token on the server side)?

5. **Devcontainer support:** Should Ouija respect a project's `.devcontainer/devcontainer.json` for environment setup? This would let projects define their own toolchain requirements.
