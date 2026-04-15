# Getting Started with Ouija

From zero to your first AI-generated pull request in about 15 minutes. This
walkthrough uses the BYO-kanban path: Ouija + a Plane workspace you already
have access to (either Plane Cloud or a self-hosted instance).

If you want a fully self-contained demo with Plane bundled in, skip to
[Path B: Full Stack with Self-Hosted Plane](#path-b-full-stack-with-self-hosted-plane)
at the end.

---

## What you'll need

Before starting, have these ready:

- **Docker + Docker Compose** (v24 or later)
- **A GitHub repository** you want agents to work on
- **A GitHub Personal Access Token** with `repo` scope — [create one](https://github.com/settings/tokens/new?scopes=repo)
- **An Anthropic API key** — [create one](https://console.anthropic.com/settings/keys) — OR the `claude` CLI already authenticated on this machine
- **A Plane workspace** — sign up at [plane.so](https://plane.so) or run your own
- **A public URL** pointing at your machine (only if Plane is not on the same host as Ouija). Options: [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), [ngrok](https://ngrok.com), [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)

---

## Step 1: Clone and bootstrap

```bash
git clone https://github.com/muhammadkh4n/ouija.git
cd ouija
bash infra/setup.sh
```

`setup.sh` generates `OUIJA_SECRET_KEY`, `PLANE_SECRET_KEY`, and
`PLANE_WEBHOOK_SECRET`, writes them to `.env`, and copies
`ouija.config.example.yaml` to `ouija.config.yaml`.

Open `.env` and fill in:

```bash
$EDITOR .env
```

| Variable | Value |
|----------|-------|
| `PLANE_BASE_URL` | `https://api.plane.so` (cloud) or `http://your-plane-host` |
| `PLANE_API_TOKEN` | Plane → Settings → API Tokens → Create token |
| `PLANE_WORKSPACE_SLUG` | The slug in your Plane URL (`app.plane.so/<slug>/`) |
| `GITHUB_PAT` | The PAT you generated above |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `OUIJA_SERVER_URL` | `http://localhost:4000` — change if using a tunnel |

Leave `OUIJA_SECRET_KEY` and `PLANE_WEBHOOK_SECRET` as they are (setup.sh
generated them).

---

## Step 2: Configure your agent

Open `ouija.config.yaml` and make three edits:

```yaml
agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@example.com            # ← use your email domain
    triggerMode: auto
    model: claude-sonnet-4-20250514

    systemPrompt: |
      You are an expert software engineer.
      Write clean, well-tested code. Follow existing project patterns.
      Create a pull request when your work is complete.

    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY

    repos:
      - url: https://github.com/YOUR-USER/YOUR-REPO.git   # ← your repo
        baseBranch: main
        default: true

    limits:
      maxDurationMs: 1800000
      stallThresholdMs: 300000
```

You can skip the `boards:` section for now — we'll use the auto-seeding flow
in Step 4.

---

## Step 3: Start Ouija

```bash
docker compose -f docker/docker-compose.ouija.yml up -d
```

Wait ~10 seconds for Postgres to initialize, then verify:

```bash
curl http://localhost:4000/healthz
# → {"status":"ok","checks":{"db":"ok","redis":"ok"}}
```

If you see errors, tail the logs:

```bash
docker compose -f docker/docker-compose.ouija.yml logs -f ouija
```

On first boot, Ouija will:

1. Run database migrations
2. Load `ouija.config.yaml`
3. Provision `rex-coder` as a Plane member (by email)
4. Start the webhook listener and agent worker

You should see structured log lines like:

```json
{"level":"info","component":"config","msg":"Loaded 1 agent profile"}
{"level":"info","component":"plane-plugin","msg":"Agent provisioned","email":"rex@example.com"}
{"level":"info","component":"orchestrator","msg":"Ready"}
```

---

## Step 4: Wire the Plane webhook

Plane needs to know where to send card-move events.

1. In Plane, go to **Settings → Webhooks → Add Webhook**
2. **URL:** `http://<your-ouija-host>:4000/hooks/plane/<PLANE_WEBHOOK_SECRET>`
   - Replace `<your-ouija-host>` with your tunnel URL if Plane is remote
   - Replace `<PLANE_WEBHOOK_SECRET>` with the value from your `.env`
3. **Secret:** paste the same `PLANE_WEBHOOK_SECRET` here
4. **Events:** enable `issue`, `issue_activity`, `project`
5. **Save**

> **If Plane is self-hosted on the same Docker network**, use
> `http://ouija:4000/hooks/plane/<secret>` instead of `localhost` — Docker
> DNS resolves service names and Plane's internal block list rejects
> `localhost`.

---

## Step 5: Assign the agent to a board

Find the project UUID you want Ouija to manage:

```bash
# In Plane, open any issue and copy the UUID from the URL:
# https://app.plane.so/<workspace>/projects/<PROJECT-UUID>/issues/...
```

Uncomment and edit the `boards:` block in `ouija.config.yaml`:

```yaml
boards:
  - projectId: "<your-plane-project-uuid>"
    autoStartOnAssign: true
    columns:
      - name: In Progress
        action: dispatch_agent
        agentId: rex-coder
      - name: Done
        action: close_and_notify
```

Restart Ouija to pick up the config change:

```bash
docker compose -f docker/docker-compose.ouija.yml restart ouija
```

---

## Step 6: Create a card and watch the magic

1. In Plane, create a new issue with a clear title and description. Example:

   > **Title:** Add a /ping endpoint
   >
   > **Description:** Add a new route `GET /ping` that returns `{"pong":true}`.
   > Write a test. Commit and open a PR.

2. **Assign** the issue to `rex@example.com` (the email you put in the agent config)
3. **Move** the card from Backlog → In Progress

Now tail the logs:

```bash
docker compose -f docker/docker-compose.ouija.yml logs -f ouija
```

You should see (in order):

```
webhook received: issue_activity
pipeline transition: idle → dispatching
agent worker dequeued job
workspace provisioned: /tmp/ouija-ws-abc123
agent subprocess started: claude -p "..."
heartbeat received: agent_acknowledged
pipeline transition: dispatching → running
... (2-5 minutes of agent activity) ...
heartbeat received: agent_completed
pipeline transition: running → succeeded
PR opened: https://github.com/YOUR-USER/YOUR-REPO/pull/42
```

Open the PR link from the log. You should see:

- A new branch `ouija/<instance-id>`
- Commits authored by `rex@example.com`
- A PR description generated from the card
- Any tests the agent wrote

---

## Troubleshooting

If something didn't work, see [troubleshooting.md](troubleshooting.md) for
the common failure modes. The fastest signal is usually:

```bash
docker compose -f docker/docker-compose.ouija.yml logs ouija | grep -E "(error|warn)"
```

---

## Path B: Full stack with self-hosted Plane

If you don't already have a Plane workspace and want everything bundled:

```bash
git clone https://github.com/muhammadkh4n/ouija.git
cd ouija
bash infra/setup.sh
$EDITOR ouija.config.yaml
docker compose -f docker/docker-compose.yml up -d
```

**Plane AIO needs ~5 GB of RAM** and takes 1–2 minutes to finish booting.
Once ready:

1. Open `http://localhost:80`, create a workspace
2. Plane → Settings → API Tokens → create one → paste into `.env` as `PLANE_API_TOKEN`
3. Plane → Settings → Webhooks → point at `http://ouija:4000/hooks/plane/<PLANE_WEBHOOK_SECRET>`
4. `docker compose -f docker/docker-compose.yml restart ouija`
5. Continue from [Step 5](#step-5-assign-the-agent-to-a-board)

---

## What to read next

- [configuration.md](configuration.md) — every field in `ouija.config.yaml`
- [troubleshooting.md](troubleshooting.md) — when things go sideways
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — add a new kanban backend or agent
