// Connects review automation to OpenCode and the forges: who owns a PR/MR,
// which findings are verified, whether the checkout matches, and how a
// coding turn ended.
import type { Plugin } from '@opencode/plugin';
import { environmentProvider, type StartContext } from './automation-environment';
import { isApproval, type FeedbackItem, type InboxState } from './feedback-inbox';
import { pipelineRunning } from './forge';
import { parseReference, parseUrl, requestNoun, traitsOf } from './forges';
import {
  INVESTIGATION_INSTRUCTIONS,
  INVESTIGATION_QUIET_TIME,
  investigatesJobs,
  investigationModels,
  isJobFailure,
  sameUpdate,
} from './job-investigation';
import {
  freshPresence,
  linkedOwner,
  placeholderMessageID,
  presenceKey,
  type DirectorySession,
} from './linked-session';
import { createLocalEnvironment, localRunnerOf as runnerOf } from './local-automation-environment';
import type { AutomationRule } from './options';
import {
  allowedModelsFor,
  automationReviewers,
  environmentExecution,
  Ineligible,
  modelKey,
  modelRefusal,
  RECHECK_INTERVAL,
  restrictedReviewers,
  type AutomationHost,
  type AutomationRecord,
  type AutomationStatus,
  type ExecutionOutcome,
  type LinkedRecord,
  type Placement,
  type Validation,
} from './review-automation';
import {
  authorizeApprovalContinuation,
  authorizeApprovalStart,
  markApprovalReady,
  readApprovalStatus,
  storedPreparation,
  type ApprovalTurnHost,
  type MarkReadyInvocation,
} from './review-automation-approval-turn';
import {
  checkoutMismatch,
  createAuthorResolver,
  currentRequest,
  readFailures,
  readVerifiedApprovals,
  readVerifiedFindings,
  resolvePolicy,
  type AutomationDependencies,
  type AutomationEnvironment,
} from './review-automation-verification';
import { createReviewClaims, type ExecutionClaim } from './review-claim';
import {
  APPROVAL_INSTRUCTIONS,
  findingsDigest,
  PREPARATION_INSTRUCTIONS,
  preparationBatch,
} from './review-preparation';
import { isForgekeeperInput } from './review-summary';
import { includesRequest, type Target } from './target';

export {
  readVerifiedApprovals,
  readVerifiedFindings,
  storedPreparation,
  type AutomationDependencies,
  type AutomationEnvironment,
  type MarkReadyInvocation,
};

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
  const resolveAuthor = createAuthorResolver(deps, directory, env.warn);

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

  const approvalTurnHost: ApprovalTurnHost = {
    ctx,
    deps,
    env,
    directory,
    claims,
    read,
    save,
    approvals,
    model,
    resolveAuthor,
    assertPending,
    assertSoleOwner,
    startedRecord,
  };

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
      let forgekeeper: 'job-investigate' | 'review-approval' | 'review-prepare' = 'review-prepare';
      if (isJobFailure(record.item)) forgekeeper = 'job-investigate';
      else if (isApproval(record.item)) forgekeeper = 'review-approval';
      await ctx.session.prompt({
        sessionID: record.item.sessionID,
        id: record.messageID,
        text,
        metadata: {
          forgekeeper,
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
      let base = PREPARATION_INSTRUCTIONS;
      if (isJobFailure(record.item)) base = INVESTIGATION_INSTRUCTIONS;
      else if (isApproval(record.item)) base = APPROVAL_INSTRUCTIONS;
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
        return authorizeApprovalStart(approvalTurnHost, start, record, ref, requested);
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
    authorizeContinuation: (record: AutomationRecord, requested: string) =>
      authorizeApprovalContinuation(approvalTurnHost, record, requested),

    // Reads live status for the PR/MR bound to the active approval follow-up turn
    // and updates the turn's last-inspected readiness snapshot.
    approvalStatus: (sessionID: string, signal?: AbortSignal) =>
      readApprovalStatus(approvalTurnHost, sessionID, signal),

    // Marks the verified draft PR/MR for the active approval follow-up turn ready
    // for review, asserting session permission and re-checking authorization,
    // turn identity, cancellation, ownership, active approval, and readiness
    // snapshot freshness both before and after permission, and immediately before
    // dispatching the forge write.
    markApprovalReady: (invocation: MarkReadyInvocation) =>
      markApprovalReady(approvalTurnHost, invocation),

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
