import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Notification, PluginContext } from '@ouija-dev/types';
import { EngramNotifyPlugin, EngramClient, EngramIngestError } from '../src/index.js';
import type { EngramConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  available: boolean;
  ingest?: () => Promise<void>;
}

function makeFakeClient(options: FakeClientOptions): EngramClient {
  // We construct a real EngramClient with an injected execFn and then
  // override its methods — ensures the type contract is the same as the
  // production code path.
  const client = new EngramClient({
    binaryPath: 'engram-ingest',
    execFn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  client.available = async () => options.available;
  client.ingest = options.ingest ?? (async () => undefined);
  return client;
}

function makeContext(config: EngramConfig = {}): PluginContext<EngramConfig> {
  return {
    config,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    publishEvent: async () => undefined,
    enqueueJob: async () => undefined,
  };
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: 'Pipeline succeeded',
    body: 'Agent opened PR #42',
    level: 'success',
    occurredAt: '2026-04-16T10:30:00.000Z',
    idempotencyKey: `inst_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngramNotifyPlugin.send', () => {
  let plugin: EngramNotifyPlugin;
  let ingestSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    plugin = new EngramNotifyPlugin();
    ingestSpy = vi.fn().mockResolvedValue(undefined);
    plugin.client = makeFakeClient({ available: true, ingest: ingestSpy });
    await plugin.init(makeContext());
    await plugin.start();
  });

  it('calls client.ingest with formatted markdown', async () => {
    await plugin.send(makeNotification());

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const [ingestOpts, timeoutMs] = ingestSpy.mock.calls[0]!;
    expect(ingestOpts.content).toContain('# Ouija: Pipeline succeeded');
    expect(ingestOpts.source).toBe('ouija-pipeline');
    expect(ingestOpts.project).toBe('ouija');
    expect(ingestOpts.raw).toBe(true);
    expect(timeoutMs).toBe(30_000);
  });

  it('is idempotent on idempotencyKey within a process lifetime', async () => {
    const n = makeNotification({ idempotencyKey: 'same-key' });
    await plugin.send(n);
    await plugin.send(n);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows EngramIngestError without throwing', async () => {
    plugin.client.ingest = async () => {
      throw new EngramIngestError('boom', 1, 'stderr body');
    };
    // Should not throw — failures are non-fatal.
    await expect(plugin.send(makeNotification())).resolves.toBeUndefined();
  });

  it('is a no-op when the binary is unavailable', async () => {
    const disabled = new EngramNotifyPlugin();
    const ingest = vi.fn();
    disabled.client = makeFakeClient({ available: false, ingest });
    await disabled.init(makeContext());
    await disabled.start();

    await disabled.send(makeNotification());
    expect(ingest).not.toHaveBeenCalled();
  });

  it('honours custom project and source from config', async () => {
    const p = new EngramNotifyPlugin();
    const ingest = vi.fn().mockResolvedValue(undefined);
    p.client = makeFakeClient({ available: true, ingest });
    await p.init(
      makeContext({ project: 'ouija-cloud', source: 'ouija-cloud-pipeline' }),
    );
    await p.start();

    await p.send(makeNotification());

    const [ingestOpts] = ingest.mock.calls[0]!;
    expect(ingestOpts.project).toBe('ouija-cloud');
    expect(ingestOpts.source).toBe('ouija-cloud-pipeline');
  });
});

describe('EngramNotifyPlugin.healthCheck', () => {
  it('reports unhealthy when disabled at startup', async () => {
    const plugin = new EngramNotifyPlugin();
    plugin.client = makeFakeClient({ available: false });
    await plugin.init(makeContext());
    await plugin.start();

    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.message).toContain('engram-ingest');
  });

  it('reports healthy when the client is available', async () => {
    const plugin = new EngramNotifyPlugin();
    plugin.client = makeFakeClient({ available: true });
    await plugin.init(makeContext());
    await plugin.start();

    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(true);
  });
});
