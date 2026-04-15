import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the packaged assets directory.
 *
 * Resolves to `<package>/assets/` regardless of whether the CLI is running
 * from the monorepo (dist/lib/paths.js → ../../assets) or from an installed
 * npm package (node_modules/@ouija-dev/cli/dist/lib/paths.js → ../../assets).
 */
export const ASSETS_DIR = resolve(__dirname, '..', '..', 'assets');

/** Path to a file inside the assets directory. */
export function assetPath(relative: string): string {
  return join(ASSETS_DIR, relative);
}

/** Current working directory — the user's project root. */
export function projectRoot(): string {
  return process.cwd();
}

/** Path to a file inside the user's project root. */
export function projectPath(relative: string): string {
  return join(projectRoot(), relative);
}
