import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedMetadata } from './linked-session';
import type { AutomationRecord } from './review-automation';
import { createReviewClaims } from './review-claim';
import { preparationMessageID } from './review-preparation';
import {
  defaultSessions,
  duoComment,
  harness,
  mr,
  ProviderMessage,
  settle,
  StatusForge,
  textOf,
  type Transcript,
} from './server-harness';
import { until } from './testing';

describe('review preparation integration', () => {
  test('disabled monitoring refuses a compacted preparation after reload', async () => {
    const claims = createReviewClaims(':memory:');
    const batch = 'a'.repeat(64);
    await claims.records.save({
      batch,
      messageID: preparationMessageID(batch, 1),
      state: 'running',
      startedAt: 10,
      at: 1,
      attempt: 1,
      item: {
        id: 'item',
        sessionID: 'one',
        url: 'https://gitlab.com/group/project/-/merge_requests/1',
        title: 'Review',
        links: [],
        at: 1,
      },
    });
    const app = await harness({
      status: new StatusForge(),
      reviewClaims: claims,
      pluginOptions: { status: false },
      transcripts: new Map([
        ['one', [{ type: 'compaction', id: 'compact', time: { created: 20 } }]],
      ]),
    });
    try {
      await expect(app.request()).rejects.toThrow('Review preparation is disabled');
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test.each(['pause', 'acknowledge', 'target', 'move', 'edit'] as const)(
    'cancels an admitted preparation before its first coding request on %s',
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), 'forgekeeper-cancel-'));
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const url = 'https://gitlab.com/group/project/-/merge_requests/1';
        const forge = new StatusForge();
        forge.set('group/project', '1', { sourceBranch: 'feature' });
        const claims = createReviewClaims(root);
        let body = 'Finding';
        const app = await harness({
          status: forge,
          reviewClaims: claims,
          feedback: async () => ({ complete: true, comments: [duoComment(url, '1')] }),
          details: async () => [
            {
              id: '1',
              url: `${url}#note_1`,
              username: 'GitLabDuo',
              authorID: 'duo',
              body,
            },
          ],
        });
        cleanup = app.cleanup;
        await app.set({ target: url });
        app.storage.set('feedback-inbox/%2Frepo', {
          paused: false,
          items: [
            {
              id: 'cancel',
              sessionID: 'one',
              url,
              title: 'Review',
              links: [`${url}#note_1`],
              commentIDs: ['1'],
              at: 1,
            },
          ],
        });
        await app.actOnFeedback('cancel');
        await until(() => app.prompts.length === 1, 100_000);
        if (action === 'pause') await app.pauseFeedback(true);
        if (action === 'acknowledge') await app.acknowledgeFeedback('cancel');
        if (action === 'target') await app.set({ target: 'none' });
        if (action === 'move') app.sessions.get('one')!.location.directory = '/other';
        if (action === 'edit') body = 'An edited finding';
        await expect(app.request()).rejects.toThrow(
          action === 'edit' ? 'findings changed' : undefined,
        );
        const [record] = await claims.records.list();
        expect(record.state).toBe('failed');
        expect(await claims.read(url)).toBeUndefined();
      } finally {
        await cleanup?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test("automation skips another author's MR and still delivers its summary", async () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/1';
    const forge = new StatusForge();
    forge.set('group/project', '1', { sourceBranch: 'feature', authorID: 'colleague' });
    const claims = createReviewClaims(':memory:');
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      storage: new Map<string, unknown>([
        ['sessions/one', { targets: [{ url }] }],
        [
          'feedback-inbox/%2Frepo',
          {
            paused: false,
            items: [
              {
                id: 'colleague-review',
                sessionID: 'one',
                url,
                title: 'Review',
                links: [`${url}#note_1`],
                commentIDs: ['1'],
                at: 1,
                automationAllowed: true,
                delivery: 'summary',
              },
            ],
          },
        ],
      ]),
      reviewerID: async () => 'duo',
      feedback: async () => ({ complete: true, comments: [duoComment(url, '1')] }),
      details: async () => [
        { id: '1', url: `${url}#note_1`, username: 'GitLabDuo', authorID: 'duo', body: 'Finding' },
      ],
      pluginOptions: {
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['GitLabDuo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await until(() => app.synthetic.length === 1 || app.notices().length > 0, 100_000);
      expect(app.notices()).toEqual([]);
      expect(app.prompts).toHaveLength(0);
      const [record] = await claims.records.list();
      expect(record).toMatchObject({ state: 'skipped' });
      expect(record.reason).toContain('You did not write this MR');
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test.each(['first', 'later'] as const)(
    "refuses a preparation's %s request on a model its rule doesn't allow",
    async (request) => {
      const url = 'https://gitlab.com/group/project/-/merge_requests/1';
      const forge = new StatusForge();
      forge.set('group/project', '1', { sourceBranch: 'feature' });
      const claims = createReviewClaims(':memory:');
      const app = await harness({
        status: forge,
        reviewClaims: claims,
        storage: new Map<string, unknown>([
          ['sessions/one', { targets: [{ url }] }],
          [
            'feedback-inbox/%2Frepo',
            {
              paused: false,
              items: [
                {
                  id: 'restricted',
                  sessionID: 'one',
                  url,
                  title: 'Review',
                  links: [`${url}#note_1`],
                  commentIDs: ['1'],
                  at: 1,
                  automationAllowed: true,
                },
              ],
            },
          ],
        ]),
        reviewerID: async () => 'duo',
        feedback: async () => ({ complete: true, comments: [duoComment(url, '1')] }),
        details: async () => [
          {
            id: '1',
            url: `${url}#note_1`,
            username: 'GitLabDuo',
            authorID: 'duo',
            body: 'Finding',
          },
        ],
        pluginOptions: {
          automation: {
            modelGroups: { coding: ['gitlab/strong'] },
            rules: [
              {
                on: 'review',
                host: 'gitlab.com',
                projects: ['group/project'],
                reviewers: ['GitLabDuo'],
                action: 'prepare',
                allowedModelGroup: 'coding',
              },
            ],
          },
        },
      });
      try {
        await until(() => app.prompts.length === 1 || app.notices().length > 0, 100_000);
        expect(app.prompts).toHaveLength(1);
        if (request === 'later') {
          await app.request();
          expect((await claims.records.list())[0]).toMatchObject({
            state: 'running',
            models: ['gitlab/strong'],
          });
        }
        app.useModel('gitlab/cheap');
        await expect(app.request()).rejects.toThrow(
          request === 'first'
            ? 'This session uses gitlab/cheap. Switch models, then use Retry feedback work.'
            : 'This session uses gitlab/cheap. The turn may have made changes. Inspect the session',
        );
        if (request === 'first') {
          const [record] = await claims.records.list();
          expect(record.state).toBe('failed');
          expect(record.reason).toContain('then use Retry feedback work');
          expect(record.startedAt).toBeUndefined();
          expect(await claims.read(url)).toBeUndefined();
        }
      } finally {
        await app.cleanup();
        claims.close();
      }
    },
  );

  test.each(['manual', 'automatic'] as const)(
    '%s action verifies findings, preserves coding tools, and adds preparation instructions',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'forgekeeper-integration-'));
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const url = 'https://gitlab.com/group/project/-/merge_requests/1';
        const forge = new StatusForge();
        forge.set('group/project', '1', { sourceBranch: 'feature' });
        const comments = [duoComment(url, '1'), { ...duoComment(url, '2'), authorID: 'impostor' }];
        const id = 'integration-review';
        const storage = new Map<string, unknown>();
        const transcripts = new Map<string, Transcript>();
        // A summary still queued behind the preparation turn.
        storage.set('status/summaries/one/msg_forgekeeper_summary_queued', {
          sessionID: 'one',
          messageID: 'msg_forgekeeper_summary_queued',
          findings: 'Another review',
          at: Date.now(),
        });
        if (mode === 'automatic') {
          storage.set('sessions/one', { targets: [{ url }] });
          storage.set('feedback-inbox/%2Frepo', {
            paused: false,
            items: [
              {
                id,
                sessionID: 'one',
                url,
                title: 'Review',
                links: comments.map((comment) => comment.url),
                commentIDs: ['1', '2'],
                at: 1,
                automationAllowed: true,
                delivery: 'summary',
              },
            ],
          });
        }
        const claims = createReviewClaims(root);
        const app = await harness({
          status: forge,
          reviewClaims: claims,
          storage,
          transcripts,
          reviewerID: async () => 'duo',
          feedback: async () => ({ complete: true, comments }),
          details: async (_request, ids) =>
            ids.map((commentID) => ({
              id: commentID,
              url: `${url}#note_${commentID}`,
              username: 'GitLabDuo',
              authorID: commentID === '1' ? 'duo' : 'impostor',
              body: `Finding ${commentID}`,
            })),
          pluginOptions: {
            delivery: { reviews: 'summary' },
            automation: {
              rules: [
                {
                  on: 'review',
                  host: 'gitlab.com',
                  projects: ['group/project'],
                  reviewers: ['GitLabDuo'],
                  action: 'prepare',
                },
              ],
            },
          },
        });
        cleanup = app.cleanup;
        if (mode === 'manual') {
          await app.set({ target: url });
          app.storage.set('feedback-inbox/%2Frepo', {
            paused: false,
            items: [
              {
                id,
                sessionID: 'one',
                url,
                title: 'Review',
                links: comments.map((comment) => comment.url),
                commentIDs: ['1', '2'],
                at: 1,
                automationAllowed: true,
              },
            ],
          });
          await app.actOnFeedback(id);
        }
        await until(() => app.prompts.length === 1 || app.notices().length > 0, 100_000);
        expect(app.notices()).toEqual([]);
        expect((await app.feedback()).items[0]?.automation?.reason).toBeUndefined();
        expect(app.prompts).toHaveLength(1);
        expect(app.prompts[0].text).toContain('Finding 1');
        if (mode === 'manual') expect(app.prompts[0].text).toContain('Finding 2');
        else expect(app.prompts[0].text).not.toContain('Finding 2');
        expect(app.synthetic).toHaveLength(0);
        const request = await app.request();
        expect(Object.keys(request.tools)).toEqual(['read', 'bash']);
        const system = request.system.map((part) => part.text).join('\n');
        expect(system).toContain('Leave all changes uncommitted');
        expect(system).toContain('Never assign a merge request to a bot');
        expect(system).toContain('Never mark checklist tasks or attestations as done');
        expect(await app.permission()).toBe('allow');
        transcripts.set('one', [
          { type: 'compaction', id: 'compacted', time: { created: Date.now() + 1 } },
        ]);
        const continued = await app.request();
        expect(continued.system.map((part) => part.text).join('\n')).toContain(
          'Leave all changes uncommitted',
        );
        expect(Object.keys(continued.tools)).toEqual(['read', 'bash']);
        expect(await app.toolCall()).toBeUndefined();
        expect(await app.permission()).toBe('allow');
        // The turn's end is recorded as it happens, since the compaction
        // removed the prompt that would otherwise tie it to the attempt.
        const [started] = await claims.records.list();
        app.emit({
          type: 'session.execution.interrupted',
          data: { sessionID: 'one', reason: 'shutdown' },
          created: started.startedAt! + 1,
        });
        app.emit({
          type: 'session.execution.failed',
          data: { sessionID: 'one' },
          created: started.startedAt! + 2,
        });
        let ended: AutomationRecord['ended'];
        for (let turn = 0; turn < 1_000 && !ended; turn++) {
          ended = (await claims.records.list())[0].ended;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(ended).toEqual({
          outcome: 'failed',
          at: started.startedAt! + 2,
        });
      } finally {
        await cleanup?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('linked sessions', () => {
  const batch = 'b'.repeat(64);
  const linkedSessions = () => {
    const sessions = defaultSessions() as Map<
      string,
      {
        title: string;
        location: { directory: string };
        parentID: string | undefined;
        fork?: { sessionID: string };
        metadata?: Record<string, unknown>;
      }
    >;
    sessions.set('linked', {
      title: 'Forgekeeper: investigate https://gitlab.com/group/project/-/merge_requests/456',
      location: { directory: '/repo' },
      parentID: undefined,
      metadata: linkedMetadata('one', batch, 'linked'),
    });
    sessions.set('linked-child', {
      title: 'Subagent',
      location: { directory: '/repo' },
      parentID: 'linked',
    });
    sessions.set('normal-child', {
      title: 'Normal subagent',
      location: { directory: '/repo' },
      parentID: 'one',
    });
    return sessions;
  };

  test('does not prefix linked session titles or store target state on turn end or rename', async () => {
    const storage = new Map<string, unknown>();
    const sessions = linkedSessions();
    const initialTitle = sessions.get('linked')!.title;
    const app = await harness({
      storage,
      sessions,
    });
    await app.set({ target: mr }, 'two');
    app.sessions.get('two')!.title = 'Other session';
    app.emit({ type: 'session.execution.succeeded', data: { sessionID: 'linked' } });
    app.emit({ type: 'session.renamed', data: { sessionID: 'linked' } });
    app.emit({ type: 'session.execution.succeeded', data: { sessionID: 'two' } });
    await settle();
    expect(app.sessions.get('linked')!.title).toBe(initialTitle);
    expect(app.sessions.get('two')!.title).toBe('[!456] Other session');
    expect(app.renames()).toBe(2);
    expect(storage.has('sessions/linked')).toBe(false);
    await app.cleanup();
  });

  test('never looks up or polls PR/MR status for linked sessions', async () => {
    const forge = new StatusForge();
    forge.set('group/project', '456');
    const app = await harness({ status: forge, sessions: linkedSessions() });
    const result = await app.refresh('linked');
    expect(result.snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'The session runs a Forgekeeper task for another session',
    });
    expect(forge.lookups).toEqual([]);
    await app.cleanup();
  });

  test('strips interactive and target tools for linked sessions and their subagents', async () => {
    const app = await harness({ sessions: linkedSessions() });
    const extraTools = {
      set_session_target: { description: 'Set target' },
      question: { description: 'Ask user' },
    };
    const linkedReq = await app.request('linked', false, undefined, extraTools);
    expect(linkedReq.tools.set_session_target).toBeUndefined();
    expect(linkedReq.tools.question).toBeUndefined();
    expect(linkedReq.tools.read).toBeDefined();

    const linkedChildReq = await app.request('linked-child', false, undefined, extraTools);
    expect(linkedChildReq.tools.set_session_target).toBeUndefined();
    expect(linkedChildReq.tools.question).toBeUndefined();

    const normalChildReq = await app.request('normal-child', false, undefined, extraTools);
    expect(normalChildReq.tools.set_session_target).toBeUndefined();
    expect(normalChildReq.tools.question).toBeDefined();

    const ownerReq = await app.request('one', false, undefined, extraTools);
    expect(ownerReq.tools.set_session_target).toBeDefined();
    expect(ownerReq.tools.question).toBeDefined();
    await app.cleanup();
  });

  test('denies interactive permission prompts in linked sessions and their subagents', async () => {
    const app = await harness({ sessions: linkedSessions() });
    const linkedAsk = await app.evaluatePermission('linked', 'ask');
    expect(linkedAsk.effect).toBe('deny');
    expect(linkedAsk.message).toContain('background');

    const childAsk = await app.evaluatePermission('linked-child', 'ask');
    expect(childAsk.effect).toBe('deny');
    expect(childAsk.message).toContain('background');

    // Pre-approved actions still run, and normal sessions still prompt.
    expect((await app.evaluatePermission('linked', 'allow')).effect).toBe('allow');
    expect((await app.evaluatePermission('one', 'ask')).effect).toBe('ask');
    expect((await app.evaluatePermission('normal-child', 'ask')).effect).toBe('ask');
    const parent = app.sessions.get('linked')!;
    app.sessions.delete('linked');
    expect((await app.evaluatePermission('linked-child', 'ask')).effect).toBe('deny');
    const unresolved = await app.request('linked-child', false, undefined, { question: {} });
    expect(unresolved.tools.question).toBeUndefined();
    app.sessions.set('linked', parent);
    await app.cleanup();
  });

  test('injects linked-session instructions and strips interactive tools during an automated turn', async () => {
    const claims = createReviewClaims(':memory:');
    const msgID = preparationMessageID(batch, 1);
    await claims.records.save({
      batch,
      messageID: msgID,
      state: 'running',
      startedAt: 10,
      at: 1,
      attempt: 1,
      placement: 'environment',
      execution: {
        stage: 'submitting',
        provider: 'local-worktree',
        version: 1,
        ownerDirectory: '/owner',
        head: 'a'.repeat(40),
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        state: { directory: '/repo', sessionID: 'linked' },
        prompt: 'Investigate failed job rspec:coverage.',
      },
      item: {
        id: 'ci-1',
        kind: 'ci-failed',
        sessionID: 'one',
        url: 'https://gitlab.com/group/project/-/merge_requests/456',
        title: '!456: job rspec:coverage failed in its pipeline',
        links: [],
        pipeline: 'p1',
        at: 1,
      },
    });
    const app = await harness({
      status: new StatusForge(),
      reviewClaims: claims,
      sessions: linkedSessions(),
      transcripts: new Map([['linked', [{ type: 'user', id: msgID, time: { created: 10 } }]]]),
    });
    try {
      const event = await app.request(
        'linked',
        false,
        [
          new ProviderMessage({
            role: 'user',
            content: [{ type: 'text', text: `Placeholder\n\n[forgekeeper:${msgID}]` }],
          }),
        ],
        {
          set_session_target: { description: 'Set target' },
          question: { description: 'Ask user' },
        },
      );
      expect(event.system.map((part) => part.text).join('\n')).toContain(
        'background linked session',
      );
      expect(event.tools.question).toBeUndefined();
      expect(event.tools.set_session_target).toBeUndefined();
      expect(event.tools.read).toBeDefined();
      expect(event.tools.bash).toBeDefined();
      expect(textOf(event)).toBe('Investigate failed job rspec:coverage.');
    } finally {
      await app.cleanup();
      claims.close();
    }
  });
});
