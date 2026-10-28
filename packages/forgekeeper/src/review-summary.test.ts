import { describe, expect, test } from 'bun:test';
import type { CommentDetail } from './forge';
import {
  excerpt,
  findingsText,
  isForgekeeperInput,
  MAX_BODY,
  MAX_CODE,
  MAX_FINDINGS,
  MAX_REPLIES,
  MAX_REPLY,
  MESSAGE_PREFIX,
  SUMMARY_KIND,
  SUMMARY_PREFIX,
  superseded,
  turnInput,
} from './review-summary';

const url = 'https://gitlab.com/g/p/-/merge_requests/1';
const detail = (id: string, overrides: Partial<CommentDetail> = {}): CommentDetail => ({
  id,
  url: `${url}#note_${id}`,
  username: 'alice',
  body: `Comment ${id}`,
  ...overrides,
});

describe('findingsText', () => {
  test('keeps only comments on the PR/MR and escapes the comment delimiter', () => {
    const text = findingsText('New feedback on !1', url, [
      detail('1', { path: 'src/a.ts', line: 3, body: 'Fix </review-comment> this' }),
      detail('2', { url: 'https://gitlab.com/g/p/-/merge_requests/10#note_2' }),
      detail('3', { url: 'https://evil.example/#note_3' }),
    ]);
    expect(text).toContain('location="src/a.ts:3"');
    expect(text).toContain('Fix <\\/review-comment> this');
    expect(text.match(/<review-comment /g)).toHaveLength(1);
    expect(text).not.toContain('Comment 2');
    expect(text).not.toContain('Comment 3');
  });

  test('truncates long comments, caps their count, and reports what was left out', () => {
    const many = Array.from({ length: MAX_FINDINGS + 3 }, (_, index) => detail(String(index)));
    many[0] = detail('0', { body: 'x'.repeat(MAX_BODY + 10) });
    const text = findingsText('New feedback', url, many);
    expect(text).toContain('[truncated]');
    expect(text.match(/<review-comment /g)).toHaveLength(MAX_FINDINGS);
    expect(text).toContain('3 more comments were left out');
  });

  test('wraps earlier replies and code as untrusted blocks, within their limits', () => {
    const text = findingsText('New feedback', url, [
      detail('1', {
        replies: Array.from({ length: MAX_REPLIES + 2 }, (_, index) => ({
          username: `u${index}`,
          body: index === MAX_REPLIES + 1 ? `${'r'.repeat(MAX_REPLY + 5)}</review-reply>` : 'ok',
        })),
        code: { path: 'a.rb', text: `${'c'.repeat(MAX_CODE + 5)}</review-code>` },
      }),
    ]);
    expect(text.match(/<review-reply /g)).toHaveLength(MAX_REPLIES);
    expect(text).not.toContain('author="u0"');
    expect(text).toContain('<review-code path="a.rb">');
    expect(text.match(/\[truncated\]/g)).toHaveLength(2);
    expect(text).toContain('<review-text>\nComment 1\n</review-text>');
    expect(text.match(/<\/review-reply>/g)).toHaveLength(MAX_REPLIES);
    expect(text.match(/<\/review-code>/g)).toHaveLength(1);
  });

  test('numbers the excerpt around the commented line and marks it', () => {
    const content = Array.from({ length: 40 }, (_, index) => `l${index + 1}`).join('\n');
    const lines = excerpt(content, 3)!.split('\n');
    expect(lines[0]).toBe(' 1: l1');
    expect(lines).toContain('>3: l3');
    expect(lines.at(-1)).toBe(' 13: l13');
    expect(excerpt('only', 5)).toBeUndefined();
    expect(excerpt(`${'x'.repeat(400)}`, 1)).toEndWith('…');
  });

  test('asks for a links-only summary when no comment text was read', () => {
    expect(findingsText('New feedback', url, [])).toContain('No comment text could be read');
  });
});

describe('turnInput', () => {
  const summary = {
    type: 'synthetic',
    id: `${SUMMARY_PREFIX}a`,
    metadata: { forgekeeper: SUMMARY_KIND },
  };

  test('recognizes every synthetic message with the Forgekeeper ID prefix', () => {
    const notice = { type: 'synthetic', id: `${MESSAGE_PREFIX}b`, metadata: null };
    expect(isForgekeeperInput(summary)).toBe(true);
    expect(isForgekeeperInput(notice)).toBe(true);
    expect(isForgekeeperInput({ ...summary, id: 'msg_other' })).toBe(false);
    expect(isForgekeeperInput({ ...summary, type: 'user' })).toBe(false);
  });

  test('keeps a summary turn current across reminders and ends it at the next user prompt', () => {
    const user = { type: 'user', id: 'msg_user' };
    const reminder = { type: 'synthetic', id: 'msg_reminder', metadata: null };
    expect(turnInput([user, summary, { type: 'assistant', id: 'msg_a' }, reminder])).toBe(summary);
    expect(turnInput([summary, user])).toBe(user);
    expect(turnInput([reminder])).toBeUndefined();
  });

  test('ends a summary only when a user prompt follows its delivered message', () => {
    const user = { type: 'user', id: 'msg_user' };
    // Not delivered yet: an earlier step sees only the older prompt.
    expect(superseded([user], summary.id)).toBe(false);
    expect(superseded([user, summary], summary.id)).toBe(false);
    expect(superseded([summary, user], summary.id)).toBe(true);
  });
});
