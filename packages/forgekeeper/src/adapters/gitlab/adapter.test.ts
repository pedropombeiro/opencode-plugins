import { describe, expect, test } from 'bun:test';
import { footerSegments } from '../../format';
import { ForgeError, pipelineFails, type GitLabMergeRequest } from '../../forge';
import { GitLabForge, gitlabTraits, type GraphQL } from './adapter';
import { node, projects, repository } from './testing';

describe('GitLabForge.findByNumber', () => {
  test.each(['REVIEW_STARTED', 'REVIEWED', 'UNREVIEWED', 'APPROVED', null])(
    "reads Duo's review state: %s",
    async (reviewState) => {
      const graphql: GraphQL = async (_host, query) => {
        expect(query).toContain(
          'type username bot mergeRequestInteraction { reviewState approved approvedAt }',
        );
        return {
          p0: {
            mergeRequest: node({
              reviewers: {
                nodes: [
                  { type: 'HUMAN', mergeRequestInteraction: { reviewState: 'REVIEW_STARTED' } },
                  { type: 'DUO_CODE_REVIEW_BOT', mergeRequestInteraction: { reviewState } },
                ],
              },
            }),
          },
        };
      };
      const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
      expect(mr?.duoReviewState).toBe(reviewState ?? undefined);
    },
  );

  // A failed job, required unless `allowFailure` says otherwise.
  const job = (id: string, allowFailure = false) => ({
    id: `gid://gitlab/Ci::Build/${id}`,
    name: `job-${id}`,
    allowFailure,
    webPath: `/group/project/-/jobs/${id}`,
    stage: { name: 'test' },
  });
  const page = (nodes: unknown[], hasNextPage = false) => ({ pageInfo: { hasNextPage }, nodes });
  const pipeline = (jobs: unknown, status = 'RUNNING') => ({
    id: 'gid://gitlab/Ci::Pipeline/9',
    status,
    path: '/group/project/-/pipelines/9',
    detailedStatus: { label: status.toLowerCase() },
    jobs,
  });
  // The pipeline a forge reads with the MR, and how many queries it sent.
  const readPipeline = async (headPipeline: unknown) => {
    let queries = 0;
    const mr = await new GitLabForge(async () => {
      queries++;
      return { p0: { mergeRequest: node({ headPipeline }) } };
    }).findByNumber(projects, '1');
    return { pipeline: mr?.pipeline, queries };
  };

  test("reads the pipeline's failed jobs that fail it, while it still runs", async () => {
    let seen = '';
    const mr = await new GitLabForge(async (_host, text) => {
      seen = String(text);
      return {
        p0: { mergeRequest: node({ headPipeline: pipeline(page([job('1'), job('2', true)])) }) },
      };
    }).findByNumber(projects, '1');
    expect(seen).toContain('jobs(statuses: [FAILED], retried: false, first: 10)');
    expect(mr?.pipeline).toEqual({
      status: 'RUNNING',
      label: 'running',
      url: 'https://gitlab.com/group/project/-/pipelines/9',
      id: 'gid://gitlab/Ci::Pipeline/9',
      failedJobs: [
        {
          id: 'gid://gitlab/Ci::Build/1',
          name: 'job-1',
          url: 'https://gitlab.com/group/project/-/jobs/1',
          stage: 'test',
        },
      ],
      failedJobsComplete: true,
    });
  });

  test('reads only the first failed jobs, and never counts unread ones as failing the pipeline', async () => {
    // Every job read is allowed to fail, and more failed.
    const optional = Array.from({ length: 10 }, (_, index) => job(String(index), true));
    const { pipeline: read, queries } = await readPipeline(pipeline(page(optional, true)));
    expect(queries).toBe(1);
    expect(read).toMatchObject({ failedJobs: [], failedJobsComplete: false });
    expect(pipelineFails(read)).toBe(false);
    // Once the pipeline is over, its status says whether an unread job failed it.
    const failed = await readPipeline(pipeline(page(optional, true), 'FAILED'));
    expect(pipelineFails(failed.pipeline)).toBe(true);
    // One read required failure is enough, however many more there are.
    const required = await readPipeline(pipeline(page([job('1'), ...optional.slice(1)], true)));
    expect(required.pipeline?.failedJobs?.map((entry) => entry.name)).toEqual(['job-1']);
    expect(pipelineFails(required.pipeline)).toBe(true);
  });

  test('reads the source branch, and treats mergeability as unknown while GitLab rechecks it', async () => {
    const read = async (overrides: Record<string, unknown>) =>
      new GitLabForge(async () => ({
        p0: { mergeRequest: node({ sourceBranch: 'feature', ...overrides }) },
      })).findByNumber(projects, '1');
    expect(await read({})).toMatchObject({
      sourceProject: 'me/project',
      sourceBranch: 'feature',
      targetBranch: 'main',
      conflictsKnown: true,
    });
    for (const status of ['CHECKING', 'UNCHECKED', 'PREPARING'])
      expect((await read({ detailedMergeStatus: status, conflicts: true }))?.conflictsKnown).toBe(
        false,
      );
    expect(await read({ detailedMergeStatus: 'CONFLICT', conflicts: true })).toMatchObject({
      conflicts: true,
      conflictsKnown: true,
    });
    // After its target branch moves, a conflicting MR reads `conflicts: false`
    // until GitLab rechecks it, though its detailed status still says CONFLICT.
    expect(
      await read({
        mergeStatusEnum: 'CANNOT_BE_MERGED_RECHECK',
        detailedMergeStatus: 'CONFLICT',
        conflicts: false,
      }),
    ).toMatchObject({ conflicts: true, conflictsKnown: false });
    // A deleted fork has no source project.
    expect((await read({ sourceProject: null }))?.sourceProject).toBeUndefined();
  });

  test('does not report human or unrelated bot reviews as Duo', async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          reviewers: {
            nodes: [
              { type: 'HUMAN', mergeRequestInteraction: { reviewState: 'REVIEW_STARTED' } },
              { type: 'PROJECT_BOT', mergeRequestInteraction: { reviewState: 'REVIEW_STARTED' } },
            ],
          },
        }),
      },
    });
    expect(
      (await new GitLabForge(graphql).findByNumber(projects, '1'))?.duoReviewState,
    ).toBeUndefined();
  });

  test('handles a Duo reviewer with no interaction', async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          reviewers: { nodes: [{ type: 'DUO_CODE_REVIEW_BOT', mergeRequestInteraction: null }] },
        }),
      },
    });
    expect(
      (await new GitLabForge(graphql).findByNumber(projects, '1'))?.duoReviewState,
    ).toBeUndefined();
  });

  test.each([
    { requirements: true, approvers: [], approved: false },
    { requirements: true, approvers: [{ id: 'gid://gitlab/User/1' }], approved: true },
    { requirements: false, approvers: [{ id: 'gid://gitlab/User/1' }], approved: false },
    { requirements: null, approvers: [{ id: 'gid://gitlab/User/1' }], approved: false },
  ])(
    'requires actual approvals and satisfied requirements: %j',
    async ({ requirements, approvers, approved }) => {
      const graphql: GraphQL = async () => ({
        p0: { mergeRequest: node({ approved: requirements, approvedBy: { nodes: approvers } }) },
      });
      const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
      expect(mr).toMatchObject({
        approved,
        hasApprovals: approvers.length > 0,
        approvalRequirementsSatisfied: requirements,
      });
      const segments = footerSegments({
        loading: false,
        lookup: { kind: 'found', requests: [mr!] },
      });
      expect(segments.some((segment) => segment.text === 'approved')).toBe(approved);
    },
  );

  // Mirrors gitlab-org/gitlab!260438: rules need no approvals, Duo approved,
  // and the human reviewer hasn't reviewed yet.
  const duo = {
    type: 'DUO_CODE_REVIEW_BOT',
    username: 'GitLabDuo',
    bot: true,
    mergeRequestInteraction: { reviewState: 'APPROVED', approved: true },
  };
  const human = (
    username: string,
    approved: boolean,
    reviewState = approved ? 'APPROVED' : 'UNREVIEWED',
  ) => ({
    type: 'HUMAN',
    username,
    bot: false,
    mergeRequestInteraction: { reviewState, approved },
  });

  test("ignores a bot's approval", async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          approved: true,
          approvedBy: { nodes: [{ id: 'gid://gitlab/User/9', bot: true }] },
          reviewers: { nodes: [duo] },
        }),
      },
    });
    expect(await new GitLabForge(graphql).findByNumber(projects, '1')).toMatchObject({
      approved: false,
      hasApprovals: false,
      awaitingReviewers: [],
    });
  });

  test("lists every reviewer's account ID, whether or not they reviewed", async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          reviewers: {
            nodes: [
              { ...human('alice', true), id: 'gid://gitlab/User/1' },
              { ...human('david', false), id: 'gid://gitlab/User/2' },
            ],
          },
        }),
      },
    });
    const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
    expect(mr?.reviewerIDs).toEqual(['gid://gitlab/User/1', 'gid://gitlab/User/2']);
  });

  test("waits for human reviewers who haven't approved", async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          approved: true,
          approvedBy: {
            nodes: [
              { id: 'gid://gitlab/User/9', bot: true },
              { id: 'gid://gitlab/User/1', bot: false },
            ],
          },
          reviewers: {
            nodes: [
              duo,
              human('alice', true),
              human('david', false),
              human('erin', false, 'REVIEWED'),
            ],
          },
        }),
      },
    });
    const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
    expect(mr).toMatchObject({
      approved: false,
      hasApprovals: true,
      awaitingReviewers: ['david', 'erin'],
    });
    const texts = footerSegments({
      loading: false,
      lookup: { kind: 'found', requests: [mr!] },
    }).map((segment) => segment.text);
    expect(texts).toContain('awaiting @david, @erin');
    expect(texts).not.toContain('approved');
  });

  test('shows approved once every human reviewer approved', async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          approved: true,
          approvedBy: { nodes: [{ id: 'gid://gitlab/User/1', bot: false }] },
          reviewers: { nodes: [duo, human('alice', true)] },
        }),
      },
    });
    expect(await new GitLabForge(graphql).findByNumber(projects, '1')).toMatchObject({
      approved: true,
      awaitingReviewers: [],
    });
  });

  test('normalizes active approvers and excludes reviewers whose re-review is not approved', async () => {
    const graphql: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          approvedBy: {
            nodes: [
              { id: 'gid://gitlab/User/9', username: 'GitLabDuo', bot: true },
              { id: 'gid://gitlab/User/1', username: 'alice', bot: false },
              { id: 'gid://gitlab/User/2', username: 'bob', bot: false },
              {
                id: 'gid://gitlab/User/3',
                username: 'duo-security-review-gitlab-org',
                bot: true,
              },
            ],
          },
          reviewers: {
            nodes: [
              {
                ...duo,
                id: 'gid://gitlab/User/9',
                mergeRequestInteraction: { reviewState: 'REVIEW_STARTED', approved: true },
              },
              { ...human('bob', true, 'UNREVIEWED'), id: 'gid://gitlab/User/2' },
            ],
          },
        }),
      },
    });
    const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
    expect(mr?.approvers).toEqual([
      { id: 'gid://gitlab/User/1', username: 'alice' },
      { id: 'gid://gitlab/User/3', username: 'duo-security-review-gitlab-org', bot: true },
    ]);

    const duoApproved: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          approvedBy: { nodes: [] },
          reviewers: {
            nodes: [
              {
                ...duo,
                id: 'gid://gitlab/User/9',
                mergeRequestInteraction: {
                  reviewState: 'APPROVED',
                  approved: true,
                  approvedAt: '2026-11-24T07:06:04Z',
                },
              },
            ],
          },
        }),
      },
    });
    expect((await new GitLabForge(duoApproved).findByNumber(projects, '1'))?.approvers).toEqual([
      {
        id: 'gid://gitlab/User/9',
        username: 'GitLabDuo',
        bot: true,
        automated: true,
        reviewID: '2026-11-24T07:06:04Z',
      },
    ]);
  });

  test('prefers the first project that has the MR', async () => {
    let seen: Record<string, string> = {};
    const graphql: GraphQL = async (_host, _query, variables) => {
      seen = variables;
      return {
        p0: { mergeRequest: node({ iid: '42', state: 'MERGED' }) },
        p1: { mergeRequest: node({ iid: '42', title: 'Security fix' }) },
      };
    };
    const mr = await new GitLabForge(graphql).findByNumber(projects, '42');
    expect(seen).toEqual({ iid: '42', p0: 'group/project', p1: 'security/project' });
    expect(mr).toMatchObject({ iid: '42', title: 'Title', state: 'merged' });
  });

  test('falls back without approvedAt on older GitLab servers and caches capability per host', async () => {
    const queries: string[] = [];
    const shared = new Set<string>();
    const graphql: GraphQL = async (_host, query) => {
      queries.push(query);
      if (query.includes('approvedAt')) {
        throw new Error("Field 'approvedAt' doesn't exist on type 'UserMergeRequestInteraction'");
      }
      return {
        p0: {
          mergeRequest: node({
            approvedBy: { nodes: [] },
            reviewers: {
              nodes: [
                {
                  ...duo,
                  id: 'gid://gitlab/User/9',
                  mergeRequestInteraction: { reviewState: 'APPROVED', approved: true },
                },
              ],
            },
          }),
        },
      };
    };
    const first = await new GitLabForge(graphql, shared).findByNumber(projects, '1');
    expect(first?.approvers).toEqual([
      { id: 'gid://gitlab/User/9', username: 'GitLabDuo', bot: true, automated: true },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('approvedAt');
    expect(queries[1]).not.toContain('approvedAt');

    // A second forge instance for the same host skips approvedAt immediately.
    const second = await new GitLabForge(graphql, shared).findByNumber(projects, '1');
    expect(second?.approvers).toHaveLength(1);
    expect(queries).toHaveLength(3);
    expect(queries[2]).not.toContain('approvedAt');
  });

  test('paginates reviewers and approvedBy and marks truncated approval pages incomplete', async () => {
    const graphql: GraphQL = async (_host, query, variables) => {
      if (query.includes('reviewers(first: 100, after: $after)')) {
        return {
          project: {
            mergeRequest: {
              reviewers: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    ...duo,
                    id: 'gid://gitlab/User/9',
                    mergeRequestInteraction: {
                      reviewState: 'APPROVED',
                      approved: true,
                      approvedAt: '2026-11-24T08:00:00Z',
                    },
                  },
                ],
              },
            },
          },
        };
      }
      if (query.includes('approvedBy(first: 100, after: $after)')) {
        expect(variables.after).toBe('c-app-1');
        return {
          project: {
            mergeRequest: {
              approvedBy: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://gitlab/User/2', username: 'bob', bot: false }],
              },
            },
          },
        };
      }
      return {
        p0: {
          mergeRequest: node({
            approvedBy: {
              pageInfo: { hasNextPage: true, endCursor: 'c-app-1' },
              nodes: [{ id: 'gid://gitlab/User/1', username: 'alice', bot: false }],
            },
            reviewers: {
              pageInfo: { hasNextPage: true, endCursor: 'c-rev-1' },
              nodes: [
                {
                  id: 'gid://gitlab/User/1',
                  type: 'HUMAN',
                  username: 'alice',
                  bot: false,
                  mergeRequestInteraction: { reviewState: 'APPROVED', approved: true },
                },
              ],
            },
          }),
        },
      };
    };
    const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
    expect(mr?.reviewersComplete).toBe(true);
    expect(mr?.approvalsComplete).toBe(true);
    expect(mr?.approvers?.map((entry) => entry.username)).toEqual(['alice', 'GitLabDuo', 'bob']);

    // Missing cursor on a truncated page marks approvals incomplete.
    const truncated: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          approvedBy: {
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [{ id: 'gid://gitlab/User/1', username: 'alice', bot: false }],
          },
        }),
      },
    });
    const partial = await new GitLabForge(truncated).findByNumber(projects, '1');
    expect(partial?.approvalsComplete).toBe(false);

    // Null first connection is never treated as a complete empty approval list.
    const nullConnection: GraphQL = async () => ({
      p0: {
        mergeRequest: node({
          reviewers: null,
          approvedBy: null,
        }),
      },
    });
    const missing = await new GitLabForge(nullConnection).findByNumber(projects, '1');
    expect(missing?.reviewersComplete).toBe(false);
    expect(missing?.approvalsComplete).toBe(false);
  });

  test('markReady runs mergeRequestSetDraft with draft: false and surfaces errors', async () => {
    const calls: Array<{ query: string; variables: Record<string, string> }> = [];
    const graphql: GraphQL = async (_host, query, variables) => {
      calls.push({ query, variables });
      return { mergeRequestSetDraft: { mergeRequest: { draft: false }, errors: [] } };
    };
    await new GitLabForge(graphql).markReady({
      forge: 'gitlab',
      host: 'gitlab.com',
      project: 'group/project',
      iid: '45',
    });
    expect(calls[0].query).toContain('mergeRequestSetDraft');
    expect(calls[0].variables).toEqual({ project: 'group/project', iid: '45' });

    const failing: GraphQL = async () => ({
      mergeRequestSetDraft: { mergeRequest: null, errors: ['Not permitted'] },
    });
    await expect(
      new GitLabForge(failing).markReady({
        forge: 'gitlab',
        host: 'gitlab.com',
        project: 'group/project',
        iid: '45',
      }),
    ).rejects.toThrow('Not permitted');
  });

  test('returns undefined when no project has the MR', async () => {
    const graphql: GraphQL = async () => ({ p0: { mergeRequest: null }, p1: null });
    expect(await new GitLabForge(graphql).findByNumber(projects, '42')).toBeUndefined();
  });

  test('reads approval progress, missing rules, auto-merge, and the merge train', async () => {
    const reviewer = (username: string, type = 'HUMAN') => ({
      type,
      username,
      mergeRequestInteraction: { reviewState: null, approved: false },
    });
    const graphql: GraphQL = async (_host, query) => {
      expect(query).toContain('eligibleApprovers { username type bot }');
      expect(query).toContain('mergeTrainCar { index }');
      return {
        p0: {
          mergeRequest: node({
            approvalsRequired: 2,
            approvalsLeft: 2,
            autoMergeEnabled: true,
            mergeTrainCar: { index: 1 },
            reviewers: { nodes: [reviewer('alice'), reviewer('Service', 'SERVICE_USER')] },
            approvalState: {
              rules: [
                {
                  name: 'Maintainers',
                  type: 'CODE_OWNER',
                  approvalsRequired: 1,
                  approved: false,
                  eligibleApprovers: [
                    { username: 'service', type: 'SERVICE_USER', bot: false },
                    { username: 'robot', type: 'PROJECT_BOT', bot: true },
                    ...Array.from({ length: 6 }, (_, index) => ({
                      username: `owner${index}`,
                      type: 'HUMAN',
                      bot: false,
                    })),
                  ],
                },
                {
                  name: 'Any',
                  type: 'ANY_APPROVER',
                  approvalsRequired: 1,
                  approved: false,
                  eligibleApprovers: null,
                },
                {
                  name: 'Done',
                  type: 'REGULAR',
                  approvalsRequired: 1,
                  approved: true,
                  eligibleApprovers: [],
                },
              ],
            },
          }),
        },
      };
    };
    const mr = await new GitLabForge(graphql).findByNumber(projects, '1');
    expect(mr).toMatchObject({
      approvalsRequired: 2,
      approvalsLeft: 2,
      autoMergeEnabled: true,
      mergeTrainIndex: 1,
      missingRules: [
        {
          name: 'Maintainers',
          type: 'CODE_OWNER',
          required: 1,
          eligibleReviewers: ['Service'],
          eligible: ['owner0', 'owner1'],
          eligibleCount: 6,
        },
        { name: 'Any', required: 1, eligibleReviewers: [], eligible: [] },
      ],
    });
    expect(gitlabTraits.details(mr as GitLabMergeRequest)).toEqual(
      expect.arrayContaining([
        'Still needed: Maintainers (1 required in total, @Service can approve)',
        'Still needed: Any (1 required in total)',
        'Auto-merge: set',
        'Merge train: position 2',
      ]),
    );
    expect(
      gitlabTraits.details({
        ...mr!,
        awaitingReviewers: [],
        missingRules: mr!.missingRules?.map((rule) => ({ ...rule, eligibleReviewers: [] })),
      }),
    ).toContain(
      'Still needed: Maintainers (1 required in total, ask @owner0, @owner1 or 4 others)',
    );
    expect(gitlabTraits.reviewIndicators?.(mr!).map(({ text }) => text)).toContain(
      'awaiting @alice, @Service',
    );
  });

  test.each([{ assigned: ['Service', 'BOB'] }, { assigned: ['BOB', 'Service'] }, { assigned: [] }])(
    'excludes prior approvers and prefers humans with assigned reviewers %j',
    async ({ assigned }) => {
      const user = (username: string, type = 'HUMAN') => ({ username, type, bot: false });
      const graphql: GraphQL = async () => ({
        p0: {
          mergeRequest: node({
            approvalsLeft: 1,
            approvedBy: { nodes: [user('ALICE')] },
            reviewers: { nodes: assigned.map((username) => ({ username })) },
            approvalState: {
              rules: [
                {
                  name: 'Maintainers',
                  type: 'REGULAR',
                  approvalsRequired: 2,
                  approved: false,
                  eligibleApprovers: [
                    user('service', 'SERVICE_USER'),
                    user('alice'),
                    user('bob'),
                    user('carol'),
                    user('dave'),
                  ],
                },
              ],
            },
          }),
        },
      });
      const mr = (await new GitLabForge(graphql).findByNumber(projects, '1'))!;
      expect(mr.awaitingReviewers).toEqual([...assigned]);
      expect(mr.missingRules?.[0]).toMatchObject({
        eligibleReviewers: assigned.length ? ['BOB', 'Service'] : [],
        eligible: ['bob', 'carol'],
        eligibleCount: 3,
      });
      expect(gitlabTraits.details(mr)).toContain(
        `Still needed: Maintainers (2 required in total, ${assigned.length ? '@BOB can approve' : 'ask @bob, @carol or 1 other'})`,
      );
    },
  );

  test.each(['approvalsLeft', 'approvedAt'])(
    'recovers when both optional selections are unsupported, starting with %s',
    async (firstMissing) => {
      const queries: string[] = [];
      const unsupported = [
        firstMissing,
        firstMissing === 'approvedAt' ? 'approvalsLeft' : 'approvedAt',
      ];
      const graphql: GraphQL = async (_host, query) => {
        queries.push(query);
        const field = unsupported.find((name) => query.includes(name));
        if (field) throw new ForgeError('request', `Field '${field}' doesn't exist on type`);
        expect(query).toContain('autoMergeEnabled');
        const mergeable = node({
          approvalsRequired: undefined,
          approvalsLeft: undefined,
          approvalState: undefined,
          autoMergeEnabled: true,
          headPipeline: null,
        });
        return {
          p0: {
            mergeRequest: mergeable,
            mergeRequests: { nodes: [mergeable] },
          },
        };
      };
      const approvedAt = new Set<string>();
      const extended = new Set<string>();
      const first = await new GitLabForge(graphql, approvedAt, extended).findByNumber(
        projects,
        '1',
      );
      expect(first?.approvalsLeft).toBeUndefined();
      expect(
        footerSegments({ loading: false, lookup: { kind: 'found', requests: [first!] } }).map(
          ({ text }) => text,
        ),
      ).toEqual(['!1', 'no pipeline', 'auto-merge set']);
      expect(queries).toHaveLength(3);
      expect(
        await new GitLabForge(graphql, approvedAt, extended).findByBranch(repository),
      ).toHaveLength(1);
      expect(queries).toHaveLength(4);
      expect(queries[3]).not.toContain('approvalState');
      expect(queries[3]).not.toContain('approvedAt');
    },
  );

  test.each([
    ['MergeTrainCar', true],
    ['UnrelatedType', false],
  ] as const)('only retries a missing index on MergeTrainCar: %s', async (parent, retry) => {
    let calls = 0;
    const error = new ForgeError('request', `Field 'index' doesn't exist on type '${parent}'`);
    const graphql: GraphQL = async (_host, query) => {
      calls++;
      if (query.includes('mergeTrainCar')) throw error;
      return { p0: { mergeRequest: node({}) } };
    };
    const lookup = new GitLabForge(graphql).findByNumber(projects, '1');
    if (retry) expect(await lookup).toMatchObject({ iid: '1' });
    else await expect(lookup).rejects.toBe(error);
    expect(calls).toBe(retry ? 2 : 1);
  });
});
