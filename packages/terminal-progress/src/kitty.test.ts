import { describe, expect, test } from 'bun:test';
import {
  detectKitty,
  detectKittyVersion,
  isKittyHost,
  isSupportedKitty,
  kittyBinaries,
  parseKittyVersion,
  type KittyDeps,
} from './kitty.ts';

function deps(links: Record<string, string>, versions: Record<string, string>) {
  const calls: string[] = [];
  const value: KittyDeps = {
    readlink(path) {
      const target = links[path];
      if (target === undefined) throw new Error('ENOENT');
      return target;
    },
    async version(binary) {
      calls.push(binary);
      return versions[binary];
    },
  };
  return { deps: value, calls };
}

describe('parseKittyVersion', () => {
  test('parses kitty --version output', () => {
    expect(parseKittyVersion('kitty 0.49.2 created by Kovid Goyal\n')).toEqual([0, 49, 2]);
  });

  test('defaults the patch component to 0', () => {
    expect(parseKittyVersion('0.47')).toEqual([0, 47, 0]);
  });

  test('rejects unparsable input', () => {
    expect(parseKittyVersion('kitty')).toBeUndefined();
  });
});

describe('isSupportedKitty', () => {
  test.each([
    [[0, 47, 0], true],
    [[0, 49, 2], true],
    [[1, 0, 0], true],
    [[0, 46, 9], false],
    [[0, 38, 0], false],
  ])('%p -> %p', (version, expected) => {
    expect(isSupportedKitty(version)).toBe(expected);
  });
});

describe('isKittyHost', () => {
  test('detects kitty without TERM_PROGRAM', () => {
    expect(isKittyHost({ KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' })).toBe(true);
  });

  test('detects kitty through tmux', () => {
    expect(isKittyHost({ KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'tmux' })).toBe(true);
  });

  test('detects an explicit TERM_PROGRAM=kitty', () => {
    expect(isKittyHost({ TERM_PROGRAM: 'kitty' })).toBe(true);
  });

  test('ignores a leaked KITTY_WINDOW_ID in a nested terminal', () => {
    expect(isKittyHost({ KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'ghostty' })).toBe(false);
    expect(isKittyHost({ KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'WezTerm' })).toBe(false);
  });

  test('is false outside kitty', () => {
    expect(isKittyHost({ TERM_PROGRAM: 'ghostty' })).toBe(false);
    expect(isKittyHost({})).toBe(false);
  });
});

describe('kittyBinaries', () => {
  test('uses the running kitty via /proc first', () => {
    const { deps: d } = deps({ '/proc/42/exe': '/opt/kitty.app/bin/kitty' }, {});
    expect(
      kittyBinaries({ KITTY_PID: '42', KITTY_INSTALLATION_DIR: '/opt/kitty.app/lib/kitty' }, d),
    ).toEqual(['/proc/42/exe', '/opt/kitty.app/bin/kitty', '/opt/kitty.app/MacOS/kitty']);
  });

  test('accepts a running kitty whose binary was replaced', () => {
    const { deps: d } = deps({ '/proc/42/exe': '/usr/bin/kitty (deleted)' }, {});
    expect(kittyBinaries({ KITTY_PID: '42' }, d)).toEqual(['/proc/42/exe']);
  });

  test('skips a reused KITTY_PID that is not kitty', () => {
    const { deps: d } = deps({ '/proc/42/exe': '/usr/bin/bash' }, {});
    expect(kittyBinaries({ KITTY_PID: '42' }, d)).toEqual([]);
  });

  test('skips /proc when unavailable', () => {
    const { deps: d } = deps({}, {});
    expect(
      kittyBinaries(
        {
          KITTY_PID: '42',
          KITTY_INSTALLATION_DIR: '/Applications/kitty.app/Contents/Resources/kitty',
        },
        d,
      ),
    ).toEqual([
      '/Applications/kitty.app/Contents/bin/kitty',
      '/Applications/kitty.app/Contents/MacOS/kitty',
    ]);
  });
});

describe('detectKittyVersion', () => {
  test('ignores TERM_PROGRAM_VERSION owned by another program', async () => {
    const { deps: d } = deps({}, {});
    expect(
      await detectKittyVersion(
        { KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'tmux', TERM_PROGRAM_VERSION: '3.4' },
        d,
      ),
    ).toBeUndefined();
  });

  test('trusts TERM_PROGRAM_VERSION when TERM_PROGRAM is kitty', async () => {
    const { deps: d, calls } = deps({}, {});
    expect(
      await detectKittyVersion({ TERM_PROGRAM: 'kitty', TERM_PROGRAM_VERSION: '0.48.1' }, d),
    ).toEqual([0, 48, 1]);
    expect(calls).toEqual([]);
  });

  test('falls back to KITTY_INSTALLATION_DIR', async () => {
    const { deps: d, calls } = deps(
      {},
      { '/Applications/kitty.app/Contents/MacOS/kitty': 'kitty 0.47.0 created by Kovid Goyal' },
    );
    expect(
      await detectKittyVersion(
        {
          KITTY_WINDOW_ID: '1',
          KITTY_INSTALLATION_DIR: '/Applications/kitty.app/Contents/Resources/kitty',
        },
        d,
      ),
    ).toEqual([0, 47, 0]);
    expect(calls).toEqual([
      '/Applications/kitty.app/Contents/bin/kitty',
      '/Applications/kitty.app/Contents/MacOS/kitty',
    ]);
  });

  test('ignores output that is not from kitty', async () => {
    const { deps: d } = deps({}, { '/x/bin/kitty': 'something 1.0.0' });
    expect(await detectKittyVersion({ KITTY_INSTALLATION_DIR: '/x/lib/kitty' }, d)).toBeUndefined();
  });
});

describe('detectKitty', () => {
  test('enables kitty 0.47+', async () => {
    const { deps: d } = deps(
      { '/proc/7/exe': '/usr/bin/kitty' },
      { '/proc/7/exe': 'kitty 0.49.2 created by Kovid Goyal' },
    );
    expect(await detectKitty({ KITTY_WINDOW_ID: '1', KITTY_PID: '7' }, d)).toBe(true);
  });

  test('disables older kitty even inside tmux', async () => {
    const { deps: d } = deps(
      { '/proc/7/exe': '/usr/bin/kitty' },
      { '/proc/7/exe': 'kitty 0.35.2 created by Kovid Goyal' },
    );
    expect(
      await detectKitty(
        { KITTY_WINDOW_ID: '1', KITTY_PID: '7', TERM_PROGRAM: 'tmux', TERM_PROGRAM_VERSION: '3.4' },
        d,
      ),
    ).toBe(false);
  });

  test('disables kitty when the version is unknown', async () => {
    const { deps: d } = deps({}, {});
    expect(await detectKitty({ KITTY_WINDOW_ID: '1' }, d)).toBe(false);
  });
});
