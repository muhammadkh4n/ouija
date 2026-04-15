# Troubleshooting

When things go sideways, the fastest signal is almost always:

```bash
npx @ouija-dev/cli logs ouija | grep -E "(error|warn|rejected)"
```

This page covers the failure modes we've actually hit — most were found
during dogfooding against a live Plane instance.

---

## 1. Webhook not firing

**Symptom:** You move a card in Plane but nothing shows up in Ouija logs.

### 1a. Plane cannot reach Ouija

Plane blocks requests to `localhost`, `127.0.0.1`, and private IP ranges in
its webhook egress. This is a safety feature, not a bug.

**Fix (local dev):** If Plane is in the same Docker network, register the
webhook URL as `http://ouija:4000/hooks/plane/<secret>` — Docker DNS resolves
the service name and bypasses the block list.

**Fix (Plane Cloud):** Plane Cloud cannot reach your machine at all. Expose
Ouija via a tunnel:

```bash
# Tailscale Funnel (recommended if you already use Tailscale)
sudo tailscale funnel 4000

# Or ngrok
ngrok http 4000
```

Then update the Plane webhook URL and set `OUIJA_SERVER_URL` in `.env` to
the public URL, and restart Ouija.

### 1b. Webhook URL uses the wrong secret

The URL path segment `hooks/plane/<SECRET>` must match the value of
`PLANE_WEBHOOK_SECRET` in your `.env`, not Plane's internal webhook signing
key (those are different).

**Verify:**
```bash
grep PLANE_WEBHOOK_SECRET .env
```

**Fix:** Edit the webhook URL in Plane → Settings → Webhooks, or regenerate
the secret and update both sides:

```bash
# Generate a new secret
NEW_SECRET=$(openssl rand -hex 16)
sed -i '' "s|PLANE_WEBHOOK_SECRET=.*|PLANE_WEBHOOK_SECRET=$NEW_SECRET|" .env
# Then update the Plane webhook URL to match
npx @ouija-dev/cli down && npx @ouija-dev/cli up
```

---

## 2. Webhook received but HMAC verification fails

**Symptom:**

```json
{"level":"warn","component":"webhook","msg":"HMAC signature mismatch","path":"/hooks/plane/..."}
```

Plane sends the signature as **raw hex** (e.g. `32d9f55a...`), not with a
`sha256=` prefix. Ouija's webhook handler normalizes this automatically, so
if you still see a mismatch, the **webhook signing secret you gave Plane**
is different from `PLANE_WEBHOOK_SECRET` in `.env`.

**Fix:** In Plane → Settings → Webhooks, paste the exact value from
`PLANE_WEBHOOK_SECRET` into the webhook's "Secret" field.

---

## 3. Pipeline stuck in `dispatching` forever

**Symptom:** Logs show:

```
pipeline transition: idle → dispatching
...
agent_progress rejected: pipeline is in state dispatching, expected running
```

The agent started and sent a progress event, but the orchestrator never
transitioned to `running`. This was a real bug: the auto-acknowledge path
was missing. It's fixed in the current version, but if you're on an older
build, update.

**Verify you have the fix:**
```bash
git log --oneline --all --grep="auto-acknowledge" | head
```

If nothing shows up, pull latest main.

---

## 4. Agent dispatched but nothing happens inside the sandbox

**Symptom:** You see `agent worker dequeued job` but no subprocess output,
no git clone, no commits.

### 4a. `claude` CLI isn't on PATH

The Docker image does **not** include the Claude Code CLI. Options:

**Option A — Run Ouija outside Docker** (simplest for self-hosted):
```bash
npm install -g @anthropic-ai/claude-code
claude login        # authenticate once
node packages/server/dist/index.js
```

**Option B — Install Claude inside the container** (requires a custom
Dockerfile layer — not yet bundled):
```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

**Option C — Use the SDK runner** (no CLI needed). Set in `ouija.config.yaml`:
```yaml
agents:
  - id: rex-coder
    runner: sdk      # uses the Anthropic SDK directly, no subprocess
```

### 4b. Claude is installed but not authenticated

If you're using `auth.method: api-key`, Ouija sets `ANTHROPIC_API_KEY` on
the subprocess — no session needed. But if you rely on session auth
(`~/.claude/`), make sure that directory is present and valid for the user
running Ouija:

```bash
ls -la ~/.claude/.credentials.json
claude --version     # should print the CLI version
```

### 4c. The `-p` flag is being called wrong

Early versions of Ouija used `claude --print` which puts Claude in Q&A mode
— it generates a text response but can't edit files. The current runner
uses `claude -p "<prompt>" --dangerously-skip-permissions`, which enables
autonomous tool use.

**Verify:**
```bash
grep -r "dangerously-skip-permissions" packages/workspace-local/src
```

If nothing matches, pull latest.

---

## 5. Git clone fails inside the workspace

**Symptom:**

```
workspace provisioning failed: fatal: could not read Username for 'https://github.com'
```

The `git clone` call uses a clean environment with a credential allowlist
and `GIT_TERMINAL_PROMPT=0` — there's no interactive fallback.

**Fix:** For HTTPS clones, set `GITHUB_PAT` in `.env`. Ouija will embed it
in the clone URL as a basic-auth username. The token needs `repo` scope for
private repos, `public_repo` for public.

```bash
# Rotate to a fresh token if unsure
$EDITOR .env
npx @ouija-dev/cli down && npx @ouija-dev/cli up
```

For SSH clones, make sure `SSH_AUTH_SOCK` is forwarded into the container
(the default compose files don't forward it — use the local dev path instead).

---

## 6. Pipeline detected as stalled immediately

**Symptom:**

```
stall detected: no heartbeat in 300000ms
pipeline transition: running → stalled
```

…but the agent is actually still working.

This usually means your `stallThresholdMs` is too aggressive for the
workload. Agents doing heavy refactors or long builds can go 5–10 minutes
without producing output.

**Fix:** Raise the threshold in `ouija.config.yaml`:

```yaml
agents:
  - id: rex-coder
    limits:
      maxDurationMs: 3600000        # 1 hour
      stallThresholdMs: 900000      # 15 minutes
```

---

## 7. `rejected transition` in logs

**Symptom:**

```json
{"level":"warn","component":"orchestrator","msg":"transition rejected","reason":"..."}
```

The pipeline state machine rejects invalid transitions as a **feature**,
not a bug — this is how we catch protocol violations.

Common reasons:
- `pipeline is in state X, expected Y` — out-of-order events. Usually benign (a retry).
- `unknown dispatchId` — the agent is reporting on a dispatch that doesn't exist in the DB. Check for clock skew between services.
- `instance already in terminal state` — the agent is reporting progress on a pipeline that already succeeded/failed. Benign.

If you see a flood of these, enable `LOG_LEVEL=debug` and look at the event
sequence just before the rejection.

---

## 8. Postgres not ready

**Symptom:** Ouija crashes at boot with:

```
ECONNREFUSED 127.0.0.1:5432
```

The Ouija container started before Postgres finished initializing.
`docker-compose.ouija.yml` has a `depends_on` with `condition: service_healthy`,
which should handle this — if it doesn't, the healthcheck interval is too
generous.

**Fix:**
```bash
npx @ouija-dev/cli down && npx @ouija-dev/cli up
```

If it happens consistently, check the Postgres logs:
```bash
npx @ouija-dev/cli logs postgres --no-follow
```

---

## 9. Plane API token rejected

**Symptom:**

```
Plane API 401: authentication credentials not provided
```

### 9a. Wrong header format

Plane uses `x-api-key: <token>`, not `Authorization: Bearer <token>`.
Ouija's Plane plugin sends the right header — if you're seeing 401, the
token itself is wrong or expired.

### 9b. Scope mismatch

Plane Community Edition requires some endpoints to be hit with **session
auth** (browser cookies), not API tokens. Ouija uses `/users/me/` for
health checks because it works with token auth. If you've modified the
plugin to use workspace-level endpoints, you'll hit this.

**Fix:** Generate a fresh token in Plane → Settings → API Tokens, paste
into `.env`, restart.

---

## 10. Agent worker not starting

**Symptom:** Logs show Ouija booted cleanly but no `Agent worker started`
message.

Check:

```bash
grep OUIJA_DISABLE_AGENT_WORKER .env
```

If this is set to `1`, the in-process worker is disabled (you'd do this
when running the worker as a separate process for horizontal scaling).
Either unset it or start the worker container explicitly.

---

## When all else fails

1. **Turn on debug logging:** add `LOG_LEVEL=debug` to `.env`, then
   `npx @ouija-dev/cli down && npx @ouija-dev/cli up`

2. **Tail everything:**
   ```bash
   npx @ouija-dev/cli logs
   ```

3. **Preflight audit:**
   ```bash
   npx @ouija-dev/cli doctor
   ```

4. **Dump Postgres state** (raw docker compose — CLI doesn't wrap `exec`):
   ```bash
   docker compose --project-directory "$(pwd)" -f docker/docker-compose.ouija.yml exec postgres \
     psql -U ouija -d ouija_db -c "SELECT id, status, updated_at FROM pipeline_instances ORDER BY updated_at DESC LIMIT 10;"
   ```

4. **Open an issue** with the output of all three and a description of what
   you expected vs. what happened: [github.com/muhammadkh4n/ouija/issues](https://github.com/muhammadkh4n/ouija/issues)
