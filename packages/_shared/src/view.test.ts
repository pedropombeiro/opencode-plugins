import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin/tui';
import type { OpenCodeEvent } from './opencode.ts';
import { createViewFilter } from './view.ts';

interface View {
  route?: string;
  tabs?: string[];
  parents?: Record<string, string>;
}

function context(view: View) {
  return {
    data: {
      session: { root: (sessionID: string) => view.parents?.[sessionID] ?? sessionID },
    },
    ui: {
      router: {
        current: () => (view.route ? { type: 'session', sessionID: view.route } : { type: 'home' }),
      },
      tabs: {
        enabled: () => view.tabs !== undefined,
        list: () => (view.tabs ?? []).map((sessionID) => ({ sessionID })),
      },
    },
  } as unknown as Pick<Plugin.Context, 'data' | 'ui'>;
}

const started = (sessionID: string) =>
  ({ type: 'session.execution.started', data: { sessionID } }) as unknown as OpenCodeEvent;

describe('createViewFilter', () => {
  test('accepts the session on screen and ignores other sessions', () => {
    const shows = createViewFilter(context({ route: 'ses_mine' }), () => false);

    expect(shows(started('ses_mine'))).toBe(true);
    expect(shows(started('ses_other'))).toBe(false);
  });

  test('accepts subagent sessions of the session on screen', () => {
    const shows = createViewFilter(
      context({ route: 'ses_mine', parents: { ses_child: 'ses_mine' } }),
      () => false,
    );

    expect(shows(started('ses_child'))).toBe(true);
  });

  test('accepts sessions in open tabs', () => {
    const shows = createViewFilter(context({ tabs: ['ses_tab'] }), () => false);

    expect(shows(started('ses_tab'))).toBe(true);
    expect(shows(started('ses_other'))).toBe(false);
  });

  test('keeps following a tracked session after it leaves the screen', () => {
    const shows = createViewFilter(context({}), (sessionID) => sessionID === 'ses_running');

    expect(shows(started('ses_running'))).toBe(true);
  });

  test('ignores events without a session', () => {
    const shows = createViewFilter(context({ route: 'ses_mine' }), () => true);

    expect(shows({ type: 'config.updated', data: {} } as unknown as OpenCodeEvent)).toBe(false);
  });
});
