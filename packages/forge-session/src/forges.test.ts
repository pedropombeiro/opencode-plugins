import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import { Forges, hostsFrom, parseReference } from './forges';
import { GitHubForge } from './github';
import { GitLabForge } from './gitlab';

const remotes: Exec = async (_file, args) => ({
  code: 0,
  stderr: '',
  stdout:
    args[0] === 'config'
      ? 'remote.origin.url git@github.com:o/r.git\nremote.lab.url git@gitlab.example.com:g/p.git'
      : '',
});

const forges = new Forges(remotes, {
  gitlab: ['gitlab.example.com'],
  github: ['github.com', 'ghe.example.com'],
});

describe('Forges', () => {
  test('classifies configured and recognizable hosts', () => {
    expect(forges.kind('github.com')).toBe('github');
    expect(forges.kind('ghe.example.com')).toBe('github');
    expect(forges.kind('gitlab.example.com')).toBe('gitlab');
    expect(forges.kind('gitlab.com')).toBe('gitlab');
    expect(forges.kind('bitbucket.org')).toBeUndefined();
  });

  test('creates the adapter for a host', () => {
    expect(forges.forHost('ghe.example.com', '/repo')).toBeInstanceOf(GitHubForge);
    expect(forges.forHost('gitlab.example.com', '/repo')).toBeInstanceOf(GitLabForge);
    expect(forges.forHost('bitbucket.org', '/repo')).toBeUndefined();
  });

  test('prefers configured hosts over recognized ones', () => {
    expect(
      new Forges(remotes, { gitlab: [], github: ['gitlab.mirror.example.com'] }).kind(
        'gitlab.mirror.example.com',
      ),
    ).toBe('github');
  });

  test("lists only the requested forge's projects, even when origin is on another forge", async () => {
    expect(await forges.projects('/repo', 'github')).toEqual([{ host: 'github.com', path: 'o/r' }]);
    expect(await forges.projects('/repo', 'gitlab')).toEqual([
      { host: 'gitlab.example.com', path: 'g/p' },
    ]);
    const mirrored: Exec = async () => ({
      code: 0,
      stderr: '',
      stdout:
        'remote.origin.url git@gitlab.example.com:g/p.git\nremote.mirror.url git@github.com:o/r.git',
    });
    expect(await new Forges(mirrored, forges.hosts).projects('/repo', 'github')).toEqual([
      { host: 'github.com', path: 'o/r' },
    ]);
  });

  test('reads host options with defaults', () => {
    expect(hostsFrom({})).toEqual({ gitlab: ['gitlab.com'], github: ['github.com'] });
    expect(hostsFrom({ hosts: ['gitlab.example.com', 3], githubHosts: [] })).toEqual({
      gitlab: ['gitlab.example.com'],
      github: [],
    });
  });

  test('parses PR/MR and issue URLs on either forge', () => {
    expect(parseReference('https://gitlab.com/g/p/-/merge_requests/4')).toEqual({
      ref: { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', iid: '4' },
      issue: false,
    });
    expect(parseReference('https://gitlab.com/g/p/-/issues/4')).toMatchObject({
      ref: { forge: 'gitlab' },
      issue: true,
    });
    expect(parseReference('https://github.com/o/r/pull/4')).toMatchObject({
      ref: { forge: 'github' },
      issue: false,
    });
    expect(parseReference('https://github.com/o/r/issues/4')).toMatchObject({
      ref: { forge: 'github' },
      issue: true,
    });
    expect(parseReference('https://github.com/o/r')).toBeUndefined();
  });

  test('resolves the branch only on supported forges', async () => {
    const unsupported: Exec = async (_file, args) => ({
      code: 0,
      stderr: '',
      stdout:
        args[0] === 'config'
          ? 'remote.origin.url git@bitbucket.org:o/r.git'
          : args[0] === 'symbolic-ref' && args.length === 4
            ? 'feature'
            : '/repo',
    });
    expect(await new Forges(unsupported, forges.hosts).repository('/repo')).toEqual({
      kind: 'none',
      reason: 'Not a supported forge remote',
    });
  });
});
