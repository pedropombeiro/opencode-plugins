import { describe, expect, test } from 'bun:test';
import {
  createFeedbackInbox,
  feedbackFooter,
  feedbackLinks,
  feedbackTime,
  formatTime,
  linkOptions,
  type InboxState,
  type FeedbackItem,
} from './feedback-inbox';

const recordAndDeliver = async (
  inbox: ReturnType<typeof createFeedbackInbox>,
  ...args: Parameters<typeof inbox.record>
) => (await inbox.record(...args)).delivery;

describe('feedback inbox', () => {
  test("a session's footer counts only its own updates", () => {
    const item = (id: string, sessionID: string): FeedbackItem => ({
      id,
      sessionID,
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'Review',
      links: [],
      at: 1,
    });
    const state: InboxState = {
      items: [item('a', 'one'), item('b', 'one'), item('c', 'two')],
      paused: false,
    };
    expect(feedbackFooter(state, 'one')).toBe('2 review updates');
    expect(feedbackFooter(state, 'two')).toBe('1 review update');
    expect(feedbackFooter(state, 'other')).toBeUndefined();
    // A new session has no ID until its first message.
    expect(feedbackFooter(state, undefined)).toBeUndefined();
    const paused = { ...state, paused: true };
    expect(feedbackFooter(paused, 'one')).toBe('2 review updates (paused)');
    expect(feedbackFooter(paused, 'other')).toBeUndefined();
  });

  test('selects automation only after persistence and suppresses summary delivery', async () => {
    let stored: InboxState | undefined;
    const steps: string[] = [];
    const inbox = createFeedbackInbox({
      read: async () => stored,
      write: async (state) => {
        stored = state;
        steps.push('stored');
      },
      changed: () => {},
      select: async (item) => {
        expect(stored?.items.some((entry) => entry.id === item.id)).toBe(true);
        steps.push('automation');
        return true;
      },
      notify: async () => {
        steps.push('summary');
      },
    });
    await recordAndDeliver(inbox, {
      id: 'one',
      sessionID: 's',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'Feedback',
      links: [],
      at: 1,
      delivery: 'summary',
    });
    expect(steps).toEqual(['stored', 'automation']);
  });

  test('selects automation with inbox-only delivery and does not select while paused', async () => {
    let stored: InboxState | undefined;
    let selections = 0;
    const inbox = createFeedbackInbox({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      changed: () => {},
      select: async () => {
        selections++;
        return true;
      },
    });
    await recordAndDeliver(inbox, {
      id: 'one',
      sessionID: 's',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'Feedback',
      links: [],
      at: 1,
    });
    expect(selections).toBe(1);
    await inbox.pause(true);
    await inbox.notifyPending();
    expect(selections).toBe(1);
  });

  test('offers comment links before the PR/MR, labeled by their anchor', () => {
    const url = 'https://gitlab.com/g/p/-/merge_requests/1';
    const options = linkOptions({
      url,
      links: [`${url}#note_7`, `${url}#note_8`, url, 'https://evil.example/#note_9'],
    });
    expect(options.map((option) => option.value)).toEqual([`${url}#note_7`, `${url}#note_8`, url]);
    expect(options[0].title).toBe('Comment 1 of 2 (#note_7)');
    expect(options.at(-1)?.title).toBe('PR/MR overview');
    expect(linkOptions({ url, links: [`${url}#note_7`] })[0].title).toBe('Comment (#note_7)');
    // An update stored without comment links offers only the PR/MR.
    expect(linkOptions({ url, links: [url] })).toEqual([
      { title: 'PR/MR overview', description: url, value: url },
    ]);
    // The PR/MR's own link passes the same filter as comment links.
    const insecure = 'http://gitlab.com/g/p/-/merge_requests/1';
    expect(linkOptions({ url: insecure, links: [`${insecure}#note_7`] })).toEqual([]);
    expect(linkOptions({ url: 'javascript:alert(1)', links: [] })).toEqual([]);
    const credentials = 'https://user:pass@gitlab.com/g/p/-/merge_requests/1';
    expect(linkOptions({ url: credentials, links: [] })).toEqual([]);
  });
  test('labels the links of a failed-job update as jobs', () => {
    const url = 'https://gitlab.com/g/p/-/merge_requests/1';
    expect(
      linkOptions({ url, kind: 'ci-failed', links: ['https://gitlab.com/g/p/-/jobs/9', url] }).map(
        (option) => option.title,
      ),
    ).toEqual(['Failed job (jobs/9)', 'PR/MR overview']);
  });

  test("labels an update with its newest comment's time, or its detection time without comments", () => {
    const at = Date.UTC(2026, 9, 28, 14, 31);
    const postedAt = Date.UTC(2026, 9, 28, 14, 25);
    expect(feedbackTime({ at, postedAt })).toBe(`Latest comment: ${formatTime(postedAt)}`);
    expect(feedbackTime({ at })).toBe(`Detected: ${formatTime(at)}`);
    expect(formatTime(postedAt)).toContain('2026');
  });
  test('retries passive notifications after restart without replacing their stable identity', async () => {
    let state: InboxState | undefined;
    let fail = true;
    const sent: string[] = [];
    const options = {
      read: async () => structuredClone(state),
      write: async (value: InboxState) => {
        state = structuredClone(value);
      },
      changed: () => {},
      now: () => 10,
      notify: async (item: FeedbackItem) => {
        sent.push(item.id);
        if (fail) throw new Error('session unavailable');
      },
    };
    const item: FeedbackItem = {
      id: 'a',
      sessionID: 'one',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'New feedback',
      links: [],
      delivery: 'passive',
      at: 1,
    };
    const inbox = createFeedbackInbox(options);
    await expect(recordAndDeliver(inbox, item)).rejects.toThrow('session unavailable');
    expect((await inbox.list()).items).toEqual([item]);
    await inbox.pause(true);
    await createFeedbackInbox(options).notifyPending();
    expect(sent).toEqual(['a']);
    fail = false;
    await inbox.pause(false);
    await createFeedbackInbox(options).notifyPending();
    expect(sent).toEqual(['a', 'a']);
    await recordAndDeliver(inbox, item);
    expect(sent).toEqual(['a', 'a']);
    expect((await inbox.list()).items).toMatchObject([{ id: 'a', notifiedAt: 10 }]);
  });

  test('delivers each pending update on its own and never an update recorded in inbox mode', async () => {
    let state: InboxState | undefined;
    const sent: string[] = [];
    const update = (id: string, delivery?: 'passive' | 'summary'): FeedbackItem => ({
      id,
      sessionID: id,
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'New feedback',
      links: [],
      ...(delivery ? { delivery } : {}),
      at: 1,
    });
    state = {
      paused: false,
      items: [update('broken', 'summary'), update('ok', 'summary'), update('old')],
    };
    const inbox = createFeedbackInbox({
      read: async () => structuredClone(state),
      write: async (value) => void (state = structuredClone(value)),
      changed: () => {},
      notify: async (item) => {
        sent.push(item.id);
        if (item.id === 'broken') throw new Error('deleted session');
      },
    });
    await expect(inbox.notifyPending()).rejects.toThrow('deleted session');
    await expect(inbox.notifyPending()).rejects.toThrow('deleted session');
    // The failing update doesn't hold the next one back, and the update
    // recorded in inbox mode starts nothing after switching modes.
    expect(sent).toEqual(['broken', 'ok', 'broken']);
    expect(state?.items.find((item) => item.id === 'ok')?.notifiedAt).toBeDefined();
  });
  test('leaves updates whose delivery is off undelivered, so they go once it is on again', async () => {
    let state: InboxState | undefined;
    let enabled = false;
    const delivered: string[] = [];
    const inbox = createFeedbackInbox({
      read: async () => state && structuredClone(state),
      write: async (next) => void (state = structuredClone(next)),
      changed: () => {},
      notify: async (item) => void delivered.push(item.id),
      enabled: () => enabled,
    });
    const item: FeedbackItem = {
      id: 'a',
      sessionID: 'one',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'Update',
      links: [],
      delivery: 'summary',
      at: 0,
    };
    await recordAndDeliver(inbox, item);
    expect(delivered).toEqual([]);
    expect((await inbox.list()).items[0].notifiedAt).toBeUndefined();
    enabled = true;
    await inbox.notifyPending();
    expect(delivered).toEqual(['a']);
  });

  test('stays usable while a delivery runs, and delivers an update once at a time', async () => {
    let state: InboxState | undefined;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const inbox = createFeedbackInbox({
      read: async () => state && structuredClone(state),
      write: async (next) => void (state = structuredClone(next)),
      changed: () => {},
      now: () => 7,
      notify: async (item) => {
        sent.push(item.id);
        await gate;
      },
    });
    const update = (id: string): FeedbackItem => ({
      id,
      sessionID: 'one',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: id,
      links: [],
      delivery: 'summary',
      at: 0,
    });
    const adding = recordAndDeliver(inbox, update('slow'));
    await Bun.sleep(0);
    expect(sent).toEqual(['slow']);
    // Reads and changes don't wait for the delivery.
    expect((await inbox.list()).items.map((item) => item.id)).toEqual(['slow']);
    await recordAndDeliver(inbox, { ...update('other'), delivery: undefined });
    const retries = Promise.all([inbox.notifyPending(), inbox.notifyPending()]);
    await Bun.sleep(0);
    expect(sent).toEqual(['slow']);
    release();
    await Promise.all([adding, retries]);
    expect(sent).toEqual(['slow']);
    expect(state?.items.find((item) => item.id === 'slow')?.notifiedAt).toBe(7);
  });

  test('records an update even when its delivery fails, and retries only what is still pending', async () => {
    let state: InboxState | undefined;
    let fail = true;
    const sent: string[] = [];
    const inbox = createFeedbackInbox({
      read: async () => state && structuredClone(state),
      write: async (next) => void (state = structuredClone(next)),
      changed: () => {},
      notify: async (item) => {
        if (fail) throw new Error('unavailable');
        sent.push(item.id);
      },
    });
    const update = (id: string): FeedbackItem => ({
      id,
      sessionID: 'one',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: id,
      links: [],
      delivery: 'summary',
      at: 0,
    });
    for (const id of ['kept', 'dismissed']) {
      const { delivery } = await inbox.record(update(id));
      await expect(delivery).rejects.toThrow('unavailable');
    }
    expect(state?.items.map((item) => item.id)).toEqual(['dismissed', 'kept']);
    await inbox.acknowledge('dismissed');
    fail = false;
    await inbox.notifyPending();
    expect(sent).toEqual(['kept']);
    // Recording waits for no delivery, but nothing records while paused.
    await inbox.pause(true);
    await expect(inbox.record(update('late'))).rejects.toThrow('paused');
  });

  test('skips an update acknowledged or paused before its delivery starts', async () => {
    let state: InboxState | undefined = {
      paused: false,
      items: [
        {
          id: 'a',
          sessionID: 'one',
          url: 'https://gitlab.com/g/p/-/merge_requests/1',
          title: 'a',
          links: [],
          delivery: 'passive',
          at: 0,
        },
      ],
    };
    const sent: string[] = [];
    const inbox = createFeedbackInbox({
      read: async () => state && structuredClone(state),
      write: async (next) => void (state = structuredClone(next)),
      changed: () => {},
      notify: async (item) => void sent.push(item.id),
    });
    await inbox.pause(true);
    await inbox.notifyPending();
    expect(sent).toEqual([]);
    await inbox.pause(false);
    const pending = inbox.notifyPending();
    await inbox.acknowledge('a');
    await pending;
    expect(sent).toEqual([]);
  });

  test('replaces the updates a new one supersedes, but not when it already exists', async () => {
    let state: InboxState | undefined;
    const inbox = createFeedbackInbox({
      read: async () => state && structuredClone(state),
      write: async (next) => void (state = structuredClone(next)),
      changed: () => {},
    });
    const item = (id: string, pipeline: string): FeedbackItem => ({
      id,
      sessionID: 'one',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      kind: 'ci-failed',
      pipeline,
      title: id,
      links: [],
      at: 0,
    });
    const same = (next: FeedbackItem) => (entry: FeedbackItem) => entry.pipeline === next.pipeline;
    await recordAndDeliver(inbox, item('a', 'p1'));
    await recordAndDeliver(inbox, item('other', 'p2'));
    await recordAndDeliver(inbox, item('b', 'p1'), same(item('b', 'p1')));
    expect((await inbox.list()).items.map((entry) => entry.id)).toEqual(['b', 'other']);
    // A retry of an update that exists changes nothing.
    await recordAndDeliver(inbox, item('other', 'p2'), () => true);
    expect((await inbox.list()).items.map((entry) => entry.id)).toEqual(['other', 'b']);
  });

  test('opens only HTTPS links on the target origin without embedded credentials', () => {
    const url = 'https://gitlab.com/g/p/-/merge_requests/1';
    expect(
      feedbackLinks({
        url,
        links: [
          `${url}#note_1`,
          'file:///etc/passwd',
          'javascript:alert(1)',
          'https://evil.example/comment',
          'https://user:pass@gitlab.com/comment',
          'http://gitlab.com/comment',
          'not a URL',
          url,
        ],
      }),
    ).toEqual([url, `${url}#note_1`]);
  });
  test('serializes concurrent updates and persists acknowledgements and pause', async () => {
    let state: InboxState | undefined;
    const options = {
      read: async () => structuredClone(state),
      write: async (value: InboxState) => {
        state = structuredClone(value);
      },
      changed: () => {},
    };
    const inbox = createFeedbackInbox(options);
    const item: FeedbackItem = {
      id: 'a',
      sessionID: 'one',
      url: 'https://gitlab.com/g/p/-/merge_requests/1',
      title: 'New feedback',
      links: [],
      at: 1,
    };
    await Promise.all([
      recordAndDeliver(inbox, item),
      recordAndDeliver(inbox, { ...item, id: 'b' }),
    ]);
    expect((await inbox.list()).items.map((entry) => entry.id)).toEqual(['b', 'a']);
    await recordAndDeliver(inbox, item);
    expect((await inbox.list()).items).toHaveLength(2);
    await inbox.acknowledge('a');
    await inbox.pause(true);
    await expect(recordAndDeliver(inbox, item)).rejects.toThrow('Feedback monitoring is paused');
    expect(await createFeedbackInbox(options).list()).toMatchObject({
      items: [{ id: 'b' }],
      paused: true,
    });
  });

  test('does not acknowledge a delivery whose storage write failed', async () => {
    const inbox = createFeedbackInbox({
      read: async () => undefined,
      write: async () => {
        throw new Error('disk full');
      },
      changed: () => {
        throw new Error('must not emit');
      },
    });
    await expect(inbox.pause(true)).rejects.toThrow('disk full');
    expect(await inbox.list()).toEqual({ items: [], paused: false });
  });
});
