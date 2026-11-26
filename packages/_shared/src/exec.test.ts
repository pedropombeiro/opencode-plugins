import { describe, expect, test } from 'bun:test';
import { exec } from './exec.ts';

describe('exec', () => {
  test('captures stdout and a zero exit code', async () => {
    const result = await exec('sh', ['-c', 'printf "$GREETING"'], { env: { GREETING: 'hello' } });
    expect(result).toEqual({ stdout: 'hello', stderr: '', code: 0 });
  });

  test('reports a non-zero exit code without throwing', async () => {
    const result = await exec('sh', ['-c', 'echo oops >&2; exit 3']);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe('oops\n');
  });

  test('reports a missing executable without throwing', async () => {
    const result = await exec('opencode-plugins-missing-executable', []);
    expect(result.code).toBe(-1);
    expect(result.stderr).not.toBe('');
  });

  test('runs in the requested directory', async () => {
    const result = await exec('pwd', [], { cwd: '/' });
    expect(result.stdout.trim()).toBe('/');
  });

  test('passes stdin to the child process', async () => {
    const result = await exec('cat', [], { stdin: 'piped input' });
    expect(result).toEqual({ stdout: 'piped input', stderr: '', code: 0 });
  });

  test('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await exec('sleep', ['5'], { signal: controller.signal });
    expect(result.code).toBe(-1);
  });

  test('does not emit an unhandled EPIPE when child exits before consuming large stdin', async () => {
    const largeStdin = 'x'.repeat(2 * 1024 * 1024);
    const result = await exec('sh', ['-c', 'exit 2'], { stdin: largeStdin });
    expect(result.code).toBe(2);
  });
});
