import { describe, expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOptions, selectDestination } from './index.ts';
import { makeTempDir } from './testing.ts';

describe('options and routing', () => {
  test('parses valid destinations, defaults, and routes', () => {
    const options = resolveOptions({
      defaultDestination: 'local',
      similarityThreshold: 0.5,
      destinations: {
        local: { type: 'file', path: '~/notes/vents.md' },
        gitlab: {
          type: 'gitlab',
          project: 'org/repo',
          epic: 'https://gitlab.com/groups/org/-/epics/42',
          labels: ['friction'],
        },
        github: {
          type: 'github',
          repo: 'owner/repo',
          labels: ['tooling'],
        },
        invalid: { type: 'gitlab' },
      },
      routes: [
        { directoryPrefix: '~/work', destination: 'gitlab' },
        { remoteContains: 'github.com/owner/', destination: 'github' },
      ],
    });

    expect(options.defaultDestination).toBe('local');
    expect(options.similarityThreshold).toBe(0.5);
    expect(Object.keys(options.destinations)).toEqual(['local', 'gitlab', 'github']);
    expect(options.destinations.gitlab).toEqual({
      type: 'gitlab',
      project: 'org/repo',
      epic: 'https://gitlab.com/groups/org/-/epics/42',
      host: 'gitlab.com',
      confidential: true,
      labels: ['friction'],
    });

    expect(
      selectDestination(options, {
        requested: 'github',
        directory: '/Users/dev/work/app',
        home: '/Users/dev',
      }).name,
    ).toBe('github');

    expect(
      selectDestination(options, {
        directory: '/Users/dev/work/app',
        home: '/Users/dev',
      }).name,
    ).toBe('gitlab');

    expect(
      selectDestination(options, {
        directory: '/Users/dev/other',
        remote: 'git@github.com:owner/repo.git',
        home: '/Users/dev',
      }).name,
    ).toBe('github');

    expect(
      selectDestination(options, {
        directory: '/Users/dev/other',
        home: '/Users/dev',
      }).name,
    ).toBe('local');
  });

  test('selects the sole destination when no defaultDestination is configured', () => {
    const options = resolveOptions({
      destinations: {
        only: { type: 'file', path: '~/vents.md' },
      },
    });
    expect(selectDestination(options, {}).name).toBe('only');
  });

  test('enforces project routes with an exception for opted-in destinations', () => {
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: {
        local: { type: 'file', path: '~/vents.md' },
        gitlab: { type: 'gitlab', project: 'dev/friction' },
        github: {
          type: 'github',
          repo: 'dev/friction',
          acceptsUnrelated: true,
        },
      },
      routes: [
        { directoryPrefix: '~/gdk', destination: 'gitlab', enforced: true },
        {
          remoteRepository: 'gitlab.com/gitlab-org/gitlab',
          destination: 'gitlab',
          enforced: true,
        },
      ],
    });
    const locations = [
      { directory: '/home/dev/gdk/gitlab/app', home: '/home/dev' },
      {
        directory: '/worktrees/feature',
        remote: 'git@gitlab.com:gitlab-org/gitlab.git',
      },
      {
        directory: '/recovery/clone',
        fetchRemotes: [
          'https://gitlab.com/dev/fork.git',
          'ssh://git@gitlab.com:22/gitlab-org/gitlab.git',
        ],
      },
    ];
    for (const location of locations) {
      expect(selectDestination(options, location).name).toBe('gitlab');
      expect(selectDestination(options, { ...location, requested: 'gitlab' }).name).toBe('gitlab');
      expect(() => selectDestination(options, { ...location, requested: 'github' })).toThrow(
        'set destination to one of "github"',
      );
      expect(() =>
        selectDestination(options, {
          ...location,
          requested: 'github',
          unrelatedReason: ' ',
        }),
      ).toThrow('unrelatedReason');
      expect(() =>
        selectDestination(options, {
          ...location,
          requested: 'local',
          unrelatedReason: "The file destination hasn't opted in.",
        }),
      ).toThrow('This checkout routes');
      expect(
        selectDestination(options, {
          ...location,
          requested: 'github',
          unrelatedReason: 'SSH signing fails in personal repositories too.',
        }).name,
      ).toBe('github');
    }
    expect(() =>
      selectDestination(options, {
        directory: '/home/dev/gdk/gitlab',
        home: '/home/dev',
        unrelatedReason: 'No destination was given.',
      }),
    ).toThrow('requires an explicit destination');
    expect(
      selectDestination(options, {
        directory: '/home/dev/gdk-backup',
        home: '/home/dev',
        remote: 'https://gitlab.com/gitlab-org/gitlab-other.git',
      }).name,
    ).toBe('local');
  });

  test('throws on missing or unknown destination', () => {
    expect(() => selectDestination(resolveOptions({}), {})).toThrow('No vent destinations');
    const options = resolveOptions({
      destinations: {
        local: { type: 'file', path: '~/vents.md' },
      },
    });
    expect(() => selectDestination(options, { requested: 'missing' })).toThrow(
      'Unknown vent destination',
    );
    expect(() => selectDestination(options, { requested: 'toString' })).toThrow(
      'Unknown vent destination',
    );
    expect(() => selectDestination(options, { requested: 'constructor' })).toThrow(
      'Unknown vent destination',
    );
  });

  test('matches directoryPrefix across symlinks and root prefix', async () => {
    const rootDir = await makeTempDir();
    const realWorkDir = join(rootDir, 'work', 'repo');
    const symlinkPath = join(rootDir, 'shortcut-repo');
    await mkdir(realWorkDir, { recursive: true });
    await symlink(realWorkDir, symlinkPath);

    const options = resolveOptions({
      defaultDestination: 'public',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        public: { type: 'github', repo: 'owner/public' },
      },
      routes: [{ directoryPrefix: join(rootDir, 'work'), destination: 'work', enforced: true }],
    });

    expect(selectDestination(options, { directory: symlinkPath }).name).toBe('work');

    const rootRouteOptions = resolveOptions({
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
      },
      routes: [{ directoryPrefix: '/', destination: 'work', enforced: true }],
    });
    expect(selectDestination(rootRouteOptions, { directory: '/workspace/project' }).name).toBe(
      'work',
    );
  });
});
