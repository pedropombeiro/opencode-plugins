import type { Exec } from '../../exec';
import {
  ForgeError,
  humanize,
  ownedBy,
  parseWebUrl,
  prefixReferences,
  yesNo,
  type AutomatedReviewState,
  type FailedJob,
  type Forge,
  type ForgeTraits,
  type GitLabIssueSnapshot,
  type GitLabMergeRequest,
  type ReviewerApproval,
  type ReviewRef,
} from '../../forge';
import type { RemoteProject, Repository } from '../../git';
import { fetchComments, fetchDetails } from './feedback';
import { fetchReviewRequests } from './review-requests';
import { fetchLinkedNote, linkedNotes } from './linked-notes';
import { duoFindings, duoReady } from './review-feedback';
import { subscribeToNotes } from './subscription';
import { query, typed, type Query, type Transport, type Typed } from '../../graphql';
import { reviewIndicators } from './approval-status';

interface DiscussionPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ resolvable: boolean; resolved: boolean }>;
}

interface ConnectionPage<T> {
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null } | null;
  nodes: T[];
}

interface ApprovedByNode {
  id: string;
  username?: string | null;
  bot?: boolean;
}

interface ApprovalRuleNode {
  name: string | null;
  type: string | null;
  approvalsRequired: number | null;
  approved: boolean | null;
  eligibleApprovers: Array<{ username: string; type: string; bot: boolean }> | null;
}

interface MergeRequestNode {
  iid: string;
  title: string;
  webUrl: string;
  state: string;
  draft: boolean;
  conflicts: boolean;
  approved: boolean | null;
  approvedBy: ConnectionPage<ApprovedByNode> | null;
  approvalsRequired?: number | null;
  approvalsLeft?: number | null;
  autoMergeEnabled: boolean;
  mergeTrainCar?: { index: number | null } | null;
  approvalState?: { rules: ApprovalRuleNode[] | null } | null;
  mergeStatusEnum?: string | null;
  detailedMergeStatus: string | null;
  diffHeadSha: string | null;
  updatedAt: string | null;
  targetBranch: string;
  sourceBranch: string;
  sourceProject: { fullPath: string } | null;
  targetProject: { fullPath: string };
  author?: { id: string } | null;
  headPipeline: {
    id?: string | null;
    status: string;
    path: string | null;
    detailedStatus: { label: string | null } | null;
    jobs?: {
      pageInfo?: { hasNextPage: boolean } | null;
      nodes: Array<{
        id?: string | null;
        name: string | null;
        allowFailure: boolean;
        webPath: string | null;
        stage: { name: string | null } | null;
      }>;
    } | null;
  } | null;
  discussions: DiscussionPage;
  reviewers?: ConnectionPage<ReviewerNode> | null;
}

// What `mergeRequestNumbersQuery` selects.
interface MergeRequestNumber {
  iid: string;
  updatedAt: string | null;
  sourceProject: { fullPath: string } | null;
}

interface ReviewerNode {
  id?: string | null;
  type: string;
  username?: string;
  bot?: boolean;
  mergeRequestInteraction: {
    reviewState: string | null;
    approved?: boolean | null;
    approvedAt?: string | null;
  } | null;
}

const DISCUSSIONS = 'pageInfo { hasNextPage endCursor } nodes { resolvable resolved }';
const PAGE_SIZE = 100;
export const MAX_DISCUSSION_PAGES = 50;

// The failed jobs read with each MR. One that isn't allowed to fail is enough
// to tell the pipeline fails; past these, only the pipeline's status can tell.
const FIRST_FAILED_JOBS = 10;
const FAILED_JOBS =
  'pageInfo { hasNextPage } nodes { id name allowFailure webPath stage { name } }';

type FailedJobPage = NonNullable<NonNullable<MergeRequestNode['headPipeline']>['jobs']>;

// Merge statuses during which GitLab hasn't settled whether the MR conflicts.
const RECHECKING = new Set(['CHECKING', 'UNCHECKED', 'PREPARING']);
// GitLab's `conflicts` is true only in the CANNOT_BE_MERGED merge status. When
// the target branch moves, a conflicting MR goes to this one, where `conflicts`
// reads false and the detailed status still says CONFLICT, until a recheck.
const CONFLICT_RECHECK = 'CANNOT_BE_MERGED_RECHECK';

const REVIEWER_FIELDS = (includeApprovedAt: boolean) =>
  `pageInfo { hasNextPage endCursor } nodes { id type username bot mergeRequestInteraction { reviewState approved${includeApprovedAt ? ' approvedAt' : ''} } }`;
const APPROVED_BY_FIELDS = 'pageInfo { hasNextPage endCursor } nodes { id username bot }';

const mergeRequestFields = (includeApprovedAt: boolean, includeExtendedStatus: boolean) => `
  iid title webUrl state draft conflicts approved mergeStatusEnum detailedMergeStatus diffHeadSha updatedAt targetBranch sourceBranch
  autoMergeEnabled
  ${
    includeExtendedStatus
      ? `
    approvalsRequired approvalsLeft mergeTrainCar { index }
    approvalState { rules { name type approvalsRequired approved eligibleApprovers { username type bot } } }
  `
      : ''
  }
  approvedBy(first: ${PAGE_SIZE}) { ${APPROVED_BY_FIELDS} }
  sourceProject { fullPath }
  targetProject { fullPath }
  author { id }
  headPipeline {
    id status path detailedStatus { label }
    jobs(statuses: [FAILED], retried: false, first: ${FIRST_FAILED_JOBS}) { ${FAILED_JOBS} }
  }
  reviewers(first: ${PAGE_SIZE}) { ${REVIEWER_FIELDS(includeApprovedAt)} }
  discussions(first: ${PAGE_SIZE}) { ${DISCUSSIONS} }
`;

// Queries that look up several projects give each an alias, `p0`, `p1`, and
// so on. A project that doesn't exist, or that the viewer can't see, is null.
type Projects<T> = { [alias: `p${number}`]: T | null | undefined };

export function mergeRequestsQuery(
  projectCount: number,
  includeApprovedAt = true,
  includeExtendedStatus = true,
): Query<Projects<{ mergeRequests?: { nodes: MergeRequestNode[] } | null }>> {
  const fields = mergeRequestFields(includeApprovedAt, includeExtendedStatus);
  const variables = Array.from({ length: projectCount }, (_, index) => `$p${index}: ID!`).join(
    ', ',
  );
  const projects = Array.from(
    { length: projectCount },
    (_, index) =>
      `p${index}: project(fullPath: $p${index}) {
        mergeRequests(sourceBranches: [$branch], state: opened, first: 20) { nodes { ${fields} } }
      }`,
  ).join('\n');
  return query(`query($branch: String!, ${variables}) {\n${projects}\n}`);
}

export function mergeRequestQuery(
  projectCount: number,
  includeApprovedAt = true,
  includeExtendedStatus = true,
): Query<Projects<{ mergeRequest?: MergeRequestNode | null }>> {
  const fields = mergeRequestFields(includeApprovedAt, includeExtendedStatus);
  const variables = Array.from({ length: projectCount }, (_, index) => `$p${index}: ID!`).join(
    ', ',
  );
  const projects = Array.from(
    { length: projectCount },
    (_, index) =>
      `p${index}: project(fullPath: $p${index}) { mergeRequest(iid: $iid) { ${fields} } }`,
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

export const ISSUE_QUERY = query<{
  project?: {
    workItems?: {
      nodes: Array<{
        state: string;
        widgets: Array<{
          status?: { name: string } | null;
          assignees?: { nodes: Array<{ username: string }> };
          labels?: { nodes: Array<{ title: string }> };
          milestone?: { title: string } | null;
        }>;
      }>;
    } | null;
  } | null;
}>(`query($project: ID!, $iid: String!) {
  project(fullPath: $project) {
    workItems(iid: $iid, first: 1) {
      nodes {
        state
        widgets {
          ... on WorkItemWidgetStatus { status { name } }
          ... on WorkItemWidgetAssignees { assignees { nodes { username } } }
          ... on WorkItemWidgetLabels { labels { nodes { title } } }
          ... on WorkItemWidgetMilestone { milestone { title } }
        }
      }
    }
  }
}`);

export const DISCUSSIONS_QUERY = query<{
  project?: { mergeRequest?: { discussions?: DiscussionPage | null } | null } | null;
}>(`query($project: ID!, $iid: String!, $after: String) {
  project(fullPath: $project) {
    mergeRequest(iid: $iid) { discussions(first: ${PAGE_SIZE}, after: $after) { ${DISCUSSIONS} } }
  }
}`);

const reviewersQuery = (includeApprovedAt: boolean) =>
  query<{
    project?: { mergeRequest?: { reviewers?: ConnectionPage<ReviewerNode> | null } | null } | null;
  }>(`query($project: ID!, $iid: String!, $after: String) {
  project(fullPath: $project) {
    mergeRequest(iid: $iid) { reviewers(first: ${PAGE_SIZE}, after: $after) { ${REVIEWER_FIELDS(includeApprovedAt)} } }
  }
}`);

const APPROVED_BY_QUERY = query<{
  project?: {
    mergeRequest?: { approvedBy?: ConnectionPage<ApprovedByNode> | null } | null;
  } | null;
}>(`query($project: ID!, $iid: String!, $after: String) {
  project(fullPath: $project) {
    mergeRequest(iid: $iid) { approvedBy(first: ${PAGE_SIZE}, after: $after) { ${APPROVED_BY_FIELDS} } }
  }
}`);

const MARK_READY_MUTATION = query<{
  mergeRequestSetDraft?: {
    mergeRequest?: { draft?: boolean | null } | null;
    errors?: string[] | null;
  } | null;
}>(`mutation($project: ID!, $iid: String!) {
  mergeRequestSetDraft(input: { projectPath: $project, iid: $iid, draft: false }) {
    mergeRequest { draft }
    errors
  }
}`);

const unsupportedApprovedAtHosts = new Set<string>();
const unsupportedExtendedStatusHosts = new Set<string>();

const isMissingExtendedStatus = (error: unknown) =>
  /(?:approvalsRequired|approvalsLeft|mergeTrainCar|approvalState).*?(?:doesn't exist|not defined|unknown)|(?:undefinedField|unknown field).*?(?:approvalsRequired|approvalsLeft|mergeTrainCar|approvalState)|Field ['"]index['"] doesn't exist on type ['"]MergeTrainCar['"]/i.test(
    error instanceof Error ? error.message : String(error),
  );

const isMissingApprovedAt = (error: unknown) =>
  /approvedAt.*(?:doesn't exist|not defined|unknown)|(?:undefinedField|unknown field).*approvedAt/i.test(
    error instanceof Error ? error.message : String(error),
  );

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
  open: (run, directory) =>
    new GitLabForge(
      glabGraphQL(run, directory),
      unsupportedApprovedAtHosts,
      unsupportedExtendedStatusHosts,
    ),
  owns: ownedBy('gitlab'),
  parseUrl: (url) => parseWebUrl('gitlab', url, /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/),
  // Issues can also be opened as work items.
  parseIssueUrl: (url) =>
    parseWebUrl('gitlab', url, /^\/(.+)\/-\/(?:issues|work_items)\/([1-9]\d*)\/?$/),
  reference: (iid) => `!${iid}`,
  issueReference: (iid) => `#${iid}`,
  titleReferences: (title) => prefixReferences(title, '!'),
  indicators: () => [],
  reviewIndicators,
  details(request) {
    const requirements =
      request.approvalRequirementsSatisfied === null
        ? 'unknown'
        : yesNo(request.approvalRequirementsSatisfied);
    const lines = [
      `Human approvals: ${yesNo(request.hasApprovals)} · Approval requirements satisfied: ${requirements}`,
    ];
    const missing =
      request.approvalRequirementsSatisfied === true ? [] : (request.missingRules ?? []);
    for (const rule of missing.slice(0, 2)) {
      const others = (rule.eligibleCount ?? rule.eligible.length) - rule.eligible.length;
      const who = rule.eligibleReviewers.length
        ? `, @${rule.eligibleReviewers[0]} can approve`
        : rule.eligible.length
          ? `, ${request.awaitingReviewers.length ? 'ask an eligible approver: ' : 'ask '}@${rule.eligible.join(', @')}${others > 0 ? ` or ${others} ${others === 1 ? 'other' : 'others'}` : ''}`
          : '';
      lines.push(`Still needed: ${rule.name} (${rule.required} required in total${who})`);
    }
    if (missing.length > 2) lines.push(`+${missing.length - 2} more rules`);
    if (request.autoMergeEnabled) lines.push('Auto-merge: set');
    if (request.mergeTrainIndex != null)
      lines.push(`Merge train: position ${request.mergeTrainIndex + 1}`);
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
    async viewerID(run, directory, host) {
      const data = await typed(glabGraphQL(run, directory))(
        host,
        query<{ currentUser: { id: string } | null }>('query { currentUser { id } }'),
        {},
      );
      return data.currentUser?.id;
    },
    async reviewerID(run, directory, host, username) {
      const data = await typed(glabGraphQL(run, directory))(
        host,
        query<{ user: { id: string; username: string } | null }>(
          'query($username: String!) { user(username: $username) { id username } }',
        ),
        { username },
      );
      return data.user?.username.toLowerCase() === username.toLowerCase()
        ? data.user.id
        : undefined;
    },
    subscribe: subscribeToNotes,
    async fetch(run, directory, request) {
      const ref = gitlabTraits.parseUrl(request.url);
      return ref
        ? fetchComments(glabGraphQL(run, directory), ref.host, ref.project, ref.iid)
        : undefined;
    },
    async reviewRequests(run, directory, request) {
      const ref = gitlabTraits.parseUrl(request.url);
      return ref
        ? fetchReviewRequests(
            glabGraphQL(run, directory),
            ref.host,
            ref.project,
            ref.iid,
            request.url,
          )
        : undefined;
    },
    async details(run, directory, request, ids) {
      const ref = gitlabTraits.parseUrl(request.url);
      return ref ? fetchDetails(glabGraphQL(run, directory), ref.host, ref.project, ids) : [];
    },
    commentID: (url) => url.match(/#note_(\d+)$/)?.[1],
    linkedNotes(request, details) {
      const ref = gitlabTraits.parseUrl(request.url);
      return ref ? linkedNotes(ref.host, details) : [];
    },
    async linkedNote(run, directory, request, url) {
      const ref = gitlabTraits.parseUrl(request.url);
      return ref ? fetchLinkedNote(glabGraphQL(run, directory), ref.host, url) : undefined;
    },
  },
};

// Final Duo states that can leave feedback to act on. An approval, or a review
// that was reset to unreviewed, needs nothing from the agent. New GitLab
// states stay silent until they are added here.
const DUO_FEEDBACK = new Set(['REVIEWED', 'REQUESTED_CHANGES']);

// The pipeline's ID, and the read failed jobs that fail it. When it has more
// failed jobs than were read, the list is incomplete, and none of the unread
// ones counts as failing it.
function failedJobs(host: string, pipeline: NonNullable<MergeRequestNode['headPipeline']>) {
  if (!pipeline.id || !pipeline.jobs) return {};
  return {
    id: pipeline.id,
    failedJobs: requiredFailures(host, pipeline.jobs.nodes),
    failedJobsComplete: !pipeline.jobs.pageInfo?.hasNextPage,
  };
}

// The failed jobs that fail the pipeline. Jobs allowed to fail don't, and the
// query leaves out retried ones.
function requiredFailures(host: string, nodes: FailedJobPage['nodes']): FailedJob[] {
  return nodes.flatMap((job) =>
    !job.allowFailure && job.name
      ? [
          {
            ...(job.id ? { id: job.id } : {}),
            name: job.name,
            ...(job.webPath ? { url: `https://${host}${job.webPath}` } : {}),
            ...(job.stage?.name ? { stage: job.stage.name } : {}),
          },
        ]
      : [],
  );
}

function duoState(state: string): AutomatedReviewState {
  if (state === 'REVIEW_STARTED') return 'running';
  return DUO_FEEDBACK.has(state) ? 'feedback' : 'settled';
}

function normalizeApprovers(
  reviewers: readonly ReviewerNode[],
  approvedBy: readonly ApprovedByNode[],
): ReviewerApproval[] {
  const byId = new Map<string, ReviewerNode>();
  const byUsername = new Map<string, ReviewerNode>();
  for (const reviewer of reviewers) {
    if (reviewer.id) byId.set(reviewer.id, reviewer);
    if (reviewer.username) byUsername.set(reviewer.username.toLowerCase(), reviewer);
  }
  const isDuo = (reviewer?: ReviewerNode, username?: string, bot?: boolean) =>
    reviewer?.type === 'DUO_CODE_REVIEW_BOT' ||
    (bot === true && username?.toLowerCase() === 'gitlabduo');
  const inactiveReview = (reviewer?: ReviewerNode) => {
    const state = reviewer?.mergeRequestInteraction?.reviewState;
    return !!state && state !== 'APPROVED';
  };
  const found: ReviewerApproval[] = [];
  const add = (entry: ReviewerApproval) => {
    const lower = entry.username.toLowerCase();
    const index = found.findIndex((existing) =>
      entry.id && existing.id
        ? existing.id === entry.id
        : existing.username.toLowerCase() === lower && (!entry.id || !existing.id),
    );
    if (index < 0) {
      found.push(entry);
      return;
    }
    const existing = found[index];
    found[index] = {
      ...existing,
      ...entry,
      ...(existing.id || entry.id ? { id: entry.id ?? existing.id } : {}),
      ...(existing.bot || entry.bot ? { bot: true } : {}),
      ...(existing.automated || entry.automated ? { automated: true } : {}),
      ...(existing.reviewID || entry.reviewID
        ? { reviewID: entry.reviewID ?? existing.reviewID }
        : {}),
    };
  };

  for (const reviewer of reviewers) {
    const interaction = reviewer.mergeRequestInteraction;
    const approving =
      interaction?.reviewState === 'APPROVED' ||
      (!interaction?.reviewState && interaction?.approved === true);
    if (!approving) continue;
    const duo = isDuo(reviewer, reviewer.username, reviewer.bot);
    const username = reviewer.username ?? (duo ? 'GitLabDuo' : undefined);
    if (!username) continue;
    const bot = reviewer.bot === true || duo;
    add({
      ...(reviewer.id ? { id: reviewer.id } : {}),
      username,
      ...(bot ? { bot: true } : {}),
      ...(duo ? { automated: true } : {}),
      ...(interaction?.approvedAt ? { reviewID: interaction.approvedAt } : {}),
    });
  }

  for (const approver of approvedBy) {
    const matched =
      (approver.id ? byId.get(approver.id) : undefined) ??
      (approver.username ? byUsername.get(approver.username.toLowerCase()) : undefined);
    if (inactiveReview(matched)) continue;
    const duo = isDuo(
      matched,
      approver.username ?? matched?.username,
      approver.bot ?? matched?.bot,
    );
    const username = approver.username ?? matched?.username ?? (duo ? 'GitLabDuo' : undefined);
    if (!username) continue;
    const bot = approver.bot === true || matched?.bot === true || duo;
    add({
      ...(approver.id || matched?.id ? { id: approver.id ?? matched?.id ?? undefined } : {}),
      username,
      ...(bot ? { bot: true } : {}),
      ...(duo ? { automated: true } : {}),
    });
  }

  return found;
}

// Reads GitLab merge requests through `glab api graphql`, using glab's login.
export class GitLabForge implements Forge {
  readonly traits = gitlabTraits;

  private readonly graphql: Typed<Variables>;

  constructor(
    graphql: GraphQL,
    private readonly unsupportedApprovedAt: Set<string> = new Set(),
    private readonly unsupportedExtendedStatus: Set<string> = new Set(),
  ) {
    this.graphql = typed(graphql);
  }

  private async queryWithApprovedAt<T>(
    host: string,
    build: (includeApprovedAt: boolean) => Query<T>,
    variables: Variables,
  ): Promise<T> {
    if (this.unsupportedApprovedAt.has(host)) {
      return this.graphql(host, build(false), variables);
    }
    try {
      return await this.graphql(host, build(true), variables);
    } catch (error) {
      if (!isMissingApprovedAt(error)) throw error;
      this.unsupportedApprovedAt.add(host);
      return this.graphql(host, build(false), variables);
    }
  }

  private async queryStatus<T>(
    host: string,
    build: (includeApprovedAt: boolean, includeExtendedStatus: boolean) => Query<T>,
    variables: Variables,
  ): Promise<T> {
    const run = (extended: boolean) =>
      this.queryWithApprovedAt(host, (approvedAt) => build(approvedAt, extended), variables);
    if (this.unsupportedExtendedStatus.has(host)) return run(false);
    try {
      return await run(true);
    } catch (error) {
      if (!isMissingExtendedStatus(error)) throw error;
      this.unsupportedExtendedStatus.add(host);
      return run(false);
    }
  }

  async findByBranch(repository: Repository): Promise<GitLabMergeRequest[]> {
    const { source, targets, sourceBranch } = repository;
    const variables: Record<string, string> = { branch: sourceBranch };
    targets.forEach((target, index) => (variables[`p${index}`] = target.path));
    const data = await this.queryStatus(
      source.host,
      (approvedAt, extended) => mergeRequestsQuery(targets.length, approvedAt, extended),
      variables,
    );

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

  async issue(ref: ReviewRef): Promise<GitLabIssueSnapshot | undefined> {
    const data = await this.graphql(ref.host, ISSUE_QUERY, {
      project: ref.project,
      iid: ref.iid,
    });
    const node = data.project?.workItems?.nodes[0];
    if (!node) return undefined;
    const widgets = node.widgets;
    const milestone = widgets.find((widget) => widget.milestone)?.milestone?.title;
    const status = widgets.find((widget) => widget.status)?.status?.name;
    return {
      forge: 'gitlab',
      open: node.state === 'OPEN',
      ...(status ? { status } : {}),
      assignees: widgets.flatMap((widget) => widget.assignees?.nodes ?? []).map((u) => u.username),
      labels: widgets.flatMap((widget) => widget.labels?.nodes ?? []).map((l) => l.title),
      ...(milestone ? { milestone } : {}),
    };
  }

  async markReady(
    ref: ReviewRef,
    options?: { beforeMutate?: () => Promise<void> | void },
  ): Promise<void> {
    await options?.beforeMutate?.();
    const data = await this.graphql(ref.host, MARK_READY_MUTATION, {
      project: ref.project,
      iid: ref.iid,
    });
    const result = data.mergeRequestSetDraft;
    if (result?.errors?.length) throw new ForgeError('request', result.errors[0]);
    if (!result?.mergeRequest || result.mergeRequest.draft !== false)
      throw new ForgeError('request', 'Could not mark the GitLab merge request as ready');
  }

  async findByNumber(
    projects: readonly RemoteProject[],
    iid: string,
  ): Promise<GitLabMergeRequest | undefined> {
    if (projects.length === 0) return undefined;
    const host = projects[0].host;
    const variables: Record<string, string> = { iid };
    projects.forEach((project, index) => (variables[`p${index}`] = project.path));
    const data = await this.queryStatus(
      host,
      (approvedAt, extended) => mergeRequestQuery(projects.length, approvedAt, extended),
      variables,
    );
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

  private async allReviewers(host: string, node: MergeRequestNode) {
    if (!node.reviewers?.pageInfo)
      return { nodes: [...(node.reviewers?.nodes ?? [])], complete: false };
    const nodes = [...node.reviewers.nodes];
    let page: { hasNextPage: boolean; endCursor?: string | null } = node.reviewers.pageInfo;
    let pages = 1;
    while (page.hasNextPage && page.endCursor && pages < MAX_DISCUSSION_PAGES) {
      const data = await this.queryWithApprovedAt(
        host,
        (includeApprovedAt) => reviewersQuery(includeApprovedAt),
        {
          project: node.targetProject.fullPath,
          iid: node.iid,
          after: page.endCursor,
        },
      );
      const next = data.project?.mergeRequest?.reviewers;
      if (!next?.pageInfo) return { nodes, complete: false };
      nodes.push(...next.nodes);
      page = next.pageInfo;
      pages++;
    }
    return { nodes, complete: !page.hasNextPage };
  }

  private async allApprovedBy(host: string, node: MergeRequestNode) {
    if (!node.approvedBy?.pageInfo)
      return { nodes: [...(node.approvedBy?.nodes ?? [])], complete: false };
    const nodes = [...node.approvedBy.nodes];
    let page: { hasNextPage: boolean; endCursor?: string | null } = node.approvedBy.pageInfo;
    let pages = 1;
    while (page.hasNextPage && page.endCursor && pages < MAX_DISCUSSION_PAGES) {
      const data = await this.graphql(host, APPROVED_BY_QUERY, {
        project: node.targetProject.fullPath,
        iid: node.iid,
        after: page.endCursor,
      });
      const next = data.project?.mergeRequest?.approvedBy;
      if (!next?.pageInfo) return { nodes, complete: false };
      nodes.push(...next.nodes);
      page = next.pageInfo;
      pages++;
    }
    return { nodes, complete: !page.hasNextPage };
  }

  private async normalize(host: string, node: MergeRequestNode): Promise<GitLabMergeRequest> {
    const [threads, reviewersPage, approvedByPage] = await Promise.all([
      this.unresolvedThreads(host, node),
      this.allReviewers(host, node),
      this.allApprovedBy(host, node),
    ]);
    const pipeline = node.headPipeline;
    // A bot approval, such as Duo's when its review finds nothing, can satisfy
    // rules that require no approvals, so only people's approvals count.
    const hasApprovals = approvedByPage.nodes.some((approver) => approver.bot !== true);
    const awaitingReviewers = reviewersPage.nodes
      .filter(
        (reviewer) =>
          reviewer.bot !== true &&
          reviewer.username &&
          reviewer.mergeRequestInteraction?.approved !== true,
      )
      .map((reviewer) => reviewer.username!);
    const approvers = normalizeApprovers(reviewersPage.nodes, approvedByPage.nodes);
    const approvedNames = new Set(
      [...approvedByPage.nodes, ...approvers].flatMap(({ username }) =>
        username ? [username.toLowerCase()] : [],
      ),
    );
    const missingRules = (node.approvalState?.rules ?? []).flatMap((rule) => {
      if (rule.approvalsRequired == null || rule.approvalsRequired <= 0 || rule.approved !== false)
        return [];
      const eligible = (rule.eligibleApprovers ?? []).filter(
        ({ username, bot }) => !bot && !approvedNames.has(username.toLowerCase()),
      );
      const eligibleNames = new Set(eligible.map(({ username }) => username.toLowerCase()));
      const humans = eligible.filter(({ type }) => type === 'HUMAN');
      const humanNames = new Set(humans.map(({ username }) => username.toLowerCase()));
      const eligibleReviewers = awaitingReviewers
        .filter((username) => eligibleNames.has(username.toLowerCase()))
        .sort(
          (a, b) =>
            Number(humanNames.has(b.toLowerCase())) - Number(humanNames.has(a.toLowerCase())),
        );
      const candidates = humans.length ? humans : eligible;
      return [
        {
          name: rule.name ?? 'Unnamed approval rule',
          type: rule.type ?? undefined,
          required: rule.approvalsRequired,
          eligibleReviewers,
          eligible: candidates.slice(0, 2).map(({ username }) => username),
          eligibleCount: candidates.length,
        },
      ];
    });
    return {
      forge: 'gitlab',
      iid: node.iid,
      title: node.title,
      url: node.webUrl,
      state: node.state.toLowerCase(),
      draft: node.draft,
      // A conflict that GitLab rechecks still counts, but as unknown, so the
      // last known state stands until the recheck settles it.
      conflicts: node.conflicts || node.mergeStatusEnum === CONFLICT_RECHECK,
      // While GitLab recalculates mergeability, `conflicts` may describe an
      // older commit.
      conflictsKnown:
        node.mergeStatusEnum !== CONFLICT_RECHECK &&
        !RECHECKING.has(node.detailedMergeStatus ?? ''),
      approved: node.approved === true && hasApprovals && awaitingReviewers.length === 0,
      hasApprovals,
      approvalRequirementsSatisfied: node.approved,
      approvalsRequired: node.approvalsRequired ?? undefined,
      approvalsLeft: node.approvalsLeft ?? undefined,
      missingRules,
      autoMergeEnabled: node.autoMergeEnabled,
      mergeTrainIndex: node.mergeTrainCar?.index,
      awaitingReviewers,
      reviewersComplete: reviewersPage.complete,
      changesRequested: reviewersPage.nodes.some(
        (reviewer) => reviewer.mergeRequestInteraction?.reviewState === 'REQUESTED_CHANGES',
      )
        ? true
        : reviewersPage.complete &&
            reviewersPage.nodes.every((reviewer) => reviewer.mergeRequestInteraction?.reviewState)
          ? false
          : undefined,
      approvalsComplete: reviewersPage.complete && approvedByPage.complete,
      reviewerIDs: reviewersPage.nodes.flatMap((reviewer) => reviewer.id ?? []),
      approvers,
      mergeStatus: node.detailedMergeStatus ?? undefined,
      targetProject: node.targetProject.fullPath,
      targetBranch: node.targetBranch,
      ...(node.sourceProject ? { sourceProject: node.sourceProject.fullPath } : {}),
      sourceBranch: node.sourceBranch,
      headSha: node.diffHeadSha ?? undefined,
      ...(node.author?.id ? { authorID: node.author.id } : {}),
      updatedAt: node.updatedAt ?? undefined,
      pipeline: pipeline
        ? {
            status: pipeline.status,
            label:
              pipeline.detailedStatus?.label ?? pipeline.status.toLowerCase().replace(/_/g, ' '),
            url: pipeline.path ? `https://${host}${pipeline.path}` : undefined,
            ...failedJobs(host, pipeline),
          }
        : undefined,
      unresolvedThreads: threads.count,
      threadsComplete: threads.complete,
      duoReviewState:
        reviewersPage.nodes.find((reviewer) => reviewer.type === 'DUO_CODE_REVIEW_BOT')
          ?.mergeRequestInteraction?.reviewState ?? undefined,
    };
  }
}
