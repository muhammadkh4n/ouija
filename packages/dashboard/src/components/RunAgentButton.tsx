/**
 * RunAgentButton — header-mounted operator action that dispatches an agent
 * without touching the kanban board.
 *
 * Targets `POST /api/v1/pipelines/dispatch` (Phase 2 Task 7). Closes
 * friction-log #17 (no path to the first agent run when kanban is broken
 * or absent). Renders as an inline panel rather than a true dialog to
 * keep keyboard-trap + focus-management complexity out of v1; a `<dialog>`
 * upgrade is queued for the v0.5.0 dashboard polish pass.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, listAgents, runAgent } from '../lib/api-client.js';
import type { AgentRecord } from '../lib/api-types.js';

interface RunAgentButtonProps {
  /** The board the dispatched pipeline should target (required to invalidate the right cache). */
  boardId: string;
}

export function RunAgentButton({ boardId }: RunAgentButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col" style={{ gap: 'var(--space-3)' }}>
      <button
        type="button"
        data-testid="run-agent-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="run-agent-form"
        className="mono"
        style={{
          padding: 'var(--space-2) var(--space-4)',
          border: '1px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-sm)',
          background: open
            ? 'var(--color-bg-sunken)'
            : 'var(--color-accent, var(--color-text))',
          color: open ? 'var(--color-text)' : 'var(--color-bg, white)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          fontSize: 'var(--text-xs)',
          cursor: 'pointer',
          fontWeight: 600,
          alignSelf: 'flex-end',
          transition: 'background var(--dur-fast) var(--ease-out-expo)',
        }}
      >
        {open ? 'cancel' : '+ run agent'}
      </button>
      {open && (
        <RunAgentForm
          boardId={boardId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

interface RunAgentFormProps {
  boardId: string;
  onClose: () => void;
}

function RunAgentForm({ boardId, onClose }: RunAgentFormProps): JSX.Element {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['agents', { active: true }],
    queryFn: () => listAgents(false),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: () => runAgent({ agentId, title, description, boardId }),
    onSuccess: async () => {
      setError(null);
      setTitle('');
      setDescription('');
      await queryClient.invalidateQueries({ queryKey: ['pipelines', boardId] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Dispatch failed — see console.');
      }
    },
  });

  const agents: AgentRecord[] = agentsQuery.data?.items ?? [];
  const submitDisabled =
    mutation.isPending ||
    agentId.trim().length === 0 ||
    title.trim().length === 0 ||
    description.trim().length === 0;

  return (
    <form
      id="run-agent-form"
      data-testid="run-agent-form"
      className="surface flex flex-col"
      style={{
        padding: 'var(--space-4) var(--space-5)',
        gap: 'var(--space-3)',
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitDisabled) mutation.mutate();
      }}
    >
      <h3
        className="mono uppercase tracking-wide faint"
        style={{ fontSize: 'var(--text-xs)', margin: 0 }}
      >
        run agent — {boardId}
      </h3>

      <label className="flex flex-col" style={{ gap: 'var(--space-1)' }}>
        <span
          className="mono uppercase tracking-wide dim"
          style={{ fontSize: 'var(--text-xs)' }}
        >
          agent
        </span>
        <select
          required
          data-testid="run-agent-agent-select"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
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
          <option value="">
            {agentsQuery.isLoading ? 'loading…' : '— pick an agent —'}
          </option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.config.name} ({a.id})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col" style={{ gap: 'var(--space-1)' }}>
        <span
          className="mono uppercase tracking-wide dim"
          style={{ fontSize: 'var(--text-xs)' }}
        >
          task title
        </span>
        <input
          required
          type="text"
          maxLength={300}
          data-testid="run-agent-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Bump deps to latest minor"
          className="mono sunken"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            color: 'var(--color-text)',
            fontSize: 'var(--text-sm)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
          }}
        />
      </label>

      <label className="flex flex-col" style={{ gap: 'var(--space-1)' }}>
        <span
          className="mono uppercase tracking-wide dim"
          style={{ fontSize: 'var(--text-xs)' }}
        >
          task description
        </span>
        <textarea
          required
          rows={4}
          maxLength={10_000}
          data-testid="run-agent-description-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Run npm-check-updates and open a PR with the diff."
          className="mono sunken"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            color: 'var(--color-text)',
            fontSize: 'var(--text-sm)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />
      </label>

      {error !== null && (
        <div
          role="alert"
          className="mono"
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-status-failed, #bf616a)',
            background: 'rgba(191, 97, 106, 0.08)',
            border: '1px solid var(--color-status-failed, #bf616a)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          dispatch failed — {error}
        </div>
      )}

      <div
        className="flex items-center justify-end"
        style={{ gap: 'var(--space-2)' }}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={mutation.isPending}
          className="mono"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--color-text)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontSize: 'var(--text-xs)',
            cursor: 'pointer',
          }}
        >
          cancel
        </button>
        <button
          type="submit"
          data-testid="run-agent-submit"
          disabled={submitDisabled}
          className="mono"
          style={{
            padding: 'var(--space-2) var(--space-4)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-sm)',
            background: submitDisabled
              ? 'var(--color-bg-sunken)'
              : 'var(--color-accent, var(--color-text))',
            color: submitDisabled ? 'var(--color-text)' : 'var(--color-bg, white)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            cursor: submitDisabled ? 'not-allowed' : 'pointer',
            opacity: submitDisabled ? 0.6 : 1,
          }}
        >
          {mutation.isPending ? 'dispatching…' : 'dispatch'}
        </button>
      </div>
    </form>
  );
}
