/**
 * AgentList — manage dashboard-created agents.
 *
 * Shows every agent row from the DB-backed /api/v1/agents endpoint plus a
 * "create" CTA. Inactive rows are dimmed; soft-deletes are reversible via
 * the detail form (active=true).
 *
 * Graceful degradation: when the server is old (migration 003 not applied)
 * the API returns 404 NOT_AVAILABLE. We show an inline hint instead of the
 * generic error state so the user knows it's a migration issue, not a bug.
 */

import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listAgents, deleteAgent, listBoards, ApiError } from '../lib/api-client.js';
import { Header } from '../components/Header.js';
import { EmptyState } from '../components/EmptyState.js';
import { useToast } from '../components/Toast.js';
import type { AgentRecord } from '../lib/api-types.js';
import { relativeTime } from '../lib/format.js';

export function AgentList() {
  const boardsQuery = useQuery({ queryKey: ['boards'], queryFn: listBoards, staleTime: 30_000 });
  const agentsQuery = useQuery({
    queryKey: ['agents', 'all'],
    queryFn: () => listAgents(true),
  });

  const boards = boardsQuery.data?.items ?? [];
  const agents = agentsQuery.data?.items ?? [];

  const backendUnavailable =
    agentsQuery.error instanceof ApiError && agentsQuery.error.status === 404 &&
    agentsQuery.error.code === 'NOT_AVAILABLE';

  return (
    <div className="min-h-screen">
      <Header boardCount={boards.length} />
      <main
        className="mx-auto"
        style={{
          maxWidth: '1280px',
          padding: 'var(--space-6) var(--space-6) var(--space-8)',
        }}
      >
        <div
          className="flex items-end justify-between"
          style={{ marginBottom: 'var(--space-5)', gap: 'var(--space-4)' }}
        >
          <div>
            <h2
              style={{
                fontSize: 'var(--text-xl)',
                letterSpacing: '-0.02em',
                marginBottom: 'var(--space-1)',
              }}
            >
              Agents
            </h2>
            <span className="dim mono" style={{ fontSize: 'var(--text-xs)' }}>
              {agentsQuery.isFetching
                ? 'refreshing…'
                : `${agents.length} defined`}
            </span>
          </div>
          {!backendUnavailable && (
            <Link
              to="/agents/new"
              className="mono"
              style={{
                padding: 'var(--space-2) var(--space-4)',
                fontSize: 'var(--text-sm)',
                background: 'var(--color-accent)',
                color: 'var(--color-bg)',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
              }}
            >
              new agent
            </Link>
          )}
        </div>

        {backendUnavailable ? (
          <EmptyState
            title="Agent CRUD not available on this server"
            hint="This server hasn't applied migration 003-agents. Either restart the server (migrations auto-run on boot) or define agents in ouija.config.yaml."
          />
        ) : agentsQuery.isLoading ? (
          <p className="dim mono" style={{ fontSize: 'var(--text-xs)' }}>
            loading…
          </p>
        ) : agents.length === 0 ? (
          <EmptyState
            title="No agents defined"
            hint='Click "new agent" to create your first one. Agents defined here override any entries with the same id in ouija.config.yaml.'
          />
        ) : (
          <AgentTable agents={agents} />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent table
// ---------------------------------------------------------------------------

function AgentTable({ agents }: { agents: AgentRecord[] }) {
  const qc = useQueryClient();
  const toast = useToast();

  const del = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: () => {
      toast.push({ kind: 'success', message: 'Agent deactivated' });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (err) => {
      toast.push({
        kind: 'error',
        message: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
  });

  return (
    <div className="surface" style={{ overflow: 'hidden' }}>
      <div
        className="grid faint mono uppercase tracking-wide"
        style={{
          gridTemplateColumns: '12rem 1fr 8rem 6rem 8rem 6rem',
          gap: 'var(--space-4)',
          padding: 'var(--space-3) var(--space-5)',
          fontSize: 'var(--text-xs)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span>id</span>
        <span>name</span>
        <span>runner</span>
        <span>mode</span>
        <span>updated</span>
        <span></span>
      </div>
      {agents.map((a) => (
        <div
          key={a.id}
          className="grid"
          style={{
            gridTemplateColumns: '12rem 1fr 8rem 6rem 8rem 6rem',
            gap: 'var(--space-4)',
            padding: 'var(--space-3) var(--space-5)',
            fontSize: 'var(--text-sm)',
            borderBottom: '1px solid var(--color-border)',
            alignItems: 'center',
            opacity: a.active ? 1 : 0.45,
          }}
        >
          <Link
            to={`/agents/${encodeURIComponent(a.id)}/edit`}
            className="mono"
            style={{ color: 'var(--color-text)', textDecoration: 'none' }}
          >
            {a.id}
          </Link>
          <span>{a.config.name}</span>
          <span className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
            {a.config.runner ?? 'stream-json'}
          </span>
          <span className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
            {a.config.triggerMode}
          </span>
          <span className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
            {relativeTime(a.updatedAt)}
          </span>
          <div className="flex items-center gap-3">
            {a.active ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Deactivate agent "${a.id}"? Pipeline history stays intact.`)) {
                    del.mutate(a.id);
                  }
                }}
                className="mono dim"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 'var(--text-xs)',
                }}
                disabled={del.isPending}
              >
                deactivate
              </button>
            ) : (
              <span className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
                inactive
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
