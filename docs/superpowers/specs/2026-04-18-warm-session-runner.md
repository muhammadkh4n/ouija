# Warm session agent runner — design spec

**Status:** draft, needs review
**Author:** claude, 2026-04-18
**Builds on:** `StreamJsonAgentRunner` (commit `d37ccac`, 2026-04-16)

## The pitch

Kill the 10–15s cold-start every dispatch pays. The stream-json smoke test
on 2026-04-16 showed a cold `claude -p --input-format stream-json` burning
~12.3s before the agent began meaningful work. For a kanban flow where a
card move triggers a dispatch, that 12s is the single biggest UX bottleneck
between "I moved the card" and "I see the agent working."

Warm sessions keep a pool of `claude` subprocesses alive across dispatches.
First dispatch pays cold start; subsequent dispatches reuse the warm
process and start emitting events in <1s.

## What's already solved

- **Stream-json protocol** — `StreamJsonAgentRunner` already speaks
  NDJSON on stdin/stdout. A warm session is the same protocol, just
  with the subprocess lifetime decoupled from the single dispatch.
- **Subscription billing preserved** — warm sessions read the same
  `~/.claude/.credentials.json` and the same env allowlist. No
  regression on the cost moat.
- **Live dashboard** — SSE streaming (shipped today) works the same
  regardless of runner. Warm sessions will surface the same events.

## What's genuinely hard (decisions needed)

### Decision 1 — Session reset between dispatches

The agent finishes dispatch A with accumulated context (tool calls,
file reads, conversation turns). Dispatch B starts on a different card.
How do we reset?

**Options:**

**1a. `/clear` slash command.** Send `{type:'user', message:{content:'/clear'}}`
between dispatches. Pros: cheap, keeps the process warm. Cons: does
`/clear` actually reset context in print mode? Needs verification. Tool
permissions from `--dangerously-skip-permissions` persist, which is
what we want.

**1b. `--session-id` rotation.** Claude CLI supports `--session-id <uuid>`
to name a session. A reset = start a new session id. Unclear whether
this works in `--print` + `--input-format stream-json` mode without
restarting the process. Needs verification.

**1c. No reset — one process per dispatch.** Same as today. No win.
Reject.

**1d. Restart on "stale" signal.** Run N dispatches on a session, then
kill + respawn. Caps context creep without paying every-dispatch cost.
Cheap insurance, but doesn't solve contamination between concurrent
dispatches.

**Recommendation:** empirically test 1a (`/clear`) first. If it works,
combine with 1d (respawn every 50 dispatches) as belt-and-suspenders.
If `/clear` doesn't reset in print mode, fall back to per-dispatch
spawn for the first release and punt warm sessions until the CLI gains
a real reset primitive.

### Decision 2 — Workspace model (the big one)

Current flow: every dispatch gets a fresh workspace via
`WorkspaceProvider.create()` — a temp dir with a git clone. The `claude`
subprocess starts with `cwd = workspace.path`. At dispatch end,
workspace is destroyed.

Warm sessions break this model. The subprocess cwd is fixed when the
process starts. If dispatch A runs in `/tmp/ws-A` and dispatch B runs
in `/tmp/ws-B`, they need different processes — warm sessions don't
help.

**Options:**

**2a. Persistent workspace per agent-profile.** Each agent gets ONE
persistent working directory. Every dispatch does `git fetch && git
checkout <new-branch>` inside it. Pros: warm session keeps its cwd.
Cons: breaks workspace isolation (in-flight state from dispatch A
leaks to dispatch B via the filesystem), breaks concurrent dispatches
for the same agent.

**2b. Workspace pool per agent-profile.** Each agent has N persistent
workspace dirs and N warm sessions, paired 1:1. Dispatcher leases a
(session, workspace) pair, runs dispatch, releases. Pros: concurrent
dispatches work. Cons: more state to manage, and resetting a workspace
between dispatches (`git clean -fdx && git checkout main` etc.) is
non-trivial to get right.

**2c. `cd` via a stdin command.** Before dispatch B's user message,
send a synthetic user message saying "work in `/tmp/ws-B`" or use a
tool call to change directories. Pros: warm session unchanged. Cons:
`claude` doesn't reliably respect cwd changes mid-session — the Node
process's cwd is fixed, only the agent's perception of "where am I"
would change. Tools that shell out will run in the original cwd. Fragile.

**Recommendation:** 2b is the only model that scales. Start with
pool-size = 1 per agent (= serialized dispatches per agent, which is
already the default worker concurrency), then lift concurrency later.

### Decision 3 — When is this worth building?

The Apr 16 note said: *"Deferred until real dogfood cadence justifies
the complexity."*

**Real dogfood signals to confirm before building:**

- ≥10 dispatches/day against the same agent profile (amortizes the
  warm-session construction cost)
- Users noticing the cold-start in actual UX complaints / observations
- Measurable p50 dispatch latency that's mostly cold-start, not agent
  work time

**Counter-signal (means warm sessions aren't the bottleneck):**

- p50 dispatch takes >2 minutes of agent work. Saving 12s cold-start
  is a 10% win, not worth 2 weeks of engineering.

**Recommendation:** we need one week of production-ish dogfood before
deciding. Instrument `durationMs` breakdown in `StreamJsonAgentRunner`
to split "time to first event" vs "time from first event to result"
so we can see the ratio empirically. **This is the right first
increment** — it's useful regardless of whether we build warm sessions
next, and it turns the "is this worth it" question into data.

## Proposed first increment (if we proceed)

Not the full warm session — just the instrumentation that tells us if
we should.

1. Add `timeToFirstEventMs` and `agentWorkDurationMs` fields to
   `AgentRunResult`.
2. `StreamJsonAgentRunner` records timestamp on the first non-`system`
   NDJSON line.
3. Surface both in the dashboard detail meta card.
4. Stream to the live event bus as `agent.work.first_event` (new
   topic) so SSE clients can render "agent is thinking…" →
   "agent is working" transitions.

**Effort:** ~2 hours. Non-invasive. Prepares the ground and gives us
real numbers.

**After a week of data:** decide whether to build warm sessions or
leave them deferred.

## Open questions for Muhammad

1. **Approve the "measure first" approach**, or do you want me to just
   build warm sessions on intuition?
2. **Decision 2 (workspace model)** — is 2b (pool) the right call, or
   do you see a simpler model I'm missing?
3. **Decision 1 (reset)** — comfortable with me running a small
   empirical test of `/clear` in print mode + stream-json to validate
   it actually resets context?

## Out of scope

- SaaS deployment model (still E2B-based per the Apr 2 research spec)
- MCP server lifecycle within warm sessions (MCP handshake is part of
  cold-start; warm sessions may need to re-register MCP tools per
  dispatch, or not — needs a separate investigation)
- Cross-agent session sharing (definitely not — keeps auth, context,
  and tool permissions isolated per agent)
