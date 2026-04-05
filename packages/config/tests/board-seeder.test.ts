import { describe, it, expect, vi } from 'vitest';
import { buildPipelineConfig } from '../src/board-seeder.js';
import type { BoardConfig } from '../src/types.js';
import type { KanbanColumnClient } from '../src/board-seeder.js';

const noopLogger = { info: vi.fn(), warn: vi.fn() };

describe('buildPipelineConfig', () => {
  const boardConfig: BoardConfig = {
    projectId: 'proj-123',
    columns: [
      { name: 'In Progress', action: 'dispatch_agent', agentId: 'rex-coder' },
      { name: 'Done', action: 'close_and_notify' },
    ],
    autoStartOnAssign: true,
  };

  const kanbanClient: KanbanColumnClient = {
    getColumns: vi.fn().mockResolvedValue([
      { id: 'state-1', name: 'Backlog' },
      { id: 'state-2', name: 'In Progress' },
      { id: 'state-3', name: 'Review' },
      { id: 'state-4', name: 'Done' },
    ]),
  };

  it('maps configured columns to states by name (case-insensitive)', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    const inProgress = config.columnMappings.find((m) => m.columnName === 'In Progress');
    expect(inProgress?.action).toBe('dispatch_agent');
    expect(inProgress?.agentId).toBe('rex-coder');
    expect(inProgress?.columnId).toBe('state-2');
  });

  it('defaults unmapped columns to noop', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    const backlog = config.columnMappings.find((m) => m.columnName === 'Backlog');
    expect(backlog?.action).toBe('noop');
  });

  it('sets autoStartOnAssign from board config', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    expect(config.autoStartOnAssign).toBe(true);
  });

  it('uses default stall threshold when not specified', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    expect(config.defaultStallThresholdMs).toBe(300_000);
  });

  it('sets boardId to projectId', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    expect(config.boardId).toBe('proj-123');
  });

  it('respects custom stall threshold', async () => {
    const customConfig: BoardConfig = {
      ...boardConfig,
      defaultStallThresholdMs: 600_000,
    };
    const config = await buildPipelineConfig(customConfig, kanbanClient, noopLogger);
    expect(config.defaultStallThresholdMs).toBe(600_000);
  });

  it('matches column names case-insensitively', async () => {
    const mixedCaseClient: KanbanColumnClient = {
      getColumns: vi.fn().mockResolvedValue([
        { id: 'state-1', name: 'in progress' },
      ]),
    };
    const config = await buildPipelineConfig(boardConfig, mixedCaseClient, noopLogger);
    const inProgress = config.columnMappings.find((m) => m.columnName === 'in progress');
    expect(inProgress?.action).toBe('dispatch_agent');
    expect(inProgress?.agentId).toBe('rex-coder');
  });

  it('does not include agentId for non-dispatch columns', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    const done = config.columnMappings.find((m) => m.columnName === 'Done');
    expect(done?.action).toBe('close_and_notify');
    expect(done?.agentId).toBeUndefined();
  });

  it('initializes guards as empty array for all columns', async () => {
    const config = await buildPipelineConfig(boardConfig, kanbanClient, noopLogger);
    for (const mapping of config.columnMappings) {
      expect(mapping.guards).toEqual([]);
    }
  });

  it('prefers boardId over projectId when both are present', async () => {
    const dualConfig: BoardConfig = {
      boardId: 'board-xyz',
      projectId: 'proj-123',
      columns: [],
    };
    const emptyClient: KanbanColumnClient = {
      getColumns: vi.fn().mockResolvedValue([]),
    };
    const config = await buildPipelineConfig(dualConfig, emptyClient, noopLogger);
    expect(config.boardId).toBe('board-xyz');
    expect(emptyClient.getColumns).toHaveBeenCalledWith('board-xyz');
  });
});
