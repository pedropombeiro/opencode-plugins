import { describe, expect, test } from 'bun:test';
import type { GitHubPullRequest, GitLabMergeRequest, ReviewComment } from './forge';
import { footerSegments } from './format';
import { FETCH_INTERVAL, SETTLE_TIME } from './human-review-watch';
import {
  announcedIn,
  defaultSessions,
  duoComment,
  feedbackReader,
  harness,
  pendingRecord,
  projectA,
  projectB,
  quiet,
  settle,
  StatusForge,
  watchedFeedback,
} from './server-harness';

describe('PR/MR status', () => {
  test("serves a shown session's status and publishes changes", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { title: 'Add things' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    const watched = await app.watch(['one'], 'one');
    expect(watched.enabled).toBe(true);
    await settle();
    expect(app.lastStatus()?.snapshot.lookup).toMatchObject({
      kind: 'found',
      explicitTarget: true,
      requests: [{ iid: '1' }],
    });
    expect((await app.watch(['one'], 'one')).statuses.one.lookup).toMatchObject({
      requests: [{ title: 'Add things' }],
    });
    await app.cleanup();
  });

  test('publishes whether the targets include a PR/MR before looking them up', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.watch(['one'], 'one');
    await settle();
    expect(app.lastStatus()?.snapshot.targeted).toBeUndefined();

    forge.gated = true;
    await app.set({ target: projectA });
    await settle();
    expect(app.lastStatus()?.snapshot).toMatchObject({ loading: true, targeted: true });
    expect(footerSegments(app.lastStatus()!.snapshot)).toEqual([]);
    forge.open();
    await settle();

    await app.set({ target: 'https://gitlab.com/group/a/-/issues/2' });
    await settle();
    expect(app.lastStatus()?.snapshot.targeted).toBeUndefined();
    await app.cleanup();
  });

  test('sends only JSON over RPC, even after a lookup clears an error', async () => {
    // JSON has no `undefined`, and the RPC rejects outputs that contain it.
    const hasUndefined = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === 'object' &&
        value !== null &&
        Object.values(value).some((entry) => hasUndefined(entry)));
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    const outputs = [
      await app.refresh(),
      await app.watch(['one'], 'one'),
      ...app.emitted.map((event) => event.data),
    ];
    expect(outputs.filter(hasUndefined)).toEqual([]);
    await app.cleanup();
  });

  test('never notifies about a target removed while its lookup was running', async () => {
    // Same MR number in two projects, so the title prefix doesn't change.
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    forge.set('group/b', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();

    forge.gated = true;
    const polling = app.refresh();
    await settle();
    await app.set({ target: projectB });
    const changed = app.emitted.length;
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.open();
    await polling;
    await settle();

    expect(app.synthetic).toEqual([]);
    expect(app.lastStatus()?.snapshot.lookup).toMatchObject({ requests: [{ url: projectB }] });
    // The old target's result is discarded, not shown or watched.
    const published = app.emitted.slice(changed).filter((event) => event.name === 'status');
    expect(JSON.stringify(published)).not.toContain('"REVIEWED"');
    await app.cleanup();
  });

  test("records a target's published Duo findings without an agent message", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    let comments: ReviewComment[] = [];
    const app = await harness({
      status: forge,
      pluginOptions: { ...quiet, delivery: { reviews: 'inbox' } },
      feedback: async () => ({ complete: true, viewerID: 'me', comments }),
    });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    // Hidden after being shown, but still polled because the review is running.
    await app.watch(['one'], '');
    forge.set('group/a', '1', { duoReviewState: 'REQUESTED_CHANGES' });
    comments = [duoComment(projectA, '7')];
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect((await app.feedback()).items).toMatchObject([{ sessionID: 'one', url: projectA }]);
    expect(app.notices()).toMatchObject([
      { sessionID: 'one', title: 'New GitLab Duo review feedback on !1', variant: 'info' },
    ]);
    await app.cleanup();
  });

  test('keeps failed Duo findings unannounced and reports the failure', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    let comments: ReviewComment[] = [];
    const app = await harness({
      status: forge,
      pluginOptions: quiet,
      failingInbox: 1,
      feedback: async () => ({ complete: true, viewerID: 'me', comments }),
    });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    comments = [duoComment(projectA, '7')];
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toMatchObject([{ variant: 'error' }]);
    expect(announcedIn(app.storage)).toEqual([]);
    await app.cleanup();
  });

  test('ignores branch and title references and removes only the old managed prefix', async () => {
    const forge = new StatusForge();
    forge.set('group/project', '1', { state: 'closed' });
    forge.branch = [
      {
        forge: 'gitlab',
        iid: '2',
        url: 'https://gitlab.com/group/project/-/merge_requests/2',
        state: 'opened',
      } as GitLabMergeRequest,
    ];
    const storage = new Map<string, unknown>([['sessions/two', { prefix: '[!1]' }]]);
    const app = await harness({
      status: forge,
      storage,
      pluginOptions: quiet,
      branch: { current: '123-feature', default: 'main' },
    });
    app.sessions.get('two')!.title = '[!1] [#12, !1] Other session';
    app.sessions.get('one')!.title = '[#12, !1] General question';
    await app.watch(['two'], 'two');
    app.emit({ type: 'session.execution.succeeded', data: { sessionID: 'one' } });
    app.emit({ type: 'session.renamed', data: { sessionID: 'two' } });
    await settle();
    expect(app.sessions.get('one')!.title).toBe('[#12, !1] General question');
    expect(app.sessions.get('two')!.title).toBe('[#12, !1] Other session');
    expect(await app.target('two')).toEqual({});
    expect(app.lastStatus('two')?.snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'No session target is set',
    });
    expect((await app.refresh('')).snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'No session is open',
    });
    expect(forge.lookups).toEqual([]);
    await app.cleanup();
  });

  test('clearing the last target clears status in a visible session', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    expect(app.lastStatus()?.snapshot.lookup).toMatchObject({ requests: [{ iid: '1' }] });

    await app.set({ target: projectA, operation: 'remove' });
    await settle();
    expect(app.lastStatus()?.snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'No session target is set',
    });
    expect(await app.target()).toEqual({});
    expect(forge.lookups).toHaveLength(1);
    await app.cleanup();
  });

  test('stops polling a session that no CLI leases', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.refresh();
    expect(forge.lookups).toHaveLength(1);
    await app.watch([]);
    await app.set({ target: projectB });
    await settle();
    // Nothing leases the session, so the target change doesn't trigger a lookup.
    expect(forge.lookups).toHaveLength(1);
    await app.cleanup();
  });

  test('reports monitoring without enrolling sessions, fetching, or emitting events', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const reader = feedbackReader();
    const storage = new Map<string, unknown>([['sessions/one', { targets: [{ url: projectA }] }]]);
    const app = await harness({
      status: forge,
      storage,
      feedback: reader.read,
      now: reader.now,
      activity: reader.now(),
    });
    await settle();
    const before = {
      lookups: forge.lookups.length,
      reads: reader.reads(),
      events: app.emitted.length,
    };
    const status = await app.monitoringStatus();
    expect(status).toMatchObject({
      enabled: true,
      directory: '/repo',
      sessionID: 'one',
      discovered: true,
      leased: false,
      polling: true,
      paused: false,
      humanFeedback: true,
      automatedFeedback: true,
      status: { loading: false, fetchedAt: reader.now() },
      targets: [
        {
          url: projectA,
          state: 'opened',
          feedbackWatched: true,
          status: { loading: false, fetchedAt: reader.now() },
          feedback: { loading: false, fetchedAt: reader.now() },
        },
      ],
    });
    const unknown = await app.monitoringStatus('unknown');
    expect(unknown).toMatchObject({
      discovered: false,
      leased: false,
      polling: false,
      targets: [],
    });
    await settle();
    expect({
      lookups: forge.lookups.length,
      reads: reader.reads(),
      events: app.emitted.length,
    }).toEqual(before);
    await app.pauseFeedback(true);
    expect(await app.monitoringStatus()).toMatchObject({
      paused: true,
      targets: [{ feedbackWatched: false, subscription: { state: 'inactive' } }],
    });
    await app.cleanup();
  });

  test('reports an incomplete feedback fetch as unusable instead of healthy', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const reader = feedbackReader();
    const storage = new Map<string, unknown>([['sessions/one', { targets: [{ url: projectA }] }]]);
    const app = await harness({
      status: forge,
      storage,
      now: reader.now,
      activity: reader.now(),
      feedback: async () => ({ complete: false, viewerID: 'me', comments: [] }),
    });
    await settle();
    const [target] = (await app.monitoringStatus()).targets;
    expect(target.feedback).toEqual({
      loading: false,
      attemptedAt: reader.now(),
      result: 'incomplete',
    });
    expect(target.status).toMatchObject({ result: 'usable', fetchedAt: reader.now() });
    await app.cleanup();
  });

  test('reports disabled monitoring without starting status lookups', async () => {
    const app = await harness();
    expect(await app.monitoringStatus()).toMatchObject({
      enabled: false,
      polling: false,
      targets: [],
      status: { loading: false },
    });
    await app.cleanup();
  });

  test('preserves Copilot and successive human feedback batches as separate inbox items', async () => {
    const forge = new StatusForge('github');
    const url = 'https://github.com/group/a/pull/1';
    const request = {
      forge: 'github',
      iid: '1',
      url,
      state: 'opened',
      copilotReview: { requested: true, comments: 0 },
    } as GitHubPullRequest;
    forge.requests.set('group/a!1', request);
    const reader = feedbackReader();
    const app = await harness({
      status: forge,
      feedback: reader.read,
      now: reader.now,
      pluginOptions: { delivery: { reviews: 'inbox' } },
    });
    await app.set({ target: url });
    await app.watch(['one'], 'one');
    await settle();
    forge.requests.set('group/a!1', {
      ...request,
      copilotReview: { requested: false, reviewID: 'copilot-1', comments: 1 },
    });
    reader.advance(SETTLE_TIME);
    await app.refresh();
    await settle();
    const automated = (await app.feedback()).items;
    expect(automated).toHaveLength(1);
    const first = { ...reader.comment('7'), url: `${url}#discussion_r7` };
    reader.set([first]);
    reader.advance(SETTLE_TIME);
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toHaveLength(2);
    const second = { ...reader.comment('8'), url: `${url}#discussion_r8` };
    reader.set([first, second]);
    reader.advance(SETTLE_TIME);
    await app.refresh();
    await settle();
    const items = (await app.feedback()).items;
    expect(items).toHaveLength(3);
    expect(items).toEqual(expect.arrayContaining(automated));
    expect(items.map((item) => item.links)).toEqual(
      expect.arrayContaining([[first.url], [second.url]]),
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    reader.advance(SETTLE_TIME);
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toEqual(items);
    expect(app.syntheticStarted()).toBe(0);
    await app.cleanup();
  });

  test('shares status and feedback fetches across sessions but keeps notification baselines separate', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const reader = feedbackReader();
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      ['sessions/two', { targets: [{ url: projectA }] }],
    ]);
    const app = await harness({
      storage,
      status: forge,
      feedback: reader.read,
      now: reader.now,
      pluginOptions: { delivery: { reviews: 'inbox' } },
    });
    await app.watch(['one', 'two'], 'one');
    await settle();
    expect(forge.lookups).toEqual(['group/a!1']);
    expect(reader.reads()).toBe(1);
    expect([...storage.keys()].filter((key) => key.startsWith('status/feedback/'))).toHaveLength(4);
    reader.advance(FETCH_INTERVAL);
    reader.set([reader.comment('7')]);
    app.emit({ type: 'session.execution.succeeded', data: { sessionID: 'one' } });
    await settle();
    expect(forge.lookups).toEqual(['group/a!1', 'group/a!1']);
    expect(reader.reads()).toBe(2);
    expect((await app.feedback()).items.map((item) => item.sessionID).sort()).toEqual([
      'one',
      'two',
    ]);
    expect(app.syntheticStarted()).toBe(0);
    forge.set('group/a', '1', { state: 'merged' });
    const refreshed = await app.refresh('one');
    expect(refreshed.snapshot.lookup).toMatchObject({ requests: [{ state: 'merged' }] });
    await app.cleanup();
  });

  test('keeps inbox-only notifications out of the agent inbox, including its next turn', async () => {
    const { app, reader } = await watchedFeedback({
      pluginOptions: { delivery: { reviews: 'inbox' } },
    });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toHaveLength(1);
    expect(app.syntheticStarted()).toBe(0);
    const context = await app.context();
    expect(context).not.toContain('New review feedback');
    reader.advance(FETCH_INTERVAL);
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toHaveLength(1);
    expect(app.syntheticStarted()).toBe(0);
    await app.cleanup();
  });

  test('ignores the removed resume option for CLI-watched sessions, and says so', async () => {
    const { app } = await watchedFeedback({
      pluginOptions: { resumeSession: true, delivery: { reviews: 'inbox' } },
    });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toHaveLength(1);
    expect(app.syntheticStarted()).toBe(0);
    expect(app.notices()).toContainEqual(
      expect.objectContaining({
        variant: 'error',
        message: expect.stringContaining("resumeSession isn't a Forgekeeper option"),
      }),
    );
    await app.cleanup();
  });

  test('pause suppresses delivery and preserves unannounced comments for resume', async () => {
    const { app, reader } = await watchedFeedback({
      pluginOptions: { delivery: { reviews: 'inbox' } },
    });
    await app.pauseFeedback(true);
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toEqual([]);
    expect(announcedIn(app.storage)).not.toContain('7');
    await app.pauseFeedback(false);
    reader.advance(FETCH_INTERVAL);
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toHaveLength(1);
    expect(app.syntheticStarted()).toBe(0);
    await app.cleanup();
  });

  test('surfaces discovered feedback without a CLI or agent execution', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const reader = feedbackReader();
    const storage = new Map<string, unknown>([['sessions/one', { targets: [{ url: projectA }] }]]);
    const app = await harness({
      storage,
      status: forge,
      feedback: reader.read,
      now: reader.now,
      activity: reader.now(),
      pluginOptions: { delivery: { reviews: 'inbox' } },
    });
    await settle();
    expect(reader.reads()).toBe(1);
    reader.advance(FETCH_INTERVAL);
    reader.set([reader.comment('7')]);
    await app.refresh();
    await settle();
    expect(app.syntheticStarted()).toBe(0);
    const state = await app.feedback();
    expect(state.items).toMatchObject([{ sessionID: 'one', links: [`${projectA}#note_7`] }]);
    await app.cleanup();
    const reloaded = await harness({ storage, status: forge, now: reader.now });
    expect((await reloaded.feedback()).items).toEqual(state.items);
    await reloaded.acknowledgeFeedback(state.items[0].id);
    expect((await reloaded.feedback()).items).toEqual([]);
    await reloaded.pauseFeedback(true);
    expect((await reloaded.feedback()).paused).toBe(true);
    await reloaded.cleanup();
  });

  test('never tells a session about feedback read after cleanup started', async () => {
    const { app, reader } = await watchedFeedback();
    reader.hold();
    await app.refresh();
    await settle();
    expect(reader.reads()).toBe(2);
    const stopping = app.cleanup();
    await settle();
    reader.release();
    // Cleanup waits for the running check instead of its 5-second limit.
    await stopping;
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    expect(announcedIn(app.storage)).toEqual([]);
  });

  test('looks up a hidden session after a restart, so its reviews stay watched', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const storage = new Map<string, unknown>([['sessions/one', { targets: [{ url: projectA }] }]]);
    let comments: ReviewComment[] = [];
    const app = await harness({
      status: forge,
      storage,
      pluginOptions: quiet,
      feedback: async () => ({ complete: true, viewerID: 'me', comments }),
    });
    // The CLI renews its lease on the hidden session; another one is on screen.
    await app.watch(['one', 'two'], 'two');
    await settle();
    expect(forge.lookups).toContain('group/a!1');
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    comments = [duoComment(projectA, '7')];
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toMatchObject([{ sessionID: 'one' }]);
    await app.cleanup();
  });

  test("leaves a session that moved to another checkout to that checkout's instance", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    app.sessions.get('one')!.location.directory = '/repo-worktree';
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    // A CLI that still leases the session here doesn't make this instance watch it.
    expect((await app.refresh()).snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'The session moved to another checkout',
    });
    await settle();
    expect(app.synthetic).toEqual([]);
    expect([...app.storage.keys()].filter((key) => key.startsWith('status/pending/'))).toEqual([]);
    await app.cleanup();
  });

  test('never tells a session that moved while its feedback was read', async () => {
    const { app, reader } = await watchedFeedback();
    reader.hold();
    await app.refresh();
    await settle();
    expect(reader.reads()).toBe(2);
    app.sessions.get('one')!.location.directory = '/repo-worktree';
    reader.release();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    // The next lookup leaves the session to its new checkout.
    expect((await app.refresh()).snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'The session moved to another checkout',
    });
    await app.cleanup();
  });

  test('never tells a session that moved while its status was looked up', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.gated = true;
    const polling = app.refresh();
    await settle();
    app.sessions.get('one')!.location.directory = '/repo-worktree';
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.open();
    await polling;
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    await app.cleanup();
  });

  test('stores the outcome of an automated notification that finishes during cleanup', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      [
        pendingRecord('one', projectA),
        { sessionID: 'one', url: projectA, since: Date.now(), retryAt: 0 },
      ],
      [
        `status/feedback/${encodeURIComponent(`duo one ${projectA}`)}`,
        { baseline: 0, announced: [], seenAt: Date.now() },
      ],
    ]);
    const app = await harness({
      status: forge,
      storage,
      pluginOptions: quiet,
      holdInbox: true,
      feedback: async () => ({
        complete: true,
        viewerID: 'me',
        comments: [duoComment(projectA, '7')],
      }),
    });
    await app.watch(['one'], 'one');
    await settle();
    expect(app.inboxStarted()).toBe(1);
    const stopping = app.cleanup();
    await settle();
    app.releaseInbox();
    await stopping;
    expect((await app.feedback()).items).toHaveLength(1);
    // The replacement instance won't send it again.
    expect(app.storage.has(pendingRecord('one', projectA))).toBe(false);
  });

  test('stores the comments of a feedback notification that finishes during cleanup', async () => {
    const { app } = await watchedFeedback({ holdInbox: true });
    await app.refresh();
    await settle();
    expect(app.inboxStarted()).toBe(1);
    const stopping = app.cleanup();
    await settle();
    app.releaseInbox();
    await stopping;
    expect((await app.feedback()).items).toHaveLength(1);
    expect(announcedIn(app.storage)).toEqual(['7']);
  });

  test('leaves a passive session message that cleanup prevented to the next instance', async () => {
    const { app, reader } = await watchedFeedback({
      holdInbox: true,
      pluginOptions: { delivery: { reviews: 'passive' } },
    });
    await app.refresh();
    await settle();
    expect(app.inboxStarted()).toBe(1);
    const stopping = app.cleanup();
    await settle();
    app.releaseInbox();
    await stopping;
    const [item] = (await app.feedback()).items;
    expect(item.notifiedAt).toBeUndefined();
    expect(app.passive).toEqual([]);
    // The inbox has it, so the review watcher doesn't announce it again.
    expect(announcedIn(app.storage)).toEqual(['7']);
    const reloaded = await harness({
      storage: app.storage,
      status: new StatusForge(),
      feedback: reader.read,
      now: reader.now,
      pluginOptions: { delivery: { reviews: 'passive' } },
    });
    await settle();
    expect(reloaded.passive).toHaveLength(1);
    expect((await reloaded.feedback()).items[0].notifiedAt).toBeDefined();
    await reloaded.cleanup();
  });

  // Runs a lookup in which the targets' automated reviews finish, and arms
  // `arm` for the ownership read that the notification starts with.
  async function finishDuringRead(
    app: Awaited<ReturnType<typeof harness>>,
    forge: StatusForge,
    arm: () => void,
  ) {
    forge.gated = true;
    const polling = app.refresh();
    await settle();
    arm();
    forge.open();
    await polling;
    await settle();
  }

  test('never tells a session about a target removed while ownership was read', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    let comments: ReviewComment[] = [];
    const app = await harness({
      status: forge,
      pluginOptions: quiet,
      feedback: async () => ({ complete: true, viewerID: 'me', comments }),
    });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    comments = [duoComment(projectA, '7')];
    let release = () => {};
    await finishDuringRead(app, forge, () => (release = app.holdNextRead()));
    await app.set({ target: projectB });
    release();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    await app.cleanup();
  });

  test('tells a session only about the targets it still has after ownership was read', async () => {
    const projectC = 'https://gitlab.com/group/c/-/merge_requests/1';
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    forge.set('group/c', '1', { duoReviewState: 'REVIEW_STARTED' });
    let ready = false;
    const app = await harness({
      status: forge,
      pluginOptions: quiet,
      feedback: async (request) => ({
        complete: true,
        viewerID: 'me',
        comments: ready ? [duoComment(request.url, '7')] : [],
      }),
    });
    await app.set({ targets: [projectA, projectC] });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.set('group/c', '1', { duoReviewState: 'REQUESTED_CHANGES' });
    ready = true;
    let release = () => {};
    await finishDuringRead(app, forge, () => (release = app.holdNextRead()));
    await app.set({ targets: [projectA], operation: 'remove' });
    release();
    await settle();
    expect((await app.feedback()).items).toMatchObject([{ url: projectC }]);
    expect((await app.feedback()).items).toHaveLength(1);
    expect(app.notices()).toHaveLength(1);
    await app.cleanup();
  });

  test("keeps Duo findings unannounced when the session can't be read", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      [
        pendingRecord('one', projectA),
        { sessionID: 'one', url: projectA, since: Date.now(), retryAt: 0 },
      ],
      [
        `status/feedback/${encodeURIComponent(`duo one ${projectA}`)}`,
        { baseline: 0, announced: [], seenAt: Date.now() },
      ],
    ]);
    const app = await harness({
      status: forge,
      storage,
      pluginOptions: quiet,
      feedback: async () => ({
        complete: true,
        viewerID: 'me',
        comments: [duoComment(projectA, '7')],
      }),
    });
    forge.gated = true;
    await app.watch(['one'], 'one');
    await settle();
    app.failNextRead(new Error('database locked'));
    forge.open();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(announcedIn(app.storage)).toEqual([]);
    expect(app.notices()).toMatchObject([{ variant: 'error' }]);
    expect(JSON.stringify(app.notices())).toContain('database locked');
    await app.cleanup();
  });

  test("doesn't count feedback as announced when the session can't be read", async () => {
    const { app, reader } = await watchedFeedback();
    reader.hold();
    await app.refresh();
    await settle();
    app.failNextRead(new Error('database locked'));
    reader.release();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(announcedIn(app.storage)).toEqual([]);
    expect(app.notices()).toMatchObject([{ sessionID: 'one', variant: 'error' }]);
    expect(JSON.stringify(app.notices())).toContain('database locked');
    await app.cleanup();
  });

  test('scans and cleans up merged PR/MR and closed issue-only sessions, pruning inbox items and emitting sessionsCleanedUp', async () => {
    const forge = new StatusForge();
    const mr1 = 'https://gitlab.com/group/a/-/merge_requests/1';
    const issue10 = 'https://gitlab.com/group/a/-/issues/10';
    forge.set('group/a', '1', { state: 'opened' });
    forge.issues.set('group/a#10', {
      forge: 'gitlab',
      open: true,
      assignees: ['pedro'],
      labels: [],
    });

    const sessions = defaultSessions();
    sessions.set('issue-session', {
      title: 'Triage issue',
      location: { directory: '/repo' },
      parentID: undefined,
    });

    const app = await harness({
      status: forge,
      sessions,
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox', lifecycle: 'inbox' } },
    });
    try {
      await app.set({ target: mr1 }, 'one');
      await app.set({ target: issue10 }, 'issue-session');
      await app.watch(['one', 'issue-session'], 'one');
      await settle();

      // Neither is eligible while open:
      expect((await app.cleanupCandidates()).candidates).toEqual([]);

      // Merge MR !1 and close issue #10:
      forge.set('group/a', '1', { state: 'merged' });
      forge.issues.set('group/a#10', {
        forge: 'gitlab',
        open: false,
        assignees: ['pedro'],
        labels: [],
      });
      const refreshedMr = await app.refresh('one');
      const refreshedIssue = await app.refresh('issue-session');
      await settle();

      // Snapshot.lookup.cleanupReady is set for both, and transition notices fired once:
      expect(refreshedMr.snapshot.lookup?.cleanupReady).toEqual({
        kind: 'merged-requests',
        reason: 'MR merged',
      });
      expect(refreshedIssue.snapshot.lookup?.cleanupReady).toEqual({
        kind: 'closed-issues',
        reason: 'Tracked issue closed',
      });
      expect(app.notices()).toContainEqual({
        sessionID: 'one',
        title: 'MR merged — ready to archive',
        message: 'Run /forge-cleanup to archive this session and close its tab.',
        variant: 'info',
        openTab: false,
      });
      expect(app.notices()).toContainEqual({
        sessionID: 'issue-session',
        title: 'Tracked issue closed — ready to archive',
        message: 'Run /forge-cleanup to archive this session and close its tab.',
        variant: 'info',
        openTab: false,
      });
      // Merge lifecycle item is in the inbox for session `one`:
      expect((await app.feedback()).items.some((item) => item.sessionID === 'one')).toBe(true);

      const scan = await app.cleanupCandidates();
      expect(scan.enabled).toBe(true);
      expect(scan.candidates.map((c) => c.sessionID).sort()).toEqual(['issue-session', 'one']);

      const cleaned = await app.cleanupSessions(['one', 'issue-session']);
      expect(cleaned).toEqual({
        archived: ['one', 'issue-session'],
        alreadyArchived: [],
        failed: [],
      });

      // Sessions are archived, inbox items for `one` are pruned, and sessionsCleanedUp emitted:
      expect(
        (sessions.get('one') as { time?: { archived?: number } })?.time?.archived,
      ).toBeDefined();
      expect((await app.feedback()).items.filter((item) => item.sessionID === 'one')).toEqual([]);
      expect(app.emitted).toContainEqual({
        name: 'sessionsCleanedUp',
        data: { sessionIDs: ['one', 'issue-session'] },
      });
    } finally {
      await app.cleanup();
    }
  });

  test('prunes inbox items when session.archived event fires', async () => {
    const forge = new StatusForge();
    const mr1 = 'https://gitlab.com/group/a/-/merge_requests/1';
    forge.set('group/a', '1', { state: 'merged' });
    const sessions = defaultSessions();
    const app = await harness({
      status: forge,
      sessions,
      storage: new Map<string, unknown>([
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [
              {
                id: 'merged-1',
                kind: 'merged',
                sessionID: 'two',
                url: mr1,
                title: '!1 merged into main',
                links: [mr1],
                at: 100,
              },
            ],
            paused: false,
          },
        ],
      ]),
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await app.set({ target: mr1 }, 'one');
      await settle();

      // Live session.archived event prunes session two's inbox items:
      expect((await app.feedback()).items).toHaveLength(1);
      app.emit({ type: 'session.archived', data: { sessionID: 'two' } });
      await settle();
      expect((await app.feedback()).items).toEqual([]);
    } finally {
      await app.cleanup();
    }

    // With status disabled, cleanupCandidates reports enabled: false and cleanupSessions rejects:
    const disabled = await harness({ pluginOptions: { status: false } });
    try {
      expect(await disabled.cleanupCandidates()).toEqual({
        enabled: false,
        candidates: [],
        skippedErrors: 0,
      });
      await expect(disabled.cleanupSessions(['one'])).rejects.toThrow('PR/MR status is disabled');
      await expect(disabled.summarizeFeedback('missing')).rejects.toThrow(
        'PR/MR status is disabled',
      );
      await expect(disabled.actOnFeedback('missing')).rejects.toThrow('PR/MR status is disabled');
    } finally {
      await disabled.cleanup();
    }

    // Invalidated in-flight lookup (e.g. target detached mid-refresh) does not emit a stale cleanupWatch notice:
    const raceForge = new StatusForge();
    raceForge.set('group/a', '1', { state: 'opened' });
    const raceApp = await harness({ status: raceForge });
    try {
      await raceApp.set({ target: mr1 }, 'one');
      await raceApp.watch(['one'], 'one');
      await settle();

      raceForge.set('group/a', '1', { state: 'merged' });
      raceForge.gated = true;
      const pendingRefresh = raceApp.refresh('one');
      await settle();
      await raceApp.set({ target: 'none' }, 'one');
      raceForge.open();
      await pendingRefresh;
      await settle();

      expect(
        raceApp
          .notices()
          .some((notice) =>
            ((notice as { title?: string }).title ?? '').includes('ready to archive'),
          ),
      ).toBe(false);
    } finally {
      await raceApp.cleanup();
    }

    // When ctx.session.update ignores `archived`, allowClientArchive + finalizeArchived completes cleanup:
    const fallbackForge = new StatusForge();
    fallbackForge.set('group/a', '1', { state: 'merged' });
    const fallbackSessions = defaultSessions();
    const fallbackApp = await harness({
      status: fallbackForge,
      sessions: fallbackSessions,
      ignoreServerArchive: true,
      storage: new Map<string, unknown>([
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [
              {
                id: 'merged-1',
                kind: 'merged',
                sessionID: 'one',
                url: mr1,
                title: '!1 merged into main',
                links: [mr1],
                at: 100,
              },
            ],
            paused: false,
          },
        ],
      ]),
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await fallbackApp.set({ target: mr1 }, 'one');
      await settle();

      const firstPass = await fallbackApp.cleanupSessions(['one'], { allowClientArchive: true });
      expect(firstPass).toEqual({
        archived: [],
        alreadyArchived: [],
        failed: [],
        needsClientArchive: ['one'],
      });
      // Simulate client archiving via HTTP API:
      const sessionOne = fallbackSessions.get('one') as { time?: { archived?: number } };
      sessionOne.time = { ...sessionOne.time, archived: 500 };

      const finalized = await fallbackApp.cleanupSessions(['one'], { finalizeArchived: true });
      expect(finalized).toEqual({
        archived: ['one'],
        alreadyArchived: [],
        failed: [],
      });
      expect((await fallbackApp.feedback()).items).toEqual([]);
      expect(fallbackApp.emitted).toContainEqual({
        name: 'sessionsCleanedUp',
        data: { sessionIDs: ['one'] },
      });
    } finally {
      await fallbackApp.cleanup();
    }
  });
});
