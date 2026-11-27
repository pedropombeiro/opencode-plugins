import type { Plugin } from '@opencode/plugin';
import type { StartContext } from './automation-environment';
import { isApproval, type FeedbackItem } from './feedback-inbox';
import { approversOf, type ReviewRef } from './forge';
import { parseUrl } from './forges';
import { localRunnerOf as runnerOf } from './local-automation-environment';
import {
  allowedModelsFor,
  automationReviewers,
  matchesApprovalRule,
  modelRefusal,
  type ApprovalContext,
  type AutomationRecord,
} from './review-automation';
import {
  currentRequest,
  resolvePolicy,
  type AuthorResolver,
  type AutomationDependencies,
  type AutomationEnvironment,
} from './review-automation-verification';
import type { createReviewClaims } from './review-claim';
import {
  APPROVAL_STATUS_TOOL,
  approvalDigest,
  approvalStatusData,
  MARK_READY_TOOL,
  preparationBatch,
  readinessDigest,
} from './review-preparation';
import { turnInput } from './review-summary';

type Context = Plugin.Context;

export interface MarkReadyInvocation {
  sessionID: string;
  agent?: string;
  messageID?: string;
  callID?: string;
  signal?: AbortSignal;
}

export interface ResolvedPreparation {
  record: AutomationRecord;
  compacted: boolean;
  messages: Awaited<ReturnType<Context['session']['context']>>;
  promptIndex: number;
}

const boundAtOf = (record: AutomationRecord) => record.submittedAt ?? record.startedAt;

export async function resolvePreparation(
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

export interface ApprovalTurnHost {
  ctx: Context;
  deps: AutomationDependencies;
  env: AutomationEnvironment;
  directory: string;
  claims: ReturnType<typeof createReviewClaims>;
  read: ReturnType<typeof createReviewClaims>['records']['read'];
  save: (record: AutomationRecord, expected?: AutomationRecord) => Promise<boolean>;
  approvals: (
    item: FeedbackItem,
    reviewers: readonly string[] | undefined,
    tagged?: readonly string[],
  ) => Promise<ApprovalContext>;
  model: (sessionID: string) => Promise<string | undefined>;
  resolveAuthor: AuthorResolver;
  assertPending: (item: FeedbackItem) => Promise<void>;
  assertSoleOwner: (item: FeedbackItem) => Promise<void>;
  startedRecord: (record: AutomationRecord, models: string[] | undefined) => AutomationRecord;
}

export async function authorizeApprovalStart(
  host: ApprovalTurnHost,
  start: StartContext,
  record: AutomationRecord,
  ref: ReviewRef | undefined,
  requested: string,
): Promise<AutomationRecord> {
  const configured = await start.rules();
  if (host.env.watchesApprovalItem && !host.env.watchesApprovalItem(record.item))
    throw new Error('This reviewer approval is no longer watched');
  if (!ref || !matchesApprovalRule(configured, ref, record.item.reviewers))
    throw new Error('The review automation rule is no longer enabled');
  const rules = await start.check(record.item, true, configured);
  const current = await host.approvals(record.item, automationReviewers(rules, ref));
  if (!current.approvers.length || approvalDigest(current.approvers) !== record.digest)
    throw new Error(
      'The reviewer approval changed after the task was queued. Explicitly retry to act on the current approval.',
    );
  const models = allowedModelsFor(rules, ref, current.approvers);
  const refusal = modelRefusal(models, requested, 'retry');
  if (refusal) throw new Error(refusal);
  await start.pending(record.item);
  await host.assertSoleOwner(record.item);
  await start.admit();
  const started = host.startedRecord(record, models);
  if (!(await host.save(started, record)))
    throw new Error('Review automation changed before the approval turn');
  return started;
}

export async function authorizeApprovalContinuation(
  host: ApprovalTurnHost,
  record: AutomationRecord,
  requested: string,
): Promise<void> {
  if (!isApproval(record.item)) {
    const refusal = modelRefusal(record.models, requested, 'inspect');
    if (refusal) throw new Error(refusal);
    return;
  }
  if (record.ended || record.state !== 'running')
    throw new Error('Approval follow-up is no longer active.');
  const session = await host.ctx.session.get({ sessionID: record.item.sessionID });
  if (session.agent === 'plan')
    throw new Error(
      'Switch the owning session to a coding agent before continuing approval follow-up.',
    );
  if (host.env.watchesApprovalItem && !host.env.watchesApprovalItem(record.item))
    throw new Error('This reviewer approval is no longer watched.');
  const ref = parseUrl(record.item.url);
  if (!ref || !matchesApprovalRule(host.env.rules, ref, record.item.reviewers))
    throw new Error('The review automation rule is no longer enabled.');
  const policy = await resolvePolicy(
    host.deps,
    host.directory,
    host.env.rules,
    host.resolveAuthor,
    record.item,
    true,
  );
  if (!matchesApprovalRule(policy.rules, ref, record.item.reviewers))
    throw new Error('The review automation rule is no longer enabled.');
  const current = await host.approvals(record.item, automationReviewers(policy.rules, ref));
  if (!current.approvers.length || approvalDigest(current.approvers) !== record.digest)
    throw new Error('The reviewer approval is no longer current.');
  const currentAllowed = allowedModelsFor(policy.rules, ref, current.approvers);
  const effectiveModels =
    record.models && currentAllowed
      ? record.models.filter((entry) => currentAllowed.includes(entry))
      : (currentAllowed ?? record.models);
  const refusal = modelRefusal(effectiveModels, requested, 'inspect');
  if (refusal) throw new Error(refusal);
}

export async function readApprovalStatus(
  host: ApprovalTurnHost,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string> {
  const checkAborted = () => {
    if (signal?.aborted || host.env.signal.aborted || host.env.closing())
      throw new Error('Approval follow-up was cancelled.');
  };
  checkAborted();
  const record = await storedPreparation(host.ctx, host.claims, sessionID);
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
  await host.assertPending(record.item);
  await host.assertSoleOwner(record.item);
  checkAborted();
  const request = await currentRequest(host.deps, host.directory, record.item.url);
  checkAborted();
  if (!request) throw new Error('The PR/MR could not be read from the forge.');
  const currentApprovers = approversOf(request);
  const data = approvalStatusData(request, currentApprovers);
  const nextReadiness = readinessDigest(request, currentApprovers);
  const latest = await host.read(record.batch);
  if (
    latest &&
    latest.state === 'running' &&
    latest.messageID === record.messageID &&
    !latest.ended &&
    latest.readiness !== nextReadiness
  ) {
    await host.save({ ...latest, readiness: nextReadiness }, latest).catch(() => {});
  }
  return JSON.stringify(data);
}

export async function markApprovalReady(
  host: ApprovalTurnHost,
  invocation: MarkReadyInvocation,
): Promise<string> {
  const { sessionID, signal } = invocation;
  const checkAborted = () => {
    if (signal?.aborted || host.env.signal.aborted || host.env.closing())
      throw new Error('Approval follow-up was cancelled.');
  };
  const verifyTurn = async (expected?: AutomationRecord) => {
    checkAborted();
    if (!invocation.messageID || !invocation.callID)
      throw new Error('Missing tool invocation identity; refusing to mark the PR/MR ready.');
    const resolved = await resolvePreparation(host.ctx, host.claims, sessionID);
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
    if (expected && (record.batch !== expected.batch || record.messageID !== expected.messageID))
      throw new Error('Approval follow-up is no longer active.');
    const session = await host.ctx.session.get({ sessionID });
    if (invocation.agent === 'plan' || session.agent === 'plan')
      throw new Error('Switch the owning session to a coding agent before marking a PR/MR ready.');
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
    await host.assertPending(record.item);
    await host.assertSoleOwner(record.item);
    if (host.env.watchesApprovalItem && !host.env.watchesApprovalItem(record.item))
      throw new Error('This reviewer approval is no longer watched.');
    const ref = parseUrl(record.item.url);
    if (!ref || !matchesApprovalRule(host.env.rules, ref, record.item.reviewers))
      throw new Error('The review automation rule is no longer enabled.');
    return { record, ref };
  };
  const verifyLivePolicy = async (record: AutomationRecord, ref: ReviewRef) => {
    const policy = await resolvePolicy(
      host.deps,
      host.directory,
      host.env.rules,
      host.resolveAuthor,
      record.item,
      true,
    );
    checkAborted();
    if (!matchesApprovalRule(policy.rules, ref, record.item.reviewers))
      throw new Error('The review automation rule is no longer enabled.');
    const current = await host.approvals(record.item, automationReviewers(policy.rules, ref));
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
      const currentModel = await host.model(sessionID);
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
  await host.ctx.permission.assert({
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
  const forge = host.deps.forges.forHost(afterTurn.ref.host, host.directory);
  if (!forge?.markReady) throw new Error('This forge does not support marking PRs/MRs ready.');
  await forge.markReady(afterTurn.ref, {
    beforeMutate: async () => {
      await verifyTurn(initial.record);
    },
  });
  host.env.markedReady?.(afterTurn.ref);
  return `Marked ${after.request.url} as ready for review.`;
}
