import { describe, expect, test } from 'bun:test';
import { feedbackReport, parseFeedbackAction, statusReport } from './commands';
import type { FeedbackItem } from './feedback-inbox';

describe('/forge-inbox arguments', () => {
  test('lists without arguments, and acknowledges or summarizes by number', () => {
    expect(parseFeedbackAction('  ')).toEqual({ kind: 'list' });
    expect(parseFeedbackAction('ack 2')).toEqual({ kind: 'acknowledge', which: 2 });
    expect(parseFeedbackAction('Acknowledge ALL')).toEqual({ kind: 'acknowledge', which: 'all' });
    expect(parseFeedbackAction('summarize 1')).toEqual({ kind: 'summarize', which: 1 });
  });

  test('rejects anything else', () => {
    for (const input of ['ack', 'ack 0', 'ack 1 2', 'summarize all', 'open 1'])
      expect(parseFeedbackAction(input)).toEqual({ kind: 'invalid', input });
  });
});

describe('command reports', () => {
  test('explains a status without PRs/MRs as the dialog does', () => {
    expect(statusReport({ loading: false })).toBe('No data yet.');
    expect(statusReport({ loading: false, lookup: { kind: 'none', reason: 'no checkout' } })).toBe(
      'No PR/MR lookup: no checkout.',
    );
  });

  test("lists only the session's updates, numbered, with their links", () => {
    const item = (sessionID: string, iid: string): FeedbackItem => ({
      id: `${sessionID}-${iid}`,
      sessionID,
      url: `https://gitlab.com/group/a/-/merge_requests/${iid}`,
      title: `New review feedback on !${iid}`,
      links: [`https://gitlab.com/group/a/-/merge_requests/${iid}#note_1`],
      at: 0,
    });
    const report = feedbackReport(
      { items: [item('one', '1'), item('two', '2'), item('one', '3')], paused: true },
      'one',
    );
    expect(report).toContain('Feedback monitoring is paused.');
    expect(report).toContain('1. New review feedback on !1');
    expect(report).toContain('2. New review feedback on !3');
    expect(report).toContain('   - https://gitlab.com/group/a/-/merge_requests/3#note_1');
    expect(report).not.toContain('!2');
    expect(feedbackReport({ items: [], paused: false }, 'one')).toBe(
      'No pending review updates for this session.',
    );
  });
});
