import { constants } from 'node:os';

export const EXIT_TIMED_OUT = 124;
export const EXIT_UNKNOWN = 1;

export interface ShellMetadata {
  status?: unknown;
  exit?: unknown;
  signal?: unknown;
  timeout?: unknown;
}

export function isRunning(metadata: ShellMetadata | undefined): boolean {
  return metadata?.status === 'running';
}

export function exitCode(metadata: ShellMetadata | undefined): number {
  if (typeof metadata?.exit === 'number') return metadata.exit;
  if (metadata?.timeout === true) return EXIT_TIMED_OUT;
  if (typeof metadata?.signal === 'string') {
    const signal = constants.signals[metadata.signal as NodeJS.Signals];
    if (typeof signal === 'number') return 128 + signal;
  }
  return EXIT_UNKNOWN;
}
