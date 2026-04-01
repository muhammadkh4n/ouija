import semver from 'semver';
import type { BasePlugin, PluginLogger, PluginHealth, JSONSchema, PluginContext } from '@ouija/types';
import { validateConfigOrThrow } from './config-validator.js';

// ---- Types ----

/**
 * A single plugin registration entry.
 * `module` is the import specifier (file path or package name).
 * `config` is the raw config object that will be validated against the manifest schema.
 */
export interface PluginRegistration {
  module: string;
  config: Record<string, unknown>;
}

/**
 * The shape of the default export (or named `PluginFactory` export) expected
 * from each plugin module.
 *
 * Plugin modules must export a factory object whose `manifest` is read before
 * `create()` is called.
 */
export interface PluginFactory<TConfig = unknown> {
  manifest: {
    name: string;
    version: string;
    type: 'kanban' | 'git' | 'agent' | 'notification';
    coreApiVersion: string;
    configSchema: JSONSchema;
    dependencies?: string[];
  };
  create(): BasePlugin<TConfig>;
}

/** Shape of an imported plugin module. */
type PluginModule = {
  default?: PluginFactory<unknown>;
  PluginFactory?: PluginFactory<unknown>;
};

/** Context factory signature. */
export type ContextFactory = (
  pluginName: string,
  config: Record<string, unknown>,
) => PluginContext<unknown>;

/** Internal record tracking a loaded plugin. */
interface LoadedEntry {
  plugin: BasePlugin<unknown>;
  name: string;
}

// ---- Core API version this loader implements ----
const CORE_API_VERSION = '1.0.0';

// ---- PluginLoader ----

/**
 * Manages the full lifecycle for a set of registered plugins:
 *   register → loadAll (import + validate + sort + init) → startAll → stopAll
 */
export class PluginLoader {
  private readonly logger: PluginLogger;
  private readonly registrations: Map<string, PluginRegistration> = new Map();
  /** Ordered by dependency resolution (dependencies first). */
  private loadedPlugins: LoadedEntry[] = [];
  private started = false;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  /**
   * Register a plugin module + config pair. The module is not imported yet.
   */
  register(registration: PluginRegistration): void {
    this.registrations.set(registration.module, registration);
  }

  /**
   * Import all registered modules, validate their configs, resolve dependency
   * order, and call `plugin.init(context)` for each in dependency order.
   *
   * @param contextFactory - builds the PluginContext for each plugin.
   * @param importFn - override the import mechanism (default: dynamic import).
   *   Pass a custom function in tests to avoid filesystem lookups.
   *
   * Throws on:
   *  - `coreApiVersion` incompatibility
   *  - Config validation failure
   *  - Circular dependencies
   *  - Unknown dependency references
   */
  async loadAll(
    contextFactory: ContextFactory,
    importFn: (moduleSpecifier: string) => Promise<PluginModule> = (m) =>
      import(m) as Promise<PluginModule>,
  ): Promise<void> {
    // 1. Import all modules and extract factories.
    const factories = new Map<string, PluginFactory<unknown>>();
    // Map from plugin name → module specifier so we can find the registration.
    const nameToModule = new Map<string, string>();

    for (const [moduleSpecifier, registration] of this.registrations) {
      const mod = await importFn(moduleSpecifier);
      const factory: PluginFactory<unknown> | undefined =
        mod.default ?? mod.PluginFactory;

      if (!factory || typeof factory.create !== 'function') {
        throw new Error(
          `Plugin module "${moduleSpecifier}" must export a default PluginFactory with a create() method`,
        );
      }

      const { name, coreApiVersion, configSchema } = factory.manifest;

      // 2. Check coreApiVersion compatibility.
      if (!semver.satisfies(CORE_API_VERSION, coreApiVersion)) {
        throw new Error(
          `Plugin ${name} requires coreApiVersion "${coreApiVersion}" but core is at ${CORE_API_VERSION}`,
        );
      }

      // 3. Validate config against manifest schema.
      validateConfigOrThrow(name, configSchema, registration.config);

      factories.set(name, factory);
      nameToModule.set(name, moduleSpecifier);
    }

    // 4. Topological sort by dependencies.
    const sortedNames = topoSort(factories);

    // 5. Create plugin instances in sorted order and init them.
    for (const name of sortedNames) {
      const factory = factories.get(name);
      if (!factory) continue;

      const moduleSpecifier = nameToModule.get(name);
      if (!moduleSpecifier) {
        throw new Error(`Internal error: no module specifier found for plugin "${name}"`);
      }

      const registration = this.registrations.get(moduleSpecifier);
      if (!registration) {
        throw new Error(`Internal error: no registration found for plugin "${name}"`);
      }

      const plugin = factory.create();
      const context = contextFactory(name, registration.config);

      this.logger.info(`Initialising plugin "${name}"`);
      await plugin.init(context);

      this.loadedPlugins.push({ plugin, name });
    }
  }

  /**
   * Start all loaded plugins concurrently.
   * A failing plugin logs the error but does not prevent others from starting.
   */
  async startAll(): Promise<void> {
    this.started = true;
    const results = await Promise.allSettled(
      this.loadedPlugins.map(async ({ plugin, name }) => {
        this.logger.info(`Starting plugin "${name}"`);
        await plugin.start();
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error('Plugin failed to start', {
          error: String(result.reason),
        });
      }
    }
  }

  /**
   * Stop all plugins in reverse dependency order.
   * Each plugin gets `timeoutMs` (default 5 000 ms) to shut down.
   */
  async stopAll(timeoutMs = 5_000): Promise<void> {
    const reversed = [...this.loadedPlugins].reverse();

    for (const { plugin, name } of reversed) {
      this.logger.info(`Stopping plugin "${name}"`);
      try {
        await Promise.race([
          plugin.stop(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Plugin "${name}" stop timed out`)),
              timeoutMs,
            ),
          ),
        ]);
      } catch (err) {
        this.logger.error(`Plugin "${name}" stop error`, { error: String(err) });
      }
    }
    this.started = false;
  }

  /**
   * Get a loaded plugin by name, cast to type `T`.
   * Throws if the plugin is not found.
   */
  getPlugin<T>(name: string): T {
    const entry = this.loadedPlugins.find((e) => e.name === name);
    if (!entry) {
      throw new Error(`Plugin "${name}" is not loaded`);
    }
    return entry.plugin as unknown as T;
  }

  /**
   * Poll all loaded plugins for their health status.
   */
  async getHealthStatuses(): Promise<Map<string, PluginHealth>> {
    const results = new Map<string, PluginHealth>();

    await Promise.all(
      this.loadedPlugins.map(async ({ plugin, name }) => {
        try {
          const health = await plugin.healthCheck();
          results.set(name, health);
        } catch (err) {
          results.set(name, {
            healthy: false,
            message: `healthCheck threw: ${String(err)}`,
          });
        }
      }),
    );

    return results;
  }
}

// ---- Topological sort ----

/**
 * Kahn's algorithm (BFS-based topological sort).
 * Returns plugin names in dependency-first order.
 * Throws on circular dependencies or missing dependency references.
 */
function topoSort(factories: Map<string, PluginFactory<unknown>>): string[] {
  const inDegree = new Map<string, number>();
  // dependents[dep] = plugins that depend on dep
  const dependents = new Map<string, string[]>();

  for (const [name] of factories) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const [name, factory] of factories) {
    for (const dep of factory.manifest.dependencies ?? []) {
      if (!factories.has(dep)) {
        throw new Error(
          `Plugin "${name}" depends on "${dep}", but "${dep}" is not registered`,
        );
      }
      const existing = dependents.get(dep) ?? [];
      existing.push(name);
      dependents.set(dep, existing);
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  // Start with nodes that have no unmet dependencies.
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    // Stable alphabetical sort within the queue for determinism.
    queue.sort();
    const current = queue.shift()!;
    sorted.push(current);

    for (const dependent of dependents.get(current) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (sorted.length !== factories.size) {
    const inCycle = [...factories.keys()].filter((n) => !sorted.includes(n));
    throw new Error(
      `Circular dependency detected among plugins: ${inCycle.sort().join(', ')}`,
    );
  }

  return sorted;
}
