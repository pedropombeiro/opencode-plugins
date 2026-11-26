import { exec as run, type ExecOptions, type ExecResult } from '../../_shared/src/index.ts';

export type { ExecOptions, ExecResult };

export type Exec = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = (file, args, options = {}) =>
  run(file, args, { ...options, timeout: options.timeout ?? 30_000 });
