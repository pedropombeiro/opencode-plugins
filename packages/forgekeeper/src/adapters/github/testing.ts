import { GitHubForge, type GraphQL } from './adapter';

export const pull = (number = 1) => ({
  number,
  title: 'A PR',
  url: `https://github.com/owner/repo/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'UNKNOWN',
  reviewDecision: 'CHANGES_REQUESTED',
  headRefOid: 'abc',
  headRefName: 'feature',
  headRepository: { nameWithOwner: 'fork/repo' },
  baseRepository: { nameWithOwner: 'owner/repo' },
  baseRefName: 'main',
  updatedAt: '2026-10-09',
  reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } },
  reviewRequests: {
    nodes: [{ requestedReviewer: { login: 'human' } }],
    pageInfo: { hasNextPage: false },
  },
  latestOpinionatedReviews: { nodes: [], pageInfo: { hasNextPage: false } },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ],
  },
});

export const projects = [{ host: 'github.com', path: 'owner/repo' }];
export const byNumber = (graphql: GraphQL) => new GitHubForge(graphql).findByNumber(projects, '1');

export const copilot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };
export const copilotReviewOf = (requested: boolean, review?: { id: string; comments: number }) => {
  const node = pull();
  node.reviewRequests.nodes = [
    { requestedReviewer: { login: 'human' } },
    ...(requested ? [{ requestedReviewer: copilot }] : []),
  ];
  return {
    ...node,
    copilotReviews: {
      nodes: review ? [{ id: review.id, comments: { totalCount: review.comments } }] : [],
    },
  };
};
