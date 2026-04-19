/**
 * Typed fetch wrapper for the Ouija REST API.
 *
 * Auth model (v1):
 *   - Static bearer token stored in localStorage under `ouija:apiKey`.
 *   - 401 responses are not auto-redirected; the router renders a token
 *     entry screen when `getApiKey()` returns null or when queries fail
 *     with status 401. This keeps the router decoupled from fetch logic.
 *
 * Base URL:
 *   - Dev: '' (vite proxy forwards /api → http://localhost:4000)
 *   - Prod: '' (served from the same origin as /dashboard/)
 */

import type {
  AgentListResponse,
  AgentProfileConfig,
  AgentRecord,
  BoardListResponse,
  PipelineDetailResponse,
  PipelineListResponse,
} from './api-types.js';

const API_KEY_STORAGE = 'ouija:apiKey';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getApiKey(): string | null {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(API_KEY_STORAGE);
    } else {
      window.localStorage.setItem(API_KEY_STORAGE, value);
    }
  } catch {
    /* ignore storage errors in private mode */
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getApiKey();
  const headers = new Headers(init.headers);
  if (key !== null) {
    headers.set('Authorization', `Bearer ${key}`);
  }
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let code = 'UNKNOWN';
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error — keep status text */
    }
    throw new ApiError(response.status, code, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// ---- Typed endpoints ----

export function listBoards(): Promise<BoardListResponse> {
  return request<BoardListResponse>('/api/v1/boards');
}

export function listPipelines(boardId: string, limit = 30): Promise<PipelineListResponse> {
  const url = `/api/v1/pipelines?boardId=${encodeURIComponent(boardId)}&limit=${limit}`;
  return request<PipelineListResponse>(url);
}

export function getPipeline(id: string): Promise<PipelineDetailResponse> {
  return request<PipelineDetailResponse>(`/api/v1/pipelines/${encodeURIComponent(id)}`);
}

export function retryPipeline(id: string): Promise<{ ok: true; instanceId: string }> {
  return request(`/api/v1/pipelines/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export function cancelPipeline(id: string): Promise<{ ok: true; instanceId: string }> {
  return request(`/api/v1/pipelines/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

// ---- Agents ----

export function listAgents(includeInactive = false): Promise<AgentListResponse> {
  const qs = includeInactive ? '?includeInactive=true' : '';
  return request<AgentListResponse>(`/api/v1/agents${qs}`);
}

export function getAgent(id: string): Promise<AgentRecord> {
  return request<AgentRecord>(`/api/v1/agents/${encodeURIComponent(id)}`);
}

export interface CreateAgentRequest {
  id: string;
  config: AgentProfileConfig;
  secrets?: Record<string, string>;
}

export function createAgent(body: CreateAgentRequest): Promise<AgentRecord> {
  return request<AgentRecord>('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface UpdateAgentRequest {
  config?: AgentProfileConfig;
  secrets?: Record<string, string>;
  replaceSecrets?: boolean;
  active?: boolean;
}

export function updateAgent(id: string, body: UpdateAgentRequest): Promise<AgentRecord> {
  return request<AgentRecord>(`/api/v1/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function deleteAgent(id: string): Promise<void> {
  return request<void>(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
