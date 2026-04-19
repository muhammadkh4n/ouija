/**
 * AgentForm — create or edit an agent.
 *
 * Single form covers identity, auth, runner, system prompt, repos, and limits.
 * When editing, the config is prefilled from GET /api/v1/agents/:id and
 * secretFields surfaces which credentials are already set (values never leave
 * the server). A secret input is only persisted when the user types a fresh
 * value; blank means "leave as-is" on PUT.
 *
 * Server-side validation (validateAgentProfile in @ouija-dev/config) is the
 * canonical gate. The UI enforces only the minimal shape needed to submit.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createAgent,
  getAgent,
  listBoards,
  updateAgent,
  ApiError,
} from '../lib/api-client.js';
import { Header } from '../components/Header.js';
import { useToast } from '../components/Toast.js';
import type {
  AgentProfileConfig,
  AgentRepoConfig,
  AuthMethod,
  RunnerType,
  TriggerMode,
} from '../lib/api-types.js';

const AUTH_METHODS: AuthMethod[] = ['api-key', 'bedrock', 'vertex', 'foundry', 'api-key-helper', 'proxy'];
const RUNNER_TYPES: RunnerType[] = ['stream-json', 'local', 'sdk'];
const TRIGGER_MODES: TriggerMode[] = ['auto', 'manual'];

interface FormState {
  id: string;
  name: string;
  email: string;
  model: string;
  triggerMode: TriggerMode;
  runner: RunnerType;
  systemPrompt: string;
  authMethod: AuthMethod;
  secretRef: string;
  secretValue: string; // only sent when non-empty
  repos: AgentRepoConfig[];
  maxDurationMin: number;
  /** Review loop toggles — see packages/config/src/types.ts ReviewLoopConfig. */
  reviewLoopEnabled: boolean;
  /** Comma-separated list, trimmed on submit. Empty string → undefined. */
  ignoreReviewers: string;
  triggerReviewers: string;
  ignoreWorkflows: string;
  maxReviewIterations: number;
}

function emptyForm(): FormState {
  return {
    id: '',
    name: '',
    email: '',
    model: 'claude-sonnet-4-20250514',
    triggerMode: 'auto',
    runner: 'stream-json',
    systemPrompt: '',
    authMethod: 'api-key',
    secretRef: 'env:ANTHROPIC_API_KEY',
    secretValue: '',
    repos: [{ url: '', baseBranch: 'main', default: true }],
    maxDurationMin: 30,
    reviewLoopEnabled: true,
    ignoreReviewers: '',
    triggerReviewers: '',
    ignoreWorkflows: '',
    maxReviewIterations: 5,
  };
}

function csvToList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function configToForm(config: AgentProfileConfig): FormState {
  const rl = config.reviewLoop;
  return {
    id: config.id,
    name: config.name,
    email: config.email,
    model: config.model,
    triggerMode: config.triggerMode,
    runner: config.runner ?? 'stream-json',
    systemPrompt: config.systemPrompt ?? '',
    authMethod: config.auth.method,
    secretRef: config.auth.secretRef,
    secretValue: '',
    repos: config.repos.map((r) => ({ ...r })),
    maxDurationMin: Math.round(config.limits.maxDurationMs / 60_000),
    reviewLoopEnabled: rl?.enabled ?? true,
    ignoreReviewers: (rl?.ignoreReviewers ?? []).join(', '),
    triggerReviewers: (rl?.triggerReviewers ?? []).join(', '),
    ignoreWorkflows: (rl?.ignoreWorkflows ?? []).join(', '),
    maxReviewIterations: rl?.maxIterations ?? 5,
  };
}

function formToConfig(form: FormState): AgentProfileConfig {
  // `exactOptionalPropertyTypes: true` forbids explicit `undefined` on optional
  // fields — spread the key only when the value is meaningful.
  const base: AgentProfileConfig = {
    id: form.id,
    name: form.name,
    email: form.email,
    model: form.model,
    triggerMode: form.triggerMode,
    runner: form.runner,
    auth: { method: form.authMethod, secretRef: form.secretRef },
    repos: form.repos,
    limits: { maxDurationMs: form.maxDurationMin * 60_000 },
  };
  if (form.systemPrompt) base.systemPrompt = form.systemPrompt;

  // Only attach reviewLoop when the user customised it (disabled, listed
  // reviewers, or non-default iteration cap). Omitting means "defaults" on
  // the server side — same behaviour as never setting it.
  const ignoreR = csvToList(form.ignoreReviewers);
  const triggerR = csvToList(form.triggerReviewers);
  const ignoreW = csvToList(form.ignoreWorkflows);
  const customised =
    !form.reviewLoopEnabled ||
    ignoreR.length > 0 ||
    triggerR.length > 0 ||
    ignoreW.length > 0 ||
    form.maxReviewIterations !== 5;
  if (customised) {
    const rl: NonNullable<AgentProfileConfig['reviewLoop']> = {
      enabled: form.reviewLoopEnabled,
    };
    if (ignoreR.length > 0) rl.ignoreReviewers = ignoreR;
    if (triggerR.length > 0) rl.triggerReviewers = triggerR;
    if (ignoreW.length > 0) rl.ignoreWorkflows = ignoreW;
    if (form.maxReviewIterations !== 5) rl.maxIterations = form.maxReviewIterations;
    base.reviewLoop = rl;
  }
  return base;
}

export function AgentForm() {
  const params = useParams<{ id?: string }>();
  const editId = params.id;
  const isEdit = editId !== undefined;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const boardsQuery = useQuery({ queryKey: ['boards'], queryFn: listBoards, staleTime: 30_000 });
  const agentQuery = useQuery({
    queryKey: ['agents', editId],
    queryFn: () => getAgent(editId!),
    enabled: isEdit,
  });

  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isEdit && agentQuery.data) {
      setForm(configToForm(agentQuery.data.config));
    }
  }, [isEdit, agentQuery.data]);

  const createMut = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof createAgent>[0] = {
        id: form.id,
        config: formToConfig(form),
      };
      const secrets = secretsFromForm(form);
      if (secrets) body.secrets = secrets;
      return createAgent(body);
    },
    onSuccess: () => {
      toast.push({ kind: 'success', message: 'Agent created' });
      qc.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
    onError: (err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
  });

  const updateMut = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof updateAgent>[1] = {
        config: formToConfig(form),
      };
      const secrets = secretsFromForm(form);
      if (secrets) body.secrets = secrets;
      return updateAgent(editId!, body);
    },
    onSuccess: () => {
      toast.push({ kind: 'success', message: 'Agent updated' });
      qc.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
    onError: (err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
  });

  const submitting = createMut.isPending || updateMut.isPending;
  const boards = boardsQuery.data?.items ?? [];

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (isEdit) {
      updateMut.mutate();
    } else {
      createMut.mutate();
    }
  }

  const secretFieldsAlreadySet = agentQuery.data?.secretFields ?? [];

  const backendUnavailable =
    agentQuery.error instanceof ApiError && agentQuery.error.status === 404 &&
    agentQuery.error.code === 'NOT_AVAILABLE';

  return (
    <div className="min-h-screen">
      <Header boardCount={boards.length} />
      <main
        className="mx-auto"
        style={{ maxWidth: '720px', padding: 'var(--space-6)' }}
      >
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <Link to="/agents" className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
            ← back to agents
          </Link>
          <h2
            style={{
              fontSize: 'var(--text-xl)',
              letterSpacing: '-0.02em',
              marginTop: 'var(--space-3)',
              marginBottom: 'var(--space-1)',
            }}
          >
            {isEdit ? `edit ${editId}` : 'new agent'}
          </h2>
          <span className="dim mono" style={{ fontSize: 'var(--text-xs)' }}>
            {isEdit
              ? 'Changes take effect on the next pipeline dispatch.'
              : 'A DB-stored agent overrides YAML entries with the same id.'}
          </span>
        </div>

        {backendUnavailable && (
          <p
            className="mono"
            style={{
              fontSize: 'var(--text-xs)',
              padding: 'var(--space-3)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 'var(--space-5)',
            }}
          >
            This server hasn't applied migration 003-agents. Restart the server to run migrations.
          </p>
        )}

        <form onSubmit={onSubmit} className="flex flex-col" style={{ gap: 'var(--space-5)' }}>
          <Section title="identity">
            <Field label="id (kebab-case, immutable)" hint="e.g. rex-coder">
              <input
                type="text"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })}
                required
                pattern="^[a-z0-9][a-z0-9-]*$"
                disabled={isEdit}
                style={inputStyle(isEdit)}
              />
            </Field>
            <Field label="name">
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                style={inputStyle(false)}
              />
            </Field>
            <Field label="email" hint="Provisioned in your kanban as the agent's member.">
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                style={inputStyle(false)}
              />
            </Field>
          </Section>

          <Section title="behaviour">
            <Field label="model">
              <input
                type="text"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                required
                style={inputStyle(false)}
              />
            </Field>
            <Field label="runner" hint="stream-json preserves subscription auth and emits structured events.">
              <select
                value={form.runner}
                onChange={(e) => setForm({ ...form, runner: e.target.value as RunnerType })}
                style={inputStyle(false)}
              >
                {RUNNER_TYPES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="trigger mode">
              <select
                value={form.triggerMode}
                onChange={(e) => setForm({ ...form, triggerMode: e.target.value as TriggerMode })}
                style={inputStyle(false)}
              >
                {TRIGGER_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="system prompt (optional)">
              <textarea
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                rows={5}
                style={{ ...inputStyle(false), fontFamily: 'var(--font-mono)', resize: 'vertical' }}
              />
            </Field>
          </Section>

          <Section title="auth">
            <Field label="method">
              <select
                value={form.authMethod}
                onChange={(e) => setForm({ ...form, authMethod: e.target.value as AuthMethod })}
                style={inputStyle(false)}
              >
                {AUTH_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="secretRef"
              hint='Either "env:VAR_NAME" for env-var lookup or "vault:KEY" to read from the per-agent secret vault below.'
            >
              <input
                type="text"
                value={form.secretRef}
                onChange={(e) => setForm({ ...form, secretRef: e.target.value })}
                required
                style={inputStyle(false)}
              />
            </Field>
            <Field
              label="ANTHROPIC_API_KEY (write-only)"
              hint={
                secretFieldsAlreadySet.length > 0
                  ? `Currently set: ${secretFieldsAlreadySet.join(', ')}. Leave blank to keep.`
                  : 'Encrypted at rest with OUIJA_SECRET_KEY (AES-256-GCM).'
              }
            >
              <input
                type="password"
                value={form.secretValue}
                onChange={(e) => setForm({ ...form, secretValue: e.target.value })}
                placeholder={isEdit ? '•••••• (unchanged)' : 'sk-ant-…'}
                autoComplete="off"
                style={inputStyle(false)}
              />
            </Field>
          </Section>

          <Section title="repos">
            {form.repos.map((repo, i) => {
              // `exactOptionalPropertyTypes` forbids explicit `undefined` on an
              // optional prop. Build the prop object conditionally so onRemove
              // is omitted entirely when there's only one repo.
              const rowProps: RepoRowProps = {
                repo,
                onChange: (patch) =>
                  setForm({
                    ...form,
                    repos: form.repos.map((r, j) => (i === j ? { ...r, ...patch } : r)),
                  }),
                onMakeDefault: () =>
                  setForm({
                    ...form,
                    repos: form.repos.map((r, j) => ({ ...r, default: i === j })),
                  }),
              };
              if (form.repos.length > 1) {
                rowProps.onRemove = () =>
                  setForm({ ...form, repos: form.repos.filter((_, j) => j !== i) });
              }
              return <RepoRow key={i} {...rowProps} />;
            })}
            <button
              type="button"
              onClick={() =>
                setForm({
                  ...form,
                  repos: [...form.repos, { url: '', baseBranch: 'main' }],
                })
              }
              className="mono dim"
              style={{
                alignSelf: 'flex-start',
                background: 'transparent',
                border: '1px dashed var(--color-border-strong)',
                padding: 'var(--space-2) var(--space-3)',
                fontSize: 'var(--text-xs)',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              + add repo
            </button>
          </Section>

          <Section title="limits">
            <Field label="max duration (minutes)">
              <input
                type="number"
                min={1}
                max={120}
                value={form.maxDurationMin}
                onChange={(e) => setForm({ ...form, maxDurationMin: parseInt(e.target.value, 10) || 30 })}
                style={inputStyle(false)}
              />
            </Field>
          </Section>

          <Section title="review loop">
            <Field
              label="enabled"
              hint="When off, reviewer comments and CI failures on this agent's PRs are ignored — no follow-up dispatches."
            >
              <label className="flex items-center gap-2" style={{ fontSize: 'var(--text-sm)' }}>
                <input
                  type="checkbox"
                  checked={form.reviewLoopEnabled}
                  onChange={(e) => setForm({ ...form, reviewLoopEnabled: e.target.checked })}
                />
                <span className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
                  iterate on reviewer feedback + CI failures
                </span>
              </label>
            </Field>
            <Field
              label="max iterations"
              hint="Cap on follow-up dispatches per PR before the pipeline stalls for human attention."
            >
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxReviewIterations}
                onChange={(e) =>
                  setForm({
                    ...form,
                    maxReviewIterations: parseInt(e.target.value, 10) || 5,
                  })
                }
                style={inputStyle(!form.reviewLoopEnabled)}
                disabled={!form.reviewLoopEnabled}
              />
            </Field>
            <Field
              label="ignore reviewers"
              hint="Comma-separated GitHub logins (case-insensitive). Their reviews/comments don't trigger re-dispatch."
            >
              <input
                type="text"
                value={form.ignoreReviewers}
                onChange={(e) => setForm({ ...form, ignoreReviewers: e.target.value })}
                placeholder="dependabot[bot], noisy-reviewer"
                style={inputStyle(!form.reviewLoopEnabled)}
                disabled={!form.reviewLoopEnabled}
              />
            </Field>
            <Field
              label="trigger reviewers (allowlist)"
              hint="When non-empty, ONLY these logins trigger the loop. Leave blank to accept any reviewer."
            >
              <input
                type="text"
                value={form.triggerReviewers}
                onChange={(e) => setForm({ ...form, triggerReviewers: e.target.value })}
                placeholder="coderabbitai[bot], copilot-pull-request-reviewer[bot]"
                style={inputStyle(!form.reviewLoopEnabled)}
                disabled={!form.reviewLoopEnabled}
              />
            </Field>
            <Field
              label="ignore workflows"
              hint="Comma-separated GitHub Actions workflow names (case-sensitive) whose CI failures shouldn't trigger re-dispatch."
            >
              <input
                type="text"
                value={form.ignoreWorkflows}
                onChange={(e) => setForm({ ...form, ignoreWorkflows: e.target.value })}
                placeholder="nightly-bench, deploy-preview"
                style={inputStyle(!form.reviewLoopEnabled)}
                disabled={!form.reviewLoopEnabled}
              />
            </Field>
          </Section>

          {submitError && (
            <p
              className="mono"
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-err)',
                padding: 'var(--space-3)',
                background: 'var(--color-surface)',
                border: '1px solid var(--color-err)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {submitError}
            </p>
          )}

          <div className="flex items-center gap-3" style={{ justifyContent: 'flex-end' }}>
            <Link to="/agents" className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
              cancel
            </Link>
            <button
              type="submit"
              disabled={submitting}
              className="mono"
              style={{
                padding: 'var(--space-2) var(--space-4)',
                fontSize: 'var(--text-sm)',
                background: 'var(--color-accent)',
                color: 'var(--color-bg)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? 'saving…' : isEdit ? 'save changes' : 'create agent'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="surface" style={{ padding: 'var(--space-5)' }}>
      <h3
        className="faint mono uppercase tracking-wide"
        style={{
          fontSize: 'var(--text-xs)',
          marginBottom: 'var(--space-4)',
        }}
      >
        {title}
      </h3>
      <div className="flex flex-col" style={{ gap: 'var(--space-4)' }}>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col" style={{ gap: 'var(--space-1)' }}>
      <span className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>
          {hint}
        </span>
      )}
    </label>
  );
}

interface RepoRowProps {
  repo: AgentRepoConfig;
  onChange: (patch: Partial<AgentRepoConfig>) => void;
  onRemove?: () => void;
  onMakeDefault: () => void;
}

function RepoRow({ repo, onChange, onRemove, onMakeDefault }: RepoRowProps) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-bg)',
      }}
    >
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 mono dim" style={{ fontSize: 'var(--text-xs)' }}>
          <input
            type="radio"
            checked={repo.default === true}
            onChange={onMakeDefault}
          />
          default
        </label>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="mono dim"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--text-xs)',
              padding: 0,
            }}
          >
            remove
          </button>
        )}
      </div>
      <Field label="repo url (or leave blank and use path)">
        <input
          type="text"
          value={repo.url ?? ''}
          onChange={(e) => onChange(optionalPatch('url', e.target.value))}
          placeholder="https://github.com/org/repo.git"
          style={inputStyle(false)}
        />
      </Field>
      <Field label="path (for local repos)">
        <input
          type="text"
          value={repo.path ?? ''}
          onChange={(e) => onChange(optionalPatch('path', e.target.value))}
          placeholder="/opt/repo"
          style={inputStyle(false)}
        />
      </Field>
      <Field label="base branch">
        <input
          type="text"
          value={repo.baseBranch}
          onChange={(e) => onChange({ baseBranch: e.target.value })}
          required
          style={inputStyle(false)}
        />
      </Field>
      <Field label="projectId (optional — Plane project UUID)">
        <input
          type="text"
          value={repo.projectId ?? ''}
          onChange={(e) => onChange(optionalPatch('projectId', e.target.value))}
          style={inputStyle(false)}
        />
      </Field>
    </div>
  );
}

/**
 * Build a single-field patch for AgentRepoConfig that either carries the value
 * or is an empty object. Keeps us compatible with `exactOptionalPropertyTypes:
 * true` which forbids explicit `undefined` on optional properties like
 * `url?: string`.
 */
function optionalPatch<K extends 'url' | 'path' | 'projectId'>(
  key: K,
  value: string,
): Partial<AgentRepoConfig> {
  return value ? ({ [key]: value } as Partial<AgentRepoConfig>) : {};
}

function inputStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: 'var(--space-2) var(--space-3)',
    fontSize: 'var(--text-sm)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    outline: 'none',
    opacity: disabled ? 0.5 : 1,
    fontFamily: 'inherit',
    width: '100%',
  };
}

function secretsFromForm(form: FormState): Record<string, string> | undefined {
  if (!form.secretValue) return undefined;
  // Secret key derived from authMethod: `api-key` → ANTHROPIC_API_KEY, bedrock → AWS_ACCESS_KEY_ID, etc.
  // v1 ships the common mapping; advanced users edit via the API directly.
  const keyByMethod: Record<AuthMethod, string> = {
    'api-key': 'ANTHROPIC_API_KEY',
    bedrock: 'AWS_ACCESS_KEY_ID',
    vertex: 'GOOGLE_APPLICATION_CREDENTIALS',
    foundry: 'AZURE_CLIENT_SECRET',
    'api-key-helper': 'ANTHROPIC_API_KEY',
    proxy: 'ANTHROPIC_API_KEY',
  };
  return { [keyByMethod[form.authMethod]]: form.secretValue };
}
