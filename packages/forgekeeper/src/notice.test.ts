import { expect, test } from 'bun:test';
import { showNotice } from './notice';
import type { Notice } from './rpc';

function harness(shown: string[] = ['ses_review']) {
  const opened: string[] = [];
  const toasts: unknown[] = [];
  const show = (notice: Notice) =>
    showNotice(notice, {
      hasShown: (sessionID) => shown.includes(sessionID),
      openTab: (sessionID) => void opened.push(sessionID),
      toast: (input) => void toasts.push(input),
    });
  return { show, opened, toasts };
}

test('reopens the tab of a session that was told about a review', () => {
  const { show, opened, toasts } = harness();
  show({ sessionID: 'ses_review', title: 'Review', message: 'New feedback', variant: 'info' });
  expect(opened).toEqual(['ses_review']);
  expect(toasts).toEqual([{ title: 'Review', message: 'New feedback', variant: 'info' }]);
});

test('ignores notices about sessions this CLI has not shown', () => {
  const { show, opened, toasts } = harness();
  show({ sessionID: 'ses_other', message: 'New feedback', variant: 'info' });
  expect(opened).toEqual([]);
  expect(toasts).toEqual([]);
});

test('does not reopen a tab for errors', () => {
  const { show, opened, toasts } = harness();
  show({ sessionID: 'ses_review', message: 'Could not tell the session', variant: 'error' });
  expect(opened).toEqual([]);
  expect(toasts).toEqual([{ message: 'Could not tell the session', variant: 'error' }]);
});

test('shows notices without a session and opens no tab', () => {
  const { show, opened, toasts } = harness();
  show({ message: 'Could not check PR/MR review feedback', variant: 'error' });
  expect(opened).toEqual([]);
  expect(toasts).toEqual([{ message: 'Could not check PR/MR review feedback', variant: 'error' }]);
});
