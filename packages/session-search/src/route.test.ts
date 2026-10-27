import { describe, expect, test } from 'bun:test';
import { openAction, openRequested, showsSource, type Route, type SessionUI } from './route.ts';
import type { OpenRequest } from './rpc.ts';

describe('showsSource', () => {
  const request = { sourceSessionIDs: ['ses_child', 'ses_root'] };

  test('matches the requesting session or one of its ancestors', () => {
    expect(showsSource({ type: 'session', sessionID: 'ses_child' }, request)).toBe(true);
    expect(showsSource({ type: 'session', sessionID: 'ses_root' }, request)).toBe(true);
  });

  test('ignores terminals showing other sessions or pages', () => {
    expect(showsSource({ type: 'session', sessionID: 'ses_other' }, request)).toBe(false);
    expect(showsSource({ type: 'home' }, request)).toBe(false);
  });
});

describe('openAction', () => {
  test('focuses a tab for a root session when tabs are enabled', () => {
    expect(openAction(true, { root: true })).toBe('tab');
  });

  test('navigates otherwise', () => {
    expect(openAction(true, { root: false })).toBe('route');
    expect(openAction(false, { root: true })).toBe('route');
  });
});

describe('openRequested', () => {
  const request: OpenRequest = {
    requestID: 'request_1',
    sourceSessionIDs: ['ses_source'],
    sessionID: 'ses_target',
    rootSessionID: 'ses_target',
    root: true,
    closeSource: true,
  };

  function terminal(options: { tabs?: boolean; navigate?: boolean; route?: Route } = {}) {
    let route: Route = options.route ?? { type: 'session', sessionID: 'ses_source' };
    const calls: string[] = [];
    const ui: SessionUI = {
      router: {
        current: () => route,
        navigate: (next) => {
          calls.push(`navigate:${next.sessionID}`);
          if (options.navigate !== false) route = next;
        },
      },
      tabs: {
        enabled: () => options.tabs !== false,
        focus: (sessionID) => {
          calls.push(`focus:${sessionID}`);
          if (options.navigate !== false) route = { type: 'session', sessionID };
        },
        close: (sessionID) => {
          calls.push(`close:${sessionID}`);
        },
      },
    };
    return { ui, calls };
  }

  test('focuses the destination before closing the source tab', () => {
    const { ui, calls } = terminal();
    expect(openRequested(ui, request)).toBe('tab');
    expect(calls).toEqual(['focus:ses_target', 'close:ses_source']);
  });

  test('keeps the source open by default', () => {
    const { ui, calls } = terminal();
    expect(openRequested(ui, { ...request, closeSource: false })).toBe('tab');
    expect(calls).toEqual(['focus:ses_target']);
  });

  test('only navigates when tabs are disabled', () => {
    const { ui, calls } = terminal({ tabs: false });
    expect(openRequested(ui, request)).toBe('route');
    expect(calls).toEqual(['navigate:ses_target']);
  });

  test('keeps the source open when navigation fails', () => {
    const { ui, calls } = terminal({ navigate: false });
    expect(openRequested(ui, request)).toBeUndefined();
    expect(calls).toEqual(['focus:ses_target']);
  });

  test('keeps the source open when navigation throws', () => {
    const { ui, calls } = terminal();
    ui.tabs.focus = () => {
      throw new Error('Navigation failed');
    };
    expect(() => openRequested(ui, request)).toThrow('Navigation failed');
    expect(calls).toEqual([]);
  });

  test('ignores other terminals', () => {
    const { ui, calls } = terminal({ route: { type: 'session', sessionID: 'ses_other' } });
    expect(openRequested(ui, request)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('closes the source root tab for a child caller', () => {
    const { ui, calls } = terminal({ route: { type: 'session', sessionID: 'ses_child' } });
    expect(openRequested(ui, { ...request, sourceSessionIDs: ['ses_child', 'ses_source'] })).toBe(
      'tab',
    );
    expect(calls).toEqual(['focus:ses_target', 'close:ses_source']);
  });

  test('navigates to a child destination before closing a different source root', () => {
    const { ui, calls } = terminal();
    expect(openRequested(ui, { ...request, root: false, rootSessionID: 'ses_other_root' })).toBe(
      'route',
    );
    expect(calls).toEqual(['navigate:ses_target', 'close:ses_source']);
  });

  test('never closes a shared root tab', () => {
    const { ui, calls } = terminal();
    expect(openRequested(ui, { ...request, root: false, rootSessionID: 'ses_source' })).toBe(
      'route',
    );
    expect(calls).toEqual(['navigate:ses_target']);
  });

  test('never closes the destination tab when opening the source itself', () => {
    const { ui, calls } = terminal();
    expect(
      openRequested(ui, { ...request, sessionID: 'ses_source', rootSessionID: 'ses_source' }),
    ).toBe('tab');
    expect(calls).toEqual(['focus:ses_source']);
  });
});
