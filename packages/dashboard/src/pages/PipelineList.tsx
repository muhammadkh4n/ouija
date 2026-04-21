/**
 * PipelineList — the default landing page.
 *
 * Shows a board picker (if >1 board configured) and a dense table of the
 * most recent pipelines for the selected board. Polls every 3 seconds so
 * status dots update near-live.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listBoards, listPipelines } from '../lib/api-client.js';
import { Header } from '../components/Header.js';
import { StatusDot } from '../components/StatusDot.js';
import { EmptyState } from '../components/EmptyState.js';
import { relativeTime, shortId, isZeroTokenAnomaly } from '../lib/format.js';
import type { PipelineSummary } from '../lib/api-types.js';

const BOARD_STORAGE_KEY = 'ouija:selectedBoardId';

export function PipelineList() {
  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: listBoards,
    staleTime: 30_000,
  });

  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(BOARD_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  // Auto-select the first board once the list loads (if nothing is saved).
  useEffect(() => {
    if (selectedBoardId !== null) return;
    const first = boardsQuery.data?.items[0];
    if (first !== undefined) {
      setSelectedBoardId(first.boardId);
    }
  }, [boardsQuery.data, selectedBoardId]);

  // Persist selection.
  useEffect(() => {
    if (selectedBoardId !== null) {
      try {
        window.localStorage.setItem(BOARD_STORAGE_KEY, selectedBoardId);
      } catch {
        /* ignore */
      }
    }
  }, [selectedBoardId]);

  const pipelinesQuery = useQuery({
    queryKey: ['pipelines', selectedBoardId],
    queryFn: () => listPipelines(selectedBoardId!),
    enabled: selectedBoardId !== null,
    refetchInterval: 3_000,
  });

  const boards = boardsQuery.data?.items ?? [];
  const pipelines = pipelinesQuery.data?.items ?? [];

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
        <SectionHeader
          title="Pipelines"
          subtitle={
            pipelinesQuery.isFetching && !pipelinesQuery.isPending
              ? 'refreshing…'
              : `${pipelines.length} tracked`
          }
          boards={boards}
          selectedBoardId={selectedBoardId}
          onSelectBoard={setSelectedBoardId}
        />

        {boardsQuery.isLoading ? (
          <SkeletonRows count={6} />
        ) : boards.length === 0 ? (
          <EmptyState
            title="No boards configured"
            hint="Add a `boards:` section to ouija.config.yaml and restart the server, then refresh this page."
          />
        ) : pipelines.length === 0 ? (
          <EmptyState
            title="No pipelines yet"
            hint="Move a card into a dispatch column in your kanban board. Ouija will create a pipeline and it will appear here."
          />
        ) : (
          <PipelineTable pipelines={pipelines} />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header with board picker
// ---------------------------------------------------------------------------

interface SectionHeaderProps {
  title: string;
  subtitle: string;
  boards: Array<{ boardId: string }>;
  selectedBoardId: string | null;
  onSelectBoard: (id: string) => void;
}

function SectionHeader({
  title,
  subtitle,
  boards,
  selectedBoardId,
  onSelectBoard,
}: SectionHeaderProps) {
  return (
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
          {title}
        </h2>
        <span className="dim mono" style={{ fontSize: 'var(--text-xs)' }}>
          {subtitle}
        </span>
      </div>

      {boards.length > 1 && selectedBoardId !== null && (
        <label
          className="flex items-center gap-2"
          style={{ fontSize: 'var(--text-xs)' }}
        >
          <span className="dim mono uppercase tracking-wide">board</span>
          <select
            value={selectedBoardId}
            onChange={(e) => onSelectBoard(e.target.value)}
            className="mono sunken"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              color: 'var(--color-text)',
              fontSize: 'var(--text-sm)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
            }}
          >
            {boards.map((b) => (
              <option key={b.boardId} value={b.boardId}>
                {b.boardId}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline table — editorial list, not a stock card grid
// ---------------------------------------------------------------------------

function PipelineTable({ pipelines }: { pipelines: PipelineSummary[] }) {
  // Sort most-recent first.
  const sorted = useMemo(
    () => [...pipelines].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [pipelines],
  );

  return (
    <div
      className="surface"
      style={{ overflow: 'hidden' }}
    >
      <div
        className="grid faint mono uppercase tracking-wide"
        style={{
          gridTemplateColumns: '2.5rem 10rem 1fr 4rem 6rem 8rem',
          gap: 'var(--space-4)',
          padding: 'var(--space-3) var(--space-5)',
          fontSize: 'var(--text-xs)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span />
        <span>id</span>
        <span>card</span>
        <span style={{ textAlign: 'right' }}>attempt</span>
        <span>updated</span>
        <span style={{ textAlign: 'right' }}>actions</span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {sorted.map((p) => (
          <PipelineRow key={p.id} pipeline={p} />
        ))}
      </ul>
    </div>
  );
}

function PipelineRow({ pipeline }: { pipeline: PipelineSummary }) {
  return (
    <li style={{ borderTop: '1px solid var(--color-border)' }}>
      <Link
        to={`/pipelines/${pipeline.id}`}
        className="grid items-center"
        style={{
          gridTemplateColumns: '2.5rem 10rem 1fr 4rem 6rem 8rem',
          gap: 'var(--space-4)',
          padding: 'var(--space-3) var(--space-5)',
          color: 'var(--color-text)',
          textDecoration: 'none',
          transition: 'background var(--dur-fast) var(--ease-out-expo)',
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = 'var(--color-bg-sunken)')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = 'transparent')
        }
      >
        <StatusDot status={pipeline.status} />

        <span
          className="mono dim"
          title={pipeline.id}
          style={{ fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}
        >
          {shortId(pipeline.id)}
        </span>

        <span
          className="mono"
          title={pipeline.cardId}
          style={{
            fontSize: 'var(--text-sm)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {pipeline.cardId}
        </span>

        <span
          className="mono dim"
          style={{ fontSize: 'var(--text-sm)', textAlign: 'right' }}
        >
          {pipeline.attempt}
        </span>

        <span
          className="faint"
          style={{ fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}
        >
          {relativeTime(pipeline.updatedAt)}
        </span>

        <div
          className="flex items-center justify-end gap-2"
          style={{ fontSize: 'var(--text-xs)' }}
        >
          {isZeroTokenAnomaly(pipeline) && (
            <span
              className="mono"
              title="Succeeded with no tokens reported and no PR opened — likely pre-v0.4.0 historical row or a runner that skipped outcome reporting. See Ouija friction-log item #21."
              style={{
                padding: '2px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(191, 97, 106, 0.15)',
                color: 'var(--color-status-failed, #bf616a)',
                border: '1px solid var(--color-status-failed, #bf616a)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
              data-testid="zero-token-anomaly-badge"
            >
              ⚠ 0 tokens
            </span>
          )}
          {pipeline.prUrl !== null && pipeline.prUrl !== undefined && (
            <span
              className="mono"
              style={{ color: 'var(--color-accent)' }}
            >
              pr →
            </span>
          )}
          {pipeline.allowedActions.map((action) => (
            <span
              key={action}
              className="mono faint"
              style={{ textTransform: 'uppercase' }}
            >
              {action}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="surface">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            padding: 'var(--space-4) var(--space-5)',
            borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
          }}
        >
          <div
            style={{
              width: '60%',
              height: '0.75rem',
              background: 'var(--color-bg-sunken)',
              borderRadius: 'var(--radius-sm)',
            }}
          />
        </div>
      ))}
    </div>
  );
}
