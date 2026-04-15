/**
 * PipelineDetail — per-pipeline view showing state, metadata, timeline,
 * and allowed actions (retry / cancel).
 *
 * Polling strategy:
 *   - In-flight (provisioning/dispatching/running): poll every 2 seconds
 *   - Terminal (succeeded/failed/cancelled/stalled): no polling, single fetch
 *
 * This keeps the dashboard responsive during active work without burning
 * DB quota on pipelines that aren't changing.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  cancelPipeline,
  getPipeline,
  listBoards,
  retryPipeline,
} from '../lib/api-client.js';
import { Header } from '../components/Header.js';
import { StatusDot } from '../components/StatusDot.js';
import { useToast } from '../components/Toast.js';
import { relativeTime, shortId, isInFlight } from '../lib/format.js';
import type {
  PipelineDetailResponse,
  PipelineSummary,
  TimelineEvent,
} from '../lib/api-types.js';

export function PipelineDetail() {
  const { id } = useParams<{ id: string }>();
  const instanceId = id ?? '';

  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: listBoards,
    staleTime: 30_000,
  });

  const detailQuery = useQuery({
    queryKey: ['pipeline', instanceId],
    queryFn: () => getPipeline(instanceId),
    enabled: instanceId.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data as PipelineDetailResponse | undefined;
      if (data === undefined) return 2_000;
      return isInFlight(data.pipeline.status) ? 2_000 : false;
    },
  });

  return (
    <div className="min-h-screen">
      <Header boardCount={boardsQuery.data?.items.length ?? 0} />
      <main
        className="mx-auto"
        style={{
          maxWidth: '1280px',
          padding: 'var(--space-5) var(--space-6) var(--space-8)',
        }}
      >
        <Breadcrumb instanceId={instanceId} />

        {detailQuery.isLoading ? (
          <DetailSkeleton />
        ) : detailQuery.isError ? (
          <ErrorState error={detailQuery.error} />
        ) : detailQuery.data !== undefined ? (
          <DetailContent data={detailQuery.data} />
        ) : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function Breadcrumb({ instanceId }: { instanceId: string }) {
  return (
    <nav
      className="flex items-center gap-2 mono faint"
      style={{ fontSize: 'var(--text-xs)', marginBottom: 'var(--space-5)' }}
    >
      <Link to="/" style={{ color: 'inherit' }}>
        pipelines
      </Link>
      <span aria-hidden>/</span>
      <span style={{ color: 'var(--color-text-dim)' }}>{shortId(instanceId)}</span>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

interface DetailContentProps {
  data: PipelineDetailResponse;
}

function DetailContent({ data }: DetailContentProps) {
  const { pipeline, timeline } = data;

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
        gap: 'var(--space-5)',
        alignItems: 'start',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        <DetailHeader pipeline={pipeline} />
        <TimelineCard timeline={timeline} />
      </div>
      <MetaCard pipeline={pipeline} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header with status + title + actions
// ---------------------------------------------------------------------------

function DetailHeader({ pipeline }: { pipeline: PipelineSummary }) {
  return (
    <section className="surface" style={{ padding: 'var(--space-5)' }}>
      <div
        className="flex items-center gap-3"
        style={{ marginBottom: 'var(--space-3)' }}
      >
        <StatusDot status={pipeline.status} label />
        <span className="faint mono" style={{ fontSize: 'var(--text-xs)' }}>
          attempt {pipeline.attempt}
        </span>
      </div>

      <h1
        className="mono"
        style={{
          fontSize: 'var(--text-lg)',
          letterSpacing: '-0.01em',
          marginBottom: 'var(--space-2)',
          wordBreak: 'break-all',
        }}
      >
        {pipeline.cardId}
      </h1>

      <p className="dim mono" style={{ fontSize: 'var(--text-xs)' }}>
        <span className="faint">id</span> {pipeline.id}
      </p>

      <div
        style={{
          marginTop: 'var(--space-4)',
          paddingTop: 'var(--space-4)',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <ActionButtons pipeline={pipeline} />
        {pipeline.prUrl !== null && pipeline.prUrl !== undefined && (
          <a
            href={pipeline.prUrl}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-accent-dim)',
              color: 'var(--color-accent)',
              fontSize: 'var(--text-sm)',
            }}
          >
            open PR →
          </a>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Action buttons (retry / cancel) with two-step confirmation
// ---------------------------------------------------------------------------

function ActionButtons({ pipeline }: { pipeline: PipelineSummary }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<'retry' | 'cancel' | null>(null);

  const retryMutation = useMutation({
    mutationFn: () => retryPipeline(pipeline.id),
    onSuccess: () => {
      toast.push({ kind: 'success', message: 'Retry dispatched' });
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['pipeline', pipeline.id] });
    },
    onError: (err) => {
      toast.push({
        kind: 'error',
        message: `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelPipeline(pipeline.id),
    onSuccess: () => {
      toast.push({ kind: 'success', message: 'Cancel dispatched' });
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['pipeline', pipeline.id] });
    },
    onError: (err) => {
      toast.push({
        kind: 'error',
        message: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
  });

  const canRetry = pipeline.allowedActions.includes('retry');
  const canCancel = pipeline.allowedActions.includes('cancel');

  if (!canRetry && !canCancel) {
    return (
      <span className="faint mono" style={{ fontSize: 'var(--text-xs)' }}>
        no actions available
      </span>
    );
  }

  return (
    <>
      {canRetry && (
        <ActionButton
          kind="primary"
          loading={retryMutation.isPending}
          confirming={confirming === 'retry'}
          label="retry"
          confirmLabel="confirm retry"
          onActivate={() => setConfirming('retry')}
          onConfirm={() => retryMutation.mutate()}
          onCancel={() => setConfirming(null)}
        />
      )}
      {canCancel && (
        <ActionButton
          kind="danger"
          loading={cancelMutation.isPending}
          confirming={confirming === 'cancel'}
          label="cancel"
          confirmLabel="confirm cancel"
          onActivate={() => setConfirming('cancel')}
          onConfirm={() => cancelMutation.mutate()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

interface ActionButtonProps {
  kind: 'primary' | 'danger';
  loading: boolean;
  confirming: boolean;
  label: string;
  confirmLabel: string;
  onActivate: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function ActionButton({
  kind,
  loading,
  confirming,
  label,
  confirmLabel,
  onActivate,
  onConfirm,
  onCancel,
}: ActionButtonProps) {
  const color =
    kind === 'danger' ? 'var(--color-status-failed)' : 'var(--color-accent)';

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className="mono"
          style={{
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-sm)',
            background: color,
            color: 'var(--color-bg)',
            border: 'none',
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'dispatching…' : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="mono faint"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            background: 'transparent',
            border: 'none',
            fontSize: 'var(--text-xs)',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onActivate}
      className="mono"
      style={{
        padding: 'var(--space-2) var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        color,
        border: `1px solid ${color}`,
        fontSize: 'var(--text-sm)',
        cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out-expo)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-bg-sunken)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Metadata sidebar
// ---------------------------------------------------------------------------

function MetaCard({ pipeline }: { pipeline: PipelineSummary }) {
  const rows: Array<[string, string]> = [
    ['board', pipeline.boardId],
    ['project', pipeline.projectId ?? '—'],
    ['created', relativeTime(pipeline.createdAt)],
    ['updated', relativeTime(pipeline.updatedAt)],
  ];

  if (pipeline.cost !== undefined && pipeline.cost !== null) {
    rows.push(['cost', `$${pipeline.cost.toFixed(4)}`]);
  }
  if (pipeline.tokensUsed !== undefined && pipeline.tokensUsed !== null) {
    rows.push(['tokens', pipeline.tokensUsed.toLocaleString()]);
  }

  return (
    <section className="surface" style={{ padding: 'var(--space-5)' }}>
      <h2
        className="faint mono uppercase tracking-wide"
        style={{
          fontSize: 'var(--text-xs)',
          marginBottom: 'var(--space-4)',
        }}
      >
        metadata
      </h2>
      <dl
        className="grid"
        style={{
          gridTemplateColumns: 'auto 1fr',
          gap: 'var(--space-2) var(--space-4)',
          margin: 0,
        }}
      >
        {rows.map(([label, value]) => (
          <MetaRow key={label} label={label} value={value} />
        ))}
      </dl>
    </section>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt
        className="faint mono uppercase tracking-wide"
        style={{ fontSize: 'var(--text-xs)' }}
      >
        {label}
      </dt>
      <dd
        className="mono"
        style={{
          fontSize: 'var(--text-xs)',
          margin: 0,
          color: 'var(--color-text-dim)',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Timeline — editorial list of events
// ---------------------------------------------------------------------------

function TimelineCard({ timeline }: { timeline: TimelineEvent[] }) {
  if (timeline.length === 0) {
    return (
      <section className="surface" style={{ padding: 'var(--space-5)' }}>
        <h2
          className="faint mono uppercase tracking-wide"
          style={{
            fontSize: 'var(--text-xs)',
            marginBottom: 'var(--space-3)',
          }}
        >
          timeline
        </h2>
        <p className="dim" style={{ fontSize: 'var(--text-sm)' }}>
          No events recorded yet.
        </p>
      </section>
    );
  }

  // Most-recent first.
  const sorted = [...timeline].sort((a, b) => b.sequence - a.sequence);

  return (
    <section className="surface" style={{ padding: 'var(--space-5)' }}>
      <h2
        className="faint mono uppercase tracking-wide"
        style={{
          fontSize: 'var(--text-xs)',
          marginBottom: 'var(--space-4)',
        }}
      >
        timeline · {timeline.length} events
      </h2>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {sorted.map((event) => (
          <TimelineRow key={event.id} event={event} />
        ))}
      </ol>
    </section>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  // Extract the last segment of the topic for the primary label.
  const segments = event.topic.split('.');
  const head = segments.slice(0, -1).join('.');
  const tail = segments[segments.length - 1] ?? event.topic;

  return (
    <li
      className="grid items-baseline"
      style={{
        gridTemplateColumns: '3rem 1fr 7rem',
        gap: 'var(--space-3)',
        paddingBottom: 'var(--space-3)',
        borderBottom: '1px dashed var(--color-border)',
      }}
    >
      <span
        className="mono faint"
        style={{ fontSize: 'var(--text-xs)', textAlign: 'right' }}
      >
        #{event.sequence}
      </span>
      <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>
        <span className="faint">{head}.</span>
        <span style={{ color: 'var(--color-accent)' }}>{tail}</span>
      </span>
      <span
        className="faint mono"
        style={{ fontSize: 'var(--text-xs)', textAlign: 'right' }}
        title={event.occurredAt}
      >
        {relativeTime(event.occurredAt)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function DetailSkeleton() {
  return (
    <div
      className="surface"
      style={{
        padding: 'var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <div
        style={{
          width: '40%',
          height: '1rem',
          background: 'var(--color-bg-sunken)',
          borderRadius: 'var(--radius-sm)',
        }}
      />
      <div
        style={{
          width: '70%',
          height: '0.75rem',
          background: 'var(--color-bg-sunken)',
          borderRadius: 'var(--radius-sm)',
        }}
      />
      <div
        style={{
          width: '55%',
          height: '0.75rem',
          background: 'var(--color-bg-sunken)',
          borderRadius: 'var(--radius-sm)',
        }}
      />
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      className="surface"
      style={{
        padding: 'var(--space-6)',
        borderColor: 'var(--color-status-failed)',
      }}
    >
      <h2
        style={{
          fontSize: 'var(--text-md)',
          color: 'var(--color-status-failed)',
          marginBottom: 'var(--space-2)',
        }}
      >
        Could not load pipeline
      </h2>
      <p className="dim mono" style={{ fontSize: 'var(--text-sm)' }}>
        {message}
      </p>
      <Link
        to="/"
        className="mono"
        style={{
          display: 'inline-block',
          marginTop: 'var(--space-4)',
          fontSize: 'var(--text-sm)',
        }}
      >
        ← back to pipelines
      </Link>
    </div>
  );
}
