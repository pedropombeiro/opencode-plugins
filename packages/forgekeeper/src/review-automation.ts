// Acts on review feedback from authorized reviewers: one coding turn per
// review batch, in the one session that targets the PR/MR. Each attempt is
// stored, so a reload resumes or reconciles it instead of starting it again.
import { environmentProvider, EnvironmentUncertain } from './automation-environment';
import { isApproval, type FeedbackItem } from './feedback-inbox';
import { approversOf } from './forge';
import { parseReference, requestNoun } from './forges';
import {
  failuresDigest,
  INVESTIGATION_QUIET_TIME,
  investigatesJobs,
  investigationModels,
  investigationPrompt,
  isJobFailure,
  sameUpdate,
} from './job-investigation';
import { createKeyedQueue } from './keyed-queue';
import type { AutomationRule } from './options';
import {
  ADMISSION_CHECKS,
  allowedModelsFor,
  automationBatch,
  automationReviewers,
  claimHeldMessage,
  environmentExecution,
  handlesDelivery,
  Ineligible,
  matchesApprovalRule,
  modelKey,
  modelRefusal,
  ORPHANED,
  RECHECK_INTERVAL,
  restrictedReviewers,
  sameAttempt,
  TRANSITIONS,
  type ApprovalContext,
  type AutomationHost,
  type AutomationRecord,
  type AutomationState,
  type AutomationStatus,
  type ClaimHolder,
  type Execution,
  type ExecutionOutcome,
  type LinkedRecord,
  type ModelRemedy,
  type PipelineFailures,
  type Placement,
  type ProvisioningExecution,
  type ReviewFinding,
  type SubmittingExecution,
  type Validation,
  type VerifiedApproval,
} from './review-automation-rules';
import type { ExecutionClaim } from './review-claim';
import {
  approvalDigest,
  approvalPrompt,
  findingsDigest,
  preparationMessageID,
  preparationPrompt,
  readinessDigest,
} from './review-preparation';

export {
  ADMISSION_CHECKS,
  allowedModelsFor,
  automationBatch,
  automationReviewers,
  environmentExecution,
  Ineligible,
  matchesApprovalRule,
  modelKey,
  modelRefusal,
  RECHECK_INTERVAL,
  restrictedReviewers,
  type ApprovalContext,
  type AutomationHost,
  type AutomationRecord,
  type AutomationState,
  type AutomationStatus,
  type Execution,
  type ExecutionOutcome,
  type LinkedRecord,
  type ModelRemedy,
  type PipelineFailures,
  type Placement,
  type ProvisioningExecution,
  type ReviewFinding,
  type SubmittingExecution,
  type Validation,
  type VerifiedApproval,
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface PreparedExecution {
  // Identifies the data the prompt holds; see `findingsDigest`.
  digest: string;
  readiness?: string;
  text: string;
  placement: Placement;
  // The models that may run the turn, or undefined for any.
  models?: string[];
}

export function createReviewAutomation(host: AutomationHost) {
  const queue = createKeyedQueue();
  const tasks = new Map<string, Promise<void>>();
  const now = host.now ?? Date.now;
  const providerOf = (record: AutomationRecord) => environmentProvider(host.environments, record);
  const executionExists = (record: AutomationRecord) =>
    record.execution ? providerOf(record).exists(record) : host.exists(record.item.sessionID);
  const outcomeOf = async (claim: ExecutionClaim) => {
    const record = await host.read(claim.batch);
    return record?.execution && sameAttempt(claim, record)
      ? providerOf(record).outcome(record)
      : host.outcome(claim);
  };

  const ruleReviewers = (item: FeedbackItem) => {
    const ref = host.ref(item.url);
    return ref ? automationReviewers(host.rules, ref) : [];
  };

  // Whether a rule lets the update start a turn on its own.
  const ruleCovers = (item: FeedbackItem) => {
    const ref = host.ref(item.url);
    if (!ref) return false;
    if (isJobFailure(item)) return investigatesJobs(host.rules, ref);
    if (isApproval(item))
      return item.approverKind !== 'human' && matchesApprovalRule(host.rules, ref, item.reviewers);
    return !item.kind && ruleReviewers(item).length > 0;
  };

  // The reviewers whose findings count, and those whose findings name their
  // reviewer. An automatic run reads only the findings of the reviewers of
  // `rules`, the rules that apply to the PR/MR's author. A manual one reads
  // everyone's, tagging the reviewers whose rules restrict models.
  const findingsPolicy = (
    item: FeedbackItem,
    manual: boolean,
    rules: readonly AutomationRule[],
  ): { reviewers?: string[]; tagged?: string[] } => {
    const ref = host.ref(item.url);
    if (!manual) return { reviewers: ref ? automationReviewers(rules, ref) : [] };
    const tagged = ref ? restrictedReviewers(host.rules, ref) : [];
    return tagged.length ? { tagged } : {};
  };
  const readFindings = (item: FeedbackItem, manual: boolean, rules: readonly AutomationRule[]) => {
    const policy = findingsPolicy(item, manual, rules);
    return host.findings(item, policy.reviewers, policy.tagged);
  };
  const readApprovals = (item: FeedbackItem, rules: readonly AutomationRule[]) => {
    if (!host.approvals) throw new Error('Approval automation is unavailable');
    const ref = host.ref(item.url);
    return host.approvals(item, ref ? automationReviewers(rules, ref) : []);
  };

  // Rejects with `Ineligible` when the session's model may not act on the
  // findings, or investigate the update's failed jobs, under `rules`.
  // Returns the models that may, or undefined for any.
  async function assertAllowedModel(
    item: FeedbackItem,
    rules: readonly AutomationRule[],
    findings: readonly { reviewer?: string }[] = [],
  ): Promise<string[] | undefined> {
    const ref = host.ref(item.url);
    const allowed =
      ref &&
      (isJobFailure(item)
        ? investigationModels(rules, ref)
        : allowedModelsFor(rules, ref, findings));
    if (!allowed) return undefined;
    const refusal = modelRefusal(allowed, await host.model(item.sessionID), 'act');
    if (refusal) throw new Ineligible(refusal);
    return allowed;
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

  // Ends a queued or running attempt whose session was deleted, freeing its
  // claim. A linked session's turn outlives its owner, so its transcript
  // says how the attempt ended. Rejects while that turn is still going.
  async function settleOrphan(record: AutomationRecord) {
    if (record.state !== 'queued' && record.state !== 'running') return;
    const linked = record.execution;
    if (
      record.state === 'running' &&
      linked?.stage === 'submitting' &&
      (await executionExists(record))
    ) {
      // Without more checks to wait for, an outcome that's still pending
      // becomes uncertain, which an explicit retry can clear.
      if ((await checkExecution(record, ADMISSION_CHECKS)) === 'running')
        throw new Error('This batch is still running in its linked session; inspect it first');
      return;
    }
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
    // A linked session runs the turn, so it's the one that counts.
    if (!(await (attempt ? executionExists(attempt) : host.exists(claim.sessionID)))) {
      if (attempt && (attempt.state === 'queued' || attempt.state === 'running'))
        await transitionAttempt(attempt, 'failed', ORPHANED, { release: true });
      await host.claim.release(url, claim);
      return 'free';
    }
    if (attempt?.state === 'queued' || attempt?.state === 'running') return 'live';
    const outcome = await outcomeOf(claim);
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
    options: { manual: boolean; skip?: string; placement?: Placement | void },
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
        ...(options.placement === 'environment' ? { placement: options.placement } : {}),
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
    if (isApproval(record.item) && host.watchesApproval && !host.watchesApproval(record.item))
      return { skip: 'This reviewer approval is no longer watched.' };
    if ((!record.manual || isApproval(record.item)) && !ruleCovers(record.item))
      return { skip: 'No automation rule matches this project now.' };
    const { placement, rules } = await host.validate(
      record.item,
      !record.manual || isApproval(record.item),
    );
    let prepared: Omit<PreparedExecution, 'placement'>;
    if (isJobFailure(record.item)) {
      const failures = await host.failures(record.item);
      const models = await assertAllowedModel(record.item, rules);
      prepared = {
        digest: failuresDigest(failures.jobs),
        text: investigationPrompt(record.item.url, failures),
        ...(models ? { models } : {}),
      };
    } else if (isApproval(record.item)) {
      const { request, approvers } = await readApprovals(record.item, rules);
      if (!approvers.length)
        return { skip: 'No active approval from authorized non-human reviewers.' };
      const models = await assertAllowedModel(record.item, rules, approvers);
      const statusApprovers = approversOf(request).length ? approversOf(request) : approvers;
      prepared = {
        digest: approvalDigest(approvers),
        readiness: readinessDigest(request, statusApprovers),
        text: approvalPrompt(request, statusApprovers),
        ...(models ? { models } : {}),
      };
    } else {
      const policy = findingsPolicy(record.item, !!record.manual, rules);
      const findings = await host.findings(record.item, policy.reviewers, policy.tagged);
      if (!findings.length)
        return { skip: 'No current unresolved findings from authorized reviewers.' };
      const models = await assertAllowedModel(record.item, rules, findings);
      prepared = {
        digest: findingsDigest(findings),
        text: preparationPrompt(record.item.url, findings),
        ...(models ? { models } : {}),
      };
    }
    await assertPendingInboxItem(record.item);
    return { ...prepared, placement };
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
    const { placement } = await host.validate(
      record.item,
      !record.manual || isApproval(record.item),
    );
    // The owning checkout moved, so the attempt waits where it now runs.
    if (placement !== prepared.placement) return 'replaced';
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
      ...(prepared.readiness ? { readiness: prepared.readiness } : {}),
      ...(placement === 'environment' ? { placement } : {}),
    };
    if (placement === 'environment') {
      const provider = environmentProvider(host.environments);
      running.execution = {
        stage: 'provisioning',
        provider: provider.id,
        version: provider.version,
        state: {},
      };
    }
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
        `Another execution owns this ${requestNoun(parseReference(record.item.url)?.ref.forge)}. Inspect it before an explicit retry.`,
      );
      return undefined;
    }
    if (placement === 'environment') return submitLinked(running, prepared, admitting);
    admitting();
    await host.status(running.item, running);
    const submittedAt = now();
    await host.submit(running, prepared.text);
    const currentAfter = await host.read(running.batch);
    if (
      currentAfter &&
      currentAfter.state === 'running' &&
      currentAfter.messageID === running.messageID &&
      currentAfter.submittedAt === undefined
    ) {
      const saved = { ...currentAfter, submittedAt };
      if (await host.save(saved, currentAfter)) return saved;
    }
    return running;
  }

  async function submitLinked(
    running: AutomationRecord,
    prepared: PreparedExecution,
    admitting: () => void,
  ): Promise<AutomationRecord | undefined> {
    let stored = running;
    const provider = environmentProvider(
      host.environments,
      running.execution ? running : undefined,
    );
    // Stores `change` of the attempt as stored now. A later failure of a
    // failed-job batch replaces its update meanwhile, which the change
    // keeps, since the first model request waits out its quiet time. Any
    // other change, such as the attempt ending, stops the preparation.
    const save = async (change: (current: AutomationRecord) => AutomationRecord) => {
      for (let retry = 0; retry < 3; retry++) {
        const current = await host.read(stored.batch);
        if (
          !current ||
          JSON.stringify({ ...current, item: stored.item }) !== JSON.stringify(stored) ||
          (current.item.id !== stored.item.id &&
            !(isJobFailure(current.item) && sameUpdate(current.item, stored.item)))
        )
          throw new Error('Review automation changed while preparing its environment');
        const next = change(current);
        if (await host.save(next, current)) return (stored = next);
      }
      throw new Error('Review automation changed repeatedly while preparing its environment');
    };
    const update = (patch: Partial<ProvisioningExecution>) => {
      if (stored.execution?.stage === 'submitting')
        throw new Error('Review automation submitted its turn already');
      if (
        (patch.provider !== undefined && patch.provider !== provider.id) ||
        (patch.version !== undefined && patch.version !== provider.version)
      )
        throw new Error('An attempt cannot change its execution provider');
      return save((current) => ({
        ...current,
        execution: { ...current.execution!, ...patch } as ProvisioningExecution,
      }));
    };
    try {
      await host.status(stored.item, stored);
      if (!stored.execution)
        await update({
          stage: 'provisioning',
          provider: provider.id,
          version: provider.version,
          state: {},
        });
      stored = await provider.provision(stored, update);
      const { execution } = stored;
      if (execution?.stage !== 'provisioning')
        throw new Error("The execution environment wasn't prepared");
      const next: LinkedRecord = {
        ...stored,
        execution: {
          ...execution,
          stage: 'submitting',
          prompt: prepared.text,
        },
      };
      if (prepared.models) next.models = prepared.models;
      await providerOf(next).verify(next);
      const latest = await host.read(stored.batch);
      await assertPendingInboxItem(latest?.item ?? stored.item);
      const conflict = await ownershipConflictReason(stored.item);
      if (conflict) throw new Error(conflict);
      await save((current) => ({ ...next, item: current.item }));
    } catch (error) {
      if (host.closing()) return undefined;
      await transitionAttempt(stored, 'failed', message(error), {
        release: !(error instanceof EnvironmentUncertain),
      });
      const ended = await host.read(stored.batch).catch(() => undefined);
      if (ended?.execution) await host.notify?.(ended, 'ended').catch(() => {});
      return undefined;
    }
    admitting();
    await providerOf(stored).submit(stored as LinkedRecord);
    return stored;
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
    const outcome = await outcomeOf(claim);
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
    // A linked turn's first request records its start, in the worktree's
    // instance. Without one, Forgekeeper wasn't running there, so the turn
    // never got its task.
    if (outcome === 'completed' && current.execution && current.startedAt === undefined) {
      await transitionAttempt(
        record,
        'failed',
        "The linked session's turn ended before Forgekeeper checked it, so it never got its task. Check that Forgekeeper runs in the execution environment, then retry.",
        { release: true },
      );
      return 'over';
    }
    const turnDescription = (): string => {
      if (outcome === 'failed') {
        let kind = 'coding';
        if (isJobFailure(record.item)) kind = 'investigation';
        else if (isApproval(record.item)) kind = 'approval follow-up';
        return `The ${kind} turn failed or was interrupted.`;
      }
      if (isJobFailure(record.item)) {
        return 'The investigation finished. See the session for its causes and recommended fixes.';
      }
      if (isApproval(record.item)) {
        return 'The approval follow-up finished. See the session for the status and any actions taken.';
      }
      return 'The coding turn finished. See the session for changes, checks, and skipped findings.';
    };
    await transitionAttempt(record, outcome, turnDescription(), { release: true });
    return 'over';
  }

  // Reports a linked session's attempt that ended. The worktree's instance
  // may have ended it, such as when its first request was refused, and it
  // can't reach the owning session's inbox, so the owner's instance does.
  async function linkedEnded(record: AutomationRecord) {
    const ended = await host.read(record.batch);
    if (!ended || ended.messageID !== record.messageID || !ended.execution) return;
    if (ended.state === 'queued' || ended.state === 'running') return;
    await host.status(ended.item, ended);
    if (!ended.manual && !handlesDelivery(ended)) host.redeliver(ended.item);
    await host.notify?.(ended, 'ended').catch(() => {});
  }

  // Waits for a running attempt's turn to end. It depends only on the stored
  // record, not the inbox update, so acknowledging the update doesn't stop it.
  // A check that fails, such as a transcript that can't be read for a moment,
  // is retried a few times before the attempt fails.
  async function monitorExecution(record: AutomationRecord) {
    const stored = await host.read(record.batch);
    if (
      stored?.state === 'running' &&
      stored.messageID === record.messageID &&
      stored.execution?.stage === 'provisioning'
    ) {
      await providerOf(stored).recover(stored);
      const prepared = await prepareExecution(stored);
      if ('skip' in prepared) {
        await transitionAttempt(stored, 'failed', prepared.skip, { release: true });
        return;
      }
      if (prepared.placement !== 'environment') {
        await transitionAttempt(
          stored,
          'failed',
          'The execution placement changed during provisioning. Retry feedback work.',
          { release: true },
        );
        return;
      }
      if (prepared.digest !== stored.digest) {
        await transitionAttempt(
          stored,
          'failed',
          'The task changed during interrupted provisioning. Retry feedback work.',
          { release: true },
        );
        return;
      }
      const resumed = await submitLinked(stored, prepared, () => {});
      if (resumed) await monitorExecution(resumed);
      return;
    }
    if (stored && stored.messageID === record.messageID && stored.execution) record = stored;
    for (let check = 0, pending = 0, errors = 0; ; check++) {
      if (check > 0) await host.sleep(RECHECK_INTERVAL);
      try {
        if (record.execution) await providerOf(record).wait(record);
        else await host.wait(record.item.sessionID);
        if (host.closing()) return;
        const state = await checkExecution(record, pending);
        if (state === 'over') {
          if (record.execution) await linkedEnded(record);
          return;
        }
        pending = state === 'pending' ? pending + 1 : 0;
        errors = 0;
      } catch (error) {
        if (host.closing()) return;
        if (++errors >= ADMISSION_CHECKS) throw error;
      }
    }
  }

  // Records where a manual attempt runs, which its selection didn't, so a
  // turn in a worktree doesn't wait for the owning session. A check that
  // fails leaves it to the checks before the turn. Returns the attempt as
  // stored.
  async function placeManual(record: AutomationRecord): Promise<AutomationRecord> {
    if (!record.manual || record.placement) return record;
    const validation = await host
      .validate(record.item, isApproval(record.item))
      .catch(() => undefined);
    if (validation?.placement !== 'environment') return record;
    const placed: AutomationRecord = { ...record, placement: 'environment' };
    return (await host.save(placed, record)) ? placed : record;
  }

  async function execute(queued: AutomationRecord) {
    let admitted = false;
    let record = queued;
    try {
      record = await placeManual(record);
      // A later failure that replaces a failed-job batch's update before the
      // turn starts restarts its quiet time, even while the session is busy.
      for (;;) {
        if (isJobFailure(record.item)) {
          const quiet = await awaitQuietPipeline(record);
          if (!quiet) return;
          record = quiet;
        }
        // A turn in a worktree doesn't wait for the owning session.
        if (record.placement !== 'environment') await host.wait(record.item.sessionID);
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
        if (prepared.placement !== (record.placement ?? 'session')) {
          const moved: AutomationRecord = { ...record, placement: prepared.placement };
          if (prepared.placement === 'session') delete moved.placement;
          if (!(await host.save(moved, record))) return;
          record = moved;
          continue;
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
        // Checked before queuing, so a batch that can't run here, such as
        // someone else's PR/MR, or one the session's model may not act on,
        // gets its normal delivery right away. The rules that apply to the
        // PR/MR's author decide whose findings count.
        let validation: Validation;
        try {
          validation = await host.validate(item, true);
          if (isJobFailure(item)) await assertAllowedModel(item, validation.rules);
        } catch (error) {
          if (!(error instanceof Ineligible)) throw error;
          await startAttempt(item, undefined, { manual: false, skip: error.message });
          return false;
        }
        const { rules, placement } = validation;
        if (isJobFailure(item)) {
          // The failed jobs are read once the pipeline goes quiet.
          const record = await startAttempt(item, undefined, { manual: false, placement });
          if (record) resume(record);
          return true;
        }
        if (isApproval(item)) {
          if (host.watchesApproval && !host.watchesApproval(item)) {
            await startAttempt(item, undefined, {
              manual: false,
              skip: 'This reviewer approval is no longer watched.',
            });
            return false;
          }
          let approval: ApprovalContext;
          try {
            approval = await readApprovals(item, rules);
          } catch (error) {
            if (!(error instanceof Ineligible)) throw error;
            await startAttempt(item, undefined, { manual: false, skip: error.message });
            return false;
          }
          if (!approval.approvers.length) {
            await startAttempt(item, undefined, {
              manual: false,
              skip: 'No active approval from authorized non-human reviewers.',
            });
            return false;
          }
          try {
            await assertAllowedModel(item, rules, approval.approvers);
          } catch (error) {
            if (!(error instanceof Ineligible)) throw error;
            await startAttempt(item, undefined, { manual: false, skip: error.message });
            return false;
          }
          const record = await startAttempt(item, undefined, { manual: false, placement });
          if (record) resume(record);
          return true;
        }
        const findings = await readFindings(item, false, rules);
        if (!findings.length) {
          await startAttempt(item, undefined, {
            manual: false,
            skip: 'No findings from authorized reviewers.',
          });
          return false;
        }
        try {
          await assertAllowedModel(item, rules, findings);
        } catch (error) {
          if (!(error instanceof Ineligible)) throw error;
          await startAttempt(item, undefined, { manual: false, skip: error.message });
          return false;
        }
        const record = await startAttempt(item, undefined, { manual: false, placement });
        if (record) resume(record);
        return true;
      });
    },

    // Acts on an update on request, without an automation rule. A batch that
    // already ran needs `retry`.
    async act(item: FeedbackItem, retry = false): Promise<void> {
      if (item.humanApprovalOnly)
        throw new Error('Human reviewer approvals cannot start a turn with tools');
      if (item.kind && !isJobFailure(item) && !isApproval(item))
        throw new Error(
          'Act on feedback is available only for review, approval, and failed-job updates',
        );
      if (isApproval(item)) {
        if (item.approverKind === 'human')
          throw new Error('Human reviewer approvals cannot start a turn with tools');
        if (host.watchesApproval && !host.watchesApproval(item))
          throw new Error('This reviewer approval is no longer watched');
        if (!ruleCovers(item))
          throw new Error(
            'No automation rule authorizes follow-up turns for this reviewer approval',
          );
      }
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
        if (holder !== 'free') throw new Error(claimHeldMessage(holder, item.url));
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
          record.state !== 'running' ||
          record.startedAt === undefined ||
          record.ended ||
          at < record.startedAt
        )
          continue;
        if (record.execution) {
          const provider = host.environments?.providers.find(
            (entry) =>
              entry.id === record.execution?.provider && entry.version === record.execution.version,
          );
          if (!provider?.matchesSession(record, sessionID)) continue;
        } else if (record.item.sessionID !== sessionID) continue;
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
