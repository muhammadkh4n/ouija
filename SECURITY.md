# Security Policy

## Reporting a vulnerability

Email **subscriptions@mkweb.dev** with a description, reproduction steps, and the affected version. We will acknowledge within 72 hours and coordinate a disclosure timeline. Do not open a public GitHub issue for vulnerabilities — the codebase is self-hosted and any disclosure may put existing installs at risk.

PGP welcome but not required; plain email is fine.

## Threat model — self-hosted Ouija

Ouija is a self-hosted service that runs an AI coding agent (Claude Code CLI) against a git repository in response to kanban card transitions. The agent has write access to the repo and — via the gh credential helper on the host — to GitHub itself. Treat Ouija as you would any system that can execute code on your behalf.

### Trust assumptions

Ouija assumes that **every human who can move a card in your kanban (Plane / Fizzy) board is authorised to run code on the Ouija host under the host user's identity.**

In particular:
- **Card title + description** become part of the agent's prompt. An attacker with card-write access can attempt prompt injection.
- The agent runs with `--dangerously-skip-permissions`, meaning tool calls (file writes, shell commands, network requests) execute without confirmation.
- The agent inherits `HOME` from the server process, so it can read the host user's dotfiles (`~/.ssh/`, `~/.gitconfig`, `~/.config/gh/`, `~/.aws/`, etc).
- The agent can `gh pr create` on any repo the host user's `gh` token can access — not just the configured target repo.

**Net effect:** card-write access is roughly equivalent to shell access on the Ouija host. Restrict Plane/Fizzy project membership accordingly. If your kanban has a public intake or allows non-trusted users to comment/create cards, you must either run Ouija on a dedicated host per trust boundary, or wait for the multi-tenant SaaS tier (see "Roadmap" below).

### Defence-in-depth layers (current)

1. **Sanitizer** (`@ouija-dev/engine/sanitizer`). Every card description is scanned for:
   - HTML comments (stripped)
   - Shell metacharacters (`$(...)`, backticks with shell commands, `| bash`, `&& curl`, `>/path/x`, env-var refs, base64-piped-to-shell)
   - Workflow-file references (`.github/workflows/`, `Jenkinsfile`, etc.)
   - Secret-file references (`.env`, `id_rsa`, `credentials.json`, `.pem`, service account keys)
   - Suspicious (non-allowlisted) URLs
   - Content over 50 KB
   
   By default, **any of shell_metachar / workflow_file / secret_file / suspicious_url blocks dispatch**. The orchestrator drops the event and the webhook still returns 200 (so an attacker probing for injection gets no feedback). Configurable per-agent via `blockOnCategories: []` for trusted-author single-user deployments.

2. **HTML-to-text strip.** The sanitizer's `stripHtmlTags: true` default removes HTML tags and decodes entities before the description reaches the agent prompt. `<img onerror="..."`, `<script>`, attribute-smuggled payloads never survive into the prompt.

3. **Webhook HMAC verification.** All Plane and GitHub webhooks require a valid `X-Plane-Signature` / `X-Hub-Signature-256` HMAC against the configured secret. Unsigned or bad-signature webhooks are rejected before any processing.

4. **Environment variable allowlist.** Subprocesses do not inherit the full server `process.env`. Only `PATH`, `HOME`, `TMPDIR`, `SHELL`, `LANG`, `LC_ALL`, `USER`, `TERM`, `NODE_ENV` are forwarded — plus explicitly caller-provided env vars (e.g. `ANTHROPIC_API_KEY`). Secrets in the server's env do not leak into the agent unless routed through the `auth:` config block.

5. **Webhook rate limiting.** 100 req/min per source IP on `/hooks/*` endpoints (silent drops — attacker sees timeouts, not 429).

6. **JWT-scoped agent callbacks.** Agent callback endpoints require a short-lived JWT tied to a specific `instanceId`. A compromised agent cannot impersonate another pipeline.

### Known residual risks

These are documented rather than mitigated today; mitigations are tracked on the roadmap.

| Risk | Description | Roadmap |
|---|---|---|
| **HOME inheritance** | Agent can read `~/.ssh/`, `~/.gitconfig`, `~/.config/gh/*`, `~/.aws/*` from the host user. A prompt injection that bypasses the sanitizer could exfiltrate keys. | Synthesise a minimal HOME per dispatch with only `.claude/` (for subscription auth) and a scoped `.gitconfig`; pass a repo-scoped `GH_TOKEN` via env. Tracked as a follow-up to the initial sanitizer hardening. |
| **Network egress** | The agent has unrestricted outbound network access (needed for `npm install`, `git fetch`, `gh api`, Claude API calls). A bypass can POST exfil data to arbitrary hosts. | Outbound egress allowlist (env-configurable) for self-hosters who want it; SaaS tier will enforce via E2B sandbox firewall rules. |
| **Arbitrary repo write** | The host's `gh` token is typically scoped to all repos the human user has access to — not just the one in the ouija.config.yaml agent profile. | Scoped PAT per agent profile, stored in the secrets vault, passed via `GH_TOKEN` at dispatch time. |
| **Sanitizer regex bypass** | Regex-based pattern detection is defence-in-depth, not complete. Sophisticated obfuscation can pass. | `trustCardAuthors: false` is the default; higher-assurance deployments should use the SaaS tier's sandbox isolation. |
| **Multi-user Plane/Fizzy** | If multiple humans share the Plane workspace, any one of them can dispatch on the others' behalf. Attribution is weak. | Scoped-per-human JWT and agent identity per card author, planned for Phase 2. |

### Subscription auth note

Ouija's `runner: local` and `runner: stream-json` modes use your Claude Pro/Max subscription auth via `~/.claude/` (keychain on macOS, JSON on Linux). **This is self-hosted only, at your own Anthropic ToS risk.** Anthropic's Pro/Max terms are per-user and non-transferable; using them for non-interactive dispatches is a risk you accept by running self-hosted. Ouija does not sell, broker, or expose this to third parties — it is a local convenience your own `~/.claude/` credentials are used by a process you own.

The SaaS tier (Phase 2b+, not built yet) does not use subscription auth — it uses API billing via `runner: sdk` inside E2B Firecracker sandboxes.

### Roadmap

See `docs/superpowers/specs/2026-04-02-remote-execution-research.md` for the full plan. Security-relevant milestones:

- **Phase 2a** (in progress): sanitizer hardening (this file's WS1), dashboard-driven agent CRUD with per-agent `trustCardAuthors` flag.
- **Phase 2b**: E2B-backed sandbox runner; process isolation per dispatch; egress allowlist.
- **Phase 3**: tenant-scoped credential store; per-user JWT; audit log of every dispatch + tool call.

## Disclosure

We disclose vulnerabilities in the release notes after a fix ships, and in a dedicated CHANGELOG `## Security` section. Critical issues (CVSS ≥ 8.0) also get a pinned GitHub issue once patched, so self-hosters know to upgrade.
