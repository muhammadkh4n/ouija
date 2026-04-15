# @ouija-dev/dashboard

React SPA for monitoring Ouija pipelines. Served at `/dashboard` by
`@ouija-dev/server` — operators open `http://localhost:4000/dashboard`
and see the live state of every pipeline without tailing logs or
querying Postgres.

## Philosophy

**Information-dense, operator-first, not stock.**

- Terminal-inspired dark theme — this is a DevOps tool, not a marketing site
- JetBrains Mono for IDs, states, and other technical data
- Inter for prose and headings
- Hand-rolled components — no shadcn/ui, no default Tailwind card grids
- Status dots pulse only when in-flight (provisioning / dispatching / running)
- Colors are semantic: green = running/succeeded, amber = dispatching,
  red = failed/stalled, slate = idle/cancelled

Design tokens live in [src/styles/tokens.css](src/styles/tokens.css).
Global rules and utility classes live in [src/styles/global.css](src/styles/global.css).
Tailwind v4 is imported via the `@tailwindcss/vite` plugin — no config
file, no postcss.config.js.

## Pages (v1)

| Route | What |
|-------|------|
| `/` | Pipeline list — polls every 3s, board picker, status dots, allowed actions |
| `/pipelines/:id` | Placeholder for v2 — detail with timeline and log streaming |

## Auth

The dashboard uses the server's existing bearer-token auth. There is no
login form — users paste their `OUIJA_API_KEY` on first visit and it's
stored in `localStorage`. When any query returns 401, the app falls
back to the token-entry screen.

This is deliberately simple for v1. Future work: cookie-session login
flow, multi-user support, role-based access.

## Development

```bash
# From repo root:
npm install
npm run build --workspace=@ouija-dev/dashboard

# Run the dev server (proxies /api → http://localhost:4000):
npm run dev --workspace=@ouija-dev/dashboard
# Open http://localhost:5173/dashboard/

# Or run the production build and let Fastify serve it:
npm run build
node packages/server/dist/index.js
# Open http://localhost:4000/dashboard/
```

## Architecture

```
packages/dashboard/
├── index.html                  # Vite entry point
├── vite.config.ts              # Base path /dashboard/, /api proxy for dev
├── src/
│   ├── main.tsx                # ReactDOM.createRoot bootstrap
│   ├── App.tsx                 # Token gate + router + QueryClient provider
│   ├── lib/
│   │   ├── api-client.ts       # Typed fetch wrapper, bearer auth, 401 handling
│   │   ├── api-types.ts        # Hand-maintained response types
│   │   └── format.ts           # Relative time, ID shortener, inFlight predicate
│   ├── components/
│   │   ├── Header.tsx          # Top nav with sign-out
│   │   ├── StatusDot.tsx       # Pulsing status indicator
│   │   └── EmptyState.tsx      # Empty list surface
│   ├── pages/
│   │   ├── TokenEntry.tsx      # First-run token paste
│   │   └── PipelineList.tsx    # Landing page with board picker + polling table
│   ├── styles/
│   │   ├── tokens.css          # Design tokens (colors, type scale, spacing)
│   │   └── global.css          # Reset + utility classes + status dot styles
│   └── public/
│       └── favicon.svg         # Inline SVG, no separate asset fetch
└── dist/                       # Vite build output (served from /dashboard/*)
```

## Non-goals (v1)

Deliberately left for later:

- Pipeline detail view (timeline + logs)
- SSE / WebSocket for live updates (polling is fine for v1)
- Agent profile management (edit YAML instead)
- Board config editing (edit YAML instead)
- Multi-tenant auth
- Mobile layouts (the tool is for laptops)
- Theming (dark-only, by design)

## License

Apache-2.0. Part of the Ouija monorepo.
