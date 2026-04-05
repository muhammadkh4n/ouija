// ---- Fizzy REST API client ----
// All requests use Bearer token authentication.
// Base URL: https://<fizzy-host>

// ---- Fizzy domain types (raw API shapes) ----

export interface FizzyUser {
  id: number;
  name: string;
  email_address: string;
  role: string;
  active: boolean;
  avatar_url: string;
}

export interface FizzyColumn {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

export interface FizzyBoard {
  id: number;
  name: string;
  all_access: boolean;
  created_at: string;
  url: string;
}

export interface FizzyCard {
  id: number;
  number: number;
  title: string;
  status: 'drafted' | 'published' | 'closed' | 'postponed';
  description: string;
  description_html: string;
  tags: string[];
  column: { id: number; name: string; color: string } | null;
  board: { id: number; name: string };
  creator: FizzyUser;
  assignees: FizzyUser[];
  created_at: string;
  url: string;
}

export interface FizzyComment {
  id: number;
  body: { plain_text: string; html: string };
  creator: FizzyUser;
  created_at: string;
}

export interface FizzyWebhook {
  id: number;
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

  async getBoard(boardId: number): Promise<FizzyBoard> {
    return this.get<FizzyBoard>(`/boards/${boardId}`);
  }

  // ---- Column operations ----

  async getColumns(boardId: number): Promise<FizzyColumn[]> {
    return this.get<FizzyColumn[]>(`/boards/${boardId}/columns`);
  }

  // ---- Card operations ----

  async getCard(cardId: number): Promise<FizzyCard> {
    return this.get<FizzyCard>(`/cards/${cardId}`);
  }

  /**
   * Move a card to a column (triage).
   * POST /cards/:id/triages with { column_id }
   */
  async triageCard(cardId: number, columnId: number): Promise<void> {
    await this.post<unknown>(`/cards/${cardId}/triages`, { column_id: columnId });
  }

  async closeCard(cardId: number): Promise<void> {
    await this.post<unknown>(`/cards/${cardId}/closures`, {});
  }

  async reopenCard(cardId: number): Promise<void> {
    await this.delete<unknown>(`/cards/${cardId}/closures`);
  }

  async addComment(cardId: number, body: string): Promise<FizzyComment> {
    return this.post<FizzyComment>(`/cards/${cardId}/comments`, { body });
  }

  /**
   * Toggle assignment for a user on a card.
   * POST /cards/:id/assignments with { assignee_id }
   */
  async assignUser(cardId: number, assigneeId: number): Promise<void> {
    await this.post<unknown>(`/cards/${cardId}/assignments`, { assignee_id: assigneeId });
  }

  // ---- Webhook operations ----

  async createWebhook(
    boardId: number,
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

  // ---- Connectivity check ----

  async ping(): Promise<void> {
    await this.get<unknown>('/boards');
  }
}
