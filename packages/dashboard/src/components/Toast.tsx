/**
 * Toast — minimal hand-rolled notification primitive.
 *
 * No library. Single exported `useToast` hook + `<ToastHost />` that
 * renders pending toasts. Usage:
 *
 *   const toast = useToast();
 *   toast.push({ kind: 'success', message: 'Retry dispatched' });
 *
 * Auto-dismisses after 4 seconds (or on click). Positioned bottom-right.
 * Stacks vertically; newest at the top of the stack.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DISMISS_MS = 4_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextIdRef.current++;
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, DISMISS_MS);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ push, dismiss }}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Host — fixed-position stack of toast cards
// ---------------------------------------------------------------------------

interface ToastHostProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'var(--space-5)',
        right: 'var(--space-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  const accent =
    toast.kind === 'success'
      ? 'var(--color-status-running)'
      : toast.kind === 'error'
      ? 'var(--color-status-failed)'
      : 'var(--color-accent)';

  return (
    <button
      type="button"
      onClick={onDismiss}
      className="surface mono"
      style={{
        pointerEvents: 'auto',
        minWidth: '18rem',
        maxWidth: '28rem',
        padding: 'var(--space-3) var(--space-4)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        background: 'var(--color-bg-raised)',
        border: `1px solid ${accent}`,
        borderLeftWidth: '3px',
        borderRadius: 'var(--radius-md)',
        color: 'var(--color-text)',
        fontSize: 'var(--text-sm)',
        textAlign: 'left',
        cursor: 'pointer',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition:
          'opacity var(--dur-normal) var(--ease-out-expo), transform var(--dur-normal) var(--ease-out-expo)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: '0.6rem',
          height: '0.6rem',
          borderRadius: '50%',
          background: accent,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1 }}>{toast.message}</span>
      <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>
        ×
      </span>
    </button>
  );
}
