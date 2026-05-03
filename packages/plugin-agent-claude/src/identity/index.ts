/**
 * Identity layer barrel — Phase 3 Task 6.
 *
 * Public surface for the orchestrator (Task 8) once it switches from
 * bind-mounting `${HOME}/.claude:ro` to materialising a per-dispatch
 * private home from a chosen `AuthProvider`.
 */

export type {
  AuthProvider,
  AuthProviderConfig,
  AuthProviderKind,
  ClaudeCredentials,
  CredentialFileProviderConfig,
  EnvProviderConfig,
  HelperCommandProviderConfig,
  KeychainProviderConfig,
  ResolvedIdentity,
} from './types.js';

export { CredentialFileProvider, defaultCredentialFilePath } from './credential-file-provider.js';
export { EnvProvider } from './env-provider.js';
export {
  HelperCommandProvider,
  defaultHelperRunner,
  type HelperRunResult,
  type HelperRunner,
} from './helper-command-provider.js';
export {
  KeychainProvider,
  buildKeychainArgs,
  defaultKeychainRunner,
  diagnoseKeychainExit,
  type KeychainRunResult,
  type KeychainRunner,
} from './keychain-provider.js';
export {
  MATERIALIZED_FILES,
  materializeClaudeHome,
  neutralClaudeJson,
  neutralSettingsJson,
  type MaterializedHome,
  type MaterializeInput,
} from './materialize-home.js';
export {
  AUTO_DETECT_ORDER,
  autoDetectAuthProvider,
  createAuthProvider,
} from './factory.js';
