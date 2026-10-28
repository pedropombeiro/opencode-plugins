import type { Exec } from './exec';
import {
  ForgeError,
  humanize,
  ownedBy,
  parseWebUrl,
  prefixReferences,
  yesNo,
  type AutomatedReviewState,
  type Forge,
  type ForgeTraits,
  type GitLabMergeRequest,
  type ReviewRef,
} from './forge';
import type { RemoteProject, Repository } from './git';
import { fetchComments } from './gitlab-feedback';
import { duoFindings, duoReady } from './gitlab-review-feedback';
import { subscribeToNotes } from './gitlab-subscription';
import { query, typed, type Query, type Transport, type Typed } from './graphql';

interface DiscussionPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ resolvable: boolean; resolved: boolean }>;
}

interface MergeRequestNode {
  iid: string;
  title: string;
  webUrl: string;
  state: string;
  draft: boolean;
  conflicts: boolean;
  approved: boolean | null;
  approvedBy: { nodes: Array<{ id: string; bot?: boolean }> } | null;
  detailedMergeStatus: string | null;
  diffHeadSha: string | null;
  updatedAt: string | null;
  targetBranch: string;
  sourceProject: { fullPath: string } | null;
  targetProject: { fullPath: string };
  headPipeline: {
    status: string;
    path: string | null;
    detailedStatus: { label: string | null } | null;
  } | null;
  discussions: DiscussionPage;
  reviewers?: { nodes: ReviewerNode[] } | null;
}

// What `mergeRequestNumbersQuery` selects.
interface MergeRequestNumber {
  iid: string;
  updatedAt: string | null;
  sourceProject: { fullPath: string } | null;
}

interface ReviewerNode {
  type: string;
  username?: string;
  bot?: boolean;
  mergeRequestInteraction: { reviewState: string | null; approved?: boolean | null } | null;
}

const DISCUSSIONS = 'pageInfo { hasNextPage endCursor } nodes { resolvable resolved }';
const PAGE_SIZE = 100;
export const MAX_DISCUSSION_PAGES = 50;

const MERGE_REQUEST_FIELDS = `
  iid title webUrl state draft conflicts approved detailedMergeStatus diffHeadSha updatedAt targetBranch
  approvedBy(first: 100) { nodes { id bot } }
  sourceProject { fullPath }
  targetProject { fullPath }
  headPipeline { status path detailedStatus { label } }
  reviewers(first: 100) { nodes { type username bot mergeRequestInteraction { reviewState approved } } }
  discussions(first: ${PAGE_SIZE}) { ${DISCUSSIONS} }
`;

// Queries that look up several projects give each an alias, `p0`, `p1`, and
// so on. A project that doesn't exist, or that the viewer can't see, is null.
type Projects<T> = { [alias: `p${number}`]: T | null | undefined };

export function mergeRequestsQuery(
  projectCount: number,
): Query<Projects<{ mergeRequests?: { nodes: MergeRequestNode[] } | null }>> {
  const variables = Array.from({ length: projectCount }, (_, index) => `$p${index}: ID!`).join(
    ', ',
  );
  const projects = Array.from(
    { length: projectCount },
    (_, index) =>
      `p${index}: project(fullPath: $p${index}) {
        mergeRequests(sourceBranches: [$branch], state: opened, first: 20) { nodes { ${MERGE_REQUEST_FIELDS} } }
      }`,
  ).join('\n');
  return query(`query($branch: String!, ${variables}) {\n${projects}\n}`);
}

export function mergeRequestQuery(
  projectCount: number,
): Query<Projects<{ mergeRequest?: MergeRequestNode | null }>> {
  const variables = Array.from({ length: projectCount }, (_, index) => `$p${index}: ID!`).join(
    ', ',
  );
  const projects = Array.from(
    { length: projectCount },
    (_, index) =>
      `p${index}: project(fullPath: $p${index}) { mergeRequest(iid: $iid) { ${MERGE_REQUEST_FIELDS} } }`,
  ).join('\n');
  return query(`query($iid: String!, ${variables}) {\n${projects}\n}`);
}

// Only the fields that pick the newest MR from the source project.
export function mergeRequestNumbersQuery(
  projectCount: number,
): Query<Projects<{ mergeRequests?: { nodes: MergeRequestNumber[] } | null }>> {
  const variables = Array.from({ length: projectCount }, (_, index) => `$p${index}: ID!`).join(
    ', ',
  );
  const projects = Array.from(
    { length: projectCount },
    (_, index) =>
      `p${index}: project(fullPath: $p${index}) {
        mergeRequests(sourceBranches: [$branch], state: opened, first: 20) { nodes { iid updatedAt sourceProject { fullPath } } }
      }`,
  ).join('\n');
  return query(`query($branch: String!, ${variables}) {\n${projects}\n}`);
}

export const SOURCE_BRANCH_QUERY = query<{
  project?: { mergeRequest?: { sourceBranch?: string | null } | null } | null;
}>(`query($project: ID!, $iid: String!) {
  project(fullPath: $project) { mergeRequest(iid: $iid) { sourceBranch } }
}`);

export const DISCUSSIONS_QUERY = query<{
  project?: { mergeRequest?: { discussions?: DiscussionPage | null } | null } | null;
}>(`query($project: ID!, $iid: String!, $after: String) {
  project(fullPath: $project) {
    mergeRequest(iid: $iid) { discussions(first: ${PAGE_SIZE}, after: $after) { ${DISCUSSIONS} } }
  }
}`);

export function classifyError(message: string, code: number): ForgeError {
  const text = message.trim().replace(/^glab:\s*/, '') || `glab exited with code ${code}`;
  if (/ENOENT|command not found/i.test(text))
    return new ForgeError('missing-glab', 'glab is not installed');
  if (
    /\b401\b|unauthori[sz]ed|not logged in|authenticate|invalid token|token.*expired/i.test(text)
  ) {
    return new ForgeError('auth', 'GitLab authentication failed. Run `glab auth status`.');
  }
  if (/\b429\b|rate limit|too many requests/i.test(text))
    return new ForgeError('rate-limit', 'GitLab rate limit reached');
  return new ForgeError('request', text.split('\n')[0]);
}

type Variables = Record<string, string>;
export type GraphQL = Transport<Variables>;

interface GraphQLResponse {
  data?: object | null;
  errors?: { message?: unknown }[];
}

const isResponse = (body: unknown): body is GraphQLResponse =>
  typeof body === 'object' &&
  body !== null &&
  (!('errors' in body) || Array.isArray((body as GraphQLResponse).errors)) &&
  (!('data' in body) || typeof (body as GraphQLResponse).data === 'object');

export function glabGraphQL(run: Exec, cwd: string): GraphQL {
  return async (host, query, variables) => {
    const args = ['api', 'graphql', '--hostname', host, '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) args.push('-f', `${name}=${value}`);
    const result = await run('glab', args, cwd);
    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw classifyError(result.stderr, result.code);
    }
    if (!isResponse(body))
      throw classifyError(result.stderr || 'Unexpected GitLab response', result.code);
    // GitLab returns `null` for a field that failed, next to the error, and
    // for a project or MR that doesn't exist, without one. Only the second is
    // a missing PR/MR. Any error, or a failed command, fails the whole lookup,
    // so a timeout is retried instead of reported as no MR.
    if (body.errors?.length)
      throw classifyError(String(body.errors[0]?.message ?? ''), result.code);
    if (result.code !== 0) throw classifyError(result.stderr, result.code);
    if (!body.data) throw classifyError('GitLab returned no data', result.code);
    return body.data;
  };
}

const countUnresolved = (page: DiscussionPage) =>
  page.nodes.filter((discussion) => discussion.resolvable && !discussion.resolved).length;

export const gitlabTraits: ForgeTraits<GitLabMergeRequest, GitLabForge> = {
  kind: 'gitlab',
  noun: 'MR',
  ci: 'pipeline',
  // Self-managed instances are usually named gitlab.<domain>.
  recognizes: (host) => /(^|\.)gitlab\./.test(host),
  open: (run, directory) => new GitLabForge(glabGraphQL(run, directory)),
  owns: ownedBy('gitlab'),
  parseUrl: (url) => parseWebUrl('gitlab', url, /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/),
  // Issues can also be opened as work items.
  parseIssueUrl: (url) =>
    parseWebUrl('gitlab', url, /^\/(.+)\/-\/(?:issues|work_items)\/([1-9]\d*)\/?$/),
  reference: (iid) => `!${iid}`,
  issueReference: (iid) => `#${iid}`,
  titleReferences: (title) => prefixReferences(title, '!'),
  indicators: () => [],
  details(request) {
    const requirements =
      request.approvalRequirementsSatisfied === null
        ? 'unknown'
        : yesNo(request.approvalRequirementsSatisfied);
    const lines = [
      `Human approvals: ${yesNo(request.hasApprovals)} · Approval requirements satisfied: ${requirements}`,
    ];
    if (request.mergeStatus) lines.push(`Merge status: ${humanize(request.mergeStatus)}`);
    return lines;
  },
  automatedReview: {
    publishedFeedback: { storageKey: 'duo', select: duoFindings, ready: duoReady },
    name: 'GitLab Duo',
    status(request) {
      const state = request.duoReviewState;
      if (!state) return undefined;
      return { state: duoState(state), label: humanize(state) };
    },
  },
  feedback: {
    subscribe: subscribeToNotes,
    async fetch(run, directory, request) {
      const ref = gitlabTraits.parseUrl(request.url);
      return ref
        ? fetchComments(glabGraphQL(run, directory), ref.host, ref.project, ref.iid)
        : undefined;
    },
  },
};

// Final Duo states that can leave feedback to act on. An approval, or a review
// that was reset to unreviewed, needs nothing from the agent. New GitLab
// states stay silent until they are added here.
const DUO_FEEDBACK = new Set(['REVIEWED', 'REQUESTED_CHANGES']);

function duoState(state: string): AutomatedReviewState {
  if (state === 'REVIEW_STARTED') return 'running';
  return DUO_FEEDBACK.has(state) ? 'feedback' : 'settled';
}

// Reads GitLab merge requests through `glab api graphql`, using glab's login.
export class GitLabForge implements Forge {
  readonly traits = gitlabTraits;

  private readonly graphql: Typed<Variables>;

  constructor(graphql: GraphQL) {
    this.graphql = typed(graphql);
  }

  async findByBranch(repository: Repository): Promise<GitLabMergeRequest[]> {
    const { source, targets, sourceBranch } = repository;
    const variables: Record<string, string> = { branch: sourceBranch };
    targets.forEach((target, index) => (variables[`p${index}`] = target.path));
    const data = await this.graphql(source.host, mergeRequestsQuery(targets.length), variables);

    const sourcePath = source.path.toLowerCase();
    const seen = new Set<string>();
    const nodes: MergeRequestNode[] = [];
    targets.forEach((_, index) => {
      for (const node of data[`p${index}`]?.mergeRequests?.nodes ?? []) {
        // Another project's branch with the same name must not be reported as this branch's MR.
        if (node.sourceProject?.fullPath.toLowerCase() !== sourcePath) continue;
        const key = `${node.targetProject.fullPath}!${node.iid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(node);
      }
    });

    const requests = await Promise.all(nodes.map((node) => this.normalize(source.host, node)));
    return requests.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async findNumberByBranch(repository: Repository): Promise<string | undefined> {
    const { source, targets, sourceBranch } = repository;
    const variables: Record<string, string> = { branch: sourceBranch };
    targets.forEach((target, index) => (variables[`p${index}`] = target.path));
    const data = await this.graphql(
      source.host,
      mergeRequestNumbersQuery(targets.length),
      variables,
    );

    const sourcePath = source.path.toLowerCase();
    const nodes = targets.flatMap((_, index) => data[`p${index}`]?.mergeRequests?.nodes ?? []);
    return (
      nodes
        // Another project's branch with the same name must not name this branch's MR.
        .filter((node) => node.sourceProject?.fullPath.toLowerCase() === sourcePath)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]?.iid
    );
  }

  async sourceBranch(ref: ReviewRef): Promise<string | undefined> {
    const data = await this.graphql(ref.host, SOURCE_BRANCH_QUERY, {
      project: ref.project,
      iid: ref.iid,
    });
    const branch = data.project?.mergeRequest?.sourceBranch;
    return typeof branch === 'string' && branch ? branch : undefined;
  }

  async findByNumber(
    projects: readonly RemoteProject[],
    iid: string,
  ): Promise<GitLabMergeRequest | undefined> {
    if (projects.length === 0) return undefined;
    const host = projects[0].host;
    const variables: Record<string, string> = { iid };
    projects.forEach((project, index) => (variables[`p${index}`] = project.path));
    const data = await this.graphql(host, mergeRequestQuery(projects.length), variables);
    for (let index = 0; index < projects.length; index++) {
      const node = data[`p${index}`]?.mergeRequest;
      if (node) return this.normalize(host, node);
    }
    return undefined;
  }

  private async unresolvedThreads(host: string, node: MergeRequestNode) {
    let count = countUnresolved(node.discussions);
    let page = node.discussions.pageInfo;
    let pages = 1;
    while (page.hasNextPage && page.endCursor && pages < MAX_DISCUSSION_PAGES) {
      const data = await this.graphql(host, DISCUSSIONS_QUERY, {
        project: node.targetProject.fullPath,
        iid: node.iid,
        after: page.endCursor,
      });
      const next = data.project?.mergeRequest?.discussions;
      if (!next) break;
      count += countUnresolved(next);
      page = next.pageInfo;
      pages++;
    }
    return { count, complete: !page.hasNextPage };
  }

  private async normalize(host: string, node: MergeRequestNode): Promise<GitLabMergeRequest> {
    const threads = await this.unresolvedThreads(host, node);
    const pipeline = node.headPipeline;
    // A bot approval, such as Duo's when its review finds nothing, can satisfy
    // rules that require no approvals, so only people's approvals count.
    const hasApprovals = (node.approvedBy?.nodes ?? []).some((approver) => approver.bot !== true);
    const awaitingReviewers = (node.reviewers?.nodes ?? [])
      .filter(
        (reviewer) =>
          reviewer.bot !== true &&
          reviewer.username &&
          reviewer.mergeRequestInteraction?.approved !== true,
      )
      .map((reviewer) => reviewer.username!);
    return {
      forge: 'gitlab',
      iid: node.iid,
      title: node.title,
      url: node.webUrl,
      state: node.state.toLowerCase(),
      draft: node.draft,
      conflicts: node.conflicts,
      conflictsKnown: true,
      approved: node.approved === true && hasApprovals && awaitingReviewers.length === 0,
      hasApprovals,
      approvalRequirementsSatisfied: node.approved,
      awaitingReviewers,
      reviewersComplete: true,
      mergeStatus: node.detailedMergeStatus ?? undefined,
      targetProject: node.targetProject.fullPath,
      targetBranch: node.targetBranch,
      headSha: node.diffHeadSha ?? undefined,
      updatedAt: node.updatedAt ?? undefined,
      pipeline: pipeline
        ? {
            status: pipeline.status,
            label:
              pipeline.detailedStatus?.label ?? pipeline.status.toLowerCase().replace(/_/g, ' '),
            url: pipeline.path ? `https://${host}${pipeline.path}` : undefined,
          }
        : undefined,
      unresolvedThreads: threads.count,
      threadsComplete: threads.complete,
      duoReviewState:
        node.reviewers?.nodes.find((reviewer) => reviewer.type === 'DUO_CODE_REVIEW_BOT')
          ?.mergeRequestInteraction?.reviewState ?? undefined,
    };
  }
}
