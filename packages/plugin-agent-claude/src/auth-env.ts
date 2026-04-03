/**
 * Translate an auth method + secretRef into environment variables
 * for the Claude Code subprocess.
 */
export function buildAuthEnv(
  authMethod: string | undefined,
  secretRef: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const method = authMethod ?? 'api-key';

  // Resolve the secret value from the ref (currently only supports env: prefix)
  const resolveSecret = (ref: string): string | undefined => {
    if (ref.startsWith('env:')) {
      return process.env[ref.slice(4)];
    }
    return undefined;
  };

  switch (method) {
    case 'api-key': {
      const key = resolveSecret(secretRef);
      if (key) env['ANTHROPIC_API_KEY'] = key;
      break;
    }

    case 'bedrock': {
      env['CLAUDE_CODE_USE_BEDROCK'] = '1';
      // AWS credentials come from standard AWS env vars (already in process.env)
      // Forward them if present
      for (const awsVar of [
        'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
        'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE',
        'AWS_BEARER_TOKEN_BEDROCK',
      ]) {
        if (process.env[awsVar]) env[awsVar] = process.env[awsVar]!;
      }
      break;
    }

    case 'vertex': {
      env['CLAUDE_CODE_USE_VERTEX'] = '1';
      for (const gcpVar of [
        'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID',
        'GOOGLE_APPLICATION_CREDENTIALS',
      ]) {
        if (process.env[gcpVar]) env[gcpVar] = process.env[gcpVar]!;
      }
      break;
    }

    case 'foundry': {
      env['CLAUDE_CODE_USE_FOUNDRY'] = '1';
      // Azure credentials forwarded from process.env
      for (const azVar of [
        'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID',
        'AZURE_SUBSCRIPTION_ID',
      ]) {
        if (process.env[azVar]) env[azVar] = process.env[azVar]!;
      }
      break;
    }

    case 'api-key-helper': {
      // secretRef points to the helper script path
      // Claude Code reads apiKeyHelper from settings, but we can also
      // set it via the --settings flag. For now, just note this is
      // handled by the workspace settings.json merge in configDir.
      break;
    }

    case 'proxy': {
      // secretRef points to the bearer token
      const token = resolveSecret(secretRef);
      if (token) env['ANTHROPIC_AUTH_TOKEN'] = token;
      break;
    }

    default:
      // Unknown method — don't set any auth env vars
      break;
  }

  return env;
}
