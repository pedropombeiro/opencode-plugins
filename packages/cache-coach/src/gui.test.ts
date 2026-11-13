import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../../_shared/src/exec';

let directory: string;
let bundle: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cache-coach-gui-'));
  bundle = join(directory, 'gui.cjs');
  const result = await exec(
    'node',
    ['node_modules/vite/bin/vite.js', 'build', '--config', '.mise/vite.gui.config.mjs'],
    {
      env: {
        GUI_ENTRY: join(import.meta.dir, 'gui.tsx'),
        GUI_OUT: bundle,
      },
    },
  );
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
}, 30_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('Desktop wiring isolates servers and survives navigation and reconnects', async () => {
  const result = await exec('node', [
    '--conditions=browser',
    join(import.meta.dir, 'gui.fixture.ts'),
    bundle,
  ]);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
});

test('Desktop bundle uses only host-provided runtime modules', async () => {
  const source = await readFile(bundle, 'utf8');
  const imports = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  expect([...new Set(imports)].sort()).toEqual([
    '@opencode/plugin/gui',
    'solid-js',
    'solid-js/web',
  ]);
});
