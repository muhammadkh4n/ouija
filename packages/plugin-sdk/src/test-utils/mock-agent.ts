import type {
  AgentPlugin,
  WorkOrder,
  AgentStatus,
  AgentStatusState,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija/types';
import type { DispatchId, InstanceId } from '@ouija/types';
import { dispatchId, instanceId } from '@ouija/types';

// ---- Mock Agent Plugin ----

/** A dispatched work order with the ID assigned to it. */
export interface DispatchRecord {
  dispatchId: DispatchId;
  workOrder: WorkOrder;
}

/** A recorded cancellation. */
export interface CancelRecord {
  dispatchId: DispatchId;
}

/**
 * In-memory AgentPlugin for engine integration tests.
 *
 * - `dispatch()` records the work order and returns a deterministic fake ID.
 * - `cancel()` records the cancellation request.
 * - `getStatus()` returns a configurable default state (`idle` by default).
 *   Override per-dispatch via `setStatus()`.
 *
 * Inspect `dispatchedWorkOrders` and `cancelledIds` in test assertions.
 */
export class MockAgentPlugin implements AgentPlugin<Record<string, never>> {
  readonly manifest: PluginManifest = {
    name: '@ouija/mock-agent',
    version: '0.1.0',
    type: 'agent',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    dependencies: [],
  };

  /** All work orders passed to `dispatch()`, in insertion order. */
  readonly dispatchedWorkOrders: DispatchRecord[] = [];
  /** All dispatch IDs passed to `cancel()`, in insertion order. */
  readonly cancelledIds: CancelRecord[] = [];

  /** Override per-dispatch status here for getStatus() to return. */
  private readonly statusOverrides: Map<DispatchId, AgentStatus> = new Map();
  /** Default state returned when no override exists. */
  private defaultState: AgentStatusState = 'idle';

  private dispatchCounter = 0;
  private initialised = false;
  private running = false;

  // ---- Lifecycle ----

  async init(_context: PluginContext<Record<string, never>>): Promise<void> {
    this.initialised = true;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async healthCheck(): Promise<PluginHealth> {
    return {
      healthy: true,
      message: 'Mock agent plugin is always healthy',
      details: {
        initialised: this.initialised,
        running: this.running,
        dispatched: this.dispatchedWorkOrders.length,
      },
    };
  }

  // ---- AgentPlugin methods ----

  async dispatch(workOrder: WorkOrder): Promise<DispatchId> {
    this.dispatchCounter += 1;
    const id = dispatchId(`mock-dispatch-${this.dispatchCounter}`);
    this.dispatchedWorkOrders.push({ dispatchId: id, workOrder });
    return id;
  }

  async cancel(id: DispatchId): Promise<void> {
    this.cancelledIds.push({ dispatchId: id });
  }

  async getStatus(id: DispatchId): Promise<AgentStatus> {
    const override = this.statusOverrides.get(id);
    if (override) return { ...override };

    return {
      dispatchId: id,
      instanceId: instanceId('mock-instance'),
      state: this.defaultState,
      updatedAt: new Date().toISOString(),
    };
  }

  // ---- Test helpers ----

  /**
   * Set a specific status that `getStatus()` will return for the given dispatch ID.
   * Useful for simulating state transitions in tests.
   */
  setStatus(id: DispatchId, status: Omit<AgentStatus, 'dispatchId'>): void {
    this.statusOverrides.set(id, { ...status, dispatchId: id });
  }

  /**
   * Change the default state returned by `getStatus()` when no override is set.
   */
  setDefaultState(state: AgentStatusState): void {
    this.defaultState = state;
  }

  /** Reset all recorded data and overrides. Useful between tests. */
  reset(): void {
    this.dispatchedWorkOrders.length = 0;
    this.cancelledIds.length = 0;
    this.statusOverrides.clear();
    this.dispatchCounter = 0;
    this.defaultState = 'idle';
  }
}
