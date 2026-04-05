import type { BoardConfig } from './types.js';

export interface KanbanColumnClient {
  getColumns(boardId: string): Promise<Array<{ id: string; name: string }>>;
}

export type PlaneColumnClient = KanbanColumnClient;

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

export async function buildPipelineConfig(
  boardConfig: BoardConfig,
  client: KanbanColumnClient,
  logger: SeederLogger,
): Promise<SeedablePipelineConfig> {
  const resolvedBoardId = boardConfig.boardId ?? boardConfig.projectId;
  if (resolvedBoardId === undefined) {
    throw new Error('BoardConfig must have boardId or projectId');
  }

  const columns = await client.getColumns(resolvedBoardId);

  const columnMappings = columns.map((col) => {
    const match = boardConfig.columns.find(
      (c) => c.name.toLowerCase() === col.name.toLowerCase(),
    );

    return {
      columnId: col.id,
      columnName: col.name,
      action: match?.action ?? ('noop' as const),
      ...(match?.agentId ? { agentId: match.agentId } : {}),
      guards: [] as Array<{ type: string; value: string | number }>,
    };
  });

  logger.info('Built pipeline config', {
    boardId: resolvedBoardId,
    mappedColumns: columnMappings.filter((m) => m.action !== 'noop').length,
    totalColumns: columnMappings.length,
  });

  return {
    boardId: resolvedBoardId,
    columnMappings,
    defaultStallThresholdMs: boardConfig.defaultStallThresholdMs ?? 300_000,
    autoStartOnAssign: boardConfig.autoStartOnAssign ?? true,
  };
}
