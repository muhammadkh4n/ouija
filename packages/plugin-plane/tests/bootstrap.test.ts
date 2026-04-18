import { describe, it, expect, vi } from 'vitest';
import {
  bootstrapPlaneProjects,
  logWebhookSetupHint,
  type BoardSpec,
} from '../src/bootstrap.js';
import type { PlaneApiClient, PlaneProject } from '../src/api-client.js';

// ---- Helpers ----

function makeProject(overrides: Partial<PlaneProject> = {}): PlaneProject {
  return {
    id: 'proj-existing',
    name: 'Existing Project',
    identifier: 'EXIST',
    workspace: 'ouija-dev',
    created_at: '2026-04-19T00:00:00Z',
    updated_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

function makeClient(overrides: Partial<PlaneApiClient> = {}): PlaneApiClient {
  return {
    ensureProject: vi.fn(),
    getProject: vi.fn(),
    createProject: vi.fn(),
    listProjects: vi.fn(),
    ...overrides,
  } as unknown as PlaneApiClient;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---- bootstrapPlaneProjects ----

describe('bootstrapPlaneProjects', () => {
  it('returns empty result when no boards are declared', async () => {
    const client = makeClient({
      ensureProject: vi.fn(),
    });
    const logger = makeLogger();

    const result = await bootstrapPlaneProjects(
      client,
      { workspaceSlug: 'ouija-dev', boards: [] },
      logger,
    );

    expect(result).toEqual({ existing: [], created: [], failed: [] });
    expect(client.ensureProject).not.toHaveBeenCalled();
  });

  it('records existing projects when projectId resolves', async () => {
    const existing = makeProject({ id: 'proj-1' });
    const client = makeClient({
      ensureProject: vi.fn().mockResolvedValue(existing),
    });
    const logger = makeLogger();
    const boards: BoardSpec[] = [{ projectId: 'proj-1' }];

    const result = await bootstrapPlaneProjects(
      client,
      { workspaceSlug: 'ouija-dev', boards },
      logger,
    );

    expect(result.existing).toEqual([existing]);
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(client.ensureProject).toHaveBeenCalledWith(
      'ouija-dev',
      'proj-1',
      'Ouija Board 1',
      'OUIJABOARD1',
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Plane bootstrap: project already exists',
      expect.any(Object),
    );
  });

  it('records newly created projects when projectId is missing', async () => {
    const created = makeProject({ id: 'proj-new', name: 'Ouija Board 1' });
    const client = makeClient({
      ensureProject: vi.fn().mockResolvedValue(created),
    });
    const logger = makeLogger();

    const result = await bootstrapPlaneProjects(
      client,
      { workspaceSlug: 'ouija-dev', boards: [{ boardId: 'b1' }] },
      logger,
    );

    expect(result.created).toEqual([created]);
    expect(result.existing).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      'Plane bootstrap: project created',
      expect.any(Object),
    );
  });

  it('records failure when ensureProject throws', async () => {
    const client = makeClient({
      ensureProject: vi
        .fn()
        .mockRejectedValue(new Error('Plane is on fire')),
    });
    const logger = makeLogger();

    const result = await bootstrapPlaneProjects(
      client,
      { workspaceSlug: 'ouija-dev', boards: [{ projectId: 'proj-x' }] },
      logger,
    );

    expect(result.existing).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([
      { projectId: 'proj-x', error: 'Plane is on fire' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Plane bootstrap: project ensure failed',
      expect.objectContaining({ projectId: 'proj-x' }),
    );
  });

  it('iterates all boards even if one fails', async () => {
    const existing = makeProject({ id: 'proj-1' });
    const created = makeProject({ id: 'proj-3' });
    const client = makeClient({
      ensureProject: vi
        .fn()
        .mockResolvedValueOnce(existing) // board 1: existing
        .mockRejectedValueOnce(new Error('boom')) // board 2: fail
        .mockResolvedValueOnce(created), // board 3: created
    });
    const logger = makeLogger();

    const result = await bootstrapPlaneProjects(
      client,
      {
        workspaceSlug: 'ouija-dev',
        boards: [
          { projectId: 'proj-1' },
          { projectId: 'proj-2' },
          { boardId: 'b3' },
        ],
      },
      logger,
    );

    expect(result.existing).toEqual([existing]);
    expect(result.created).toEqual([created]);
    expect(result.failed).toEqual([{ projectId: 'proj-2', error: 'boom' }]);
    expect(client.ensureProject).toHaveBeenCalledTimes(3);
  });

  it('honours the projectNamePrefix option', async () => {
    const created = makeProject();
    const client = makeClient({
      ensureProject: vi.fn().mockResolvedValue(created),
    });
    await bootstrapPlaneProjects(
      client,
      {
        workspaceSlug: 'ouija-dev',
        boards: [{ boardId: 'b1' }],
        projectNamePrefix: 'Rex',
      },
      makeLogger(),
    );
    expect(client.ensureProject).toHaveBeenCalledWith(
      'ouija-dev',
      'b1', // falls back to boardId when projectId is absent
      'Rex Board 1',
      'REXBOARD1',
    );
  });
});

// ---- logWebhookSetupHint ----

describe('logWebhookSetupHint', () => {
  it('logs the exact webhook URL for manual paste', () => {
    const logger = makeLogger();
    logWebhookSetupHint(
      logger,
      'https://ouija.local',
      'wh_secret_abc',
      'ouija-dev',
      'http://plane-aio',
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Plane webhook setup hint',
      expect.objectContaining({
        webhookUrl: 'https://ouija.local/hooks/plane/wh_secret_abc',
        settingsUrl: 'http://plane-aio/ouija-dev/settings/webhooks',
      }),
    );
  });

  it('truncates the secret before logging', () => {
    const logger = makeLogger();
    logWebhookSetupHint(
      logger,
      'https://ouija.local',
      'abcdefghijklmnop',
      'ouija-dev',
      'http://plane-aio',
    );
    const call = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toHaveProperty('secret');
    expect(call[1].secret).toContain('abcdefgh');
    expect(call[1].secret).toContain('hidden');
    expect(call[1].secret).not.toContain('ijklmnop');
  });

  it('trims trailing slash from ouija server URL', () => {
    const logger = makeLogger();
    logWebhookSetupHint(
      logger,
      'https://ouija.local/',
      'wh',
      'ouija-dev',
      'http://plane-aio/',
    );
    const call = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].webhookUrl).toBe('https://ouija.local/hooks/plane/wh');
    expect(call[1].settingsUrl).toBe('http://plane-aio/ouija-dev/settings/webhooks');
  });
});
