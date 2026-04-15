---
name: Bug report
about: Something isn't working the way the docs say it should
title: "bug: "
labels: ["bug", "needs-triage"]
assignees: []
---

## What happened?

<!-- A clear, short description of the unexpected behaviour. -->

## What did you expect to happen?

<!-- What the docs or your mental model said *should* happen. -->

## Steps to reproduce

1.
2.
3.

## Environment

<!-- Run `ouija doctor` and paste the output, or fill in manually: -->

- **Ouija version:** <!-- e.g. @ouija-dev/cli 0.1.2 -->
- **How installed:** <!-- npx / local clone / docker compose -->
- **Node version:** <!-- node --version -->
- **OS:** <!-- macOS 15 / Ubuntu 22.04 / etc. -->
- **Kanban backend:** <!-- plane / fizzy / other -->
- **Agent runner:** <!-- local / stream-json / sdk (see ouija.config.yaml) -->
- **Auth method:** <!-- subscription (~/.claude/) / api-key / bedrock / vertex / foundry -->

## Logs

<details>
<summary>Ouija server logs</summary>

```
<!-- Paste relevant log lines. Mask any secrets before posting. -->
```
</details>

<details>
<summary>Agent subprocess output (if the bug is dispatch-side)</summary>

```
```
</details>

## Anything else?

<!-- Related issues, hypotheses, things you've already tried, anything that
     might save a maintainer 20 minutes of triage. -->
