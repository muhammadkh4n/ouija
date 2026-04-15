import { setApiKey } from '../lib/api-client.js';

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
        <div className="flex items-baseline gap-4">
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
          <span className="faint mono" style={{ fontSize: 'var(--text-xs)' }}>
            {boardCount} {boardCount === 1 ? 'board' : 'boards'}
          </span>
        </div>
        <div className="flex items-center gap-4">
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
