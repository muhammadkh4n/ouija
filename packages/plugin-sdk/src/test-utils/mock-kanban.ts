import type {
  KanbanPlugin,
  KanbanCard,
  KanbanColumn,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija/types';
import type { CardId, ColumnId, BoardId } from '@ouija/types';
import { cardId, columnId, boardId } from '@ouija/types';

// ---- Mock Kanban Plugin ----

/**
 * In-memory KanbanPlugin for use in engine integration tests and plugin
 * development. No network calls. All methods operate on internal Maps.
 *
 * Seed data via the `cards`, `columns`, and `assignments` properties before
 * calling the plugin's methods.
 */
export class MockKanbanPlugin implements KanbanPlugin<Record<string, never>> {
  readonly manifest: PluginManifest = {
    name: '@ouija/mock-kanban',
    version: '0.1.0',
    type: 'kanban',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    dependencies: [],
  };

  /** Mutable store: card ID → card */
  readonly cards: Map<CardId, KanbanCard> = new Map();
  /** Mutable store: board ID → columns */
  readonly columns: Map<BoardId, KanbanColumn[]> = new Map();
  /** Recorded comments: card ID → list of comment bodies */
  readonly comments: Map<CardId, string[]> = new Map();
  /** Recorded assignments: card ID → list of user IDs */
  readonly assignments: Map<CardId, string[]> = new Map();

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
      message: 'Mock kanban plugin is always healthy',
      details: { initialised: this.initialised, running: this.running },
    };
  }

  // ---- KanbanPlugin methods ----

  async getCard(id: CardId): Promise<KanbanCard> {
    const card = this.cards.get(id);
    if (!card) {
      throw new Error(`MockKanbanPlugin: card "${id}" not found`);
    }
    return { ...card };
  }

  async moveCard(id: CardId, toColumnId: ColumnId): Promise<void> {
    const card = this.cards.get(id);
    if (!card) {
      throw new Error(`MockKanbanPlugin: card "${id}" not found`);
    }
    this.cards.set(id, { ...card, columnId: toColumnId, updatedAt: new Date().toISOString() });
  }

  async addComment(id: CardId, body: string): Promise<void> {
    const existing = this.comments.get(id) ?? [];
    this.comments.set(id, [...existing, body]);
  }

  async assignUser(id: CardId, userId: string): Promise<void> {
    const existing = this.assignments.get(id) ?? [];
    this.assignments.set(id, [...existing, userId]);

    // Mirror the assignee onto the card.
    const card = this.cards.get(id);
    if (card) {
      this.cards.set(id, {
        ...card,
        assignees: [...card.assignees, userId],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async getColumns(board: BoardId): Promise<KanbanColumn[]> {
    return this.columns.get(board) ?? [];
  }

  // ---- Seeding helpers ----

  /**
   * Add a card to the in-memory store.
   * All fields have sensible defaults — only `id`, `title`, and `columnId` are required.
   */
  seedCard(partial: {
    id: string;
    title: string;
    columnId: string;
    boardId?: string;
    description?: string;
    labels?: string[];
    assignees?: string[];
    url?: string;
    createdAt?: string;
    updatedAt?: string;
  }): KanbanCard {
    const now = new Date().toISOString();
    const card: KanbanCard = {
      id: cardId(partial.id),
      title: partial.title,
      description: partial.description ?? '',
      columnId: columnId(partial.columnId),
      boardId: boardId(partial.boardId ?? 'board-1'),
      labels: partial.labels ?? [],
      assignees: partial.assignees ?? [],
      url: partial.url ?? `https://mock.kanban/cards/${partial.id}`,
      createdAt: partial.createdAt ?? now,
      updatedAt: partial.updatedAt ?? now,
    };
    this.cards.set(card.id, card);
    return card;
  }

  /** Add columns for a board. */
  seedColumns(
    board: string,
    cols: Array<{ id: string; name: string; position: number }>,
  ): void {
    this.columns.set(
      boardId(board),
      cols.map((c) => ({ id: columnId(c.id), name: c.name, position: c.position })),
    );
  }
}
