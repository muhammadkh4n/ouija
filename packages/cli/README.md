# @ouija-dev/cli

Command-line interface for the [Ouija](https://github.com/muhammadkh4n/ouija)
pipeline engine. Bootstrap a project, start the stack, tail logs, and run
preflight checks — without cloning the repo.

## Install

No install needed — use `npx`:

```bash
npx @ouija-dev/cli init
```

Or install globally:

```bash
npm install -g @ouija-dev/cli
ouija --help
```

## Quick start

```bash
mkdir my-ouija && cd my-ouija
npx @ouija-dev/cli init      # generates secrets, copies docker/ + config
$EDITOR ouija.config.yaml    # set your repo URL and prompt
npx @ouija-dev/cli up        # starts Ouija + Postgres + Redis
npx @ouija-dev/cli doctor    # preflight audit
```

After `init`, your directory will contain:

```
my-ouija/
├── .env                         # generated secrets + empty credential slots
├── ouija.config.yaml            # agent + board config (copy of example)
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.ouija.yml
│   ├── docker-compose.yml
│   └── docker-compose.fizzy.yml
└── infra/
    └── setup.sh
```

## Commands

### `ouija init [--force] [-y|--non-interactive]`

Bootstrap a project in the current directory:

1. Copies the bundled `docker/`, `infra/setup.sh`, and `ouija.config.example.yaml`
2. Generates `OUIJA_SECRET_KEY`, `PLANE_SECRET_KEY`, `PLANE_WEBHOOK_SECRET` and writes them to `.env`
3. Interactively prompts for `PLANE_API_TOKEN` / `FIZZY_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_PAT` (unless `-y` is passed)

**Flags:**
- `--force, -f` — overwrite existing `.env` and `ouija.config.yaml`
- `--non-interactive, -y` — skip credential prompts, write placeholders

### `ouija up [--stack ouija|full|fizzy] [--foreground]`

Start the docker stack. Default stack is `ouija` (BYO kanban). Runs detached
(`-d`) by default; pass `--foreground` to stream logs.

```bash
ouija up                    # Ouija + Postgres + Redis
ouija up --stack full       # + self-hosted Plane
ouija up --stack fizzy      # + self-hosted Fizzy
```

### `ouija down [--stack ...] [-v|--volumes]`

Stop the stack. Volumes are preserved by default — pass `-v` to also delete
Postgres and Redis data.

### `ouija logs [service] [--stack ...] [--no-follow]`

Tail docker compose logs. Follows by default; `--no-follow` prints once and
exits.

```bash
ouija logs                   # all services
ouija logs ouija             # only the ouija container
ouija logs --stack full      # full stack
ouija logs --no-follow       # last 200 lines, no tail
```

### `ouija status [--stack ...]` (alias: `ps`)

`docker compose ps` for the stack.

### `ouija doctor`

Preflight audit of the current directory. Checks:

- Docker Compose v2, git, openssl on PATH
- `.env` exists and `OUIJA_SECRET_KEY` is 32+ chars
- `ouija.config.yaml` exists and has an `agents:` section
- Agent config is customized (not the example URL)
- `docker/` compose files are present
- `ANTHROPIC_API_KEY` is set OR `claude` CLI is available

Prints a pass/warn/fail report. Exit code `0` on success (even with warnings),
`1` on any failure. Great to run as a CI smoke test or before filing an issue.

### `ouija help` / `ouija version`

What you'd expect.

## Stacks

| Stack  | Contents                                     | RAM    | Use when |
|--------|----------------------------------------------|--------|----------|
| `ouija` (default) | Ouija + Postgres + Redis          | ~1.5GB | You already have a kanban board (Plane Cloud, Jira, Linear, etc.) |
| `full`            | Ouija + Postgres + Redis + Plane  | ~5GB   | You want a self-contained demo with Plane bundled in |
| `fizzy`           | Ouija + Postgres + Redis + Fizzy  | ~3GB   | You prefer Fizzy over Plane |

## Environment

The CLI reads nothing from env vars — everything lives in the project's
`.env`. The commands pass `--project-directory $(pwd)` to `docker compose`
so `.env` is discovered from the project root, not the compose file's own
directory.

## Requirements

- Node.js 20+
- Docker Desktop or Docker Engine with the `compose` plugin (v2)

## License

Apache-2.0. See [LICENSE](../../LICENSE) at the repo root.
