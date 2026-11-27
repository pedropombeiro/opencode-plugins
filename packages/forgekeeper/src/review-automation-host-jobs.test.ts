import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import { INVESTIGATION_QUIET_TIME } from './job-investigation';
import type { AutomationRule } from './options';
import { automationReviewers, type AutomationRecord } from './review-automation';
import { createAutomationHost, type AutomationDependencies } from './review-automation-host';
import { head, hostItem as item, hostUrl as url } from './review-automation-harness';
import { createReviewClaims } from './review-claim';
import { findingsDigest, preparationMessageID } from './review-preparation';

describe('failed-job checks', () => {
  const failure = { ...item, id: 'f1', kind: 'ci-failed' as const, pipeline: 'p1' };
  const review = { ...item, id: 'r1' };

  function jobHost(
    overrides: {
      agent?: string;
      viewer?: string;
      checkout?: string;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      sessions?: () => string[];
      rules?: AutomationRule[];
      accounts?: Record<string, string | Error>;
      warn?: (message: string) => void;
      // The author ID of the one review comment that feedback reads return.
      commenter?: string;
    } = {},
  ) {
    const comment = overrides.commenter && {
      id: '1',
      order: 1,
      url: `${url}#note_1`,
      editedAt: 0,
      resolved: false,
      bot: false,
      authorID: overrides.commenter,
      username: overrides.commenter,
    };
    const request = {
      forge: 'gitlab',
      url,
      state: 'opened',
      sourceProject: 'group/project',
      sourceBranch: 'feature',
      headSha: head,
      authorID: 'author',
      reviewerIDs: ['reviewer'],
      pipeline: {
        id: 'p1',
        status: 'RUNNING',
        label: 'running',
        failedJobs: [{ id: 'j1', name: 'rspec', stage: 'test' }],
        failedJobsComplete: true,
      },
    };
    const deps = {
      forges: {
        forHost: () => ({ findByNumber: async () => structuredClone(request) }),
        repository: async () => ({
          kind: 'repository',
          repository: {
            source: { host: 'gitlab.com', path: 'group/project' },
            sourceBranch: 'feature',
            head: overrides.checkout ?? head,
          },
        }),
      },
      viewerID: async () => overrides.viewer ?? 'author',
      reviewerID: async (_ref: unknown, name: string) => {
        const account = overrides.accounts?.[name];
        if (account instanceof Error) throw account;
        return account;
      },
      details: async () =>
        comment
          ? [{ id: '1', url: comment.url, username: 'x', authorID: comment.authorID, body: 'Fix' }]
          : [],
      ...(overrides.now ? { now: overrides.now } : {}),
    } as unknown as AutomationDependencies;
    const ctx = {
      location: { directory: '/repo' },
      session: {
        get: async () => ({
          agent: overrides.agent ?? 'build',
          time: {},
          location: { directory: '/repo' },
        }),
      },
    } as unknown as Plugin.Context;
    const claims = createReviewClaims(':memory:');
    const automation = createAutomationHost(
      ctx,
      { ...deps, reviewClaims: claims },
      {
        rules: overrides.rules ?? [],
        relay: async () => {},
        closing: () => false,
        inbox: {
          list: async () => ({ items: [failure, review], paused: false }),
          automation: async () => {},
        },
        deliverable: async () => true,
        readFeedback: async () =>
          comment ? ({ complete: true, comments: [comment] } as never) : undefined,
        scan: async () =>
          (overrides.sessions?.() ?? ['one']).map((id) => ({
            key: `sessions/${id}`,
            value: { targets: [{ url }] },
          })),
        missingSession: () => false,
        redeliver: () => {},
        report: () => {},
        ...(overrides.warn ? { warn: overrides.warn } : {}),
        signal: new AbortController().signal,
        ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
      },
    );
    return { host: automation.host, automation, claims, request, close: () => claims.close() };
  }

  test('automatic investigations cover your own PRs/MRs and ones you review', async () => {
    for (const viewer of ['author', 'reviewer']) {
      const f = jobHost({ viewer });
      await f.host.validate(failure, true);
      f.close();
    }
    const outsider = jobHost({ viewer: 'outsider' });
    await expect(outsider.host.validate(failure, true)).rejects.toThrow(
      'You neither wrote nor review this MR',
    );
    // A manual run works on any PR/MR.
    await outsider.host.validate(failure, false);
    outsider.close();
    // Review preparation still needs your own PR/MR.
    const reviewer = jobHost({ viewer: 'reviewer' });
    await expect(reviewer.host.validate(review, true)).rejects.toThrow('You did not write');
    reviewer.close();
  });

  describe('rule authors', () => {
    const ref = {
      forge: 'gitlab' as const,
      host: 'gitlab.com',
      project: 'group/project',
      iid: '1',
    };
    const reviewRule = (reviewers: string[], authors?: string[]): AutomationRule => ({
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers,
      action: 'prepare',
      ...(authors ? { authors } : {}),
    });
    const jobRule = (authors?: string[]): AutomationRule => ({
      on: 'job-failed',
      host: 'gitlab.com',
      projects: ['group/project'],
      action: 'investigate',
      ...(authors ? { authors } : {}),
    });
    const serviceHost = (rules: AutomationRule[], extra: Parameters<typeof jobHost>[0] = {}) => {
      const f = jobHost({ viewer: 'me', rules, accounts: { 'service-bot': 'svc' }, ...extra });
      f.request.authorID = 'svc';
      return f;
    };

    test("cover a listed author's PR/MR for review rules, matching by account ID", async () => {
      const covered = serviceHost([reviewRule(['gitlabduo'], ['service-bot'])]);
      expect((await covered.host.validate(review, true)).rules).toEqual(covered.host.rules);
      covered.close();
      const unlisted = serviceHost([reviewRule(['gitlabduo'])]);
      await expect(unlisted.host.validate(review, true)).rejects.toThrow(
        'You did not write this MR, and no automation rule lists its author',
      );
      unlisted.close();
      // The username alone doesn't count: its account must be the author.
      const impostor = serviceHost([reviewRule(['gitlabduo'], ['service-bot'])], {
        accounts: { 'service-bot': 'someone-else' },
      });
      await expect(impostor.host.validate(review, true)).rejects.toThrow('You did not write');
      impostor.close();
    });

    test("cover a listed author's PR/MR for job-failed rules", async () => {
      const covered = serviceHost([jobRule(['service-bot'])]);
      expect((await covered.host.validate(failure, true)).rules).toEqual(covered.host.rules);
      covered.close();
      const unlisted = serviceHost([jobRule()]);
      await expect(unlisted.host.validate(failure, true)).rejects.toThrow(
        'You neither wrote nor review this MR, and no automation rule lists its author',
      );
      unlisted.close();
    });

    test('only rules that list the author apply to it, so only their reviewers count', async () => {
      const listing = reviewRule(['gitlabduo'], ['service-bot']);
      const other = reviewRule(['alice']);
      const job = jobRule();
      const elsewhere = { ...reviewRule(['bob']), projects: ['group/other'] };
      const f = serviceHost([listing, other, job, elsewhere]);
      const { rules } = await f.host.validate(review, true);
      expect(rules).toEqual([listing, job, elsewhere]);
      expect(automationReviewers(rules, ref)).toEqual(['gitlabduo']);
      // A job rule without authors doesn't cover the service account's MR.
      await expect(f.host.validate(failure, true)).rejects.toThrow('no automation rule');
      f.close();
      // Your own PR/MR keeps every rule.
      const own = jobHost({ rules: [listing, other, job] });
      expect((await own.host.validate(review, true)).rules).toEqual([listing, other, job]);
      own.close();
    });

    test('ignore an author that does not resolve, reporting it once', async () => {
      const warnings: string[] = [];
      const f = serviceHost([reviewRule(['gitlabduo'], ['ghost', 'broken', 'service-bot'])], {
        accounts: { 'service-bot': 'svc', broken: new Error('GitLab is unavailable') },
        warn: (message) => void warnings.push(message),
      });
      await f.host.validate(review, true);
      await f.host.validate(review, true);
      expect(warnings.sort()).toEqual([
        'Forgekeeper ignores automation author @broken on gitlab.com: GitLab is unavailable',
        'Forgekeeper ignores automation author @ghost on gitlab.com: the forge has no such account',
      ]);
      f.close();
      const unresolved = serviceHost([reviewRule(['gitlabduo'], ['ghost'])], {
        warn: (message) => void warnings.push(message),
      });
      await expect(unresolved.host.validate(review, true)).rejects.toThrow('You did not write');
      unresolved.close();
    });

    test("the first model request allows only the author's rules' models", async () => {
      const at = 1_000_000;
      const started = (batch: string, entry: typeof review, digest?: string) => ({
        batch,
        item: { ...entry, at: at - INVESTIGATION_QUIET_TIME },
        messageID: preparationMessageID(batch, 1),
        state: 'running' as const,
        attempt: 1,
        at,
        ...(digest ? { digest } : {}),
      });
      const strict = ['gitlab/strong'];
      const job = serviceHost([{ ...jobRule(['service-bot']), allowedModels: strict }, jobRule()], {
        now: () => at,
      });
      const investigation = started('e'.repeat(64), failure);
      await job.claims.records.save(investigation);
      await expect(job.automation.authorizeStart(investigation, 'gitlab/any')).rejects.toThrow(
        'needs one of these models: gitlab/strong',
      );
      await job.automation.authorizeStart(investigation, 'gitlab/strong');
      job.close();

      const entry = { ...review, commentIDs: ['1'] };
      const prep = serviceHost(
        [
          { ...reviewRule(['gitlabduo'], ['service-bot']), allowedModels: strict },
          reviewRule(['gitlabduo']),
        ],
        { accounts: { 'service-bot': 'svc', gitlabduo: 'duo' }, commenter: 'duo' },
      );
      const findings = [
        { id: '1', url: `${url}#note_1`, username: 'x', authorID: 'duo', body: 'Fix' },
      ];
      const preparation = started('f'.repeat(64), entry, findingsDigest(findings));
      await prep.claims.records.save(preparation);
      await expect(prep.automation.authorizeStart(preparation, 'gitlab/any')).rejects.toThrow(
        'needs one of these models: gitlab/strong',
      );
      await prep.automation.authorizeStart(preparation, 'gitlab/strong');
      prep.close();
    });

    test('leave a manual action unchanged', async () => {
      const rules = [reviewRule(['gitlabduo']), jobRule()];
      const f = serviceHost(rules);
      expect((await f.host.validate(review, false)).rules).toEqual(rules);
      expect((await f.host.validate(failure, false)).rules).toEqual(rules);
      f.close();
    });
  });

  test('skips a checkout that is not at the failing pipeline commit, naming it', async () => {
    const f = jobHost({ checkout: 'beef'.repeat(10) });
    await expect(f.host.validate(failure, true)).rejects.toThrow(
      `isn't at the head commit that the failing pipeline tested, so the failure may already be fixed. To investigate anyway, check out ${head.slice(0, 12)}`,
    );
    f.close();
  });

  test('skips a pipeline that a newer one replaced', async () => {
    const f = jobHost();
    await expect(f.host.validate({ ...failure, pipeline: 'p0' }, true)).rejects.toThrow(
      'A newer pipeline replaced the failing one',
    );
    expect(await f.host.pipelineDone({ ...failure, pipeline: 'p0' })).toBe(true);
    f.close();
  });

  test('holds the first model request until a late failure goes quiet', async () => {
    let clock = 1_000_000;
    let replaced = false;
    let f3At = 0;
    const jobBatch = 'b'.repeat(64);
    const running: AutomationRecord = {
      batch: jobBatch,
      item: { ...failure, at: clock - INVESTIGATION_QUIET_TIME },
      messageID: preparationMessageID(jobBatch, 1),
      state: 'running',
      attempt: 1,
      at: clock,
      manual: true,
    };
    const f = jobHost({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // A job fails while the request waits, replacing the update.
        if (replaced) return;
        replaced = true;
        const stored = (await f.claims.records.read(jobBatch))!;
        f3At = clock;
        await f.claims.records.save(
          { ...stored, item: { ...failure, id: 'f3', at: clock } },
          stored,
        );
      },
    });
    // The update the prompt was written for is already quiet, but a later
    // failure arrives just before the first model request.
    await f.claims.records.save({ ...running, item: { ...failure, id: 'f2', at: clock } });
    await f.automation.authorizeStart(running, 'gitlab/any');
    const started = (await f.claims.records.read(jobBatch))!;
    expect(started.item.id).toBe('f3');
    expect(started.startedAt! - f3At).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
    f.close();
  });

  test('rechecks sole ownership after waiting out the quiet time', async () => {
    let clock = 1_000_000;
    const sessions = ['one'];
    const jobBatch = 'd'.repeat(64);
    const running: AutomationRecord = {
      batch: jobBatch,
      item: { ...failure, at: clock },
      messageID: preparationMessageID(jobBatch, 1),
      state: 'running',
      attempt: 1,
      at: clock,
      manual: true,
    };
    const f = jobHost({
      now: () => clock,
      sessions: () => sessions,
      // Another session targets the PR/MR while the request waits.
      sleep: async (ms) => {
        clock += ms;
        if (!sessions.includes('two')) sessions.push('two');
      },
    });
    await f.claims.records.save(running);
    await expect(f.automation.authorizeStart(running, 'gitlab/any')).rejects.toThrow(
      'ownership changed',
    );
    expect((await f.claims.records.read(jobBatch))!.startedAt).toBeUndefined();
    f.close();
  });

  test('a finished pipeline lets the first model request start right away', async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const jobBatch = 'c'.repeat(64);
    const running: AutomationRecord = {
      batch: jobBatch,
      item: { ...failure, at: clock },
      messageID: preparationMessageID(jobBatch, 1),
      state: 'running',
      attempt: 1,
      at: clock,
      manual: true,
    };
    const f = jobHost({ now: () => clock, sleep: async (ms) => void sleeps.push((clock += ms)) });
    f.request.pipeline = { ...f.request.pipeline, status: 'FAILED' };
    await f.claims.records.save(running);
    await f.automation.authorizeStart(running, 'gitlab/any');
    expect(sleeps).toEqual([]);
    expect((await f.claims.records.read(jobBatch))!.startedAt).toBe(clock);
    f.close();
  });

  test('lets a plan agent investigate, but not prepare fixes', async () => {
    const f = jobHost({ agent: 'plan' });
    await f.host.validate(failure, true);
    await expect(f.host.validate(review, true)).rejects.toThrow('coding agent');
    f.close();
  });

  test('reads the failed jobs while the pipeline runs', async () => {
    const f = jobHost();
    expect(await f.host.failures(failure)).toEqual({
      pipeline: { id: 'p1' },
      jobs: [{ id: 'j1', name: 'rspec', stage: 'test' }],
      unlisted: false,
      complete: true,
    });
    // A pipeline with more failed jobs than the forge listed says so.
    f.request.pipeline = { ...f.request.pipeline, failedJobsComplete: false };
    expect((await f.host.failures(failure)).complete).toBe(false);
    f.request.pipeline = { ...f.request.pipeline, failedJobsComplete: true };
    expect(await f.host.pipelineDone(failure)).toBe(false);
    // A retried job that passed leaves nothing to investigate.
    f.request.pipeline = { ...f.request.pipeline, status: 'SUCCESS', failedJobs: [] };
    expect(await f.host.pipelineDone(failure)).toBe(true);
    await expect(f.host.failures(failure)).rejects.toThrow('no longer has failed jobs');
    f.close();
  });
});
