import { describe, expect, test } from 'bun:test';
import {
  cleanupRef,
  cleanupReport,
  feedbackReport,
  invalidCleanupReport,
  parseCleanupAction,
  parseFeedbackAction,
  statusReport,
} from './commands';
import type { FeedbackItem } from './feedback-inbox';

describe('/forge-inbox arguments', () => {
  test('lists without arguments, and acknowledges or summarizes by ID', () => {
    expect(parseFeedbackAction('  ')).toEqual({ kind: 'list' });
    expect(parseFeedbackAction('ack 2')).toEqual({ kind: 'invalid', input: 'ack 2' });
    expect(parseFeedbackAction('Acknowledge ALL')).toEqual({ kind: 'acknowledge', which: 'all' });
    expect(parseFeedbackAction('summarize 0123456789abcdef')).toEqual({
      kind: 'summarize',
      which: '0123456789abcdef',
    });
  });

  test('rejects anything else', () => {
    for (const input of ['ack', 'ack 0', 'ack 1 2', 'summarize all', 'open 1'])
      expect(parseFeedbackAction(input)).toEqual({ kind: 'invalid', input });
  });
});

describe('/forge-prune arguments', () => {
  test('lists without arguments, and cleans by ID or all', () => {
    expect(parseCleanupAction('')).toEqual({ kind: 'list' });
    expect(parseCleanupAction('ALL')).toEqual({ kind: 'clean', which: 'all' });
    expect(parseCleanupAction('archive all')).toEqual({ kind: 'clean', which: 'all' });
    expect(parseCleanupAction('0123456789abcdef')).toEqual({
      kind: 'clean',
      which: '0123456789abcdef',
    });
    expect(parseCleanupAction('clean 0123456789abcdef')).toEqual({
      kind: 'clean',
      which: '0123456789abcdef',
    });
  });

  test('rejects invalid cleanup arguments', () => {
    for (const input of ['clean', '123', 'all extra'])
      expect(parseCleanupAction(input)).toEqual({ kind: 'invalid', input });
    expect(invalidCleanupReport('bad')).toContain('Usage: `/forge-prune [all | <id>]`');
  });
});

describe('command reports', () => {
  test('explains a status without PRs/MRs as the dialog does, and appends cleanup hint when ready', () => {
    expect(statusReport({ loading: false })).toBe('No data yet.');
    expect(statusReport({ loading: false, lookup: { kind: 'none', reason: 'no checkout' } })).toBe(
      'No PR/MR lookup: no checkout.',
    );
    expect(
      statusReport({
        loading: false,
        lookup: {
          kind: 'none',
          reason: 'The session target is not a PR/MR',
          cleanupReady: { kind: 'closed-issues', reason: 'Tracked issue closed' },
        },
      }),
    ).toContain(
      'Tracked issue closed. Run `/forge-cleanup` (or `/forge-prune`) to archive this session.',
    );
  });

  test('formats cleanup candidate reports', () => {
    expect(cleanupReport({ enabled: true, candidates: [], skippedErrors: 1 })).toContain(
      'Skipped 1 session whose target status could not be verified.',
    );
    const report = cleanupReport({
      enabled: true,
      skippedErrors: 0,
      candidates: [
        {
          sessionID: 'ses_1',
          title: '[!42] Ship feature',
          directory: '/repo',
          reason: 'merged-requests',
          targets: [
            {
              kind: 'merge-request',
              url: 'https://gitlab.com/group/a/-/merge_requests/42',
              reference: '!42',
              project: 'group/a',
            },
          ],
          pendingFeedback: 1,
        },
      ],
    });
    expect(report).toContain(`1. [!42] Ship feature (\`${cleanupRef('ses_1')}\`)`);
    expect(report).toContain('   - !42 merged · 1 review update');
    expect(report).toContain('   - https://gitlab.com/group/a/-/merge_requests/42');
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
