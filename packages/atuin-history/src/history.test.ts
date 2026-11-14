import { describe, expect, test } from 'bun:test';
import { EXIT_TIMED_OUT, EXIT_UNKNOWN, exitCode, isRunning } from './history.ts';

describe('exitCode', () => {
  test('uses the exit code the command reported', () => {
    expect(exitCode({ exit: 0 })).toBe(0);
    expect(exitCode({ exit: 42 })).toBe(42);
  });

  test('prefers the reported exit code over a timeout', () => {
    expect(exitCode({ exit: 3, timeout: true })).toBe(3);
  });

  test('reports a timeout without an exit code as 124', () => {
    expect(exitCode({ timeout: true, signal: 'SIGTERM' })).toBe(EXIT_TIMED_OUT);
  });

  test('maps a terminating signal to 128 plus its number', () => {
    expect(exitCode({ signal: 'SIGINT' })).toBe(130);
    expect(exitCode({ signal: 'SIGKILL' })).toBe(137);
  });

  test('reports an unknown outcome as a failure', () => {
    expect(exitCode(undefined)).toBe(EXIT_UNKNOWN);
    expect(exitCode({})).toBe(EXIT_UNKNOWN);
    expect(exitCode({ exit: null })).toBe(EXIT_UNKNOWN);
    expect(exitCode({ signal: 'SIGNOPE' })).toBe(EXIT_UNKNOWN);
  });
});

describe('isRunning', () => {
  test('detects a command moved to the background', () => {
    expect(isRunning({ status: 'running' })).toBe(true);
    expect(isRunning({ status: 'completed', exit: 0 })).toBe(false);
    expect(isRunning(undefined)).toBe(false);
  });
});
