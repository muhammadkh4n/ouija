import type { PipelineStatus } from '../lib/api-types.js';
import { isInFlight } from '../lib/format.js';

interface StatusDotProps {
  status: PipelineStatus;
  label?: boolean;
}

export function StatusDot({ status, label = false }: StatusDotProps) {
  const pulse = isInFlight(status);
  return (
    <span className="inline-flex items-center gap-2" title={status}>
      <span
        className={`status-dot${pulse ? ' pulse' : ''}`}
        data-status={status}
        aria-hidden
      />
      {label && <span className="mono dim uppercase tracking-wide text-xs">{status}</span>}
    </span>
  );
}
