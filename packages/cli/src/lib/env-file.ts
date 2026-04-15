/**
 * Minimal .env file parser and writer.
 *
 * Preserves comments and blank lines, updates existing keys in place,
 * and appends new keys at the end of the file.
 */

export interface EnvUpdates {
  [key: string]: string;
}

/** Parse a .env file body into a flat key/value map. */
export function parseEnv(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Apply updates to a .env file body, preserving formatting.
 *
 * - Existing keys are updated in place (value after `=` is replaced).
 * - Commented-out keys (`# FOO=bar`) are uncommented and updated.
 * - New keys are appended at the end under a `# Added by ouija CLI` header.
 */
export function applyEnvUpdates(body: string, updates: EnvUpdates): string {
  const lines = body.split('\n');
  const applied = new Set<string>();

  const updatedLines = lines.map((line) => {
    for (const [key, value] of Object.entries(updates)) {
      if (applied.has(key)) continue;

      const activePattern = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=.*$`);
      const commentedPattern = new RegExp(
        `^(\\s*)#\\s*${escapeRegex(key)}\\s*=.*$`,
      );

      if (activePattern.test(line)) {
        applied.add(key);
        const indent = line.match(activePattern)?.[1] ?? '';
        return `${indent}${key}=${value}`;
      }
      if (commentedPattern.test(line)) {
        applied.add(key);
        const indent = line.match(commentedPattern)?.[1] ?? '';
        return `${indent}${key}=${value}`;
      }
    }
    return line;
  });

  const appended: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (applied.has(key)) continue;
    appended.push(`${key}=${value}`);
  }

  if (appended.length > 0) {
    const needsBlank =
      updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== '';
    if (needsBlank) updatedLines.push('');
    updatedLines.push('# Added by ouija CLI');
    updatedLines.push(...appended);
  }

  return updatedLines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
