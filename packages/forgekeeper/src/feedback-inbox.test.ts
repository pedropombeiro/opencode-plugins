import { describe, expect, test } from 'bun:test';
import {
  createFeedbackInbox,
  feedbackLinks,
  type InboxState,
  type FeedbackItem,
} from './feedback-inbox';

describe('feedback inbox', () => {
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
