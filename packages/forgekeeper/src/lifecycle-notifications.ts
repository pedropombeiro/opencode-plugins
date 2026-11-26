import type { Plugin } from '@opencode/plugin';
import type { FeedbackItem } from './feedback-inbox';
import { jobKey, type FailedJob, type ReviewRef, type ReviewRequest } from './forge';
import { parseUrl, reference, traits, traitsOf, type ForgeCatalog } from './forges';
import { issueProblems } from './issue-watch';
import { proposeRetargets, stricter } from './lifecycle-execution';
import {
  createLifecycleWatcher,
  failureKeys,
  UNLISTED_FAILURE,
  type IssueCheck,
  type LifecycleEvent,
  type LifecycleRecord,
  type PipelineState,
} from './lifecycle-watch';
import type { StatusOptions } from './options';
import type { Notice } from './rpc';
import { feedbackTarget } from './summary-delivery';
import { includesRequest, relatedIssueRef, sameRef, targetRequest, type Target } from './target';

const MAX_LISTED_JOBS = 10;
const LIFECYCLE_STORE = 'status/lifecycle/';
const LIFECYCLE_RETENTION = 30 * 24 * 60 * 60_000;
const lifecyclePrefix = (sessionID: string) =>
  `${LIFECYCLE_STORE}${encodeURIComponent(sessionID)}/`;
const lifecycleKey = (sessionID: string, url: string) =>
  `${lifecyclePrefix(sessionID)}${encodeURIComponent(url)}`;

function splitFailures(ci: PipelineState, keys: readonly string[]) {
  const wanted = new Set(keys);
  return {
    fresh: ci.jobs.filter((job) => wanted.has(jobKey(job))),
    earlier: ci.jobs.filter((job) => !wanted.has(jobKey(job))),
    unlisted: ci.unlisted && wanted.has(UNLISTED_FAILURE),
  };
}

function failureTitle(
  reference: string,
  ci: PipelineState,
  failures: ReturnType<typeof splitFailures>,
  word: string,
) {
  const { fresh } = failures;
  if (!fresh.length) return `${reference}: its ${word} failed`;
  const what = fresh.length === 1 ? `job ${fresh[0].name} failed` : `${fresh.length} jobs failed`;
  return `${reference}: ${what} in its ${word}${ci.running ? ', which is still running' : ''}`;
}

function failureDetails(ci: PipelineState, failures: ReturnType<typeof splitFailures>): string[] {
  const line = (job: FailedJob, when = '') =>
    `${job.name} failed${when}${job.stage ? ` in stage ${job.stage}` : ''}.`;
  const listed = [
    ...failures.fresh.map((job) => line(job)),
    ...failures.earlier.map((job) => line(job, ' earlier')),
  ];
  const more = listed.length - MAX_LISTED_JOBS;
  return [
    ...listed.slice(0, MAX_LISTED_JOBS),
    ...(more > 0 ? [`${more} more jobs failed.`] : []),
    ...(failures.unlisted
      ? [
          'A job that is not allowed to fail failed the pipeline, but it is not among the failed jobs Forgekeeper reads.',
        ]
      : ci.complete
        ? []
        : ['More jobs failed than Forgekeeper reads.']),
    ...(ci.running ? ['Other jobs are still running.'] : []),
  ];
}

interface LifecycleHost {
  targets: (sessionID: string, url: string) => Promise<Target[] | undefined>;
  storedTargets: (sessionID: string) => Promise<Target[]>;
  closing: () => boolean;
  scan: (prefix: string) => Promise<{ key: string; value: unknown }[]>;
  record: (item: FeedbackItem, supersedes?: (entry: FeedbackItem) => boolean) => Promise<void>;
  notice: (notice: Notice) => void;
  error: (error: unknown) => void;
}

export function createLifecycleNotifications(
  ctx: Plugin.Context,
  settings: StatusOptions,
  deps: { forges: ForgeCatalog; now?: () => number },
  host: LifecycleHost,
) {
  const directory = ctx.location.directory;
  const read = async (prefix: string) =>
    (await host.scan(prefix)).map(({ value }) => value as LifecycleRecord);

  async function fresh(url: string): Promise<ReviewRequest | undefined> {
    const ref = parseUrl(url);
    const forge = ref && deps.forges.forHost(ref.host, directory);
    if (!ref || !forge) return undefined;
    return forge.findByNumber([{ host: ref.host, path: ref.project }], ref.iid);
  }

  // What each issue was last read for, so an unchanged PR/MR doesn't read it again.
  const issueReads = new Map<string, string>();

  async function issues(
    sessionID: string,
    requests: readonly ReviewRequest[],
  ): Promise<Map<string, IssueCheck>> {
    const checks = new Map<string, IssueCheck>();
    const targets = await host.storedTargets(sessionID).catch(() => undefined);
    if (!targets) return checks;
    const groups = new Map<string, { ref: ReviewRef; requests: ReviewRequest[] }>();
    for (const request of requests) {
      const ref = parseUrl(request.url);
      const target = targets.find((entry) => {
        const named = targetRequest(entry);
        return ref && named && sameRef(named, ref);
      });
      const issue = target && relatedIssueRef(target);
      if (!issue) continue;
      const key = [sessionID, issue.host, issue.project.toLowerCase(), issue.iid].join(' ');
      const group = groups.get(key) ?? { ref: issue, requests: [] };
      group.requests.push(request);
      groups.set(key, group);
    }
    for (const [key, { ref, requests: group }] of groups) {
      const forge = deps.forges.forHost(ref.host, directory);
      if (!forge?.issue) continue;
      const seen = group.map((request) => [request.url, request.state, request.draft]).join(' ');
      if (issueReads.get(key) === seen) continue;
      const issue = await forge.issue(ref).catch((error) => {
        host.error(error);
        return undefined;
      });
      if (!issue) continue;
      issueReads.set(key, seen);
      // shortcut: GitLab's issue URL shape, move it into the forge traits when GitHub gets `issue`.
      const check = {
        url: `https://${ref.host}/${ref.project}/-/issues/${ref.iid}`,
        reference: traits(ref.forge).issueReference(ref.iid),
        problems: issueProblems(issue, group),
      };
      for (const request of group) checks.set(request.url, check);
    }
    return checks;
  }

  async function record(
    record: LifecycleRecord,
    event: LifecycleEvent,
    records: readonly LifecycleRecord[],
  ): Promise<void> {
    const targets = await host.targets(record.sessionID, record.url);
    if (!targets) return;
    if (event.kind === 'conflict' && (record.state !== 'opened' || record.conflicts === false))
      return;
    const still = new Set(record.ci ? failureKeys(record.ci) : []);
    if (
      event.kind === 'ci-failed' &&
      (record.state !== 'opened' ||
        record.ci?.id !== event.pipeline ||
        !(event.jobs ?? []).some((key) => still.has(key)))
    )
      return;
    const stillOutdated = new Set(record.issueProblems ?? []);
    const problems = (event.problems ?? []).filter((problem) => stillOutdated.has(problem.id));
    if (event.kind === 'issue-outdated' && (record.state !== 'opened' || !problems.length)) return;
    const children = records.filter(
      (entry) =>
        entry.parent === record.url &&
        entry.url !== record.url &&
        includesRequest(targets, entry.url),
    );
    let proposals: string[] = [];
    if (event.kind === 'merged' && children.length) {
      const lines = await proposeRetargets({
        parent: record,
        children,
        policy: stricter(event.policy, settings.lifecycleExecution.parentMerged),
        fetch: fresh,
      });
      const latest = await host.targets(record.sessionID, record.url);
      if (!latest) return;
      proposals = lines
        .filter((line) => includesRequest(latest, line.url))
        .map((line) => line.text);
    }
    const ci = event.kind === 'ci-failed' ? record.ci : undefined;
    const failures = ci && splitFailures(ci, event.jobs ?? []);
    const details =
      event.kind === 'issue-outdated' && event.issue
        ? [
            ...problems.map((problem) => `${event.issue?.reference}: ${problem.text}.`),
            'Tell the user what you would change in the issue, and wait for their approval before editing it.',
          ]
        : ci && failures
          ? failureDetails(ci, failures)
          : proposals;
    const forge = feedbackTarget(record.url);
    const title =
      ci && failures
        ? failureTitle(record.reference, ci, failures, forge ? traitsOf(forge).ci : 'pipeline')
        : event.kind === 'issue-outdated'
          ? `Issue ${event.issue?.reference} may be outdated after ${record.reference}`
          : event.kind === 'conflict'
            ? `${record.reference} can no longer merge: it conflicts with ${record.targetBranch}`
            : `${record.reference} merged into ${record.targetBranch}`;
    const item: FeedbackItem = {
      id: event.id,
      kind: event.kind,
      sessionID: record.sessionID,
      url: record.url,
      title,
      links: [
        ...(failures
          ? [...failures.fresh, ...failures.earlier]
              .slice(0, MAX_LISTED_JOBS)
              .flatMap((job) => job.url ?? [])
          : []),
        ...(event.issue ? [event.issue.url] : []),
        record.url,
      ],
      ...(details.length ? { details } : {}),
      ...(event.pipeline ? { pipeline: event.pipeline } : {}),
      ...(event.delivery ? { delivery: event.delivery } : {}),
      at: event.detectedAt,
    };
    const samePipeline = (entry: FeedbackItem) =>
      item.kind === 'ci-failed' &&
      entry.kind === 'ci-failed' &&
      entry.sessionID === item.sessionID &&
      entry.url === item.url &&
      entry.pipeline === item.pipeline;
    await host.record(item, samePipeline);
    host.notice({
      sessionID: record.sessionID,
      title,
      message: 'New merge request update in /forge-feedback.',
      variant: 'info',
    });
  }

  const watcher = settings.watch.lifecycle
    ? createLifecycleWatcher({
        records: (sessionID) => read(lifecyclePrefix(sessionID)),
        write: async (record) => {
          if (host.closing()) throw new Error('The plugin stopped');
          await ctx.storage.set(lifecycleKey(record.sessionID, record.url), record as never);
        },
        waiting: async () => {
          const waiting = (await read(LIFECYCLE_STORE)).filter((record) => record.pending.length);
          const here = await Promise.all(
            [...new Set(waiting.map((record) => record.sessionID))].map(async (sessionID) => {
              const session = await ctx.session.get({ sessionID }).catch(() => undefined);
              return session?.location.directory === directory ? sessionID : undefined;
            }),
          );
          return waiting.filter((record) => here.includes(record.sessionID));
        },
        deliver: record,
        reference,
        policy: (kind) =>
          kind === 'merged' ? settings.lifecycleExecution.parentMerged : undefined,
        delivery: () => settings.delivery.lifecycle,
        ...(settings.watch.issues ? { issues } : {}),
        onError: host.error,
        now: deps.now,
      })
    : undefined;

  return {
    watcher,
    async prune() {
      const at = (deps.now ?? Date.now)();
      for (const { key, value } of await host.scan(LIFECYCLE_STORE)) {
        const record = value as LifecycleRecord;
        if (record.pending.length || at - record.at < LIFECYCLE_RETENTION) continue;
        const targets = await host.storedTargets(record.sessionID).catch(() => undefined);
        if (targets && !includesRequest(targets, record.url)) await ctx.storage.remove(key);
      }
    },
  };
}
