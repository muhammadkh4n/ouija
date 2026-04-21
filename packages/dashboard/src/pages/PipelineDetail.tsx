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

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  cancelPipeline,
  getPipeline,
  listBoards,
  retryPipeline,
} from '../lib/api-client.js';
import { streamPipelineEvents } from '../lib/pipeline-stream.js';
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
  const qc = useQueryClient();
  const [streamLive, setStreamLive] = useState(false);
  const [latestMessage, setLatestMessage] = useState<string | null>(null);

  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: listBoards,
    staleTime: 30_000,
  });

  const detailQuery = useQuery({
    queryKey: ['pipeline', instanceId],
    queryFn: () => getPipeline(instanceId),
    enabled: instanceId.length > 0,
    // SSE is the primary update channel. Polling stays on as a fallback
    // at a slower cadence when the stream drops or for the brief window
    // before the handshake completes.
    refetchInterval: (query) => {
      const data = query.state.data as PipelineDetailResponse | undefined;
      if (data === undefined) return 2_000;
      if (!isInFlight(data.pipeline.status)) return false;
      return streamLive ? 10_000 : 2_000;
    },
  });

  // Live event stream — one connection per in-flight pipeline. The stream
  // pushes progress updates, PR links, and terminal state into the cache
  // so the UI reflects changes without waiting for the next poll tick.
  useEffect(() => {
    if (instanceId.length === 0) return;
    const status = detailQuery.data?.pipeline.status;
    if (status !== undefined && !isInFlight(status)) return;

    const stop = streamPipelineEvents(instanceId, {
      onOpen: () => setStreamLive(true),
      onError: () => setStreamLive(false),
      onFrame: (frame) => {
        if (frame.event === 'ready' || frame.event === 'message') return;

        // Any agent-scoped frame means state has changed — refresh the
        // detail query so timeline + status + PR URL update from the
        // authoritative REST endpoint.
        void qc.invalidateQueries({ queryKey: ['pipeline', instanceId] });

        if (frame.event === 'agent.work.progress') {
          const payload = (frame.data as {
            payload?: { message?: string };
          }).payload;
          if (typeof payload?.message === 'string' && payload.message.length > 0) {
            setLatestMessage(payload.message);
          }
        }
      },
    });
    return () => {
      stop();
      setStreamLive(false);
    };
  }, [instanceId, detailQuery.data?.pipeline.status, qc]);

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
          <DetailContent
            data={detailQuery.data}
            streamLive={streamLive}
            latestMessage={latestMessage}
          />
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
  streamLive: boolean;
  latestMessage: string | null;
}

function DetailContent({ data, streamLive, latestMessage }: DetailContentProps) {
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
        <DetailHeader
          pipeline={pipeline}
          streamLive={streamLive}
          latestMessage={latestMessage}
        />
        <TimelineCard timeline={timeline} />
      </div>
      <MetaCard pipeline={pipeline} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header with status + title + actions
// ---------------------------------------------------------------------------

function DetailHeader({
  pipeline,
  streamLive,
  latestMessage,
}: {
  pipeline: PipelineSummary;
  streamLive: boolean;
  latestMessage: string | null;
}) {
  const showLiveBadge = streamLive && isInFlight(pipeline.status);

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
        {pipeline.iteration !== undefined && pipeline.iteration !== null && pipeline.iteration > 1 && (
          <span
            className="mono"
            style={{
              fontSize: 'var(--text-xs)',
              padding: '2px var(--space-2)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-status-review, rgba(180, 142, 173, 0.15))',
              color: 'var(--color-status-review, #b48ead)',
              border: '1px solid var(--color-status-review, #b48ead)',
            }}
            title="Review-loop iteration count (reviewer feedback or CI failures have triggered follow-up dispatches)"
          >
            iter {pipeline.iteration}
          </span>
        )}
        {showLiveBadge && <LiveBadge />}
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

      {latestMessage !== null && isInFlight(pipeline.status) && (
        <p
          className="mono"
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-dim)',
            background: 'var(--color-bg-sunken)',
            borderLeft: '2px solid var(--color-accent-dim)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            wordBreak: 'break-word',
          }}
        >
          <span className="faint">agent:</span> {latestMessage}
        </p>
      )}

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
        {pipeline.sessionLogPath !== null && pipeline.sessionLogPath !== undefined && (
          <SessionLogButton path={pipeline.sessionLogPath} />
        )}
      </div>
    </section>
  );
}

/**
 * "View session" button — surfaces the absolute path to the agent's NDJSON
 * session log (friction-log item #22). Clicking copies the path to the
 * clipboard so self-hosters can `cat` it from their terminal. Intentionally
 * no in-dashboard viewer yet: reading arbitrary paths from the agent's HOME
 * requires a scoped file-read endpoint that's out of scope for v0.4.0.
 */
function SessionLogButton({ path }: { path: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onClick = (): void => {
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => {
        // Clipboard unavailable (older browsers, insecure context) — fall back
        // to visible-path prompt so the user can still copy manually.
        window.prompt('session log path', path);
      });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      title={path}
      style={{
        padding: 'var(--space-2) var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border)',
        background: 'transparent',
        color: 'var(--color-text-muted)',
        fontSize: 'var(--text-sm)',
        cursor: 'pointer',
      }}
    >
      {copied ? 'copied ✓' : 'view session log'}
    </button>
  );
}

function LiveBadge() {
  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-accent)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: '0.5rem',
          height: '0.5rem',
          borderRadius: '999px',
          background: 'var(--color-accent)',
          animation: 'pulse 1.2s ease-in-out infinite',
        }}
      />
      live
    </span>
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
