import { exec as run, type ExecResult } from '../../_shared/src/index.ts';

export type { ExecResult };

export type Exec = (file: string, args: string[], cwd: string) => Promise<ExecResult>;

// Runs a command without a shell, so arguments are never reinterpreted.
export const execWithTimeout =
  (timeout: number): Exec =>
  (file, args, cwd) =>
    run(file, args, { cwd, timeout });

export const exec = execWithTimeout(30_000);
