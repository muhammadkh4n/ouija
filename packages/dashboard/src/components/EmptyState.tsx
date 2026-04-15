interface EmptyStateProps {
  title: string;
  hint?: string;
}

export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div
      className="surface flex flex-col items-center justify-center text-center"
      style={{ padding: 'var(--space-7) var(--space-5)' }}
    >
      <div
        aria-hidden
        className="mono faint"
        style={{ fontSize: 'var(--text-md)', marginBottom: 'var(--space-3)' }}
      >
        ∅
      </div>
      <h3 style={{ fontSize: 'var(--text-md)', marginBottom: 'var(--space-2)' }}>
        {title}
      </h3>
      {hint !== undefined && (
        <p className="dim" style={{ fontSize: 'var(--text-sm)', maxWidth: '48ch' }}>
          {hint}
        </p>
      )}
    </div>
  );
}
