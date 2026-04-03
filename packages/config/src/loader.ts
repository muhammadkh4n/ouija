import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { validateConfig } from './schema.js';
import type { OuijaConfig } from './types.js';

export async function loadConfig(configPath: string): Promise<OuijaConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw err;
  }

  const data: unknown = parse(raw);
  const result = validateConfig(data);

  if (!result.valid) {
    throw new Error(
      `Invalid config at ${configPath}:\n  - ${result.errors.join('\n  - ')}`,
    );
  }

  return result.config;
}
