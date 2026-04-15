# @ouija-dev/plugin-engram

Ouija notification plugin that ingests pipeline events into an [Engram](https://github.com/muhammadkh4n/engram)
memory instance. Gives Ouija-dispatched agents durable cross-run memory
without Ouija itself having to implement recall.

## Why this is the "agents that remember" story

Every other AI-in-CI tool treats each run as stateless. This plugin flips
that. When a pipeline succeeds, fails, or opens a PR, Ouija emits a
`notification.send` event. This plugin forwards that event to the shared
Engram memory graph by shelling out to the `engram-ingest` CLI.

The next time Ouija dispatches a Claude Code agent on the same repo, the
agent **already has `memory_recall` in its MCP toolbelt** (because Engram
runs as an MCP server attached to the agent's `~/.claude/` config). The
agent can ask *"what do I know about this codebase?"* and get real answers
drawn from every prior Ouija pipeline that touched it.

**Nothing in the agent subprocess changes.** The plugin only writes. The
reading happens on the agent's side, via tools that already exist.

## Architecture

```
┌────────────────────┐        ┌──────────────────────┐
│  Ouija pipeline    │        │  Engram memory graph │
│  succeeds / fails  │        │  (shared instance)   │
└──────────┬─────────┘        └──────────▲───────────┘
           │ notification.send           │
           ▼                             │ engram-ingest
┌────────────────────┐  shell out  ┌─────┴────────┐
│  EngramNotify      │────────────▶│ engram-ingest│
│  Plugin            │             │   CLI        │
└────────────────────┘             └──────────────┘

                   (next dispatch)

┌────────────────────┐
│  Claude Code agent │  memory_recall via MCP
│  (new dispatch)    │──────────┐
└────────────────────┘          │
                                ▼
                  ┌──────────────────────┐
                  │  Engram memory graph │
                  │  (same instance)     │
                  └──────────────────────┘
```

## Install

Self-hosted: the `engram-ingest` CLI must be on `PATH` in the same
environment that runs the Ouija server.

```bash
npm install -g @engram-mem/mcp
# engram-ingest, engram-mcp, and friends are now on your PATH.
```

Engram itself needs backing stores — a Supabase Postgres project and an
OpenAI API key at minimum. See the [Engram README](https://github.com/muhammadkh4n/engram#readme)
for the full setup. Ouija's plugin forwards these env vars to the
subprocess via an allowlist:

- `SUPABASE_URL`, `SUPABASE_KEY`
- `OPENAI_API_KEY`
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` (optional graph backend)
- `ENGRAM_SALIENCE_THRESHOLD`, `ENGRAM_SALIENCE_DISABLED` (optional tuning)

## Enable the plugin in Ouija

Set one env var:

```bash
OUIJA_ENGRAM_ENABLED=1
```

Then start the server. On boot you should see:

```
Wiring Engram memory plugin
Engram notification plugin started
Engram memory plugin active
```

### Optional env overrides

| Variable | Default | What |
|---|---|---|
| `OUIJA_ENGRAM_BINARY` | `engram-ingest` | Path to the ingest CLI (use when not on PATH) |
| `OUIJA_ENGRAM_PROJECT` | `ouija` | Engram `--project` scope tag |

## Graceful degradation

When `OUIJA_ENGRAM_ENABLED=1` is set but `engram-ingest` is **not**
available (missing binary, ENOENT, etc.), the plugin:

1. Emits a single `warn`-level log line on startup
2. Marks itself disabled
3. Makes every `send()` a silent no-op

Ouija itself boots normally. You can run `ouija doctor`-style probes to
see the warning without breaking the pipeline.

## What gets ingested

Every `notification.send` event fires one `engram-ingest` subprocess with
a markdown body like:

```markdown
# Ouija: Pipeline succeeded

**Level:** success
**When:** 2026-04-16T10:30:00.000Z

Agent rex-coder opened PR #42 on muhammadkh4n/ouija.
Task: "Add rate limiter to webhook ingress"
Cost: $0.0423 · Tokens: 18,450

**Links:**
- [PR](https://github.com/muhammadkh4n/ouija/pull/42)
- [Card](https://plane.example.com/.../issues/abc)

<!-- ouija:inst_abc123_succeeded -->
```

The trailing `<!-- ouija:... -->` marker gives Engram's dedup pass a hook
for near-duplicate detection if two Ouija processes ever race on the
same event.

Events use `--raw` so Engram skips the salience classifier — pipeline
events are always "interesting" to Ouija, no point paying for a GPT-4o
round-trip.

## What this plugin does NOT do

- **Does not recall** — reading happens on the agent subprocess side via
  its own MCP tools. This plugin is strictly one-way.
- **Does not embed Engram** — no `@engram-mem/core` runtime dep. Thin
  adapter by design. Works with any version of Engram that ships
  `engram-ingest`.
- **Does not guarantee delivery** — Engram ingest failures are logged as
  warnings and swallowed. We don't want a memory backend outage to
  cascade into pipeline failures.

## Development

```bash
npm install
npm run build --workspace=@ouija-dev/plugin-engram
npm run test --workspace=@ouija-dev/plugin-engram
```

22 tests: formatter (6), EngramClient (9), plugin (7).

## License

Apache-2.0. Part of the Ouija monorepo.
