import type { BasePlugin } from './plugin.js';
import type { CardId, ColumnId, BoardId } from './ids.js';

// ---- Kanban domain types ----

export interface KanbanColumn {
  id: ColumnId;
  name: string;
  position: number;
}

export interface KanbanCard {
  id: CardId;
  title: string;
  description: string;
  columnId: ColumnId;
  boardId: BoardId;
  labels: string[];
  assignees: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Kanban plugin interface ----

export interface KanbanPlugin<TConfig = unknown> extends BasePlugin<TConfig> {
  /** Fetch a single card by ID */
  getCard(cardId: CardId): Promise<KanbanCard>;

  /** Move a card to a different column */
  moveCard(cardId: CardId, toColumnId: ColumnId): Promise<void>;

  /** Add a comment to a card */
  addComment(cardId: CardId, body: string): Promise<void>;

  /** Assign a user (or agent) to a card */
  assignUser(cardId: CardId, userId: string): Promise<void>;

  /** Fetch all columns for a board */
  getColumns(boardId: BoardId): Promise<KanbanColumn[]>;
}
