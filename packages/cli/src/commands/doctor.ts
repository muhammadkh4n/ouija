/**
 * `ouija doctor` — preflight audit of the current project directory.
 *
 * Runs a sequence of checks and prints a pass/warn/fail report. Designed to
 * catch the common "it doesn't work" failures before the user files an issue.
 *
 * Exit code:
 *   0  — all checks passed (warnings are OK)
 *   1  — one or more checks failed
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { projectPath } from '../lib/paths.js';
import { parseEnv } from '../lib/env-file.js';
import { log } from '../lib/logger.js';
import pc from 'picocolors';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export async function runDoctor(_argv: readonly string[]): Promise<number> {
  log.step('Ouija doctor');
  const results: CheckResult[] = [];

  results.push(checkCommand('docker', ['compose', 'version'], 'Docker Compose v2'));
  results.push(checkCommand('git', ['--version'], 'Git'));
  results.push(checkCommand('openssl', ['version'], 'openssl'));

  results.push(await checkEnvFile());
  results.push(await checkConfigFile());
  results.push(await checkComposeFile());
  results.push(await checkAuthMethod());
  results.push(await checkOptionalClaudeCli());

  console.log('');
  let failures = 0;
  for (const r of results) {
    const icon = r.status === 'pass' ? pc.green('✓') : r.status === 'warn' ? pc.yellow('!') : pc.red('✗');
    const label = r.status === 'fail' ? pc.red(r.name) : r.name;
    console.log(`  ${icon} ${label}`);
    if (r.detail) console.log(`      ${pc.dim(r.detail)}`);
    if (r.status === 'fail') failures++;
  }
  console.log('');

  if (failures === 0) {
    log.success(`All checks passed${results.some((r) => r.status === 'warn') ? ' (with warnings)' : ''}`);
    return 0;
  }
  log.error(`${failures} check(s) failed`);
  return 1;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkCommand(
  cmd: string,
  args: readonly string[],
  label: string,
): CheckResult {
  const result = spawnSync(cmd, args as string[], { stdio: 'ignore' });
  if (result.status === 0) {
    return { name: `${label} available on PATH`, status: 'pass' };
  }
  return {
    name: `${label} available on PATH`,
    status: 'fail',
    detail: `'${cmd} ${args.join(' ')}' failed — install ${label} first.`,
  };
}

async function checkEnvFile(): Promise<CheckResult> {
  const envPath = projectPath('.env');
  if (!existsSync(envPath)) {
    return {
      name: '.env exists',
      status: 'fail',
      detail: "Run 'ouija init' in this directory to create it.",
    };
  }
  const body = await readFile(envPath, 'utf8');
  const env = parseEnv(body);
  const secret = env['OUIJA_SECRET_KEY'] ?? '';
  if (secret.length < 32) {
    return {
      name: 'OUIJA_SECRET_KEY is 32+ chars',
      status: 'fail',
      detail: `Current length: ${secret.length}. Regenerate with 'openssl rand -hex 32'.`,
    };
  }
  return { name: '.env valid (OUIJA_SECRET_KEY set)', status: 'pass' };
}

async function checkConfigFile(): Promise<CheckResult> {
  const configPath = projectPath('ouija.config.yaml');
  if (!existsSync(configPath)) {
    return {
      name: 'ouija.config.yaml exists',
      status: 'fail',
      detail: "Run 'ouija init' to copy the example template.",
    };
  }
  const body = await readFile(configPath, 'utf8');
  if (!/agents\s*:/.test(body)) {
    return {
      name: 'ouija.config.yaml has agents',
      status: 'fail',
      detail: 'No top-level "agents:" key found.',
    };
  }
  if (body.includes('https://github.com/your-org/your-repo.git')) {
    return {
      name: 'ouija.config.yaml repo URL customized',
      status: 'warn',
      detail: 'Still pointing at the example repo URL — edit repos[].url.',
    };
  }
  return { name: 'ouija.config.yaml valid', status: 'pass' };
}

async function checkComposeFile(): Promise<CheckResult> {
  const path = projectPath('docker/docker-compose.ouija.yml');
  if (!existsSync(path)) {
    return {
      name: 'docker/docker-compose.ouija.yml exists',
      status: 'fail',
      detail: "Run 'ouija init' to copy compose files.",
    };
  }
  return { name: 'docker compose files present', status: 'pass' };
}

async function checkAuthMethod(): Promise<CheckResult> {
  const envPath = projectPath('.env');
  if (!existsSync(envPath)) {
    return { name: 'Claude auth configured', status: 'warn', detail: 'No .env' };
  }
  const env = parseEnv(await readFile(envPath, 'utf8'));
  const hasKey = (env['ANTHROPIC_API_KEY'] ?? '').length > 0;
  if (hasKey) {
    return { name: 'ANTHROPIC_API_KEY set', status: 'pass' };
  }
  return {
    name: 'ANTHROPIC_API_KEY set',
    status: 'warn',
    detail: 'Not set — agent will rely on Claude CLI session auth (~/.claude).',
  };
}

async function checkOptionalClaudeCli(): Promise<CheckResult> {
  const result = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  if (result.status === 0) {
    return { name: 'claude CLI available (optional)', status: 'pass' };
  }
  return {
    name: 'claude CLI available (optional)',
    status: 'warn',
    detail: 'Not found — OK if using ANTHROPIC_API_KEY only.',
  };
}
