import type { Exec } from './exec';
import type { RemoteProject, Repository } from './git';

// Forge-neutral review requests: GitLab merge requests and GitHub pull
// requests. The store, footer, and commands work with these types; each forge
// adapter owns its API calls and normalization.
export type ForgeKind = 'gitlab' | 'github';

export interface Pipeline {
  status: string;
  label: string;
  url?: string;
}

interface Common {
  iid: string;
  title: string;
  url: string;
  // opened, merged, closed, or locked.
  state: string;
  draft: boolean;
  conflicts: boolean;
  // False while the forge hasn't computed mergeability yet.
  conflictsKnown: boolean;
  // Approved, with no human reviewer still pending.
  approved: boolean;
  // Human reviewers who haven't approved yet.
  awaitingReviewers: string[];
  // False when more reviewers exist than the adapter fetches.
  reviewersComplete: boolean;
  targetProject: string;
  targetBranch: string;
  // Where the PR/MR's commits come from. Absent when the forge doesn't say,
  // such as for a deleted fork.
  sourceProject?: string;
  sourceBranch?: string;
  headSha?: string;
  updatedAt?: string;
  pipeline?: Pipeline;
  unresolvedThreads: number;
  // False when more thread pages exist than the adapter fetches.
  threadsComplete: boolean;
}

export interface GitLabMergeRequest extends Common {
  forge: 'gitlab';
  // Approvals from people; bot approvals such as Duo's don't count.
  hasApprovals: boolean;
  approvalRequirementsSatisfied: boolean | null;
  mergeStatus?: string;
  duoReviewState?: string;
}

export interface GitHubPullRequest extends Common {
  forge: 'github';
  // GitHub's review decision. It doesn't cover every branch protection rule.
  reviewDecision?: string;
  copilotReview?: CopilotReview;
}

export interface CopilotReview {
  requested: boolean;
  reviewID?: string;
  comments: number;
  dismissed?: boolean;
}

export type ReviewRequest = GitLabMergeRequest | GitHubPullRequest;

// A PR/MR identified by URL, independent of the checked-out branch.
export interface ReviewRef {
  forge: ForgeKind;
  host: string;
  project: string;
  iid: string;
}

export type Tone = 'muted' | 'success' | 'warning' | 'error';

// A footer segment. `compact` replaces the text when space runs short, and
// essential segments are the last to be dropped.
export interface Indicator {
  text: string;
  tone: Tone;
  url?: string;
  compact?: string;
  essential?: boolean;
}

// Everything that differs between forges, apart from API access: identity,
// host detection, URLs, vocabulary, and how the forge presents its own status
// fields. Traits are stateless, so code can use them with only a host, a URL,
// or a request. `open` creates the adapter that talks to the forge.
export interface ForgeTraits<
  Request extends ReviewRequest = ReviewRequest,
  Adapter extends Forge = Forge,
> {
  readonly kind: Request['forge'];
  // "MR" or "PR".
  readonly noun: string;
  // What the forge calls CI results, such as "pipeline".
  readonly ci: string;
  // Whether the forge serves a host that isn't configured, judging by its name.
  recognizes(host: string): boolean;
  // An adapter that runs the forge's CLI in `directory`.
  open(run: Exec, directory: string): Adapter;
  // Whether a request came from this forge.
  owns(request: ReviewRequest): request is Request;
  // The PR/MR a web URL names. Undefined for other URLs, such as issues.
  parseUrl(url: string): ReviewRef | undefined;
  // The issue a web URL names. Undefined for other URLs, such as PRs/MRs.
  parseIssueUrl(url: string): ReviewRef | undefined;
  // Writes a request number the way the forge does, such as `!45` or `#7`.
  reference(iid: string): string;
  // Writes an issue number the way the forge does, such as `#12`.
  issueReference(iid: string): string;
  // The request numbers in a session title's managed prefix, such as
  // `[#12, !45]`, in order. Some may name issues rather than PRs/MRs.
  titleReferences(title: string | undefined): string[];
  // Footer segments for forge-specific status, such as a requested change.
  indicators(request: Request): Indicator[];
  // Status dialog lines for forge-specific fields, such as approval rules.
  details(request: Request): string[];
  // Optional capabilities. Shared code checks for these, never for a forge.
  readonly automatedReview?: AutomatedReview<Request>;
  readonly feedback?: ReviewFeedback<Request>;
  readonly lifecycle?: LifecycleActions<Request>;
}

// Changes Forgekeeper makes on its own for lifecycle events, when the user's
// policy allows them. Each does one fixed thing.
export interface LifecycleActions<Request extends ReviewRequest = ReviewRequest> {
  // Makes the PR/MR target `branch` in its target project. Rejects with the
  // forge's reason when it refuses.
  retarget?(run: Exec, directory: string, request: Request, branch: string): Promise<void>;
}

// `running` reviews poll faster, and a review that goes from `running` to
// `feedback` left something for the agent to act on. Other final states, such
// as an approval, are `settled`.
export type AutomatedReviewState = 'running' | 'feedback' | 'settled';

export interface AutomatedReviewStatus {
  state: AutomatedReviewState;
  label: string;
  completed?: CompletedReview;
}

export interface CompletedReview {
  id: string;
  feedback: boolean;
  label: string;
}

// A forge's automated code reviewer, such as GitLab Duo or GitHub Copilot.
export interface AutomatedReview<Request extends ReviewRequest = ReviewRequest> {
  readonly publishedFeedback?: {
    storageKey: string;
    select(snapshot: FeedbackSnapshot): FeedbackSnapshot;
    ready(snapshot: FeedbackSnapshot, now: number): boolean;
  };
  readonly name: string;
  // The reviewer's review of a request, or undefined without one.
  status(request: Request): AutomatedReviewStatus | undefined;
}

// A comment on a PR/MR, as read by a forge's `feedback` capability. The forge
// leaves out entries that aren't comments, such as GitLab's system notes.
export interface ReviewComment {
  automated?: { reviewer: string; finding: boolean; runID?: string; status?: string };
  // Identifies the comment, for remembering which comments were announced.
  id: string;
  // Orders comments by when they were posted, across all comment types.
  order: number;
  url: string;
  // When the comment was last written, in milliseconds.
  editedAt: number;
  // Whether its thread is resolved. Comments outside threads are unresolved.
  resolved: boolean;
  bot: boolean;
  authorID: string;
  username: string;
}

export interface FeedbackSnapshot {
  // False when a page is missing or the viewer is unknown. A complete snapshot
  // covers every comment, or the newest comments the forge reads.
  complete: boolean;
  // The ID of the user that the forge's CLI is logged in as.
  viewerID?: string;
  comments: ReviewComment[];
}

// Reads a request's review comments, for announcing new human feedback.
export interface ReviewFeedback<Request extends ReviewRequest = ReviewRequest> {
  subscribe?(
    run: Exec,
    directory: string,
    request: Request,
    events: FeedbackEvents,
    signal: AbortSignal,
  ): Promise<void>;
  // Undefined when the request doesn't exist.
  fetch(run: Exec, directory: string, request: Request): Promise<FeedbackSnapshot | undefined>;
  // The text of the comments with these IDs, for summarizing feedback. Leaves
  // out comments it can't read. The text is written by reviewers, so callers
  // treat it as untrusted.
  details?(run: Exec, directory: string, request: Request, ids: string[]): Promise<CommentDetail[]>;
  // The comment ID a comment link names, for updates stored before they kept
  // their comment IDs. Undefined when the link doesn't name one.
  commentID?(url: string): string | undefined;
  // Links to other comments that these comments' own text names directly,
  // which a summary may read. Each is canonical, on the request's forge host,
  // and not one of the comments. Links in replies or code don't count.
  linkedNotes?(request: Request, details: readonly CommentDetail[]): string[];
  // Reads the comment a link from `linkedNotes` names. Undefined when it
  // can't be read, or when what the forge returns isn't that comment.
  linkedNote?(
    run: Exec,
    directory: string,
    request: Request,
    url: string,
  ): Promise<LinkedNote | undefined>;
}

// A comment that review feedback links to. Its text is untrusted.
export interface LinkedNote {
  url: string;
  username: string;
  body: string;
}

export interface CommentDetail {
  id: string;
  url: string;
  username: string;
  body: string;
  path?: string;
  line?: number;
  // The code the comment is on: numbered file lines around it, or the diff
  // hunk that ends at it. Written by the PR/MR's author, so also untrusted.
  code?: { path: string; text: string };
  // Earlier comments in the same thread, oldest first.
  replies?: Array<{ username: string; body: string }>;
}

export interface FeedbackEvents {
  connected: () => void;
  changed: () => void;
}

// A type guard for one forge's requests, for its traits' `owns`.
export const ownedBy =
  <Kind extends ForgeKind>(kind: Kind) =>
  (request: ReviewRequest): request is Extract<ReviewRequest, { forge: Kind }> =>
    request.forge === kind;

// The server prefixes titles with the session's references, such as
// `[#123, !456] Title`. Returns the prefix, or "" without one.
export const titlePrefix = (title: string | undefined) => title?.match(/^\[[^\]]*\]/)?.[0] ?? '';

// The numbers that follow `sigil` in a title's managed prefix, in order.
export function prefixReferences(title: string | undefined, sigil: string): string[] {
  return titlePrefix(title)
    .slice(1, -1)
    .split(/[\s,]+/)
    .flatMap((token) =>
      token.startsWith(sigil) && /^[1-9]\d*$/.test(token.slice(sigil.length))
        ? [token.slice(sigil.length)]
        : [],
    );
}

// Parses a forge's web URL whose path matches `pattern`, capturing the project
// path and the request number.
export function parseWebUrl(
  kind: ForgeKind,
  value: string,
  pattern: RegExp,
): ReviewRef | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return undefined;
  const match = url.pathname.match(pattern);
  if (!match) return undefined;
  return {
    forge: kind,
    host: url.hostname.toLowerCase(),
    project: decodeURIComponent(match[1]),
    iid: match[2],
  };
}

export const yesNo = (value: boolean) => (value ? 'yes' : 'no');
export const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

export type ErrorKind = 'auth' | 'rate-limit' | 'missing-glab' | 'missing-gh' | 'request';

export class ForgeError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface Forge {
  readonly traits: ForgeTraits;
  // Looks up one PR/MR by number and returns the match from the first project
  // that has it, so `origin` wins over other remotes.
  findByNumber(
    projects: readonly RemoteProject[],
    number: string,
  ): Promise<ReviewRequest | undefined>;
  // Open PRs/MRs from the repository's current branch, newest first.
  findByBranch(repository: Repository): Promise<ReviewRequest[]>;
  // The number of the newest open PR/MR from the repository's current branch.
  // Unlike `findByBranch`, it reads no status, so session titles stay cheap.
  findNumberByBranch(repository: Repository): Promise<string | undefined>;
  // The branch a PR/MR was opened from. Undefined when the PR/MR doesn't exist.
  sourceBranch(ref: ReviewRef): Promise<string | undefined>;
}
