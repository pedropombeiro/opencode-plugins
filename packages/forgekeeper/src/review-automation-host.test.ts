import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import {
  createAutomationHost,
  LINKED_INSTRUCTIONS,
  ownerPolicy,
  pushNotice,
  readVerifiedFindings,
  storedPreparation,
  type AutomationDependencies,
} from './review-automation-host';
import { extractTurnReport } from './local-automation-environment';
import { createSummaryDelivery } from './summary-delivery';
import { SUMMARY_KIND } from './review-summary';
import type { AutomationRule } from './options';
import {
  automationReviewers,
  Ineligible,
  type AutomationRecord,
  type LinkedRecord,
} from './review-automation';
import { linkedMetadata, presenceKey } from './linked-session';
import { PLUGIN_ID } from './plugin-id';
import { createReviewClaims } from './review-claim';
import { INVESTIGATION_QUIET_TIME } from './job-investigation';
import { approvalDigest, findingsDigest, preparationMessageID } from './review-preparation';

type Message = Awaited<ReturnType<Plugin.Context['session']['context']>>[number];
const batch = 'a'.repeat(64);
const messageID = preparationMessageID(batch, 1);
const item = {
  id: 'item',
  sessionID: 'one',
  url: 'https://gitlab.com/group/project/-/merge_requests/1',
  title: 'Review',
  links: [],
  at: 1,
};
const record: AutomationRecord = {
  batch,
  item,
  messageID,
  state: 'running',
  attempt: 1,
  at: 1,
  startedAt: 10,
};
const claim = { batch, sessionID: 'one', messageID };
const message = (type: string, id: string, at: number, extra = {}) =>
  ({ type, id, time: { created: at }, ...extra }) as Message;

async function fixture(messages: Message[], idle?: number, stored = record) {
  const claims = createReviewClaims(':memory:');
  await claims.records.save(stored);
  const ctx = {
    location: { directory: '/repo' },
    session: {
      context: async () => messages,
      get: async () => ({
        time: { idle },
        outcome: idle ? 'succeeded' : undefined,
        location: { directory: '/repo' },
      }),
    },
  } as unknown as Plugin.Context;
  const make = () =>
    createAutomationHost(ctx, { reviewClaims: claims } as AutomationDependencies, {
      rules: [],
      closing: () => false,
      inbox: { list: async () => ({ items: [item], paused: false }), automation: async () => {} },
      relay: async () => {},
      deliverable: async () => true,
      readFeedback: async () => undefined,
      scan: async () => [],
      missingSession: () => false,
      redeliver: () => {},
      report: () => {},
      signal: new AbortController().signal,
    });
  return { make, claims };
}

describe('review execution history', () => {
  test('a started preparation survives compaction and host reload', async () => {
    const messages = [message('compaction', 'compact', 20)];
    const f = await fixture(messages);
    try {
      expect(await f.make().preparationFor('one')).toEqual(record);
      const restored = f.make();
      expect(await restored.preparationFor('one')).toEqual(record);
      expect(await restored.host.outcome(claim)).toBe('running');
      messages.push(message('idle', 'idle', 30, { outcome: 'succeeded' }));
      await f.claims.records.save({ ...record, ended: { outcome: 'succeeded', at: 30 } }, record);
      expect(await restored.host.outcome(claim)).toBe('completed');
    } finally {
      f.claims.close();
    }
  });

  test('after compaction, a later turn ending does not settle an earlier attempt', async () => {
    // The attempt's own turn failed at 20. Another task later compacted the
    // session and succeeded, which is all the session and its context show.
    const f = await fixture(
      [
        message('compaction', 'later', 50),
        message('idle', 'later-idle', 60, { outcome: 'succeeded' }),
      ],
      60,
    );
    try {
      expect(await f.make().host.outcome(claim)).toBe('pending');
      await f.claims.records.save({ ...record, ended: { outcome: 'failed', at: 20 } }, record);
      expect(await f.make().host.outcome(claim)).toBe('failed');
    } finally {
      f.claims.close();
    }
  });

  test('after compaction, input before the recorded end makes the outcome uncertain', async () => {
    const f = await fixture(
      [message('compaction', 'compact', 15), message('user', 'steered', 18)],
      30,
      { ...record, ended: { outcome: 'succeeded', at: 30 } },
    );
    try {
      expect(await f.make().host.outcome(claim)).toBe('unknown');
    } finally {
      f.claims.close();
    }
  });

  test('after compaction, input after the recorded end belongs to a later turn', async () => {
    const f = await fixture(
      [message('compaction', 'compact', 40), message('user', 'later', 45)],
      50,
      { ...record, ended: { outcome: 'succeeded', at: 30 } },
    );
    try {
      expect(await f.make().host.outcome(claim)).toBe('completed');
    } finally {
      f.claims.close();
    }
  });

  test.each(['running', 'failed'] as const)(
    'a %s attempt stays with its own turn when a later task compacts',
    async (state) => {
      const f = await fixture([message('compaction', 'later', 50)], 30, { ...record, state });
      try {
        expect(await f.make().preparationFor('one')).toBeUndefined();
      } finally {
        f.claims.close();
      }
    },
  );

  test('a compacted attempt whose end was not recorded stays pending, not completed', async () => {
    const f = await fixture([message('compaction', 'compact', 20)], 30);
    try {
      expect(await f.make().host.outcome(claim)).toBe('pending');
    } finally {
      f.claims.close();
    }
  });

  test('an unrelated synthetic reminder does not hide completion', async () => {
    const f = await fixture([
      message('user', messageID, 1),
      message('synthetic', 'reminder', 20),
      message('idle', 'idle', 30, { outcome: 'succeeded' }),
    ]);
    try {
      expect(await f.make().host.outcome(claim)).toBe('completed');
    } finally {
      f.claims.close();
    }
  });

  test.each(['user', 'synthetic'] as const)(
    'a new %s step ends preparation instructions',
    async (type) => {
      const f = await fixture(
        [
          message('compaction', 'compact', 20),
          message(type, type === 'user' ? 'user' : 'msg_forgekeeper_summary_next', 25),
        ],
        30,
      );
      try {
        expect(await f.make().preparationFor('one')).toBeUndefined();
        expect(await f.make().host.outcome(claim)).toBe('unknown');
      } finally {
        f.claims.close();
      }
    },
  );

  test.each([
    ['with', [message('user', messageID, 1)]],
    ['after compacting', [message('compaction', 'compact', 15)]],
  ] as const)(
    'a turn steered %s its prompt stays running until the session goes idle',
    async (_case, history) => {
      const messages = [...history, message('user', 'steering', 20)];
      const running = await fixture(messages, 5);
      const stopped = await fixture(messages, 30);
      try {
        expect(await running.make().host.outcome(claim)).toBe('running');
        expect(await stopped.make().host.outcome(claim)).toBe('unknown');
      } finally {
        running.claims.close();
        stopped.claims.close();
      }
    },
  );

  test('only a session confirmed missing counts as deleted', async () => {
    const f = await fixture([]);
    const missing = Object.assign(new Error('Session not found'), { _tag: 'SessionNotFoundError' });
    let failure: Error | undefined;
    const ctx = {
      location: { directory: '/repo' },
      session: {
        get: async () => {
          if (failure) throw failure;
          return { time: {}, location: { directory: '/repo' } };
        },
      },
    } as unknown as Plugin.Context;
    const host = createAutomationHost(ctx, { reviewClaims: f.claims } as AutomationDependencies, {
      rules: [],
      closing: () => false,
      inbox: { list: async () => ({ items: [], paused: false }), automation: async () => {} },
      deliverable: async () => true,
      readFeedback: async () => undefined,
      scan: async () => [],
      missingSession: (error) => error === missing,
      relay: async () => {},
      redeliver: () => {},
      report: () => {},
      signal: new AbortController().signal,
    }).host;
    try {
      expect(await host.exists('one')).toBe(true);
      failure = missing;
      expect(await host.exists('one')).toBe(false);
      failure = new Error('Storage busy');
      await expect(host.exists('one')).rejects.toThrow('Storage busy');
    } finally {
      f.claims.close();
    }
  });

  test("a session's model is its own, else its agent's, else the default", async () => {
    const f = await fixture([]);
    const session: { agent?: string; model?: { providerID: string; id: string } } = {
      agent: 'build',
      model: { providerID: 'gitlab', id: 'session' },
    };
    let agentModel: { providerID: string; id: string } | undefined = {
      providerID: 'gitlab',
      id: 'agent',
    };
    const ctx = {
      location: { directory: '/repo' },
      session: { get: async () => ({ ...session, time: {}, location: { directory: '/repo' } }) },
      agent: { get: async () => ({ data: { id: 'build', model: agentModel } }) },
      model: { default: async () => ({ data: { providerID: 'gitlab', id: 'default' } }) },
    } as unknown as Plugin.Context;
    const host = createAutomationHost(ctx, { reviewClaims: f.claims } as AutomationDependencies, {
      rules: [],
      closing: () => false,
      inbox: { list: async () => ({ items: [], paused: false }), automation: async () => {} },
      deliverable: async () => true,
      readFeedback: async () => undefined,
      scan: async () => [],
      missingSession: () => false,
      relay: async () => {},
      redeliver: () => {},
      report: () => {},
      signal: new AbortController().signal,
    }).host;
    try {
      expect(await host.model('one')).toBe('gitlab/session');
      delete session.model;
      expect(await host.model('one')).toBe('gitlab/agent');
      agentModel = undefined;
      expect(await host.model('one')).toBe('gitlab/default');
    } finally {
      f.claims.close();
    }
  });
});

describe('verified review findings', () => {
  test('name the configured reviewer that wrote them, filtered or tagged', async () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/1';
    const comment = (id: string, authorID: string) => ({
      id,
      order: Number(id),
      url: `${url}#note_${id}`,
      editedAt: 0,
      resolved: false,
      bot: false,
      authorID,
      username: authorID,
    });
    const ctx = { location: { directory: '/repo' } } as unknown as Plugin.Context;
    const deps = {
      reviewerID: async (_ref: unknown, name: string) => `id-${name}`,
      details: async (_target: unknown, ids: string[]) =>
        ids.map((id) => ({
          id,
          url: `${url}#note_${id}`,
          username: 'someone',
          authorID: id === '1' ? 'id-duo' : id === '2' ? 'id-bot' : 'id-human',
          body: `Finding ${id}`,
        })),
    } as unknown as AutomationDependencies;
    const env = {
      readFeedback: async () => ({
        complete: true,
        comments: [comment('1', 'id-duo'), comment('2', 'id-bot'), comment('3', 'id-human')],
      }),
    };
    const batch = { ...item, url, commentIDs: ['1', '2', '3'] };
    const reviewers = async (only: string[] | undefined, tagged?: string[]) =>
      (await readVerifiedFindings(ctx, deps, env, batch, only, tagged)).map(
        (finding) => `${finding.id}:${finding.reviewer ?? '-'}`,
      );
    expect(await reviewers(['duo', 'bot'])).toEqual(['1:duo', '2:bot']);
    expect(await reviewers(['bot'], ['duo'])).toEqual(['2:bot']);
    expect(await reviewers(undefined, ['duo'])).toEqual(['1:duo', '2:-', '3:-']);
    expect(await reviewers(undefined)).toEqual(['1:-', '2:-', '3:-']);
  });
});

describe('failed-job checks', () => {
  const url = 'https://gitlab.com/group/project/-/merge_requests/1';
  const head = 'c0ffee'.repeat(7);
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
      'You neither wrote nor review this PR/MR',
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
        'You did not write this PR/MR, and no automation rule lists its author',
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
        'You neither wrote nor review this PR/MR, and no automation rule lists its author',
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

describe('worktree automation', () => {
  const url = 'https://gitlab.com/group/project/-/merge_requests/1';
  const head = 'c0ffee'.repeat(7);
  const review = { ...item, id: 'r1', url };
  const rule = {
    on: 'review' as const,
    host: 'gitlab.com',
    projects: ['group/project'],
    reviewers: ['duo'],
    action: 'prepare' as const,
  };

  interface Options {
    rules?: AutomationRule[];
    checkout?: string;
    sessions?: Record<string, Record<string, unknown>>;
    storage?: Record<string, unknown>;
    // Overrides of the PR/MR the forge reports.
    request?: Record<string, unknown>;
    viewer?: string;
    accounts?: Record<string, string>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    // The pages of sessions that listing the project returns.
    pages?: Array<Array<Record<string, unknown>>>;
    // Transcripts by session ID, for `ctx.session.context`.
    transcripts?: Record<string, Message[]>;
    // What `git status --short` reports in the worktree.
    status?: string;
    items?: AutomationRecord['item'][];
  }

  // What `git status --short` reports in the worktree.
  let status = '';
  // Git in a worktree at `head` on `feature`.
  const exec = (async (_file: string, args: string[]) => ({
    code: ['symbolic-ref', 'rev-parse', 'status'].includes(args[0]) ? 0 : 1,
    stderr: '',
    stdout: args.includes('--show-toplevel')
      ? '/repo'
      : args[0] === 'rev-parse'
        ? head
        : args[0] === 'symbolic-ref'
          ? 'feature'
          : args[0] === 'status'
            ? status
            : '',
  })) as unknown as AutomationDependencies['exec'];

  function hostFixture(options: Options = {}) {
    status = options.status ?? '';
    const sessions: Record<string, Record<string, unknown>> = {
      one: { id: 'one', agent: 'build', time: {}, location: { directory: '/repo' } },
      ...options.sessions,
    };
    const storage: Record<string, unknown> = { ...options.storage };
    const request = {
      forge: 'gitlab',
      url,
      state: 'opened',
      sourceProject: 'group/project',
      sourceBranch: 'feature',
      headSha: head,
      authorID: 'author',
      ...options.request,
    };
    const deps = {
      exec,
      forges: {
        forHost: () => ({ findByNumber: async () => structuredClone(request) }),
        repository: async () => ({
          kind: 'repository',
          repository: {
            source: { host: 'gitlab.com', path: 'group/project' },
            sourceBranch: options.checkout ?? 'feature',
            head,
          },
        }),
      },
      viewerID: async () => options.viewer ?? 'author',
      reviewerID: async (_ref: unknown, name: string) => options.accounts?.[name],
      ...(options.now ? { now: options.now } : {}),
    } as unknown as AutomationDependencies;
    const pages = options.pages ?? [[]];
    const listed: unknown[] = [];
    const synthetic: Array<Record<string, unknown>> = [];
    const ctx = {
      location: { directory: '/repo', project: { id: 'project' } },
      storage: {
        get: async (key: string) => storage[key],
        set: async (key: string, value: unknown) => {
          storage[key] = value;
        },
      },
      plugin: {
        list: async () => ({ data: [{ id: PLUGIN_ID, state: { status: 'active' } }] }),
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = sessions[sessionID];
          if (!session) throw new Error('Session not found');
          return session;
        },
        context: async ({ sessionID }: { sessionID: string }) =>
          options.transcripts?.[sessionID] ?? [],
        synthetic: async (input: Record<string, unknown>) => {
          synthetic.push(input);
        },
        list: async (input: { cursor?: number }) => {
          listed.push(input);
          const index = input.cursor ?? 0;
          return {
            data: pages[index].map((session) => ({ location: { directory: '/repo' }, ...session })),
            cursor: { next: index + 1 < pages.length ? index + 1 : null },
          };
        },
      },
    } as unknown as Plugin.Context;
    const summaries = createSummaryDelivery(ctx, deps, {
      closing: () => false,
      inbox: async () => ({ items: [], paused: false }),
      deliverable: async () => true,
      scan: async () => [],
      write: () => {},
      report: () => {},
    });
    const claims = createReviewClaims(':memory:');
    const automation = createAutomationHost(
      ctx,
      { ...deps, reviewClaims: claims },
      {
        rules: options.rules ?? [rule],
        relay: summaries.relay,
        closing: () => false,
        inbox: {
          list: async () => ({ items: options.items ?? [review], paused: false }),
          automation: async () => {},
        },
        deliverable: async () => true,
        readFeedback: async () => undefined,
        scan: async () =>
          Object.keys(sessions).map((id) => ({
            key: `sessions/${id}`,
            value: { targets: [{ url }] },
          })),
        missingSession: (error) => /not found/i.test(String(error)),
        redeliver: () => {},
        report: () => {},
        signal: new AbortController().signal,
        ...(options.sleep ? { sleep: options.sleep } : {}),
      },
    );
    return {
      ...automation,
      claims,
      storage,
      sessions,
      request,
      listed,
      synthetic,
      summaries,
      close: () => claims.close(),
    };
  }

  test('a checkout elsewhere runs in a worktree only when every rule opts in', async () => {
    const opted = { ...rule, execution: 'environment' as const };
    const cases: Array<[AutomationRule[], string]> = [
      [[opted], 'environment'],
      [[opted, { ...rule, reviewers: ['bot'] }], 'skip'],
      [[rule], 'skip'],
    ];
    for (const [rules, expected] of cases) {
      const f = hostFixture({ rules, checkout: 'main' });
      const result = await f.host.validate(review, true).then(
        ({ placement }) => placement,
        (error) => (error instanceof Ineligible ? 'skip' : error),
      );
      expect(result).toBe(expected);
      f.close();
    }
    // A matching checkout runs in the owning session, whatever the rules say.
    const matching = hostFixture({ rules: [opted] });
    expect((await matching.host.validate(review, true)).placement).toBe('session');
    matching.close();
  });

  test('linked sessions never count as owners', async () => {
    const f = hostFixture({
      sessions: {
        linked: {
          id: 'linked',
          time: {},
          location: { directory: '/worktree' },
          metadata: linkedMetadata('one', 'batch', 'linked'),
        },
      },
    });
    expect(await f.host.associations(url)).toEqual(['one']);
    f.close();
  });

  // A linked session's attempt, its owner in /owner, the worktree here.
  const linkedAttempt = (entry: AutomationRecord['item'] = review): LinkedRecord => ({
    ...record,
    item: entry,
    state: 'running',
    startedAt: undefined,
    execution: {
      stage: 'submitting',
      provider: 'local-worktree',
      version: 1,
      ownerDirectory: '/owner',
      head,
      sourceProject: 'group/project',
      sourceBranch: 'feature',
      state: { directory: '/repo', sessionID: 'linked' },
      prompt: 'task',
    },
  });
  const linkedSessions = {
    one: { id: 'one', time: {}, location: { directory: '/owner' } },
    linked: {
      id: 'linked',
      agent: 'build',
      time: {},
      location: { directory: '/repo' },
      metadata: linkedMetadata('one', batch, 'linked'),
    },
  };
  // The owner's instance, running with `rules`, with the update pending
  // and the PR/MR targeted.
  const ownerReady = (rules: AutomationRule[], at: number, entry = review) => ({
    [presenceKey('/owner')]: { at, instance: 'owner', rules },
    [`feedback-inbox/${encodeURIComponent('/owner')}`]: { items: [entry], paused: false },
    'sessions/one': { targets: [{ url }] },
  });

  test("checks a linked session's first request against the owner's instance, inbox, and targets", async () => {
    const attempt = linkedAttempt();
    const f = hostFixture({ sessions: linkedSessions });
    await f.claims.records.save(attempt);
    // The update isn't in the owner's inbox.
    await expect(f.authorizeStart(attempt, 'gitlab/model')).rejects.toThrow(
      'canceled before the coding turn',
    );
    f.storage[`feedback-inbox/${encodeURIComponent('/owner')}`] = {
      items: [review],
      paused: false,
    };
    // The owner no longer targets the PR/MR.
    await expect(f.authorizeStart(attempt, 'gitlab/model')).rejects.toThrow(
      'canceled before the coding turn',
    );
    f.storage['sessions/one'] = { targets: [{ url }] };
    // The owner's instance isn't running, so its rules can't be read.
    await expect(f.authorizeStart(attempt, 'gitlab/model')).rejects.toThrow(
      "Forgekeeper isn't running in /owner",
    );
    // A turn that moved out of its worktree never starts.
    await expect(
      f.authorizeStart(
        {
          ...attempt,
          execution: {
            ...attempt.execution!,
            state: { ...attempt.execution.state, directory: '/elsewhere' },
          },
        },
        'gitlab/model',
      ),
    ).rejects.toThrow("isn't in its worktree anymore");
    expect((await f.claims.records.read(batch))?.startedAt).toBeUndefined();
    f.close();
  });

  describe("a linked investigation's first request", () => {
    const at = 10_000_000;
    const failure = { ...review, id: 'f1', kind: 'ci-failed' as const, pipeline: 'p1', at };
    const job = {
      on: 'job-failed' as const,
      host: 'gitlab.com',
      projects: ['group/project'],
      action: 'investigate' as const,
    };
    // A service account's MR, covered only by the rule that lists it.
    const listing: AutomationRule = {
      ...job,
      authors: ['service-bot'],
      allowedModels: ['gitlab/strong'],
      execution: 'environment',
    };
    function investigation(rules: AutomationRule[], extra: Partial<Options> = {}) {
      let clock = at;
      const f = hostFixture({
        sessions: linkedSessions,
        viewer: 'me',
        accounts: { 'service-bot': 'svc' },
        request: {
          authorID: 'svc',
          pipeline: {
            id: 'p1',
            status: 'RUNNING',
            running: true,
            failedJobs: [{ id: 'j1', name: 'rspec', stage: 'test' }],
            failedJobsComplete: true,
          },
        },
        now: () => clock,
        storage: ownerReady(rules, at, failure),
        ...extra,
      });
      return { f, advance: (ms: number) => (clock += ms), now: () => clock };
    }

    test("runs under the owner's rules for the MR's author, not every rule", async () => {
      const done = { ...failure, at: at - INVESTIGATION_QUIET_TIME };
      const { f } = investigation([listing, job], {
        storage: ownerReady([listing, job], at, done),
      });
      const attempt = linkedAttempt(done);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/any')).rejects.toThrow(
        'needs one of these models: gitlab/strong',
      );
      const started = await f.authorizeStart(attempt, 'gitlab/strong');
      expect(started).toMatchObject({ startedAt: at, models: ['gitlab/strong'] });
      expect(await f.claims.records.read(batch)).toEqual(started);
      f.close();
    });

    test("refuses once the owner's rules no longer let it run in a worktree", async () => {
      const done = { ...failure, at: at - INVESTIGATION_QUIET_TIME };
      const inSession: AutomationRule = { ...listing, execution: 'session' };
      const { f } = investigation([inSession], {
        storage: ownerReady([inSession], at, done),
      });
      const attempt = linkedAttempt(done);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/strong')).rejects.toThrow(
        'no longer let this turn run in an environment',
      );
      f.close();
    });

    test('waits out the quiet time again after a later failure', async () => {
      let sleeps = 0;
      const later = { ...failure, id: 'f2', at: at + 60_000 };
      const context: { f?: ReturnType<typeof hostFixture>; advance?: (ms: number) => number } = {};
      const { f, advance, now } = investigation([listing], {
        sleep: async (ms) => {
          sleeps++;
          const at = context.advance!(ms);
          // The owner's instance keeps announcing itself.
          context.f!.storage[presenceKey('/owner')] = { at, instance: 'owner', rules: [listing] };
          // A failure during the wait replaces the batch's update.
          if (sleeps === 1) {
            const stored = (await context.f!.claims.records.read(batch))!;
            await context.f!.claims.records.save({ ...stored, item: later }, stored);
            context.f!.storage[`feedback-inbox/${encodeURIComponent('/owner')}`] = {
              items: [later],
              paused: false,
            };
          }
        },
      });
      Object.assign(context, { f, advance });
      const attempt = linkedAttempt(failure);
      await f.claims.records.save(attempt);
      await f.authorizeStart(attempt, 'gitlab/strong');
      const started = (await f.claims.records.read(batch))!;
      expect(started.item.id).toBe('f2');
      expect(started.startedAt).toBe(now());
      expect(now() - later.at).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
      f.close();
    });

    test('refuses once another session started in the worktree during the wait', async () => {
      const pages: Array<Array<Record<string, unknown>>> = [[]];
      const context: { f?: ReturnType<typeof hostFixture>; advance?: (ms: number) => number } = {};
      const { f, advance } = investigation([listing], {
        pages,
        sleep: async (ms) => {
          const at = context.advance!(ms);
          context.f!.storage[presenceKey('/owner')] = { at, instance: 'owner', rules: [listing] };
          // Someone starts a task in a package of the worktree.
          pages[0] = [
            { id: 'other', time: { idle: 1, busy: 2 }, location: { directory: '/repo/app' } },
          ];
        },
      });
      Object.assign(context, { f, advance });
      const attempt = linkedAttempt(failure);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/strong')).rejects.toThrow(
        'Another session is running in /repo',
      );
      expect((await f.claims.records.read(batch))?.startedAt).toBeUndefined();
      f.close();
    });

    test("reads the owner's rules after the wait, and refuses once its instance stopped", async () => {
      const context: { advance?: (ms: number) => number } = {};
      // The owner's instance stops announcing itself during the wait.
      const { f, advance } = investigation([listing], {
        sleep: async (ms) => void context.advance!(ms),
      });
      context.advance = advance;
      const attempt = linkedAttempt(failure);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/strong')).rejects.toThrow(
        "Forgekeeper isn't running in /owner",
      );
      expect((await f.claims.records.read(batch))?.startedAt).toBeUndefined();
      f.close();
    });
  });

  test('a service account MR runs in a worktree only when the rules covering its author opt in', async () => {
    const listing = { ...rule, authors: ['service-bot'], execution: 'environment' as const };
    const other = { ...rule, reviewers: ['bot'] };
    const service = { viewer: 'me', accounts: { 'service-bot': 'svc' }, checkout: 'main' };
    const covered = hostFixture({
      ...service,
      rules: [listing, other],
      request: { authorID: 'svc' },
    });
    // The rule without `checkout` doesn't cover the MR's author, so it doesn't count.
    expect(await covered.host.validate(review, true)).toEqual({
      placement: 'environment',
      rules: [listing],
    });
    covered.close();
    const inSession = { ...listing, execution: 'session' as const };
    const kept = hostFixture({
      ...service,
      rules: [inSession, other],
      request: { authorID: 'svc' },
    });
    await expect(kept.host.validate(review, true)).rejects.toThrow('The checkout does not match');
    kept.close();
  });

  test("a worktree whose instance hasn't started yet is checked by the turn's first request", async () => {
    // Listing plugins doesn't start an instance, so only the prompt can: no
    // presence is waited for before submitting.
    const f = hostFixture({ sessions: linkedSessions });
    expect(await f.host.environments!.providers[0].verify(linkedAttempt())).toBeUndefined();
    f.close();
  });

  test('a busy subagent, or a busy session on a later page, keeps the worktree from the turn', async () => {
    const at = Date.now();
    const verify = async (pages: Array<Array<Record<string, unknown>>>) => {
      const f = hostFixture({
        sessions: linkedSessions,
        pages,
        storage: { [presenceKey('/repo')]: { at, instance: 'here', rules: [] } },
      });
      const result = await f.host.environments!.providers[0].verify(linkedAttempt()).then(
        () => 'free',
        (error: Error) => error.message,
      );
      f.close();
      return { result, pages: f.listed.length };
    };
    const busy = { time: { idle: 1, busy: 2 } };
    expect(await verify([[{ id: 'child', parentID: 'other', ...busy }]])).toEqual({
      result: 'Another session is running in /repo',
      pages: 1,
    });
    expect(await verify([[{ id: 'idle', time: { idle: 2 } }], [{ id: 'late', ...busy }]])).toEqual({
      result: 'Another session is running in /repo',
      pages: 2,
    });
    expect(await verify([[{ id: 'idle', time: { idle: 2 } }]])).toEqual({
      result: 'free',
      pages: 1,
    });
  });

  test("a busy session below the worktree's directory keeps the worktree from the turn", async () => {
    const at = Date.now();
    const busy = { time: { idle: 1, busy: 2 } };
    const verify = async (directory: string) => {
      const f = hostFixture({
        sessions: linkedSessions,
        pages: [[{ id: 'nested', ...busy, location: { directory } }]],
        storage: { [presenceKey('/repo')]: { at, instance: 'here', rules: [] } },
      });
      const result = await f.host.environments!.providers[0].verify(linkedAttempt()).then(
        () => 'free',
        (error: Error) => error.message,
      );
      f.close();
      return { result, listed: f.listed[0] };
    };
    // OpenCode lists a directory's sessions without those below it, so the
    // project's are listed.
    expect(await verify('/repo/packages/app')).toEqual({
      result: 'Another session is running in /repo',
      listed: { project: 'project', archived: false, limit: 200 },
    });
    expect((await verify('/repo-other')).result).toBe('free');
  });

  test("a borrowed worktree with someone else's changes keeps the turn from it", async () => {
    const at = Date.now();
    const verify = async (owned: boolean) => {
      const f = hostFixture({
        sessions: linkedSessions,
        status: ' M file',
        storage: { [presenceKey('/repo')]: { at, instance: 'here', rules: [] } },
      });
      if (owned)
        await f.claims.worktrees.save({
          key: '/repo',
          directory: '/repo',
          name: 'forgekeeper-project-1-abcd1234',
          url,
          projectID: 'project',
          state: 'ready',
          at: 1,
        });
      const result = await f.host.environments!.providers[0].verify(linkedAttempt()).then(
        () => 'free',
        (error: Error) => error.message,
      );
      f.close();
      return result;
    };
    expect(await verify(false)).toBe("/repo has uncommitted changes that this task didn't make");
    // Forgekeeper's own worktree for the PR/MR keeps an earlier batch's fixes.
    expect(await verify(true)).toBe('free');
  });

  test("the linked session gets the owner's agent with its rules in the owning checkout", async () => {
    const asked: unknown[] = [];
    const ctx = {
      agent: {
        get: async (input: unknown) => {
          asked.push(input);
          return {
            data: { id: 'build', permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] },
          };
        },
      },
    } as unknown as Plugin.Context;
    const owner = {
      id: 'one',
      agent: 'build',
      location: { directory: '/owner' },
      permissions: [{ action: 'edit', resource: 'src/*', effect: 'allow' }],
    } as unknown as Parameters<typeof ownerPolicy>[1];
    // The owner's own rules follow its agent's, so they still win where
    // they match.
    expect(await ownerPolicy(ctx, owner)).toEqual({
      agent: 'build',
      permissions: [
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'edit', resource: 'src/*', effect: 'allow' },
      ],
    });
    expect(asked).toEqual([{ agentID: 'build', location: { directory: '/owner' } }]);
    // Without an agent of the owner's own, its rules can't be read for certain.
    const implicit = { ...owner, agent: undefined } as unknown as typeof owner;
    await expect(ownerPolicy(ctx, implicit)).rejects.toBeInstanceOf(Ineligible);
  });

  test('the push command for a detached worktree reads every branch name literally', async () => {
    for (const branch of ['feature;pwd', 'a$(id)b', "it's", 'tick`id`', 'x```y']) {
      const notice = pushNotice(branch, 'my fork');
      const fence = notice.match(/(`{3,})sh\n([\s\S]*?)\n\1$/);
      expect(fence).not.toBeNull();
      const result = Bun.spawnSync(['sh', '-c', `git() { printf '%s\\n' "$@"; }\n${fence![2]}`]);
      expect(result.stdout.toString()).toBe(`push\nmy fork\nHEAD:refs/heads/${branch}\n`);
    }
  });

  test('keeps watching a linked attempt whose owner was deleted', async () => {
    const f = hostFixture({ sessions: { one: undefined as never } });
    delete f.sessions.one;
    const attempt = {
      ...linkedAttempt(),
      execution: { ...linkedAttempt().execution!, ownerDirectory: '/repo' },
    };
    await f.claims.records.save(attempt);
    expect(await f.restorable()).toEqual([attempt]);
    f.close();
  });

  test("puts the task in place of the placeholder only in its linked session's started turn", async () => {
    const f = hostFixture();
    const stored: AutomationRecord = {
      ...record,
      execution: {
        stage: 'submitting',
        ownerDirectory: '/repo',
        head,
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        provider: 'local-worktree',
        version: 1,
        state: { directory: '/worktree', sessionID: 'linked' },
        prompt: 'the findings',
      },
    };
    await f.claims.records.save(stored);
    const request = (sessionID: string) => ({
      sessionID,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `Task\n\n[forgekeeper:${messageID}]` }] },
      ] as Array<{ role: string; content: unknown }>,
    });
    const owner = request('one');
    await f.substitutePrompt(owner);
    expect(JSON.stringify(owner.messages)).not.toContain('the findings');
    const ran = request('linked');
    await f.substitutePrompt(ran);
    expect(ran.messages[0].content).toEqual([{ type: 'text', text: 'the findings' }]);
    await f.claims.records.save({ ...stored, startedAt: undefined }, stored);
    const unstarted = request('linked');
    await f.substitutePrompt(unstarted);
    expect(JSON.stringify(unstarted.messages)).not.toContain('the findings');
    f.close();
  });

  test('restores the task of the turn a compaction removed the placeholder from', async () => {
    const f = hostFixture();
    const stored: AutomationRecord = {
      ...record,
      execution: {
        stage: 'submitting',
        ownerDirectory: '/repo',
        head,
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        provider: 'local-worktree',
        version: 1,
        state: { directory: '/worktree', sessionID: 'linked' },
        prompt: 'the findings',
      },
    };
    await f.claims.records.save(stored);
    const compacted = {
      sessionID: 'linked',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Summary so far' }] },
      ] as Array<{
        role: string;
        content: unknown;
      }>,
    };
    await f.substitutePrompt(compacted, stored);
    expect(compacted.messages.map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'the findings' }],
      [{ type: 'text', text: 'Summary so far' }],
    ]);
    // With the placeholder still there, the task replaces it, once.
    const tagged = {
      sessionID: 'linked',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `Task\n\n[forgekeeper:${messageID}]` }] },
      ] as Array<{ role: string; content: unknown }>,
    };
    await f.substitutePrompt(tagged, stored);
    expect(tagged.messages).toHaveLength(1);
    // Another session's request never gets it.
    const other = { sessionID: 'one', messages: [] as unknown[] };
    await f.substitutePrompt(other, stored);
    expect(other.messages).toEqual([]);
    f.close();
  });

  test('the linked session, not the owner, holds the preparation', async () => {
    const f = hostFixture();
    const stored: AutomationRecord = {
      ...record,
      execution: {
        stage: 'submitting',
        ownerDirectory: '/repo',
        head,
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        provider: 'local-worktree',
        version: 1,
        state: { directory: '/worktree', sessionID: 'linked' },
        prompt: 'the findings',
      },
    };
    await f.claims.records.save(stored);
    const ctx = {
      session: { context: async () => [message('user', messageID, 5)] },
    } as unknown as Plugin.Context;
    expect(await storedPreparation(ctx, f.claims, 'linked')).toEqual(stored);
    await expect(storedPreparation(ctx, f.claims, 'one')).rejects.toThrow('unavailable');
    f.close();
  });

  test('extracts the final assistant report for a linked turn, including after compaction', () => {
    const assistant = (id: string, at: number, text: string) =>
      message('assistant', id, at, { content: [{ type: 'text', text }] });
    const toolOnly = (id: string, at: number) =>
      message('assistant', id, at, { content: [{ type: 'tool', id: 't1', name: 'shell' }] });
    expect(
      extractTurnReport(
        [
          message('user', messageID, 10),
          assistant('a1', 11, 'Checking pipeline logs...'),
          toolOnly('a2', 12),
          assistant('a3', 13, 'Root cause: missing coverage on collect_stats.'),
          message('idle', 'i1', 14, { outcome: 'succeeded' }),
          message('user', 'u2', 20),
          assistant('a4', 21, 'Follow-up turn text that belongs to a later turn.'),
        ],
        { messageID, startedAt: 10 },
      ),
    ).toBe('Root cause: missing coverage on collect_stats.');
    expect(
      extractTurnReport(
        [
          message('compaction', 'c1', 15),
          assistant('a1', 20, 'Compacted turn final report.'),
          message('idle', 'i1', 25, { outcome: 'succeeded' }),
          message('user', 'u2', 30),
          assistant('a2', 35, 'Later turn.'),
        ],
        { messageID, startedAt: 10, ended: { outcome: 'succeeded', at: 25 } },
      ),
    ).toBe('Compacted turn final report.');
    const huge = 'x'.repeat(5_000);
    const clipped = extractTurnReport([message('user', messageID, 10), assistant('a1', 11, huge)], {
      messageID,
      startedAt: 10,
    });
    expect(clipped).toBeDefined();
    expect(clipped!.length).toBeLessThanOrEqual(3_500);
    expect(clipped).toContain('truncated');
  });

  test('surfaces linked-session reports and clear descriptions to the owning session', async () => {
    const jobItem = { ...review, id: 'f1', kind: 'ci-failed' as const, pipeline: 'p1' };
    const ownerMessages: Message[] = [];
    const f = hostFixture({
      sessions: linkedSessions,
      status: ' M scripts/perf/gc/collect_gc_stats.rb',
      transcripts: {
        one: ownerMessages,
        linked: [
          message('user', messageID, 10),
          message('assistant', 'a1', 12, {
            content: [{ type: 'text', text: 'Undercover flagged collect_stats at 0% coverage.' }],
          }),
          message('idle', 'i1', 15, { outcome: 'succeeded' }),
        ],
      },
    });
    const startedAttempt: LinkedRecord = { ...linkedAttempt(jobItem), startedAt: 10 };
    await f.host.notify!(startedAttempt, 'started');
    await f.host.notify!(
      {
        ...startedAttempt,
        state: 'completed',
        reason: 'The investigation finished.',
        ended: { outcome: 'succeeded', at: 15 },
      },
      'ended',
    );
    expect(f.synthetic).toHaveLength(2);
    expect(f.synthetic[0]).toMatchObject({
      sessionID: 'one',
      description: 'Forgekeeper: investigating failed jobs for !1',
      metadata: { forgekeeper: SUMMARY_KIND },
      resume: false,
    });
    expect(f.synthetic[1]).toMatchObject({
      sessionID: 'one',
      description: 'Forgekeeper: failed-job investigation completed for !1',
      metadata: { forgekeeper: SUMMARY_KIND },
      resume: true,
    });
    expect(String(f.synthetic[1].text)).not.toContain('Undercover flagged');
    const deliver = async (index: number) => {
      ownerMessages.push(message('synthetic', String(f.synthetic[index].id), index + 20));
      const request = {
        sessionID: 'one',
        messages: [],
        options: {},
        system: [],
        tools: { bash: {} },
      };
      expect(await f.summaries.prepare(request)).toBe(true);
      expect(Object.keys(request.tools)).toHaveLength(0);
      return JSON.stringify(request.messages);
    };
    expect(await deliver(0)).not.toContain('Undercover flagged');
    const completion = await deliver(1);
    expect(completion).toContain('Undercover flagged collect_stats at 0% coverage.');
    expect(completion).toContain('M scripts/perf/gc/collect_gc_stats.rb');

    // An automatic attempt that failed before starting does not wake the owner.
    await f.host.notify!(
      {
        ...linkedAttempt(jobItem),
        state: 'failed',
        reason: 'The pipeline no longer has failed jobs.',
      },
      'ended',
    );
    expect(f.synthetic[2]).toMatchObject({
      description: 'Forgekeeper: failed-job investigation failed for !1',
      resume: false,
    });

    await f.host.notify!(
      {
        ...linkedAttempt(jobItem),
        execution: { stage: 'provisioning', provider: 'local-worktree', version: 1, state: {} },
        state: 'failed',
        manual: true,
        reason: 'No worktree available.',
      },
      'ended',
    );
    expect(f.synthetic[3].resume).toBe(true);
    expect(await deliver(3)).toContain('No worktree available.');

    // An archived owning session is not woken or notified.
    f.sessions.one = { id: 'one', time: { archived: 1 }, location: { directory: '/owner' } };
    await f.host.notify!({ ...startedAttempt, state: 'completed' }, 'ended');
    expect(f.synthetic).toHaveLength(4);
    f.close();
  });

  test('appends non-interactive linked-session instructions only for environment executions', () => {
    const f = hostFixture();
    expect(f.instructions(record)).not.toContain(LINKED_INSTRUCTIONS);
    expect(f.instructions(linkedAttempt())).toContain(LINKED_INSTRUCTIONS);
    f.close();
  });

  test('verifies bot approvals, refuses human approvals, and runs approval turns in the owning session', async () => {
    const approvalItem = {
      id: 'approval-1',
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !1',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      at: 10,
      automationAllowed: true,
    };
    const envRule: AutomationRule = {
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare',
      execution: 'environment',
      allowedModels: ['gitlab/allowed'],
    };
    const f = hostFixture({
      checkout: 'other-branch',
      rules: [envRule],
      accounts: { gitlabduo: 'duo-id', alice: 'alice-id' },
      request: {
        draft: true,
        reviewersComplete: true,
        approvers: [
          { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true },
          { id: 'alice-id', username: 'alice' },
        ],
      },
    });
    try {
      // Runs in the owning session even when the checkout is on a different branch and the rule uses environment execution.
      const validation = await f.host.validate(approvalItem, true);
      expect(validation.placement).toBe('session');

      const verified = await f.host.approvals!(approvalItem, ['gitlabduo']);
      expect(verified.approvers).toEqual([
        { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true, reviewer: 'gitlabduo' },
      ]);

      // Human approvals are always rejected with Ineligible, even if listed in reviewers or run manually.
      const humanItem = {
        ...approvalItem,
        id: 'approval-human',
        reviewers: ['alice'],
        approverKind: 'human' as const,
      };
      await expect(f.host.approvals!(humanItem, ['alice'])).rejects.toBeInstanceOf(Ineligible);
      await expect(f.host.approvals!(humanItem, undefined)).rejects.toBeInstanceOf(Ineligible);

      // Approval turns get approval follow-up instructions.
      expect(f.instructions({ ...record, item: approvalItem })).toContain(
        'review approval follow-up',
      );
    } finally {
      f.close();
    }
  });

  test('authorizeStart aborts an approval turn if the reviewer unapproves before the model request', async () => {
    const approvalItem = {
      id: 'approval-1',
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !1',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      at: 10,
      automationAllowed: true,
    };
    const duoRule: AutomationRule = {
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare',
      allowedModels: ['gitlab/allowed'],
    };
    const f = hostFixture({
      rules: [duoRule],
      accounts: { gitlabduo: 'duo-id' },
      items: [approvalItem],
      request: {
        draft: true,
        reviewersComplete: true,
        approvers: [],
      },
    });
    const queued: AutomationRecord = {
      ...record,
      item: approvalItem,
      state: 'running',
      digest: approvalDigest([
        { id: 'duo-id', username: 'GitLabDuo', automated: true, reviewID: 'r1' },
      ]),
    };
    try {
      await expect(f.authorizeStart(queued, 'gitlab/allowed')).rejects.toThrow(
        'The reviewer approval changed after the task was queued',
      );
    } finally {
      f.close();
    }
  });

  test('rejects replacement approval B before preparation and enforces author/reviewer rules on manual Act', async () => {
    const approvalA = {
      id: 'approval-A',
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !1',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      approverID: 'duo-id',
      approvalToken: '2026-11-24T07:00:00Z',
      approvalCycle: 1,
      at: 10,
      automationAllowed: true,
    };
    const duoRule: AutomationRule = {
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare',
    };
    // Approval A is replaced by B (different reviewID) before preparation: A matches nothing.
    const replaced = hostFixture({
      rules: [duoRule],
      accounts: { gitlabduo: 'duo-id' },
      items: [approvalA],
      request: {
        draft: true,
        reviewersComplete: true,
        approvalsComplete: true,
        approvers: [
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewID: '2026-11-24T08:00:00Z',
          },
        ],
      },
    });
    try {
      const verified = await replaced.host.approvals!(approvalA, ['gitlabduo']);
      expect(verified.approvers).toEqual([]);
    } finally {
      replaced.close();
    }

    // Manual Act on another author's MR without that author listed in rules is refused.
    const otherAuthor = hostFixture({
      rules: [duoRule],
      viewer: 'me',
      accounts: { gitlabduo: 'duo-id' },
      items: [approvalA],
      request: {
        authorID: 'someone-else',
        draft: true,
        reviewersComplete: true,
        approvers: [
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewID: '2026-11-24T07:00:00Z',
          },
        ],
      },
    });
    try {
      await expect(otherAuthor.host.validate(approvalA, false)).rejects.toThrow(
        'approval follow-up is not authorized',
      );
      const manualQueued: AutomationRecord = {
        ...record,
        item: approvalA,
        manual: true,
        state: 'running',
        digest: approvalDigest([
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            automated: true,
            reviewID: '2026-11-24T07:00:00Z',
          },
        ]),
      };
      await expect(otherAuthor.authorizeStart(manualQueued, 'gitlab/allowed')).rejects.toThrow(
        'approval follow-up is not authorized',
      );
    } finally {
      otherAuthor.close();
    }
  });
});
