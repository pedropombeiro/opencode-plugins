import { describe, expect, test } from 'bun:test';
import { EXIT_TIMED_OUT, EXIT_UNKNOWN, exitCode, isRunning, startArgs } from './history.ts';

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

describe('startArgs', () => {
  test('marks the entry as run by the opencode agent', () => {
    expect(startArgs('ls -la', { command: 'ls -la' })).toEqual([
      'history',
      'start',
      '--author',
      'opencode',
      '--author-kind',
      'agent',
      '--',
      'ls -la',
    ]);
  });

  test('records the tool description as the intent', () => {
    expect(startArgs('ls', { command: 'ls', description: ' List files ' })).toEqual([
      'history',
      'start',
      '--author',
      'opencode',
      '--author-kind',
      'agent',
      '--intent',
      'List files',
      '--',
      'ls',
    ]);
  });

  test('omits an empty or missing intent', () => {
    expect(startArgs('ls', { command: 'ls', description: '  ' })).not.toContain('--intent');
    expect(startArgs('ls', undefined)).not.toContain('--intent');
  });

  test('passes a command that looks like an option after the separator', () => {
    expect(startArgs('--help', undefined).slice(-2)).toEqual(['--', '--help']);
  });
});
