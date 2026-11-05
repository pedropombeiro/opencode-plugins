// Connects review automation to OpenCode and the forges: who owns a PR/MR,
// which findings are verified, whether the checkout matches, and how a
// coding turn ended.
import type { Plugin } from '@opencode/plugin';
import type { FeedbackItem, InboxState } from './feedback-inbox';
import type { FeedbackSnapshot, ReviewRef, ReviewRequest } from './forge';
import { parseUrl, traitsOf, type ForgeCatalog } from './forges';
import type { ReviewAutomationRule } from './options';
import {
  allowedModelsFor,
  automationReviewers,
  Ineligible,
  modelKey,
  modelRefusal,
  restrictedReviewers,
  type ReviewFinding,
  type AutomationHost,
  type AutomationRecord,
  type AutomationStatus,
  type ExecutionOutcome,
} from './review-automation';
import { createReviewClaims, type ExecutionClaim } from './review-claim';
import { findingsDigest, preparationBatch } from './review-preparation';
import { isForgekeeperInput, turnInput } from './review-summary';
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
  rules: readonly ReviewAutomationRule[];
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
  // Aborts when the plugin stops, which ends waits and sleeps.
  signal: AbortSignal;
}

type Context = Plugin.Context;

// The stored attempt whose prompt started the session's current turn. When a
// compaction removed that prompt, an attempt counts only if it started after
// the session was last idle: a later turn, such as an unrelated task, can't
// take on the instructions of an attempt that already ended.
export async function storedPreparation(
  ctx: Context,
  claims: ReturnType<typeof createReviewClaims>,
  sessionID: string,
): Promise<AutomationRecord | undefined> {
  const messages = await ctx.session.context({ sessionID });
  const input = turnInput(messages);
  const batch = input && preparationBatch(input.id);
  if (batch) {
    const record = await claims.records.read(batch);
    if (!record || record.messageID !== input.id || record.item.sessionID !== sessionID)
      throw new Error('Review automation execution instructions are unavailable');
    return record;
  }
  if (input || !messages.some((message) => message.type === 'compaction')) return undefined;
  const started = (await claims.records.list()).filter(
    (record) =>
      record.item.sessionID === sessionID &&
      record.startedAt !== undefined &&
      (record.state === 'running' || record.state === 'failed') &&
      messages.some(
        (message) => message.type === 'compaction' && message.time.created >= record.startedAt!,
      ),
  );
  if (!started.length) return undefined;
  const idle = (await ctx.session.get({ sessionID })).time.idle;
  const candidates = started.filter((record) => idle === undefined || idle < record.startedAt!);
  if (candidates.length > 1)
    throw new Error('Review preparation ownership is uncertain after compaction');
  return candidates[0];
}

const sameStatus = (a: AutomationStatus | undefined, b: AutomationStatus) =>
  a?.state === b.state && a.at === b.at && a.messageID === b.messageID && a.reason === b.reason;

// Every non-archived root session whose stored targets include the PR/MR, in
// any checkout. Rejects when a session can't be read, since it might count.
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
    if (!session.parentID && session.time.archived === undefined) ids.add(sessionID);
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
      (!comment.automated || comment.automated.finding),
  );
  const ids = comments.map((comment) => comment.id);
  const details = await (deps.details
    ? deps.details(target, ids)
    : capability.details(deps.exec, directory, target, ids));
  const verified = details.filter((detail) => {
    const comment = comments.find((entry) => entry.id === detail.id);
    return !!comment && detail.authorID === comment.authorID && detail.url === comment.url;
  });
  if (verified.length !== comments.length)
    throw new Error('Some review findings could not be verified; retry after a complete fetch');
  return verified.map((detail) => {
    const reviewer = detail.authorID && accounts.get(detail.authorID);
    return reviewer ? { ...detail, reviewer } : detail;
  });
}

// Checks that the PR/MR is open and the checkout is its source branch, at its
// head commit when the forge reports one. With `ownOnly`, the PR/MR must also
// be the signed-in user's.
async function assertMatchingCheckout(
  deps: AutomationDependencies,
  directory: string,
  url: string,
  ownOnly: boolean,
) {
  const ref = parseUrl(url);
  const forge = ref && deps.forges.forHost(ref.host, directory);
  const request =
    forge && ref && (await forge.findByNumber([{ host: ref.host, path: ref.project }], ref.iid));
  if (!request || request.state !== 'opened') throw new Ineligible('The PR/MR is no longer open');
  if (ownOnly) {
    const viewer = await (deps.viewerID
      ? deps.viewerID(ref)
      : traitsOf(request).feedback?.viewerID?.(deps.exec, directory, ref.host));
    if (!viewer) throw new Error('Could not read the signed-in account');
    if (request.authorID !== viewer)
      throw new Ineligible(
        'You did not write this PR/MR, so automatic action is skipped. Use Act on feedback to act anyway.',
      );
  }
  const checkout = await deps.forges.repository(directory);
  if (
    checkout.kind !== 'repository' ||
    !request.sourceProject ||
    !request.sourceBranch ||
    checkout.repository.source.host !== ref.host ||
    checkout.repository.source.path !== request.sourceProject ||
    checkout.repository.sourceBranch !== request.sourceBranch ||
    (request.headSha && checkout.repository.head !== request.headSha)
  )
    throw new Ineligible('The checkout does not match the PR/MR source project and branch');
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
  const messages = await ctx.session.context({ sessionID: claim.sessionID });
  // Input during the attempt's turn makes its outcome uncertain, but while
  // the session hasn't been idle since that input, the turn is still going.
  const steered = async (input: { time: { created: number } }): Promise<ExecutionOutcome> => {
    const idle = (await ctx.session.get({ sessionID: claim.sessionID })).time.idle;
    return idle === undefined || idle < input.time.created ? 'running' : 'unknown';
  };
  const index = messages.findIndex((message) => message.id === claim.messageID);
  if (index >= 0) {
    for (const message of messages.slice(index + 1)) {
      if (message.type === 'user' || isForgekeeperInput(message)) return steered(message);
      if (message.type === 'idle') return message.outcome === 'succeeded' ? 'completed' : 'failed';
    }
    const session = await ctx.session.get({ sessionID: claim.sessionID });
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
  const session = await ctx.session.get({ sessionID: claim.sessionID });
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
  const ruleReviewers = (url: string) => {
    const ref = parseUrl(url);
    return ref ? automationReviewers(env.rules, ref) : [];
  };
  // The session's own model, or else its agent's, or else the default.
  const model = async (sessionID: string) => {
    const session = await ctx.session.get({ sessionID });
    if (session.model) return modelKey(session.model);
    const agent = session.agent
      ? (await ctx.agent.get({ agentID: session.agent })).data.model
      : undefined;
    if (agent) return modelKey(agent);
    const fallback = (await ctx.model.default()).data;
    return fallback ? modelKey(fallback) : undefined;
  };

  async function validate(item: FeedbackItem, automatic: boolean) {
    if (!(await env.deliverable(item)))
      throw new Ineligible('The session no longer targets this PR/MR here');
    const session = await ctx.session.get({ sessionID: item.sessionID });
    if (session.parentID) throw new Ineligible('Subagents cannot own review automation');
    await assertMatchingCheckout(deps, directory, item.url, automatic);
    if (session.agent === 'plan')
      throw new Ineligible('Switch the owning session to a coding agent before acting on feedback');
  }

  async function assertPending(item: FeedbackItem) {
    const state = await env.inbox.list();
    if (
      env.closing() ||
      state.paused ||
      !state.items.some((entry) => entry.id === item.id) ||
      !(await env.deliverable(item))
    )
      throw new Error('Review automation was canceled before the coding turn');
  }

  const sleep = (ms: number) =>
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
    });

  const host: AutomationHost = {
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
      const current = (await env.inbox.list()).items.find((entry) => entry.id === item.id);
      if (sameStatus(current?.automation, status)) return;
      await env.inbox.automation(item.id, status);
    },
    inbox: env.inbox.list,
    associations,
    exists,
    findings,
    model,
    validate,
    redeliver: env.redeliver,
    wait: (sessionID) => ctx.session.wait({ sessionID }, { signal: env.signal }),
    sleep,
    claim: claims,
    async submit(record, text) {
      await ctx.session.prompt({
        sessionID: record.item.sessionID,
        id: record.messageID,
        text,
        metadata: { forgekeeper: 'review-prepare', batch: record.batch },
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

    // Checks, before the turn's first model request, that the attempt may
    // still run, that its prompt holds the current authorized findings, and
    // that the request's model may act on them. Records the start and the
    // allowed models, so the turn's later requests check only the model.
    async authorizeStart(record: AutomationRecord, requested: string) {
      if (record.state !== 'running') throw new Error('Review automation is no longer running');
      await assertPending(record.item);
      const sessions = await associations(record.item.url);
      if (sessions.length !== 1 || sessions[0] !== record.item.sessionID)
        throw new Error('Review automation ownership changed before the coding turn');
      const ref = parseUrl(record.item.url);
      const reviewers = record.manual ? undefined : ruleReviewers(record.item.url);
      if (!ref || reviewers?.length === 0)
        throw new Error('The review automation rule is no longer enabled');
      await validate(record.item, !record.manual);
      const current = await findings(
        record.item,
        reviewers,
        record.manual ? restrictedReviewers(env.rules, ref) : undefined,
      );
      if (findingsDigest(current) !== record.digest)
        throw new Error(
          'The review findings changed after the task was queued. Explicitly retry to act on the current findings.',
        );
      const models = allowedModelsFor(env.rules, ref, current);
      const refusal = modelRefusal(models, requested, 'retry');
      if (refusal) throw new Error(refusal);
      await assertPending(record.item);
      const started: AutomationRecord = { ...record, startedAt: now() };
      if (models) started.models = models;
      if (!(await save(started, record)))
        throw new Error('Review automation changed before the coding turn');
    },

    // The stored attempts this checkout's instance continues after a reload:
    // queued and running ones whose session is here.
    async restorable(): Promise<AutomationRecord[]> {
      const records: AutomationRecord[] = [];
      for (const record of await claims.records.list()) {
        if (!record.item || (record.state !== 'running' && record.state !== 'queued')) continue;
        const session = await ctx.session
          .get({ sessionID: record.item.sessionID })
          .catch(() => undefined);
        if (session?.location.directory === directory) records.push(record);
      }
      return records;
    },
  };
}
