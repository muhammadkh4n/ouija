import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { projectPath } from './paths.js';
import { die, log } from './logger.js';

/**
 * Supported compose stacks. Phase 3 Task 10 dropped the legacy
 * `'full'` preset (Plane-AIO bundle) — its image
 * `makeplane/plane-aio:v0.23-dev` was never on Docker Hub, so the
 * preset literally couldn't start (friction-log #1).
 */
export type StackName = 'ouija' | 'fizzy';

const COMPOSE_FILES: Record<StackName, string> = {
  ouija: 'docker/docker-compose.ouija.yml',
  fizzy: 'docker/docker-compose.fizzy.yml',
};

/** Assert that `docker compose` (v2) is available. Exits on failure. */
export function assertDockerAvailable(): void {
  const result = spawnSync('docker', ['compose', 'version'], {
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    die(
      'docker compose (v2) is required but not found on PATH.\n' +
        '  Install Docker Desktop or the docker-compose-plugin package.',
    );
  }
}

/** Resolve a stack name to an absolute compose file path in the user's project. */
export function resolveComposeFile(stack: StackName): string {
  const relative = COMPOSE_FILES[stack];
  const abs = projectPath(relative);
  if (!existsSync(abs)) {
    die(
      `Compose file not found: ${relative}\n` +
        `  Did you run '${log.code('ouija init')}' in this directory?`,
    );
  }
  return abs;
}

/** Run `docker compose` with the given args, inheriting stdio. */
export function runCompose(
  stack: StackName,
  args: readonly string[],
): Promise<number> {
  assertDockerAvailable();
  const composeFile = resolveComposeFile(stack);
  // Pin the project directory to the user's project root so .env resolves
  // relative to where the user ran the CLI, not to the compose file's own
  // directory (which is docker/ and has no .env).
  const projectDir = projectPath('.');
  const fullArgs = [
    'compose',
    '--project-directory',
    projectDir,
    '-f',
    composeFile,
    ...args,
  ];
  return new Promise((resolve) => {
    const child = spawn('docker', fullArgs, {
      stdio: 'inherit',
      cwd: projectDir,
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Parse the --stack flag from argv. Defaults to 'ouija'. */
export function parseStackFlag(argv: readonly string[]): StackName {
  const idx = argv.findIndex((a) => a === '--stack' || a === '-s');
  if (idx === -1) return 'ouija';
  const value = argv[idx + 1];
  if (value === 'ouija' || value === 'fizzy') {
    return value;
  }
  // Phase 3 Task 10: explicit migration message for self-hosters who still
  // pass `--stack full` from a v0.4.x muscle-memory.
  if (value === 'full') {
    die(
      `--stack full was removed in v0.5.0. The Plane preset is gone (friction-log #1).\n` +
        `  Use --stack ouija (BYO kanban or 'ouija watch') or --stack fizzy.\n` +
        `  Re-run 'npx @ouija-dev/cli init --force --preset byo-kanban' (or self-hosted-fizzy) to refresh your project.`,
    );
  }
  die(`Unknown stack: ${value ?? '(empty)'}. Use ouija or fizzy.`);
}
