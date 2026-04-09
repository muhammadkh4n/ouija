// ---- Plugin SDK public API ----

export { validateConfig, validateConfigOrThrow } from './config-validator.js';
export type { ValidationResult } from './config-validator.js';

export { PluginLoader } from './plugin-loader.js';
export type { PluginRegistration, PluginFactory } from './plugin-loader.js';

// Test utilities are intentionally kept under a sub-path so production code
// cannot accidentally import mocks. Re-exported here for convenience when
// tests are co-located with source (the test runner resolves from the package
// root). Plugin authors can also import directly from
// '@ouija-dev/plugin-sdk/test-utils'.
export * from './test-utils/index.js';
