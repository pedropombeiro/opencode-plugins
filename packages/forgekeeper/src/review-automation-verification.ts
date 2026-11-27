import type { Plugin } from '@opencode/plugin';
import { matchesApproval } from './approval-watch';
import { isApproval, type FeedbackItem, type InboxState } from './feedback-inbox';
import {
  approvalsComplete,
  approversOf,
  pipelineFails,
  unlistedFailure,
  type FeedbackSnapshot,
  type ReviewerApproval,
  type ReviewRef,
  type ReviewRequest,
} from './forge';
import { parseReference, parseUrl, requestNoun, traitsOf, type ForgeCatalog } from './forges';
import { isJobFailure } from './job-investigation';
import type { AutomationRule } from './options';
import {
  Ineligible,
  type ApprovalContext,
  type AutomationStatus,
  type PipelineFailures,
  type ReviewFinding,
  type VerifiedApproval,
} from './review-automation';
import type { createReviewClaims } from './review-claim';
import { commentIDsOf, feedbackTarget, type SummaryDependencies } from './summary-delivery';

export interface AutomationDependencies extends SummaryDependencies {
  forges: ForgeCatalog;
  reviewClaims?: ReturnType<typeof createReviewClaims>;
  // Resolves a reviewer's username to their account ID. Defaults to the forge's.
  reviewerID?: (ref: ReviewRef, username: string) => Promise<string | undefined>;
  // The signed-in account's ID on the PR/MR's host. Defaults to the forge's.
  viewerID?: (ref: ReviewRef) => Promise<string | undefined>;
}

export interface AutomationEnvironment {
  relay: (sessionID: string, title: string, report: string, resume: boolean) => Promise<void>;
  rules: readonly AutomationRule[];
  closing: () => boolean;
  inbox: {
    list: () => Promise<InboxState>;
    automation: (id: string, status: AutomationStatus) => Promise<unknown>;
  };
  deliverable: (item: FeedbackItem) => Promise<boolean>;
  readFeedback: (
    request: ReviewRequest,
    directory: string,
  ) => Promise<FeedbackSnapshot | undefined>;
  scan: (prefix: string) => Promise<{ key: string; value: unknown }[]>;
  missingSession: (error: unknown) => boolean;
  redeliver: (item: FeedbackItem) => void;
  report: (error: unknown) => void;
  // Shows a configuration problem, such as a rule author that can't be resolved.
  warn?: (message: string) => void;
  // Current watch policy for reviewer approvals, enforced on automatic, manual, retry, and execution paths.
  watchesApprover?: (url: string, approver: ReviewerApproval) => boolean;
  watchesApprovalItem?: (item: FeedbackItem) => boolean;
  // Called after an approval turn marks a PR/MR ready so status caches invalidate.
  markedReady?: (ref: ReviewRef) => void;
  // Called after linked sessions are archived so connected clients close their tabs.
  sessionsCleanedUp?: (sessionIDs: string[], options?: { archive?: boolean }) => void;
  // Aborts when the plugin stops, which ends waits and sleeps.
  signal: AbortSignal;
  // Replaces the timer-based sleep, for tests.
  sleep?: (ms: number) => Promise<void>;
}

// The reviewers by account ID. Rejects when one can't be verified, so no
// finding is attributed to an unverified name.
async function resolveReviewerIDs(
  resolve: (username: string) => Promise<string | undefined>,
  reviewers: readonly string[],
): Promise<Array<readonly [id: string, name: string]>> {
  return Promise.all(
    reviewers.map(async (name) => {
      const id = await resolve(name);
      if (!id) throw new Error(`Could not verify reviewer @${name}`);
      return [id, name] as const;
    }),
  );
}

// The batch's current, unresolved findings. With reviewers, only their
// accounts' comments count. Findings from `reviewers` or `tagged` name their
// reviewer. Each comment's details must name the same author and URL as the
// listing, or the read fails.
export async function readVerifiedFindings(
  ctx: Plugin.Context,
  deps: AutomationDependencies,
  env: Pick<AutomationEnvironment, 'readFeedback'>,
  item: FeedbackItem,
  reviewers: readonly string[] | undefined,
  tagged: readonly string[] = [],
): Promise<ReviewFinding[]> {
  const directory = ctx.location.directory;
  const target = feedbackTarget(item.url);
  const ref = parseUrl(item.url);
  if (!target || !ref) throw new Error('The review target is invalid');
  const capability = traitsOf(target).feedback;
  if (!capability?.fetch || !capability.details)
    throw new Error('This forge cannot read review findings');
  const snapshot = await env.readFeedback(target as ReviewRequest, directory);
  if (!snapshot?.complete)
    throw new Error('Current feedback is incomplete; no coding turn was started');
  const named = [...new Set([...(reviewers ?? []), ...tagged])];
  const resolved = named.length
    ? await resolveReviewerIDs(
        (name) =>
          deps.reviewerID
            ? deps.reviewerID(ref, name)
            : (capability.reviewerID?.(deps.exec, directory, ref.host, name) ??
              Promise.resolve(undefined)),
        named,
      )
    : [];
  const accounts = new Map(resolved);
  const allowed =
    reviewers && new Set(resolved.filter(([, name]) => reviewers.includes(name)).map(([id]) => id));
  const wanted = new Set(commentIDsOf(item));
  const comments = snapshot.comments.filter(
    (comment) =>
      wanted.has(comment.id) &&
      !comment.resolved &&
      (!allowed || allowed.has(comment.authorID)) &&
      (!comment.automated || comment.automated.finding) &&
      !(comment.reviewState === 'APPROVED' && !comment.bot),
  );
  const ids = comments.map((comment) => comment.id);
  const details = await (deps.details
    ? deps.details(target, ids)
    : capability.details(deps.exec, directory, target, ids));
  const approvedHumanIDs = new Set<string>();
  const verified = details.filter((detail) => {
    const comment = comments.find((entry) => entry.id === detail.id);
    if (!comment || detail.authorID !== comment.authorID || detail.url !== comment.url)
      return false;
    if (detail.reviewState === 'APPROVED' && !detail.bot) {
      approvedHumanIDs.add(detail.id);
      return false;
    }
    return true;
  });
  if (verified.length + approvedHumanIDs.size !== comments.length)
    throw new Error('Some review findings could not be verified; retry after a complete fetch');
  return verified.map((detail) => {
    const reviewer = detail.authorID && accounts.get(detail.authorID);
    return reviewer ? { ...detail, reviewer } : detail;
  });
}

export async function readVerifiedApprovals(
  ctx: Plugin.Context,
  deps: AutomationDependencies,
  item: FeedbackItem,
  reviewers: readonly string[] | undefined,
  tagged: readonly string[] = [],
  watchesApprover?: (url: string, approver: ReviewerApproval) => boolean,
): Promise<ApprovalContext> {
  if (item.approverKind === 'human')
    throw new Ineligible('Human reviewer approvals cannot start a turn with tools.');
  const directory = ctx.location.directory;
  const target = feedbackTarget(item.url);
  const ref = parseUrl(item.url);
  if (!target || !ref) throw new Error('The review target is invalid');
  const request = await currentRequest(deps, directory, item.url);
  if (!request || request.state !== 'opened')
    throw new Ineligible(`The ${requestNoun(ref.forge)} is no longer open`);
  if (!approvalsComplete(request))
    throw new Error('Current approvals are incomplete; no follow-up turn was started');
  const capability = traitsOf(target).feedback;
  const matching = approversOf(request).filter((approver) => {
    if (item.approverID && approver.id !== item.approverID) return false;
    return matchesApproval(item, approver);
  });
  const nonHuman = matching.filter(
    (approver) => approver.automated === true || approver.bot === true,
  );
  if (matching.length > 0 && nonHuman.length === 0)
    throw new Ineligible('Human reviewer approvals cannot start a turn with tools.');
  const watched = watchesApprover
    ? nonHuman.filter((approver) => watchesApprover(request.url, approver))
    : nonHuman;
  if (!watched.length) return { request, approvers: [] };
  const named = [...new Set([...(reviewers ?? []), ...tagged])];
  const resolved = named.length
    ? await resolveReviewerIDs(
        (name) =>
          deps.reviewerID
            ? deps.reviewerID(ref, name)
            : (capability?.reviewerID?.(deps.exec, directory, ref.host, name) ??
              Promise.resolve(undefined)),
        named,
      )
    : [];
  const accounts = new Map(resolved);
  const allowed =
    reviewers && new Set(resolved.filter(([, name]) => reviewers.includes(name)).map(([id]) => id));
  const verified = watched
    .filter((approver) => !allowed || (!!approver.id && allowed.has(approver.id)))
    .map((approver): VerifiedApproval => {
      const reviewer = approver.id ? accounts.get(approver.id) : undefined;
      return reviewer ? { ...approver, reviewer } : approver;
    });
  return { request, approvers: verified };
}

// The PR/MR as the forge reports it now, or undefined when it can't be found.
export async function currentRequest(
  deps: AutomationDependencies,
  directory: string,
  url: string,
): Promise<ReviewRequest | undefined> {
  const ref = parseUrl(url);
  const forge = ref && deps.forges.forHost(ref.host, directory);
  return forge && ref
    ? forge.findByNumber([{ host: ref.host, path: ref.project }], ref.iid)
    : undefined;
}

// Why the update's pipeline can't be investigated anymore, or undefined
// while it's the PR/MR's head pipeline. Either forge ties that pipeline to the
// head commit: GitLab's head pipeline is the head commit's, even when it tests
// a merge commit, such as a merged results pipeline, and GitHub's checks run
// on the head commit itself.
function pipelineMismatch(request: ReviewRequest, item: FeedbackItem): string | undefined {
  if (!request.pipeline?.id || request.pipeline.id !== item.pipeline)
    return `A newer ${traitsOf(request).ci} replaced the failing one, so the failure may already be fixed.`;
  if (!request.headSha)
    return `The forge didn't report the ${traitsOf(request).noun}'s head commit.`;
}

function authorIneligibleMessage(noun: string, jobs: boolean, approval: boolean): string {
  if (jobs) {
    return `You neither wrote nor review this ${noun}, and no automation rule lists its author, so automatic investigation is skipped. Use Act on feedback to investigate anyway.`;
  }
  if (approval) {
    return `You did not write this ${noun}, and no automation rule lists its author, so approval follow-up is not authorized.`;
  }
  return `You did not write this ${noun}, and no automation rule lists its author, so automatic action is skipped. Use Act on feedback to act anyway.`;
}

// Resolves a rule author's username to their account ID, or undefined when
// it can't be resolved.
export type AuthorResolver = (
  ref: ReviewRef,
  request: ReviewRequest,
  username: string,
) => Promise<string | undefined>;

export function createAuthorResolver(
  deps: AutomationDependencies,
  directory: string,
  warn?: (message: string) => void,
): AuthorResolver {
  const unresolved = new Set<string>();
  return async (ref, request, username) => {
    let reason = 'the forge has no such account';
    try {
      const id = await (deps.reviewerID
        ? deps.reviewerID(ref, username)
        : traitsOf(request).feedback?.reviewerID?.(deps.exec, directory, ref.host, username));
      if (id) return id;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    const key = `${ref.host}/${username}`;
    if (!unresolved.has(key)) {
      unresolved.add(key);
      warn?.(`Forgekeeper ignores automation author @${username} on ${ref.host}: ${reason}`);
    }
    return undefined;
  };
}

// The rules that cover the PR/MR's author. The signed-in user's own PR/MR, or
// for failed jobs, one they review, is covered by every rule. Anyone else's
// is covered only by the matching rules whose `authors` list its author, so
// for review feedback only those rules' reviewers count. Rejects when no
// rule covers it.
async function authorRules(
  deps: AutomationDependencies,
  directory: string,
  rules: readonly AutomationRule[],
  resolveAuthor: AuthorResolver,
  ref: ReviewRef,
  request: ReviewRequest,
  jobs: boolean,
  approval = false,
): Promise<readonly AutomationRule[]> {
  const viewer = await (deps.viewerID
    ? deps.viewerID(ref)
    : traitsOf(request).feedback?.viewerID?.(deps.exec, directory, ref.host));
  if (!viewer) throw new Error('Could not read the signed-in account');
  if (request.authorID === viewer || (jobs && request.reviewerIDs?.includes(viewer))) return rules;
  const on = jobs ? 'job-failed' : 'review';
  const matching = (rule: AutomationRule) =>
    rule.on === on && rule.host === ref.host && rule.projects.includes(ref.project);
  const listed = [...new Set(rules.filter(matching).flatMap((rule) => rule.authors ?? []))];
  const authorID = request.authorID;
  const matched = new Set(
    authorID
      ? (
          await Promise.all(
            listed.map(async (name) =>
              (await resolveAuthor(ref, request, name)) === authorID ? [name] : [],
            ),
          )
        ).flat()
      : [],
  );
  if (!matched.size)
    throw new Ineligible(authorIneligibleMessage(traitsOf(request).noun, jobs, approval));
  return rules.filter(
    (rule) => !matching(rule) || !!rule.authors?.some((name) => matched.has(name)),
  );
}

// What applies to an update now: the PR/MR as the forge reports it, and the
// rules that apply to its author.
export interface Policy {
  ref: ReviewRef;
  request: ReviewRequest;
  rules: readonly AutomationRule[];
}

// Checks that the PR/MR is open, reports its source, and, for failed jobs,
// that the update's pipeline is still the head commit's. Automatic runs and
// approval follow-ups need a rule that covers the PR/MR's author; see
// `authorRules`. Other manual runs are under all the rules.
export async function resolvePolicy(
  deps: AutomationDependencies,
  directory: string,
  rules: readonly AutomationRule[],
  resolveAuthor: AuthorResolver,
  item: FeedbackItem,
  automatic: boolean,
): Promise<Policy> {
  const ref = parseUrl(item.url);
  const request = ref && (await currentRequest(deps, directory, item.url));
  if (!ref || !request || request.state !== 'opened')
    throw new Ineligible(`The ${requestNoun(ref?.forge)} is no longer open`);
  const jobs = isJobFailure(item);
  const approval = isApproval(item);
  const applicable =
    automatic || approval
      ? await authorRules(deps, directory, rules, resolveAuthor, ref, request, jobs, approval)
      : rules;
  if (jobs) {
    const mismatch = pipelineMismatch(request, item);
    if (mismatch) throw new Ineligible(mismatch);
  }
  if (!approval && (!request.sourceProject || !request.sourceBranch))
    throw new Ineligible(
      `The checkout does not match the ${traitsOf(request).noun} source project and branch`,
    );
  return { ref, request, rules: applicable };
}

// Why the checkout isn't the PR/MR's source branch at its head commit, or
// undefined when it is.
export async function checkoutMismatch(
  deps: AutomationDependencies,
  directory: string,
  { ref, request }: Policy,
  jobs: boolean,
): Promise<string | undefined> {
  const noun = traitsOf(request).noun;
  const checkout = await deps.forges.repository(directory);
  if (
    checkout.kind !== 'repository' ||
    checkout.repository.source.host !== ref.host ||
    checkout.repository.source.path !== request.sourceProject ||
    checkout.repository.sourceBranch !== request.sourceBranch
  )
    return `The checkout does not match the ${noun} source project and branch`;
  if (request.headSha && checkout.repository.head !== request.headSha)
    return jobs
      ? `The checkout isn't at the head commit that the failing ${traitsOf(request).ci} tested, so the failure may already be fixed. To investigate anyway, check out ${request.headSha.slice(0, 12)}, then use Retry feedback work.`
      : `The checkout does not match the ${noun} source project and branch`;
  return undefined;
}

// The failed jobs of the update's pipeline, while it's still the PR/MR's
// head pipeline and fails.
export async function readFailures(
  deps: AutomationDependencies,
  directory: string,
  item: FeedbackItem,
): Promise<PipelineFailures> {
  const request = await currentRequest(deps, directory, item.url);
  if (!request || request.state !== 'opened')
    throw new Ineligible(
      `The ${requestNoun(parseReference(item.url)?.ref.forge)} is no longer open`,
    );
  const mismatch = pipelineMismatch(request, item);
  if (mismatch) throw new Ineligible(mismatch);
  const pipeline = request.pipeline!;
  const unlisted = unlistedFailure(pipeline);
  if (!pipelineFails(pipeline))
    throw new Ineligible(`The ${traitsOf(request).ci} no longer has failed jobs.`);
  return {
    pipeline: { id: pipeline.id!, ...(pipeline.url ? { url: pipeline.url } : {}) },
    jobs: pipeline.failedJobs ?? [],
    unlisted,
    complete: pipeline.failedJobsComplete !== false,
  };
}
