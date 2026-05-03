import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const workspacePackages = [
  'agent-worker',
  'bus',
  'cli',
  'config',
  'dashboard',
  'engine',
  'plugin-agent-claude',
  'plugin-engram',
  'plugin-fizzy',
  'plugin-github',
  'plugin-notify-telegram',
  'plugin-plane',
  'plugin-sdk',
  'server',
  'types',
  'workspace-local',
] as const;

// Vite 8 strict ESM resolution refuses to resolve workspace packages whose
// `exports`/`main` point at `dist/` before they've been built. For the
// vitest harness only, alias `@ouija-dev/<pkg>[/sub]` straight to the
// source TypeScript so a cold checkout (no prior `turbo run build`) can
// still run `vitest`. Production runtime is unchanged: node consults each
// package's `exports` → compiled `dist/index.js`.
export const ouijaSourceAliases = [
  // Subpath imports first so the bare-name alias doesn't shadow them.
  ...workspacePackages.map((name) => ({
    find: new RegExp(`^@ouija-dev/${name}/(.+)$`),
    replacement: resolve(root, `packages/${name}/src/$1.ts`),
  })),
  ...workspacePackages.map((name) => ({
    find: new RegExp(`^@ouija-dev/${name}$`),
    replacement: resolve(root, `packages/${name}/src/index.ts`),
  })),
];
