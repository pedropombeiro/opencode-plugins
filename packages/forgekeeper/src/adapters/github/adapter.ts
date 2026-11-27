import type { Exec } from '../../exec';
import {
  type CopilotReview,
  type AutomatedReviewStatus,
  ForgeError,
  humanize,
  ownedBy,
  parseWebUrl,
  prefixReferences,
  type Forge,
  type ForgeTraits,
  type GitHubIssueSnapshot,
  type GitHubPullRequest,
  type IssueStateSnapshot,
  type Pipeline,
  type RequestStateSnapshot,
  type ReviewerApproval,
  type ReviewRef,
} from '../../forge';
import type { RemoteProject, Repository } from '../../git';
import { fetchComments, fetchDetails } from './feedback';
import { gitlabTraits } from '../gitlab/adapter';
import { query, typed, type Transport, type Typed } from '../../graphql';

interface Connection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor?: string };
}

interface Check {
  __typename: string;
  // Each run of a check has its own ID.
  id?: string;
  // A check run's name, or a status context's.
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  startedAt?: string | null;
  checkSuite?: {
    createdAt?: string;
    app?: { id: string } | null;
    workflowRun?: { workflow: { id: string } | null } | null;
  } | null;
}

interface ReviewSummaryNode {
  id?: string | null;
  state?: string | null;
  author?: { __typename?: string; id?: string; login?: string } | null;
}

interface Pull {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision?: string | null;
  headRefOid: string;
  headRefName: string;
  headRepository?: { nameWithOwner: string } | null;
  baseRepository: { nameWithOwner: string };
  baseRefName: string;
  updatedAt: string;
  author?: { id?: string } | null;
  reviewThreads: Connection<{ isResolved: boolean }>;
  reviewRequests: Connection<{
    requestedReviewer?: { __typename?: string; login?: string; name?: string; id?: string } | null;
  }>;
  latestReviews?: {
    nodes?: Array<ReviewSummaryNode | null> | null;
  } | null;
  latestOpinionatedReviews?: Connection<ReviewSummaryNode | null> | null;
  copilotReviews?: {
    nodes?: Array<{
      id: string;
      state: string;
      comments: { totalCount: number };
      author?: { __typename?: string; id?: string; login?: string } | null;
    } | null> | null;
  } | null;
  commits: {
    nodes: Array<{ commit: { statusCheckRollup?: { contexts: Connection<Check> } | null } }>;
  };
}

const COPILOT_AUTHOR = 'copilot-pull-request-reviewer[bot]';

const fields = `number title url state isDraft mergeable reviewDecision headRefOid headRefName
  headRepository { nameWithOwner } baseRepository { nameWithOwner } baseRefName updatedAt
  author { ... on User { id } ... on Bot { id } }
  reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
  reviewRequests(first:100) { nodes { requestedReviewer { __typename ... on User { id login } ... on Bot { id login } ... on Team { name } } } pageInfo { hasNextPage endCursor } }
  latestReviews(first:100) { nodes { id state author { __typename login ... on User { id } ... on Bot { id } ... on Mannequin { id } } } }
  latestOpinionatedReviews(first:100) { nodes { id state author { __typename login ... on User { id } ... on Bot { id } ... on Mannequin { id } } } pageInfo { hasNextPage endCursor } }
  copilotReviews: reviews(last:1, author:"${COPILOT_AUTHOR}", states:[COMMENTED,CHANGES_REQUESTED,APPROVED,DISMISSED]) { nodes { id state comments { totalCount } author { __typename login ... on Bot { id } ... on User { id } } } }
  commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) {
    nodes { __typename ... on CheckRun { id name status conclusion detailsUrl startedAt checkSuite { createdAt app { id } workflowRun { workflow { id } } } } ... on StatusContext { id context state targetUrl } }
    pageInfo { hasNextPage endCursor }
  } } } } }`;

// Pagination stops after this many pages; results are then marked partial.
const MAX_PAGES = 50;

type Variables = Record<string, string | number>;
export type GraphQL = Transport<Variables>;

// Every query selects fields of one repository. A repository that doesn't
// exist, or that the viewer can't see, is null.
type RepositoryData<T> = { repository?: T | null };

export function ghGraphQL(run: Exec, cwd: string): GraphQL {
  return async (host, query, variables) => {
    const args = ['api', 'graphql', '--hostname', host, '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables))
      args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
    const result = await run('gh', args, cwd);
    let body: {
      data?: object;
      errors?: Array<{ type?: string; message: string }>;
    };
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw classifyError(result.stderr, result.code);
    }
    // A missing object, such as a number that names an issue rather than a PR,
    // is a NOT_FOUND error next to a null field. gh exits 1 for it.
    const errors = (body.errors ?? []).filter((error) => error.type !== 'NOT_FOUND');
    if (!body.data || errors.length || (result.code !== 0 && !body.errors?.length)) {
      throw classifyError(errors[0]?.message ?? result.stderr, result.code);
    }
    return body.data;
  };
}

export function classifyError(message: string, code: number): ForgeError {
  const text = message.trim() || `gh exited with code ${code}`;
  if (/ENOENT|command not found/i.test(text))
    return new ForgeError('missing-gh', 'gh is not installed');
  if (/401|unauthori[sz]ed|authenticate|not logged|token.*expired/i.test(text))
    return new ForgeError('auth', 'GitHub authentication failed. Run `gh auth status`.');
  if (/429|rate limit|too many requests/i.test(text))
    return new ForgeError('rate-limit', 'GitHub rate limit reached');
  return new ForgeError('request', text.split('\n')[0]);
}

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const CONCLUSIONS = [
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
];
const STATES = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'];

const checkKey = (node: Check) =>
  node.__typename === 'CheckRun' &&
  node.name &&
  node.checkSuite?.app?.id &&
  node.checkSuite.workflowRun?.workflow?.id &&
  JSON.stringify([node.checkSuite.app.id, node.checkSuite.workflowRun?.workflow?.id, node.name]);
const checkTime = (node: Check) => Date.parse(node.checkSuite?.createdAt ?? '');
const newerCheck = (node: Check, previous: Check) => checkTime(node) > checkTime(previous);

// Summarizes the head commit's checks. Failures win over pending checks, and
// partial or unrecognized results never report success.
export function checks(nodes: Check[], complete: boolean, url: string, id?: string): Pipeline {
  const latest = new Map<string, Check>();
  for (const node of nodes) {
    const time = checkTime(node);
    const key = checkKey(node);
    if (!key || !Number.isFinite(time)) continue;
    const previous = latest.get(key);
    if (!previous || newerCheck(node, previous)) latest.set(key, node);
  }
  nodes = nodes.filter((node) => {
    const key = checkKey(node);
    const replacement = key && latest.get(key);
    return !replacement || !newerCheck(replacement, node);
  });
  const count = (value: number) => `${value} check${value === 1 ? '' : 's'}`;
  const cancelled = nodes.filter((node) => node.conclusion === 'CANCELLED').length;
  const stale = nodes.filter((node) => node.conclusion === 'STALE').length;
  const stopped = [
    ...(cancelled ? [`${count(cancelled)} cancelled`] : []),
    ...(stale ? [`${count(stale)} stale`] : []),
  ];
  const failing = nodes.filter((node) => FAILED.includes(node.conclusion ?? node.state ?? ''));
  const failed = failing.length;
  // The checks of one commit count as one run.
  const run = id
    ? {
        id,
        failedJobs: failing.flatMap((node) => {
          const name = node.name ?? node.context;
          const link = node.detailsUrl ?? node.targetUrl;
          return name
            ? [{ ...(node.id ? { id: node.id } : {}), name, ...(link ? { url: link } : {}) }]
            : [];
        }),
        failedJobsComplete: complete,
      }
    : {};
  const pending = nodes.filter((node) =>
    node.status ? node.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(node.state ?? ''),
  ).length;
  const unknown = nodes.some((node) =>
    node.status === 'COMPLETED'
      ? !CONCLUSIONS.includes(node.conclusion ?? '')
      : !node.status && !STATES.includes(node.state ?? ''),
  );
  if (failed)
    return {
      status: 'FAILED',
      label:
        [
          `${count(failed)} failed`,
          ...stopped,
          ...(pending ? [`${count(pending)} pending`] : []),
        ].join(', ') + (complete ? '' : ' (partial)'),
      url,
      ...run,
      // GitHub reports a failure before the other checks finish.
      running: pending > 0,
    };
  if (pending || !complete || unknown)
    return {
      status: 'PENDING',
      label:
        [...stopped, pending ? `${count(pending)} pending` : 'unknown'].join(', ') +
        (complete ? '' : ' (partial)'),
      url,
      ...run,
    };
  if (cancelled || stale) return { status: 'CANCELLED', label: stopped.join(', '), url, ...run };
  const label = [
    ['SUCCESS', 'passed'],
    ['SKIPPED', 'skipped'],
    ['NEUTRAL', 'neutral'],
  ]
    .flatMap(([result, text]) => {
      const total = nodes.filter((node) => (node.conclusion ?? node.state) === result).length;
      return total ? [`${count(total)} ${text}`] : [];
    })
    .join(', ');
  return { status: 'SUCCESS', label: label || '0 checks', url, ...run };
}

// GitHub URLs are accepted on any host, for GitHub Enterprise, except GitLab
// hosts, which also answer legacy paths such as `/group/project/issues/1`.
function parseGitHubUrl(url: string, pattern: RegExp) {
  const ref = parseWebUrl('github', url, pattern);
  return ref && !gitlabTraits.recognizes(ref.host) ? ref : undefined;
}

export const githubTraits: ForgeTraits<GitHubPullRequest, GitHubForge> = {
  kind: 'github',
  noun: 'PR',
  fullNoun: 'pull request',
  ci: 'checks',
  // GitHub hosts come only from the `githubHosts` option.
  recognizes: () => false,
  open: (run, directory) => new GitHubForge(ghGraphQL(run, directory)),
  owns: ownedBy('github'),
  parseUrl: (url) => parseGitHubUrl(url, /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/),
  parseIssueUrl: (url) => parseGitHubUrl(url, /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/),
  reference: (iid) => `#${iid}`,
  issueReference: (iid) => `#${iid}`,
  // `#N` also names issues, such as in `[#42, #108]`.
  titleReferences: (title) => prefixReferences(title, '#'),
  indicators: (request) =>
    request.reviewDecision === 'CHANGES_REQUESTED'
      ? [{ text: 'changes requested', tone: 'warning', essential: true }]
      : [],
  details: (request) => [
    `Review decision: ${request.reviewDecision ? humanize(request.reviewDecision) : 'not reported'}`,
  ],
  automatedReview: {
    name: 'GitHub Copilot',
    status: (request) => copilotStatus(request.copilotReview),
  },
  feedback: {
    async viewerID(run, directory, host) {
      const data = await typed(ghGraphQL(run, directory))(
        host,
        query<{ viewer: { id: string } | null }>('query { viewer { id } }'),
        {},
      );
      return data.viewer?.id;
    },
    async reviewerID(run, directory, host, username) {
      const result = await run(
        'gh',
        ['api', '--hostname', host, `users/${encodeURIComponent(username)}`],
        directory,
      );
      if (result.code !== 0) throw new Error('Could not resolve the GitHub reviewer account');
      const user = JSON.parse(result.stdout) as { login?: string; node_id?: string };
      return user.login?.toLowerCase() === username.toLowerCase() ? user.node_id : undefined;
    },
    async fetch(run, directory, request) {
      const ref = githubTraits.parseUrl(request.url);
      return ref
        ? fetchComments(ghGraphQL(run, directory), ref.host, ref.project, ref.iid)
        : undefined;
    },
    async details(run, directory, request, ids) {
      const ref = githubTraits.parseUrl(request.url);
      return ref ? fetchDetails(ghGraphQL(run, directory), ref.host, ids) : [];
    },
  },
};

function copilotStatus(review: CopilotReview | undefined): AutomatedReviewStatus | undefined {
  if (!review) return undefined;
  const feedback = review.comments > 0 && !review.dismissed;
  const label = review.dismissed ? 'dismissed' : feedback ? 'commented' : 'no comments';
  const completed = review.reviewID ? { id: review.reviewID, feedback, label } : undefined;

  if (review.requested) return { state: 'running', label: 'reviewing', completed };
  if (!completed) return undefined;
  return { state: feedback ? 'feedback' : 'settled', label, completed };
}

const isCopilotReviewer = (login: string | undefined) =>
  /^copilot-pull-request-reviewer(\[bot\])?$/i.test(login ?? '');

const isCopilotBot = (reviewer?: { __typename?: string; login?: string } | null) =>
  reviewer?.__typename === 'Bot' && isCopilotReviewer(reviewer.login);

function copilotReview(node: Pull): CopilotReview | undefined {
  const requested = node.reviewRequests.nodes.some((request) =>
    isCopilotBot(request.requestedReviewer),
  );
  const latest = node.copilotReviews?.nodes?.find((review) => review);
  if (!requested && !latest) return undefined;
  return {
    requested,
    reviewID: latest?.id,
    comments: latest?.comments.totalCount ?? 0,
    ...(latest?.state === 'DISMISSED' ? { dismissed: true } : {}),
  };
}

export function botUsername(login: string, typename?: string): string {
  return typename === 'Bot' && !login.endsWith('[bot]') ? `${login}[bot]` : login;
}

function pendingReviewer(reviewers: Pull['reviewRequests']) {
  const pendingIDs = new Set<string>();
  const pendingWithoutID = new Set<string>();
  const pendingTypedLogins = new Set<string>();
  const typedLoginKey = (typename: string | undefined, login: string) =>
    `${typename ?? 'Unknown'}:${botUsername(login, typename).toLowerCase()}`;
  for (const request of reviewers.nodes) {
    const reviewer = request.requestedReviewer;
    if (reviewer?.id) pendingIDs.add(reviewer.id);
    if (reviewer?.login) {
      const key = typedLoginKey(reviewer.__typename, reviewer.login);
      pendingTypedLogins.add(key);
      if (!reviewer.id) pendingWithoutID.add(key);
    }
  }
  return (id: string | undefined, typename: string | undefined, login: string) => {
    const key = typedLoginKey(typename, login);
    if (id) return pendingIDs.has(id) || pendingWithoutID.has(key);
    return pendingTypedLogins.has(key);
  };
}

function normalizeApprovers(
  node: Pull,
  reviewers: Pull['reviewRequests'],
  opinionated: readonly (ReviewSummaryNode | null)[],
): ReviewerApproval[] {
  const isPending = pendingReviewer(reviewers);
  const found = new Map<string, ReviewerApproval>();
  const add = (entry: ReviewerApproval) => {
    const key = `${entry.bot ? 'bot' : 'user'}:${entry.username.toLowerCase()}`;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, entry);
      return;
    }
    found.set(key, {
      ...existing,
      ...entry,
      ...(existing.id || entry.id ? { id: entry.id ?? existing.id } : {}),
      ...(existing.bot || entry.bot ? { bot: true } : {}),
      ...(existing.automated || entry.automated ? { automated: true } : {}),
      ...(existing.reviewID || entry.reviewID
        ? { reviewID: entry.reviewID ?? existing.reviewID }
        : {}),
    });
  };

  for (const review of opinionated) {
    if (review?.state !== 'APPROVED' || !review.author?.login) continue;
    const { id, login, __typename } = review.author;
    if (isPending(id, __typename, login)) continue;
    const bot = __typename === 'Bot';
    const automated = bot && isCopilotReviewer(login);
    const username = automated ? COPILOT_AUTHOR : botUsername(login, __typename);
    add({
      ...(id ? { id } : {}),
      username,
      ...(bot ? { bot: true } : {}),
      ...(automated ? { automated: true } : {}),
      ...(review.id ? { reviewID: review.id } : {}),
    });
  }

  const latestCopilot = node.copilotReviews?.nodes?.find((review) => review);
  const copilotPending = reviewers.nodes.some((request) => isCopilotBot(request.requestedReviewer));
  if (
    latestCopilot?.state === 'APPROVED' &&
    isCopilotBot(latestCopilot.author) &&
    !copilotPending
  ) {
    add({
      ...(latestCopilot.author?.id ? { id: latestCopilot.author.id } : {}),
      username: COPILOT_AUTHOR,
      bot: true,
      automated: true,
      ...(latestCopilot.id ? { reviewID: latestCopilot.id } : {}),
    });
  }

  return [...found.values()];
}

function changeRequests(
  reviewers: Pull['reviewRequests'],
  opinionated: { nodes: (ReviewSummaryNode | null)[]; complete: boolean },
): Pick<GitHubPullRequest, 'changesRequested' | 'changeReviewIDs'> {
  if (!reviewers.pageInfo || reviewers.pageInfo.hasNextPage) return {};
  const pending = pendingReviewer(reviewers);
  const ids: string[] = [];
  let complete = opinionated.complete;
  for (const review of opinionated.nodes) {
    if (review?.state !== 'CHANGES_REQUESTED') continue;
    const author = review.author;
    if (!author?.login || !review.id) {
      complete = false;
      continue;
    }
    if (!pending(author.id, author.__typename, author.login)) ids.push(review.id);
  }
  if (ids.length) return { changesRequested: true, changeReviewIDs: ids };
  return complete ? { changesRequested: false } : {};
}

// Reads GitHub pull requests through `gh api graphql`, using gh's login.
export class GitHubForge implements Forge {
  readonly traits = githubTraits;

  private readonly graphql: Typed<Variables>;

  constructor(graphql: GraphQL) {
    this.graphql = typed(graphql);
  }

  async findByNumber(
    projects: readonly RemoteProject[],
    number: string,
  ): Promise<GitHubPullRequest | undefined> {
    for (const project of projects) {
      const [owner, repo] = project.path.split('/');
      const data = await this.graphql(
        project.host,
        query<RepositoryData<{ pullRequest?: Pull | null }>>(
          `query($owner:String!,$repo:String!,$number:Int!) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${fields} } }
      }`,
        ),
        { owner, repo, number: Number(number) },
      );
      const node = data.repository?.pullRequest;
      if (node) return this.normalize(project.host, node);
    }
    return undefined;
  }

  async findNumberByBranch(repository: Repository): Promise<string | undefined> {
    let newest: { number: number; updatedAt: string } | undefined;
    for (const target of repository.targets) {
      const [owner, repo] = target.path.split('/');
      const data = await this.graphql(
        target.host,
        query<
          RepositoryData<{
            pullRequests?: Connection<Pick<Pull, 'number' | 'updatedAt' | 'headRepository'>> | null;
          }>
        >(`query($owner:String!,$repo:String!,$branch:String!) {
        repository(owner:$owner,name:$repo) { pullRequests(first:100,states:OPEN,headRefName:$branch,orderBy:{field:UPDATED_AT,direction:DESC}) {
          nodes { number updatedAt headRepository { nameWithOwner } }
        } } }`),
        { owner, repo, branch: repository.sourceBranch },
      );
      const nodes = data.repository?.pullRequests?.nodes ?? [];
      for (const node of nodes) {
        // A fork's branch with the same name must not name this branch's PR.
        if (
          node.headRepository?.nameWithOwner.toLowerCase() !== repository.source.path.toLowerCase()
        )
          continue;
        if (!newest || node.updatedAt > newest.updatedAt) newest = node;
      }
    }
    return newest ? String(newest.number) : undefined;
  }

  async sourceBranch(ref: ReviewRef): Promise<string | undefined> {
    const [owner, repo] = ref.project.split('/');
    const data = await this.graphql(
      ref.host,
      query<RepositoryData<{ pullRequest?: { headRefName?: string | null } | null }>>(
        `query($owner:String!,$repo:String!,$number:Int!) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) { headRefName } }
    }`,
      ),
      { owner, repo, number: Number(ref.iid) },
    );
    return data.repository?.pullRequest?.headRefName || undefined;
  }

  async issue(ref: ReviewRef): Promise<GitHubIssueSnapshot | undefined> {
    const [owner, repo] = ref.project.split('/');
    const number = Number(ref.iid);
    if (!owner || !repo || !Number.isInteger(number) || number < 1) return undefined;
    const data = await this.graphql(
      ref.host,
      query<RepositoryData<{ issue?: { state?: string; url?: string } | null }>>(
        `query($owner:String!,$repo:String!,$number:Int!) {
      repository(owner:$owner,name:$repo) { issue(number:$number) { state url } }
    }`,
      ),
      { owner, repo, number },
    );
    const node = data.repository?.issue;
    if (!node || !node.url || (node.state !== 'OPEN' && node.state !== 'CLOSED')) return undefined;
    return { forge: 'github', open: node.state === 'OPEN', url: node.url };
  }

  async requestStates(
    project: RemoteProject,
    numbers: readonly string[],
  ): Promise<ReadonlyMap<string, RequestStateSnapshot>> {
    const [owner, repo] = project.path.split('/');
    const valid = [
      ...new Set(
        numbers.filter((num) => {
          const parsed = Number(num);
          return Number.isInteger(parsed) && parsed >= 1;
        }),
      ),
    ];
    if (!owner || !repo || valid.length === 0) return new Map();
    const found = new Map<string, RequestStateSnapshot>();
    const fetchChunk = async (chunk: readonly string[]): Promise<void> => {
      if (chunk.length === 0) return;
      const vars = chunk.map((_, index) => `$n${index}:Int!`).join(',');
      const selections = chunk
        .map(
          (_, index) =>
            `pr${index}:pullRequest(number:$n${index}){number title url state baseRepository{nameWithOwner}}`,
        )
        .join(' ');
      const variables: Variables = { owner, repo };
      chunk.forEach((num, index) => (variables[`n${index}`] = Number(num)));
      type PullStateNode = {
        number: number;
        title: string;
        url: string;
        state: string;
        baseRepository?: { nameWithOwner: string } | null;
      };
      try {
        const data = await this.graphql(
          project.host,
          query<RepositoryData<Record<`pr${number}`, PullStateNode | null | undefined>>>(
            `query($owner:String!,$repo:String!,${vars}){repository(owner:$owner,name:$repo){${selections}}}`,
          ),
          variables,
        );
        const repository = data.repository;
        if (!repository) return;
        chunk.forEach((iid, index) => {
          const node = repository[`pr${index}`];
          if (!node || !node.url || !node.state || String(node.number ?? iid) !== iid) return;
          found.set(iid, {
            iid,
            title: node.title ?? '',
            url: node.url,
            state: node.state === 'OPEN' ? 'opened' : node.state.toLowerCase(),
            targetProject: node.baseRepository?.nameWithOwner ?? project.path,
          });
        });
      } catch (error) {
        if (!(error instanceof ForgeError) || error.kind !== 'request') throw error;
        if (chunk.length === 1) return;
        const mid = Math.ceil(chunk.length / 2);
        await fetchChunk(chunk.slice(0, mid));
        await fetchChunk(chunk.slice(mid));
      }
    };
    await fetchChunk(valid);
    return found;
  }

  async issueStates(
    project: RemoteProject,
    numbers: readonly string[],
  ): Promise<ReadonlyMap<string, IssueStateSnapshot>> {
    const [owner, repo] = project.path.split('/');
    const valid = [
      ...new Set(
        numbers.filter((num) => {
          const parsed = Number(num);
          return Number.isInteger(parsed) && parsed >= 1;
        }),
      ),
    ];
    if (!owner || !repo || valid.length === 0) return new Map();
    const found = new Map<string, IssueStateSnapshot>();
    const fetchChunk = async (chunk: readonly string[]): Promise<void> => {
      if (chunk.length === 0) return;
      const vars = chunk.map((_, index) => `$n${index}:Int!`).join(',');
      const selections = chunk
        .map((_, index) => `i${index}:issue(number:$n${index}){number state url}`)
        .join(' ');
      const variables: Variables = { owner, repo };
      chunk.forEach((num, index) => (variables[`n${index}`] = Number(num)));
      type IssueNode = { number: number; state?: string; url?: string };
      try {
        const data = await this.graphql(
          project.host,
          query<RepositoryData<Record<`i${number}`, IssueNode | null | undefined>>>(
            `query($owner:String!,$repo:String!,${vars}){repository(owner:$owner,name:$repo){${selections}}}`,
          ),
          variables,
        );
        const repository = data.repository;
        if (!repository) return;
        chunk.forEach((iid, index) => {
          const node = repository[`i${index}`];
          if (!node || !node.url || (node.state !== 'OPEN' && node.state !== 'CLOSED')) return;
          if (String(node.number ?? iid) !== iid) return;
          found.set(iid, {
            iid,
            open: node.state === 'OPEN',
          });
        });
      } catch (error) {
        if (!(error instanceof ForgeError) || error.kind !== 'request') throw error;
        if (chunk.length === 1) return;
        const mid = Math.ceil(chunk.length / 2);
        await fetchChunk(chunk.slice(0, mid));
        await fetchChunk(chunk.slice(mid));
      }
    };
    await fetchChunk(valid);
    return found;
  }

  async markReady(
    ref: ReviewRef,
    options?: { beforeMutate?: () => Promise<void> | void },
  ): Promise<void> {
    const [owner, repo] = ref.project.split('/');
    const lookup = await this.graphql(
      ref.host,
      query<
        RepositoryData<{
          pullRequest?: { id?: string | null; isDraft?: boolean; state?: string } | null;
        }>
      >(
        `query($owner:String!,$repo:String!,$number:Int!) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) { id isDraft state } }
    }`,
      ),
      { owner, repo, number: Number(ref.iid) },
    );
    const pr = lookup.repository?.pullRequest;
    if (!pr?.id) throw new ForgeError('request', 'GitHub pull request not found');
    if (pr.state !== 'OPEN')
      throw new ForgeError('request', 'The GitHub pull request is no longer open');
    if (!pr.isDraft) return;
    await options?.beforeMutate?.();
    const data = await this.graphql(
      ref.host,
      query<{
        markPullRequestReadyForReview?: {
          pullRequest?: { id?: string; isDraft?: boolean } | null;
        } | null;
      }>(
        `mutation($id:ID!) {
      markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { id isDraft } }
    }`,
      ),
      { id: pr.id },
    );
    const updated = data.markPullRequestReadyForReview?.pullRequest;
    if (!updated || updated.isDraft)
      throw new ForgeError('request', 'Could not mark the GitHub pull request as ready');
  }

  async findByBranch(repository: Repository): Promise<GitHubPullRequest[]> {
    const found = new Map<string, GitHubPullRequest>();
    for (const target of repository.targets) {
      const [owner, repo] = target.path.split('/');
      let after: string | undefined;
      let complete = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await this.graphql(
          target.host,
          query<RepositoryData<{ pullRequests?: Connection<Pull> | null }>>(
            `query($owner:String!,$repo:String!,$branch:String!${after ? ',$after:String!' : ''}) {
          repository(owner:$owner,name:$repo) { pullRequests(first:100,states:OPEN,headRefName:$branch${after ? ',after:$after' : ''}) {
            nodes { ${fields} } pageInfo { hasNextPage endCursor }
          } } }`,
          ),
          { owner, repo, branch: repository.sourceBranch, ...(after ? { after } : {}) },
        );
        const pulls = data.repository?.pullRequests;
        if (!pulls) throw new ForgeError('request', 'GitHub repository unavailable');
        for (const node of pulls.nodes) {
          // A fork's branch with the same name must not be reported as this branch's PR.
          if (
            node.headRepository?.nameWithOwner.toLowerCase() !==
            repository.source.path.toLowerCase()
          )
            continue;
          if (!found.has(node.url)) found.set(node.url, await this.normalize(target.host, node));
        }
        if (!pulls.pageInfo?.hasNextPage) {
          complete = true;
          break;
        }
        after = pulls.pageInfo.endCursor;
        if (!after) break;
      }
      if (!complete)
        throw new ForgeError('request', 'GitHub PR discovery exceeded its pagination limit');
    }
    return [...found.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  private async threads(host: string, node: Pull) {
    const [owner, repo] = node.baseRepository.nameWithOwner.split('/');
    const threads = [...node.reviewThreads.nodes];
    let page = node.reviewThreads.pageInfo;
    for (let count = 1; page?.hasNextPage && page.endCursor && count < MAX_PAGES; count++) {
      const data = await this.graphql(
        host,
        query<
          RepositoryData<{ pullRequest?: { reviewThreads?: Pull['reviewThreads'] | null } | null }>
        >(
          `query($owner:String!,$repo:String!,$number:Int!,$after:String!) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
          reviewThreads(first:100,after:$after) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
        } } }`,
        ),
        { owner, repo, number: node.number, after: page.endCursor },
      );
      const next = data.repository?.pullRequest?.reviewThreads;
      if (!next) break;
      threads.push(...next.nodes);
      page = next.pageInfo;
    }
    return {
      unresolved: threads.filter((thread) => !thread.isResolved).length,
      complete: !page?.hasNextPage,
    };
  }

  private async contexts(host: string, node: Pull) {
    const [owner, repo] = node.baseRepository.nameWithOwner.split('/');
    const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    const contexts = [...(rollup?.nodes ?? [])];
    let cursor = rollup?.pageInfo;
    for (let count = 1; cursor?.hasNextPage && cursor.endCursor && count < MAX_PAGES; count++) {
      const data = await this.graphql(
        host,
        query<
          RepositoryData<{
            object?: { statusCheckRollup?: { contexts?: Connection<Check> | null } | null } | null;
          }>
        >(`query($owner:String!,$repo:String!,$oid:GitObjectID!,$after:String!) {
        repository(owner:$owner,name:$repo) { object(oid:$oid) { ... on Commit { statusCheckRollup {
          contexts(first:100,after:$after) { nodes { __typename ... on CheckRun { id name status conclusion detailsUrl startedAt checkSuite { createdAt app { id } workflowRun { workflow { id } } } } ... on StatusContext { id context state targetUrl } } pageInfo { hasNextPage endCursor } }
        } } } } }`),
        { owner, repo, oid: node.headRefOid, after: cursor.endCursor },
      );
      const next = data.repository?.object?.statusCheckRollup?.contexts;
      if (!next) break;
      contexts.push(...next.nodes);
      cursor = next.pageInfo;
    }
    return { nodes: contexts, complete: !cursor?.hasNextPage };
  }

  private async reviewers(host: string, node: Pull): Promise<Pull['reviewRequests']> {
    const nodes = [...node.reviewRequests.nodes];
    let reviewerPage = node.reviewRequests.pageInfo;
    for (let count = 1; reviewerPage?.hasNextPage && count < MAX_PAGES; count++) {
      if (!reviewerPage.endCursor)
        throw new ForgeError('request', 'GitHub reviewer pagination cursor missing');
      const [owner, repo] = node.baseRepository.nameWithOwner.split('/');
      const data = await this.graphql(
        host,
        query<RepositoryData<{ pullRequest?: { reviewRequests: Pull['reviewRequests'] } | null }>>(
          `query($owner:String!,$repo:String!,$number:Int!,$after:String!) {
            repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
              reviewRequests(first:100,after:$after) {
                nodes { requestedReviewer { __typename ... on User { id login } ... on Bot { id login } ... on Team { name } } }
                pageInfo { hasNextPage endCursor }
              }
            } }
          }`,
        ),
        { owner, repo, number: node.number, after: reviewerPage.endCursor },
      );
      const next = data.repository?.pullRequest?.reviewRequests;
      if (!next) throw new ForgeError('request', 'GitHub reviewers unavailable');
      nodes.push(...next.nodes);
      reviewerPage = next.pageInfo;
    }
    if (reviewerPage?.hasNextPage)
      throw new ForgeError('request', 'GitHub reviewers exceeded the pagination limit');
    return { nodes, pageInfo: reviewerPage };
  }

  private async opinionatedReviews(host: string, node: Pull) {
    if (!node.latestOpinionatedReviews?.pageInfo)
      return { nodes: [...(node.latestOpinionatedReviews?.nodes ?? [])], complete: false };
    const nodes = [...node.latestOpinionatedReviews.nodes];
    let page: { hasNextPage: boolean; endCursor?: string } = node.latestOpinionatedReviews.pageInfo;
    for (let count = 1; page.hasNextPage && page.endCursor && count < MAX_PAGES; count++) {
      const [owner, repo] = node.baseRepository.nameWithOwner.split('/');
      const data = await this.graphql(
        host,
        query<
          RepositoryData<{
            pullRequest?: {
              latestOpinionatedReviews?: Connection<ReviewSummaryNode | null> | null;
            } | null;
          }>
        >(
          `query($owner:String!,$repo:String!,$number:Int!,$after:String!) {
            repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
              latestOpinionatedReviews(first:100,after:$after) {
                nodes { id state author { __typename login ... on User { id } ... on Bot { id } ... on Mannequin { id } } }
                pageInfo { hasNextPage endCursor }
              }
            } }
          }`,
        ),
        { owner, repo, number: node.number, after: page.endCursor },
      );
      const next = data.repository?.pullRequest?.latestOpinionatedReviews;
      if (!next?.pageInfo) return { nodes, complete: false };
      nodes.push(...next.nodes);
      page = next.pageInfo;
    }
    return { nodes, complete: !page.hasNextPage };
  }

  private async normalize(host: string, node: Pull): Promise<GitHubPullRequest> {
    const reviewers = await this.reviewers(host, node);
    const [threads, contexts, opinionated] = await Promise.all([
      this.threads(host, node),
      this.contexts(host, node),
      this.opinionatedReviews(host, node),
    ]);
    return {
      forge: 'github',
      iid: String(node.number),
      title: node.title,
      url: node.url,
      state: node.state === 'OPEN' ? 'opened' : node.state.toLowerCase(),
      draft: node.isDraft,
      conflicts: node.mergeable === 'CONFLICTING',
      conflictsKnown: node.mergeable !== 'UNKNOWN',
      approved: node.reviewDecision === 'APPROVED',
      reviewDecision: node.reviewDecision ?? undefined,
      ...changeRequests(reviewers, opinionated),
      copilotReview: copilotReview({ ...node, reviewRequests: reviewers }),
      awaitingReviewers: reviewers.nodes.flatMap((request) => {
        const reviewer = request.requestedReviewer;
        if (reviewer?.__typename === 'Bot') return [];
        return reviewer?.login ? [reviewer.login] : reviewer?.name ? [reviewer.name] : [];
      }),
      reviewersComplete: !!reviewers.pageInfo && !reviewers.pageInfo.hasNextPage,
      approvalsComplete:
        !!reviewers.pageInfo && !reviewers.pageInfo.hasNextPage && opinionated.complete,
      reviewerIDs: [
        ...new Set([
          ...reviewers.nodes.flatMap((request) =>
            request.requestedReviewer?.__typename === 'User'
              ? (request.requestedReviewer.id ?? [])
              : [],
          ),
          ...[...(node.latestReviews?.nodes ?? []), ...opinionated.nodes].flatMap((review) =>
            !review?.author?.__typename || review.author.__typename === 'User'
              ? (review?.author?.id ?? [])
              : [],
          ),
        ]),
      ],
      approvers: normalizeApprovers(node, reviewers, opinionated.nodes),
      targetProject: node.baseRepository.nameWithOwner,
      targetBranch: node.baseRefName,
      ...(node.headRepository ? { sourceProject: node.headRepository.nameWithOwner } : {}),
      sourceBranch: node.headRefName,
      headSha: node.headRefOid,
      ...(node.author?.id ? { authorID: node.author.id } : {}),
      updatedAt: node.updatedAt,
      pipeline:
        contexts.nodes.length || !contexts.complete
          ? checks(contexts.nodes, contexts.complete, `${node.url}/checks`, node.headRefOid)
          : undefined,
      unresolvedThreads: threads.unresolved,
      threadsComplete: threads.complete,
    };
  }
}
