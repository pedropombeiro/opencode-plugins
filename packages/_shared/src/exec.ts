import { execFile } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function exec(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeout,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : -1;
        resolve({ stdout, stderr: stderr || error.message, code });
      },
    );
  });
}
