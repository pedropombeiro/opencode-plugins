import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin, Skill } from '@opencode/plugin';
import { ventToGitHub } from './destinations/github.ts';
import { ventToGitLab } from './destinations/gitlab.ts';
import type { Exec, ExecOptions, ExecResult } from './exec.ts';
import plugin, {
  buildResolveVentSkill,
  executeVent,
  formatVentResult,
  parseVentInput,
  RESOLVE_VENT_SKILL_ID,
  resolveOptions,
  sanitizeRemote,
  selectDestination,
} from './index.ts';
import { makeTempDir, sampleInput, sampleMetadata } from './testing.ts';

describe('executeVent and input parsing', () => {
  test('validates input and executes through selected destination', async () => {
    expect(() => parseVentInput({ title: 'x', friction: 'missing context' })).toThrow('`context`');

    const dir = await makeTempDir();
    const targetPath = join(dir, 'vents.md');
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: { local: { type: 'file', path: targetPath } },
    });

    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      if (args.includes('remote')) {
        return {
          stdout: 'origin\tgit@github.com:example/repo.git (fetch)\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: 'main\n', stderr: '', code: 0 };
    };

    const result = await executeVent(sampleInput, options, {
      sessionID: 'ses_999',
      directory: dir,
      exec: mockExec,
      now: () => new Date('2026-11-20T15:30:00.000Z'),
    });

    expect(result.action).toBe('created');
    expect(formatVentResult(result)).toContain('Created new file vent');

    const saved = await readFile(targetPath, 'utf8');
    expect(saved).toContain('- **Repository**: `github.com/example/repo`');
    expect(saved).toContain('- **Branch**: `main`');
  });

  test('strips credentials from HTTPS and SSH remote URLs before recording metadata', async () => {
    expect(
      sanitizeRemote('https://oauth2:glpat-secret-token-123@gitlab.com/example/project.git'),
    ).toBe('gitlab.com/example/project');
    expect(
      sanitizeRemote(
        'https://oauth2:secret token with space@gitlab.com:8443/example/project.git?private_token=leak#frag',
      ),
    ).toBe('gitlab.com/example/project');
    expect(sanitizeRemote('ssh://git@gitlab.com:2222/example/project.git')).toBe(
      'gitlab.com/example/project',
    );
    expect(sanitizeRemote('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
    expect(sanitizeRemote('git@gitlab.com:/group/work.git')).toBe('gitlab.com/group/work');
    expect(sanitizeRemote('gitlab.com:group/work.git')).toBe('gitlab.com/group/work');

    const dir = await makeTempDir();
    const targetPath = join(dir, 'vents.md');
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: { local: { type: 'file', path: targetPath } },
    });

    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      if (args.includes('remote')) {
        return {
          stdout:
            'origin\thttps://oauth2:glpat-dummy-token-xyz@gitlab.com/example/repo.git (fetch)\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: 'main\n', stderr: '', code: 0 };
    };

    await executeVent(sampleInput, options, {
      sessionID: 'ses_token',
      directory: dir,
      exec: mockExec,
    });

    const saved = await readFile(targetPath, 'utf8');
    expect(saved).toContain('- **Repository**: `gitlab.com/example/repo`');
    expect(saved).not.toContain('glpat-dummy-token-xyz');
    expect(saved).not.toContain('oauth2');
  });

  test('matches enforced remoteContains route against SSH SCP-style fetch remote while sanitizing metadata', async () => {
    const options = resolveOptions({
      defaultDestination: 'other',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        other: { type: 'github', repo: 'owner/other' },
      },
      routes: [
        {
          remoteContains: 'gitlab.com:group/',
          destination: 'work',
          enforced: true,
        },
      ],
    });

    const invokedTools: string[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    const mockExec: Exec = async (file, args, execOptions): Promise<ExecResult> => {
      invokedTools.push(file);
      if (file === 'git') {
        return {
          code: 0,
          stderr: '',
          stdout: args.includes('remote')
            ? 'origin\tgit@gitlab.com:group/work.git (fetch)\n'
            : 'main\n',
        };
      }
      if (!args.includes('--method')) {
        return { code: 0, stderr: '', stdout: '[]' };
      }
      if (execOptions?.stdin) {
        payloads.push(JSON.parse(execOptions.stdin) as Record<string, unknown>);
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 1,
          iid: 1,
          project_id: 10,
          title: sampleInput.title,
          web_url: 'https://gitlab.com/group/work/-/issues/1',
        }),
      };
    };

    const result = await executeVent(sampleInput, options, {
      sessionID: 'ses_scp',
      directory: '/workspace',
      exec: mockExec,
    });

    expect(result.destination).toBe('work');
    expect(result.destinationType).toBe('gitlab');
    expect(invokedTools).not.toContain('gh');
    expect(String(payloads[0]?.description)).toContain('- **Repository**: `gitlab.com/group/work`');
  });

  test('matches partial-clone remotes with [blob:none] filter and fails closed when git remote discovery fails', async () => {
    const options = resolveOptions({
      defaultDestination: 'public',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        public: { type: 'github', repo: 'owner/public', acceptsUnrelated: true },
      },
      routes: [
        {
          remoteRepository: 'gitlab.com/group/work',
          destination: 'work',
          enforced: true,
        },
      ],
    });

    const partialCloneExec: Exec = async (file, args): Promise<ExecResult> => {
      if (file === 'git') {
        return {
          code: 0,
          stderr: '',
          stdout: args.includes('remote')
            ? 'origin\thttps://gitlab.com/group/work.git (fetch) [blob:none]\r\n'
            : 'main\r\n',
        };
      }
      if (!args.includes('--method')) return { code: 0, stderr: '', stdout: '[]' };
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 1,
          iid: 2,
          project_id: 10,
          title: sampleInput.title,
          web_url: 'https://gitlab.com/group/work/-/issues/2',
        }),
      };
    };

    const partialResult = await executeVent(sampleInput, options, {
      sessionID: 'ses_partial',
      directory: '/workspace',
      exec: partialCloneExec,
    });
    expect(partialResult.destination).toBe('work');
    expect(
      selectDestination(options, {
        fetchRemotes: ['git@gitlab.com:/group/work.git'],
      }).name,
    ).toBe('work');
    expect(
      selectDestination(options, {
        fetchRemotes: ['gitlab.com:group/work.git'],
      }).name,
    ).toBe('work');

    const failedGitTools: string[] = [];
    const failedGitExec: Exec = async (file): Promise<ExecResult> => {
      failedGitTools.push(file);
      return {
        code: 128,
        stdout: '',
        stderr: 'fatal: detected dubious ownership in repository at /workspace',
      };
    };

    await expect(
      executeVent(sampleInput, options, {
        sessionID: 'ses_fail_closed',
        directory: '/workspace',
        exec: failedGitExec,
      }),
    ).rejects.toThrow('Cannot evaluate enforced vent route for "work"');
    expect(failedGitTools).toEqual(['git', 'git']);
  });

  test('omits checkout-identifying metadata on unrelated overrides by default', async () => {
    const options = resolveOptions({
      defaultDestination: 'work',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        public: { type: 'github', repo: 'owner/public', acceptsUnrelated: true },
      },
      routes: [{ directoryPrefix: '/secret/work', destination: 'work', enforced: true }],
    });

    const payloads: Array<Record<string, unknown>> = [];
    const mockExec: Exec = async (_file, args, execOptions): Promise<ExecResult> => {
      if (!args.includes('--method')) return { code: 0, stderr: '', stdout: '[]' };
      if (execOptions?.stdin) {
        payloads.push(JSON.parse(execOptions.stdin) as Record<string, unknown>);
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ html_url: 'https://github.com/owner/public/issues/1' }),
      };
    };

    await executeVent(
      {
        ...sampleInput,
        destination: 'public',
        unrelatedReason: 'Personal global plugin issue unrelated to the work repository.',
      },
      options,
      {
        sessionID: 'ses_secret_123',
        directory: '/secret/work/confidential-repo',
        remote: 'git@gitlab.com:group/confidential-repo.git',
        branch: 'secret-feature',
        exec: mockExec,
      },
    );

    const body = String(payloads[0]?.body ?? '');
    expect(body).not.toContain('/secret/work');
    expect(body).not.toContain('confidential-repo');
    expect(body).not.toContain('secret-feature');
    expect(body).not.toContain('ses_secret_123');
  });

  test('routes a fork with a matching fetch remote and leaves the log untouched on GitLab failure', async () => {
    const dir = await makeTempDir();
    const targetPath = join(dir, 'vents.md');
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: {
        local: { type: 'file', path: targetPath, acceptsUnrelated: true },
        gitlab: { type: 'gitlab', project: 'dev/friction', epic: 'org&42' },
      },
      routes: [
        {
          remoteRepository: 'gitlab.com/org/project',
          destination: 'gitlab',
          enforced: true,
        },
      ],
    });
    const mockExec: Exec = async (file, args) => {
      if (file === 'glab') return { code: 1, stdout: '', stderr: 'authorization failed' };
      return {
        code: 0,
        stdout: args.includes('remote')
          ? 'origin\thttps://gitlab.com/dev/fork.git (fetch)\nupstream\thttps://gitlab.com/org/project.git (fetch)\n'
          : 'main\n',
        stderr: '',
      };
    };
    const runtime = { sessionID: 'ses_999', directory: dir, exec: mockExec };
    await expect(
      executeVent({ ...sampleInput, destination: 'local' }, options, runtime),
    ).rejects.toThrow('unrelatedReason');
    await expect(executeVent(sampleInput, options, runtime)).rejects.toThrow(
      'authorization failed',
    );
    expect(await Bun.file(targetPath).exists()).toBe(false);
    const personal = await executeVent(
      {
        ...sampleInput,
        destination: 'local',
        unrelatedReason: 'An unrelated user-wide tool failed.',
      },
      options,
      runtime,
    );
    expect(personal.destinationType).toBe('file');
    expect(await Bun.file(targetPath).exists()).toBe(true);
    const legacy = await executeVent(
      {
        ...sampleInput,
        destination: 'local',
        localReason: 'The deprecated alias still works.',
      },
      options,
      runtime,
    );
    expect(legacy.destinationType).toBe('file');
  });
});

describe('closed matches', () => {
  const closedIssue = (labels: string[]) => ({
    number: 5,
    title: sampleInput.title,
    body: sampleInput.friction,
    html_url: 'https://github.com/owner/repo/issues/5',
    labels: labels.map((name) => ({ name })),
  });
  const githubDestination = {
    type: 'github' as const,
    repo: 'owner/repo',
    host: 'github.com',
    labels: ['agent-friction'],
    reopenLabels: ['resolution::cannot-reproduce', 'resolution::mitigated'],
    resolutionLabelPrefix: 'resolution::',
  };

  const githubExec = (closed: unknown[]) => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const exec: Exec = async (_file, args, options?: ExecOptions) => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        const list = args.at(-1)!.includes('state=closed') ? closed : [];
        return { stdout: JSON.stringify(list), stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({
          html_url: 'https://github.com/owner/repo/issues/6',
        }),
        stderr: '',
        code: 0,
      };
    };
    return { exec, calls };
  };

  test('reports a closed match without writing, and advises reopening when it had no fix', async () => {
    const { exec, calls } = githubExec([
      closedIssue(['agent-friction', 'resolution::cannot-reproduce']),
    ]);
    const result = await ventToGitHub('github', githubDestination, sampleInput, sampleMetadata, {
      exec,
      threshold: 0.45,
    });
    expect(result.action).toBe('closed-match');
    expect(result.closedLabels).toEqual(['agent-friction', 'resolution::cannot-reproduce']);
    expect(result.note).toContain('onClosedMatch: "reopen"');
    expect(calls.some((call) => call.args.includes('--method'))).toBe(false);
  });

  test('advises a new linked issue when the closed match was fixed', async () => {
    const { exec } = githubExec([closedIssue(['agent-friction', 'resolution::fixed'])]);
    const result = await ventToGitHub('github', githubDestination, sampleInput, sampleMetadata, {
      exec,
      threshold: 0.45,
    });
    expect(result.action).toBe('closed-match');
    expect(result.note).toContain('onClosedMatch: "create"');
    expect(result.note).toContain('regression');
  });

  test('reopens a closed GitHub issue, drops its resolution label, and comments', async () => {
    const { exec, calls } = githubExec([
      closedIssue(['agent-friction', 'resolution::cannot-reproduce']),
    ]);
    const result = await ventToGitHub(
      'github',
      githubDestination,
      { ...sampleInput, onClosedMatch: 'reopen' },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    expect(result.action).toBe('reopened');
    const writes = calls.filter((call) => call.args.includes('--method'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.args).toContain('PATCH');
    expect(writes[0]!.args).toContain('repos/owner/repo/issues/5');
    expect(JSON.parse(writes[0]!.stdin!)).toEqual({
      state: 'open',
      state_reason: 'reopened',
      labels: ['agent-friction'],
    });
    expect(writes[1]!.args).toContain('repos/owner/repo/issues/5/comments');
    expect(formatVentResult(result)).toContain('Reopened closed github issue');
  });

  test('files a new GitHub issue that links the closed match', async () => {
    const { exec, calls } = githubExec([closedIssue(['agent-friction', 'resolution::fixed'])]);
    const result = await ventToGitHub(
      'github',
      githubDestination,
      { ...sampleInput, onClosedMatch: 'create' },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    expect(result.action).toBe('created');
    expect(result.note).toContain('https://github.com/owner/repo/issues/5');
    const writes = calls.filter((call) => call.args.includes('--method'));
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]!.stdin!) as { body: string };
    expect(payload.body).toContain(
      'Related to the closed issue https://github.com/owner/repo/issues/5.',
    );
  });

  test('reopens a closed GitLab issue and removes its resolution label', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const exec: Exec = async (_file, args, options?: ExecOptions) => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        const closed = args.at(-1)!.includes('state=closed');
        return {
          stdout: JSON.stringify(
            closed
              ? [
                  {
                    id: 1,
                    iid: 7,
                    project_id: 99,
                    title: sampleInput.title,
                    description: sampleInput.friction,
                    state: 'closed',
                    confidential: true,
                    labels: ['agent-friction', 'resolution::cannot-reproduce'],
                    web_url: 'https://gitlab.com/dev/friction/-/issues/7',
                  },
                ]
              : [],
          ),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: JSON.stringify({ id: 55 }), stderr: '', code: 0 };
    };
    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'dev/friction',
        host: 'gitlab.com',
        confidential: true,
        labels: [],
        resolutionLabelPrefix: 'resolution::',
      },
      { ...sampleInput, onClosedMatch: 'reopen' },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    expect(result.action).toBe('reopened');
    expect(result.url).toBe('https://gitlab.com/dev/friction/-/issues/7#note_55');
    const writes = calls.filter((call) => call.args.includes('--method'));
    expect(writes[0]!.args).toContain('PUT');
    expect(writes[0]!.args).toContain('projects/99/issues/7');
    expect(JSON.parse(writes[0]!.stdin!)).toEqual({
      state_event: 'reopen',
      remove_labels: 'resolution::cannot-reproduce',
    });
    expect(writes[1]!.args).toContain('projects/99/issues/7/notes');
  });

  test('validates onClosedMatch and closedMatchUrl target pinning', async () => {
    expect(parseVentInput({ ...sampleInput, onClosedMatch: 'reopen' }).onClosedMatch).toBe(
      'reopen',
    );
    expect(() => parseVentInput({ ...sampleInput, onClosedMatch: 'delete' })).toThrow(
      'Invalid `onClosedMatch`',
    );
    expect(() =>
      parseVentInput({
        ...sampleInput,
        closedMatchUrl: 'https://github.com/owner/repo/issues/5',
      }),
    ).toThrow('`closedMatchUrl` requires `onClosedMatch`.');

    const { exec, calls } = githubExec([closedIssue(['agent-friction'])]);
    await expect(
      ventToGitHub(
        'github',
        { ...githubDestination, resolutionLabelPrefix: undefined },
        {
          ...sampleInput,
          onClosedMatch: 'reopen',
          closedMatchUrl: 'https://github.com/owner/repo/issues/999',
        },
        sampleMetadata,
        { exec, threshold: 0.45 },
      ),
    ).rejects.toThrow('does not match approved closedMatchUrl');

    await ventToGitHub(
      'github',
      { ...githubDestination, resolutionLabelPrefix: undefined },
      {
        ...sampleInput,
        onClosedMatch: 'reopen',
        closedMatchUrl: 'https://github.com/owner/repo/issues/5',
      },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    const patchCall = calls.find((call) => call.args.includes('PATCH'));
    expect(JSON.parse(patchCall!.stdin!)).toEqual({
      state: 'open',
      state_reason: 'reopened',
    });
  });
});

describe('resolve-vent skill registration', () => {
  test('builds a resolve-vent skill tailored to configured destinations', () => {
    const options = resolveOptions({
      destinations: {
        gitlab: {
          type: 'gitlab',
          project: 'org/work-friction',
          epic: 'https://gitlab.com/groups/org/-/epics/42',
          labels: ['agent-friction'],
          resolutionLabelPrefix: 'status::',
          reopenLabels: ['status::needs-info', 'status::mitigated'],
        },
        github: {
          type: 'github',
          repo: 'owner/agent-friction',
          labels: ['agent-friction'],
        },
      },
    });

    const skill = buildResolveVentSkill(options);
    expect(skill.id).toBe(RESOLVE_VENT_SKILL_ID as Skill.ID);
    expect(skill.path).toBe('skill://resolve-vent/SKILL.md' as Skill.Info['path']);
    expect(skill.description).toContain('`org/work-friction` GitLab issues/work items');
    expect(skill.description).toContain('`owner/agent-friction` GitHub issues');
    expect(skill.content).toContain('**gitlab** (GitLab `gitlab.com`)');
    expect(skill.content).toContain('**github** (GitHub `github.com`)');
    expect(skill.content).toContain(
      '**gitlab**: `status::needs-info` or `status::mitigated` marks an item closed without a confirmed fix',
    );
    expect(skill.content).toContain(
      '**github**: no `reopenLabels` are configured. Ask the user whether to reopen the closed item and add the new evidence (`vent` with `onClosedMatch: "reopen"` and `closedMatchUrl`, keeping its existing labels) or to file a new item that links the closed one (`onClosedMatch: "create"` and `closedMatchUrl`).',
    );
    expect(skill.content).toContain('`status::cannot-reproduce`');
    expect(skill.content).toContain('glab api --hostname <host>');
    expect(skill.content).toContain('gh issue close <issue-url> --comment <text>');
    expect(skill.content).toContain('--reason duplicate --duplicate-of <primary>');

    const fileOnlySkill = buildResolveVentSkill(
      resolveOptions({
        destinations: {
          local: { type: 'file', path: '~/.agents/docs/vents.md' },
        },
      }),
    );
    expect(fileOnlySkill.content).toContain('append a `### Resolution`');
    expect(fileOnlySkill.content).toContain('`~/.agents/docs/vents.md`');
    expect(fileOnlySkill.content).not.toContain('gh issue close');
  });

  test('registers the skill via ctx.skill.transform unless a local override exists', async () => {
    const registeredSkills = new Map<string, Skill.Info>();
    let skillsDisposed = false;
    let toolsDisposed = false;
    let contextHookDisposed = false;

    const makeCtx = () =>
      ({
        options: {
          destinations: {
            github: { type: 'github', repo: 'owner/agent-friction' },
          },
        },
        location: { directory: '/workspace' },
        session: {
          get: async () => ({ location: { directory: '/workspace' } }),
          hook: async () => ({
            dispose: async () => {
              contextHookDisposed = true;
            },
          }),
        },
        skill: {
          transform: async (
            cb: (editor: {
              get: (id: string) => Skill.Info | undefined;
              add: (s: Skill.Info) => void;
            }) => void,
          ) => {
            cb({
              get: (id) => registeredSkills.get(id),
              add: (s) => registeredSkills.set(s.id, s),
            });
            return {
              dispose: async () => {
                skillsDisposed = true;
              },
            };
          },
        },
        tool: {
          transform: async (cb: (editor: { add: (t: unknown) => void }) => void) => {
            cb({ add: () => {} });
            return {
              dispose: async () => {
                toolsDisposed = true;
              },
            };
          },
        },
      }) as unknown as Plugin.Context;

    const cleanup = await plugin.setup(makeCtx());
    expect(registeredSkills.get(RESOLVE_VENT_SKILL_ID)?.description).toContain(
      '`owner/agent-friction` GitHub issues',
    );

    const customSkill = {
      id: RESOLVE_VENT_SKILL_ID as Skill.ID,
      name: RESOLVE_VENT_SKILL_ID as Skill.Name,
      description: 'Custom local skill override',
      path: '/Users/dev/.agents/skills/resolve-vent/SKILL.md' as Skill.Info['path'],
      content: '# Custom',
    };
    registeredSkills.set(RESOLVE_VENT_SKILL_ID, customSkill);
    await plugin.setup(makeCtx());
    expect(registeredSkills.get(RESOLVE_VENT_SKILL_ID)?.description).toBe(
      'Custom local skill override',
    );

    await cleanup?.();
    expect(skillsDisposed).toBe(true);
    expect(toolsDisposed).toBe(true);
    expect(contextHookDisposed).toBe(true);
  });
});
