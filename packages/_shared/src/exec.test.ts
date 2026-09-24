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
});
