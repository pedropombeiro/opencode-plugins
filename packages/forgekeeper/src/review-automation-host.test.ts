import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import {
  createAutomationHost,
  readVerifiedFindings,
  type AutomationDependencies,
} from './review-automation-host';
import type { AutomationRecord } from './review-automation';
import { createReviewClaims } from './review-claim';
import { preparationMessageID } from './review-preparation';

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
