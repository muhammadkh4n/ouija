/**
 * `ouija status [--stack ...]` — show `docker compose ps` for the stack.
 */

import { runCompose, parseStackFlag } from '../lib/docker.js';

export async function runStatus(argv: readonly string[]): Promise<number> {
  const stack = parseStackFlag(argv);
  return runCompose(stack, ['ps']);
}
