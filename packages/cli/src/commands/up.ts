/**
 * `ouija up [--stack ouija|full|fizzy]` — start the Ouija docker stack.
 *
 * Thin wrapper around `docker compose up -d`. Default stack is `ouija`
 * (BYO kanban, ~1.5GB RAM). Use --stack full for Ouija+Plane or
 * --stack fizzy for Ouija+Fizzy.
 */

import { runCompose, parseStackFlag } from '../lib/docker.js';
import { log } from '../lib/logger.js';

export async function runUp(argv: readonly string[]): Promise<number> {
  const stack = parseStackFlag(argv);
  const detach = !argv.includes('--foreground');
  log.step(`Starting stack: ${stack}`);
  const args = ['up', ...(detach ? ['-d'] : [])];
  const code = await runCompose(stack, args);
  if (code === 0) {
    log.success('Stack is up');
    log.dim(`  Health:  curl http://localhost:4000/healthz`);
    log.dim(`  Logs:    ouija logs`);
    log.dim(`  Status:  ouija status`);
  }
  return code;
}
