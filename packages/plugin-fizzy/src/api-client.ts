// ---- Fizzy REST API client ----
// All requests use Bearer token authentication.
// Base URL: https://<fizzy-host>
//
// ID TYPES: Fizzy's current main branch uses ULID-backed string IDs (stored
// as uuid in the DB). Earlier releases exposed sequential integer IDs, which
// is why this client originally typed everything as `number`. We widened to
// `string` in the 2026-04-19 WS2.3 work — integers coming back from older
// Fizzy instances still round-trip fine because they serialize as strings
// in JSON.

// ---- Fizzy domain types (raw API shapes) ----

export interface FizzyUser {
  id: string;
  name: string;
  email_address: string;
  role: string;
  active: boolean;
  avatar_url: string;
}

export interface FizzyColumn {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface FizzyBoard {
  id: string;
  name: string;
  all_access: boolean;
  created_at: string;
  url: string;
}

export interface FizzyCard {
  id: string;
  number: number;
  title: string;
  status: 'drafted' | 'published' | 'closed' | 'postponed';
  description: string;
  description_html: string;
  tags: string[];
  column: { id: string; name: string; color: string } | null;
  board: { id: string; name: string };
  creator: FizzyUser;
  assignees: FizzyUser[];
  created_at: string;
  url: string;
}

export interface FizzyComment {
  id: string;
  body: { plain_text: string; html: string };
  creator: FizzyUser;
  created_at: string;
}

export interface FizzyWebhook {
  id: string;
  name: string;
  url: string;
  signing_secret: string;
  active: boolean;
  subscribed_actions: string[];
}

// ---- Error classes ----

export class FizzyRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`Fizzy API rate limit exceeded. Retry after ${retryAfter}s`);
    this.name = 'FizzyRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class FizzyApiError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string, path: string) {
    super(`Fizzy API error ${statusCode} on ${path}: ${body}`);
    this.name = 'FizzyApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ---- Client ----

export class FizzyApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(baseUrl: string, accessToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
  }

  // ---- Private helpers ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const response = await fetch(url, init);

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? '60');
      throw new FizzyRateLimitError(retryAfter);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new FizzyApiError(response.status, text, path);
    }

    if (response.status === 204 || text.trim() === '') {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // ---- Board operations ----

  async listBoards(): Promise<FizzyBoard[]> {
    return this.get<FizzyBoard[]>('/boards');
  }

  async getBoard(boardId: string): Promise<FizzyBoard> {
    return this.get<FizzyBoard>(`/boards/${boardId}`);
  }

  // ---- Column operations ----

  async getColumns(boardId: string): Promise<FizzyColumn[]> {
    return this.get<FizzyColumn[]>(`/boards/${boardId}/columns`);
  }

  // ---- Card operations ----

  async getCard(cardId: string): Promise<FizzyCard> {
    return this.get<FizzyCard>(`/cards/${cardId}`);
  }

  /**
   * Move a card to a column (triage).
   * POST /cards/:id/triages with { column_id }
   */
  async triageCard(cardId: string, columnId: string): Promise<void> {
    await this.post<unknown>(`/cards/${cardId}/triages`, { column_id: columnId });
  }

  async closeCard(cardId: string): Promise<void> {
    await this.post<unknown>(`/cards/${cardId}/closures`, {});
  }

  async reopenCard(cardId: string): Promise<void> {
    await this.delete<unknown>(`/cards/${cardId}/closures`);
  }

  async addComment(cardId: string, body: string): Promise<FizzyComment> {
    return this.post<FizzyComment>(`/cards/${cardId}/comments`, { body });
  }

  /**
   * Toggle assignment for a user on a card.
   * POST /cards/:id/assignments with { assignee_id }
   */
  async assignUser(cardId: string, assigneeId: string): Promise<void> {
    await this.post<unknown>(`/cards/${cardId}/assignments`, { assignee_id: assigneeId });
  }

  // ---- Webhook operations ----

  async listWebhooks(boardId: string): Promise<FizzyWebhook[]> {
    return this.get<FizzyWebhook[]>(`/boards/${boardId}/webhooks`);
  }

  async createWebhook(
    boardId: string,
    name: string,
    url: string,
    subscribedActions: string[],
  ): Promise<FizzyWebhook> {
    return this.post<FizzyWebhook>(`/boards/${boardId}/webhooks`, {
      name,
      url,
      subscribed_actions: subscribedActions,
    });
  }

  /**
   * Ensure a webhook exists for the given board + URL. Idempotent: if a
   * webhook with the target URL already exists on the board, returns it.
   * Otherwise creates one with the provided name and subscribed actions.
   *
   * Self-hoster ergonomic win — callers don't have to click through Fizzy's
   * settings UI to wire the kanban → ouija webhook.
   */
  async ensureWebhook(
    boardId: string,
    url: string,
    name: string,
    subscribedActions: string[],
  ): Promise<FizzyWebhook> {
    const existing = await this.listWebhooks(boardId);
    const match = existing.find((w) => w.url === url);
    if (match) return match;
    return this.createWebhook(boardId, name, url, subscribedActions);
  }

  // ---- Connectivity check ----

  async ping(): Promise<void> {
    await this.get<unknown>('/boards');
  }
}
