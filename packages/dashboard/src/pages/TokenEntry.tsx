/**
 * Token entry screen — shown when no API key is stored or a 401 is hit.
 *
 * Not a login form. The user pastes a bearer token (OUIJA_API_KEY or a
 * JWT minted by a future CLI command). We store it in localStorage and
 * reload the app to reinitialize all queries under the new key.
 */

import { useState, type FormEvent } from 'react';
import { setApiKey } from '../lib/api-client.js';

interface TokenEntryProps {
  errorHint?: string | undefined;
}

export function TokenEntry({ errorHint }: TokenEntryProps) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    setApiKey(trimmed);
    window.location.reload();
  };

  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ padding: 'var(--space-6)' }}
    >
      <form
        onSubmit={handleSubmit}
        className="surface w-full"
        style={{ maxWidth: '28rem', padding: 'var(--space-6)' }}
      >
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <h1
            style={{
              fontSize: 'var(--text-lg)',
              letterSpacing: '-0.02em',
              marginBottom: 'var(--space-2)',
            }}
          >
            ouija
          </h1>
          <p className="dim" style={{ fontSize: 'var(--text-sm)' }}>
            Paste your <code>OUIJA_API_KEY</code> to continue. The token is
            stored locally in your browser and never sent anywhere except your
            Ouija server.
          </p>
        </div>

        {errorHint !== undefined && (
          <div
            className="sunken"
            style={{
              padding: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
              borderColor: 'var(--color-status-failed)',
              color: 'var(--color-status-failed)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {errorHint}
          </div>
        )}

        <label
          className="block dim mono"
          style={{
            fontSize: 'var(--text-xs)',
            marginBottom: 'var(--space-2)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          API token
        </label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="ouija_..."
          className="mono sunken w-full"
          style={{
            padding: 'var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text)',
            outline: 'none',
          }}
        />
        {touched && value.trim().length === 0 && (
          <p
            style={{
              color: 'var(--color-status-failed)',
              fontSize: 'var(--text-xs)',
              marginTop: 'var(--space-2)',
            }}
          >
            Token is required
          </p>
        )}

        <button
          type="submit"
          style={{
            marginTop: 'var(--space-5)',
            padding: 'var(--space-3) var(--space-5)',
            background: 'var(--color-accent)',
            color: 'var(--color-bg)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontWeight: 600,
            fontSize: 'var(--text-sm)',
            cursor: 'pointer',
            width: '100%',
            transition: 'transform var(--dur-fast) var(--ease-out-expo)',
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = 'translateY(1px)')}
          onMouseUp={(e) => (e.currentTarget.style.transform = 'translateY(0)')}
        >
          Continue →
        </button>

        <p
          className="faint mono"
          style={{
            marginTop: 'var(--space-5)',
            fontSize: 'var(--text-xs)',
            lineHeight: 1.6,
          }}
        >
          Don't have a token? Set <code>OUIJA_API_KEY</code> in your{' '}
          <code>.env</code>, prefixed with <code>ouija_</code>, then restart
          the server.
        </p>
      </form>
    </main>
  );
}
