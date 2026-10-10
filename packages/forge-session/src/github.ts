import type { Exec } from './exec';
import {
  ForgeError,
  humanize,
  ownedBy,
  parseWebUrl,
  prefixReferences,
  type Forge,
  type ForgeTraits,
  type GitHubPullRequest,
  type Pipeline,
  type ReviewRef,
} from './forge';
import type { RemoteProject, Repository } from './git';
import { gitlabTraits } from './gitlab';

interface Connection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor?: string };
}

interface Check {
  __typename: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
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
  reviewThreads: Connection<{ isResolved: boolean }>;
  reviewRequests: Connection<{ requestedReviewer?: { login?: string; name?: string } }>;
  commits: {
    nodes: Array<{ commit: { statusCheckRollup?: { contexts: Connection<Check> } | null } }>;
  };
}

const fields = `number title url state isDraft mergeable reviewDecision headRefOid headRefName
  headRepository { nameWithOwner } baseRepository { nameWithOwner } baseRefName updatedAt
  reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
  reviewRequests(first:100) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } pageInfo { hasNextPage } }
  commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) {
    nodes { __typename ... on CheckRun { status conclusion detailsUrl } ... on StatusContext { state targetUrl } }
    pageInfo { hasNextPage endCursor }
  } } } } }`;

// Pagination stops after this many pages; results are then marked partial.
const MAX_PAGES = 50;

export type GraphQL = (
  host: string,
  query: string,
  variables: Record<string, string | number>,
) => Promise<Record<string, unknown>>;

export function ghGraphQL(run: Exec, cwd: string): GraphQL {
  return async (host, query, variables) => {
    const args = ['api', 'graphql', '--hostname', host, '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables))
      args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
    const result = await run('gh', args, cwd);
    let body: {
      data?: Record<string, unknown>;
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

const FAILED = [
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
];
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

// Summarizes the head commit's checks. Failures win over pending checks, and
// partial or unrecognized results never report success.
export function checks(nodes: Check[], complete: boolean, url: string): Pipeline {
  const failed = nodes.filter((node) =>
    FAILED.includes(node.conclusion ?? node.state ?? ''),
  ).length;
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
      label: `${failed} failed${pending ? `, ${pending} pending` : ''}${complete ? '' : ' (partial)'}`,
      url,
    };
  if (pending || !complete || unknown)
    return {
      status: 'PENDING',
      label: `${pending ? `${pending} pending` : 'unknown'}${complete ? '' : ' (partial)'}`,
      url,
    };
  return { status: 'SUCCESS', label: `${nodes.length} passed or skipped`, url };
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
};

// Reads GitHub pull requests through `gh api graphql`, using gh's login.
export class GitHubForge implements Forge {
  readonly traits = githubTraits;

  constructor(readonly graphql: GraphQL) {}

  async findByNumber(
    projects: readonly RemoteProject[],
    number: string,
  ): Promise<GitHubPullRequest | undefined> {
    for (const project of projects) {
      const [owner, repo] = project.path.split('/');
      const data = await this.graphql(
        project.host,
        `query($owner:String!,$repo:String!,$number:Int!) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${fields} } }
      }`,
        { owner, repo, number: Number(number) },
      );
      const node = (data.repository as { pullRequest?: Pull } | undefined)?.pullRequest;
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
        `query($owner:String!,$repo:String!,$branch:String!) {
        repository(owner:$owner,name:$repo) { pullRequests(first:100,states:OPEN,headRefName:$branch,orderBy:{field:UPDATED_AT,direction:DESC}) {
          nodes { number updatedAt headRepository { nameWithOwner } }
        } } }`,
        { owner, repo, branch: repository.sourceBranch },
      );
      const nodes =
        (
          data.repository as
            | { pullRequests?: Connection<Pick<Pull, 'number' | 'updatedAt' | 'headRepository'>> }
            | undefined
        )?.pullRequests?.nodes ?? [];
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
      `query($owner:String!,$repo:String!,$number:Int!) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) { headRefName } }
    }`,
      { owner, repo, number: Number(ref.iid) },
    );
    const branch = (
      data.repository as { pullRequest?: { headRefName?: unknown } | null } | undefined
    )?.pullRequest?.headRefName;
    return typeof branch === 'string' && branch ? branch : undefined;
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
          `query($owner:String!,$repo:String!,$branch:String!${after ? ',$after:String!' : ''}) {
          repository(owner:$owner,name:$repo) { pullRequests(first:100,states:OPEN,headRefName:$branch${after ? ',after:$after' : ''}) {
            nodes { ${fields} } pageInfo { hasNextPage endCursor }
          } } }`,
          { owner, repo, branch: repository.sourceBranch, ...(after ? { after } : {}) },
        );
        const pulls = (data.repository as { pullRequests?: Connection<Pull> } | undefined)
          ?.pullRequests;
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
        `query($owner:String!,$repo:String!,$number:Int!,$after:String!) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
          reviewThreads(first:100,after:$after) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
        } } }`,
        { owner, repo, number: node.number, after: page.endCursor },
      );
      const next = (
        data.repository as { pullRequest?: { reviewThreads?: Pull['reviewThreads'] } } | undefined
      )?.pullRequest?.reviewThreads;
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
        `query($owner:String!,$repo:String!,$oid:GitObjectID!,$after:String!) {
        repository(owner:$owner,name:$repo) { object(oid:$oid) { ... on Commit { statusCheckRollup {
          contexts(first:100,after:$after) { nodes { __typename ... on CheckRun { status conclusion detailsUrl } ... on StatusContext { state targetUrl } } pageInfo { hasNextPage endCursor } }
        } } } } }`,
        { owner, repo, oid: node.headRefOid, after: cursor.endCursor },
      );
      const next = (
        data.repository as
          | { object?: { statusCheckRollup?: { contexts?: Connection<Check> } } }
          | undefined
      )?.object?.statusCheckRollup?.contexts;
      if (!next) break;
      contexts.push(...next.nodes);
      cursor = next.pageInfo;
    }
    return { nodes: contexts, complete: !cursor?.hasNextPage };
  }

  private async normalize(host: string, node: Pull): Promise<GitHubPullRequest> {
    const [threads, contexts] = [await this.threads(host, node), await this.contexts(host, node)];
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
      awaitingReviewers: node.reviewRequests.nodes.flatMap((request) => {
        const reviewer = request.requestedReviewer;
        return reviewer?.login ? [reviewer.login] : reviewer?.name ? [reviewer.name] : [];
      }),
      reviewersComplete: !node.reviewRequests.pageInfo?.hasNextPage,
      targetProject: node.baseRepository.nameWithOwner,
      targetBranch: node.baseRefName,
      headSha: node.headRefOid,
      updatedAt: node.updatedAt,
      pipeline:
        contexts.nodes.length || !contexts.complete
          ? checks(contexts.nodes, contexts.complete, `${node.url}/checks`)
          : undefined,
      unresolvedThreads: threads.unresolved,
      threadsComplete: threads.complete,
    };
  }
}
