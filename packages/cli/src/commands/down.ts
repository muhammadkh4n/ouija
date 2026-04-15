/**
 * `ouija down [--stack ...] [--volumes]` — stop the Ouija docker stack.
 *
 * By default, volumes are preserved so your database survives restarts.
 * Pass --volumes to also remove Postgres and Redis data.
 */

import { runCompose, parseStackFlag } from '../lib/docker.js';
import { log } from '../lib/logger.js';

export async function runDown(argv: readonly string[]): Promise<number> {
  const stack = parseStackFlag(argv);
  const withVolumes = argv.includes('--volumes') || argv.includes('-v');
  log.step(`Stopping stack: ${stack}${withVolumes ? ' (with volumes)' : ''}`);
  const args = ['down', ...(withVolumes ? ['-v'] : [])];
  const code = await runCompose(stack, args);
  if (code === 0) log.success('Stack is down');
  return code;
}
