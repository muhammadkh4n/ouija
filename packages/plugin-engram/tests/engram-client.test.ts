import { describe, it, expect, vi } from 'vitest';
import { EngramClient, EngramIngestError, type ExecFileFn } from '../src/engram-client.js';

function fakeExec(
  impl: (
    binary: string,
    args: readonly string[],
    options: { timeout: number; env: NodeJS.ProcessEnv; stdin?: string },
  ) => { stdout?: string; stderr?: string; exitCode?: number } | Promise<never>,
): ExecFileFn {
  return async (binary, args, options) => {
    const result = impl(binary, args, options);
    if (result instanceof Promise) return result;
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    };
  };
}

describe('EngramClient.ingest', () => {
  it('spawns engram-ingest with --stdin, --source, --project, --raw', async () => {
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    const execFn = fakeExec((binary, args) => {
      calls.push({ binary, args });
      return { exitCode: 0 };
    });
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await client.ingest(
      {
        content: '# Memory body',
        source: 'ouija-pipeline',
        project: 'ouija',
        raw: true,
      },
      5_000,
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.binary).toBe('engram-ingest');
    expect(call.args).toEqual([
      '--stdin',
      '--source',
      'ouija-pipeline',
      '--project',
      'ouija',
      '--raw',
    ]);
  });

  it('omits --raw when raw is false', async () => {
    let capturedArgs: readonly string[] = [];
    const execFn = fakeExec((_binary, args) => {
      capturedArgs = args;
      return { exitCode: 0 };
    });
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await client.ingest(
      {
        content: 'body',
        source: 'ouija-pipeline',
        project: 'ouija',
        raw: false,
      },
      5_000,
    );

    expect(capturedArgs).not.toContain('--raw');
  });

  it('passes --session-id when provided', async () => {
    let capturedArgs: readonly string[] = [];
    const execFn = fakeExec((_binary, args) => {
      capturedArgs = args;
      return { exitCode: 0 };
    });
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await client.ingest(
      {
        content: 'body',
        source: 'ouija-pipeline',
        project: 'ouija',
        raw: true,
        sessionId: 'inst_abc',
      },
      5_000,
    );

    expect(capturedArgs).toContain('--session-id');
    expect(capturedArgs[capturedArgs.indexOf('--session-id') + 1]).toBe('inst_abc');
  });

  it('forwards the content via stdin, not argv', async () => {
    let capturedStdin: string | undefined;
    let capturedArgs: readonly string[] = [];
    const execFn = fakeExec((_binary, args, options) => {
      capturedStdin = options.stdin;
      capturedArgs = args;
      return { exitCode: 0 };
    });
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await client.ingest(
      {
        content: '# Memory body with special chars: $()`',
        source: 'ouija-pipeline',
        project: 'ouija',
        raw: true,
      },
      5_000,
    );

    expect(capturedStdin).toBe('# Memory body with special chars: $()`');
    expect(capturedArgs).not.toContain('# Memory body with special chars: $()`');
  });

  it('propagates the timeout into execFile options', async () => {
    let capturedTimeout = 0;
    const execFn = fakeExec((_binary, _args, options) => {
      capturedTimeout = options.timeout;
      return { exitCode: 0 };
    });
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await client.ingest(
      { content: 'body', source: 'ouija-pipeline', project: 'ouija', raw: true },
      7_500,
    );

    expect(capturedTimeout).toBe(7_500);
  });

  it('throws EngramIngestError on non-zero exit', async () => {
    const execFn = fakeExec(() => ({
      exitCode: 2,
      stderr: 'SUPABASE_URL missing',
    }));
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await expect(
      client.ingest(
        { content: 'body', source: 'ouija-pipeline', project: 'ouija', raw: true },
        5_000,
      ),
    ).rejects.toBeInstanceOf(EngramIngestError);
  });

  it('propagates spawn ENOENT errors as thrown errors', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('not found'), {
      code: 'ENOENT',
    });
    const execFn: ExecFileFn = vi.fn().mockRejectedValue(err);
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });

    await expect(
      client.ingest(
        { content: 'body', source: 'ouija-pipeline', project: 'ouija', raw: true },
        5_000,
      ),
    ).rejects.toThrow('not found');
  });
});

describe('EngramClient.available', () => {
  it('returns true when the binary spawns successfully', async () => {
    const execFn = fakeExec(() => ({ exitCode: 0 }));
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });
    expect(await client.available()).toBe(true);
  });

  it('returns false (not throws) when the binary is missing', async () => {
    const execFn: ExecFileFn = vi.fn().mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'ENOENT' }),
    );
    const client = new EngramClient({ binaryPath: 'engram-ingest', execFn });
    expect(await client.available()).toBe(false);
  });
});
