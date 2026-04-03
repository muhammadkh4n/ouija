import type { BoardConfig } from './types.js';

/** Minimal Plane API interface for column discovery. */
export interface PlaneColumnClient {
  getStates(workspaceSlug: string, projectId: string): Promise<Array<{ id: string; name: string; group: string }>>;
}

export interface SeederLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

/** The shape we need to write to the DB. */
export interface SeedablePipelineConfig {
  boardId: string;
  columnMappings: Array<{
    columnId: string;
    columnName: string;
    action: 'dispatch_agent' | 'close_and_notify' | 'noop';
    agentId?: string;
    guards: Array<{ type: string; value: string | number }>;
    stallThresholdMs?: number;
  }>;
  defaultStallThresholdMs: number;
  autoStartOnAssign: boolean;
}

/**
 * Build a PipelineConfig from a BoardConfig + Plane API state discovery.
 *
 * For each Plane state:
 * - If a column config matches by name (case-insensitive), use its action/agentId
 * - Otherwise: default to 'noop'
 */
export async function buildPipelineConfig(
  boardConfig: BoardConfig,
  planeClient: PlaneColumnClient,
  workspaceSlug: string,
  logger: SeederLogger,
): Promise<SeedablePipelineConfig> {
  const states = await planeClient.getStates(workspaceSlug, boardConfig.projectId);

  const columnMappings = states.map((state) => {
    const match = boardConfig.columns.find(
      (c) => c.name.toLowerCase() === state.name.toLowerCase(),
    );

    return {
      columnId: state.id,
      columnName: state.name,
      action: match?.action ?? ('noop' as const),
      ...(match?.agentId ? { agentId: match.agentId } : {}),
      guards: [] as Array<{ type: string; value: string | number }>,
    };
  });

  logger.info('Built pipeline config', {
    projectId: boardConfig.projectId,
    mappedColumns: columnMappings.filter((m) => m.action !== 'noop').length,
    totalColumns: columnMappings.length,
  });

  return {
    boardId: boardConfig.projectId,
    columnMappings,
    defaultStallThresholdMs: boardConfig.defaultStallThresholdMs ?? 300_000,
    autoStartOnAssign: boardConfig.autoStartOnAssign ?? true,
  };
}
