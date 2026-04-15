#!/usr/bin/env node
/**
 * @ouija-dev/cli — command-line interface for Ouija.
 *
 * Top-level router. Each command lives in src/commands/ and returns an exit
 * code as a Promise<number>. The router itself is a switch statement — no
 * CLI framework, no surprise deps.
 */

import { runInit, parseInitArgs } from './commands/init.js';
import { runUp } from './commands/up.js';
import { runDown } from './commands/down.js';
import { runLogs } from './commands/logs.js';
import { runStatus } from './commands/status.js';
import { runDoctor } from './commands/doctor.js';
import { log } from './lib/logger.js';

const VERSION = '0.1.0';

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  switch (command) {
    case 'init':
      return runInit(parseInitArgs(rest));
    case 'up':
      return runUp(rest);
    case 'down':
      return runDown(rest);
    case 'logs':
      return runLogs(rest);
    case 'status':
    case 'ps':
      return runStatus(rest);
    case 'doctor':
      return runDoctor(rest);
    default:
      log.error(`Unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`
ouija — command-line interface for the Ouija pipeline engine

Usage:
  ouija <command> [options]

Commands:
  init [--force] [-y]         Bootstrap a project in the current directory
                              (generates secrets, copies docker/ + config)
  up [--stack S]              Start the docker stack (S = ouija|full|fizzy)
  down [--stack S] [-v]       Stop the stack (-v also removes volumes)
  logs [service] [--stack S]  Tail docker compose logs
  status [--stack S]          Show docker compose ps for the stack
  doctor                      Preflight audit of the current project
  version                     Print the CLI version
  help                        Show this message

Stacks:
  ouija   (default)  Ouija + Postgres + Redis  — bring your own kanban
  full               Ouija + Postgres + Redis + Plane (self-hosted)
  fizzy              Ouija + Postgres + Redis + Fizzy (self-hosted)

Examples:
  npx @ouija-dev/cli init
  ouija up
  ouija logs ouija --follow
  ouija doctor
  ouija down --volumes

Docs: https://github.com/muhammadkh4n/ouija#readme
`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
