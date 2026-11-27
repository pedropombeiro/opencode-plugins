import type { Plugin } from '@opencode/plugin';
import type { FeedbackItem } from './feedback-inbox';
import type { ReviewRef, ReviewRequest } from './forge';
import { parseUrl, traits, type ForgeCatalog } from './forges';
import { issueProblems } from './issue-watch';
import type { FeedbackDelivery } from './options';
import { relatedIssueRef, sameRef, targetRequest, type Target } from './target';

const STORE = 'status/issues/';
const prefix = (sessionID: string) => `${STORE}${encodeURIComponent(sessionID)}/`;
const identity = (ref: ReviewRef) =>
  JSON.stringify([ref.forge, ref.host, ref.project.toLowerCase(), ref.iid]);

type MergeCheck = { url: string; at: number; delivery: FeedbackDelivery };
type IssueRecord = {
  sessionID: string;
  issue: string;
  seen?: string;
  problems?: string[];
  cycle?: number;
  merge?: MergeCheck;
  pending?: FeedbackItem;
  at: number;
};

function relatedTargets(targets: readonly Target[]) {
  const groups = new Map<string, { issue: ReviewRef; targets: ReviewRef[] }>();
  for (const target of targets) {
    const mr = targetRequest(target);
    const issue = relatedIssueRef(target);
    if (!mr || !issue) continue;
    const key = identity(issue);
    const group = groups.get(key) ?? { issue, targets: [] };
    if (!group.targets.some((ref) => sameRef(ref, mr))) group.targets.push(mr);
    groups.set(key, group);
  }
  return groups;
}

function belongs(url: string, targets: readonly ReviewRef[]) {
  const ref = parseUrl(url);
  return !!ref && targets.some((target) => sameRef(target, ref));
}

function sameRequestUrl(a: string, b: string) {
  if (a === b) return true;
  const left = parseUrl(a);
  const right = parseUrl(b);
  return !!left && !!right && sameRef(left, right);
}

const issueDisplayRef = (ref: ReviewRef) =>
  ref.forge === 'github'
    ? `${ref.project}${traits(ref.forge).issueReference(ref.iid)}`
    : traits(ref.forge).issueReference(ref.iid);

export function createIssueNotifications(
  ctx: Plugin.Context,
  forges: ForgeCatalog,
  host: {
    storedTargets: (sessionID: string) => Promise<Target[]>;
    targets: (sessionID: string, url: string) => Promise<Target[] | undefined>;
    closing: () => boolean;
    scan: (prefix: string) => Promise<{ key: string; value: unknown }[]>;
    record: (item: FeedbackItem) => Promise<void>;
    error: (error: unknown) => void;
  },
  delivery: () => FeedbackDelivery,
  now: () => number,
) {
  const directory = ctx.location.directory;
  const read = async (key: string) => (await ctx.storage.get(key)) as IssueRecord | undefined;
  const write = (key: string, state: IssueRecord) => {
    if (host.closing()) throw new Error('The plugin stopped');
    return ctx.storage.set(key, { ...state, at: now() } as never);
  };

  async function flush(key: string, state: IssueRecord) {
    if (!state.pending) return state;
    const { pending, ...next } = state;
    const targets = await host.targets(state.sessionID, pending.url);
    if (targets && belongs(pending.url, relatedTargets(targets).get(state.issue)?.targets ?? []))
      await host.record(pending);
    await write(key, next);
    return next;
  }

  async function check(
    key: string,
    state: IssueRecord,
    ref: ReviewRef,
    requests: readonly ReviewRequest[],
  ) {
    const finalMergeOnly = ref.forge === 'github';
    const { merge, ...next } = state;
    const allMerged = requests.every((request) => request.state === 'merged');
    let anchor: ReviewRequest | undefined;
    if (allMerged) {
      anchor = merge
        ? requests.find((request) => sameRequestUrl(request.url, merge.url))
        : undefined;
    } else if (!finalMergeOnly) {
      anchor = requests.find((request) => request.state === 'opened');
    }
    if (!anchor) {
      if (merge) await write(key, next);
      return;
    }
    const seen = JSON.stringify(
      requests.map(({ url, state, draft }) => [url, state, !!draft]).sort(),
    );
    if (!merge && state.seen === seen) return;
    const forge = forges.forHost(ref.host, directory);
    const issue = await forge?.issue?.(ref);
    if (!issue) return;
    const issueRef = issueDisplayRef(ref);
    const problems = issueProblems(issue, requests, issueRef);
    const fresh = problems.filter((problem) => !state.problems?.includes(problem.id));
    next.seen = seen;
    next.problems = problems.map((problem) => problem.id);
    if (fresh.length) {
      const mrRef = traits(anchor.forge).reference(anchor.iid);
      const issueUrl =
        issue.forge === 'github'
          ? issue.url
          : `https://${ref.host}/${ref.project}/-/issues/${ref.iid}`;
      const mode = allMerged && merge ? merge.delivery : delivery();
      const cycle = (next.cycle ?? 0) + 1;
      next.cycle = cycle;
      next.pending = {
        id: JSON.stringify([state.sessionID, state.issue, 'issue-outdated', cycle]),
        kind: 'issue-outdated',
        sessionID: state.sessionID,
        url: anchor.url,
        title: `Issue ${issueRef} may be outdated after ${mrRef}`,
        links: [issueUrl, anchor.url],
        details: [
          ...fresh.map(({ text }) =>
            issue.forge === 'github' ? `${text}.` : `${issueRef}: ${text}.`,
          ),
          'Tell the user what you would change in the issue, and wait for their approval before editing it.',
        ],
        ...(mode === 'inbox' ? {} : { delivery: mode }),
        at: allMerged && merge ? merge.at : now(),
      };
    }
    await write(key, next);
    await flush(key, next);
  }

  return {
    async prepare(
      sessionID: string,
      requests: readonly ReviewRequest[],
      merged: ReadonlySet<string>,
    ) {
      const groups = relatedTargets(await host.storedTargets(sessionID));
      const checks: Array<() => Promise<void>> = [];
      for (const [issue, group] of groups) {
        if (!forges.forHost(group.issue.host, directory)?.issue) continue;
        const current = group.targets.map((ref) =>
          requests.find((request) => belongs(request.url, [ref])),
        );
        const transition = current.find((request) => request && merged.has(request.url));
        const key = `${prefix(sessionID)}${encodeURIComponent(issue)}`;
        const finalMergeOnly = group.issue.forge === 'github';
        let state = (await read(key)) ?? { sessionID, issue, at: now() };
        const hasUnmerged = current.some(
          (request) => request !== undefined && request.state !== 'merged',
        );
        if (hasUnmerged) {
          const { merge, ...rest } = state;
          const problems = finalMergeOnly
            ? state.problems?.filter((id) => id !== 'merged')
            : state.problems;
          if (merge || problems?.length !== state.problems?.length) {
            state = { ...rest, ...(problems ? { problems } : {}) };
            await write(key, state);
          }
        } else if (transition) {
          state = { ...state, merge: { url: transition.url, at: now(), delivery: delivery() } };
          await write(key, state);
        }
        if (finalMergeOnly && !state.merge && !state.pending) continue;
        const snapshot = state;
        if (current.every((request) => request !== undefined)) {
          checks.push(async () => check(key, await flush(key, snapshot), group.issue, current));
        } else if (snapshot.pending) {
          checks.push(async () => {
            await flush(key, snapshot);
          });
        }
      }
      return async () => {
        for (const run of checks) await run().catch(host.error);
      };
    },
    async waiting() {
      const waiting = (await host.scan(STORE))
        .map(({ value }) => value as IssueRecord)
        .filter((state) => state.merge || state.pending);
      const sessions = await Promise.all(
        [...new Set(waiting.map(({ sessionID }) => sessionID))].map(async (sessionID) => {
          const session = await ctx.session.get({ sessionID }).catch(() => undefined);
          return session?.location.directory === directory ? sessionID : undefined;
        }),
      );
      return sessions.filter((sessionID) => sessionID !== undefined);
    },
    async retry(sessionID: string) {
      for (const { key, value } of await host.scan(prefix(sessionID))) {
        const state = value as IssueRecord;
        if (!state.pending && !state.merge) continue;
        await (async () => {
          const next = await flush(key, state);
          if (!next.merge) return;
          const { merge, ...rest } = next;
          const targets = await host.targets(sessionID, merge.url);
          const group = targets && relatedTargets(targets).get(state.issue);
          if (!targets || !group || !belongs(merge.url, group.targets)) {
            await write(key, rest);
            return;
          }
          const settled = await Promise.allSettled(
            group.targets.map((ref) =>
              forges
                .forHost(ref.host, directory)
                ?.findByNumber([{ host: ref.host, path: ref.project }], ref.iid),
            ),
          );
          const requests = settled.map((result) =>
            result.status === 'fulfilled' ? result.value : undefined,
          );
          if (requests.some((request) => request !== undefined && request.state !== 'merged')) {
            const problems =
              group.issue.forge === 'github'
                ? rest.problems?.filter((id) => id !== 'merged')
                : rest.problems;
            await write(key, { ...rest, ...(problems ? { problems } : {}) });
            return;
          }
          const failure = settled.find((result) => result.status === 'rejected');
          if (failure) throw failure.reason;
          if (requests.every((request) => request !== undefined))
            await check(key, next, group.issue, requests);
        })().catch(host.error);
      }
    },
    async prune(olderThan: number) {
      for (const { key, value } of await host.scan(STORE)) {
        const state = value as IssueRecord;
        if (state.at >= olderThan) continue;
        const targets = await host.storedTargets(state.sessionID).catch(() => undefined);
        if (targets && !relatedTargets(targets).has(state.issue)) await ctx.storage.remove(key);
      }
    },
  };
}
