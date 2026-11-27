import type { Repository } from '../../git';

export const repository: Repository = {
  head: 'abc',
  branch: 'feature',
  sourceBranch: 'feature',
  source: { host: 'gitlab.com', path: 'me/project' },
  targets: [
    { host: 'gitlab.com', path: 'me/project' },
    { host: 'gitlab.com', path: 'group/project' },
  ],
};

export const projects = [
  { host: 'gitlab.com', path: 'group/project' },
  { host: 'gitlab.com', path: 'security/project' },
];

export const discussions = (nodes: Array<[boolean, boolean]>, endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes: nodes.map(([resolvable, resolved]) => ({ resolvable, resolved })),
});

export const node = (overrides: Record<string, unknown>) => ({
  iid: '1',
  title: 'Title',
  webUrl: 'https://gitlab.com/group/project/-/merge_requests/1',
  state: 'OPENED',
  draft: false,
  conflicts: false,
  approved: false,
  approvalsRequired: 0,
  approvalsLeft: 0,
  autoMergeEnabled: false,
  mergeTrainCar: null,
  approvalState: { rules: [] },
  approvedBy: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  reviewers: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  detailedMergeStatus: 'MERGEABLE',
  diffHeadSha: 'abc',
  updatedAt: '2026-10-01T00:00:00Z',
  targetBranch: 'main',
  sourceProject: { fullPath: 'me/project' },
  targetProject: { fullPath: 'group/project' },
  headPipeline: {
    status: 'FAILED',
    path: '/group/project/-/pipelines/9',
    detailedStatus: { label: 'failed' },
  },
  discussions: discussions([]),
  ...overrides,
});
