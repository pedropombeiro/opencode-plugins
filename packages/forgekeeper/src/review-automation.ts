// Acts on review feedback from authorized reviewers: one coding turn per
// review batch, in the one session that targets the PR/MR. Each attempt is
// stored, so a reload resumes or reconciles it instead of starting it again.
import { createHash } from 'node:crypto';
import type { FeedbackItem, InboxState } from './feedback-inbox';
import type { CommentDetail, FailedJob, ReviewRef } from './forge';
import {
  failuresDigest,
  INVESTIGATION_QUIET_TIME,
  investigatesJobs,
  investigationModels,
  investigationPrompt,
  isJobFailure,
  pipelineBatch,
  sameUpdate,
} from './job-investigation';
import { createKeyedQueue } from './keyed-queue';
import type { AutomationRule, ReviewAutomationRule } from './options';
import type { ExecutionClaim } from './review-claim';
import { findingsDigest, preparationMessageID, preparationPrompt } from './review-preparation';

export type AutomationState = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AutomationStatus {
  state: AutomationState;
  at: number;
  reason?: string;
  messageID?: string;
  attempt: number;
  manual?: boolean;
}

export interface AutomationRecord extends AutomationStatus {
  batch: string;
  item: FeedbackItem;
  // When the coding turn's first model request passed its checks.
  startedAt?: number;
  // The findings the turn's prompt holds; see `findingsDigest`.
  digest?: string;
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
type ClaimHolder = 'free' | 'live' | 'running' | 'uncertain';

const CLAIM_HELD: Record<Exclude<ClaimHolder, 'free'>, string> = {
  live: 'Another feedback task is queued or running for this PR/MR',
  running: 'The earlier coding turn is still running',
  uncertain:
    'An earlier coding turn on this PR/MR has an uncertain outcome. Inspect the session, then use Retry feedback work to clear it.',
};

const ORPHANED = 'The owning session was deleted.';

// The states an attempt can move to. Every other change is a stale writer's,
// such as another instance's, and is dropped.
const TRANSITIONS: Record<AutomationState, readonly AutomationState[]> = {
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
export const automationBatch = (item: FeedbackItem) =>
  isJobFailure(item)
    ? pipelineBatch(item)
    : createHash('sha256')
        .update(
          JSON.stringify([
            item.url,
            [...(item.commentIDs ?? item.links)].sort(),
            item.postedAt ?? item.at,
          ]),
        )
        .digest('hex');

// The review rules that cover the PR/MR's project.
const reviewRules = (rules: readonly AutomationRule[], ref: ReviewRef) =>
  rules.filter(
    (rule): rule is ReviewAutomationRule =>
      rule.on === 'review' && rule.host === ref.host && rule.projects.includes(ref.project),
  );

export function automationReviewers(rules: readonly AutomationRule[], ref: ReviewRef): string[] {
  return [...new Set(reviewRules(rules, ref).flatMap((rule) => rule.reviewers))];
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

export const modelKey = (model: { providerID: string; id: string }) =>
  `${model.providerID}/${model.id}`;

// The models that may act on the findings, or undefined for any model. A
// reviewer's findings need a rule for the project and that reviewer that
// allows the model, so the batch needs a model every such reviewer allows.
export function allowedModelsFor(
  rules: readonly AutomationRule[],
  ref: ReviewRef,
  findings: readonly ReviewFinding[],
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
  // The failed jobs of a failed-job update's pipeline. Rejects with
  // `Ineligible` once it's no longer the PR/MR's head pipeline or fails.
  failures: (item: FeedbackItem) => Promise<PipelineFailures>;
  // Whether a failed-job update's pipeline finished or was replaced, so its
  // batch needn't wait for more failures.
  pipelineDone: (item: FeedbackItem) => Promise<boolean>;
  // The model the session's next turn uses, as `provider/model`.
  model: (sessionID: string) => Promise<string | undefined>;
  // Rejects with `Ineligible` when the batch can't run here. Automatic runs
  // also need the PR/MR to be the signed-in user's own, or for failed jobs,
  // one they review.
  validate: (item: FeedbackItem, automatic: boolean) => Promise<void>;
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const sameAttempt = (claim: ExecutionClaim | undefined, record: AutomationRecord | undefined) =>
  !!claim && !!record && claim.batch === record.batch && claim.messageID === record.messageID;

// Whether automation handles the update's delivery: while its attempt may
// still run, or once one ran. A batch that ended without running, such as a
// skipped one, keeps its normal delivery, such as a summary.
const handlesDelivery = (record: AutomationRecord | undefined) =>
  !record ||
  record.state === 'queued' ||
  record.state === 'running' ||
  record.state === 'completed' ||
  record.startedAt !== undefined;

interface PreparedExecution {
  // Identifies the data the prompt holds; see `findingsDigest`.
  digest: string;
  text: string;
}

export function createReviewAutomation(host: AutomationHost) {
  const queue = createKeyedQueue();
  const tasks = new Map<string, Promise<void>>();
  const now = host.now ?? Date.now;

  const ruleReviewers = (item: FeedbackItem) => {
    const ref = host.ref(item.url);
    return ref ? automationReviewers(host.rules, ref) : [];
  };

  // Whether a rule lets the update start a turn on its own.
  const ruleCovers = (item: FeedbackItem) => {
    if (!isJobFailure(item)) return !item.kind && ruleReviewers(item).length > 0;
    const ref = host.ref(item.url);
    return !!ref && investigatesJobs(host.rules, ref);
  };

  // An automatic run reads only the rules' reviewers' findings. A manual one
  // reads everyone's, tagging the reviewers whose rules restrict models.
  const readFindings = (item: FeedbackItem, manual: boolean) => {
    if (!manual) return host.findings(item, ruleReviewers(item));
    const ref = host.ref(item.url);
    const tagged = ref ? restrictedReviewers(host.rules, ref) : [];
    return host.findings(item, undefined, tagged.length ? tagged : undefined);
  };

  // Rejects with `Ineligible` when the session's model may not act on the
  // findings, or investigate the update's failed jobs.
  async function assertAllowedModel(item: FeedbackItem, findings: readonly ReviewFinding[] = []) {
    const ref = host.ref(item.url);
    const allowed =
      ref &&
      (isJobFailure(item)
        ? investigationModels(host.rules, ref)
        : allowedModelsFor(host.rules, ref, findings));
    if (!allowed) return;
    const refusal = modelRefusal(allowed, await host.model(item.sessionID), 'act');
    if (refusal) throw new Ineligible(refusal);
  }

  async function persistAutomationStatus(record: AutomationRecord, expected?: AutomationRecord) {
    if (!(await host.save(record, expected))) return undefined;
    await host.status(record.item, record);
    return record;
  }

  // Moves the attempt to `state`, if it's still the batch's attempt and the
  // move is allowed. With `release`, the attempt's PR/MR claim is freed in the
  // same write. Returns the stored record, or undefined when it wasn't.
  async function transitionAttempt(
    record: AutomationRecord,
    state: AutomationState,
    reason?: string,
    options: { from?: AutomationState; release?: boolean } = {},
  ): Promise<AutomationRecord | undefined> {
    for (let retry = 0; retry < 3; retry++) {
      const current = await host.read(record.batch);
      if (
        !current ||
        current.messageID !== record.messageID ||
        (options.from && current.state !== options.from) ||
        !TRANSITIONS[current.state].includes(state)
      )
        return undefined;
      const next: AutomationRecord = { ...current, state, at: now() };
      if (reason) next.reason = reason;
      else delete next.reason;
      if (!(await (options.release ? host.finish(next, current) : host.save(next, current))))
        continue;
      // An automatic attempt that ended without running hands the update
      // back to its normal delivery.
      if (!next.manual && !handlesDelivery(next)) host.redeliver(next.item);
      await host.status(next.item, next);
      return next;
    }
    throw new Error('Review attempt changed repeatedly while recording its outcome');
  }

  // Ends an attempt that this coordinator hasn't claimed. When another
  // coordinator holds the attempt's claim, it's running the attempt, and
  // records its outcome itself.
  async function settleUnclaimed(record: AutomationRecord, state: AutomationState, reason: string) {
    const claim = await host.claim.read(record.item.url).catch(() => undefined);
    if (sameAttempt(claim, record)) return;
    await transitionAttempt(record, state, reason, { from: 'queued' });
  }

  // Ends a queued or running attempt whose session was deleted, freeing its claim.
  async function settleOrphan(record: AutomationRecord) {
    if (record.state === 'queued' || record.state === 'running')
      await transitionAttempt(record, 'failed', ORPHANED, { release: true });
  }

  // Frees the PR/MR's claim once the attempt holding it can't run anymore:
  // its turn ended, or it failed before it started. With `force`, for an
  // explicit retry, a claim whose outcome is uncertain is freed too. A claim
  // whose attempt is still queued or running, or whose turn is still going,
  // always stays. Returns what still holds the PR/MR.
  async function reconcileClaim(url: string, force = false): Promise<ClaimHolder> {
    const claim = await host.claim.read(url);
    if (!claim) return 'free';
    const owner = await host.read(claim.batch);
    const attempt = sameAttempt(claim, owner) ? owner : undefined;
    // A deleted session runs nothing, so its attempt ends and its claim goes.
    if (!(await host.exists(claim.sessionID))) {
      if (attempt) await settleOrphan(attempt);
      await host.claim.release(url, claim);
      return 'free';
    }
    if (attempt?.state === 'queued' || attempt?.state === 'running') return 'live';
    const outcome = await host.outcome(claim);
    if (outcome === 'running') return 'running';
    const unstarted = attempt?.state === 'failed' && attempt.startedAt === undefined;
    if (
      !force &&
      outcome !== 'completed' &&
      outcome !== 'failed' &&
      !(outcome === 'pending' && unstarted)
    )
      return 'uncertain';
    await host.claim.release(url, claim);
    return 'free';
  }

  async function isQueuedAttempt(record: AutomationRecord) {
    const current = await host.read(record.batch);
    return current?.state === 'queued' && current.messageID === record.messageID;
  }

  async function assertPendingInboxItem(item: FeedbackItem) {
    if (host.closing()) throw new Error('The plugin stopped');
    const state = await host.inbox();
    if (state.paused) throw new Error('Feedback monitoring is paused');
    if (!state.items.some((entry) => sameUpdate(entry, item)))
      throw new Error('The update was acknowledged or is no longer in the inbox');
  }

  // Why the item's session doesn't own the PR/MR, or undefined when it does.
  async function ownershipConflictReason(item: FeedbackItem): Promise<string | undefined> {
    const sessions = [...new Set(await host.associations(item.url))];
    if (sessions.length !== 1 || sessions[0] !== item.sessionID)
      return `Expected exactly one associated session; found ${sessions.length}. Automatic action is skipped for this batch.`;
  }

  // Records a new attempt of the item's batch. Returns undefined when another
  // instance selected this attempt first.
  async function startAttempt(
    item: FeedbackItem,
    previous: AutomationRecord | undefined,
    options: { manual: boolean; skip?: string },
  ): Promise<AutomationRecord | undefined> {
    const batch = automationBatch(item);
    const attempt = (previous?.attempt ?? 0) + 1;
    const messageID = preparationMessageID(batch, attempt);
    return persistAutomationStatus(
      {
        batch,
        item,
        state: options.skip ? 'skipped' : 'queued',
        at: now(),
        attempt,
        messageID,
        ...(options.skip ? { reason: options.skip } : {}),
        ...(options.manual ? { manual: true } : {}),
      },
      previous,
    );
  }

  // Checks that the attempt may run, and reads and composes the findings it
  // acts on. Returns why it's skipped otherwise. Nothing reaches the session.
  async function prepareExecution(
    record: AutomationRecord,
  ): Promise<PreparedExecution | { skip: string }> {
    await assertPendingInboxItem(record.item);
    const conflict = await ownershipConflictReason(record.item);
    if (conflict) return { skip: conflict };
    if (!record.manual && !ruleCovers(record.item))
      return { skip: 'No automation rule matches this project now.' };
    let prepared: PreparedExecution;
    if (isJobFailure(record.item)) {
      const failures = await host.failures(record.item);
      await assertAllowedModel(record.item);
      prepared = {
        digest: failuresDigest(failures.jobs),
        text: investigationPrompt(record.item.url, failures),
      };
    } else {
      const findings = await readFindings(record.item, !!record.manual);
      if (!findings.length)
        return { skip: 'No current unresolved findings from authorized reviewers.' };
      await assertAllowedModel(record.item, findings);
      prepared = {
        digest: findingsDigest(findings),
        text: preparationPrompt(record.item.url, findings),
      };
    }
    await host.validate(record.item, !record.manual);
    await assertPendingInboxItem(record.item);
    return prepared;
  }

  // Waits until a failed-job batch's pipeline has had no new failure for the
  // quiet time, or finished. Later failures replace the batch's update, so
  // this returns the attempt as stored then, or undefined once it isn't
  // queued anymore.
  async function awaitQuietPipeline(
    record: AutomationRecord,
  ): Promise<AutomationRecord | undefined> {
    for (let check = 0; ; check++) {
      if (check > 0) await host.sleep(RECHECK_INTERVAL);
      if (host.closing()) return undefined;
      const current = await host.read(record.batch);
      if (current?.state !== 'queued' || current.messageID !== record.messageID) return undefined;
      if (now() - current.item.at >= INVESTIGATION_QUIET_TIME) return current;
      // A failed read only means waiting out the quiet time.
      if (await host.pipelineDone(current.item).catch(() => false)) return current;
    }
  }

  // Checks the claimed attempt once more, marks it running, and submits its
  // turn. Returns the running record once the prompt may have been admitted,
  // undefined when the attempt ended first, or `replaced` when a later
  // failure replaced a failed-job batch's update, so it waits again.
  async function submitExecution(
    record: AutomationRecord,
    prepared: PreparedExecution,
    admitting: () => void,
  ): Promise<AutomationRecord | 'replaced' | undefined> {
    if (!(await isQueuedAttempt(record))) return undefined;
    const conflict = await ownershipConflictReason(record.item);
    if (conflict) {
      await transitionAttempt(record, 'skipped', conflict);
      return undefined;
    }
    await host.validate(record.item, !record.manual);
    await assertPendingInboxItem(record.item);
    // A claim left by a finished attempt, such as one whose monitoring
    // failed, mustn't keep later feedback from running.
    await reconcileClaim(record.item.url).catch(() => undefined);
    const current = await host.read(record.batch);
    if (current?.state !== 'queued' || current.messageID !== record.messageID) return undefined;
    if (current.item.id !== record.item.id) return 'replaced';
    const running: AutomationRecord = {
      ...current,
      state: 'running',
      at: now(),
      digest: prepared.digest,
    };
    if (!(await host.start(running, current))) {
      // The stored attempt changed, rather than another execution holding
      // the PR/MR: a later failure replaced its update.
      const latest = await host.read(record.batch);
      if (
        latest?.state === 'queued' &&
        latest.messageID === record.messageID &&
        latest.item.id !== current.item.id
      )
        return 'replaced';
      await settleUnclaimed(
        record,
        'skipped',
        'Another execution owns this PR/MR. Inspect it before an explicit retry.',
      );
      return undefined;
    }
    admitting();
    await host.status(running.item, running);
    await host.submit(running, prepared.text);
    return running;
  }

  // Records the outcome of a running attempt, from its transcript, and frees
  // the PR/MR once the turn is over. Returns whether the turn is still going,
  // or still `pending` after `pending` earlier checks, or is over.
  async function checkExecution(
    record: AutomationRecord,
    pending: number,
  ): Promise<'running' | 'pending' | 'over'> {
    const current = await host.read(record.batch);
    if (current?.state !== 'running' || current.messageID !== record.messageID) return 'over';
    const claim = await host.claim.read(record.item.url);
    if (!claim || !sameAttempt(claim, record)) {
      await transitionAttempt(
        record,
        'failed',
        'Execution ownership is uncertain. Inspect the session before retrying.',
      );
      return 'over';
    }
    const outcome = await host.outcome(claim);
    if (outcome === 'running') return 'running';
    if (outcome === 'pending' && pending < ADMISSION_CHECKS) return 'pending';
    if (outcome === 'pending' || outcome === 'unknown') {
      await transitionAttempt(
        record,
        'failed',
        'The execution outcome is uncertain. Inspect the session and explicitly retry.',
      );
      return 'over';
    }
    await transitionAttempt(
      record,
      outcome,
      outcome === 'failed'
        ? `The ${isJobFailure(record.item) ? 'investigation' : 'coding'} turn failed or was interrupted.`
        : isJobFailure(record.item)
          ? 'The investigation finished. See the session for its causes and recommended fixes.'
          : 'The coding turn finished. See the session for changes, checks, and skipped findings.',
      { release: true },
    );
    return 'over';
  }

  // Waits for a running attempt's turn to end. It depends only on the stored
  // record, not the inbox update, so acknowledging the update doesn't stop it.
  // A check that fails, such as a transcript that can't be read for a moment,
  // is retried a few times before the attempt fails.
  async function monitorExecution(record: AutomationRecord) {
    for (let check = 0, pending = 0, errors = 0; ; check++) {
      if (check > 0) await host.sleep(RECHECK_INTERVAL);
      try {
        await host.wait(record.item.sessionID);
        if (host.closing()) return;
        const state = await checkExecution(record, pending);
        if (state === 'over') return;
        pending = state === 'pending' ? pending + 1 : 0;
        errors = 0;
      } catch (error) {
        if (host.closing()) return;
        if (++errors >= ADMISSION_CHECKS) throw error;
      }
    }
  }

  async function execute(queued: AutomationRecord) {
    let admitted = false;
    let record = queued;
    try {
      // A later failure that replaces a failed-job batch's update before the
      // turn starts restarts its quiet time, even while the session is busy.
      for (;;) {
        if (isJobFailure(record.item)) {
          const quiet = await awaitQuietPipeline(record);
          if (!quiet) return;
          record = quiet;
        }
        await host.wait(record.item.sessionID);
        const current = await host.read(record.batch);
        if (current?.state !== 'queued' || current.messageID !== record.messageID) return;
        const replaced = current.item.id !== record.item.id;
        record = current;
        if (replaced) continue;
        const prepared = await prepareExecution(record);
        if ('skip' in prepared) {
          await settleUnclaimed(record, 'skipped', prepared.skip);
          return;
        }
        const running = await submitExecution(record, prepared, () => (admitted = true));
        if (running === 'replaced') continue;
        if (running) await monitorExecution(running);
        return;
      }
    } catch (error) {
      if (host.closing()) return;
      const reason = `${message(error)}${admitted ? ' Inspect the session before retrying.' : ''}`;
      if (admitted) await transitionAttempt(record, 'failed', reason);
      else
        await settleUnclaimed(record, error instanceof Ineligible ? 'skipped' : 'failed', reason);
    }
  }

  async function monitorStored(record: AutomationRecord) {
    try {
      await monitorExecution(record);
    } catch (error) {
      if (!host.closing())
        await transitionAttempt(
          record,
          'failed',
          `${message(error)} Inspect the session before retrying.`,
        );
    }
  }

  const launch = (batch: string, work: () => Promise<void>) => {
    if (tasks.has(batch) || host.closing()) return;
    const task = work()
      .catch(host.error)
      .finally(() => tasks.delete(batch));
    tasks.set(batch, task);
  };

  // Continues a stored attempt: queued work runs, and running work is watched.
  function resume(record: AutomationRecord) {
    if (record.state === 'queued') launch(record.batch, () => execute(record));
    else if (record.state === 'running') launch(record.batch, () => monitorStored(record));
  }

  return {
    // Selects a newly recorded update for automation, under the configured
    // rules. Returns whether automation handles its delivery. Rejects, so the
    // inbox retries, while session ownership can't be established.
    async selectAutomatic(item: FeedbackItem): Promise<boolean> {
      const allowed = !!item.automationAllowed && ruleCovers(item);
      // A failed-job update can replace one of a batch that already exists,
      // such as a manual investigation on a project without a rule, so its
      // batch is looked up before the rule decides about a new one.
      if (!allowed && !isJobFailure(item)) return false;
      const batch = automationBatch(item);
      return queue.run(batch, async () => {
        let existing = await host.read(batch);
        if (!existing && !allowed) return false;
        // A later failure in a pipeline batch whose turn hasn't reached its
        // first model request replaces its update, which restarts the
        // batch's quiet time. That request waits for it to pass.
        if (
          (existing?.state === 'queued' ||
            (existing?.state === 'running' && existing.startedAt === undefined)) &&
          isJobFailure(item) &&
          existing.item.sessionID === item.sessionID &&
          existing.item.id !== item.id &&
          item.at >= existing.item.at
        ) {
          const updated = { ...existing, item };
          if (await host.save(updated, existing)) existing = updated;
        }
        if (existing) {
          await host.status(item, existing);
          if (existing.item.sessionID === item.sessionID) resume(existing);
          return handlesDelivery(existing);
        }
        await assertPendingInboxItem(item);
        // Stored before reading findings, which can fail, so an ambiguous
        // batch stays skipped even if the other association goes away.
        const conflict = await ownershipConflictReason(item);
        if (conflict) {
          await startAttempt(item, undefined, { manual: false, skip: conflict });
          return false;
        }
        if (isJobFailure(item)) {
          // Checked before queuing, like review batches below. The failed
          // jobs are read once the pipeline goes quiet.
          try {
            await assertAllowedModel(item);
            await host.validate(item, true);
          } catch (error) {
            if (!(error instanceof Ineligible)) throw error;
            await startAttempt(item, undefined, { manual: false, skip: error.message });
            return false;
          }
          const record = await startAttempt(item, undefined, { manual: false });
          if (record) resume(record);
          return true;
        }
        const findings = await readFindings(item, false);
        if (!findings.length) {
          await startAttempt(item, undefined, {
            manual: false,
            skip: 'No findings from authorized reviewers.',
          });
          return false;
        }
        // Checked before queuing, so a batch that can't run here, such as
        // someone else's PR/MR, or one the session's model may not act on,
        // gets its normal delivery right away.
        try {
          await assertAllowedModel(item, findings);
          await host.validate(item, true);
        } catch (error) {
          if (!(error instanceof Ineligible)) throw error;
          await startAttempt(item, undefined, { manual: false, skip: error.message });
          return false;
        }
        const record = await startAttempt(item, undefined, { manual: false });
        if (record) resume(record);
        return true;
      });
    },

    // Acts on an update on request, without an automation rule. A batch that
    // already ran needs `retry`.
    async act(item: FeedbackItem, retry = false): Promise<void> {
      if (item.kind && !isJobFailure(item))
        throw new Error('Act on feedback is available only for review and failed-job updates');
      const batch = automationBatch(item);
      await queue.run(batch, async () => {
        let existing = await host.read(batch);
        // A skipped batch never ran, so another session may take it over, as
        // may any session once the batch's session is deleted. The ownership
        // check below still applies.
        if (
          existing &&
          existing.item.sessionID !== item.sessionID &&
          existing.state !== 'skipped'
        ) {
          if (await host.exists(existing.item.sessionID))
            throw new Error('This batch belongs to another session; inspect its execution first');
          await settleOrphan(existing);
          existing = await host.read(batch);
        }
        if (tasks.has(batch) || existing?.state === 'queued' || existing?.state === 'running')
          throw new Error('Feedback work is already queued or running');
        if (existing && existing.state !== 'skipped' && !retry)
          throw new Error('This batch already has an automation outcome. Use explicit retry.');
        await assertPendingInboxItem(item);
        // An earlier attempt's claim, of this batch or another, is freed
        // once its turn is over, or on explicit retry once it's uncertain.
        const holder = await reconcileClaim(item.url, retry);
        if (holder !== 'free') throw new Error(CLAIM_HELD[holder]);
        const conflict = await ownershipConflictReason(item);
        const record = await startAttempt(item, existing, {
          manual: true,
          ...(conflict ? { skip: conflict } : {}),
        });
        if (!record) throw new Error('Another instance selected this batch first');
        resume(record);
      });
    },

    // Ends a running attempt whose turn was refused before its first model
    // request. Nothing ran, so the PR/MR is free again.
    async abandon(record: AutomationRecord, reason: string) {
      await transitionAttempt(record, 'failed', reason, { release: true });
    },

    // Records how the session's turn ended, for its running attempts that
    // started before the end. Only the first end after a start counts: it's
    // the end of the attempt's own turn, even if a compaction removes the
    // turn's prompt and a later turn ends differently.
    async turnEnded(sessionID: string, outcome: 'succeeded' | 'failed', at: number) {
      for (const record of await host.list()) {
        if (
          record.item.sessionID !== sessionID ||
          record.state !== 'running' ||
          record.startedAt === undefined ||
          record.ended ||
          at < record.startedAt
        )
          continue;
        await host.save({ ...record, ended: { outcome, at } }, record);
      }
    },

    // Continues the stored attempts after a reload, without waiting for them.
    restore(records: readonly AutomationRecord[]) {
      for (const record of records) resume(record);
    },

    tasks: () => [...tasks.values()],
  };
}
