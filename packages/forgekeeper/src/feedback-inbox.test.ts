import { describe, expect, test } from 'bun:test';
import {
  createFeedbackInbox,
  feedbackLinks,
  feedbackTime,
  formatTime,
  linkOptions,
  type InboxState,
  type FeedbackItem,
} from './feedback-inbox';

describe('feedback inbox', () => {
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
    await expect(inbox.add(item)).rejects.toThrow('session unavailable');
    expect((await inbox.list()).items).toEqual([item]);
    await inbox.pause(true);
    await createFeedbackInbox(options).notifyPending();
    expect(sent).toEqual(['a']);
    fail = false;
    await inbox.pause(false);
    await createFeedbackInbox(options).notifyPending();
    expect(sent).toEqual(['a', 'a']);
    await inbox.add(item);
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
    await inbox.add(item);
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
    const adding = inbox.add(update('slow'));
    await Bun.sleep(0);
    expect(sent).toEqual(['slow']);
    // Reads and changes don't wait for the delivery.
    expect((await inbox.list()).items.map((item) => item.id)).toEqual(['slow']);
    await inbox.add({ ...update('other'), delivery: undefined });
    const retries = Promise.all([inbox.notifyPending(), inbox.notifyPending()]);
    await Bun.sleep(0);
    expect(sent).toEqual(['slow']);
    release();
    await Promise.all([adding, retries]);
    expect(sent).toEqual(['slow']);
    expect(state?.items.find((item) => item.id === 'slow')?.notifiedAt).toBe(7);
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
    await inbox.add(item('a', 'p1'));
    await inbox.add(item('other', 'p2'));
    await inbox.add(item('b', 'p1'), same(item('b', 'p1')));
    expect((await inbox.list()).items.map((entry) => entry.id)).toEqual(['b', 'other']);
    // A retry of an update that exists changes nothing.
    await inbox.add(item('other', 'p2'), () => true);
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
    await Promise.all([inbox.add(item), inbox.add({ ...item, id: 'b' })]);
    expect((await inbox.list()).items.map((entry) => entry.id)).toEqual(['b', 'a']);
    await inbox.add(item);
    expect((await inbox.list()).items).toHaveLength(2);
    await inbox.acknowledge('a');
    await inbox.pause(true);
    await expect(inbox.add(item)).rejects.toThrow('Feedback monitoring is paused');
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
