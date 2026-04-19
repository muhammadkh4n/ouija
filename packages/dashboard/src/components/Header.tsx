import { useQuery } from '@tanstack/react-query';
import { getWebhookActivity, setApiKey } from '../lib/api-client.js';
import { relativeTime } from '../lib/format.js';

interface HeaderProps {
  boardCount: number;
  onSignOut?: () => void;
}

export function Header({ boardCount, onSignOut }: HeaderProps) {
  const handleSignOut = () => {
    setApiKey(null);
    onSignOut?.();
    window.location.reload();
  };

  return (
    <header
      className="border-b"
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-bg)',
      }}
    >
      <div
        className="mx-auto flex items-center justify-between gap-6 px-6 py-4"
        style={{ maxWidth: '1280px' }}
      >
        <div className="flex items-baseline gap-6">
          <a href="/dashboard/" className="flex items-baseline gap-2">
            <span
              className="font-semibold tracking-tight"
              style={{
                fontSize: 'var(--text-lg)',
                color: 'var(--color-text)',
                letterSpacing: '-0.02em',
              }}
            >
              ouija
            </span>
            <span
              className="mono faint"
              style={{ fontSize: 'var(--text-xs)' }}
            >
              v0.1
            </span>
          </a>
          <nav className="flex items-center gap-4">
            <a href="/dashboard/" className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
              pipelines
            </a>
            <a href="/dashboard/agents" className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>
              agents
            </a>
          </nav>
          <span className="faint mono" style={{ fontSize: 'var(--text-xs)' }}>
            {boardCount} {boardCount === 1 ? 'board' : 'boards'}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <WebhookIndicator />
          <a
            href="https://github.com/muhammadkh4n/ouija"
            target="_blank"
            rel="noreferrer"
            className="mono dim"
            style={{ fontSize: 'var(--text-xs)' }}
          >
            github →
          </a>
          <button
            type="button"
            onClick={handleSignOut}
            className="mono dim"
            style={{
              fontSize: 'var(--text-xs)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            sign out
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * Last-webhook-received badge. Polls every 5s. Solves the "silent wiring
 * failure" problem: a self-hoster can verify HMAC + path-secret wiring
 * without having to drag a card and wait for a pipeline.
 */
function WebhookIndicator() {
  const query = useQuery({
    queryKey: ['webhook-activity'],
    queryFn: getWebhookActivity,
    refetchInterval: 5_000,
    staleTime: 0,
  });

  const last = query.data?.last ?? null;
  const fresh =
    last !== null && Date.now() - new Date(last.receivedAt).getTime() < 60_000;

  const color = last === null
    ? 'var(--color-dim)'
    : fresh
    ? 'var(--color-ok, #66cc88)'
    : 'var(--color-dim)';

  const label = last === null
    ? 'waiting for first webhook'
    : `webhook ${relativeTime(last.receivedAt)}`;

  return (
    <span
      className="mono dim flex items-center gap-2"
      style={{ fontSize: 'var(--text-xs)' }}
      title={last === null
        ? 'Ouija has not received a signature-verified webhook yet. Check your Plane/Fizzy webhook URL + secret.'
        : `Last ${last.source} webhook at ${last.receivedAt}`}
    >
      <span
        aria-hidden
        style={{
          width: '0.5rem',
          height: '0.5rem',
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}
