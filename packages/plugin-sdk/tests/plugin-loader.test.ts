import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginLoader } from '../src/plugin-loader.js';
import type { PluginFactory, ContextFactory } from '../src/plugin-loader.js';
import type { BasePlugin, PluginContext, PluginHealth, PluginManifest } from '@ouija/types';
import { createMockLogger, createMockContext } from '../src/test-utils/index.js';

// ---- Test helpers ----

/** Build a minimal PluginFactory whose plugin records call order. */
function makeFactory(
  name: string,
  opts: {
    coreApiVersion?: string;
    dependencies?: string[];
    configSchema?: Record<string, unknown>;
    onInit?: () => void;
    onStart?: () => void;
    onStop?: () => void;
    health?: PluginHealth;
    stopDelay?: number;
  } = {},
): PluginFactory<unknown> {
  const manifest: PluginManifest = {
    name,
    version: '1.0.0',
    type: 'kanban',
    coreApiVersion: opts.coreApiVersion ?? '>=1.0.0 <2.0.0',
    configSchema: opts.configSchema ?? { type: 'object', additionalProperties: true },
    dependencies: opts.dependencies ?? [],
  };

  return {
    manifest,
    create(): BasePlugin<unknown> {
      let ctx: PluginContext<unknown> | null = null;
      return {
        manifest,
        async init(context) {
          ctx = context;
          opts.onInit?.();
        },
        async start() {
          opts.onStart?.();
        },
        async stop() {
          if (opts.stopDelay) {
            await new Promise((r) => setTimeout(r, opts.stopDelay));
          }
          opts.onStop?.();
        },
        async healthCheck() {
          return opts.health ?? { healthy: true };
        },
      };
    },
  };
}

/** Build a simple context factory that uses createMockContext for each plugin. */
const simpleContextFactory: ContextFactory = (_name, config) =>
  createMockContext(config) as PluginContext<unknown>;

/** Build an importFn from a name→factory map. */
function buildImportFn(
  map: Record<string, PluginFactory<unknown>>,
): (specifier: string) => Promise<{ default: PluginFactory<unknown> }> {
  return async (specifier) => {
    const factory = map[specifier];
    if (!factory) throw new Error(`importFn: unknown module "${specifier}"`);
    return { default: factory };
  };
}

// ---- Tests ----

describe('PluginLoader — config validation', () => {
  it('accepts a valid config matching the schema', async () => {
    const factory = makeFactory('@ouija/plugin-a', {
      configSchema: {
        type: 'object',
        required: ['apiToken'],
        properties: { apiToken: { type: 'string' } },
        additionalProperties: false,
      },
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/plugin-a', config: { apiToken: 'tok_abc' } });

    await expect(
      loader.loadAll(simpleContextFactory, buildImportFn({ '@ouija/plugin-a': factory })),
    ).resolves.not.toThrow();
  });

  it('throws with plugin name and field name when required field is missing', async () => {
    const factory = makeFactory('@ouija/plugin-plane', {
      configSchema: {
        type: 'object',
        required: ['apiToken'],
        properties: { apiToken: { type: 'string' } },
        additionalProperties: false,
      },
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/plugin-plane', config: {} });

    await expect(
      loader.loadAll(simpleContextFactory, buildImportFn({ '@ouija/plugin-plane': factory })),
    ).rejects.toThrow(/Plugin @ouija\/plugin-plane config error.*apiToken/);
  });
});

describe('PluginLoader — plugin lifecycle', () => {
  it('calls init → start → stop in order', async () => {
    const order: string[] = [];

    const factory = makeFactory('@ouija/plugin-a', {
      onInit: () => order.push('init'),
      onStart: () => order.push('start'),
      onStop: () => order.push('stop'),
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/plugin-a', config: {} });

    await loader.loadAll(simpleContextFactory, buildImportFn({ '@ouija/plugin-a': factory }));
    await loader.startAll();
    await loader.stopAll();

    expect(order).toEqual(['init', 'start', 'stop']);
  });

  it('getPlugin returns the loaded plugin', async () => {
    const factory = makeFactory('@ouija/plugin-a');
    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/plugin-a', config: {} });

    await loader.loadAll(simpleContextFactory, buildImportFn({ '@ouija/plugin-a': factory }));

    const plugin = loader.getPlugin<BasePlugin<unknown>>('@ouija/plugin-a');
    expect(plugin).toBeDefined();
    expect(plugin.manifest.name).toBe('@ouija/plugin-a');
  });

  it('getPlugin throws for an unknown name', async () => {
    const loader = new PluginLoader(createMockLogger());
    expect(() => loader.getPlugin('@ouija/missing')).toThrow(/not loaded/);
  });
});

describe('PluginLoader — dependency ordering', () => {
  it('initialises dependency (A) before dependent (B)', async () => {
    const initOrder: string[] = [];

    const factoryA = makeFactory('@ouija/plugin-a', {
      onInit: () => initOrder.push('A'),
    });
    const factoryB = makeFactory('@ouija/plugin-b', {
      dependencies: ['@ouija/plugin-a'],
      onInit: () => initOrder.push('B'),
    });

    const loader = new PluginLoader(createMockLogger());
    // Register B before A intentionally — loader must still init A first.
    loader.register({ module: '@ouija/plugin-b', config: {} });
    loader.register({ module: '@ouija/plugin-a', config: {} });

    await loader.loadAll(
      simpleContextFactory,
      buildImportFn({
        '@ouija/plugin-a': factoryA,
        '@ouija/plugin-b': factoryB,
      }),
    );

    expect(initOrder).toEqual(['A', 'B']);
  });

  it('initialises C after both A and B when C depends on both', async () => {
    const initOrder: string[] = [];

    const fA = makeFactory('@ouija/a', { onInit: () => initOrder.push('A') });
    const fB = makeFactory('@ouija/b', { onInit: () => initOrder.push('B') });
    const fC = makeFactory('@ouija/c', {
      dependencies: ['@ouija/a', '@ouija/b'],
      onInit: () => initOrder.push('C'),
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/c', config: {} });
    loader.register({ module: '@ouija/b', config: {} });
    loader.register({ module: '@ouija/a', config: {} });

    await loader.loadAll(
      simpleContextFactory,
      buildImportFn({ '@ouija/a': fA, '@ouija/b': fB, '@ouija/c': fC }),
    );

    // C must come last; A and B order is deterministic (alphabetical) due to stable sort.
    expect(initOrder.indexOf('C')).toBeGreaterThan(initOrder.indexOf('A'));
    expect(initOrder.indexOf('C')).toBeGreaterThan(initOrder.indexOf('B'));
  });
});

describe('PluginLoader — circular dependency detection', () => {
  it('throws when A depends on B and B depends on A', async () => {
    const fA = makeFactory('@ouija/a', { dependencies: ['@ouija/b'] });
    const fB = makeFactory('@ouija/b', { dependencies: ['@ouija/a'] });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/a', config: {} });
    loader.register({ module: '@ouija/b', config: {} });

    await expect(
      loader.loadAll(
        simpleContextFactory,
        buildImportFn({ '@ouija/a': fA, '@ouija/b': fB }),
      ),
    ).rejects.toThrow(/[Cc]ircular dependency/);
  });

  it('throws when A → B → C → A', async () => {
    const fA = makeFactory('@ouija/a', { dependencies: ['@ouija/c'] });
    const fB = makeFactory('@ouija/b', { dependencies: ['@ouija/a'] });
    const fC = makeFactory('@ouija/c', { dependencies: ['@ouija/b'] });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/a', config: {} });
    loader.register({ module: '@ouija/b', config: {} });
    loader.register({ module: '@ouija/c', config: {} });

    await expect(
      loader.loadAll(
        simpleContextFactory,
        buildImportFn({ '@ouija/a': fA, '@ouija/b': fB, '@ouija/c': fC }),
      ),
    ).rejects.toThrow(/[Cc]ircular dependency/);
  });
});

describe('PluginLoader — coreApiVersion compatibility', () => {
  it('throws when plugin requires a future coreApiVersion', async () => {
    const factory = makeFactory('@ouija/future-plugin', {
      coreApiVersion: '>=2.0.0 <3.0.0',
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/future-plugin', config: {} });

    await expect(
      loader.loadAll(
        simpleContextFactory,
        buildImportFn({ '@ouija/future-plugin': factory }),
      ),
    ).rejects.toThrow(/coreApiVersion/);
  });

  it('throws with the plugin name in the error message', async () => {
    const factory = makeFactory('@ouija/v99-plugin', {
      coreApiVersion: '>=99.0.0',
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/v99-plugin', config: {} });

    await expect(
      loader.loadAll(
        simpleContextFactory,
        buildImportFn({ '@ouija/v99-plugin': factory }),
      ),
    ).rejects.toThrow(/@ouija\/v99-plugin/);
  });

  it('accepts a plugin with a compatible version range', async () => {
    const factory = makeFactory('@ouija/compat-plugin', {
      coreApiVersion: '>=1.0.0 <2.0.0',
    });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/compat-plugin', config: {} });

    await expect(
      loader.loadAll(
        simpleContextFactory,
        buildImportFn({ '@ouija/compat-plugin': factory }),
      ),
    ).resolves.not.toThrow();
  });
});

describe('PluginLoader — health status aggregation', () => {
  it('returns healthy status for all plugins', async () => {
    const fA = makeFactory('@ouija/a', { health: { healthy: true, message: 'ok' } });
    const fB = makeFactory('@ouija/b', { health: { healthy: true } });

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/a', config: {} });
    loader.register({ module: '@ouija/b', config: {} });

    await loader.loadAll(
      simpleContextFactory,
      buildImportFn({ '@ouija/a': fA, '@ouija/b': fB }),
    );

    const statuses = await loader.getHealthStatuses();
    expect(statuses.size).toBe(2);
    expect(statuses.get('@ouija/a')?.healthy).toBe(true);
    expect(statuses.get('@ouija/b')?.healthy).toBe(true);
  });

  it('marks a plugin unhealthy when healthCheck throws', async () => {
    const manifest: PluginManifest = {
      name: '@ouija/broken',
      version: '1.0.0',
      type: 'kanban',
      coreApiVersion: '>=1.0.0 <2.0.0',
      configSchema: { type: 'object', additionalProperties: true },
    };

    const brokenFactory: PluginFactory<unknown> = {
      manifest,
      create() {
        return {
          manifest,
          async init() {},
          async start() {},
          async stop() {},
          async healthCheck() {
            throw new Error('connection refused');
          },
        };
      },
    };

    const loader = new PluginLoader(createMockLogger());
    loader.register({ module: '@ouija/broken', config: {} });

    await loader.loadAll(
      simpleContextFactory,
      buildImportFn({ '@ouija/broken': brokenFactory }),
    );

    const statuses = await loader.getHealthStatuses();
    const status = statuses.get('@ouija/broken');
    expect(status?.healthy).toBe(false);
    expect(status?.message).toContain('connection refused');
  });

  it('returns an empty map when no plugins are loaded', async () => {
    const loader = new PluginLoader(createMockLogger());
    const statuses = await loader.getHealthStatuses();
    expect(statuses.size).toBe(0);
  });
});

describe('PluginLoader — stop timeout', () => {
  it('logs an error when a plugin exceeds the stop timeout', async () => {
    const logger = createMockLogger();
    const factory = makeFactory('@ouija/slow', { stopDelay: 500 });

    const loader = new PluginLoader(logger);
    loader.register({ module: '@ouija/slow', config: {} });

    await loader.loadAll(simpleContextFactory, buildImportFn({ '@ouija/slow': factory }));
    // Use 10 ms timeout — the plugin takes 500 ms to stop.
    await loader.stopAll(10);

    const errorEntries = logger.entriesAt('error');
    expect(errorEntries.length).toBeGreaterThan(0);
    expect(errorEntries.some((e) => /timed out/i.test(e.msg) || /stop error/i.test(e.msg))).toBe(true);
  });
});
