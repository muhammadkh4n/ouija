/**
 * Agent CRUD route tests.
 *
 * Uses an in-memory AgentRepository so the tests stay hermetic — no Postgres
 * required. Covers the critical-path behaviours:
 *
 *  - POST creates, returning 201 with secret field names but no values
 *  - POST 409 when id already exists and is active
 *  - PUT updates config and merges secrets by default (existing keys preserved)
 *  - PUT replaces secrets when replaceSecrets:true
 *  - DELETE soft-deletes (active=false) without removing the row
 *  - GET list omits inactive rows by default; includeInactive=true shows them
 *  - GET detail returns the serialised shape
 *  - A recreate of a soft-deleted agent is allowed via POST
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type {
  AgentRepository,
  AgentRecord,
  Database,
} from '@ouija-dev/types';
import { decryptSecrets } from '@ouija-dev/engine';

// ---- In-memory AgentRepository ----

function makeMockAgentRepo(): AgentRepository & { _rows: Map<string, AgentRecord> } {
  const rows = new Map<string, AgentRecord>();
  return {
    _rows: rows,
    async findById(id) {
      return rows.get(id);
    },
    async listAll(activeOnly = true) {
      const all = [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return activeOnly ? all.filter((r) => r.active) : all;
    },
    async save(record) {
      rows.set(record.id, record);
    },
    async softDelete(id) {
      const r = rows.get(id);
      if (r) {
        rows.set(id, { ...r, active: false, updatedAt: new Date().toISOString() });
      }
    },
  };
}

function makeDb(agents: AgentRepository): Database {
  return {
    pipelines: {} as never,
    pipelineEvents: {} as never,
    boardConfigs: {} as never,
    deduplication: {
      isDuplicate: async () => false,
      markProcessed: async () => undefined,
      purgeExpired: async () => 0,
    },
    agents,
    async transaction() {
      return undefined as never;
    },
    async ping() {
      return;
    },
  };
}

// ---- Test helper: sign auth cookie ----
// The agents routes use requireAuth which accepts an OUIJA_API_KEY header.

const API_KEY = 'ouija_test-api-key-for-agents';

async function buildTestApp(agents?: AgentRepository) {
  const repo = agents ?? makeMockAgentRepo();
  const db = makeDb(repo);
  const app = await buildApp({
    logger: false,
    db,
    orchestrator: { processTrigger: async () => undefined } as never,
  });
  return { app, repo };
}

function authHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
}

/** Auth-only headers for DELETE/GET — omits content-type so Fastify doesn't try to parse an empty body as JSON. */
function authHeadersNoContentType(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

// ---- Setup ----

beforeAll(() => {
  process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
  process.env['OUIJA_API_KEY'] = API_KEY;
});

afterAll(() => {
  delete process.env['OUIJA_API_KEY'];
});

// ---- Tests ----

const SAMPLE_CONFIG = {
  id: 'rex-coder',
  name: 'Rex Coder',
  email: 'rex@ouija.local',
  model: 'claude-sonnet-4-20250514',
  triggerMode: 'auto' as const,
  auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
  repos: [{ url: 'https://github.com/test/repo.git', baseBranch: 'main' }],
  limits: { maxDurationMs: 1_800_000 },
};

describe('POST /api/v1/agents', () => {
  let app: FastifyInstance;
  let repo: ReturnType<typeof makeMockAgentRepo>;

  beforeEach(async () => {
    ({ app, repo } = await buildTestApp(makeMockAgentRepo() as ReturnType<typeof makeMockAgentRepo>));
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates an agent and returns 201 with secretFields (no values)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({
        id: 'rex-coder',
        config: SAMPLE_CONFIG,
        secrets: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      }),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe('rex-coder');
    expect(body.secretFields).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(body)).not.toContain('sk-ant-test');
    expect(body.active).toBe(true);
  });

  it('persists an encrypted vault that decrypts back to the original value', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({
        id: 'rex-coder',
        config: SAMPLE_CONFIG,
        secrets: { ANTHROPIC_API_KEY: 'sk-ant-roundtrip' },
      }),
    });

    const stored = repo._rows.get('rex-coder')!;
    expect(stored.secretsVault).not.toBeNull();
    const decrypted = decryptSecrets(stored.secretsVault!, process.env['OUIJA_SECRET_KEY']!);
    expect(decrypted['ANTHROPIC_API_KEY']).toBe('sk-ant-roundtrip');
  });

  it('rejects duplicate ids with 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'rex-coder', config: SAMPLE_CONFIG }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'rex-coder', config: SAMPLE_CONFIG }),
    });
    expect(response.statusCode).toBe(409);
  });

  it('allows recreate of a soft-deleted agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'rex-coder', config: SAMPLE_CONFIG }),
    });
    await app.inject({
      method: 'DELETE',
      url: '/api/v1/agents/rex-coder',
      headers: authHeadersNoContentType(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'rex-coder', config: SAMPLE_CONFIG }),
    });
    expect(response.statusCode).toBe(201);
    const row = repo._rows.get('rex-coder')!;
    expect(row.active).toBe(true);
  });

  it('rejects invalid ids that break the kebab-case pattern', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'InvalidId', config: SAMPLE_CONFIG }),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('PUT /api/v1/agents/:id — secrets merge vs replace', () => {
  let app: FastifyInstance;
  let repo: ReturnType<typeof makeMockAgentRepo>;

  beforeEach(async () => {
    ({ app, repo } = await buildTestApp(makeMockAgentRepo() as ReturnType<typeof makeMockAgentRepo>));
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({
        id: 'rex-coder',
        config: SAMPLE_CONFIG,
        secrets: { ANTHROPIC_API_KEY: 'first-key', OPENAI_KEY: 'first-openai' },
      }),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('merges secrets by default (existing keys preserved unless overridden)', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/agents/rex-coder',
      headers: authHeaders(),
      payload: JSON.stringify({ secrets: { ANTHROPIC_API_KEY: 'second-key' } }),
    });

    const stored = repo._rows.get('rex-coder')!;
    const decrypted = decryptSecrets(stored.secretsVault!, process.env['OUIJA_SECRET_KEY']!);
    expect(decrypted['ANTHROPIC_API_KEY']).toBe('second-key');
    expect(decrypted['OPENAI_KEY']).toBe('first-openai');
  });

  it('replaces entire secret set when replaceSecrets=true', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/agents/rex-coder',
      headers: authHeaders(),
      payload: JSON.stringify({
        secrets: { ANTHROPIC_API_KEY: 'third-key' },
        replaceSecrets: true,
      }),
    });

    const stored = repo._rows.get('rex-coder')!;
    const decrypted = decryptSecrets(stored.secretsVault!, process.env['OUIJA_SECRET_KEY']!);
    expect(decrypted['ANTHROPIC_API_KEY']).toBe('third-key');
    expect(decrypted['OPENAI_KEY']).toBeUndefined();
  });
});

describe('GET /api/v1/agents', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'rex-coder', config: SAMPLE_CONFIG }),
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'retired', config: { ...SAMPLE_CONFIG, id: 'retired' } }),
    });
    await app.inject({
      method: 'DELETE',
      url: '/api/v1/agents/retired',
      headers: authHeadersNoContentType(),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns only active agents by default', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents',
      headers: authHeadersNoContentType(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((a: { id: string }) => a.id)).toEqual(['rex-coder']);
  });

  it('includes inactive agents when includeInactive=true', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?includeInactive=true',
      headers: authHeadersNoContentType(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((a: { id: string }) => a.id).sort()).toEqual(['retired', 'rex-coder']);
  });

  it('returns 404 for unknown agent id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/does-not-exist',
      headers: authHeadersNoContentType(),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/agents/:id', () => {
  it('returns 204 and sets active=false without removing the row', async () => {
    const { app, repo } = await buildTestApp(makeMockAgentRepo() as ReturnType<typeof makeMockAgentRepo>);
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: authHeaders(),
      payload: JSON.stringify({ id: 'rex-coder', config: SAMPLE_CONFIG }),
    });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/agents/rex-coder',
      headers: authHeadersNoContentType(),
    });
    expect(response.statusCode).toBe(204);
    const stored = repo._rows.get('rex-coder')!;
    expect(stored.active).toBe(false);
    await app.close();
  });
});

describe('Database without agents repository', () => {
  it('returns 404 NOT_AVAILABLE for GET /api/v1/agents when migration 003 is missing', async () => {
    // Build a DB that deliberately omits `agents`
    const db: Database = {
      pipelines: {} as never,
      pipelineEvents: {} as never,
      boardConfigs: {} as never,
      deduplication: {
        isDuplicate: async () => false,
        markProcessed: async () => undefined,
        purgeExpired: async () => 0,
      },
      async transaction() {
        return undefined as never;
      },
      async ping() {
        return;
      },
    };
    const app = await buildApp({
      logger: false,
      db,
      orchestrator: { processTrigger: async () => undefined } as never,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents',
      headers: authHeadersNoContentType(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_AVAILABLE');
    await app.close();
  });
});
