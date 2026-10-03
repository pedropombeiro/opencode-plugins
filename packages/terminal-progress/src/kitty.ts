import { readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exec } from '../../_shared/src/index.ts';

type Env = Record<string, string | undefined>;
type Version = readonly number[];

export const KITTY_MIN_SUPPORTED = [0, 47, 0] as const;

export interface KittyDeps {
  readlink(path: string): string;
  version(binary: string): Promise<string | undefined>;
}

const defaultDeps: KittyDeps = {
  readlink: (path) => readlinkSync(path),
  async version(binary) {
    const result = await exec(binary, ['--version'], { timeout: 2000 });
    return result.code === 0 ? result.stdout : undefined;
  },
};

export function parseKittyVersion(value: string): Version | undefined {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function isSupportedKitty(version: Version): boolean {
  for (let i = 0; i < KITTY_MIN_SUPPORTED.length; i++) {
    if ((version[i] ?? 0) > KITTY_MIN_SUPPORTED[i]) return true;
    if ((version[i] ?? 0) < KITTY_MIN_SUPPORTED[i]) return false;
  }
  return true;
}

export function isKittyHost(env: Env): boolean {
  const termProgram = env['TERM_PROGRAM'];
  if (termProgram === 'kitty') return true;
  if (!env['KITTY_WINDOW_ID']) return false;
  return !termProgram || termProgram === 'tmux';
}

export function kittyBinaries(env: Env, deps: Pick<KittyDeps, 'readlink'> = defaultDeps): string[] {
  const binaries: string[] = [];
  const pid = env['KITTY_PID'];
  if (pid && /^\d+$/.test(pid)) {
    const exe = `/proc/${pid}/exe`;
    try {
      if (basename(deps.readlink(exe).replace(/ \(deleted\)$/, '')) === 'kitty') {
        binaries.push(exe);
      }
    } catch {
      // no /proc (e.g. macOS) or the process is gone
    }
  }
  const installDir = env['KITTY_INSTALLATION_DIR'];
  if (installDir) {
    binaries.push(join(installDir, '..', '..', 'bin', 'kitty'));
    binaries.push(join(installDir, '..', '..', 'MacOS', 'kitty'));
  }
  return binaries;
}

export async function detectKittyVersion(
  env: Env,
  deps: KittyDeps = defaultDeps,
): Promise<Version | undefined> {
  if (env['TERM_PROGRAM'] === 'kitty' && env['TERM_PROGRAM_VERSION']) {
    const parsed = parseKittyVersion(env['TERM_PROGRAM_VERSION']);
    if (parsed) return parsed;
  }
  for (const binary of kittyBinaries(env, deps)) {
    const output = await deps.version(binary);
    const parsed = output && /^kitty\s/.test(output) ? parseKittyVersion(output) : undefined;
    if (parsed) return parsed;
  }
  return undefined;
}

export async function detectKitty(env: Env, deps: KittyDeps = defaultDeps): Promise<boolean> {
  const version = await detectKittyVersion(env, deps);
  return !!version && isSupportedKitty(version);
}
