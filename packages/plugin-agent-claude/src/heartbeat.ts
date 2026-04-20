/**
 * Heartbeat reporter — posts progress callbacks to the Ouija server.
 *
 * The Ouija server returns a refreshed JWT when the current token is near
 * expiry. HeartbeatReporter handles that transparently so the agent never
 * gets a 401 mid-run.
 *
 * The interval loop is owned here: call startInterval() after the agent
 * begins work, stopInterval() before teardown. Individual one-shot reports
 * (progress, completed, failed, pr_ready) can be called at any time.
 */

// ---------------------------------------------------------------------------
// Payload shapes (mirrors the callback endpoint contract)
// ---------------------------------------------------------------------------

interface HeartbeatPayload {
  type: 'agent_progress';
  instanceId: string;
  dispatchId: string;
  progress?: number;
  message: string;
}

interface PrReadyPayload {
  type: 'agent_pr_ready';
  instanceId: string;
  dispatchId: string;
  prUrl: string;
  prId: string;
}

import type { DispatchOutcome } from '@ouija-dev/types';

interface CompletedPayload {
  type: 'agent_completed';
  instanceId: string;
  dispatchId: string;
  /**
   * Positive-evidence summary — tool calls observed, commits pushed, PR URL
   * extracted from stdout, tokens when reported. Absent for legacy runners
   * that don't compute it. See DispatchOutcome in @ouija-dev/types.
   */
  outcome?: DispatchOutcome;
}

interface FailedPayload {
  type: 'agent_failed';
  instanceId: string;
  dispatchId: string;
  error: string;
  retryable: boolean;
}

interface AcknowledgedPayload {
  type: 'agent_acknowledged';
  instanceId: string;
  dispatchId: string;
}

type CallbackPayload =
  | AcknowledgedPayload
  | HeartbeatPayload
  | PrReadyPayload
  | CompletedPayload
  | FailedPayload;

/**
 * Server response shape from the callback endpoint.
 * The server optionally returns a refreshed JWT via `token`.
 */
interface CallbackResponse {
  ok: boolean;
  /** New JWT when the current token is near expiry. */
  token?: string;
}

// ---------------------------------------------------------------------------
// HeartbeatReporter
// ---------------------------------------------------------------------------

/**
 * Sends heartbeat and lifecycle events to the Ouija callback URL.
 *
 * JWT refresh: if the server returns `{ token: "..." }`, that token is stored
 * and used for all subsequent calls. This lets short-lived JWTs be extended
 * across a long agent run without an additional round-trip to the auth service.
 */
export class HeartbeatReporter {
  private currentToken: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * @param callbackUrl   The Ouija callback endpoint URL.
   * @param initialToken  JWT for authenticating the callback.
   * @param instanceId    Pipeline instance ID for payload context.
   * @param dispatchId    Dispatch ID for payload context.
   * @param _fetchFn      Injectable fetch — override in tests to avoid real HTTP.
   */
  constructor(
    private readonly callbackUrl: string,
    initialToken: string,
    private readonly instanceId: string,
    private readonly dispatchId: string,
    /** Injectable for testing — defaults to globalThis.fetch. */
    public _fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.currentToken = initialToken;
  }

  // ---- Interval management ----

  /**
   * Start sending periodic progress heartbeats.
   * Safe to call multiple times — existing interval is cleared first.
   *
   * @param intervalMs  Milliseconds between heartbeats. Default 30 000.
   */
  startInterval(intervalMs = 30_000): void {
    this.stopInterval();
    this.intervalHandle = setInterval(() => {
      this.reportProgress('Agent is working...').catch(() => {
        // Heartbeat failure is non-fatal. The stall monitor on the server
        // side will detect silence and escalate if needed.
      });
    }, intervalMs);
  }

  /**
   * Stop the periodic heartbeat interval.
   */
  stopInterval(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // ---- One-shot reports ----

  /**
   * Report that the agent has received and acknowledged the work order.
   * Transitions pipeline from dispatching → running.
   */
  async reportAcknowledged(): Promise<void> {
    await this._post({
      type: 'agent_acknowledged',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
    });
  }

  /**
   * Report incremental progress. Called during setup steps and on demand.
   */
  async reportProgress(message: string, progress?: number): Promise<void> {
    const payload: HeartbeatPayload = {
      type: 'agent_progress',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
      message,
    };
    if (progress !== undefined) {
      payload.progress = progress;
    }
    await this._post(payload);
  }

  /**
   * Report that a pull request has been opened.
   */
  async reportPrReady(prUrl: string, prId: string): Promise<void> {
    await this._post({
      type: 'agent_pr_ready',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
      prUrl,
      prId,
    });
  }

  /**
   * Report successful completion of the work order. Pass the runner's
   * DispatchOutcome so the orchestrator can apply Tenet-3 positive-evidence
   * checking before marking the pipeline succeeded.
   */
  async reportCompleted(outcome?: DispatchOutcome): Promise<void> {
    const payload: CompletedPayload = {
      type: 'agent_completed',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
    };
    if (outcome !== undefined) payload.outcome = outcome;
    await this._post(payload);
  }

  /**
   * Report failure. `retryable` signals whether the Ouija engine should
   * re-queue the dispatch or mark the pipeline as permanently failed.
   */
  async reportFailed(error: string, retryable: boolean): Promise<void> {
    await this._post({
      type: 'agent_failed',
      instanceId: this.instanceId,
      dispatchId: this.dispatchId,
      error,
      retryable,
    });
  }

  // ---- Internal ----

  private async _post(payload: CallbackPayload): Promise<void> {
    const response = await this._fetchFn(this.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.currentToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Callback endpoint returned HTTP ${response.status}`);
    }

    // Handle JWT refresh transparently.
    const body = (await response.json()) as CallbackResponse;
    if (body.token) {
      this.currentToken = body.token;
    }
  }

  /**
   * Expose current token — used in tests to verify JWT refresh behaviour.
   */
  get token(): string {
    return this.currentToken;
  }
}
