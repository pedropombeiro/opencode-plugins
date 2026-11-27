import { afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VentInput, VentMetadata } from './destinations/types.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-vent-test-'));
  tempDirs.push(dir);
  return dir;
}

export const sampleInput: VentInput = {
  title: 'Missing read-only permission for `glab api` pagination flag',
  friction: 'Running `glab api --paginate` prompts for approval even for read-only GET queries.',
  context: 'Listing open issues across a group during triage.',
  evidence: 'Command `glab api --paginate groups/example/issues` triggered a permission prompt.',
  suggestion: 'Allow `glab api *` with `--paginate` when no mutation flags are present.',
  category: 'permissions',
  labels: ['agent-friction'],
};

export const sampleMetadata: VentMetadata = {
  date: '2026-11-20',
  timestamp: '2026-11-20T12:00:00.000Z',
  directory: '/Users/dev/project',
  remote: 'git@gitlab.com:example/project.git',
  branch: 'feature/test',
  sessionID: 'ses_12345',
  category: 'permissions',
};
