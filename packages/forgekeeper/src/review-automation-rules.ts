import { createHash } from 'node:crypto';
import type { AutomationEnvironments, ExecutionSource } from './automation-environment';
import { isApproval, type FeedbackItem, type InboxState } from './feedback-inbox';
import type { CommentDetail, FailedJob, ReviewerApproval, ReviewRef, ReviewRequest } from './forge';
import { parseReference, requestNoun } from './forges';
import { isJobFailure, pipelineBatch } from './job-investigation';
import type { AutomationRule, ReviewAutomationRule } from './options';
import type { ExecutionClaim } from './review-claim';

export type AutomationState = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AutomationStatus {
  state: AutomationState;
  at: number;
  reason?: string;
  messageID?: string;
  attempt: number;
  manual?: boolean;
}

export type Placement = 'session' | 'environment';

// What lets a batch run: where its turn runs, and the rules that apply to
// the PR/MR's author.
export interface Validation {
  placement: Placement;
  rules: readonly AutomationRule[];
}

// A turn in a linked session. The owning session keeps the target, the
// inbox update, and the claim; the linked session runs the turn.

export interface ProvisioningExecution extends Partial<ExecutionSource> {
  stage: 'provisioning';
  ownerDirectory?: string;
  provider: string;
  version: number;
  state: Record<string, unknown>;
}

// Once the prompt may have been submitted to the linked session.
export interface SubmittingExecution extends Omit<ProvisioningExecution, 'stage'> {
  stage: 'submitting';
  // The task, which only Forgekeeper adds to the linked session's requests.
  prompt: string;
}

export type Execution = ProvisioningExecution | SubmittingExecution;

// An attempt whose turn the linked session may have received.
export type LinkedRecord = AutomationRecord & { execution: SubmittingExecution };

export interface AutomationRecord extends AutomationStatus {
  batch: string;
  item: FeedbackItem;
  placement?: Placement;
  execution?: Execution;
  // When the turn's prompt was submitted to the session, persisted only after
  // submission succeeds so pre-delivery compaction cannot bind an unrelated turn.
  submittedAt?: number;
  // When the coding turn's first model request passed its checks.
  startedAt?: number;
  // The findings the turn's prompt holds; see `findingsDigest`.
  digest?: string;
  // Readiness snapshot hash last shown to the model in an approval turn.
  readiness?: string;
  // The models the turn's requests may use, set when it starts. Without
  // them, any model may.
  models?: string[];
  // How the session's first turn end after `startedAt` went, as the session
  // reported it then. A later turn's end can't stand in for it.
  ended?: { outcome: 'succeeded' | 'failed'; at: number };
}

// How a coding turn ended. `pending` means its start or end isn't in the
// transcript or the stored attempt yet, and `unknown` that they can't say.
export type ExecutionOutcome = 'pending' | 'running' | 'completed' | 'failed' | 'unknown';

// What still holds a PR/MR's execution claim: nothing, an attempt that's
// queued or running, a turn that's still going, or a turn whose outcome is
// uncertain.
export type ClaimHolder = 'free' | 'live' | 'running' | 'uncertain';

export function claimHeldMessage(holder: Exclude<ClaimHolder, 'free'>, url: string): string {
  const noun = requestNoun(parseReference(url)?.ref.forge);
  switch (holder) {
    case 'live':
      return `Another feedback task is queued or running for this ${noun}`;
    case 'running':
      return 'The earlier coding turn is still running';
    case 'uncertain':
      return `An earlier coding turn on this ${noun} has an uncertain outcome. Inspect the session, then use Retry feedback work to clear it.`;
  }
}

export const ORPHANED = 'The owning session was deleted.';

// The states an attempt can move to. Every other change is a stale writer's,
// such as another instance's, and is dropped.
export const TRANSITIONS: Record<AutomationState, readonly AutomationState[]> = {
  queued: ['running', 'skipped', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  skipped: [],
};

// How often a turn that is still running, or not yet admitted, is checked
// again, and how many checks admission may take.
export const RECHECK_INTERVAL = 30_000;
export const ADMISSION_CHECKS = 3;

// A review update's batch is its comments. A failed-job update's batch is its
// pipeline, so later failures in the pipeline join the same batch.
export const automationBatch = (item: FeedbackItem) => {
  if (isJobFailure(item)) return pipelineBatch(item);
  if (isApproval(item)) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          item.url,
          'approval',
          item.approverID ?? null,
          [...(item.reviewers ?? [])].map((name) => name.toLowerCase()).sort(),
          item.approvalToken ?? null,
          item.approvalCycle ?? null,
          item.postedAt ?? item.at,
        ]),
      )
      .digest('hex');
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        item.url,
        [...(item.commentIDs ?? item.links)].sort(),
        item.postedAt ?? item.at,
      ]),
    )
    .digest('hex');
};

// The review rules that cover the PR/MR's project.
const reviewRules = (rules: readonly AutomationRule[], ref: ReviewRef) =>
  rules.filter(
    (rule): rule is ReviewAutomationRule =>
      rule.on === 'review' && rule.host === ref.host && rule.projects.includes(ref.project),
  );

export function environmentExecution(
  rules: readonly AutomationRule[],
  ref: ReviewRef,
  item: Pick<FeedbackItem, 'kind'>,
): boolean {
  const on = isJobFailure(item) ? 'job-failed' : 'review';
  const covering = rules.filter(
    (rule) => rule.on === on && rule.host === ref.host && rule.projects.includes(ref.project),
  );
  return covering.length > 0 && covering.every((rule) => rule.execution === 'environment');
}

export function automationReviewers(rules: readonly AutomationRule[], ref: ReviewRef): string[] {
  return [...new Set(reviewRules(rules, ref).flatMap((rule) => rule.reviewers))];
}

export function matchesApprovalRule(
  rules: readonly AutomationRule[],
  ref: ReviewRef,
  reviewers: readonly string[] | undefined,
): boolean {
  if (!reviewers?.length) return false;
  const allowed = new Set(automationReviewers(rules, ref));
  return reviewers.some((name) => allowed.has(name.toLowerCase()));
}

// The reviewers whose feedback only some models may act on. A manual action
// tags their findings, so it honors the same restrictions.
export function restrictedReviewers(rules: readonly AutomationRule[], ref: ReviewRef): string[] {
  return [
    ...new Set(
      reviewRules(rules, ref)
        .filter((rule) => rule.allowedModels)
        .flatMap((rule) => rule.reviewers),
    ),
  ];
}

// A finding, with the configured reviewer whose account wrote it, if any.
export type ReviewFinding = CommentDetail & { reviewer?: string };

export type VerifiedApproval = ReviewerApproval & { reviewer?: string };

export interface ApprovalContext {
  request: ReviewRequest;
  approvers: VerifiedApproval[];
}

export const modelKey = (model: { providerID: string; id: string }) =>
  `${model.providerID}/${model.id}`;

// The models that may act on the findings, or undefined for any model. A
// reviewer's findings need a rule for the project and that reviewer that
// allows the model, so the batch needs a model every such reviewer allows.
export function allowedModelsFor(
  rules: readonly AutomationRule[],
  ref: ReviewRef,
  findings: readonly { reviewer?: string }[],
): string[] | undefined {
  let allowed: string[] | undefined;
  for (const reviewer of new Set(findings.flatMap((finding) => finding.reviewer ?? []))) {
    const governing = reviewRules(rules, ref).filter((rule) => rule.reviewers.includes(reviewer));
    if (!governing.length || governing.some((rule) => !rule.allowedModels)) continue;
    const models = new Set(governing.flatMap((rule) => rule.allowedModels!));
    allowed = allowed ? allowed.filter((model) => models.has(model)) : [...models];
  }
  return allowed;
}

// What to do after switching models: act on a skipped batch, retry one
// that failed before its turn started, or inspect a turn that started.
export type ModelRemedy = 'act' | 'retry' | 'inspect';

const REMEDIES: Record<ModelRemedy, string> = {
  act: 'Switch models, then use Act on feedback.',
  retry: 'Switch models, then use Retry feedback work.',
  inspect:
    'The turn may have made changes. Inspect the session, switch models, then use Retry feedback work.',
};

// Why the model may not act on feedback that `allowed` restricts, or
// undefined when it may.
export function modelRefusal(
  allowed: readonly string[] | undefined,
  model: string | undefined,
  remedy: ModelRemedy,
): string | undefined {
  if (!allowed || (model && allowed.includes(model))) return undefined;
  if (!allowed.length)
    return "No model is allowed for every reviewer in this batch. Check the automation rules' allowed models.";
  return `Review automation needs one of these models: ${allowed.join(', ')}. This session uses ${model ?? 'a model Forgekeeper could not read'}. ${REMEDIES[remedy]}`;
}

// A pipeline's failed jobs, as the forge reports them now.
export interface PipelineFailures {
  pipeline: { id: string; url?: string };
  jobs: FailedJob[];
  // Whether the pipeline failed without a job Forgekeeper could read.
  unlisted: boolean;
  // False when the pipeline has more failed jobs than `jobs` lists.
  complete: boolean;
}

export interface AutomationHost {
  environments?: AutomationEnvironments;
  rules: readonly AutomationRule[];
  ref: (url: string) => ReviewRef | undefined;
  read: (batch: string) => Promise<AutomationRecord | undefined>;
  list: () => Promise<AutomationRecord[]>;
  save: (record: AutomationRecord, expected?: AutomationRecord) => Promise<boolean>;
  start: (record: AutomationRecord, expected: AutomationRecord) => Promise<boolean>;
  // Stores a definitive outcome and frees the attempt's PR/MR claim together.
  finish: (record: AutomationRecord, expected: AutomationRecord) => Promise<boolean>;
  status: (item: FeedbackItem, status: AutomationStatus) => Promise<void>;
  inbox: () => Promise<InboxState>;
  // Rejects when sessions can't be enumerated, so ownership stays undecided.
  associations: (url: string) => Promise<string[]>;
  // False only when the session is confirmed gone. Rejects when it can't be read.
  exists: (sessionID: string) => Promise<boolean>;
  // With reviewers, only their findings count. Findings from `reviewers` or
  // `tagged` name their reviewer.
  findings: (
    item: FeedbackItem,
    reviewers: string[] | undefined,
    tagged?: readonly string[],
  ) => Promise<ReviewFinding[]>;
  approvals?: (
    item: FeedbackItem,
    reviewers: string[] | undefined,
    tagged?: readonly string[],
  ) => Promise<ApprovalContext>;
  watchesApproval?: (item: FeedbackItem) => boolean;
  // The failed jobs of a failed-job update's pipeline. Rejects with
  // `Ineligible` once it's no longer the PR/MR's head pipeline or fails.
  failures: (item: FeedbackItem) => Promise<PipelineFailures>;
  // Whether a failed-job update's pipeline finished or was replaced, so its
  // batch needn't wait for more failures.
  pipelineDone: (item: FeedbackItem) => Promise<boolean>;
  // The model the session's next turn uses, as `provider/model`.
  model: (sessionID: string) => Promise<string | undefined>;
  validate: (item: FeedbackItem, automatic: boolean) => Promise<Validation>;
  // Tells the owning session about a linked session's turn.
  notify?: (record: AutomationRecord, phase: 'started' | 'ended') => Promise<void>;
  // Delivers the item as if automation hadn't selected it, such as with a summary.
  redeliver: (item: FeedbackItem) => void;
  wait: (sessionID: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  claim: {
    acquire: (url: string, claim: ExecutionClaim) => Promise<boolean>;
    read: (url: string) => Promise<ExecutionClaim | undefined>;
    release: (url: string, claim: ExecutionClaim) => Promise<void>;
  };
  submit: (record: AutomationRecord, text: string) => Promise<void>;
  outcome: (claim: ExecutionClaim) => Promise<ExecutionOutcome>;
  closing: () => boolean;
  error: (error: unknown) => void;
  now?: () => number;
}

// A check that rules a batch out, as opposed to one that failed to run, such
// as for a network error. A ruled-out batch is skipped and keeps its normal
// delivery; a failed check is retried.
export class Ineligible extends Error {}

export const sameAttempt = (
  claim: ExecutionClaim | undefined,
  record: AutomationRecord | undefined,
) => !!claim && !!record && claim.batch === record.batch && claim.messageID === record.messageID;

// Whether automation handles the update's delivery: while its attempt may
// still run, or once one ran. A batch that ended without running, such as a
// skipped one, keeps its normal delivery, such as a summary.
export const handlesDelivery = (record: AutomationRecord | undefined) =>
  !record ||
  record.state === 'queued' ||
  record.state === 'running' ||
  record.state === 'completed' ||
  record.startedAt !== undefined;
