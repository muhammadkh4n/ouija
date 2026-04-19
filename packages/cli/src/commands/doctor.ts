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

  // WS2.4 additions — catch the friction points self-hosters hit on first run.
  results.push(await checkConfigPlaceholders());
  results.push(await checkGhAuth());
  results.push(await checkPlaneReachable());
  results.push(await checkSubscriptionMount());
  results.push(checkContainerCli());

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

// ---------------------------------------------------------------------------
// WS2.4 additions
// ---------------------------------------------------------------------------

/**
 * Detect unedited placeholder values in ouija.config.yaml. The only
 * unambiguous placeholder is the example repo URL — agent emails like
 * rex@ouija.local are legitimate bot identities, not template values.
 *
 * Upgraded from the original warn-only check — a repo URL pointing at a
 * repo that does not exist is guaranteed to break dispatch, so failing
 * fast with a clear message is more useful than a silent deploy.
 */
async function checkConfigPlaceholders(): Promise<CheckResult> {
  const configPath = projectPath('ouija.config.yaml');
  if (!existsSync(configPath)) {
    return {
      name: 'ouija.config.yaml has no placeholder values',
      status: 'warn',
      detail: "Config missing — run 'ouija init'.",
    };
  }
  const body = await readFile(configPath, 'utf8');
  const placeholders: string[] = [];
  if (body.includes('your-org/your-repo.git')) placeholders.push('repos[].url');
  if (/systemPrompt:\s*["']?TODO\s/i.test(body)) placeholders.push('agents[].systemPrompt');
  if (placeholders.length === 0) {
    return { name: 'ouija.config.yaml has no placeholder values', status: 'pass' };
  }
  return {
    name: 'ouija.config.yaml has no placeholder values',
    status: 'fail',
    detail: `Unedited placeholders in: ${placeholders.join(', ')}. Edit ouija.config.yaml or re-run 'ouija init --preset <name>'.`,
  };
}

/**
 * Check GitHub auth — the agent subprocess calls `gh pr create` via the
 * credential helper, which requires `gh auth login` to have completed.
 */
async function checkGhAuth(): Promise<CheckResult> {
  const which = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  if (which.status !== 0) {
    return {
      name: 'gh CLI authenticated',
      status: 'warn',
      detail: "gh CLI not installed on host. Needed for the agent's `gh pr create`. See https://cli.github.com/.",
    };
  }
  const status = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  if (status.status === 0) {
    return { name: 'gh CLI authenticated', status: 'pass' };
  }
  return {
    name: 'gh CLI authenticated',
    status: 'fail',
    detail: "`gh auth status` failed. Run `gh auth login` then `gh auth setup-git`.",
  };
}

/**
 * Check that PLANE_BASE_URL + PLANE_API_TOKEN actually work. Does NOT try to
 * verify workspace/project existence — that's the plugin's job at start(). We
 * just prove the token is live and the host is reachable.
 */
async function checkPlaneReachable(): Promise<CheckResult> {
  const envPath = projectPath('.env');
  if (!existsSync(envPath)) {
    return { name: 'Plane API reachable', status: 'warn', detail: 'No .env — skipped.' };
  }
  const env = parseEnv(await readFile(envPath, 'utf8'));
  const baseUrl = env['PLANE_BASE_URL'];
  const token = env['PLANE_API_TOKEN'];
  if (!baseUrl || !token) {
    return {
      name: 'Plane API reachable',
      status: 'warn',
      detail: 'PLANE_BASE_URL or PLANE_API_TOKEN not set — skipped (OK if using Fizzy or standalone).',
    };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/users/me/`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Api-Key': token },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      return { name: 'Plane API reachable', status: 'pass' };
    }
    return {
      name: 'Plane API reachable',
      status: 'fail',
      detail: `GET ${url} returned ${res.status}. Check PLANE_API_TOKEN + PLANE_BASE_URL.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'Plane API reachable',
      status: 'fail',
      detail: `Fetch failed: ${message}. Is the Plane container running?`,
    };
  }
}

/**
 * When config declares runner: local or stream-json, the bundled in-container
 * Claude CLI needs access to ~/.claude for subscription auth. Check that the
 * docker compose file actually bind-mounts it.
 */
async function checkSubscriptionMount(): Promise<CheckResult> {
  const configPath = projectPath('ouija.config.yaml');
  if (!existsSync(configPath)) {
    return {
      name: '~/.claude bind-mount (subscription auth)',
      status: 'warn',
      detail: 'No config — skipped.',
    };
  }
  const body = await readFile(configPath, 'utf8');
  const usesSubscription =
    /runner:\s*(?:local|stream-json)\b/.test(body) || !/runner:/.test(body);
  if (!usesSubscription) {
    return {
      name: '~/.claude bind-mount (subscription auth)',
      status: 'pass',
      detail: 'Config uses runner: sdk (API-billed) — no mount needed.',
    };
  }

  // Look for the mount in either compose variant. Docker accepts ~, ${HOME},
  // or an absolute path — accept all three.
  const composeFiles = [
    projectPath('docker/docker-compose.ouija.yml'),
    projectPath('docker/docker-compose.yml'),
  ].filter((p) => existsSync(p));
  if (composeFiles.length === 0) {
    return {
      name: '~/.claude bind-mount (subscription auth)',
      status: 'warn',
      detail: 'No docker-compose files — skipped.',
    };
  }
  const mountPattern = /\$\{?HOME\}?\/\.claude|~\/\.claude|\/[a-zA-Z0-9_\-/]+\/\.claude/;
  for (const path of composeFiles) {
    const content = await readFile(path, 'utf8');
    if (mountPattern.test(content) && /\/home\/node\/\.claude/.test(content)) {
      return { name: '~/.claude bind-mount (subscription auth)', status: 'pass' };
    }
  }
  return {
    name: '~/.claude bind-mount (subscription auth)',
    status: 'warn',
    detail: 'runner: local/stream-json set but ~/.claude mount not found in docker-compose. Subscription auth will not work from the container — agent will fall back to ANTHROPIC_API_KEY or fail. See SECURITY.md.',
  };
}

/**
 * Check that `claude --version` works inside the ouija container. Requires
 * the container to already be running. A no-op skip when the container is
 * not up (common for first-time doctor invocations before `ouija up`).
 */
function checkContainerCli(): CheckResult {
  // Is the ouija container running?
  const ps = spawnSync(
    'docker',
    ['compose', '-f', 'docker/docker-compose.ouija.yml', 'ps', '--format', '{{.Name}}\t{{.State}}'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (ps.status !== 0) {
    return {
      name: 'claude CLI inside ouija container',
      status: 'warn',
      detail: 'Container not running — start the stack with `ouija up` then re-run doctor.',
    };
  }
  const running = (ps.stdout ?? '').split('\n').some((line) => {
    const [name, state] = line.split('\t');
    return name?.includes('ouija') && state === 'running';
  });
  if (!running) {
    return {
      name: 'claude CLI inside ouija container',
      status: 'warn',
      detail: 'ouija container not in "running" state — start with `ouija up`.',
    };
  }
  const exec = spawnSync(
    'docker',
    ['compose', '-f', 'docker/docker-compose.ouija.yml', 'exec', '-T', 'ouija', 'claude', '--version'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (exec.status === 0) {
    const version = (exec.stdout ?? '').trim().split('\n')[0] ?? 'unknown';
    return {
      name: 'claude CLI inside ouija container',
      status: 'pass',
      detail: version,
    };
  }
  return {
    name: 'claude CLI inside ouija container',
    status: 'fail',
    detail: '`docker compose exec ouija claude --version` failed. The container image is stale or the bundle step in the Dockerfile did not run — rebuild with `docker compose build ouija`.',
  };
}
