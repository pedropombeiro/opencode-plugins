import { randomUUID } from 'node:crypto';
import type { FeedbackItem } from './feedback-inbox';
import {
  approvalsComplete,
  approversOf,
  pipelineFails,
  pipelineRunning,
  type ReviewerApproval,
  type ReviewRequest,
} from './forge';
import { traitsOf } from './forges';
import { createKeyedQueue } from './keyed-queue';
import type { FeedbackDelivery } from './options';

export const APPROVAL_RETENTION = 30 * 24 * 60 * 60_000;

export interface ApprovalEvent {
  id: string;
  cycle?: number;
  detectedAt: number;
  approver: ReviewerApproval;
  title: string;
  details?: string[];
  delivery?: 'passive' | 'summary';
}

export interface ApprovalRecord {
  sessionID: string;
  url: string;
  reference: string;
  state: string;
  generation?: string;
  approvers: string[];
  tokens?: Record<string, string>;
  cycles: Record<string, number>;
  pending: ApprovalEvent[];
  at: number;
}

export const approverKind = (approver: ReviewerApproval): 'automated' | 'bot' | 'human' =>
  approver.automated ? 'automated' : approver.bot ? 'bot' : 'human';

export const approverKey = (
  approver: Pick<ReviewerApproval, 'id' | 'username' | 'bot' | 'automated'>,
): string =>
  approver.id
    ? `id:${approver.id}`
    : `${approver.bot || approver.automated ? 'bot' : 'user'}:${approver.username.toLowerCase()}`;

const legacyApproverKey = (approver: Pick<ReviewerApproval, 'username'>): string =>
  approver.username.toLowerCase();

const isStructuredRecord = (record: Pick<ApprovalRecord, 'approvers' | 'tokens' | 'cycles'>) =>
  record.approvers.some((entry) => entry.includes(':')) ||
  Object.keys(record.tokens ?? {}).some((entry) => entry.includes(':')) ||
  Object.keys(record.cycles).some((entry) => entry.includes(':'));

export function matchesApproverEvent(
  expected: ReviewerApproval,
  actual: ReviewerApproval,
): boolean {
  if ((expected.bot || expected.automated) && !actual.bot && !actual.automated) return false;
  const accountMatch =
    expected.id && actual.id
      ? expected.id === actual.id
      : expected.username.toLowerCase() === actual.username.toLowerCase();
  if (!accountMatch) return false;
  if (expected.reviewID && actual.reviewID !== expected.reviewID) return false;
  return true;
}

export function matchesApproval(
  item: Pick<FeedbackItem, 'reviewers' | 'approverID' | 'approvalToken' | 'approverKind'>,
  approver: ReviewerApproval,
): boolean {
  if (item.approverKind && item.approverKind !== 'human' && !approver.bot && !approver.automated)
    return false;
  const accountMatch =
    item.approverID && approver.id
      ? approver.id === item.approverID
      : !!item.reviewers?.some((name) => name.toLowerCase() === approver.username.toLowerCase());
  if (!accountMatch) return false;
  if (item.approvalToken && approver.reviewID !== item.approvalToken) return false;
  return true;
}

export function approvalTitle(
  request: ReviewRequest,
  approver: ReviewerApproval,
  ref: string,
): string {
  const label = approver.automated
    ? (traitsOf(request).automatedReview?.name ?? approver.username)
    : `@${approver.username}`;
  return `${label} approved ${ref}`;
}

export function approvalDetails(request: ReviewRequest): string[] {
  const noun = traitsOf(request).noun;
  const details: string[] = [];
  if (request.draft) details.push(`The ${noun} is still a draft.`);
  if (request.conflicts && request.conflictsKnown) details.push(`The ${noun} has merge conflicts.`);
  else if (!request.conflictsKnown)
    details.push(`The ${noun} mergeability is still being checked.`);
  if (request.unresolvedThreads > 0 || request.threadsComplete === false) {
    const singular = request.unresolvedThreads === 1 && request.threadsComplete !== false;
    details.push(
      `${request.unresolvedThreads}${request.threadsComplete === false ? '+' : ''} unresolved thread${singular ? ' remains' : 's remain'}.`,
    );
  }
  if (request.awaitingReviewers?.length) {
    details.push(
      `Still awaiting review from ${request.awaitingReviewers.map((username) => `@${username}`).join(', ')}.`,
    );
  }
  if (request.reviewersComplete === false) {
    details.push('Reviewer list is incomplete.');
  }
  if (request.approvalsComplete === false) {
    details.push('Approval list is incomplete.');
  }
  if (request.pipeline) {
    if (pipelineFails(request.pipeline))
      details.push(`The ${traitsOf(request).ci} has failed jobs.`);
    else if (pipelineRunning(request.pipeline))
      details.push(`The ${traitsOf(request).ci} is still running.`);
  }
  return details;
}

export function observeApprovals(
  sessionID: string,
  requests: readonly ReviewRequest[],
  records: ReadonlyMap<string, ApprovalRecord>,
  reference: (request: ReviewRequest) => string,
  now: number,
  watches: (request: ReviewRequest, approver: ReviewerApproval) => boolean = () => true,
  delivery: () => FeedbackDelivery = () => 'inbox',
  newGeneration: () => string = randomUUID,
): ApprovalRecord[] {
  const next: ApprovalRecord[] = [];
  for (const request of requests) {
    const previous = records.get(request.url);
    if (!approvalsComplete(request)) {
      if (!previous) continue;
      next.push({
        ...previous,
        reference: reference(request),
        state: request.state,
        pending: request.state === 'opened' ? previous.pending : [],
        at: now,
      });
      continue;
    }
    const currentApprovers = approversOf(request);
    const currentKeys = [...new Set(currentApprovers.map(approverKey))].sort();
    const structured = previous ? isStructuredRecord(previous) : true;
    // Retain previously seen review tokens across inactive/pending polls so a
    // GitHub approval reappearing with the same review ID after a comment-only
    // or canceled re-review is not mistaken for a new approval.
    const nextTokens: Record<string, string> = { ...(previous?.tokens ?? {}) };
    for (const entry of currentApprovers) {
      const key = approverKey(entry);
      if (entry.reviewID) {
        nextTokens[key] = entry.reviewID;
        if (!structured) delete nextTokens[legacyApproverKey(entry)];
      }
    }
    if (!previous) {
      next.push({
        sessionID,
        url: request.url,
        reference: reference(request),
        state: request.state,
        generation: newGeneration(),
        approvers: currentKeys,
        ...(Object.keys(nextTokens).length ? { tokens: nextTokens } : {}),
        cycles: {},
        pending: [],
        at: now,
      });
      continue;
    }
    const pending = previous.pending.filter(
      (event) =>
        request.state === 'opened' &&
        currentApprovers.some((approver) => matchesApproverEvent(event.approver, approver)),
    );
    const cycles = { ...previous.cycles };
    if (request.state === 'opened') {
      const previousSet = new Set(previous.approvers);
      const seen = new Set<string>();
      for (const approver of currentApprovers) {
        const key = approverKey(approver);
        if (seen.has(key)) continue;
        seen.add(key);
        const legacy = legacyApproverKey(approver);
        const wasApproving = previousSet.has(key) || (!structured && previousSet.has(legacy));
        const previousToken =
          previous.tokens?.[key] ?? (!structured ? previous.tokens?.[legacy] : undefined);
        const sameToken =
          !!approver.reviewID && !!previousToken && approver.reviewID === previousToken;
        const reapproved =
          wasApproving &&
          !!approver.reviewID &&
          !!previousToken &&
          approver.reviewID !== previousToken;
        if (sameToken || (wasApproving && !reapproved)) continue;
        if (approver.id && request.authorID && approver.id === request.authorID) continue;
        if (!watches(request, approver)) continue;
        const priorCycle = cycles[key] ?? (!structured ? cycles[legacy] : undefined) ?? 0;
        const cycle = priorCycle + 1;
        cycles[key] = cycle;
        if (!structured && legacy !== key) delete cycles[legacy];
        const id = previous.generation
          ? JSON.stringify([sessionID, request.url, 'approval', previous.generation, key, cycle])
          : JSON.stringify([sessionID, request.url, 'approval', key, cycle]);
        if (pending.some((event) => event.id === id)) continue;
        const details = approvalDetails(request);
        const mode = delivery();
        pending.push({
          id,
          cycle,
          detectedAt: now,
          approver,
          title: approvalTitle(request, approver, reference(request)),
          ...(details.length ? { details } : {}),
          ...(mode !== 'inbox' ? { delivery: mode } : {}),
        });
      }
    }
    next.push({
      sessionID,
      url: request.url,
      reference: reference(request),
      state: request.state,
      ...(previous.generation ? { generation: previous.generation } : {}),
      approvers: currentKeys,
      ...(Object.keys(nextTokens).length ? { tokens: nextTokens } : {}),
      cycles,
      pending,
      at: now,
    });
  }
  return next;
}

export const unchangedApproval = (a: ApprovalRecord | undefined, b: ApprovalRecord) =>
  a !== undefined && JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

export type ApprovalDeliveryOutcome = 'defer' | { reconcile: ReviewRequest } | void;

export interface ApprovalWatcherOptions {
  records: (sessionID: string) => Promise<ApprovalRecord[]>;
  write: (record: ApprovalRecord) => Promise<void>;
  remove?: (record: ApprovalRecord) => Promise<void>;
  retired?: (eventIDs: readonly string[]) => Promise<void>;
  waiting: () => Promise<ApprovalRecord[]>;
  deliver: (
    record: ApprovalRecord,
    event: ApprovalEvent,
    fresh?: ReviewRequest,
  ) => Promise<ApprovalDeliveryOutcome>;
  reference: (request: ReviewRequest) => string;
  watches?: (request: ReviewRequest, approver: ReviewerApproval) => boolean;
  delivery?: () => FeedbackDelivery;
  newGeneration?: () => string;
  onError?: (error: unknown) => void;
  now?: () => number;
}

function reconcileLive(
  record: ApprovalRecord,
  live: ReviewRequest,
  at: number,
  droppedID?: string,
): ApprovalRecord {
  if (live.state !== 'opened') {
    return {
      ...record,
      state: live.state,
      approvers: [],
      pending: [],
      at,
    };
  }
  if (!approvalsComplete(live)) {
    return droppedID
      ? {
          ...record,
          pending: record.pending.filter((entry) => entry.id !== droppedID),
        }
      : record;
  }
  const currentApprovers = approversOf(live);
  const liveKeys = new Set(currentApprovers.map(approverKey));
  const liveLegacy = new Set(currentApprovers.map(legacyApproverKey));
  const structured = isStructuredRecord(record);
  const approvers = record.approvers.filter(
    (entry) => liveKeys.has(entry) || (!structured && liveLegacy.has(entry)),
  );
  const pending = record.pending.filter(
    (entry) =>
      entry.id !== droppedID &&
      currentApprovers.some((approver) => matchesApproverEvent(entry.approver, approver)),
  );
  return {
    ...record,
    state: live.state,
    approvers,
    pending,
    at,
  };
}

export function createApprovalWatcher(options: ApprovalWatcherOptions) {
  const now = options.now ?? Date.now;
  const queue = createKeyedQueue();

  async function flush(sessionID: string, fresh?: ReadonlyMap<string, ReviewRequest>) {
    let failure: { error: unknown } | undefined;
    const records = await options.records(sessionID);
    const candidates = fresh ? records.filter((record) => fresh.has(record.url)) : records;
    for (const record of candidates) {
      let current = record;
      for (const event of record.pending) {
        if (!current.pending.some((entry) => entry.id === event.id)) continue;
        let outcome: ApprovalDeliveryOutcome;
        try {
          outcome = await options.deliver(current, event, fresh?.get(current.url));
        } catch (error) {
          failure ??= { error };
          continue;
        }
        if (outcome === 'defer') continue;
        const beforeIDs = current.pending.map((entry) => entry.id);
        current =
          outcome && typeof outcome === 'object' && 'reconcile' in outcome
            ? reconcileLive(current, outcome.reconcile, now(), event.id)
            : { ...current, pending: current.pending.filter((entry) => entry.id !== event.id) };
        await options.write(current);
        const remaining = new Set(current.pending.map((entry) => entry.id));
        const retired = beforeIDs.filter((id) => !remaining.has(id));
        if (retired.length) await options.retired?.(retired).catch(() => {});
      }
    }
    if (failure) throw failure.error;
  }

  return {
    observe: (sessionID: string, requests: readonly ReviewRequest[]) =>
      queue.run(sessionID, async () => {
        if (requests.length === 0) return;
        const stored = new Map(
          (await options.records(sessionID)).map((record) => [record.url, record]),
        );
        for (const record of observeApprovals(
          sessionID,
          requests,
          stored,
          options.reference,
          now(),
          options.watches,
          options.delivery,
          options.newGeneration,
        )) {
          if (!unchangedApproval(stored.get(record.url), record)) await options.write(record);
        }
        await flush(sessionID, new Map(requests.map((request) => [request.url, request])));
      }),
    retry: async () => {
      const sessions = new Set((await options.waiting()).map((record) => record.sessionID));
      for (const sessionID of sessions)
        await queue
          .run(sessionID, () => flush(sessionID))
          .catch((error) => options.onError?.(error));
    },
    reconcile: (sessionID: string, live: ReviewRequest, fetchedAt: number) =>
      queue.run(sessionID, async () => {
        const record = (await options.records(sessionID)).find((entry) => entry.url === live.url);
        if (!record || record.at > fetchedAt) return;
        const beforeIDs = record.pending.map((entry) => entry.id);
        const next = reconcileLive(record, live, Math.max(record.at, fetchedAt));
        if (unchangedApproval(record, next)) return;
        await options.write(next);
        const remaining = new Set(next.pending.map((entry) => entry.id));
        const retired = beforeIDs.filter((id) => !remaining.has(id));
        if (retired.length) await options.retired?.(retired).catch(() => {});
      }),
    retire: (sessionID: string, keep?: (url: string) => boolean) =>
      queue.run(sessionID, async () => {
        const records = await options.records(sessionID);
        const retiredIDs: string[] = [];
        for (const record of records) {
          if (keep?.(record.url)) continue;
          await options.remove?.(record);
          for (const event of record.pending) retiredIDs.push(event.id);
        }
        if (retiredIDs.length) await options.retired?.(retiredIDs).catch(() => {});
      }),
  };
}
