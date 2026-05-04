/**
 * `ouija logs [service] [--stack ...] [--follow]` — tail docker compose logs.
 *
 * Examples:
 *   ouija logs                  # tail all services, follow by default
 *   ouija logs ouija            # only the ouija container
 *   ouija logs --stack fizzy    # tail the Fizzy-bundled stack
 *   ouija logs --no-follow      # print once and exit
 */

import { runCompose, parseStackFlag } from '../lib/docker.js';

export async function runLogs(argv: readonly string[]): Promise<number> {
  const stack = parseStackFlag(argv);
  const follow = !argv.includes('--no-follow');

  // Positional service name — the first argv entry that isn't a flag or a
  // --stack value.
  const service = positional(argv);

  const args = ['logs'];
  if (follow) args.push('-f');
  args.push('--tail', '200');
  if (service) args.push(service);

  return runCompose(stack, args);
}

function positional(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('-')) {
      // Skip flag and its value if the flag takes one.
      if (a === '--stack' || a === '-s') i++;
      continue;
    }
    // The immediately-preceding arg consumed --stack's value, so check it.
    const prev = argv[i - 1];
    if (prev === '--stack' || prev === '-s') continue;
    return a;
  }
  return undefined;
}
