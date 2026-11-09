import { expect, test } from 'bun:test';
import { NOTICE_TEXT, withoutNotices } from './notice';

const text = (role: string, value: string) => ({ role, content: [{ type: 'text', text: value }] });

test('removes only the notices', () => {
  const messages = [
    text('user', 'Fix the bug'),
    text('assistant', 'Done'),
    text('user', NOTICE_TEXT),
    text('assistant', NOTICE_TEXT),
    { role: 'user', content: [{ type: 'text', text: NOTICE_TEXT }, { type: 'file' }] },
    text('user', 'Thanks'),
  ];
  expect(withoutNotices(messages)).toEqual([
    messages[0],
    messages[1],
    messages[3],
    messages[4],
    messages[5],
  ]);
});
