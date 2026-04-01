// ---- Plane REST API v1 client ----
// All requests use the X-Api-Key header for authentication.
// Base URL: https://<plane-host>/api/v1

// ---- Plane domain types (raw API shapes) ----

export interface PlaneIssue {
  id: string;
  name: string;
  description_html: string;
  state: string;              // state ID (UUID)
  project: string;            // project ID (UUID)
  workspace: string;          // workspace slug
  label_details: Array<{ id: string; name: string }>;
  assignee_details: Array<{ id: string; email: string; display_name: string }>;
  created_at: string;
  updated_at: string;
}

export interface PlaneState {
  id: string;
  name: string;
  color: string;
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  sequence: number;
}

export interface PlaneMember {
  id: string;
  email: string;
  display_name: string;
  role: number;               // 5=Guest, 10=Member, 15=Viewer, 20=Admin
}

export interface PlaneComment {
  id: string;
  comment_html: string;
  actor: string;
  created_at: string;
}

// ---- Rate limit error ----

export class PlaneRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`Plane API rate limit exceeded. Retry after ${retryAfter}s`);
    this.name = 'PlaneRateLimitError';
    this.retryAfter = retryAfter;
  }
}

// ---- API error ----

export class PlaneApiError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string, path: string) {
    super(`Plane API error ${statusCode} on ${path}: ${body}`);
    this.name = 'PlaneApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ---- Client ----

export class PlaneApiClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    // Normalise: strip trailing slash so path construction is consistent.
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiToken = apiToken;
  }

  // ---- Private helpers ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;

    const headers: Record<string, string> = {
      'X-Api-Key': this.apiToken,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const response = await fetch(url, init);

    // Rate limit: surface the retry-after header.
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? '60');
      throw new PlaneRateLimitError(retryAfter);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new PlaneApiError(response.status, text, path);
    }

    // 204 No Content — return empty object cast to T.
    if (response.status === 204 || text.trim() === '') {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  // ---- Issue operations ----

  /**
   * Fetch a single issue by ID.
   * GET /api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/
   */
  async getIssue(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneIssue> {
    return this.get<PlaneIssue>(
      `/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
    );
  }

  /**
   * Update issue fields (e.g. state for column moves).
   * PATCH /api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/
   */
  async updateIssue(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    data: Partial<Pick<PlaneIssue, 'state'>> & Record<string, unknown>,
  ): Promise<PlaneIssue> {
    return this.patch<PlaneIssue>(
      `/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
      data,
    );
  }

  /**
   * Add a comment to an issue.
   * POST /api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/comments/
   */
  async addComment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    body: string,
  ): Promise<PlaneComment> {
    return this.post<PlaneComment>(
      `/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`,
      { comment_html: body },
    );
  }

  /**
   * Fetch all states (columns) for a project.
   * GET /api/v1/workspaces/:workspaceSlug/projects/:projectId/states/
   */
  async getStates(
    workspaceSlug: string,
    projectId: string,
  ): Promise<PlaneState[]> {
    const response = await this.get<{ results: PlaneState[] } | PlaneState[]>(
      `/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    );
    // Plane may return a paginated envelope or a plain array depending on version.
    if (Array.isArray(response)) {
      return response;
    }
    return response.results;
  }

  /**
   * Invite a member (e.g. agent bot user) to the workspace.
   * POST /api/v1/workspaces/:workspaceSlug/invitations/
   *
   * Role codes: 5=Guest, 10=Member, 15=Viewer, 20=Admin
   */
  async createMember(
    workspaceSlug: string,
    email: string,
    role: 5 | 10 | 15 | 20 = 10,
  ): Promise<{ id: string; email: string; role: number }> {
    return this.post<{ id: string; email: string; role: number }>(
      `/workspaces/${workspaceSlug}/invitations/`,
      { email, role },
    );
  }

  /**
   * Assign a member to an issue.
   * Plane uses assignees as an array of member IDs on the issue resource.
   * We fetch the current assignees and PATCH with the new list.
   */
  async assignMember(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    memberId: string,
  ): Promise<PlaneIssue> {
    // Fetch current issue to get existing assignees.
    const issue = await this.getIssue(workspaceSlug, projectId, issueId);
    const existing = issue.assignee_details.map((a) => a.id);

    if (existing.includes(memberId)) {
      // Already assigned — no-op.
      return issue;
    }

    return this.patch<PlaneIssue>(
      `/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
      { assignees: [...existing, memberId] },
    );
  }

  /**
   * Lightweight connectivity check: fetch workspace details.
   * GET /api/v1/workspaces/:workspaceSlug/
   */
  async ping(workspaceSlug: string): Promise<void> {
    await this.get<unknown>(`/workspaces/${workspaceSlug}/`);
  }
}
