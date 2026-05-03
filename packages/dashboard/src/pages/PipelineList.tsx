/**
 * PipelineList — the default landing page.
 *
 * Shows a board picker (if >1 board configured) and a dense table of the
 * most recent pipelines for the selected board. Polls every 3 seconds so
 * status dots update near-live.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ApiError,
  listBoards,
  listPipelines,
  resetPipeline,
} from '../lib/api-client.js';
import { Header } from '../components/Header.js';
import { StatusDot } from '../components/StatusDot.js';
import { EmptyState } from '../components/EmptyState.js';
import {
  dwellMs,
  formatDwell,
  isOverDwellBudget,
  isZeroTokenAnomaly,
  relativeTime,
  shortId,
} from '../lib/format.js';
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
          <PipelineTable pipelines={pipelines} selectedBoardId={selectedBoardId!} />
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

function PipelineTable({
  pipelines,
  selectedBoardId,
}: {
  pipelines: PipelineSummary[];
  selectedBoardId: string;
}) {
  // Sort most-recent first.
  const sorted = useMemo(
    () => [...pipelines].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [pipelines],
  );

  const queryClient = useQueryClient();
  const [resetError, setResetError] = useState<string | null>(null);

  const resetMutation = useMutation({
    mutationFn: (id: string) => resetPipeline(id),
    onSuccess: async () => {
      setResetError(null);
      await queryClient.invalidateQueries({
        queryKey: ['pipelines', selectedBoardId],
      });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setResetError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setResetError(err.message);
      } else {
        setResetError('Reset failed — see console.');
      }
    },
  });

  const COLUMNS = '2.5rem 7rem 9rem 1fr 4rem 6rem 9rem';

  return (
    <div className="surface" style={{ overflow: 'hidden' }}>
      <div
        className="grid faint mono uppercase tracking-wide"
        style={{
          gridTemplateColumns: COLUMNS,
          gap: 'var(--space-4)',
          padding: 'var(--space-3) var(--space-5)',
          fontSize: 'var(--text-xs)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span />
        <span>dwell</span>
        <span>id</span>
        <span>card</span>
        <span style={{ textAlign: 'right' }}>attempt</span>
        <span>updated</span>
        <span style={{ textAlign: 'right' }}>actions</span>
      </div>
      {resetError !== null && (
        <div
          role="alert"
          className="mono"
          style={{
            padding: 'var(--space-2) var(--space-5)',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-status-failed, #bf616a)',
            background: 'rgba(191, 97, 106, 0.08)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          reset failed — {resetError}
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {sorted.map((p) => (
          <PipelineRow
            key={p.id}
            pipeline={p}
            columns={COLUMNS}
            isResetting={resetMutation.isPending && resetMutation.variables === p.id}
            onReset={(id) => {
              setResetError(null);
              resetMutation.mutate(id);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

interface PipelineRowProps {
  pipeline: PipelineSummary;
  columns: string;
  isResetting: boolean;
  onReset: (id: string) => void;
}

function PipelineRow({ pipeline, columns, isResetting, onReset }: PipelineRowProps) {
  const overBudget = isOverDwellBudget(pipeline);
  const dwellLabel = pipelineHasDwell(pipeline) ? formatDwell(dwellMs(pipeline)) : '—';
  const dwellColor = overBudget
    ? 'var(--color-status-failed, #bf616a)'
    : 'var(--color-text-faint, var(--color-text))';
  const dwellTitle = pipelineHasDwell(pipeline)
    ? `in ${pipeline.status} for ${formatDwell(dwellMs(pipeline))}` +
      (pipeline.dwellBudgetMs !== null && pipeline.dwellBudgetMs !== undefined
        ? ` — budget ${formatDwell(pipeline.dwellBudgetMs)}` +
          (overBudget ? ' (over budget; reconciler will time out next tick)' : '')
        : '')
    : `${pipeline.status} — no dwell budget`;

  return (
    <li style={{ borderTop: '1px solid var(--color-border)' }}>
      <Link
        to={`/pipelines/${pipeline.id}`}
        className="grid items-center"
        style={{
          gridTemplateColumns: columns,
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
          className="mono"
          title={dwellTitle}
          data-testid="dwell-badge"
          data-over-budget={overBudget ? 'true' : 'false'}
          style={{
            fontSize: 'var(--text-xs)',
            color: dwellColor,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            ...(overBudget && {
              fontWeight: 600,
            }),
          }}
        >
          {dwellLabel}
        </span>

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
          {pipeline.allowedActions.map((action) => {
            if (action === 'reset') {
              return (
                <button
                  key={action}
                  type="button"
                  data-testid="reset-button"
                  disabled={isResetting}
                  aria-label={`Reset pipeline ${shortId(pipeline.id)} to idle`}
                  title={`Admin reset → idle. Cancels in-flight agent + workspace; emits pipeline.admin_reset audit event. From state "${pipeline.status}".`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onReset(pipeline.id);
                  }}
                  className="mono"
                  style={{
                    padding: '2px var(--space-2)',
                    border: '1px solid var(--color-border-strong)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'transparent',
                    color: 'var(--color-text)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontSize: 'var(--text-xs)',
                    cursor: isResetting ? 'wait' : 'pointer',
                    opacity: isResetting ? 0.5 : 1,
                    transition: 'background var(--dur-fast) var(--ease-out-expo)',
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = 'var(--color-bg-sunken)')
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = 'transparent')
                  }
                >
                  {isResetting ? 'resetting…' : 'reset'}
                </button>
              );
            }
            return (
              <span
                key={action}
                className="mono faint"
                style={{ textTransform: 'uppercase' }}
              >
                {action}
              </span>
            );
          })}
        </div>
      </Link>
    </li>
  );
}

/**
 * True when the pipeline's current status has a dwell budget worth showing.
 * Mirrors the engine's `reconcilableStatuses()` envelope: idle / succeeded /
 * failed / cancelled have no dwell concept (they're terminal or pre-dispatch),
 * so the badge renders "—" to keep the column visually quiet for them.
 */
function pipelineHasDwell(p: PipelineSummary): boolean {
  return (
    p.status === 'provisioning' ||
    p.status === 'dispatching' ||
    p.status === 'running' ||
    p.status === 'awaiting_review' ||
    p.status === 'stalled'
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
