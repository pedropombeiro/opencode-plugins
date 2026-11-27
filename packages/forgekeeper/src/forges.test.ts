import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import {
  aRequestNoun,
  Forges,
  forgeScope,
  hostsFrom,
  parseReference,
  requestFullNoun,
  requestNoun,
  requestPlural,
  sharedForge,
} from './forges';
import { GitHubForge } from './adapters/github/adapter';
import { GitLabForge } from './adapters/gitlab/adapter';

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
    const unsupported: Exec = async (_file, args) => {
      if (args[0] === 'config')
        return { code: 0, stderr: '', stdout: 'remote.origin.url git@bitbucket.org:o/r.git' };
      const stdout = args[0] === 'symbolic-ref' && args.length === 4 ? 'feature' : '/repo';
      return { code: 0, stderr: '', stdout };
    };
    expect(await new Forges(unsupported, forges.hosts).repository('/repo')).toEqual({
      kind: 'none',
      reason: 'Not a supported forge remote',
    });
  });

  test('detects the directory forge from origin or shared remotes', async () => {
    expect(await forges.detectForge('/repo')).toBe('github');

    const gitlabOrigin: Exec = async () => ({
      code: 0,
      stderr: '',
      stdout:
        'remote.origin.url git@gitlab.example.com:g/p.git\nremote.mirror.url git@github.com:o/r.git',
    });
    expect(await new Forges(gitlabOrigin, forges.hosts).detectForge('/repo')).toBe('gitlab');

    const nonOriginUniform: Exec = async () => ({
      code: 0,
      stderr: '',
      stdout:
        'remote.upstream.url git@github.com:o/r.git\nremote.fork.url git@ghe.example.com:f/r.git',
    });
    expect(await new Forges(nonOriginUniform, forges.hosts).detectForge('/repo')).toBe('github');

    const nonOriginMixed: Exec = async () => ({
      code: 0,
      stderr: '',
      stdout:
        'remote.upstream.url git@github.com:o/r.git\nremote.lab.url git@gitlab.example.com:g/p.git',
    });
    expect(await new Forges(nonOriginMixed, forges.hosts).detectForge('/repo')).toBeUndefined();

    const noRemotes: Exec = async () => ({ code: 1, stderr: '', stdout: '' });
    expect(await new Forges(noRemotes, forges.hosts).detectForge('/repo')).toBeUndefined();
  });

  test('formats forge nouns and scopes', () => {
    expect(requestNoun('github')).toBe('PR');
    expect(requestNoun('gitlab')).toBe('MR');
    expect(requestNoun(undefined)).toBe('PR/MR');
    expect(requestPlural('github')).toBe('PRs');
    expect(requestPlural('gitlab')).toBe('MRs');
    expect(requestPlural(undefined)).toBe('PRs/MRs');
    expect(aRequestNoun('github')).toBe('a PR');
    expect(aRequestNoun('gitlab')).toBe('an MR');
    expect(aRequestNoun(undefined)).toBe('a PR/MR');
    expect(requestFullNoun('github')).toBe('pull request');
    expect(requestFullNoun('gitlab')).toBe('merge request');
    expect(requestFullNoun(undefined)).toBe('PR/MR');
    expect(sharedForge(['github', 'github'])).toBe('github');
    expect(sharedForge(['github', 'gitlab'])).toBeUndefined();
    expect(forgeScope([])).toBeUndefined();
    expect(forgeScope(['gitlab'])).toBe('gitlab');
    expect(forgeScope(['github', 'gitlab'])).toBe('mixed');
  });
});
