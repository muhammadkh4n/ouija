import { Ajv } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import { createRequire } from 'node:module';
import type { JSONSchema } from '@ouija/types';

// ajv-formats is a CJS-only package; use createRequire to import it
// in a way that works with NodeNext module resolution.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const addFormats: FormatsPlugin = require('ajv-formats') as FormatsPlugin;

// ---- Ajv instance (shared, compiled schemas are cached) ----

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// ---- Validation result ----

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate `data` against a JSON Schema.
 *
 * On success: `{ valid: true, errors: [] }`
 * On failure: `{ valid: false, errors: ['apiToken is required', ...] }`
 *
 * The caller is responsible for narrowing the type after a `valid` check.
 * Typical usage:
 *
 *   const result = validateConfig(manifest.configSchema, rawConfig);
 *   if (!result.valid) throw new Error(result.errors.join('; '));
 *   const config = rawConfig as MyPluginConfig; // safe after validation
 */
export function validateConfig(schema: JSONSchema, data: unknown): ValidationResult {
  const validate = ajv.compile(schema);
  const valid = validate(data) as boolean;

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors ?? []).map((err) => {
    // Build human-readable messages that include the field path.
    // err.instancePath is empty for top-level missing-required errors;
    // the field name comes from err.params in that case.
    const path = err.instancePath
      ? err.instancePath.replace(/^\//, '').replace(/\//g, '.')
      : '';

    if (err.keyword === 'required') {
      const field = (err.params as { missingProperty: string }).missingProperty;
      return `${field} is required`;
    }

    if (path) {
      return `${path} ${err.message ?? 'is invalid'}`;
    }

    return err.message ?? 'validation failed';
  });

  return { valid: false, errors };
}

/**
 * Validate config and format error messages with the plugin name prefix.
 * Throws if config is invalid.
 *
 * Example error: "Plugin @ouija/plugin-plane config error: apiToken is required"
 */
export function validateConfigOrThrow(
  pluginName: string,
  schema: JSONSchema,
  data: unknown,
): void {
  const result = validateConfig(schema, data);
  if (!result.valid) {
    const messages = result.errors.join('; ');
    throw new Error(`Plugin ${pluginName} config error: ${messages}`);
  }
}
