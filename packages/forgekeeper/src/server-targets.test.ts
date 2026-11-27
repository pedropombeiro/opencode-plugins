import { describe, expect, test } from 'bun:test';
import type { ReviewComment, ReviewRequest } from './forge';
import { FETCH_INTERVAL, SETTLE_TIME } from './human-review-watch';
import {
  defaultSessions,
  duoComment,
  harness,
  issue,
  mr,
  nextMr,
  projectA,
  projectB,
  ProviderMessage,
  quiet,
  settle,
  StatusForge,
  textOf,
  type Transcript,
} from './server-harness';

describe('session targets', () => {
  test('registers set_session_target as a direct tool', async () => {
    const app = await harness();
    expect(app.toolOptions()).toEqual({ codemode: false });
    await app.cleanup();
  });

  test("leaves a compaction alone unless it summarizes a linked session's task", async () => {
    const app = await harness();
    const messages = [
      new ProviderMessage({ role: 'user', content: [{ type: 'text', text: 'earlier work' }] }),
    ];
    const event = await app.compact('one', messages);
    expect(event.messages).toEqual(messages);
    await app.cleanup();
  });

  test('writes the instruction entry when the first prompt is admitted', async () => {
    const app = await harness();
    await app.admit();
    expect(app.entries()['forgekeeper-session-target']).toBe('Current session target: none.');
    expect(app.entryWrites).toEqual(['put forgekeeper-session-target']);
    const first = await app.system();
    expect(first).toContain('call set_session_target');
    expect(first).not.toContain('Current session target');
    expect(await app.system()).toBe(first);
    await app.admit();
    expect(app.entryWrites).toEqual(['put forgekeeper-session-target']);
    await app.cleanup();
  });

  test('skips the prompt-time entry for child sessions and other directories', async () => {
    const sessions = defaultSessions();
    sessions.set('child', {
      title: 'Child',
      location: { directory: '/repo' },
      parentID: 'one',
    });
    sessions.set('elsewhere', {
      title: 'Elsewhere',
      location: { directory: '/other' },
      parentID: undefined,
    });
    const app = await harness({ sessions });
    await app.admit('child');
    await app.admit('elsewhere');
    expect(app.entryWrites).toEqual([]);
    await app.cleanup();
  });

  test('admits the prompt when the session read fails', async () => {
    const app = await harness();
    app.failNextRead(new Error('unavailable'));
    await app.admit();
    expect(app.entryWrites).toEqual([]);
    await app.cleanup();
  });

  test('writes a missing entry from the context hook without adding system text', async () => {
    const app = await harness();
    const first = await app.system();
    expect(app.entries()['forgekeeper-session-target']).toBe('Current session target: none.');
    expect(first).not.toContain('Current session target');
    expect(await app.system()).toBe(first);
    expect(app.entryWrites).toEqual(['put forgekeeper-session-target']);
    await app.cleanup();
  });

  test('updates the instruction entry without changing the steady-state system prompt', async () => {
    const app = await harness();
    await app.admit();
    const stable = await app.system();
    expect(stable).not.toContain('Current session target');
    await app.set({ target: mr });
    expect(app.entries()['forgekeeper-session-target']).toContain(mr);
    expect(await app.system()).toBe(stable);
    await app.set({ target: mr });
    expect(app.entryWrites).toEqual([
      'put forgekeeper-session-target',
      'put forgekeeper-session-target',
    ]);
    await app.set({ target: 'none' });
    expect(app.entries()['forgekeeper-session-target']).toBe('Current session target: none.');
    expect(await app.system()).toBe(stable);
    await app.cleanup();
  });

  test('registers guidance and prefixes the title when a target is set', async () => {
    const app = await harness();
    expect(await app.context()).toContain('call set_session_target');
    await app.set({ target: mr });
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.context()).toContain(mr);
    expect(await app.context('two')).not.toContain(mr);
    expect(app.sessions.get('two')?.title).toBe('Other session');
    await app.cleanup();
  });

  test('persists the target and owned prefix across plugin reloads', async () => {
    const storage = new Map<string, unknown>();
    const first = await harness({ storage });
    await first.set({ target: mr, issue_url: issue });
    const title = first.sessions.get('one')!.title;
    await first.cleanup();

    const second = await harness({ storage });
    second.sessions.get('one')!.title = title;
    expect(await second.context()).toContain(mr);
    await second.set({ target: nextMr });
    expect(second.sessions.get('one')?.title).toBe('[!789] Review changes');
    await second.set({ target: nextMr });
    expect(second.renames()).toBe(1);
    await second.cleanup();
  });

  describe('forked sessions', () => {
    // Forks of 'one' that copied its title, like OpenCode does.
    const forked = () => {
      const sessions = defaultSessions();
      sessions.set('fork', {
        title: '[!456] Review changes (fork #1)',
        location: { directory: '/repo' },
        parentID: undefined,
        fork: { sessionID: 'one' },
      });
      sessions.set('nested', {
        title: '[!456] Review changes (fork #1) (fork #1)',
        location: { directory: '/repo' },
        parentID: undefined,
        fork: { sessionID: 'fork' },
      });
      return sessions;
    };

    test('inherits the source session targets and owned prefix', async () => {
      const app = await harness({ sessions: forked() });
      await app.set({ target: mr });
      expect(await app.context('fork')).toContain(mr);
      expect(await app.target('fork')).toEqual(await app.target());
      app.emit({ type: 'session.renamed', data: { sessionID: 'fork' } });
      await settle();
      expect(app.sessions.get('fork')?.title).toBe('[!456] Review changes (fork #1)');
      expect(app.storage.get('sessions/fork')).toEqual(app.storage.get('sessions/one'));
      await app.cleanup();
    });

    test('inherits through a fork of a fork', async () => {
      const app = await harness({ sessions: forked() });
      await app.set({ target: mr });
      expect(await app.context('nested')).toContain(mr);
      await app.cleanup();
    });

    test('keeps its own targets once it has set them', async () => {
      const app = await harness({ sessions: forked() });
      await app.set({ target: mr });
      await app.set({ target: nextMr }, 'fork');
      expect(app.sessions.get('fork')?.title).toBe('[!789] Review changes (fork #1)');
      expect(await app.context('fork')).toContain(nextMr);
      expect(await app.context('fork')).not.toContain(mr);
      expect(await app.context()).toContain(mr);
      await app.cleanup();
    });

    test('keeps the inherited targets when the source changes later', async () => {
      const app = await harness({ sessions: forked() });
      await app.set({ target: mr });
      app.emit({ type: 'session.renamed', data: { sessionID: 'fork' } });
      await settle();
      await app.set({ target: nextMr });
      expect(await app.context('fork')).toContain(mr);
      expect(await app.context('fork')).not.toContain(nextMr);
      await app.cleanup();
    });

    test('leaves unrelated sessions without targets', async () => {
      const app = await harness({ sessions: forked() });
      await app.set({ target: mr });
      expect(await app.context('two')).toContain('Current session target: none.');
      await app.cleanup();
    });
  });

  test('clearing targets removes the prefix and updates the context', async () => {
    const app = await harness();
    await app.set({ target: mr });
    await app.set({ target: 'none' });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    expect(await app.context()).toContain('Current session target: none.');
    await app.cleanup();
  });

  test('preserves user-written references when retargeting after detach and reload', async () => {
    const app = await harness();
    await app.set({ target: mr });
    const title = '[#12, !45] General question';
    app.sessions.get('one')!.title = `[!456] ${title}`;
    await app.runCommand('forge-detach');
    expect(app.sessions.get('one')?.title).toBe(title);
    await app.cleanup();

    const reloaded = await harness({ storage: app.storage, sessions: app.sessions });
    await reloaded.set({ target: nextMr });
    expect(reloaded.sessions.get('one')?.title).toBe(`[!789] ${title}`);
    await reloaded.cleanup();
  });

  test.each(['session.created', 'session.renamed'])(
    'preserves references when setting the first target after %s',
    async (type) => {
      const app = await harness();
      const title = '[#12, !45] Review changes';
      app.sessions.get('one')!.title = title;
      app.emit({ type, data: { sessionID: 'one' } });
      await settle();
      expect(app.sessions.get('one')?.title).toBe(title);
      expect(await app.target()).toEqual({});
      await app.cleanup();

      const reloaded = await harness({ storage: app.storage, sessions: app.sessions });
      await reloaded.set({ target: mr });
      expect(reloaded.sessions.get('one')?.title).toBe(`[!456] ${title}`);
      await reloaded.cleanup();
    },
  );

  test('replaces a legacy prefix when setting the first target without stored state', async () => {
    const app = await harness();
    app.sessions.get('one')!.title = '[#12, !45] Review changes';
    await app.set({ target: mr });
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    await app.cleanup();
  });

  test('clearing a target leaves a long manual rename intact', async () => {
    const app = await harness();
    await app.set({ target: mr });
    const title = `General question ${'with more detail '.repeat(8).trimEnd()}`;
    app.sessions.get('one')!.title = title;
    await app.set({ target: 'none' });
    expect(app.sessions.get('one')?.title).toBe(title);
    await app.cleanup();
  });

  test('serializes concurrent switches and drops the previous related issue', async () => {
    const app = await harness();
    await Promise.all([app.set({ target: mr, issue_url: issue }), app.set({ target: nextMr })]);
    expect(app.sessions.get('one')?.title).toBe('[!789] Review changes');
    await app.cleanup();
  });

  test('rejects invalid targets without changing the current target', async () => {
    const app = await harness();
    await app.set({ target: mr });
    await expect(app.set({ target: '!789' })).rejects.toThrow();
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.context()).toContain(mr);
    await app.cleanup();
  });

  test('targets a newly created MR with its issue', async () => {
    const app = await harness();
    expect(await app.context()).toContain('After you create a PR or MR for the current task');
    await app.set({ target: 'https://gitlab.com/group/project/-/issues/123' });
    expect(app.sessions.get('one')?.title).toBe('[#123] Review changes');
    await app.set({ target: mr, issue_url: 'https://gitlab.com/group/project/-/issues/123' });
    expect(app.sessions.get('one')?.title).toBe('[#123, !456] Review changes');
    await app.cleanup();
  });

  test('guides the agent to target existing work it reviews', async () => {
    const app = await harness();
    expect(await app.context()).toContain(
      'Reviewing, triaging, or addressing feedback on existing issues, PRs, or MRs makes them the primary targets.',
    );
    await app.cleanup();
  });

  test('infers the related issue from the MR source branch', async () => {
    const app = await harness({ sourceBranches: new Map([['456', '321-fix-timeout']]) });
    await app.set({ target: mr });
    expect(app.sourceLookups).toEqual([
      { forge: 'gitlab', host: 'gitlab.com', project: 'group/project', iid: '456' },
    ]);
    expect(app.sessions.get('one')?.title).toBe('[#321, !456] Review changes');
    expect(await app.context()).toContain('"branchIssue":"321"');
    await app.set({ target: nextMr });
    expect(app.sessions.get('one')?.title).toBe('[!789] Review changes');
    await app.cleanup();
  });

  test('prefers an explicit issue and skips lookups for issue targets', async () => {
    const app = await harness({ sourceBranches: new Map([['456', '321-fix-timeout']]) });
    await app.set({ target: mr, issue_url: 'https://gitlab.com/group/other/-/issues/42' });
    expect(app.sessions.get('one')?.title).toBe('[#42, !456] Review changes');
    await app.set({ target: 'https://gitlab.com/group/project/-/issues/7' });
    expect(app.sessions.get('one')?.title).toBe('[#7] Review changes');
    expect(app.sourceLookups).toEqual([]);
    await app.cleanup();
  });

  test('exposes the target over RPC and announces changes', async () => {
    const storage = new Map<string, unknown>();
    const app = await harness({ storage });
    expect(await app.target()).toEqual({});
    await app.set({ target: mr, issue_url: issue });
    expect(await app.target()).toEqual({
      url: mr,
      issueUrl: issue,
      targets: [{ url: mr, issueUrl: issue }],
    });
    expect(await app.target('two')).toEqual({});
    await app.set({ target: 'none' });
    expect(await app.target()).toEqual({});
    expect(app.emitted).toEqual([
      {
        name: 'targetChanged',
        data: {
          sessionID: 'one',
          url: mr,
          issueUrl: issue,
          targets: [{ url: mr, issueUrl: issue }],
        },
      },
      { name: 'targetChanged', data: { sessionID: 'one' } },
    ]);
    await app.cleanup();
    expect(app.disposed).toEqual(['command', 'tool', 'rpc']);

    const reloaded = await harness({ storage });
    await reloaded.set({ target: nextMr });
    expect(await reloaded.target()).toEqual({ url: nextMr, targets: [{ url: nextMr }] });
    await reloaded.cleanup();
  });

  test('keeps the inferred issue of a stored target when adding another', async () => {
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: mr, branchIssue: '123' }], prefix: '[#123, !45]' }],
    ]);
    const app = await harness({ storage, sourceBranches: new Map([['456', '999-other']]) });
    expect(await app.target()).toEqual({ url: mr, targets: [{ url: mr }] });
    await app.set({ target: nextMr, operation: 'add' });
    // The stored target keeps its inferred issue, so only the new one is looked up.
    expect(app.sourceLookups.map((ref) => ref.iid)).toEqual(['789']);
    expect(storage.get('sessions/one')).toEqual({
      targets: [{ url: mr, branchIssue: '123' }, { url: nextMr }],
      prefix: '[!456, !789]',
    });
    expect(app.sessions.get('one')?.title).toBe('[!456, !789] Review changes');
    await app.cleanup();
  });

  test('sets, adds, and removes several targets', async () => {
    const app = await harness({
      sourceBranches: new Map([
        ['456', '321-fix-timeout'],
        ['101', '5-other'],
      ]),
    });
    const third = 'https://gitlab.com/group/other/-/merge_requests/101';
    expect(await app.set({ targets: [mr, nextMr] })).toEqual({
      content: `Session targets (2):\n- ${mr}\n- ${nextMr}`,
    });
    expect(app.sessions.get('one')?.title).toBe('[!456, !789] Review changes');
    expect(await app.context()).toContain(
      `Current session target: 2 targets: [{"url":"${mr}","branchIssue":"321"},{"url":"${nextMr}"}]`,
    );

    await app.set({ target: third, operation: 'add' });
    expect(app.sessions.get('one')?.title).toBe('[!456, !789, !101] Review changes');
    expect(await app.target()).toEqual({
      url: mr,
      targets: [{ url: mr }, { url: nextMr }, { url: third }],
    });
    expect(app.emitted.at(-1)?.data).toMatchObject({
      sessionID: 'one',
      targets: [{ url: mr }, { url: nextMr }, { url: third }],
    });

    expect(await app.set({ targets: [nextMr, issue], operation: 'remove' })).toEqual({
      content: `Session targets (2):\n- ${mr}\n- ${third}\nNot session targets, so not removed: ${issue}`,
    });
    expect(app.sessions.get('one')?.title).toBe('[!456, !101] Review changes');

    // The remaining target shows its inferred issue again, without another lookup.
    await app.set({ target: third, operation: 'remove' });
    expect(app.sessions.get('one')?.title).toBe('[#321, !456] Review changes');
    expect(app.sourceLookups.map((ref) => ref.iid)).toEqual(['456', '789', '101']);

    expect(await app.set({ target: mr, operation: 'remove' })).toEqual({
      content: 'Session target: none.',
    });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    expect(await app.context()).toContain('Current session target: none.');
    await app.cleanup();
  });

  test('tells the agent to set every target of a task, even ones it has to find', async () => {
    const app = await harness();
    const guidance = await app.context();
    expect(guidance).toContain('with all of their full URLs in targets');
    expect(guidance).toContain(
      'If the user describes them instead of linking them, find them first',
    );
    expect(guidance).toContain('use operation "add" so they are kept');
    expect(guidance).not.toMatch(/weekly|distill/i);
    await app.cleanup();
  });

  test('relates a batch of MRs to one issue and shows it first in the title', async () => {
    const app = await harness();
    await app.set({ targets: [mr, nextMr], issue_url: issue });
    expect(app.storage.get('sessions/one')).toMatchObject({
      targets: [
        { url: mr, issueUrl: issue },
        { url: nextMr, issueUrl: issue },
      ],
    });
    expect(app.sessions.get('one')?.title).toBe('[#42, !456, !789] Review changes');
    await app.cleanup();
  });

  test('rejects invalid batches without changing the targets', async () => {
    const app = await harness();
    await app.set({ targets: [mr, nextMr] });
    await expect(app.set({ targets: [mr, 'branch'] })).rejects.toThrow();
    await expect(app.set({ targets: [mr, issue], issue_url: issue })).rejects.toThrow();
    expect(app.sessions.get('one')?.title).toBe('[!456, !789] Review changes');
    await app.cleanup();
  });

  test('skips child sessions and sessions in another location', async () => {
    const app = await harness();
    app.sessions.get('one')!.parentID = 'parent';
    expect(await app.context()).toBe('');
    await expect(app.set({ target: mr })).rejects.toThrow('root session');
    app.sessions.get('two')!.location.directory = '/another/location';
    expect(await app.context('two')).toBe('');
    await expect(app.set({ target: mr }, 'two')).rejects.toThrow('root session');
    await app.cleanup();
  });

  test('keeps targets and titles but serves no status with status off', async () => {
    const forge = new StatusForge();
    const app = await harness({ status: forge, pluginOptions: { status: false } });
    await app.set({ target: mr });
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.watch(['one'], 'one')).toEqual({ enabled: false, statuses: {} });
    expect((await app.refresh()).enabled).toBe(false);
    expect(forge.lookups).toEqual([]);
    await app.cleanup();
  });

  test('still runs Forgekeeper steps queued earlier without tools or history when status is off', async () => {
    const tagged = new ProviderMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Update\n\n[forgekeeper:msg_forgekeeper_summary_abc]' }],
    });
    const earlier = new ProviderMessage({
      role: 'user',
      content: [{ type: 'text', text: 'work' }],
    });
    // A summary queued before monitoring was turned off, and its record.
    const storage = new Map<string, unknown>([
      ['status/summaries/one/msg_forgekeeper_summary_abc', { findings: 'secret review text' }],
    ]);
    const transcripts = new Map<string, Transcript>([
      ['one', [{ type: 'synthetic', id: 'msg_forgekeeper_summary_abc' }]],
    ]);
    const app = await harness({
      storage,
      transcripts,
      status: new StatusForge(),
      pluginOptions: { status: false },
    });
    for (const messages of [
      [earlier, tagged],
      // Without the tag, such as after a compaction, the stored record and
      // the context still show the step.
      [earlier],
    ]) {
      const request = await app.request('one', false, messages);
      expect(request.tools).toEqual({});
      expect(request.options.maxTokens).toBe(1_200);
      expect(request.messages).toHaveLength(1);
      expect(textOf(request)).toContain('The review text is unavailable');
      expect(textOf(request)).not.toContain('secret review text');
      expect(await app.toolCall()).toContain('Tools are disabled');
      expect(await app.permission()).toBe('deny');
    }
    // A user prompt ends the step, and later requests run as usual.
    app.prompt();
    const ordinary = await app.request('one', false, [earlier]);
    expect(Object.keys(ordinary.tools)).toEqual(['read', 'bash']);
    expect(await app.toolCall()).toBeUndefined();
    expect(await app.permission()).toBe('allow');
    // Sessions without Forgekeeper steps aren't restricted.
    expect(Object.keys((await app.request('two', false, [earlier])).tools)).toEqual([
      'read',
      'bash',
    ]);
    await app.cleanup();
  });

  test("never blocks the model request when the session can't be read", async () => {
    const app = await harness({ failingSession: true });
    expect(await app.context()).toBe('');
    await app.cleanup();
  });
});

describe('state shared across instances and reloads', () => {
  // Two sessions in two checkouts, whose instances share storage.
  function sharedSessions() {
    const sessions = defaultSessions();
    sessions.set('three', {
      title: 'Elsewhere',
      location: { directory: '/other' },
      parentID: undefined,
    });
    return sessions;
  }

  test("keeps every instance's Duo feedback baseline in shared storage after delivery fails", async () => {
    const storage = new Map<string, unknown>();
    const sessions = sharedSessions();
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    forge.set('group/b', '1', { duoReviewState: 'REVIEW_STARTED' });
    let ready = false;
    const options = {
      status: forge,
      storage,
      sessions,
      pluginOptions: quiet,
      failingInbox: 1,
      feedback: async (request: ReviewRequest) => ({
        complete: true,
        viewerID: 'me',
        comments: ready ? [duoComment(request.url, '7')] : [],
      }),
    };
    const here = await harness(options);
    const there = await harness({ ...options, directory: '/other' });
    await here.set({ target: projectA });
    await there.set({ target: projectB }, 'three');
    await here.watch(['one'], 'one');
    await there.watch(['three'], 'three');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.set('group/b', '1', { duoReviewState: 'REVIEWED' });
    ready = true;
    await here.refresh('one');
    await there.refresh('three');
    await settle();
    expect(
      storage.get(`status/feedback/${encodeURIComponent(`duo one ${projectA}`)}`),
    ).toMatchObject({ baseline: 0, announced: [] });
    expect(
      storage.get(`status/feedback/${encodeURIComponent(`duo three ${projectB}`)}`),
    ).toMatchObject({ baseline: 0, announced: [] });
    await here.cleanup();
    await there.cleanup();
  });

  test("never lets an old instance's title update overwrite a target set after a reload", async () => {
    const storage = new Map<string, unknown>([['sessions/one', { prefix: '[!45]' }]]);
    const sessions = defaultSessions();
    sessions.get('one')!.title = '[!45] Review changes';
    const old = await harness({ storage, sessions });
    const release = old.holdNextGet('sessions/one');
    old.emit({ type: 'session.execution.succeeded', data: { sessionID: 'one' } });
    await settle();
    const stopping = old.cleanup();

    const replacement = await harness({ storage, sessions });
    await replacement.set({ target: mr });
    release();
    await stopping;
    await settle();
    expect(storage.get('sessions/one')).toMatchObject({ targets: [{ url: mr }] });
    expect(sessions.get('one')?.title).toBe('[!456] Review changes');
    await replacement.cleanup();
  });

  test('never restores old targets from a read that overlapped a target change', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.set('group/b', '1');
    const reader = {
      clock: 100 * SETTLE_TIME,
      gate: undefined as Promise<void> | undefined,
      comments: [] as ReviewComment[],
    };
    let open = () => {};
    const app = await harness({
      status: forge,
      now: () => reader.clock,
      feedback: async () => {
        await reader.gate;
        return { complete: true, viewerID: 'me', comments: reader.comments };
      },
    });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    // A settled human comment on A, whose fetch is still running.
    reader.clock += FETCH_INTERVAL;
    reader.comments = [
      {
        id: '7',
        order: 7,
        url: `${projectA}#note_7`,
        editedAt: reader.clock - SETTLE_TIME,
        resolved: false,
        bot: false,
        authorID: 'someone',
        username: 'alice',
      } as ReviewComment,
    ];
    reader.gate = new Promise<void>((resolve) => (open = resolve));
    await app.refresh();
    await settle();

    // A slow read of the targets returns A after the change to B.
    const release = app.holdNextGet('sessions/one');
    const reading = app.target();
    await settle();
    await app.set({ target: projectB });
    release();
    expect(await reading).toMatchObject({ url: projectA });
    open();
    await settle();
    expect(app.synthetic).toEqual([]);
    await app.cleanup();
  });

  test('never resumes a session for the automated review of a merged MR', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED', state: 'merged' });
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);
    await app.cleanup();
  });
});
