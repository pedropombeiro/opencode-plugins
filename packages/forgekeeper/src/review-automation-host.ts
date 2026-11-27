// Connects review automation to OpenCode and the forges: who owns a PR/MR,
// which findings are verified, whether the checkout matches, and how a
// coding turn ended.
import type { Plugin } from '@opencode/plugin';
import { matchesApproval } from './approval-watch';
import { isApproval, type FeedbackItem, type InboxState } from './feedback-inbox';
import {
  approvalsComplete,
  approversOf,
  pipelineFails,
  pipelineRunning,
  unlistedFailure,
  type FeedbackSnapshot,
  type ReviewerApproval,
  type ReviewRef,
  type ReviewRequest,
} from './forge';
import { parseReference, parseUrl, requestNoun, traitsOf, type ForgeCatalog } from './forges';
import {
  INVESTIGATION_INSTRUCTIONS,
  INVESTIGATION_QUIET_TIME,
  investigatesJobs,
  investigationModels,
  isJobFailure,
  sameUpdate,
} from './job-investigation';
import type { AutomationRule } from './options';
import {
  allowedModelsFor,
  automationReviewers,
  Ineligible,
  matchesApprovalRule,
  modelKey,
  modelRefusal,
  RECHECK_INTERVAL,
  restrictedReviewers,
  environmentExecution,
  type ApprovalContext,
  type ReviewFinding,
  type AutomationHost,
  type AutomationRecord,
  type AutomationStatus,
  type ExecutionOutcome,
  type PipelineFailures,
  type Placement,
  type Validation,
  type VerifiedApproval,
  type LinkedRecord,
} from './review-automation';
import { createReviewClaims, type ExecutionClaim } from './review-claim';
import {
  APPROVAL_INSTRUCTIONS,
  APPROVAL_STATUS_TOOL,
  approvalDigest,
  approvalStatusData,
  findingsDigest,
  MARK_READY_TOOL,
  PREPARATION_INSTRUCTIONS,
  preparationBatch,
  readinessDigest,
} from './review-preparation';
import { isForgekeeperInput, turnInput } from './review-summary';
import {
  freshPresence,
  linkedOwner,
  placeholderMessageID,
  presenceKey,
  type DirectorySession,
} from './linked-session';
import { environmentProvider, type StartContext } from './automation-environment';
import { createLocalEnvironment, localRunnerOf as runnerOf } from './local-automation-environment';
import { commentIDsOf, feedbackTarget, type SummaryDependencies } from './summary-delivery';
import { includesRequest, type Target } from './target';

export interface AutomationDependencies extends SummaryDependencies {
  forges: ForgeCatalog;
  reviewClaims?: ReturnType<typeof createReviewClaims>;
  // Resolves a reviewer's username to their account ID. Defaults to the forge's.
  reviewerID?: (ref: ReviewRef, username: string) => Promise<string | undefined>;
  // The signed-in account's ID on the PR/MR's host. Defaults to the forge's.
  viewerID?: (ref: ReviewRef) => Promise<string | undefined>;
}

interface AutomationEnvironment {
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

type Context = Plugin.Context;

type ModelRef = { providerID: string; id: string; variant?: string };

export const LINKED_INSTRUCTIONS = [
  'This turn runs in a background linked session for another session, without interactive user prompts.',
  'Do not ask the user questions directly or rely on commands that require interactive permission approval.',
  'Report any design decisions, ambiguities, or commands needing user approval in your final response so the owning session can surface them to the user.',
].join('\n');

type SessionInfo = Awaited<ReturnType<Context['session']['get']>>;

// The owning session's agent, and its permissions as they apply in the
// owning checkout: its agent's rules there, then its own. A session's rules
// apply after its agent's, and the last matching rule wins, so in a linked
// session they apply as in the owner, even where the worktree configures the
// agent otherwise. Without an agent of the owner's own, which agent's rules
// apply can't be read for certain, so it rejects.
export async function ownerPolicy(ctx: Context, owner: SessionInfo) {
  if (!owner.agent)
    throw new Ineligible(
      "The owning session has no agent of its own, so Forgekeeper can't give the linked session its permissions. Pick an agent in the owning session, then use Retry feedback work.",
    );
  const agent = await ctx.agent.get({
    agentID: owner.agent,
    location: { directory: owner.location.directory },
  });
  return {
    agent: owner.agent,
    permissions: [...agent.data.permissions, ...(owner.permissions ?? [])],
  };
}

// The argument as a POSIX shell reads it literally.
export const shellQuote = (argument: string) => `'${argument.replaceAll("'", `'\\''`)}'`;

// How to publish commits made in a worktree with a detached HEAD: a push to
// the source branch, quoted for the shell, since a branch name can hold
// characters such as `;` and `$`, in a code block fenced longer than any
// run of backticks in it.
export function pushNotice(sourceBranch: string, remote: string | undefined) {
  const command = `git push ${remote ? shellQuote(remote) : '<remote>'} ${shellQuote(`HEAD:refs/heads/${sourceBranch}`)}`;
  const fence = '`'.repeat(
    Math.max(3, ...(command.match(/`+/g) ?? []).map((run) => run.length + 1)),
  );
  return [
    `The worktree has a detached HEAD. To publish commits made there, run this in it${remote ? '' : ", with the source project's remote for <remote>"}:`,
    `${fence}sh\n${command}\n${fence}`,
  ].join('\n\n');
}

export interface MarkReadyInvocation {
  sessionID: string;
  agent?: string;
  messageID?: string;
  callID?: string;
  signal?: AbortSignal;
}

interface ResolvedPreparation {
  record: AutomationRecord;
  compacted: boolean;
  messages: Awaited<ReturnType<Context['session']['context']>>;
  promptIndex: number;
}

const boundAtOf = (record: AutomationRecord) => record.submittedAt ?? record.startedAt;

async function resolvePreparation(
  ctx: Context,
  claims: ReturnType<typeof createReviewClaims>,
  sessionID: string,
): Promise<ResolvedPreparation | undefined> {
  const messages = await ctx.session.context({ sessionID });
  const input = turnInput(messages);
  const batch = input && preparationBatch(input.id);
  if (batch) {
    const record = await claims.records.read(batch);
    if (!record || record.messageID !== input.id || runnerOf(record) !== sessionID)
      throw new Error('Review automation execution instructions are unavailable');
    const promptIndex = messages.findLastIndex((message) => message.id === input.id);
    return { record, compacted: false, messages, promptIndex };
  }
  if (input || !messages.some((message) => message.type === 'compaction')) return undefined;
  const active = (await claims.records.list()).filter((record) => {
    if (runnerOf(record) !== sessionID) return false;
    if (record.ended) return false;
    const boundAt = boundAtOf(record);
    if (boundAt === undefined) return false;
    const eligibleState =
      record.state === 'running' || (record.state === 'failed' && record.startedAt !== undefined);
    if (!eligibleState) return false;
    return messages.some(
      (message) => message.type === 'compaction' && message.time.created >= boundAt,
    );
  });
  if (!active.length) return undefined;
  const idle = (await ctx.session.get({ sessionID })).time.idle;
  const candidates = active.filter((record) => idle === undefined || idle < boundAtOf(record)!);
  if (candidates.length > 1)
    throw new Error('Review preparation ownership is uncertain after compaction');
  const record = candidates[0];
  return record ? { record, compacted: true, messages, promptIndex: -1 } : undefined;
}

// The stored attempt whose prompt started the session's current turn. When a
// compaction removed that prompt (including before the first model request),
// an attempt counts only if its prompt was already submitted or started after
// the session was last idle and the attempt has not ended.
export async function storedPreparation(
  ctx: Context,
  claims: ReturnType<typeof createReviewClaims>,
  sessionID: string,
): Promise<AutomationRecord | undefined> {
  return (await resolvePreparation(ctx, claims, sessionID))?.record;
}

const sameStatus = (a: AutomationStatus | undefined, b: AutomationStatus) =>
  a?.state === b.state && a.at === b.at && a.messageID === b.messageID && a.reason === b.reason;

// Every non-archived root session whose stored targets include the PR/MR, in
// any checkout. Linked sessions run turns for their owner, so they never
// count. Rejects when a session can't be read, since it might count.
export async function findAssociatedRootSessions(
  ctx: Context,
  env: Pick<AutomationEnvironment, 'scan' | 'missingSession'>,
  url: string,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const { key, value } of await env.scan('sessions/')) {
    if (!includesRequest((value as { targets?: Target[] }).targets ?? [], url)) continue;
    const sessionID = key.slice('sessions/'.length);
    let session;
    try {
      session = await ctx.session.get({ sessionID });
    } catch (error) {
      if (env.missingSession(error)) continue;
      throw error;
    }
    if (
      !session.parentID &&
      session.time.archived === undefined &&
      !linkedOwner(session as DirectorySession)
    )
      ids.add(sessionID);
  }
  return [...ids];
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
  ctx: Context,
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
  ctx: Context,
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
async function currentRequest(
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

// Resolves a rule author's username to their account ID, or undefined when
function authorIneligibleMessage(noun: string, jobs: boolean, approval: boolean): string {
  if (jobs) {
    return `You neither wrote nor review this ${noun}, and no automation rule lists its author, so automatic investigation is skipped. Use Act on feedback to investigate anyway.`;
  }
  if (approval) {
    return `You did not write this ${noun}, and no automation rule lists its author, so approval follow-up is not authorized.`;
  }
  return `You did not write this ${noun}, and no automation rule lists its author, so automatic action is skipped. Use Act on feedback to act anyway.`;
}
// it can't be resolved.
type AuthorResolver = (
  ref: ReviewRef,
  request: ReviewRequest,
  username: string,
) => Promise<string | undefined>;

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
interface Policy {
  ref: ReviewRef;
  request: ReviewRequest;
  rules: readonly AutomationRule[];
}

// Checks that the PR/MR is open, reports its source, and, for failed jobs,
// that the update's pipeline is still the head commit's. Automatic runs and
// approval follow-ups need a rule that covers the PR/MR's author; see
// `authorRules`. Other manual runs are under all the rules.
async function resolvePolicy(
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
async function checkoutMismatch(
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
async function readFailures(
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

// How the turn that the claim's prompt started ended. While the prompt is in
// the transcript, the transcript says. Once a compaction removed it, a later
// turn's end can look the same, so only the end recorded as it happened, in
// the attempt's `ended`, says how the turn went.
export async function transcriptOutcome(
  ctx: Context,
  claim: ExecutionClaim,
  record?: AutomationRecord,
): Promise<ExecutionOutcome> {
  const attempt = record?.messageID === claim.messageID ? record : undefined;
  // A linked session runs the turn for the owning session, which holds the claim.
  const sessionID = attempt ? runnerOf(attempt) : claim.sessionID;
  if (!sessionID) throw new Error('The execution has no local session');
  const messages = await ctx.session.context({ sessionID });
  // Input during the attempt's turn makes its outcome uncertain, but while
  // the session hasn't been idle since that input, the turn is still going.
  const steered = async (input: { time: { created: number } }): Promise<ExecutionOutcome> => {
    const idle = (await ctx.session.get({ sessionID })).time.idle;
    return idle === undefined || idle < input.time.created ? 'running' : 'unknown';
  };
  const index = messages.findIndex((message) => message.id === claim.messageID);
  if (index >= 0) {
    for (const message of messages.slice(index + 1)) {
      if (message.type === 'user' || isForgekeeperInput(message)) return steered(message);
      if (message.type === 'idle') return message.outcome === 'succeeded' ? 'completed' : 'failed';
    }
    const session = await ctx.session.get({ sessionID });
    if (
      session.time.idle !== undefined &&
      session.time.idle >= messages[index].time.created &&
      session.outcome
    )
      return session.outcome === 'succeeded' ? 'completed' : 'failed';
    return 'running';
  }
  const startedAt = attempt?.startedAt;
  if (startedAt === undefined) return 'pending';
  // Input during the attempt's turn makes it uncertain. Input after its
  // recorded end starts a later turn.
  const ended = attempt!.ended;
  const input = messages.find(
    (message) =>
      (message.type === 'user' || isForgekeeperInput(message)) &&
      message.time.created >= startedAt &&
      !(ended && message.time.created > ended.at),
  );
  if (input) return ended ? 'unknown' : steered(input);
  if (ended) return ended.outcome === 'succeeded' ? 'completed' : 'failed';
  const session = await ctx.session.get({ sessionID });
  // Not idle since the attempt started, so its turn is still going.
  if (session.time.idle === undefined || session.time.idle < startedAt) return 'running';
  // The turn ended, but its end isn't recorded yet, or was missed.
  return 'pending';
}

export function createAutomationHost(
  ctx: Context,
  deps: AutomationDependencies,
  env: AutomationEnvironment,
) {
  const directory = ctx.location.directory;
  const now = deps.now ?? Date.now;

  const claims = deps.reviewClaims ?? createReviewClaims();
  const read = claims.records.read;
  const save = async (record: AutomationRecord, expected?: AutomationRecord) => {
    if (env.closing()) throw new Error('The plugin stopped');
    return claims.records.save(record, expected);
  };
  const associations = (url: string) => findAssociatedRootSessions(ctx, env, url);
  const exists = async (sessionID: string) => {
    try {
      await ctx.session.get({ sessionID });
      return true;
    } catch (error) {
      if (env.missingSession(error)) return false;
      throw error;
    }
  };
  const findings = (
    item: FeedbackItem,
    reviewers: readonly string[] | undefined,
    tagged?: readonly string[],
  ) => readVerifiedFindings(ctx, deps, env, item, reviewers, tagged);
  const approvals = (
    item: FeedbackItem,
    reviewers: readonly string[] | undefined,
    tagged?: readonly string[],
  ) => readVerifiedApprovals(ctx, deps, item, reviewers, tagged, env.watchesApprover);
  // The session's own model, or else its agent's, or else the default.
  const modelOf = async (session: {
    model?: ModelRef;
    agent?: string;
  }): Promise<ModelRef | undefined> => {
    if (session.model) return session.model;
    const agent = session.agent
      ? (await ctx.agent.get({ agentID: session.agent })).data.model
      : undefined;
    return agent ?? (await ctx.model.default()).data ?? undefined;
  };
  const model = async (sessionID: string) => {
    const found = await modelOf(await ctx.session.get({ sessionID }));
    return found ? modelKey(found) : undefined;
  };

  // A rule author that can't be resolved is ignored, so it never widens a
  // rule, and reported once per run.
  const unresolved = new Set<string>();
  const resolveAuthor: AuthorResolver = async (ref, request, username) => {
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
      env.warn?.(`Forgekeeper ignores automation author @${username} on ${ref.host}: ${reason}`);
    }
    return undefined;
  };

  // Checks that the owning session may run the batch under `configured`,
  // and where: in its checkout when that's at the PR/MR's head commit, or
  // in a worktree when only the checkout doesn't match and the rules allow it.
  async function validateWith(
    item: FeedbackItem,
    automatic: boolean,
    configured: readonly AutomationRule[],
  ): Promise<Validation> {
    if (!(await env.deliverable(item)))
      throw new Ineligible(
        `The session no longer targets this ${requestNoun(parseReference(item.url)?.ref.forge)} here`,
      );
    const session = await ctx.session.get({ sessionID: item.sessionID });
    if (session.parentID) throw new Ineligible('Subagents cannot own review automation');
    const policy = await resolvePolicy(deps, directory, configured, resolveAuthor, item, automatic);
    const { rules } = policy;
    const mismatch = isApproval(item)
      ? undefined
      : await checkoutMismatch(deps, directory, policy, isJobFailure(item));
    let placement: Placement = 'session';
    if (mismatch) {
      if (!environmentExecution(rules, policy.ref, item)) throw new Ineligible(mismatch);
      placement = 'environment';
    }
    // An investigation changes nothing, so a read-only agent may run it.
    if (session.agent === 'plan' && !isJobFailure(item))
      throw new Ineligible('Switch the owning session to a coding agent before acting on feedback');
    return { placement, rules };
  }
  const validate = (item: FeedbackItem, automatic: boolean) =>
    validateWith(item, automatic, env.rules);

  // The owning session's checks, for the instance of the worktree that runs
  // its linked session: the update is still in the owner's inbox, monitoring
  // there isn't paused, and the owner still targets the PR/MR there.
  async function assertOwnerPending(item: FeedbackItem, ownerDirectory: string) {
    const canceled = () => new Error('Review automation was canceled before the coding turn');
    const state = (await ctx.storage.get(
      `feedback-inbox/${encodeURIComponent(ownerDirectory)}`,
    )) as InboxState | undefined;
    if (
      env.closing() ||
      !state ||
      state.paused ||
      !state.items.some((entry) => sameUpdate(entry, item))
    )
      throw canceled();
    let owner;
    try {
      owner = await ctx.session.get({ sessionID: item.sessionID });
    } catch (error) {
      if (env.missingSession(error)) throw canceled();
      throw error;
    }
    if (owner.time.archived !== undefined || owner.location.directory !== ownerDirectory)
      throw canceled();
    const stored = (await ctx.storage.get(`sessions/${item.sessionID}`)) as
      { targets?: Target[] } | undefined;
    if (!includesRequest(stored?.targets ?? [], item.url)) throw canceled();
  }

  const local = createLocalEnvironment({
    ctx,
    deps: { exec: deps.exec, claims, repository: (path) => deps.forges.repository(path), now },
    signal: env.signal,
    closing: env.closing,
    request: (url) => currentRequest(deps, directory, url),
    policy: async (owner) => ({ ...(await ownerPolicy(ctx, owner)), model: await modelOf(owner) }),
    exists,
    outcome: (record) =>
      transcriptOutcome(
        ctx,
        {
          sessionID: record.item.sessionID,
          batch: record.batch,
          messageID: record.messageID!,
        },
        record,
      ),
    startContext: linkedStartContext,
    pushNotice,
  });
  const environments = { default: local.id, providers: [local] };
  // What the first-request checks read from where the turn runs. In the
  // owning session, they're this instance's. For a linked session, they're
  // the owning instance's current rules and checks, so the turn never runs
  // under the worktree's own configuration.
  function startContext(record: AutomationRecord): StartContext {
    const execution = record.execution;
    if (!execution)
      return {
        pending: assertPending,
        rules: async () => env.rules,
        async check(item, automatic, configured) {
          const { placement, rules } = await validateWith(item, automatic, configured);
          if (placement !== 'session')
            throw new Ineligible(
              `The checkout does not match the ${requestNoun(parseReference(item.url)?.ref.forge)} source project and branch`,
            );
          return rules;
        },
        admit: async () => {},
      };
    if (execution.stage !== 'submitting') throw new Error('Review automation is no longer running');
    return environmentProvider(environments, record).startContext(record as LinkedRecord);
  }

  function linkedStartContext(record: LinkedRecord): Omit<StartContext, 'admit'> {
    const execution = record.execution;
    if (
      !execution.ownerDirectory ||
      !execution.head ||
      !execution.sourceBranch ||
      !execution.sourceProject
    )
      throw new Error('The local execution source is unavailable');
    const ownerDirectory = execution.ownerDirectory;
    return {
      pending: (item) => assertOwnerPending(item, ownerDirectory),
      async rules() {
        const owner = freshPresence(await ctx.storage.get(presenceKey(ownerDirectory)), now());
        if (!owner)
          throw new Error(
            `Forgekeeper isn't running in ${execution.ownerDirectory}, which owns this turn, so its rules couldn't be checked.`,
          );
        return owner.rules;
      },
      async check(item, automatic, configured) {
        const { ref, request, rules } = await resolvePolicy(
          deps,
          directory,
          configured,
          resolveAuthor,
          item,
          automatic,
        );
        if (!environmentExecution(rules, ref, item))
          throw new Error('The automation rules no longer let this turn run in an environment');
        if (request.headSha !== execution.head)
          throw new Error(
            `The ${traitsOf(request).noun} has a newer head commit than the worktree. Retry feedback work.`,
          );
        return rules;
      },
    };
  }

  function linkedNotifyDescription(
    phase: 'started' | 'ended',
    job: boolean,
    label: string,
    state: string,
  ): string {
    if (phase === 'started') {
      const action = job ? 'investigating failed jobs for' : 'preparing review fixes for';
      return `Forgekeeper: ${action} ${label}`;
    }
    const kind = job ? 'failed-job investigation' : 'review preparation';
    return `Forgekeeper: ${kind} ${state} for ${label}`;
  }

  function linkedNotifyLines(
    phase: 'started' | 'ended',
    url: string,
    task: string,
    state: string,
    reason: string | undefined,
    details: readonly string[],
  ): string[] {
    if (phase === 'started') {
      const noun = requestNoun(parseReference(url)?.ref.forge);
      return [
        `Forgekeeper is ${task} ${url} in a linked session, because this checkout isn't at the ${noun}'s head commit.`,
        ...details,
      ];
    }
    const suffix = reason ? ` ${reason}` : '';
    return [`Forgekeeper's linked session for ${url} ended: ${state}.${suffix}`, ...details];
  }
  async function notify(record: AutomationRecord, phase: 'started' | 'ended') {
    if (!record.execution) return;
    const provider = environmentProvider(environments, record);
    const owner = await ctx.session
      .get({ sessionID: record.item.sessionID })
      .catch(() => undefined);
    if (owner && owner.time?.archived === undefined) {
      const details = await provider.describe(record, phase).catch(() => []);
      const job = isJobFailure(record.item);
      const ref = parseUrl(record.item.url);
      const label = ref ? traitsOf(ref).reference(ref.iid) : record.item.url;
      const task = job ? 'investigating the failed jobs of' : 'preparing fixes for';
      const lines = linkedNotifyLines(
        phase,
        record.item.url,
        task,
        record.state,
        record.reason,
        details,
      );
      const description = linkedNotifyDescription(phase, job, label, record.state);
      await env.relay(record.item.sessionID, description, lines.join('\n\n'), true);
    }
    if (phase === 'ended' && record.state === 'completed' && provider.archive) {
      const archived = await provider.archive(record).catch(() => undefined);
      if (typeof archived === 'string') {
        env.sessionsCleanedUp?.([archived]);
      } else if (archived) {
        env.sessionsCleanedUp?.(
          [archived.sessionID],
          archived.needsClientArchive ? { archive: true } : undefined,
        );
      }
    }
  }

  async function assertPending(item: FeedbackItem) {
    const state = await env.inbox.list();
    if (
      env.closing() ||
      state.paused ||
      !state.items.some((entry) => sameUpdate(entry, item)) ||
      !(await env.deliverable(item))
    )
      throw new Error('Review automation was canceled before the coding turn');
  }

  async function assertSoleOwner(item: FeedbackItem) {
    const sessions = await associations(item.url);
    if (sessions.length !== 1 || sessions[0] !== item.sessionID)
      throw new Error('Review automation ownership changed before the coding turn');
  }

  async function pipelineDone(item: FeedbackItem) {
    const request = await currentRequest(deps, directory, item.url);
    return (
      !request ||
      request.state !== 'opened' ||
      request.pipeline?.id !== item.pipeline ||
      !pipelineRunning(request.pipeline)
    );
  }

  // The attempt with its turn started now, under `models`.
  const startedRecord = (record: AutomationRecord, models: string[] | undefined) => {
    const started: AutomationRecord = { ...record, startedAt: now() };
    if (models) started.models = models;
    else delete started.models;
    return started;
  };

  const sleep =
    env.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        if (env.signal.aborted) return resolve();
        const finish = () => {
          clearTimeout(timer);
          env.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        env.signal.addEventListener('abort', finish, { once: true });
      }));

  const host: AutomationHost = {
    environments,
    rules: env.rules,
    ref: parseUrl,
    read,
    list: claims.records.list,
    save,
    start: async (record, expected) => {
      if (env.closing()) throw new Error('The plugin stopped');
      return claims.records.start(record, expected);
    },
    finish: async (record, expected) => {
      if (env.closing()) throw new Error('The plugin stopped');
      return claims.records.finish(record, expected);
    },
    async status(item, record) {
      const status: AutomationStatus = {
        state: record.state,
        at: record.at,
        attempt: record.attempt,
        ...(record.reason ? { reason: record.reason } : {}),
        ...(record.messageID ? { messageID: record.messageID } : {}),
        ...(record.manual ? { manual: record.manual } : {}),
      };
      // A failed-job batch's status goes to the update that replaced its own.
      const current = (await env.inbox.list()).items.find((entry) => sameUpdate(entry, item));
      if (!current || sameStatus(current.automation, status)) return;
      await env.inbox.automation(current.id, status);
    },
    inbox: env.inbox.list,
    associations,
    exists,
    findings,
    approvals,
    watchesApproval: env.watchesApprovalItem,
    failures: (item) => readFailures(deps, directory, item),
    pipelineDone,
    model,
    validate,
    redeliver: env.redeliver,
    wait: (sessionID) => ctx.session.wait({ sessionID }, { signal: env.signal }),
    sleep,
    claim: claims,
    notify,
    async submit(record, text) {
      await ctx.session.prompt({
        sessionID: record.item.sessionID,
        id: record.messageID,
        text,
        metadata: {
          forgekeeper: isJobFailure(record.item)
            ? 'job-investigate'
            : isApproval(record.item)
              ? 'review-approval'
              : 'review-prepare',
          batch: record.batch,
        },
        delivery: 'queue',
        resume: true,
      });
    },
    outcome: async (claim) => transcriptOutcome(ctx, claim, await read(claim.batch)),
    closing: env.closing,
    error: env.report,
    now,
  };

  return {
    host,
    close: () => {
      if (!deps.reviewClaims) claims.close();
    },

    // The stored attempt whose prompt started the session's current turn.
    // Rejects for a preparation prompt without one, so the turn can't run
    // without its instructions.
    preparationFor: (sessionID: string) => storedPreparation(ctx, claims, sessionID),

    // The task instructions for the attempt's turn.
    instructions: (record: AutomationRecord) => {
      const base = isJobFailure(record.item)
        ? INVESTIGATION_INSTRUCTIONS
        : isApproval(record.item)
          ? APPROVAL_INSTRUCTIONS
          : PREPARATION_INSTRUCTIONS;
      return record.execution ? `${base}\n${LINKED_INSTRUCTIONS}` : base;
    },

    // Checks, before the turn's first model request, that the attempt may
    // still run, that its prompt holds the current authorized findings, and
    // that the request's model may act on them. Records the start and the
    // allowed models, so the turn's later requests check only the model.
    // Returns the started attempt as stored.
    async authorizeStart(record: AutomationRecord, requested: string): Promise<AutomationRecord> {
      if (record.state !== 'running') throw new Error('Review automation is no longer running');
      const start = startContext(record);
      await start.pending(record.item);
      await assertSoleOwner(record.item);
      const ref = parseUrl(record.item.url);
      if (isJobFailure(record.item)) {
        // A job that fails before this first request replaces the batch's
        // update, so the request waits out the quiet time again, unless
        // the pipeline finishes. A failure during the checks changes the
        // stored attempt, so they run again with it.
        for (;;) {
          if (env.closing()) throw new Error('The plugin stopped');
          const current = await read(record.batch);
          if (
            current?.state !== 'running' ||
            current.messageID !== record.messageID ||
            current.startedAt !== undefined
          )
            throw new Error('Failed-job automation changed before the investigation turn');
          if (
            now() - current.item.at < INVESTIGATION_QUIET_TIME &&
            !(await pipelineDone(current.item).catch(() => false))
          ) {
            await sleep(RECHECK_INTERVAL);
            continue;
          }
          const configured = await start.rules();
          if (!ref || (!current.manual && !investigatesJobs(configured, ref)))
            throw new Error('The failed-job automation rule is no longer enabled');
          const rules = await start.check(current.item, !current.manual, configured);
          // The pipeline must still fail. Jobs that failed after the prompt
          // was written don't stop the turn, which reads the pipeline itself.
          await readFailures(deps, directory, current.item);
          const models = investigationModels(rules, ref);
          const refusal = modelRefusal(models, requested, 'retry');
          if (refusal) throw new Error(refusal);
          await start.pending(current.item);
          // Another session may have targeted the PR/MR during the wait.
          await assertSoleOwner(current.item);
          await start.admit();
          const started = startedRecord(current, models);
          if (await save(started, current)) {
            if (started.execution) await notify(started, 'started').catch(() => {});
            return started;
          }
        }
      }
      if (isApproval(record.item)) {
        const configured = await start.rules();
        if (env.watchesApprovalItem && !env.watchesApprovalItem(record.item))
          throw new Error('This reviewer approval is no longer watched');
        if (!ref || !matchesApprovalRule(configured, ref, record.item.reviewers))
          throw new Error('The review automation rule is no longer enabled');
        const rules = await start.check(record.item, true, configured);
        const current = await approvals(record.item, automationReviewers(rules, ref));
        if (!current.approvers.length || approvalDigest(current.approvers) !== record.digest)
          throw new Error(
            'The reviewer approval changed after the task was queued. Explicitly retry to act on the current approval.',
          );
        const models = allowedModelsFor(rules, ref, current.approvers);
        const refusal = modelRefusal(models, requested, 'retry');
        if (refusal) throw new Error(refusal);
        await start.pending(record.item);
        await assertSoleOwner(record.item);
        await start.admit();
        const started = startedRecord(record, models);
        if (!(await save(started, record)))
          throw new Error('Review automation changed before the approval turn');
        return started;
      }
      const configured = await start.rules();
      if (!ref || (!record.manual && automationReviewers(configured, ref).length === 0))
        throw new Error('The review automation rule is no longer enabled');
      const rules = await start.check(record.item, !record.manual, configured);
      const current = await findings(
        record.item,
        record.manual ? undefined : automationReviewers(rules, ref),
        record.manual ? restrictedReviewers(configured, ref) : undefined,
      );
      if (findingsDigest(current) !== record.digest)
        throw new Error(
          'The review findings changed after the task was queued. Explicitly retry to act on the current findings.',
        );
      const models = allowedModelsFor(rules, ref, current);
      const refusal = modelRefusal(models, requested, 'retry');
      if (refusal) throw new Error(refusal);
      await start.pending(record.item);
      await start.admit();
      const started = startedRecord(record, models);
      if (!(await save(started, record)))
        throw new Error('Review automation changed before the coding turn');
      if (started.execution) await notify(started, 'started').catch(() => {});
      return started;
    },

    // Re-verifies current approval policy (agent, watch, author-scoped rule,
    // active approval, and narrowed allowed models) on every continuation of an
    // already-started approval turn.
    async authorizeContinuation(record: AutomationRecord, requested: string): Promise<void> {
      if (!isApproval(record.item)) {
        const refusal = modelRefusal(record.models, requested, 'inspect');
        if (refusal) throw new Error(refusal);
        return;
      }
      if (record.ended || record.state !== 'running')
        throw new Error('Approval follow-up is no longer active.');
      const session = await ctx.session.get({ sessionID: record.item.sessionID });
      if (session.agent === 'plan')
        throw new Error(
          'Switch the owning session to a coding agent before continuing approval follow-up.',
        );
      if (env.watchesApprovalItem && !env.watchesApprovalItem(record.item))
        throw new Error('This reviewer approval is no longer watched.');
      const ref = parseUrl(record.item.url);
      if (!ref || !matchesApprovalRule(env.rules, ref, record.item.reviewers))
        throw new Error('The review automation rule is no longer enabled.');
      const policy = await resolvePolicy(
        deps,
        directory,
        env.rules,
        resolveAuthor,
        record.item,
        true,
      );
      if (!matchesApprovalRule(policy.rules, ref, record.item.reviewers))
        throw new Error('The review automation rule is no longer enabled.');
      const current = await approvals(record.item, automationReviewers(policy.rules, ref));
      if (!current.approvers.length || approvalDigest(current.approvers) !== record.digest)
        throw new Error('The reviewer approval is no longer current.');
      const currentAllowed = allowedModelsFor(policy.rules, ref, current.approvers);
      const effectiveModels =
        record.models && currentAllowed
          ? record.models.filter((entry) => currentAllowed.includes(entry))
          : (currentAllowed ?? record.models);
      const refusal = modelRefusal(effectiveModels, requested, 'inspect');
      if (refusal) throw new Error(refusal);
    },

    // Reads live status for the PR/MR bound to the active approval follow-up turn
    // and updates the turn's last-inspected readiness snapshot.
    async approvalStatus(sessionID: string, signal?: AbortSignal): Promise<string> {
      const checkAborted = () => {
        if (signal?.aborted || env.signal.aborted || env.closing())
          throw new Error('Approval follow-up was cancelled.');
      };
      checkAborted();
      const record = await storedPreparation(ctx, claims, sessionID);
      if (
        !record ||
        record.startedAt === undefined ||
        record.state !== 'running' ||
        record.ended ||
        !isApproval(record.item)
      )
        throw new Error(
          'This tool is only available during an active Forgekeeper review approval follow-up.',
        );
      await assertPending(record.item);
      await assertSoleOwner(record.item);
      checkAborted();
      const request = await currentRequest(deps, directory, record.item.url);
      checkAborted();
      if (!request) throw new Error('The PR/MR could not be read from the forge.');
      const currentApprovers = approversOf(request);
      const data = approvalStatusData(request, currentApprovers);
      const nextReadiness = readinessDigest(request, currentApprovers);
      const latest = await read(record.batch);
      if (
        latest &&
        latest.state === 'running' &&
        latest.messageID === record.messageID &&
        !latest.ended &&
        latest.readiness !== nextReadiness
      ) {
        await save({ ...latest, readiness: nextReadiness }, latest).catch(() => {});
      }
      return JSON.stringify(data);
    },

    // Marks the verified draft PR/MR for the active approval follow-up turn ready
    // for review, asserting session permission and re-checking authorization,
    // turn identity, cancellation, ownership, active approval, and readiness
    // snapshot freshness both before and after permission, and immediately before
    // dispatching the forge write.
    async markApprovalReady(invocation: MarkReadyInvocation): Promise<string> {
      const { sessionID, signal } = invocation;
      const checkAborted = () => {
        if (signal?.aborted || env.signal.aborted || env.closing())
          throw new Error('Approval follow-up was cancelled.');
      };
      const verifyTurn = async (expected?: AutomationRecord) => {
        checkAborted();
        if (!invocation.messageID || !invocation.callID)
          throw new Error('Missing tool invocation identity; refusing to mark the PR/MR ready.');
        const resolved = await resolvePreparation(ctx, claims, sessionID);
        if (!resolved || resolved.compacted)
          throw new Error(
            'Approval turn identity could not be verified from the active transcript; refusing to mark the PR/MR ready.',
          );
        const { record, messages, promptIndex } = resolved;
        if (
          record.startedAt === undefined ||
          record.state !== 'running' ||
          record.ended ||
          !isApproval(record.item)
        )
          throw new Error(
            'This tool is only available during an active Forgekeeper review approval follow-up.',
          );
        if (
          expected &&
          (record.batch !== expected.batch || record.messageID !== expected.messageID)
        )
          throw new Error('Approval follow-up is no longer active.');
        const session = await ctx.session.get({ sessionID });
        if (invocation.agent === 'plan' || session.agent === 'plan')
          throw new Error(
            'Switch the owning session to a coding agent before marking a PR/MR ready.',
          );
        const promptMessage = promptIndex >= 0 ? messages[promptIndex] : undefined;
        if (!promptMessage)
          throw new Error('Approval prompt is no longer active in the session transcript.');
        const afterPrompt = messages.slice(promptIndex + 1);
        if (afterPrompt.some((message) => message.type === 'idle'))
          throw new Error('Approval follow-up turn has already ended.');
        if (
          session.time.idle !== undefined &&
          promptMessage.time?.created !== undefined &&
          session.time.idle >= promptMessage.time.created
        )
          throw new Error('Approval follow-up turn has already ended.');
        const callerIndex = messages.findIndex((message) => message.id === invocation.messageID);
        if (callerIndex >= 0 && callerIndex <= promptIndex)
          throw new Error('Tool call does not belong to the active approval follow-up turn.');
        const assistantsAfter = afterPrompt.filter((message) => message.type === 'assistant');
        if (assistantsAfter.length > 0 && assistantsAfter.at(-1)!.id !== invocation.messageID)
          throw new Error(
            'Tool call does not belong to the active assistant response for this approval follow-up.',
          );
        await assertPending(record.item);
        await assertSoleOwner(record.item);
        if (env.watchesApprovalItem && !env.watchesApprovalItem(record.item))
          throw new Error('This reviewer approval is no longer watched.');
        const ref = parseUrl(record.item.url);
        if (!ref || !matchesApprovalRule(env.rules, ref, record.item.reviewers))
          throw new Error('The review automation rule is no longer enabled.');
        return { record, ref };
      };
      const verifyLivePolicy = async (record: AutomationRecord, ref: ReviewRef) => {
        const policy = await resolvePolicy(
          deps,
          directory,
          env.rules,
          resolveAuthor,
          record.item,
          true,
        );
        checkAborted();
        if (!matchesApprovalRule(policy.rules, ref, record.item.reviewers))
          throw new Error('The review automation rule is no longer enabled.');
        const current = await approvals(record.item, automationReviewers(policy.rules, ref));
        checkAborted();
        if (!current.approvers.length || approvalDigest(current.approvers) !== record.digest)
          throw new Error(
            'The reviewer approval is no longer current; refusing to mark the PR/MR ready.',
          );
        const currentAllowed = allowedModelsFor(policy.rules, ref, current.approvers);
        const effectiveModels =
          record.models && currentAllowed
            ? record.models.filter((entry) => currentAllowed.includes(entry))
            : (currentAllowed ?? record.models);
        if (effectiveModels !== undefined) {
          const currentModel = await model(sessionID);
          const refusal = modelRefusal(effectiveModels, currentModel, 'inspect');
          if (refusal) throw new Error(refusal);
        }
        const statusApprovers = approversOf(current.request).length
          ? approversOf(current.request)
          : current.approvers;
        const liveReadiness = readinessDigest(current.request, statusApprovers);
        if (record.readiness && liveReadiness !== record.readiness) {
          throw new Error(
            `Readiness status changed since it was last inspected; refusing to mark the PR/MR ready. Call ${APPROVAL_STATUS_TOOL} and re-evaluate the updated status before retrying:\n${JSON.stringify(approvalStatusData(current.request, statusApprovers))}`,
          );
        }
        return current;
      };

      const initial = await verifyTurn();
      const before = await verifyLivePolicy(initial.record, initial.ref);
      if (!before.request.draft) return `${before.request.url} is already marked ready for review.`;
      checkAborted();
      await ctx.permission.assert({
        sessionID,
        ...(invocation.agent ? { agent: invocation.agent } : {}),
        source: { type: 'tool', messageID: invocation.messageID!, id: invocation.callID! },
        action: MARK_READY_TOOL,
        resources: [before.request.url],
        save: [before.request.url],
        metadata: {
          url: before.request.url,
          forge: initial.ref.forge,
          project: initial.ref.project,
          iid: initial.ref.iid,
        },
      });
      // Re-verify active attempt, cancellation, agent, pending item, sole owner,
      // author-scoped policy, live approval, model, readiness snapshot, and draft
      // state after permission returns and immediately before dispatching.
      const afterTurn = await verifyTurn(initial.record);
      const after = await verifyLivePolicy(afterTurn.record, afterTurn.ref);
      if (!after.request.draft) return `${after.request.url} is already marked ready for review.`;
      checkAborted();
      const forge = deps.forges.forHost(afterTurn.ref.host, directory);
      if (!forge?.markReady) throw new Error('This forge does not support marking PRs/MRs ready.');
      await forge.markReady(afterTurn.ref, {
        beforeMutate: async () => {
          await verifyTurn(initial.record);
        },
      });
      env.markedReady?.(afterTurn.ref);
      return `Marked ${after.request.url} as ready for review.`;
    },

    // The stored attempts this checkout's instance continues after a reload:
    // queued and running ones whose session is here.
    async restorable(): Promise<AutomationRecord[]> {
      const records: AutomationRecord[] = [];
      for (const record of await claims.records.list()) {
        if (!record.item || (record.state !== 'running' && record.state !== 'queued')) continue;
        let session;
        try {
          session = await ctx.session.get({ sessionID: record.item.sessionID });
        } catch (error) {
          // A linked session's turn outlives its deleted owner, so the
          // instance of the checkout the owner was in keeps watching it.
          if (!env.missingSession(error)) throw error;
          if (record.execution?.ownerDirectory === directory) records.push(record);
          continue;
        }
        if (session.location.directory === directory) records.push(record);
      }
      return records;
    },

    // Removes the worktrees Forgekeeper created for PRs/MRs that are over,
    // when nothing in them would be lost. See `sweepWorktrees`.
    async sweep(): Promise<string[]> {
      return (await Promise.all(environments.providers.map((provider) => provider.sweep()))).flat();
    },

    // Puts a linked session's task in place of the placeholder that its
    // prompt shows, in every request of the session once the turn started,
    // so later turns and compactions there still read the findings. When a
    // compaction removed the placeholder, the task of `current`, the attempt
    // whose turn the request continues, goes first instead.
    async substitutePrompt(
      event: { sessionID: string; messages: unknown[] },
      current?: AutomationRecord,
    ) {
      const task = (record: AutomationRecord | undefined) =>
        record?.execution?.stage === 'submitting' &&
        record.startedAt !== undefined &&
        runnerOf(record) === event.sessionID
          ? record.execution.prompt
          : undefined;
      let restored = false;
      for (const message of event.messages as Array<{ role?: unknown; content?: unknown }>) {
        if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
        const text = (message.content as Array<{ text?: unknown }>)
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('\n');
        const messageID = placeholderMessageID(text);
        const batch = messageID && preparationBatch(messageID);
        if (!batch) continue;
        const record = await read(batch);
        const prompt = record?.messageID === messageID ? task(record) : undefined;
        if (!prompt) continue;
        message.content = [{ type: 'text', text: prompt }];
        if (record!.messageID === current?.messageID) restored = true;
      }
      const prompt = task(current);
      if (prompt && !restored)
        event.messages.unshift({
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          metadata: { forgekeeper: 'review-task' },
        });
    },
  };
}
