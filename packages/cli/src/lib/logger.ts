import pc from 'picocolors';

export const log = {
  info: (msg: string): void => console.log(`${pc.blue('›')} ${msg}`),
  success: (msg: string): void => console.log(`${pc.green('✓')} ${msg}`),
  warn: (msg: string): void => console.log(`${pc.yellow('!')} ${msg}`),
  error: (msg: string): void => console.error(`${pc.red('✗')} ${msg}`),
  step: (msg: string): void => console.log(`\n${pc.bold(pc.cyan(msg))}`),
  dim: (msg: string): void => console.log(pc.dim(msg)),
  code: (msg: string): string => pc.cyan(msg),
};

/** Exit with an error message. Never returns. */
export function die(msg: string, code = 1): never {
  log.error(msg);
  process.exit(code);
}
