declare const __brand: unique symbol;
type Brand<T, TBrand extends string> = T & { [__brand]: TBrand };

export type CardId = Brand<string, 'CardId'>;
export type InstanceId = Brand<string, 'InstanceId'>;
export type PrId = Brand<string, 'PrId'>;
export type DispatchId = Brand<string, 'DispatchId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type BoardId = Brand<string, 'BoardId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ColumnId = Brand<string, 'ColumnId'>;
export type PluginId = Brand<string, 'PluginId'>;

// Construction helpers — use at parse boundaries (DB reads, webhook ingestion)
export function cardId(raw: string): CardId { return raw as CardId; }
export function instanceId(raw: string): InstanceId { return raw as InstanceId; }
export function prId(raw: string): PrId { return raw as PrId; }
export function dispatchId(raw: string): DispatchId { return raw as DispatchId; }
export function agentId(raw: string): AgentId { return raw as AgentId; }
export function projectId(raw: string): ProjectId { return raw as ProjectId; }
export function boardId(raw: string): BoardId { return raw as BoardId; }
export function workspaceId(raw: string): WorkspaceId { return raw as WorkspaceId; }
export function columnId(raw: string): ColumnId { return raw as ColumnId; }
export function pluginId(raw: string): PluginId { return raw as PluginId; }
