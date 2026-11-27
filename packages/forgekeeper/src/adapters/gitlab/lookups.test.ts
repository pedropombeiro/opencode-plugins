import { describe, expect, test } from 'bun:test';
import type { Exec } from '../../exec';
import { ForgeError } from '../../forge';
import {
  classifyError,
  DISCUSSIONS_QUERY,
  GitLabForge,
  glabGraphQL,
  ISSUE_QUERY,
  SOURCE_BRANCH_QUERY,
  type GraphQL,
} from './adapter';
import { discussions, node, repository } from './testing';

describe('GitLabForge.findByBranch', () => {
  test('counts unresolved threads across pages and filters other source projects', async () => {
    const calls: Array<Record<string, string>> = [];
    const graphql: GraphQL = async (_host, query, variables) => {
      calls.push(variables);
      if (query === DISCUSSIONS_QUERY) {
        if (variables.after === 'c1')
          return { project: { mergeRequest: { discussions: discussions([[true, false]], 'c2') } } };
        return {
          project: {
            mergeRequest: {
              discussions: discussions([
                [true, false],
                [true, true],
              ]),
            },
          },
        };
      }
      return {
        p0: { mergeRequests: { nodes: [] } },
        p1: {
          mergeRequests: {
            nodes: [
              node({
                discussions: discussions(
                  [
                    [true, false],
                    [false, false],
                    [true, true],
                  ],
                  'c1',
                ),
              }),
              node({ iid: '2', sourceProject: { fullPath: 'someone-else/project' } }),
            ],
          },
        },
      };
    };

    const result = await new GitLabForge(graphql).findByBranch(repository);
    expect(calls[0]).toEqual({ branch: 'feature', p0: 'me/project', p1: 'group/project' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      iid: '1',
      unresolvedThreads: 3,
      threadsComplete: true,
      pipeline: {
        status: 'FAILED',
        label: 'failed',
        url: 'https://gitlab.com/group/project/-/pipelines/9',
      },
    });
  });

  test('returns an empty list without an MR and handles a missing pipeline', async () => {
    const empty: GraphQL = async () => ({ p0: { mergeRequests: { nodes: [] } }, p1: null });
    expect(await new GitLabForge(empty).findByBranch(repository)).toEqual([]);

    const noPipeline: GraphQL = async () => ({
      p0: {
        mergeRequests: {
          nodes: [node({ headPipeline: null, sourceProject: { fullPath: 'Me/Project' } })],
        },
      },
    });
    const [mr] = await new GitLabForge(noPipeline).findByBranch(repository);
    expect(mr.pipeline).toBeUndefined();
  });

  test('lists several MRs from the same branch newest first', async () => {
    const graphql: GraphQL = async () => ({
      p0: { mergeRequests: { nodes: [node({ iid: '5', updatedAt: '2026-09-01T00:00:00Z' })] } },
      p1: { mergeRequests: { nodes: [node({ iid: '7', updatedAt: '2026-10-02T00:00:00Z' })] } },
    });
    expect((await new GitLabForge(graphql).findByBranch(repository)).map((mr) => mr.iid)).toEqual([
      '7',
      '5',
    ]);
  });
});

describe('GitLabForge title lookups', () => {
  test('finds the newest MR number from the source project without reading status', async () => {
    let seen: { query: string; variables: Record<string, string> } | undefined;
    const graphql: GraphQL = async (_host, query, variables) => {
      seen = { query, variables };
      return {
        p0: {
          mergeRequests: {
            nodes: [
              {
                iid: '5',
                updatedAt: '2026-09-01T00:00:00Z',
                sourceProject: { fullPath: 'me/project' },
              },
            ],
          },
        },
        p1: {
          mergeRequests: {
            nodes: [
              {
                iid: '9',
                updatedAt: '2026-10-09T00:00:00Z',
                sourceProject: { fullPath: 'someone-else/project' },
              },
              {
                iid: '7',
                updatedAt: '2026-10-02T00:00:00Z',
                sourceProject: { fullPath: 'Me/Project' },
              },
            ],
          },
        },
      };
    };
    expect(await new GitLabForge(graphql).findNumberByBranch(repository)).toBe('7');
    expect(seen?.variables).toEqual({ branch: 'feature', p0: 'me/project', p1: 'group/project' });
    expect(seen?.query).not.toContain('discussions');
    expect(
      await new GitLabForge(async () => ({ p0: null, p1: null })).findNumberByBranch(repository),
    ).toBeUndefined();
  });

  test("reads an MR's source branch", async () => {
    let seen: Record<string, string> = {};
    const graphql: GraphQL = async (_host, query, variables) => {
      seen = variables;
      expect(query).toBe(SOURCE_BRANCH_QUERY);
      return { project: { mergeRequest: { sourceBranch: '12-fix' } } };
    };
    const ref = { forge: 'gitlab' as const, host: 'gitlab.com', project: 'g/p', iid: '4' };
    expect(await new GitLabForge(graphql).sourceBranch(ref)).toBe('12-fix');
    expect(seen).toEqual({ project: 'g/p', iid: '4' });
    expect(
      await new GitLabForge(async () => ({ project: { mergeRequest: null } })).sourceBranch(ref),
    ).toBeUndefined();
    expect(
      await new GitLabForge(async () => ({
        project: { mergeRequest: { sourceBranch: '' } },
      })).sourceBranch(ref),
    ).toBeUndefined();
  });
});

describe('GitLabForge.issue', () => {
  const ref = { forge: 'gitlab' as const, host: 'gitlab.com', project: 'g/p', iid: '9' };

  test("reads an issue's status, assignees, labels, and milestone", async () => {
    let seen: Record<string, string> = {};
    const graphql: GraphQL = async (_host, query, variables) => {
      seen = variables;
      expect(query).toBe(ISSUE_QUERY);
      return {
        project: {
          workItems: {
            nodes: [
              {
                state: 'OPEN',
                widgets: [
                  {},
                  { status: { name: 'In dev' } },
                  { assignees: { nodes: [{ username: 'alice' }] } },
                  { labels: { nodes: [{ title: 'group::dh' }, { title: 'bug::ux' }] } },
                  { milestone: { title: '19.7' } },
                ],
              },
            ],
          },
        },
      };
    };
    expect(await new GitLabForge(graphql).issue(ref)).toEqual({
      forge: 'gitlab',
      open: true,
      status: 'In dev',
      assignees: ['alice'],
      labels: ['group::dh', 'bug::ux'],
      milestone: '19.7',
    });
    expect(seen).toEqual({ project: 'g/p', iid: '9' });
  });

  test('leaves out what an issue does not have, and reads a closed one', async () => {
    const closed = async () => ({
      project: { workItems: { nodes: [{ state: 'CLOSED', widgets: [{ status: null }] }] } },
    });
    expect(await new GitLabForge(closed).issue(ref)).toEqual({
      forge: 'gitlab',
      open: false,
      assignees: [],
      labels: [],
    });
  });

  test('is undefined for an issue that does not exist', async () => {
    const none = async () => ({ project: { workItems: { nodes: [] } } });
    expect(await new GitLabForge(none).issue(ref)).toBeUndefined();
    expect(await new GitLabForge(async () => ({ project: null })).issue(ref)).toBeUndefined();
  });
});

describe('glabGraphQL', () => {
  const run =
    (stdout: string, stderr = '', code = 0): Exec =>
    async () => ({ stdout, stderr, code });

  // The error that the lookup throws.
  const failure = async (exec: Exec): Promise<ForgeError> => {
    try {
      await glabGraphQL(exec, '/repo')('gitlab.com', 'q', {});
    } catch (error) {
      return error as ForgeError;
    }
    throw new Error('Expected the lookup to fail');
  };

  test('passes variables as raw strings', async () => {
    let seen: string[] = [];
    const exec: Exec = async (_file, args) => {
      seen = args;
      return { stdout: '{"data":{"ok":true}}', stderr: '', code: 0 };
    };
    expect(await glabGraphQL(exec, '/repo')('gitlab.com', 'query', { branch: '123' })).toEqual({
      ok: true,
    });
    expect(seen).toEqual([
      'api',
      'graphql',
      '--hostname',
      'gitlab.com',
      '-f',
      'query=query',
      '-f',
      'branch=123',
    ]);
  });

  test('classifies failures', async () => {
    expect((await failure(run('', 'glab: 401 Unauthorized', 1))).kind).toBe('auth');
    expect((await failure(run('', 'spawn glab ENOENT', -1))).kind).toBe('missing-glab');
    expect((await failure(run('', 'glab: 429 Too Many Requests', 1))).kind).toBe('rate-limit');
    const graphqlError = await failure(run('{"errors":[{"message":"Field missing"}]}', '', 1));
    expect(graphqlError).toBeInstanceOf(ForgeError);
    expect(graphqlError.message).toBe('Field missing');
  });

  test('fails the lookup when a field errored, even next to data', async () => {
    // A timed-out field is `null` next to its error, which isn't a missing MR.
    const partial = '{"data":{"p0":null},"errors":[{"message":"request timed out","path":["p0"]}]}';
    expect(await failure(run(partial))).toMatchObject({
      kind: 'request',
      message: 'request timed out',
    });
    expect(await failure(run('{"data":{"p0":null}}', 'glab: connection reset', 1))).toMatchObject({
      message: 'connection reset',
    });
    expect(await failure(run('{"data":null}'))).toMatchObject({
      message: 'GitLab returned no data',
    });
    expect(await failure(run('[1, 2]'))).toBeInstanceOf(ForgeError);
    // A project or MR that doesn't exist is `null` without an error.
    expect(await glabGraphQL(run('{"data":{"p0":null}}'), '/repo')('gitlab.com', 'q', {})).toEqual({
      p0: null,
    });
  });

  test('classifyError keeps the first line of unknown errors', () => {
    expect(classifyError('glab: dial tcp: timeout\nmore', 1)).toMatchObject({
      kind: 'request',
      message: 'dial tcp: timeout',
    });
  });

  test('requestStates and issueStates batch IIDs and split on request errors', async () => {
    const mrQueries: Array<Record<string, string>> = [];
    const mrForge = new GitLabForge(async (_host, _query, variables) => {
      mrQueries.push(variables);
      if ('i1' in variables) throw new ForgeError('request', 'Request timed out');
      const iid = variables.i0;
      if (iid === '3') throw new ForgeError('request', 'Single item failed');
      return {
        project: {
          mergeRequests: {
            nodes: [
              {
                iid,
                title: `MR ${iid}`,
                webUrl: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
                state: 'merged',
                targetProject: { fullPath: 'g/p' },
              },
            ],
          },
        },
      };
    });
    const mrStates = await mrForge.requestStates({ host: 'gitlab.com', path: 'g/p' }, [
      '1',
      '2',
      '3',
    ]);
    expect(mrStates.get('1')).toEqual({
      iid: '1',
      title: 'MR 1',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      state: 'merged',
      targetProject: 'g/p',
    });
    expect(mrStates.get('2')?.state).toBe('merged');
    // Leaf failure on '3' does not discard '1' or '2':
    expect(mrStates.has('3')).toBe(false);

    const issueForge = new GitLabForge(async () => ({
      project: {
        workItems: {
          nodes: [
            { iid: '10', state: 'CLOSED' },
            { iid: '11', state: 'OPEN' },
            { iid: '12', state: 'UNKNOWN' },
            null,
          ],
        },
      },
    }));
    const issueStates = await issueForge.issueStates({ host: 'gitlab.com', path: 'g/p' }, [
      '10',
      '11',
      '12',
    ]);
    expect(issueStates.get('10')).toEqual({ iid: '10', open: false });
    expect(issueStates.get('11')).toEqual({ iid: '11', open: true });
    expect(issueStates.has('12')).toBe(false);

    // Auth and rate-limit errors fail immediately without recursive splitting:
    for (const kind of ['auth', 'rate-limit'] as const) {
      let attempts = 0;
      const failForge = new GitLabForge(async () => {
        attempts++;
        throw new ForgeError(kind, `${kind} failed`);
      });
      await expect(
        failForge.requestStates({ host: 'gitlab.com', path: 'g/p' }, ['1', '2', '3']),
      ).rejects.toMatchObject({ kind });
      expect(attempts).toBe(1);
    }
  });
});
